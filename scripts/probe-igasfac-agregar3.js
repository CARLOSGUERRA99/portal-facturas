require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

(async () => {
  const user = process.env.IGAS_USER;
  const pass = process.env.IGAS_PASS;
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('dialog', async d => { await d.accept().catch(() => {}); });
  page.on('console', m => console.log('CONSOLE:', m.text()));

  await page.goto('https://www.igasfac.com.mx/Identity/Account/Login?ReturnUrl=%2F', { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('#Input_Email', { timeout: 15000 });
  await page.click('#Input_Email'); await page.keyboard.type(user, { delay: 20 });
  await page.click('#Input_Password'); await page.keyboard.type(pass, { delay: 20 });
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(x => /iniciar sesi[oó]n/i.test(x.textContent || ''));
    if (b) b.click();
  });
  await page.waitForTimeout(3000);
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('a, button')).find(x => /nueva factura/i.test(x.textContent || ''));
    if (b) b.click();
  });
  await page.waitForTimeout(2000);
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim() === 'Agregar');
    if (b) b.click();
  });
  await page.waitForTimeout(1200);
  await page.waitForSelector('#Input_Folio', { visible: true, timeout: 10000 });

  // Inspeccionar el elemento: ¿tiene algún atributo de librería de máscara?
  const info = await page.evaluate(() => {
    const el = document.getElementById('Input_Folio');
    return {
      outerHTML: el.outerHTML,
      dataAttrs: Object.assign({}, el.dataset),
    };
  });
  console.log('INFO INPUT:', JSON.stringify(info, null, 2));

  console.log('➡️ Click real + focus + pulsar dígitos uno por uno...');
  const handle = await page.$('#Input_Folio');
  await handle.click({ clickCount: 3 });
  await page.waitForTimeout(300);

  const digitos = '06370047523200093301';
  for (const d of digitos) {
    await page.keyboard.press(d);
    await page.waitForTimeout(80);
  }
  await page.waitForTimeout(500);

  const valorActual = await page.$eval('#Input_Folio', el => el.value);
  console.log('Valor actual del campo (tras press individual):', valorActual);

  const buf1 = await page.screenshot({ fullPage: true });
  console.log('📸', await subirArchivoR2(buf1, `debug/igasfac_modal3_${Date.now()}.png`, 'image/png'));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
