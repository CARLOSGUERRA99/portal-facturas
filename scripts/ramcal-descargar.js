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
    if (/xml|pdf|zip|octet-stream/i.test(ct)) {
      archivos.push({ url: resp.url(), ct, status: resp.status() });
    }
  });

  await page.goto('http://ramcal.no-ip.net:8082/bajatufactura/', { waitUntil: 'networkidle2', timeout: 25000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('input,button')).find(x => /generaci[oó]n de factura$/i.test((x.value || x.textContent || '').trim()));
    if (b) b.click();
  });
  await page.waitForTimeout(1200);
  await page.click('#rfc');
  await page.keyboard.type('GPR110128QD8', { delay: 30 });
  await page.waitForTimeout(300);
  await page.click('input[name="btn_submit_codigo"]');
  await page.waitForTimeout(2000);
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('input,button,a')).find(x => /seleccionar/i.test((x.value || x.textContent || '').trim()));
    if (b) b.click();
  });
  await page.waitForTimeout(2000);
  const codigoInput = await page.$('input[name="codigo[]"]');
  await codigoInput.click();
  await page.keyboard.type('01292742361', { delay: 30 });
  await page.waitForTimeout(300);
  await page.click('input[name="btn_submit_nf"]');
  await page.waitForTimeout(2500);

  // Ya facturado antes: puede ir directo a la pantalla de resultado, o pedir de nuevo cuenta/uso
  let bodyNow = await page.evaluate(() => document.body.innerText);
  if (!/Factura:\s*P/i.test(bodyNow)) {
    await page.click('input[name="cuentapago"]').catch(() => {});
    await page.keyboard.type('8510', { delay: 30 }).catch(() => {});
    await page.click('#btn_facturar').catch(() => {});
    await page.waitForTimeout(4000);
    bodyNow = await page.evaluate(() => document.body.innerText);
  }
  console.log('BODY:\n', bodyNow.slice(0, 500));

  console.log('➡️ Click Descargar...');
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('input,button,a')).find(x => /descargar/i.test((x.value || x.textContent || '').trim()));
    if (b) b.click();
  });
  await page.waitForTimeout(3000);

  console.log('URL tras Descargar:', page.url());
  const bodyDescarga = await page.evaluate(() => document.body.innerText.slice(0, 1500));
  console.log('BODY tras Descargar:\n', bodyDescarga);

  const enlaces = await page.evaluate(() => Array.from(document.querySelectorAll('a')).map(a => ({ text: a.textContent.trim(), href: a.href })));
  console.log('\nENLACES en pantalla de descarga:', JSON.stringify(enlaces, null, 2));

  console.log('\n=== ARCHIVOS detectados (xml/pdf/zip) ===');
  console.log(JSON.stringify(archivos, null, 2));

  const buf = await page.screenshot({ fullPage: true });
  console.log('📸', await subirArchivoR2(buf, `debug/ramcal_descarga_${Date.now()}.png`, 'image/png'));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
