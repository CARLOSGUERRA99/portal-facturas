require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1000 });
  page.on('dialog', async d => { console.log('🔔 Dialog:', d.message()); await d.accept().catch(() => {}); });

  const apiCalls = [];
  page.on('response', async (resp) => {
    const url = resp.url();
    if (!/facturacionestacion\.com/i.test(url) || /\.(js|css|png|jpg|svg|woff|ico|gif)(\?|$)/i.test(url)) return;
    let body = null;
    try { body = (await resp.text()).slice(0, 900); } catch {}
    apiCalls.push({ status: resp.status(), url, body });
  });

  await page.goto('https://valerogdl.facturacionestacion.com/', { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('#txtReferencia', { timeout: 15000 });
  await page.click('#txtReferencia'); await page.keyboard.type('6060', { delay: 15 });
  await page.click('#txtFolio'); await page.keyboard.type('1929725', { delay: 15 });
  await page.click('#txtAmount'); await page.keyboard.type('399.00', { delay: 15 });
  await page.click('#txtRFC'); await page.keyboard.type('GPR110128QD8', { delay: 15 });
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(x => /buscar/i.test(x.textContent || ''));
    if (b) b.click();
  });
  await page.waitForTimeout(2800);

  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 800));
  console.log('Texto tras Buscar:\n', bodyText);

  const valores = await page.evaluate(() => {
    const ids = ['txtName', 'txtAddress', 'txtNeighborhood', 'txtZipcode', 'txtCity', 'txtEmail'];
    const out = {};
    for (const id of ids) { const el = document.getElementById(id); out[id] = el ? el.value : '(no existe)'; }
    return out;
  });
  console.log('Valores auto-rellenados:', JSON.stringify(valores, null, 2));

  const selects = await page.$$eval('select', els => els.map(e => ({ id: e.id, value: e.value, options: Array.from(e.options).map(o => o.text) })));
  console.log('Selects:', JSON.stringify(selects, null, 2));

  const buf = await page.screenshot({ fullPage: true });
  console.log('📸', await subirArchivoR2(buf, `debug/gashr_form_${Date.now()}.png`, 'image/png'));

  console.log('\n=== API CALLS ===');
  console.log(JSON.stringify(apiCalls, null, 2));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
