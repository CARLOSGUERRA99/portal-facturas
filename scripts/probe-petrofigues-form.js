require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  const apiCalls = [];
  page.on('response', async (resp) => {
    const url = resp.url();
    if (!/facturacionestacion\.com/i.test(url) || /\.(js|css|png|jpg|svg|woff|ico)(\?|$)/i.test(url)) return;
    let body = null;
    try { body = (await resp.text()).slice(0, 800); } catch {}
    apiCalls.push({ status: resp.status(), url, method: resp.request().method(), body });
  });

  await page.goto('https://petrofigues.facturacionestacion.com/', { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('#txtReferencia', { timeout: 15000 });

  await page.click('#txtReferencia'); await page.keyboard.type('13697', { delay: 20 });
  await page.click('#txtFolio'); await page.keyboard.type('1067336', { delay: 20 });
  await page.click('#txtAmount'); await page.keyboard.type('1000.00', { delay: 20 });
  await page.click('#txtRFC'); await page.keyboard.type('GPR110128QD8', { delay: 20 });

  const buf1 = await page.screenshot({ fullPage: true });
  console.log('📸 form:', await subirArchivoR2(buf1, `debug/petrofigues_form_${Date.now()}.png`, 'image/png'));

  console.log('\n➡️ Click Buscar...');
  await page.click('#btnNext');
  await page.waitForTimeout(3000);

  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 1500));
  console.log('\nTexto tras Buscar:\n', bodyText);

  const buf2 = await page.screenshot({ fullPage: true });
  console.log('📸 resultado:', await subirArchivoR2(buf2, `debug/petrofigues_resultado_${Date.now()}.png`, 'image/png'));

  console.log('\n=== API CALLS ===');
  console.log(JSON.stringify(apiCalls, null, 2));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
