require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('dialog', async d => { console.log('🔔 Dialog:', d.message()); await d.accept().catch(() => {}); });

  await page.goto('https://factura.enerfueltech.com/', { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForTimeout(3000);

  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 2500));
  console.log('BODY:\n', bodyText);

  const inputs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('input,select,textarea,button')).map(el => ({
      tag: el.tagName, id: el.id, name: el.name, type: el.type, placeholder: el.placeholder, texto: (el.textContent||'').trim().slice(0,40),
    })).filter(el => el.type !== 'hidden');
  });
  console.log('\n=== CAMPOS ===');
  console.log(JSON.stringify(inputs, null, 2));

  const buf = await page.screenshot({ fullPage: true });
  console.log('📸', await subirArchivoR2(buf, `debug/enerfueltech_home2_${Date.now()}.png`, 'image/png'));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
