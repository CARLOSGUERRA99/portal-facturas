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
    if (!/facturagas\.net/i.test(url) || /\.(js|css|png|jpg|svg|woff|ico|gif)(\?|$)/i.test(url)) return;
    let body = null;
    try { body = (await resp.text()).slice(0, 600); } catch {}
    apiCalls.push({ status: resp.status(), url, body });
  });

  await page.goto('https://app.facturagas.net/generar_factura.aspx', { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('#rstation_Input', { timeout: 15000 });

  console.log('➡️ Escribiendo en el buscador de estación...');
  await page.click('#rstation_Input');
  await page.keyboard.type('Suministros Energeticos', { delay: 40 });
  await page.waitForTimeout(2000);

  const bodyText1 = await page.evaluate(() => document.body.innerText.slice(0, 500));
  console.log('Texto tras escribir:', bodyText1);

  const opciones = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('li, .dx-item, [role="option"]'));
    return items.filter(i => i.offsetParent !== null).map(i => i.textContent.trim()).filter(Boolean).slice(0, 20);
  });
  console.log('Opciones visibles:', JSON.stringify(opciones));

  const buf = await page.screenshot({ fullPage: true });
  console.log('📸', await subirArchivoR2(buf, `debug/facturagas_estacion_${Date.now()}.png`, 'image/png'));

  console.log('\n=== API CALLS ===');
  console.log(JSON.stringify(apiCalls, null, 2));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
