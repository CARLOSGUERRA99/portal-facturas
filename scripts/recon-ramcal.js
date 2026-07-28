require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('dialog', async d => { console.log('🔔 Dialog:', d.message()); await d.accept().catch(() => {}); });

  const resp = await page.goto('https://corporativoramcal.mx', { waitUntil: 'networkidle2', timeout: 30000 });
  console.log('Status:', resp.status(), '| URL final:', page.url());

  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 2000));
  console.log('BODY:\n', bodyText);

  const enlaces = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a')).map(a => ({ text: a.textContent.trim(), href: a.href })).filter(a => a.text || a.href)
  );
  console.log('\nENLACES:', JSON.stringify(enlaces.slice(0, 40), null, 2));

  const buf = await page.screenshot({ fullPage: true });
  console.log('📸', await subirArchivoR2(buf, `debug/ramcal_home_${Date.now()}.png`, 'image/png'));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
