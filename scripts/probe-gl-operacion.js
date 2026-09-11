/**
 * Sonda de gl-operacion.com.mx ("Facturación GL") — ticket #379
 * Multiservicio Chapa de Mota, Pemex ES 11595.
 *
 * SOLO LECTURA / DIAGNOSTICO. Se detiene en la pantalla de captura de tickets
 * (WebId + Monto). NUNCA llega a confirmacion.php ni a inserta_solicitud_factura.php.
 */
require('dotenv').config();
const puppeteer = require('puppeteer');

const BASE = 'https://www.gl-operacion.com.mx';
const TIPO_ESTACION = 2;      // Pemex
const NUM_ESTACION = '11595'; // "Pemex ES 11595" del ticket
const RFC_RECEPTOR = 'GPR110128QD8';

async function dump(page, label) {
  const info = await page.evaluate(() => {
    const vis = el => el.offsetParent !== null;
    return {
      url: location.href,
      title: document.title,
      inputs: Array.from(document.querySelectorAll('input,select,textarea')).filter(vis).map(i => ({
        tag: i.tagName, type: i.type || null, id: i.id || null, name: i.name || null,
        placeholder: i.placeholder || null, maxlength: i.getAttribute('maxlength') || null,
      })),
      botones: Array.from(document.querySelectorAll('a,button,input[type=submit],input[type=button]')).filter(vis)
        .map(b => ({ id: b.id || null, text: (b.textContent || b.value || '').trim().slice(0, 60) })),
      texto: (document.body.innerText || '').replace(/\n{2,}/g, '\n').slice(0, 1200),
    };
  });
  console.log(`\n=== ${label} ===\n` + JSON.stringify(info, null, 2));
  return info;
}

(async () => {
  // Browserless suele ir a 429 cuando varios agentes lo usan a la vez -> caemos a Chrome local.
  const token = process.env.BROWSERLESS_TOKEN;
  let browser;
  if (process.env.PROBE_LOCAL === '1') {
    browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
    console.log('🖥️  Chrome local');
  } else {
    try {
      browser = await puppeteer.connect({
        browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true`,
      });
      console.log('☁️  Browserless');
    } catch (e) {
      console.log('⚠️  Browserless falló (' + e.message + '), uso Chrome local');
      browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
    }
  }
  const page = await browser.newPage();
  page.on('dialog', d => d.accept().catch(() => {}));
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

  // 1) Home
  const r = await page.goto(BASE + '/index.php', { waitUntil: 'networkidle2', timeout: 45000 });
  console.log('Status home:', r.status(), page.url());
  await dump(page, 'p1_home');

  // 2) ¿Está registrada la estación? -> mysql_busca_estacion.php (1 = sí, 0 = no)
  const valida = await page.evaluate(async (num, tipo) => {
    const fd = new URLSearchParams({ num_franquicia: num, tipo });
    const res = await fetch('mysql_busca_estacion.php', {
      method: 'POST', body: fd,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
    });
    return { status: res.status, body: (await res.text()).trim().slice(0, 300) };
  }, NUM_ESTACION, TIPO_ESTACION);
  console.log('\n>>> mysql_busca_estacion.php (Pemex 11595):', JSON.stringify(valida));

  // 3) Avanzar por el flujo real: index -> rfc.php -> opciones.php
  await page.select('#cmdTipoEstacion', String(TIPO_ESTACION));
  await page.evaluate(() => typeof cambioTipo === 'function' && cambioTipo());
  await page.type('#txtNumFranquicia', NUM_ESTACION);
  await page.evaluate(() => aceptarEstacion());
  await new Promise(r => setTimeout(r, 2500));
  await dump(page, 'p2_rfc');

  // 4) RFC del receptor -> opciones.php
  const hayRfc = await page.$('#txtRfc');
  if (hayRfc) {
    await page.type('#txtRfc', RFC_RECEPTOR);
    await page.evaluate((n, t) => aceptarRfc(n, t), NUM_ESTACION, String(TIPO_ESTACION));
    await new Promise(r => setTimeout(r, 2500));
    await dump(page, 'p3_opciones');
  }

  // 5) Pantalla de captura de tickets (WebId + Monto). AQUI PARAMOS.
  const irTickets = await page.$('#txtWebId');
  if (!irTickets) {
    await page.evaluate((n, t, rfc) => {
      if (typeof generarFactura === 'function') generarFactura(n, t, rfc);
    }, NUM_ESTACION, String(TIPO_ESTACION), RFC_RECEPTOR);
    await new Promise(r => setTimeout(r, 2500));
    await dump(page, 'p4_datos_cliente');
  }

  console.log('\n🛑 PARADA DELIBERADA: no se toca confirmacion.php ni inserta_solicitud_factura.php.');
  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
