require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1000 });
  page.on('dialog', async d => { console.log('🔔 Dialog:', d.message()); await d.accept().catch(() => {}); });

  const netLog = [];
  page.on('response', async (resp) => {
    if (/factur|pdf|xml/i.test(resp.url())) netLog.push({ url: resp.url(), status: resp.status(), ct: resp.headers()['content-type'] });
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

  console.log('➡️ Cuenta de pago (últimos 4 dígitos): 8510...');
  await page.click('input[name="cuentapago"]');
  await page.keyboard.type('8510', { delay: 30 });
  await page.waitForTimeout(300);

  const usoCfdiVal = await page.$eval('#usocfdi', el => el.value);
  console.log('Uso CFDI (ya default):', usoCfdiVal);

  const buf1 = await page.screenshot({ fullPage: true });
  console.log('📸 antes de Facturar:', await subirArchivoR2(buf1, `debug/ramcal_antes_facturar_${Date.now()}.png`, 'image/png'));

  console.log('➡️ Click Facturar (emisión real)...');
  await page.click('#btn_facturar');
  await page.waitForTimeout(6000);

  const bodyFinal = await page.evaluate(() => document.body.innerText.slice(0, 2000));
  console.log('\nBODY FINAL:\n', bodyFinal);

  console.log('\n=== NETWORK LOG ===');
  console.log(JSON.stringify(netLog, null, 2));

  const buf2 = await page.screenshot({ fullPage: true });
  console.log('📸 resultado:', await subirArchivoR2(buf2, `debug/ramcal_resultado_${Date.now()}.png`, 'image/png'));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
