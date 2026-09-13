/**
 * CONSULTA (no factura) el portal de clientes de Parisina para saber si un
 * ticket YA tiene CFDI emitido.
 *
 * Por qué existe: el ticket #306 se intentó facturar a mano el 09-sep-2026 y el
 * portal no devolvió ni confirmación ni error, así que NO se sabe si timbró. Y
 * el correo que Parisina tiene registrado para GPN es GASTOSCULIACAN@GMAIL.COM,
 * no el buzón de captura, así que el CFDI —si existe— no entró por IMAP y no
 * hay forma de saberlo desde nuestra base. Volver a facturar a ciegas emitiría
 * un duplicado, y en autofactura eso solo se arregla cancelando ante el SAT.
 *
 * El portal de consulta es OTRO dominio (parisina.mysuitecfdi.com) y pide:
 *   RFC · No.Caja+No.Ticket JUNTOS SIN ESPACIOS · No.Sucursal · Fecha · Captcha
 * Ejemplo del propio portal: CAJA 1 + TICKET 98765 → "198765".
 *
 * Uso: node scripts/probe-parisina-consulta.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');
const { resolverCaptchaImagen } = require('../lib/capsolver');

process.on('unhandledRejection', (e) => console.log('unhandledRejection:', (e && e.message) || String(e)));

const URL_CONSULTA = 'https://parisina.mysuitecfdi.com/DefaultNoAuth.aspx';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ticket #306, leído de la foto: Sucursal 206 TIJUANA OTAY, CAJA 2, No TICKET 632108.
const CONSULTA = {
  rfc: 'GPR110128QD8',
  caja: '2',
  ticket: '632108',
  sucursal: '206',
  fecha: '2026-09-03', // el datepicker usa yy-mm-dd
};

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error('BROWSERLESS_TOKEN no definido');
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('dialog', async (d) => { console.log(`💬 ALERT: "${d.message()}"`); try { await d.accept(); } catch {} });

  const shot = async (label) => {
    try {
      const buf = await page.screenshot({ fullPage: true });
      console.log(`📸 [${label}]: ${await subirArchivoR2(buf, `debug/parisina_consulta_${label}_${Date.now()}.png`, 'image/png')}`);
    } catch {}
  };

  try {
    console.log('🌐 Cargando portal de consulta de Parisina...');
    await page.goto(URL_CONSULTA, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForSelector('#txtRFC', { timeout: 20000 });
    await sleep(1500);

    const noTicket = `${CONSULTA.caja}${CONSULTA.ticket}`;
    console.log(`🔎 RFC ${CONSULTA.rfc} | caja+ticket ${noTicket} | sucursal ${CONSULTA.sucursal} | fecha ${CONSULTA.fecha}`);

    await page.evaluate((d) => {
      const set = (id, v) => { const e = document.getElementById(id); if (e) { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); } };
      set('txtRFC', d.rfc); set('txtTicket', d.noTicket); set('txtSucursal', d.sucursal); set('txtFecha', d.fecha);
    }, { ...CONSULTA, noTicket });

    // ⚠️ El captcha es SENSIBLE A MAYÚSCULAS ("considerando mayúsculas,
    // minúsculas y números") y CapSolver acierta los caracteres pero no siempre
    // la caja. Cada intento fallido regenera la imagen, así que se reintenta:
    // es más barato que pelearse con el reconocimiento.
    const INTENTOS = 4;
    let ok = false;
    for (let i = 1; i <= INTENTOS && !ok; i++) {
      const img = await page.evaluate(() => { const el = document.getElementById('Image1'); return el ? el.src : null; });
      if (!img) { await shot('sin_captcha'); break; }

      let texto;
      try { texto = await resolverCaptchaImagen(img); }
      catch (e) { console.log(`   intento ${i}: CapSolver falló — ${e.message}`); break; }

      await page.evaluate((d) => {
        const set = (id, v) => { const e = document.getElementById(id); if (e) { e.value = v; e.dispatchEvent(new Event('change', { bubbles: true })); } };
        set('txtRFC', d.rfc); set('txtTicket', d.noTicket); set('txtSucursal', d.sucursal); set('txtFecha', d.fecha); set('txtCaptcha', d.texto);
      }, { ...CONSULTA, noTicket, texto });

      await page.evaluate(() => document.getElementById('tnAuth').click());
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 45000 }).catch(() => {});
      await sleep(3000);

      const malCaptcha = await page.evaluate(() => /captcha\s+es\s+incorrecto/i.test(document.body.innerText || ''));
      if (malCaptcha) { console.log(`   intento ${i}/${INTENTOS}: "${texto}" → captcha incorrecto, reintento`); await sleep(1500); continue; }
      ok = true;
      console.log(`   ✅ captcha aceptado en el intento ${i}`);
    }
    if (!ok) console.log(`⚠️ No se pasó el captcha en ${INTENTOS} intentos — el resultado de abajo es el del último envío.`);
    await shot('resultado');

    const res = await page.evaluate(() => ({
      url: location.href,
      texto: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 1200),
      filas: Array.from(document.querySelectorAll('table tr')).map((tr) => (tr.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 15),
      enlaces: Array.from(document.querySelectorAll('a')).map((a) => ({ txt: (a.innerText || '').trim().slice(0, 30), href: (a.getAttribute('href') || '').slice(0, 90) })).filter((a) => a.txt).slice(0, 15),
    }));

    console.log('\n========== RESULTADO ==========');
    console.log('URL:', res.url);
    console.log('TEXTO:', res.texto);
    if (res.filas.length) { console.log('\nFILAS:'); res.filas.forEach((f) => console.log('  ', f)); }
    if (res.enlaces.length) { console.log('\nENLACES:'); res.enlaces.forEach((e) => console.log('  ', e.txt, '→', e.href)); }

    await browser.close();
    process.exit(0);
  } catch (e) {
    console.error('❌', e.message);
    await shot('error').catch(() => {});
    await browser.close().catch(() => {});
    process.exit(1);
  }
})();
