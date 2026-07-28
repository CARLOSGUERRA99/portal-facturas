require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('dialog', async d => { console.log('🔔 Dialog:', d.message()); await d.accept().catch(() => {}); });

  const resp = await page.goto('https://corporativoramcal.mx/facturacion/', { waitUntil: 'networkidle2', timeout: 30000 });
  console.log('Status:', resp.status(), '| URL final:', page.url());

  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 3000));
  console.log('BODY:\n', bodyText);

  const inputs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('input,select,textarea,button')).map(el => ({
      tag: el.tagName, id: el.id, name: el.name, type: el.type, placeholder: el.placeholder, texto: (el.textContent||'').trim().slice(0,40),
    })).filter(el => el.type !== 'hidden');
  });
  console.log('\n=== CAMPOS ===');
  console.log(JSON.stringify(inputs, null, 2));

  const iframes = await page.evaluate(() => Array.from(document.querySelectorAll('iframe')).map(f => f.src));
  console.log('\nIFRAMES:', JSON.stringify(iframes));

  const buf = await page.screenshot({ fullPage: true });
  console.log('📸', await subirArchivoR2(buf, `debug/ramcal_facturacion_${Date.now()}.png`, 'image/png'));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
