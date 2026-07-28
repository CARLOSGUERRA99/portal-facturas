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
    const b = Array.from(document.querySelectorAll('input,button')).find(x => /^descargar factura$/i.test((x.value || x.textContent || '').trim()));
    if (b) b.click();
  });
  await page.waitForTimeout(1200);
  await page.click('#btn_nf');
  await page.waitForTimeout(1200);
  await page.click('input[name="factura"]');
  await page.keyboard.type('P275856', { delay: 30 });
  await page.waitForTimeout(300);
  await page.click('input[name="btn_submit_nf"]');
  await page.waitForTimeout(2000);
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('input,button,a')).find(x => /enviar correo/i.test((x.value || x.textContent || '').trim()));
    if (b) b.click();
  });
  await page.waitForTimeout(1500);

  console.log('➡️ Cambiando correo a buzonfacturas@serviciosga.site...');
  const emailInput = await page.$('#email');
  await emailInput.click({ clickCount: 3 });
  await page.keyboard.type('buzonfacturas@serviciosga.site', { delay: 25 });
  await page.waitForTimeout(300);

  console.log('➡️ Click Enviar...');
  await page.click('#ev_cr');
  await page.waitForTimeout(3000);

  const bodyFinal = await page.evaluate(() => document.body.innerText.slice(0, 1200));
  console.log('\nBODY tras Enviar:\n', bodyFinal);

  const buf = await page.screenshot({ fullPage: true });
  console.log('📸', await subirArchivoR2(buf, `debug/ramcal_correo_enviado_${Date.now()}.png`, 'image/png'));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
