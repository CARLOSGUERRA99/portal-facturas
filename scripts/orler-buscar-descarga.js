require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

(async () => {
  const user = process.env.ORLER_SINALOA_USER;
  const pass = process.env.ORLER_SINALOA_PASS;
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('dialog', async d => { await d.accept().catch(() => {}); });

  await page.goto('https://facturacion.sinaloa.gob.mx/login', { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('input[name="user"]', { timeout: 15000 });
  await page.click('input[name="user"]'); await page.keyboard.type(user, { delay: 25 });
  await page.click('input[name="password"]'); await page.keyboard.type(pass, { delay: 25 });
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(x => /iniciar|entrar|acceder/i.test(x.textContent || ''));
    if (b) b.click();
  });
  await page.waitForTimeout(4000);

  console.log('URL tras login:', page.url());
  const enlaces = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a')).map(a => ({ text: a.textContent.trim().replace(/\s+/g, ' '), href: a.href })).filter(a => a.text)
  );
  console.log('=== ENLACES del menú ===');
  console.log(JSON.stringify(enlaces, null, 2));

  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 1500));
  console.log('\n=== BODY ===\n', bodyText);

  const buf = await page.screenshot({ fullPage: true });
  console.log('📸', await subirArchivoR2(buf, `debug/orler_menu_${Date.now()}.png`, 'image/png'));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
