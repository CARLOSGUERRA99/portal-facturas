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
    return { inputs, bodyText: (document.body.innerText || '').slice(0, 900) };
  });
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(info, null, 2));
  return info;
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

  console.log('➡️ Click radio "Sí"...');
  const radios = await page.$$('input[name="caseta"]');
  await radios[0].click();
  await page.waitForTimeout(1000);
  await dump(page, 'p5_caseta_si');

  console.log('\n➡️ Llenando folio, fecha, importe (ticket real Orler Pisal)...');
  const folioInput = await page.$('input[name="folio"]');
  await folioInput.click();
  await page.keyboard.type('0944056', { delay: 30 });

  // Fecha de pago — probablemente un datepicker, click para ver qué aparece
  const inputs = await page.$$('input');
  const fechaInput = await page.evaluateHandle(() => {
    return Array.from(document.querySelectorAll('input')).find(i => {
      const prev = i.closest('div')?.previousElementSibling;
      return (i.id || '').includes('FechadePago');
    });
  });
  const fechaEl = fechaInput.asElement();
  if (fechaEl) { await fechaEl.click(); await page.waitForTimeout(800); }
  await dump(page, 'p6_fecha_datepicker');

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
