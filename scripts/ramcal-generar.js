require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1000 });
  page.on('dialog', async d => { console.log('🔔 Dialog:', d.message()); await d.accept().catch(() => {}); });

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

  // Inspeccionar TODOS los campos de la pantalla de facturación (cuenta de pago, uso cfdi, submit)
  const inputs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('input,select,textarea,button')).map(el => ({
      tag: el.tagName, id: el.id, name: el.name, type: el.type, value: (el.value||'').slice(0,40), visible: !!(el.offsetWidth||el.offsetHeight),
    })).filter(el => el.visible);
  });
  console.log('=== CAMPOS en pantalla de facturación ===');
  console.log(JSON.stringify(inputs, null, 2));

  const buf = await page.screenshot({ fullPage: true });
  console.log('📸', await subirArchivoR2(buf, `debug/ramcal_pantalla_facturacion_${Date.now()}.png`, 'image/png'));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
