// Reintento del ticket 07 de OXXO GAS (Los Nardos BJX) con ritmo ESPACIADO
// (30-60 s entre acciones clave) para descartar de una vez el rate-limiting
// como causa del síntoma observado en los 3 intentos rápidos previos: el clic
// en "Agregar Ticket" no producía NINGUNA petición a
// /facturacion/facturar/tickets y el folio nunca entraba al carrito.
//
// Datos del ticket (verificados aritméticamente contra la foto):
//   Estación Los Nardos BJX = E12154
//   Folio 106629030 | MAGNA 44.046 L x $24.99 = $1,100.71 ✔ (cuadra exacto)
//   Forma de pago: Tarjeta de Débito
//
// Requiere cookies de sesión frescas inyectadas por variables de entorno
// (OXXOGAS_CI_SESSION / OXXOGAS_INCAP_SES_363 / OXXOGAS_VISID_INCAP).
// NUNCA se guardan en archivo ni se comitean.
require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');
const { extraerUUIDcfdi } = require('../lib/util');

const ESTACION = 'E12154';
const FOLIO = '106629030';
const MONTO = '1100.71';
const RFC_GPN = 'GPR110128QD8';
const PAUSA = 35000; // 35 s entre acciones clave

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const ci = process.env.OXXOGAS_CI_SESSION;
  if (!ci) {
    console.error('❌ falta OXXOGAS_CI_SESSION');
    process.exit(1);
  }

  // ⚠️ `timeout` EXPLÍCITO: Browserless cierra la sesión por su cuenta pasado su
  // timeout por defecto (~60 s de vida total, no de inactividad). Sin este
  // parámetro, la primera corrida de este script murió con "Requesting main
  // frame too early!" justo durante la segunda pausa de 35 s, cuando la sesión
  // llevaba ~90 s abierta. Cualquier flujo con esperas largas necesita esto.
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}&stealth=true&timeout=600000`,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1100 });
  page.on('dialog', async (d) => {
    console.log('🔔 dialog:', d.message());
    await d.accept().catch(() => {});
  });

  // Instrumentación: saber si el clic dispara la petición y qué contesta.
  let huboRequest = false;
  let respTickets = null;
  page.on('request', (r) => {
    if (r.url().includes('/facturacion/facturar/tickets')) {
      huboRequest = true;
      console.log('   📤 REQUEST →', r.method(), r.url());
      console.log('      payload:', String(r.postData() || '').slice(0, 300));
    }
  });
  page.on('response', async (r) => {
    if (r.url().includes('/facturacion/facturar/tickets')) {
      const txt = await r.text().catch(() => '');
      respTickets = { status: r.status(), body: txt.slice(0, 400) };
      console.log('   📥 RESPONSE ←', r.status(), txt.slice(0, 300));
    }
  });
  page.on('pageerror', (e) => console.log('   ⚠️ JS error en la página:', e.message.slice(0, 200)));

  const cookies = [{ name: 'ci_sessions', value: ci, domain: 'facturacion.oxxogas.com', path: '/' }];
  for (const [n, v] of [
    ['incap_ses_363_3020163', process.env.OXXOGAS_INCAP_SES_363],
    ['visid_incap_3020163', process.env.OXXOGAS_VISID_INCAP],
  ]) {
    if (v) cookies.push({ name: n, value: v, domain: '.oxxogas.com', path: '/' });
  }
  await page.setCookie(...cookies);

  const shot = async (label) => {
    try {
      const u = await subirArchivoR2(await page.screenshot({ fullPage: true }), `debug/oxxogas_t07_lento_${label}_${Date.now()}.png`, 'image/png');
      console.log(`📸 [${label}] ${u}`);
    } catch {}
  };

  try {
    console.log('1) Cargando dashboard…');
    await page.goto('https://facturacion.oxxogas.com/', { waitUntil: 'networkidle2', timeout: 45000 });
    await dormir(8000);
    const body0 = await page.evaluate(() => document.body.innerText.slice(0, 200));
    if (!/Hola/i.test(body0)) {
      console.log('❌ la sesión no es válida:', body0.replace(/\s+/g, ' ').slice(0, 120));
      await browser.close();
      process.exit(2);
    }
    console.log('   ✅ sesión activa');

    console.log(`2) Pausa de ${PAUSA / 1000}s antes de entrar a Facturar (ritmo humano)…`);
    await dormir(PAUSA);

    const facH = await page.evaluateHandle(
      () => Array.from(document.querySelectorAll('a')).find((a) => a.textContent.trim() === 'ACCEDER A FACTURAR') || null
    );
    const facEl = facH.asElement();
    if (!facEl) throw new Error('no apareció el enlace ACCEDER A FACTURAR');
    await facEl.click();
    await dormir(10000);
    await page.waitForSelector('#agregar_tickets', { timeout: 20000 });
    console.log('   ✅ formulario de Facturar cargado');

    console.log(`3) Pausa de ${PAUSA / 1000}s antes de llenar el formulario…`);
    await dormir(PAUSA);

    // El value del <select> de RFC es un id interno; se resuelve por texto para
    // no depender de un número hardcodeado.
    const rfcValue = await page.evaluate((rfc) => {
      const sel = document.querySelector('#rfc');
      const opt = Array.from(sel.options).find((o) => o.text.toUpperCase().includes(rfc));
      return opt ? opt.value : null;
    }, RFC_GPN);
    if (!rfcValue) throw new Error(`el RFC ${RFC_GPN} no está en el select #rfc de la cuenta`);
    console.log(`   RFC ${RFC_GPN} → value ${rfcValue}`);

    await page.select('#rfc', rfcValue);
    await dormir(5000);
    await page.select('#regimen_fiscal', '601');
    await dormir(3000);
    await page.select('#usocfdi', 'G03');
    await dormir(3000);
    await page.select('#estacion', ESTACION);
    await dormir(3000);

    const ti = await page.$('#ticket');
    await ti.click({ clickCount: 3 });
    await page.keyboard.type(FOLIO, { delay: 140 });
    await dormir(2500);
    const mi = await page.$('#monto');
    await mi.click({ clickCount: 3 });
    await page.keyboard.type(MONTO, { delay: 140 });
    await dormir(3000);

    const lleno = await page.evaluate(() => ({
      rfc: document.querySelector('#rfc')?.value,
      regimen: document.querySelector('#regimen_fiscal')?.value,
      uso: document.querySelector('#usocfdi')?.value,
      estacion: document.querySelector('#estacion')?.value,
      ticket: document.querySelector('#ticket')?.value,
      monto: document.querySelector('#monto')?.value,
    }));
    console.log('   estado del formulario:', JSON.stringify(lleno));
    await shot('pre_agregar');

    console.log(`4) Pausa de ${PAUSA / 1000}s antes de "Agregar Ticket"…`);
    await dormir(PAUSA);

    huboRequest = false;
    respTickets = null;
    const ab = await page.$('#agregar_tickets');
    await ab.hover();
    await dormir(1500);
    await ab.click();
    console.log('   clic dado — esperando 25s la respuesta del servidor…');
    await dormir(25000);

    const enCarrito = await page.evaluate((f) => document.body.innerText.includes(f), FOLIO);
    console.log(`   ¿folio en el carrito?: ${enCarrito} | ¿disparó la petición AJAX?: ${huboRequest}`);
    await shot('post_agregar');

    if (!enCarrito) {
      console.log('\n=== DIAGNÓSTICO DEL REINTENTO ESPACIADO ===');
      if (!huboRequest) {
        console.log('❌ Con 35 s entre cada acción el clic SIGUE sin disparar la petición a');
        console.log('   /facturacion/facturar/tickets → NO es rate-limiting: es validación');
        console.log('   del lado del cliente (Angular) que aborta el submit.');
      } else {
        console.log(`❌ Sí se disparó la petición, el servidor respondió: ${JSON.stringify(respTickets)}`);
      }
      const visible = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 800));
      console.log('   texto en pantalla:', visible);
      await browser.close();
      process.exit(1);
    }

    console.log('5) ✅ Ticket en el carrito. Seleccionando forma de pago (Tarjeta de Débito)…');
    await dormir(6000);
    const info = await page.evaluate((f) => {
      const row = Array.from(document.querySelectorAll('tr')).find((t) => t.textContent.includes(f));
      if (!row) return { error: 'fila no encontrada' };
      const sel = row.querySelector('select');
      if (!sel) return { error: 'select no encontrado' };
      const o = Array.from(sel.options).find((x) => /tarjeta de d[eé]bito/i.test(x.text));
      return { name: sel.name, value: o ? o.value : null };
    }, FOLIO);
    console.log('   select de pago:', JSON.stringify(info));
    if (info.name && info.value) {
      await page.select(`select[name="${info.name}"]`, info.value);
      await dormir(5000);
    }
    await shot('pre_facturar');

    console.log('6) Click en FACTURAR TICKETS (emisión real)…');
    const ftH = await page.evaluateHandle(
      () => Array.from(document.querySelectorAll('button')).find((b) => /facturar tickets/i.test(b.textContent || '')) || null
    );
    const ftEl = ftH.asElement();
    if (!ftEl) throw new Error('no se encontró el botón Facturar Tickets');
    await ftEl.click();
    await dormir(25000);
    await shot('post_facturar');

    const vacio = await page.evaluate(() => document.body.innerText.includes('No tiene agregado ningún Ticket'));
    console.log('   ¿carrito vacío (señal de éxito)?:', vacio);
    if (!vacio) {
      console.log('   texto:', (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 900));
      throw new Error('el carrito no se vació — no se puede confirmar el timbrado');
    }

    console.log('7) Recuperando el CFDI real desde Mis Facturas…');
    const mfH = await page.evaluateHandle(
      () => Array.from(document.querySelectorAll('a')).find((a) => a.textContent.trim() === 'ACCEDER A MIS FACTURAS') || null
    );
    await mfH.asElement().click();
    await dormir(14000);
    await shot('mis_facturas');

    const xmlHref = await page.evaluate(() => {
      const row = Array.from(document.querySelectorAll('tr')).find((t) => /1[,.]?100\.71/.test(t.textContent));
      if (!row) return null;
      const a = Array.from(row.querySelectorAll('a')).find((x) => /\/xml\//.test(x.href));
      return a ? a.href : null;
    });
    console.log('   link XML:', xmlHref);
    if (!xmlHref) throw new Error('no se ubicó la factura recién emitida en Mis Facturas');

    const id = xmlHref.split('/').pop();
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const xr = await fetch(`https://facturacion.oxxogas.com/facturacion/facturas/xml/${id}`, { headers: { Cookie: cookieHeader } });
    const pr = await fetch(`https://facturacion.oxxogas.com/facturacion/facturas/pdf/${id}`, { headers: { Cookie: cookieHeader } });
    const xb = xr.ok ? Buffer.from(await xr.arrayBuffer()) : null;
    const pb = pr.ok ? Buffer.from(await pr.arrayBuffer()) : null;
    if (!xb) throw new Error('no se pudo descargar el XML');

    const xml = xb.toString('utf8');
    const uuid = extraerUUIDcfdi(xb) || id;
    const total = (xml.match(/<(?:cfdi:)?Comprobante\b[^>]*\sTotal="([\d.]+)"/i) || [])[1];
    const rfcRec = (xml.match(/<(?:cfdi:)?Receptor[^>]*\sRfc="([^"]+)"/i) || [])[1];
    const rfcEmi = (xml.match(/<(?:cfdi:)?Emisor[^>]*\sRfc="([^"]+)"/i) || [])[1];
    console.log('\n=== CFDI REAL ===');
    console.log(`UUID ${uuid} | Total ${total} | Emisor ${rfcEmi} | Receptor ${rfcRec}`);
    if (rfcRec !== RFC_GPN) throw new Error(`el receptor del CFDI es ${rfcRec}, no ${RFC_GPN}`);
    if (Math.abs(parseFloat(total) - parseFloat(MONTO)) > 0.01) throw new Error(`el total del CFDI (${total}) no coincide con el ticket (${MONTO})`);

    console.log('☁️ XML:', await subirArchivoR2(xb, `facturas/oxxogas_${uuid}.xml`, 'application/xml'));
    if (pb) console.log('☁️ PDF:', await subirArchivoR2(pb, `facturas/oxxogas_${uuid}.pdf`, 'application/pdf'));
    console.log(`\nRESULTADO_OK ${JSON.stringify({ uuid, total: parseFloat(total) })}`);
    await browser.close();
    process.exit(0);
  } catch (err) {
    console.error('❌', err.message);
    await shot('error').catch(() => {});
    await browser.close().catch(() => {});
    process.exit(1);
  }
})();
