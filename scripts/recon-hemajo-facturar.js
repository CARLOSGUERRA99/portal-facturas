require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('dialog', async d => { console.log('🔔 Dialog:', d.message()); await d.accept().catch(() => {}); });

  await page.goto('http://hemajolasuerte.ddns.net:8087/ControlGasFE/', { waitUntil: 'load', timeout: 25000 });
  await page.waitForTimeout(1000);

  console.log('➡️ Click en "Facturar"...');
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(e => console.log('nav wait:', e.message)),
    page.evaluate(() => { const b = document.getElementById('facturar'); if (b) b.click(); }),
  ]);
  await page.waitForTimeout(2000);

  console.log('URL tras click:', page.url());
  const inputs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('input,select,textarea')).map(el => ({
      tag: el.tagName, id: el.id, name: el.name, type: el.type, placeholder: el.placeholder, maxlength: el.maxLength,
    })).filter(el => el.type !== 'hidden');
  });
  console.log('=== CAMPOS visibles ===');
  console.log(JSON.stringify(inputs, null, 2));

  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 1500));
  console.log('\nBODY:\n', bodyText);

  const buf = await page.screenshot({ fullPage: true });
  console.log('📸', await subirArchivoR2(buf, `debug/hemajo_facturar_${Date.now()}.png`, 'image/png'));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
