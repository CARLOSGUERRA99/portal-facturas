/**
 * Reconocimiento real de soriana.com — login por magic link + formulario de
 * facturación electrónica. Solo observa, no envía nada real todavía.
 * Uso: node scripts/probe-soriana.js
 */
require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

async function dump(page, label) {
  const buf = await page.screenshot({ fullPage: true }).catch(() => null);
  if (buf) {
    const u = await subirArchivoR2(buf, `debug/soriana_probe_${label}_${Date.now()}.png`, 'image/png');
    console.log(`📸 [${label}]: ${u}`);
  }
  const info = await page.evaluate(() => {
    const visible = el => el.offsetParent !== null;
    const inputs = Array.from(document.querySelectorAll('input, textarea, select')).filter(visible).map(i => ({
      tag: i.tagName, type: i.type || null, id: i.id || null, name: i.name || null,
      placeholder: i.placeholder || null, value: (i.value || '').slice(0, 40),
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

  const apiCalls = [];
  page.on('response', async (resp) => {
    const url = resp.url();
    if (/\.(js|css|png|jpg|jpeg|svg|woff|woff2|ico|map)(\?|$)/i.test(url)) return;
    if (!/soriana/i.test(url)) return;
    let body = null;
    try { body = (await resp.text()).slice(0, 600); } catch {}
    apiCalls.push({ status: resp.status(), url, method: resp.request().method(), body });
  });

  console.log('🌐 Cargando soriana.com/iniciar-sesion ...');
  await page.goto('https://www.soriana.com/iniciar-sesion', { waitUntil: 'load', timeout: 30000 }).catch(async (e) => {
    console.log(`⚠️ falló con www: ${e.message} — probando sin www`);
    await page.goto('https://soriana.com/iniciar-sesion', { waitUntil: 'load', timeout: 30000 });
  });
  await page.waitForTimeout(2000);
  await dump(page, 'p1_login');

  console.log('\n=== API CALLS (soriana) hasta aquí ===');
  console.log(JSON.stringify(apiCalls, null, 2));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌ Error:', e.message); process.exit(1); });
