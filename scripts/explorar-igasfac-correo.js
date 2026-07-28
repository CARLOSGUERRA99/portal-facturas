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

  await page.goto('https://www.igasfac.com.mx/Identity/Account/Login?ReturnUrl=%2F', { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('#Input_Email', { timeout: 15000 });
  await page.click('#Input_Email'); await page.keyboard.type(user, { delay: 20 });
  await page.click('#Input_Password'); await page.keyboard.type(pass, { delay: 20 });
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(x => /iniciar sesi[oó]n/i.test(x.textContent || ''));
    if (b) b.click();
  });
  await page.waitForTimeout(3000);

  // Explorar todos los links/menú disponibles tras login (dashboard principal)
  const enlaces = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('a')).map(a => ({
      text: a.textContent.trim(),
      href: a.getAttribute('href'),
    })).filter(a => a.text || a.href);
  });
  console.log('=== ENLACES en dashboard tras login ===');
  console.log(JSON.stringify(enlaces, null, 2));

  const buf1 = await page.screenshot({ fullPage: true });
  console.log('📸 dashboard:', await subirArchivoR2(buf1, `debug/igasfac_dashboard_${Date.now()}.png`, 'image/png'));

  // Ir a "Consulta de facturas" a ver si ahí hay opción de correo
  await page.goto('https://www.igasfac.com.mx/', { waitUntil: 'load', timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const bodyDash = await page.evaluate(() => document.body.innerText.slice(0, 1500));
  console.log('\n=== BODY dashboard/home ===\n', bodyDash);

  const buf2 = await page.screenshot({ fullPage: true });
  console.log('📸 home:', await subirArchivoR2(buf2, `debug/igasfac_home_${Date.now()}.png`, 'image/png'));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
