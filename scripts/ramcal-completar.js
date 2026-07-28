require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
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

  console.log('➡️ Editar Datos — corrigiendo domicilio con datos reales de la Constancia...');
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('input,button,a')).find(x => /editar datos/i.test((x.value || x.textContent || '').trim()));
    if (b) b.click();
  });
  await page.waitForTimeout(2000);

  async function setVal(name, valor) {
    const el = await page.$(`input[name="${name}"]`);
    await el.click({ clickCount: 3 });
    await page.keyboard.type(valor, { delay: 15 });
  }
  await setVal('calle', 'AEROPUERTO');
  await setVal('noexterior', '7569');
  await setVal('nointerior', '1');
  await setVal('colonia', 'BACHIGUALATO');
  await setVal('municipio', 'CULIACAN');
  await setVal('estado', 'SINALOA');
  await setVal('cp', '80140');
  await page.waitForTimeout(300);

  const buf1 = await page.screenshot({ fullPage: true });
  console.log('📸 antes de Actualizar:', await subirArchivoR2(buf1, `debug/ramcal_editado_${Date.now()}.png`, 'image/png'));

  await page.click('#btn_cli_actualizar');
  await page.waitForTimeout(2500);

  const bodyTrasActualizar = await page.evaluate(() => document.body.innerText.slice(0, 1200));
  console.log('BODY tras Actualizar:\n', bodyTrasActualizar);

  const buf2 = await page.screenshot({ fullPage: true });
  console.log('📸 tras Actualizar:', await subirArchivoR2(buf2, `debug/ramcal_tras_actualizar_${Date.now()}.png`, 'image/png'));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
