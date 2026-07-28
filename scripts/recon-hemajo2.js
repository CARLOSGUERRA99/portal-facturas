require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('dialog', async d => { console.log('🔔 Dialog:', d.message()); await d.accept().catch(() => {}); });

  const resp = await page.goto('https://mazzhidrocarburos.com.mx/?page_id=2', { waitUntil: 'load', timeout: 25000 });
  console.log('Status:', resp.status(), '| URL final:', page.url());

  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 2000));
  console.log('BODY:\n', bodyText);

  const formInfo = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('form')).map(f => ({
      action: f.action, method: f.method, id: f.id,
      inputs: Array.from(f.querySelectorAll('input,select,textarea')).map(el => ({
        tag: el.tagName, id: el.id, name: el.name, type: el.type, placeholder: el.placeholder,
      })),
    }));
  });
  console.log('\n=== FORMULARIOS ===');
  console.log(JSON.stringify(formInfo, null, 2));

  // ¿Hay iframe con el form real (común en sitios WordPress con formularios embebidos)?
  const iframes = await page.evaluate(() => Array.from(document.querySelectorAll('iframe')).map(f => f.src));
  console.log('\nIFRAMES:', JSON.stringify(iframes, null, 2));

  const buf = await page.screenshot({ fullPage: true });
  console.log('📸', await subirArchivoR2(buf, `debug/hemajo_facturacion_${Date.now()}.png`, 'image/png'));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
