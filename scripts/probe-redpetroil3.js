require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('dialog', async d => { console.log('🔔 Dialog:', d.message()); await d.accept().catch(() => {}); });

  await page.goto('https://es11469.migasolinera.net/bajatufactura/', { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(1200);
  await page.click('#btn_facturar');
  await page.waitForTimeout(1200);
  await page.click('#rfc'); await page.keyboard.type('GPR110128QD8', { delay: 15 });
  await page.evaluate(() => document.querySelector('input[name="btn_submit_codigo"]').click());
  await page.waitForTimeout(1800);
  await page.evaluate(() => { const a = Array.from(document.querySelectorAll('a')).find(x => /seleccionar/i.test(x.textContent || '')); if (a) a.click(); });
  await page.waitForTimeout(1800);
  await page.click('input[name="codigo[]"]');
  await page.keyboard.type('68294937177', { delay: 20 });

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'load', timeout: 15000 }).catch(() => null),
    page.click('#submit'),
  ]);
  await page.waitForTimeout(1500);

  console.log('URL final:', page.url());
  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 1200)).catch(e => 'ERROR: ' + e.message);
  console.log('BODY:', bodyText);
  const buf = await page.screenshot({ fullPage: true }).catch(() => null);
  if (buf) console.log('📸', await subirArchivoR2(buf, `debug/redpetroil_codigo3_${Date.now()}.png`, 'image/png'));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
