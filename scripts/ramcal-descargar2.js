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

  let body = await page.evaluate(() => document.body.innerText);
  console.log('BODY tras código:\n', body.slice(0, 400));

  if (/^\s*Factura:/im.test(body) || /Factura:\s*\n?\s*P\d+/i.test(body)) {
    console.log('✅ Ya fue facturado — pantalla de resultado directa');
  } else if (/cuenta de pago/i.test(body)) {
    console.log('➡️ Pantalla de facturación — llenando y enviando de nuevo (idempotente)...');
    await page.click('input[name="cuentapago"]');
    await page.keyboard.type('8510', { delay: 30 });
    await page.waitForTimeout(300);
    await page.click('#btn_facturar');
    await page.waitForTimeout(5000);
    body = await page.evaluate(() => document.body.innerText);
    console.log('BODY tras re-facturar:\n', body.slice(0, 400));
  }

  console.log('➡️ Click Descargar...');
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('input,button,a')).find(x => /^descargar$/i.test((x.value || x.textContent || '').trim()));
    if (b) b.click();
  });
  await page.waitForTimeout(3500);

  console.log('URL tras Descargar:', page.url());
  const bodyDescarga = await page.evaluate(() => document.body.innerText.slice(0, 1500));
  console.log('BODY tras Descargar:\n', bodyDescarga);

  const enlaces = await page.evaluate(() => Array.from(document.querySelectorAll('a')).map(a => ({ text: a.textContent.trim(), href: a.href })));
  console.log('\nENLACES:', JSON.stringify(enlaces, null, 2));

  console.log('\n=== ARCHIVOS detectados ===');
  console.log(JSON.stringify(archivos, null, 2));

  const buf = await page.screenshot({ fullPage: true });
  console.log('📸', await subirArchivoR2(buf, `debug/ramcal_descarga2_${Date.now()}.png`, 'image/png'));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
