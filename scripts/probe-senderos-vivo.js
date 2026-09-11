/**
 * RECONOCIMIENTO EN VIVO de facturafranquicias.lossenderos.com.mx (ticket #350,
 * KFC Central Durango, sucursal 1434, ticket 217, 04/09/2026, $149).
 *
 * ⛔ NO TIMBRA. Se detiene en el modal "Informacion de Facturacion" con los
 * datos ya escritos, SIN pulsar "Facturar". Ver la nota del final del archivo:
 * hay DOS botones rotulados "Facturar" y solo el segundo emite el CFDI.
 *
 * Uso: node scripts/probe-senderos-vivo.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const URL = 'https://facturafranquicias.lossenderos.com.mx/generar-factura';

// Ticket #350. OJO: noTicket es el "No. Ticket Unico" (80) del pie del ticket,
// NO el "Ticket: 217" de arriba. Con 217 la API responde E-05 "El ticket no se
// encontro". Es la trampa de "los dos folios" del proyecto.
const T = { franquicia: 'KFC', sucursal: '1434', fecha: '2026-09-04', noTicket: '80', precio: '149' };
// Receptor GPN
const R = {
  // #regimenFiscal NO lleva la clave del SAT: lleva el IdRegimenFiscal del
  // catalogo (1 == clave 601). Con "601" el select no casa y obtenerUsoCfdi
  // devuelve data:[] — el combo de Uso de CFDI se queda vacio.
  rfc: 'GPR110128QD8', nombre: 'GPN PINTURAS Y RECUBRIMIENTOS', regimen: '1', uso: 'G03',
  cp: '80140', calle: 'AEROPUERTO', noExt: '7569', colonia: 'BACHIGUALATO',
  municipio: 'CULIACAN', estado: 'SINALOA', pais: 'MEXICO',
  email: 'buzonfacturas@serviciosga.site',
};

// El WS de Browserless emite un ErrorEvent suelto cuando responde 429 (limite
// de sesiones). Sin estos handlers Node aborta antes de imprimir nada.
process.on('unhandledRejection', (e) => console.log('  unhandledRejection:', (e && e.message) || String(e)));
process.on('uncaughtException', (e) => console.log('  uncaughtException:', (e && e.message) || String(e)));

const conectar = async () => {
  for (let i = 1; i <= 6; i++) {
    try {
      return await puppeteer.connect({
        browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}&stealth=true`,
      });
    } catch (e) {
      console.log(`  intento ${i}/6 fallo (${e.message}); espero 20s...`);
      await new Promise((r) => setTimeout(r, 20000));
    }
  }
  throw new Error('Browserless no acepta sesiones (429) tras 6 intentos');
};

(async () => {
  const browser = await conectar();
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1100 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
  // OBLIGATORIO: sin esto un alert() sin manejar cuelga el hilo y Browserless
  // mata la pestana ("Session closed" / "Target closed").
  page.on('dialog', async (d) => { console.log('  dialog:', d.message()); await d.accept().catch(() => {}); });

  // Traza de la API: es lo que de verdad importa para escribir el bot.
  page.on('response', async (r) => {
    const u = r.url();
    if (!u.includes('amsintegra.com.mx')) return;
    let body = '';
    try { body = (await r.text()).slice(0, 1200); } catch (_) { body = '(sin cuerpo)'; }
    console.log(`\n🌐 API ${r.status()} ${r.request().method()} ${u.replace('https://apifacturasestrellablanca.amsintegra.com.mx/main', '')}`);
    const post = r.request().postData();
    if (post) console.log('   POST body:', post.slice(0, 900));
    console.log('   resp:', body);
  });

  const shot = async (etq) => {
    const b = await page.screenshot({ fullPage: true }).catch(() => null);
    if (b) console.log(`📸 [${etq}]`, await subirArchivoR2(b, `debug/senderos_${etq}_${Date.now()}.png`, 'image/png'));
  };

  const inventario = async (etq) => {
    const d = await page.evaluate(() => {
      const vis = (e) => e.offsetParent !== null;
      return {
        url: location.href,
        campos: Array.from(document.querySelectorAll('input,select,textarea')).filter(vis).map((e) => ({
          tag: e.tagName, id: e.id || null, name: e.name || null, type: e.type, ph: e.placeholder || null,
          val: (e.value || '').slice(0, 40), opts: e.tagName === 'SELECT' ? e.options.length : undefined,
        })),
        botones: Array.from(document.querySelectorAll('button,a[href]')).filter(vis).map((e) => ({
          tag: e.tagName, cls: (e.className || '').toString().slice(0, 40),
          text: (e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
          padre: (e.closest('section,div.modal,div.actions') || {}).className || null,
        })).filter((b) => b.text),
        txt: (document.body.innerText || '').replace(/\n{2,}/g, '\n').slice(0, 1400),
      };
    }).catch((e) => ({ err: e.message }));
    console.log(`\n═══════ ${etq} ═══════`);
    console.log(JSON.stringify(d, null, 1));
  };

  // react-select no es un <select>: hay que abrirlo y clicar la opcion.
  const reactSelect = async (indiceInput, texto) => {
    const sel = `#react-select-${indiceInput}-input`;
    await page.click(sel).catch(() => {});
    await sleep(700);
    const opciones = await page.evaluate(() => Array.from(document.querySelectorAll('[id^="react-select"][id*="option"]'))
      .map((o) => ({ id: o.id, txt: (o.textContent || '').trim() })));
    console.log(`\n   opciones de ${sel} (${opciones.length}):`, JSON.stringify(opciones.slice(0, 60)));
    await page.type(sel, texto, { delay: 60 });
    await sleep(900);
    const filtradas = await page.evaluate(() => Array.from(document.querySelectorAll('[id^="react-select"][id*="option"]'))
      .map((o) => ({ id: o.id, txt: (o.textContent || '').trim() })));
    console.log(`   tras teclear "${texto}":`, JSON.stringify(filtradas.slice(0, 20)));
    await page.keyboard.press('Enter');
    await sleep(900);
    return opciones;
  };

  const escribir = async (sel, val) => {
    const ok = await page.$(sel);
    if (!ok) { console.log(`   ⚠️ no existe ${sel}`); return; }
    await page.click(sel, { clickCount: 3 }).catch(() => {});
    // React: poner .value a mano deja el campo "vacio" para el widget; hay que
    // teclear de verdad. Para type=date se usa el valor directo via keyboard.
    await page.type(sel, val, { delay: 45 });
    const leido = await page.$eval(sel, (e) => e.value);
    console.log(`   ${sel} = ${JSON.stringify(leido)} (queria ${JSON.stringify(val)})`);
  };

  try {
    console.log('1. Abriendo', URL);
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(6000);
    await inventario('P1 inicial');
    await shot('p1');

    console.log('\n2. Cerrando el modal "Aviso Importante" (boton Aceptar)...');
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).filter((x) => x.offsetParent)
        .find((x) => /^\s*Aceptar\s*$/i.test(x.textContent || ''));
      if (b) b.click();
    });
    await sleep(2500);

    console.log('\n3. Franquicia (react-select-2)...');
    await reactSelect(2, T.franquicia);
    console.log('\n4. Sucursal (react-select-3)...');
    await reactSelect(3, T.sucursal);

    console.log('\n5. Fecha / # Comprobante / Importe...');
    // input type=date en Chrome: se teclea como MMDDYYYY segun el locale del
    // navegador (en-US en Browserless).
    const [y, m, dd] = T.fecha.split('-');
    await page.click('#FechaVenta').catch(() => {});
    await page.keyboard.type(`${m}${dd}${y}`, { delay: 90 });
    console.log('   #FechaVenta =', await page.$eval('#FechaVenta', (e) => e.value));
    await escribir('#NoTicket', T.noTicket);
    await escribir('#Precio', T.precio);
    await shot('p2_ticket_lleno');

    console.log('\n6. Pulsando "Añadir ticket" (solo CONSULTA el ticket, no factura)...');
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button.primary')).filter((x) => x.offsetParent)
        .find((x) => /Añadir ticket/i.test(x.textContent || ''));
      if (b) b.click();
    });
    await sleep(9000);
    await inventario('P3 tras anadir ticket');
    await shot('p3_tras_anadir');

    console.log('\n7. Marcando el ticket de la lista y pulsando "Siguiente"...');
    await page.evaluate(() => {
      const c = Array.from(document.querySelectorAll('input[type=checkbox]')).filter((x) => x.offsetParent);
      c.forEach((x) => { if (!x.checked) x.click(); });
    });
    await sleep(1200);
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).filter((x) => x.offsetParent)
        .find((x) => /^\s*Siguiente\s*$/i.test(x.textContent || ''));
      if (b) b.click();
    });
    await sleep(5000);
    await inventario('P4 modal datos fiscales');
    await shot('p4_modal_fiscal');

    console.log('\n8. Rellenando el modal fiscal (SIN pulsar Facturar)...');
    await escribir('#rfc', R.rfc);
    await sleep(4000); // dispara obtenerReceptor + obtenerRegimenFiscal
    await inventario('P5 tras RFC (autorrelleno)');

    const cat = await page.evaluate(() => ({
      regimen: Array.from(document.querySelectorAll('#regimenFiscal option')).map((o) => `${o.value}|${o.textContent.trim()}`),
      uso: Array.from(document.querySelectorAll('#usoCfdi option')).map((o) => `${o.value}|${o.textContent.trim()}`),
    }));
    console.log('\n   CATALOGO #regimenFiscal:', JSON.stringify(cat.regimen, null, 1));
    console.log('   CATALOGO #usoCfdi:', JSON.stringify(cat.uso, null, 1));

    await escribir('#nombreRazonSocial', R.nombre);
    await page.select('#regimenFiscal', R.regimen).catch((e) => console.log('   regimen:', e.message));
    await sleep(3500);
    const usoTras = await page.evaluate(() => Array.from(document.querySelectorAll('#usoCfdi option')).map((o) => `${o.value}|${o.textContent.trim()}`));
    console.log('   #usoCfdi tras elegir regimen 601:', JSON.stringify(usoTras, null, 1));
    await page.select('#usoCfdi', R.uso).catch((e) => console.log('   uso:', e.message));
    await escribir('#codigoPostal', R.cp);
    await escribir('#calle', R.calle);
    await escribir('#noExterior', R.noExt);
    await escribir('#colonia', R.colonia);
    await escribir('#municipio', R.municipio);
    await escribir('#estado', R.estado);
    await escribir('#pais', R.pais);
    await escribir('#email', R.email);

    await sleep(1500);
    await inventario('P6 FORMULARIO COMPLETO — PARADA (no se pulsa Facturar)');
    await shot('p6_listo_sin_facturar');

    console.log(`
⛔ PARADA DELIBERADA.
   El boton "Facturar" de ESTE modal (.modal .content button.primary) solo pide
   la PREfactura (isGenerarCFDI:"0") y pasa al paso 2. El que TIMBRA es el
   segundo "Facturar", el de section.datos-fiscales .actions button.primary,
   que abre un modal de confirmacion. Ninguno de los dos se ha pulsado.`);

    await browser.close().catch(() => {});
    process.exit(0);
  } catch (e) {
    console.error('❌', e.message);
    await shot('error').catch(() => {});
    await browser.close().catch(() => {});
    process.exit(1);
  }
})();
