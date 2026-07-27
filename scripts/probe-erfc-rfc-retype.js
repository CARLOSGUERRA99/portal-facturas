require('dotenv').config();
const puppeteer = require('puppeteer');

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1000 });
  page.on('console', m => console.log('CONSOLE:', m.text()));
  page.on('pageerror', e => console.log('PAGEERROR:', e.message));

  await page.goto('https://www.erfc.com.mx', { waitUntil: 'load', timeout: 30000 });
  await page.click('#correo'); await page.keyboard.type('buzonfacturas@serviciosga.site', { delay: 10 });
  await page.click('#rfc'); await page.keyboard.type('GPR110128QD8', { delay: 10 });
  await page.click('#link_terminos_condiciones');
  await page.waitForTimeout(500);
  await page.click('#accept_terminos_condiciones');
  await page.click('#btn-access');
  await page.waitForTimeout(2500);

  console.log('➡️ RE-escribiendo RFC en la página de facturación (clear + type)...');
  await page.click('#rfc', { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(300);
  await page.keyboard.type('GPR110128QD8', { delay: 40 });
  await page.keyboard.press('Tab');
  await page.waitForTimeout(2500);

  const opciones = await page.$$eval('#RegimenFiscalReceptor option', opts => opts.map(o => ({ value: o.value, text: o.text })));
  console.log('Opciones régimen tras re-escribir RFC:', JSON.stringify(opciones));

  const buf = await page.screenshot({ fullPage: true });
  require('fs').writeFileSync('C:/Users/carlo/AppData/Local/Temp/claude/C--Users-carlo/bd061180-d7e6-4587-97d7-6edd69b553bc/scratchpad/erfc_retype.png', buf);

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
