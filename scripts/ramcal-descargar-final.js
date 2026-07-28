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
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('input,button')).find(x => /^descargar factura$/i.test((x.value || x.textContent || '').trim()));
    if (b) b.click();
  });
  await page.waitForTimeout(1200);

  console.log('➡️ Click "Por Factura"...');
  await page.click('#btn_nf');
  await page.waitForTimeout(1200);

  const body1 = await page.evaluate(() => document.body.innerText.slice(0, 800));
  console.log('BODY tras Por Factura:\n', body1);
  const inputs1 = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('input,button')).map(el => ({
      tag: el.tagName, id: el.id, name: el.name, type: el.type, value: (el.value||'').slice(0,30), visible: !!(el.offsetWidth||el.offsetHeight),
    })).filter(el => el.visible);
  });
  console.log('CAMPOS:', JSON.stringify(inputs1, null, 2));

  const factInput = await page.$('input[name="factura"]');
  if (factInput) {
    await factInput.click();
    await page.keyboard.type('P275856', { delay: 30 });
    await page.waitForTimeout(300);
    await page.click('input[name="btn_submit_nf"]');
    await page.waitForTimeout(2500);
  }

  const bodyFinal = await page.evaluate(() => document.body.innerText.slice(0, 1500));
  console.log('\nBODY tras buscar factura:\n', bodyFinal);

  const enlaces = await page.evaluate(() => Array.from(document.querySelectorAll('a')).map(a => ({ text: a.textContent.trim(), href: a.href })));
  console.log('\nENLACES:', JSON.stringify(enlaces, null, 2));

  console.log('\n➡️ Click Descargar (si existe)...');
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('input,button,a')).find(x => /^descargar$/i.test((x.value || x.textContent || '').trim()));
    if (b) b.click();
  });
  await page.waitForTimeout(3000);

  console.log('URL final:', page.url());
  console.log('\n=== ARCHIVOS detectados ===');
  console.log(JSON.stringify(archivos, null, 2));

  const buf = await page.screenshot({ fullPage: true });
  console.log('📸', await subirArchivoR2(buf, `debug/ramcal_por_factura_${Date.now()}.png`, 'image/png'));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
