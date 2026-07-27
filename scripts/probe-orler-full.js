require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

async function dump(page, label) {
  const buf = await page.screenshot({ fullPage: true }).catch(() => null);
  if (buf) {
    const u = await subirArchivoR2(buf, `debug/orler_probe_${label}_${Date.now()}.png`, 'image/png');
    console.log(`📸 [${label}]: ${u}`);
  }
  const bodyText = await page.evaluate(() => (document.body.innerText || '').slice(0, 1200));
  console.log(`\n=== ${label} ===\n${bodyText}`);
}

(async () => {
  const user = process.env.ORLER_SINALOA_USER;
  const pass = process.env.ORLER_SINALOA_PASS;
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

  await page.goto('https://facturacion.sinaloa.gob.mx/login', { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('input[name="user"]', { timeout: 15000 });
  await page.click('input[name="user"]'); await page.keyboard.type(user, { delay: 20 });
  await page.click('input[name="password"]'); await page.keyboard.type(pass, { delay: 20 });
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(x => /iniciar sesi[oó]n/i.test(x.textContent || ''));
    if (b) b.click();
  });
  await page.waitForTimeout(3000);
  await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('a, button')).find(x => /solicitar nueva factura/i.test(x.textContent || ''));
    if (el) el.click();
  });
  await page.waitForTimeout(2000);

  const radios = await page.$$('input[name="caseta"]');
  await radios[0].click(); // "Sí"
  await page.waitForTimeout(800);

  await page.click('input[name="carril"]');
  await page.keyboard.type('5801', { delay: 30 });

  await page.click('input[name="folio"]');
  await page.keyboard.type('0944056', { delay: 30 });

  // Fecha de pago — datepicker Material: click para abrir, navegar a 24 de julio 2026
  const fechaEl = await page.evaluateHandle(() => Array.from(document.querySelectorAll('input')).find(i => (i.id || '').includes('FechadePago')));
  await fechaEl.asElement().click();
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    const dias = Array.from(document.querySelectorAll('button, td, div'));
    const el = dias.find(d => (d.textContent || '').trim() === '24' && d.offsetParent !== null);
    if (el) el.click();
  });
  await page.waitForTimeout(500);
  await dump(page, 'p7_post_fecha');

  await page.click('input[name="amount"]');
  await page.keyboard.type('101.00', { delay: 30 });
  await dump(page, 'p8_form_completo');

  console.log('\n➡️ Click BUSCAR...');
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(x => /^buscar$/i.test((x.textContent || '').trim()));
    if (b) b.click();
  });
  await page.waitForTimeout(3000);
  await dump(page, 'p9_resultado_buscar');

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
