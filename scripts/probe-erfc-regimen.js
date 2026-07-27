require('dotenv').config();
const puppeteer = require('puppeteer');

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1000 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

  page.on('console', msg => console.log(`🖥️ CONSOLE [${msg.type()}]:`, msg.text()));
  page.on('pageerror', err => console.log('💥 PAGE ERROR:', err.message));

  const apiCalls = [];
  page.on('response', async (resp) => {
    const url = resp.url();
    if (!/erfc\.com\.mx/i.test(url) || /\.(js|css|png|jpg|svg|woff|ico|jpeg)(\?|$)/i.test(url)) return;
    let body = null;
    try { body = (await resp.text()).slice(0, 600); } catch {}
    apiCalls.push({ status: resp.status(), url, method: resp.request().method(), body });
  });

  await page.goto('https://www.erfc.com.mx', { waitUntil: 'load', timeout: 30000 });
  await page.click('#correo'); await page.keyboard.type('buzonfacturas@serviciosga.site', { delay: 10 });
  await page.click('#rfc'); await page.keyboard.type('GPR110128QD8', { delay: 10 });
  await page.click('#link_terminos_condiciones');
  await page.waitForTimeout(500);
  await page.click('#accept_terminos_condiciones');
  await page.click('#btn-access');
  await page.waitForTimeout(2500);

  console.log('➡️ CP + blur...');
  await page.click('#DomicilioFiscalReceptor'); await page.keyboard.type('80140', { delay: 15 });
  await page.click('#nombre'); // blur CP
  await page.waitForTimeout(2500);

  const opciones1 = await page.$$eval('#RegimenFiscalReceptor option', opts => opts.map(o => ({ value: o.value, text: o.text })));
  console.log('Opciones régimen tras blur CP:', JSON.stringify(opciones1));

  // Probar Tab / Enter también
  await page.keyboard.press('Tab');
  await page.waitForTimeout(1500);
  const opciones2 = await page.$$eval('#RegimenFiscalReceptor option', opts => opts.map(o => ({ value: o.value, text: o.text })));
  console.log('Opciones régimen tras Tab:', JSON.stringify(opciones2));

  console.log('\n=== API CALLS ===');
  console.log(JSON.stringify(apiCalls, null, 2));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
