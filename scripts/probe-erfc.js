require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

async function dump(page, label) {
  const buf = await page.screenshot({ fullPage: true }).catch(() => null);
  if (buf) {
    const u = await subirArchivoR2(buf, `debug/erfc_probe_${label}_${Date.now()}.png`, 'image/png');
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
    return { url: location.href, title: document.title, inputs, botones, bodyTextSample: (document.body.innerText || '').slice(0, 700) };
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

  console.log('🌐 Cargando erfc.com.mx ...');
  const r = await page.goto('https://www.erfc.com.mx', { waitUntil: 'load', timeout: 30000 });
  console.log('Status:', r.status());
  await page.waitForTimeout(2000);
  await dump(page, 'p1_home');

  console.log('\n➡️ Llenando correo + RFC...');
  await page.click('#correo'); await page.keyboard.type('buzonfacturas@serviciosga.site', { delay: 20 });
  await page.click('#rfc'); await page.keyboard.type('GPR110128QD8', { delay: 20 });

  console.log('➡️ Click en "Leer Términos y Condiciones" (el checkbox está disabled hasta esto)...');
  await page.click('#link_terminos_condiciones');
  await page.waitForTimeout(1000);
  await dump(page, 'p1c_modal_terminos');
  const disabledNow = await page.$eval('#accept_terminos_condiciones', el => el.disabled);
  console.log('Checkbox disabled tras leer términos:', disabledNow);
  await page.click('#accept_terminos_condiciones');
  const checkedAfter = await page.$eval('#accept_terminos_condiciones', el => el.checked);
  console.log('Checkbox checked después de click real:', checkedAfter);
  await dump(page, 'p1b_checkbox');

  await page.click('#btn-access');
  await page.waitForTimeout(2500);
  await dump(page, 'p2_post_ingresar');

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌ Error:', e.message); process.exit(1); });
