// Reintento del ticket 07 de OXXO GAS (Los Nardos BJX) diseñado para caber en
// el PRESUPUESTO DE 60 s de Browserless.
//
// ⚠️ HALLAZGO QUE MOTIVA ESTE SCRIPT (medido, no supuesto — 2026-07-30):
// Browserless cierra TODA sesión a los 60 s exactos de vida (no de inactividad)
// en el plan actual, y rechaza con HTTP 400 cualquier `&timeout=` explícito
// (probado con 120000/180000/300000). Al morir, el síntoma es
// "Requesting main frame too early!" / "Session closed" / "Target closed".
// Eso — y no un rate-limiting del portal — es la explicación más probable de la
// intermitencia de OXXO GAS: el flujo completo (dashboard → Facturar → 6 campos
// → Agregar → forma de pago → Facturar Tickets → timbrado → Mis Facturas →
// descarga) NO cabe en 60 s si además se toman screenshots fullPage (cada uno
// cuesta segundos de sesión entre la captura y la subida a R2).
//
// Estrategia:
//   FASE 1 (dentro del navegador, objetivo < 45 s): solo lo que EXIGE un
//     navegador — llenar el form Angular y emitir. Cero screenshots en el
//     camino feliz; si algo falla, se captura solo el viewport (no fullPage).
//   FASE 2 (sin navegador): la factura ya existe del lado del servidor, así que
//     el listado y la descarga de XML/PDF se hacen con fetch() + header Cookie.
//
// Datos del ticket: Estación Los Nardos BJX = E12154, folio 106629030,
// MAGNA 44.046 L x $24.99 = $1,100.71 (cuadra exacto), Tarjeta de Débito.
require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');
const { extraerUUIDcfdi } = require('../lib/util');

const ESTACION = 'E12154';
const FOLIO = '106629030';
const MONTO = '1100.71';
const RFC_GPN = 'GPR110128QD8';

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// Espera a que un <select> poblado por AJAX tenga opciones reales, selecciona la
// que casa con `regex` (o con `valorExacto` si se da) y VERIFICA que el valor
// quedó puesto. Lanza si no: un select vacío aquí es un fallo silencioso que
// después se manifiesta como "el botón no hace nada".
async function seleccionarCuandoCargue(page, selector, regex, valorExacto = null) {
  let opciones = [];
  for (let i = 0; i < 20; i++) {
    opciones = await page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return [];
      return Array.from(el.options).map((o) => ({ v: o.value, t: o.text }));
    }, selector);
    if (opciones.filter((o) => o.v).length > 0) break;
    await dormir(500);
  }
  const util = opciones.filter((o) => o.v);
  if (!util.length) throw new Error(`${selector}: el <select> nunca se pobló (¿falló el AJAX del portal?)`);

  const elegido = valorExacto
    ? util.find((o) => o.v === valorExacto)
    : util.find((o) => regex.test(o.t)) || util.find((o) => regex.test(o.v));
  if (!elegido) throw new Error(`${selector}: ninguna de las ${util.length} opciones casa con ${regex} (ej: ${util.slice(0, 3).map((o) => o.t).join(' | ')})`);

  await page.select(selector, elegido.v);
  await dormir(350);
  const puesto = await page.evaluate((s) => document.querySelector(s)?.value || '', selector);
  if (!puesto) throw new Error(`${selector}: se seleccionó "${elegido.t}" pero el valor quedó vacío`);
  return puesto;
}

