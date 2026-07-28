require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('dialog', async d => { console.log('🔔 Dialog:', d.message()); await d.accept().catch(() => {}); });

  for (const url of ['https://mazzhidrocarburos.com.mx', 'https://www.mazzhidrocarburos.com.mx']) {
    console.log(`\n=== Probando ${url} ===`);
    try {
      const resp = await page.goto(url, { waitUntil: 'load', timeout: 20000 });
      console.log('Status:', resp.status(), '| URL final:', page.url());
      const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 1500));
      console.log('BODY:\n', bodyText);
      const enlaces = await page.evaluate(() =>
        Array.from(document.querySelectorAll('a')).map(a => ({ text: a.textContent.trim(), href: a.href })).filter(a => a.text)
      );
      console.log('ENLACES:', JSON.stringify(enlaces.slice(0, 30), null, 2));
      const buf = await page.screenshot({ fullPage: true });
      console.log('📸', await subirArchivoR2(buf, `debug/hemajo_home_${Date.now()}.png`, 'image/png'));
      break; // si cargó bien, no probar la siguiente variante
    } catch (e) {
      console.log('❌ Error:', e.message);
    }
  }

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
