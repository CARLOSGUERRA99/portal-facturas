/**
 * Reconocimiento real de facturacion.sinaloa.gob.mx (Orler).
 * Solo mapea la ESTRUCTURA del login (sin usar credenciales reales todavía).
 * Uso: node scripts/probe-orler.js
 */
require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

async function dump(page, label) {
  const buf = await page.screenshot({ fullPage: true }).catch(() => null);
  if (buf) {
    const u = await subirArchivoR2(buf, `debug/orler_probe_${label}_${Date.now()}.png`, 'image/png');
    console.log(`📸 [${label}]: ${u}`);
  }
  const info = await page.evaluate(() => {
    const visible = el => el.offsetParent !== null;
    const inputs = Array.from(document.querySelectorAll('input, textarea, select')).filter(visible).map(i => ({
      tag: i.tagName, type: i.type || null, id: i.id || null, name: i.name || null, placeholder: i.placeholder || null,
    }));
    const botones = Array.from(document.querySelectorAll('a, button, input[type="button"], input[type="submit"]')).filter(visible).map(b => ({
      tag: b.tagName, id: b.id || null, text: (b.textContent || b.value || '').trim().slice(0, 60), href: b.href || null,
    }));
    return { url: location.href, title: document.title, inputs, botones, bodyTextSample: (document.body.innerText || '').slice(0, 600) };
  });
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(info, null, 2));
  return info;
}

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

  console.log('🌐 Cargando facturacion.sinaloa.gob.mx ...');
  const r = await page.goto('https://facturacion.sinaloa.gob.mx', { waitUntil: 'load', timeout: 30000 });
  console.log('Status:', r.status());
  await page.waitForTimeout(1500);
  await dump(page, 'p1_home');

  // Buscar y click "Iniciar sesión"
  const clicked = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('a, button')).find(x => /iniciar sesi[oó]n/i.test(x.textContent || ''));
    if (el) { el.click(); return true; }
    return false;
  });
  console.log(`\n➡️ Click "Iniciar sesión": ${clicked}`);
  await page.waitForTimeout(2000);
  await dump(page, 'p2_login_form');

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌ Error:', e.message); process.exit(1); });
