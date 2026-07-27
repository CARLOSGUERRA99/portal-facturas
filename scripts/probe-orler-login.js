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
      checked: i.checked ?? null,
    }));
    const botones = Array.from(document.querySelectorAll('a, button, input[type="button"], input[type="submit"]')).filter(visible).map(b => ({
      tag: b.tagName, id: b.id || null, text: (b.textContent || b.value || '').trim().slice(0, 60), href: b.href || null,
    }));
    return { url: location.href, title: document.title, inputs, botones, bodyTextSample: (document.body.innerText || '').slice(0, 900) };
  });
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(info, null, 2));
  return info;
}

(async () => {
  const user = process.env.ORLER_SINALOA_USER;
  const pass = process.env.ORLER_SINALOA_PASS;
  if (!user || !pass) throw new Error('Faltan ORLER_SINALOA_USER/PASS en el entorno');

  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

  console.log('🌐 Cargando login...');
  await page.goto('https://facturacion.sinaloa.gob.mx/login', { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('input[name="user"]', { timeout: 15000 });

  await page.click('input[name="user"]');
  await page.keyboard.type(user, { delay: 30 });
  await page.click('input[name="password"]');
  await page.keyboard.type(pass, { delay: 30 });
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(x => /iniciar sesi[oó]n/i.test(x.textContent || ''));
    if (b) b.click();
  });
  await page.waitForTimeout(3000);
  await dump(page, 'p3_post_login');

  console.log('\n➡️ Buscando "SOLICITAR NUEVA FACTURA"...');
  const clickedSolicitar = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('a, button')).find(x => /solicitar nueva factura/i.test(x.textContent || ''));
    if (el) { el.click(); return true; }
    return false;
  });
  console.log('Click:', clickedSolicitar);
  await page.waitForTimeout(2000);
  await dump(page, 'p4_nueva_factura_form');

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
