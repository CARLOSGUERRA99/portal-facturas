// Sondeo del portal AutoFacturas RADEC de GRUPO SALCIDO (E.S. 1821, Sonoyta, Son.).
// La URL sale de www.gruposalcido.com.mx, que es el sitio impreso en el ticket #381:
//   https://radecsalcido.dyndns.org/facturas/autofactura.aspx
// Es la MISMA app ASP.NET de Grupo CADISA que ya maneja bots/cadisa.js.
//
// HALLAZGO (11-sep-2026): el RFC de GPN (GPR110128QD8) NO está en el padrón de
// esta estación y el botón de alta (#btnAltaEmpresa) llega con
// disabled="disabled" class="aspNetDisabled" DESDE EL SERVIDOR — no es un fallo
// del bot: esta estación no deja darse de alta por web (en rindemas.dyndns.org
// el mismo botón llega habilitado). Hay que registrar al cliente en la
// gasolinera. Hasta entonces el flujo no pasa de la pantalla del RFC.
//
// PASO=1  (por defecto) solo valida el RFC.
// ALTA=1  revela el formulario de alta SIN enviarlo (el boton "AQUI" no manda nada).
// PASO=2  pulsa "Datos correctos, continuar" (no emite nada).
// PASO=3  agrega el ticket y lee el total que pinta el portal.
// NUNCA pulsa #btnRealizarFactura: para en la pantalla anterior.
require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

const PORTAL = process.env.PORTAL_SALCIDO || 'https://radecsalcido.dyndns.org/facturas/autofactura.aspx';
const RFC = process.env.RFC || 'GPR110128QD8';
const FOLIO = process.env.FOLIO || '13900263';
const CODIGO = process.env.CODIGO || '4024';
const PASO = Number(process.env.PASO || 1);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function dump(page, label) {
  const buf = await page.screenshot({ fullPage: true }).catch(() => null);
  if (buf) console.log(`[${label}]:`, await subirArchivoR2(buf, `debug/salcido_probe_${label}_${Date.now()}.png`, 'image/png'));
  const info = await page.evaluate(() => {
    const vis = (el) => el.offsetParent !== null;
    return {
      url: location.href,
      inputs: Array.from(document.querySelectorAll('input,select,textarea')).filter(vis)
        .map((i) => ({ id: i.id || null, type: i.type || i.tagName, value: (i.value || '').slice(0, 60) })),
      botones: Array.from(document.querySelectorAll('a,button,input[type=button],input[type=submit]')).filter(vis)
        .map((b) => ({ id: b.id || null, text: (b.textContent || b.value || '').trim().slice(0, 50) })),
      texto: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 1400),
    };
  });
  console.log(`=== ${label} ===\n` + JSON.stringify(info, null, 1));
  return info;
}

(async () => {
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}&stealth=true`,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1000 });
  page.on('dialog', async (d) => { console.log('dialog:', d.message()); await d.accept().catch(() => {}); });

  const escribir = (id, v) => page.evaluate((i, val) => {
    const e = document.getElementById(i); if (!e) return false;
    e.focus(); e.value = String(val);
    for (const ev of ['input', 'change', 'blur']) e.dispatchEvent(new Event(ev, { bubbles: true }));
    return true;
  }, id, v);
  const clickId = (id) => page.evaluate((i) => { const e = document.getElementById(i); if (!e) return false; e.click(); return true; }, id);
  const existe = (id) => page.evaluate((i) => !!document.getElementById(i), id);

  console.log('Portal:', PORTAL);
  const r = await page.goto(PORTAL, { waitUntil: 'networkidle2', timeout: 60000 });
  console.log('Status:', r && r.status(), '->', page.url());
  await page.waitForSelector('#txtRFC', { timeout: 30000 });
  await dump(page, 'p1_inicio');

  console.log(`\nValidando RFC ${RFC}...`);
  await escribir('txtRFC', RFC);
  await sleep(1000);
  await clickId('btnValidarRFC');
  await sleep(8000);
  await dump(page, 'p2_post_rfc');
  console.log('btnAltaEmpresa?', await existe('btnAltaEmpresa'));
  console.log('CCiudad (ficha)?', await existe('CCiudad'));
  console.log('btnDatosCorrectosContinuar?', await existe('btnDatosCorrectosContinuar'));
  console.log('txtNumMov?', await existe('txtNumMov'));

  // Solo REVELA el formulario de alta: el boton "AQUI" no envia nada. Sirve para
  // comprobar que los ids que escribe bots/cadisa.js existen en este despliegue.
  if (process.env.ALTA === '1' && await existe('btnAltaEmpresa')) {
    console.log('\nRevelando el formulario de alta (sin enviarlo)...');
    // #btnAltaEmpresa es un submit dentro de un UpdatePanel: el .click() por DOM
    // no siempre dispara el postback. Con page.click() (raton real) si.
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
      page.click('#btnAltaEmpresa').catch((e) => console.log('page.click fallo:', e.message)),
    ]);
    await sleep(6000);
    await dump(page, 'p2b_form_alta');
    const ids = ['CRazonSocial', 'CDireccion', 'CColonia', 'CCiudad', 'CEstado', 'CCodigoPostal', 'ddRegimenFiscal', 'CRFC', 'CEmail', 'btnDatosCorrectosContinuar'];
    for (const id of ids) console.log(`   ${id}: ${await existe(id) ? 'OK' : 'NO EXISTE'}`);
    const cat = await page.evaluate(() => {
      const o = {};
      for (const id of ['CEstado', 'ddRegimenFiscal']) {
        const s = document.getElementById(id);
        if (s && s.options) o[id] = Array.from(s.options).map((x) => x.text);
      }
      return o;
    });
    console.log('Catalogos del alta:', JSON.stringify(cat).slice(0, 2000));
  }

  if (PASO >= 2 && await existe('btnDatosCorrectosContinuar')) {
    console.log('\nDatos correctos -> continuar (no emite nada)...');
    await clickId('btnDatosCorrectosContinuar');
    await sleep(9000);
    await dump(page, 'p3_form_ticket');
  }

  if (PASO >= 3 && await existe('txtNumMov')) {
    console.log(`\nAgregando ticket folio=${FOLIO} codigo=${CODIGO} (esto NO timbra)...`);
    await escribir('txtNumMov', FOLIO);
    await escribir('txtCodigoTicket', CODIGO);
    await sleep(800);
    await clickId('btnAgregarTicket');
    await sleep(10000);
    const info = await dump(page, 'p4_ticket_agregado');
    const m = info.texto.match(/Total\s*\$\s*([\d,]+\.?\d*)/i);
    console.log('TOTAL QUE VE EL PORTAL:', m ? m[1] : '(no lo pinto)');
    const opciones = await page.evaluate(() => {
      const o = {};
      for (const id of ['ddFormaPago', 'ddUsoCFDi']) {
        const s = document.getElementById(id);
        if (s) o[id] = Array.from(s.options).map((x) => x.text);
      }
      return o;
    });
    console.log('Catalogos:', JSON.stringify(opciones, null, 1));
    console.log('PARADA: existe btnRealizarFactura =', await existe('btnRealizarFactura'), '- NO se pulsa.');
  }

  await browser.close();
  process.exit(0);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
