// Sonda de la fachada central app.facturagas.net (familia ControlGAS).
// Llega SOLO hasta "Consultar Ticket" (#btnSerchTk), que valida el folio, e
// inventaria la pantalla final. NUNCA pulsa "Generar Factura" (#btnGenFacUs).
//
// Parametrizable: PROPIOS='url|url' INTENTOS='cadena|cadena' FOLIO= WEBID=
//
// RESULTADOS 11-sep-2026:
//
// · Ticket #351 — E10736 "APV" (folio 1023288 / webId 65923089): la estación
//   SÍ aparece (buscando "10736" → "E10736: APV") pero su servidor SIGUE
//   CAÍDO: "Error en el servicio, intente más tarde." Es exactamente lo que
//   ya reportó bots/facturagas.js (error_code reintentar_despues). No hay
//   nada que arreglar en el bot ni en los datos; hay que reintentar.
//   Su portal propio, facturasapv.myddns.me/controlgasfe, tampoco responde.
//
// · Ticket #360 — E13549 "Servicio Pioneros" (SERVICIO PIONEROS 4, el del
//   portal pioneros4.ddns.net:82): "Ticket validado correctamente" con
//   Folio 31443100, Monto $1191.23, Fecha 2026-09-01 08:45 — cuadra con la
//   foto. O sea que ese ticket se puede facturar aquí, sin captcha.
//
// ⚠️ El autocompletado NO casa con el nombre largo. "10736 - ESTACION DE
//    SERVICIO APV" y "13549 - SERVICIO PIONEROS 4 SA DE CV" no devuelven
//    nada; la clave sola ("10736", "13549") sí. bots/facturagas.js ya prueba
//    la clave suelta como segundo intento, así que funciona.
//
// Selectores de la pantalla final (confirmados hoy, versión 2.0.4.5):
//    #rstation_Input (estación) · #despacho (*Folio) · #webId (*WebID)
//    #btnSerchTk "Consultar Ticket" (onclick consultaTicket())
//    #inputRfc2 (RFC) + #btnValidRfc "Agregar"  ← hasta pulsarlo, los campos
//       de abajo están inertes y #cmbRegimen/#cmbUsos traen 1 sola <option>
//    #inputRazon · #inputCorreo · #inputCp · #cmbRegimen · #cmbUsos
//    #btnGenFacUs  ← "Generar Factura": ESTE ES EL QUE TIMBRA. No pulsado.
//    #btnClear "Limpiar" · #chkSerchInv + #nroCheck + #btnSerchInv "Buscar"
//       (pestaña "Buscar Factura", para recuperar un CFDI ya emitido)
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');
const dormir = ms => new Promise(r => setTimeout(r, ms));

const ESTACION = process.env.ESTACION || '10736 - ESTACION DE SERVICIO APV';
const FOLIO = process.env.FOLIO || '1023288';
const WEBID = process.env.WEBID || '65923089';

(async () => {
  let browser = null;
  for (let i = 0; i < 12 && !browser; i++) {
    try {
      browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}&stealth=true` });
    } catch (e) { console.log(`connect ${i + 1}: ${e.message} — 20s`); await dormir(20000); }
  }
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1000 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
  page.on('dialog', async d => { console.log('🔔 DIALOG:', d.message()); await d.accept().catch(() => {}); });

  // A) El ControlGasFE propio que imprime el ticket
  const propios = process.env.PROPIOS ? process.env.PROPIOS.split('|') : ['http://facturasapv.myddns.me/controlgasfe/', 'http://facturasapv.myddns.me:82/controlgasfe/'];
  for (const u of propios) {
    try {
      const r = await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 20000 });
      console.log(`✅ ${u} → ${r && r.status()} | ${page.url()} | título: ${await page.title()}`);
      console.log('   texto:', (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 300));
    } catch (e) { console.log(`❌ ${u} → ${e.message}`); }
  }

  // B) La fachada central app.facturagas.net
  console.log('\n🌐 app.facturagas.net/generar_factura.aspx');
  await page.goto('https://app.facturagas.net/generar_factura.aspx', { waitUntil: 'load', timeout: 40000 });
  await page.waitForSelector('#rstation_Input', { timeout: 20000 });
  await dormir(1500);

  const intentos = (process.env.INTENTOS ? process.env.INTENTOS.split('|') : [ESTACION, '10736', 'APV', 'ESTACION DE SERVICIO APV']);
  let ok = false;
  for (const t of [...new Set(intentos)]) {
    await page.click('#rstation_Input', { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await page.keyboard.type(t, { delay: 30 });
    await dormir(2500);
    const r = await page.evaluate((n) => {
      const items = Array.from(document.querySelectorAll('li,[role=option]')).filter(i => i.offsetParent !== null && (i.textContent || '').trim());
      const norm = s => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
      const el = items.find(i => norm(i.textContent).includes(norm(n)) || norm(n).includes(norm(i.textContent)));
      if (el) { el.click(); return { ok: true, texto: el.textContent.trim() }; }
      return { ok: false, opciones: items.map(i => i.textContent.trim().slice(0, 45)).slice(0, 10) };
    }, t);
    console.log(`   "${t}" →`, JSON.stringify(r));
    if (r.ok) { ok = true; break; }
  }
  if (!ok) { console.log('❌ la estación no aparece en el autocomplete'); }
  await dormir(1200);

  await page.click('#despacho'); await page.keyboard.type(String(FOLIO), { delay: 25 });
  await page.click('#webId'); await page.keyboard.type(String(WEBID), { delay: 25 });
  console.log('➡️ Click "Consultar Ticket" (#btnSerchTk) — solo valida, NO timbra...');
  await page.click('#btnSerchTk');
  for (let i = 0; i < 16; i++) {
    await dormir(1500);
    const busy = await page.evaluate(() => /Consultando,\s*espere/i.test(document.body.innerText));
    if (!busy) break;
  }
  await dormir(1500);
  const texto = await page.evaluate(() => document.body.innerText.replace(/\n{3,}/g, '\n').slice(0, 1200));
  console.log('\n=== TEXTO TRAS CONSULTAR ===\n' + texto);

  // Inventario de la pantalla final (la que lleva el boton que TIMBRA).
  const inv = await page.evaluate(() => {
    const vis = el => !!(el.offsetWidth || el.offsetHeight);
    return {
      campos: Array.from(document.querySelectorAll('input,select,textarea')).filter(vis).map(el => ({
        tag: el.tagName, type: el.type, id: el.id, name: el.name, ph: el.placeholder,
        nOptions: el.tagName === 'SELECT' ? el.options.length : undefined,
        ops: el.tagName === 'SELECT' ? Array.from(el.options).slice(0, 4).map(o => (o.value + '|' + o.text).slice(0, 45)) : undefined,
      })),
      botones: Array.from(document.querySelectorAll('a,button,input[type=button],input[type=submit]')).filter(vis).map(b => ({
        tag: b.tagName, id: b.id, name: b.name, texto: (b.textContent || b.value || '').trim().slice(0, 40),
        onclick: (b.getAttribute('onclick') || '').slice(0, 80),
      })).filter(b => b.texto),
    };
  });
  console.log('=== INVENTARIO PANTALLA FINAL ===', JSON.stringify(inv, null, 1));
  console.log('📸', await subirArchivoR2(await page.screenshot({ fullPage: true }), `debug/apv10736_consulta_${Date.now()}.png`, 'image/png'));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
