require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('dialog', async d => { console.log('🔔 Dialog:', d.message()); await d.accept().catch(() => {}); });

  await page.goto('https://app.facturagas.net/generar_factura.aspx', { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('#rstation_Input', { timeout: 15000 });

  await page.click('#rstation_Input');
  await page.keyboard.type('Suministros Energeticos', { delay: 30 });
  await page.waitForTimeout(1800);

  console.log('➡️ Click en la opción de la lista...');
  const clicked = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('li, .dx-item, [role="option"]'));
    const el = items.find(i => /SUMINISTROS ENERGETICOS/i.test(i.textContent || '') && i.offsetParent !== null);
    if (el) { el.click(); return true; }
    return false;
  });
  console.log('clicked:', clicked);
  await page.waitForTimeout(1000);

  await page.click('#despacho');
  await page.keyboard.type('2025730', { delay: 20 });
  await page.click('#webId');
  await page.keyboard.type('60844255', { delay: 20 });

  const buf1 = await page.screenshot({ fullPage: true });
  console.log('📸 form:', await subirArchivoR2(buf1, `debug/facturagas_form_${Date.now()}.png`, 'image/png'));

  console.log('\n➡️ Click Consultar Ticket...');
  await page.click('#btnSerchTk');
  await page.waitForTimeout(3000);

  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 1500));
  console.log('Texto tras Consultar:\n', bodyText);

  const buf2 = await page.screenshot({ fullPage: true });
  console.log('📸 resultado:', await subirArchivoR2(buf2, `debug/facturagas_resultado_${Date.now()}.png`, 'image/png'));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