async function fase1Emitir(cookies) {
  const t0 = Date.now();
  const seg = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';

  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}&stealth=true`,
  });
  let muerta = false;
  browser.on('disconnected', () => { muerta = true; console.log(`🔌 sesión cerrada por Browserless a los ${seg()}`); });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('dialog', async (d) => { console.log('🔔 dialog:', d.message()); await d.accept().catch(() => {}); });

  let huboRequest = false;
  let respTickets = null;
  page.on('request', (r) => {
    if (r.url().includes('/facturacion/facturar/tickets')) {
      huboRequest = true;
      console.log(`   📤 [${seg()}] REQUEST ${r.method()} ${r.url()}`);
    }
  });
  page.on('response', async (r) => {
    if (r.url().includes('/facturacion/facturar/tickets')) {
      const txt = await r.text().catch(() => '');
      respTickets = { status: r.status(), body: txt.slice(0, 300) };
      console.log(`   📥 [${seg()}] RESPONSE ${r.status()} ${txt.slice(0, 200)}`);
    }
  });

  await page.setCookie(...cookies);

  try {
    // Ir DIRECTO al formulario de facturar en vez de pasar por el dashboard:
    // ahorra una navegación completa (~8 s de presupuesto).
    await page.goto('https://facturacion.oxxogas.com/facturacion/facturar', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('#agregar_tickets', { timeout: 15000 });
    console.log(`   [${seg()}] formulario cargado`);

    const rfcValue = await page.evaluate((rfc) => {
      const sel = document.querySelector('#rfc');
      if (!sel) return null;
      const opt = Array.from(sel.options).find((o) => o.text.toUpperCase().includes(rfc));
      return opt ? opt.value : null;
    }, RFC_GPN);
    if (!rfcValue) throw new Error(`el RFC ${RFC_GPN} no aparece en el select #rfc (¿sesión no autenticada?)`);

    await page.select('#rfc', rfcValue);

    // ⚠️ #regimen_fiscal y #usocfdi se POBLAN POR AJAX después de elegir el RFC.
    // page.select() NO lanza error si la opción todavía no existe: deja el
    // <select> vacío en silencio, Angular bloquea el submit por campo requerido
    // y el clic en "Agregar Ticket" no llega ni a disparar la petición. Este era
    // el fallo real de los 4 intentos anteriores. Hay que esperar las opciones
    // y COMPROBAR el valor después de asignarlo.
    await seleccionarCuandoCargue(page, '#regimen_fiscal', /601|general de ley/i);
    await seleccionarCuandoCargue(page, '#usocfdi', /^G03|gastos en general/i);
    await seleccionarCuandoCargue(page, '#estacion', new RegExp(ESTACION, 'i'), ESTACION);

    const ti = await page.$('#ticket');
    await ti.click({ clickCount: 3 });
    await page.keyboard.type(FOLIO, { delay: 25 });
    const mi = await page.$('#monto');
    await mi.click({ clickCount: 3 });
    await page.keyboard.type(MONTO, { delay: 25 });
    await dormir(400);

    const lleno = await page.evaluate(() => ({
      rfc: document.querySelector('#rfc')?.value,
      reg: document.querySelector('#regimen_fiscal')?.value,
      uso: document.querySelector('#usocfdi')?.value,
      est: document.querySelector('#estacion')?.value,
      tk: document.querySelector('#ticket')?.value,
      mo: document.querySelector('#monto')?.value,
    }));
    console.log(`   [${seg()}] form: ${JSON.stringify(lleno)}`);

    await page.click('#agregar_tickets');
    // Espera CONDICIONAL en vez de sleep fijo: en cuanto el folio aparece en el
    // carrito seguimos, sin gastar presupuesto de sesión de más.
    let enCarrito = false;
    for (let i = 0; i < 14 && !enCarrito && !muerta; i++) {
      await dormir(1000);
      enCarrito = await page.evaluate((f) => document.body.innerText.includes(f), FOLIO).catch(() => false);
    }
    console.log(`   [${seg()}] ¿en carrito?: ${enCarrito} | ¿disparó AJAX?: ${huboRequest}`);

    if (!enCarrito) {
      const texto = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 600)).catch(() => '(página muerta)');
      try {
        const u = await subirArchivoR2(await page.screenshot(), `debug/oxxogas_t07_fallo_${Date.now()}.png`, 'image/png');
        console.log('📸', u);
      } catch {}
      await browser.close().catch(() => {});
      return { ok: false, huboRequest, respTickets, texto, seg: seg() };
    }

    const pago = await page.evaluate((f) => {
      const row = Array.from(document.querySelectorAll('tr')).find((t) => t.textContent.includes(f));
      if (!row) return { error: 'fila' };
      const sel = row.querySelector('select');
      if (!sel) return { error: 'select' };
      const o = Array.from(sel.options).find((x) => /tarjeta de d[eé]bito/i.test(x.text));
      return { name: sel.name, value: o ? o.value : null };
    }, FOLIO);
    console.log(`   [${seg()}] select de pago: ${JSON.stringify(pago)}`);
    if (!pago.name || !pago.value) throw new Error(`no se pudo ubicar la forma de pago: ${JSON.stringify(pago)}`);
    await page.select(`select[name="${pago.name}"]`, pago.value);
    await dormir(1200);

    const ftH = await page.evaluateHandle(
      () => Array.from(document.querySelectorAll('button')).find((b) => /facturar tickets/i.test(b.textContent || '')) || null
    );
    const ftEl = ftH.asElement();
    if (!ftEl) throw new Error('no se encontró el botón Facturar Tickets');
    console.log(`   [${seg()}] click FACTURAR TICKETS`);
    await ftEl.click();

    let vacio = false;
    for (let i = 0; i < 25 && !vacio && !muerta; i++) {
      await dormir(1000);
      vacio = await page.evaluate(() => document.body.innerText.includes('No tiene agregado ningún Ticket')).catch(() => false);
    }
    console.log(`   [${seg()}] ¿carrito vacío (éxito)?: ${vacio} | sesión muerta: ${muerta}`);

    if (!vacio && !muerta) {
      const texto = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 600)).catch(() => '');
      try {
        const u = await subirArchivoR2(await page.screenshot(), `debug/oxxogas_t07_postfact_${Date.now()}.png`, 'image/png');
        console.log('📸', u);
      } catch {}
      await browser.close().catch(() => {});
      return { ok: false, emitido: false, texto, seg: seg() };
    }

    await browser.close().catch(() => {});
    // Si la sesión murió DESPUÉS del clic, la emisión pudo haberse completado
    // del lado del servidor: la fase 2 lo verifica sin navegador.
    return { ok: true, confirmadoEnPantalla: vacio, seg: seg() };
  } catch (err) {
    console.log(`   [${seg()}] ❌ ${err.message}`);
    await browser.close().catch(() => {});
    return { ok: false, error: err.message, huboRequest, respTickets, seg: seg() };
  }
}

