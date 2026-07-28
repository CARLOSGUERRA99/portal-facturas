require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1000 });
  page.on('dialog', async d => { await d.accept().catch(() => {}); });

  const archivos = [];
  page.on('response', async (resp) => {
    const ct = resp.headers()['content-type'] || '';
    const disp = resp.headers()['content-disposition'] || '';
    if (/xml|pdf|zip|octet-stream/i.test(ct) || /attachment/i.test(disp)) {
      archivos.push({ url: resp.url(), ct, disp, status: resp.status() });
    }
  });

  await page.goto('http://ramcal.no-ip.net:8082/bajatufactura/', { waitUntil: 'networkidle2', timeout: 25000 });
  await page.waitForTimeout(1500);

  console.log('➡️ Click "Descargar Factura"...');
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('input,button')).find(x => /^descargar factura$/i.test((x.value || x.textContent || '').trim()));
    if (b) b.click();
  });
  await page.waitForTimeout(1500);

  const body1 = await page.evaluate(() => document.body.innerText.slice(0, 1000));
  console.log('BODY tras Descargar Factura:\n', body1);

  const inputs1 = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('input,select,button')).map(el => ({
      tag: el.tagName, id: el.id, name: el.name, type: el.type, value: (el.value||'').slice(0,30), visible: !!(el.offsetWidth||el.offsetHeight),
    })).filter(el => el.visible);
  });
  console.log('\n=== CAMPOS ===');
  console.log(JSON.stringify(inputs1, null, 2));

  const buf1 = await page.screenshot({ fullPage: true });
  console.log('📸 menú descarga:', await subirArchivoR2(buf1, `debug/ramcal_menu_descarga_${Date.now()}.png`, 'image/png'));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
