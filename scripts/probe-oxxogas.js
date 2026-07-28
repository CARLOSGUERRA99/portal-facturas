require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

async function dump(page, label) {
  const buf = await page.screenshot({ fullPage: true }).catch(() => null);
  if (buf) console.log(`📸 [${label}]:`, await subirArchivoR2(buf, `debug/oxxogas_probe_${label}_${Date.now()}.png`, 'image/png'));
  const info = await page.evaluate(() => {
    const visible = el => el.offsetParent !== null;
    const inputs = Array.from(document.querySelectorAll('input, textarea, select')).filter(visible).map(i => ({
      tag: i.tagName, type: i.type || null, id: i.id || null, name: i.name || null, placeholder: i.placeholder || null,
    }));
    const botones = Array.from(document.querySelectorAll('a, button, input[type="button"], input[type="submit"]')).filter(visible).map(b => ({
      tag: b.tagName, id: b.id || null, text: (b.textContent || b.value || '').trim().slice(0, 60), href: b.href || null,
    }));
    // Señales de CAPTCHA
    const captchaHints = [];
    if (document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"]')) captchaHints.push('iframe de captcha detectado');
    if (/captcha/i.test(document.body.innerHTML)) captchaHints.push('palabra "captcha" en el HTML');
    return { url: location.href, title: document.title, inputs, botones, captchaHints, bodyTextSample: (document.body.innerText || '').slice(0, 500) };
  });
  console.log(`=== ${label} ===`, JSON.stringify(info, null, 2));
  return info;
}

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

  console.log('🌐 Cargando facturacion.oxxogas.com ...');
  let r;
  try {
    r = await page.goto('https://facturacion.oxxogas.com', { waitUntil: 'load', timeout: 30000 });
  } catch (e) {
    console.log('falló https, probando http:', e.message);
    r = await page.goto('http://facturacion.oxxogas.com', { waitUntil: 'load', timeout: 30000 });
  }
  console.log('Status:', r.status(), 'URL final:', page.url());
  await page.waitForTimeout(2000);
  const info = await dump(page, 'p1_home');

  if (info.captchaHints.length) {
    console.log('\n🛑 CAPTCHA detectado — me detengo aquí, no lo intento resolver.');
  }

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌ Error:', e.message); process.exit(1); });