async function fase2Recuperar(cookieHeader) {
  // La factura ya existe del lado del servidor: no hace falta navegador.
  const candidatos = [
    'https://facturacion.oxxogas.com/facturacion/facturas',
    'https://facturacion.oxxogas.com/facturacion/misfacturas',
    'https://facturacion.oxxogas.com/facturacion/facturas/listado',
  ];
  let html = null;
  for (const u of candidatos) {
    const r = await fetch(u, { headers: { Cookie: cookieHeader } }).catch(() => null);
    if (r && r.ok) {
      const t = await r.text();
      if (/\/xml\//.test(t)) { html = t; console.log(`   listado obtenido de ${u} (${t.length} bytes)`); break; }
      console.log(`   ${u} → 200 pero sin links /xml/`);
    } else {
      console.log(`   ${u} → ${r ? r.status : 'sin respuesta'}`);
    }
  }
  if (!html) return { ok: false, msg: 'no se pudo obtener el listado de facturas por fetch' };

  const ids = [...html.matchAll(/facturas\/xml\/([A-Za-z0-9\-]+)/g)].map((m) => m[1]);
  const unicos = [...new Set(ids)];
  console.log(`   ${unicos.length} factura(s) en el listado`);

  // Se descarga cada candidato y se elige por el TOTAL real del XML, no por
  // texto del HTML: es la única comprobación que no se puede falsear.
  for (const id of unicos.slice(0, 12)) {
    const r = await fetch(`https://facturacion.oxxogas.com/facturacion/facturas/xml/${id}`, { headers: { Cookie: cookieHeader } }).catch(() => null);
    if (!r || !r.ok) continue;
    const xb = Buffer.from(await r.arrayBuffer());
    const xml = xb.toString('utf8');
    const total = (xml.match(/<(?:cfdi:)?Comprobante\b[^>]*\sTotal="([\d.]+)"/i) || [])[1];
    if (!total || Math.abs(parseFloat(total) - parseFloat(MONTO)) > 0.01) continue;

    const uuid = extraerUUIDcfdi(xb) || id;
    const rfcRec = (xml.match(/<(?:cfdi:)?Receptor[^>]*\sRfc="([^"]+)"/i) || [])[1];
    const rfcEmi = (xml.match(/<(?:cfdi:)?Emisor[^>]*\sRfc="([^"]+)"/i) || [])[1];
    if (rfcRec !== RFC_GPN) { console.log(`   id ${id}: total cuadra pero receptor es ${rfcRec}`); continue; }

    console.log('\n=== CFDI REAL ===');
    console.log(`UUID ${uuid} | Total ${total} | Emisor ${rfcEmi} | Receptor ${rfcRec}`);
    const xmlUrl = await subirArchivoR2(xb, `facturas/oxxogas_${uuid}.xml`, 'application/xml');
    console.log('☁️ XML:', xmlUrl);
    let pdfUrl = null;
    const pr = await fetch(`https://facturacion.oxxogas.com/facturacion/facturas/pdf/${id}`, { headers: { Cookie: cookieHeader } }).catch(() => null);
    if (pr && pr.ok) {
      pdfUrl = await subirArchivoR2(Buffer.from(await pr.arrayBuffer()), `facturas/oxxogas_${uuid}.pdf`, 'application/pdf');
      console.log('☁️ PDF:', pdfUrl);
    }
    return { ok: true, uuid, total: parseFloat(total), xmlUrl, pdfUrl };
  }
  return { ok: false, msg: `ninguna factura del listado tiene Total ${MONTO} con receptor ${RFC_GPN}` };
}

(async () => {
  const ci = process.env.OXXOGAS_CI_SESSION;
  if (!ci) { console.error('❌ falta OXXOGAS_CI_SESSION'); process.exit(1); }

  const cookies = [{ name: 'ci_sessions', value: ci, domain: 'facturacion.oxxogas.com', path: '/' }];
  for (const [n, v] of [
    ['incap_ses_363_3020163', process.env.OXXOGAS_INCAP_SES_363],
    ['incap_ses_396_3020163', process.env.OXXOGAS_INCAP_SES_396],
    ['visid_incap_3020163', process.env.OXXOGAS_VISID_INCAP],
  ]) { if (v) cookies.push({ name: n, value: v, domain: '.oxxogas.com', path: '/' }); }
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

  console.log('FASE 1 — emisión dentro del presupuesto de 60 s');
  const f1 = await fase1Emitir(cookies);
  console.log(`   resultado fase 1: ${JSON.stringify(f1).slice(0, 400)}`);

  console.log('\nFASE 2 — recuperación del CFDI sin navegador');
  const f2 = await fase2Recuperar(cookieHeader);
  console.log(`   resultado fase 2: ${JSON.stringify(f2).slice(0, 300)}`);

  if (f2.ok) console.log(`\nRESULTADO_OK ${JSON.stringify({ uuid: f2.uuid, total: f2.total })}`);
  else console.log('\nRESULTADO_FALLO');
  process.exit(f2.ok ? 0 : 1);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
