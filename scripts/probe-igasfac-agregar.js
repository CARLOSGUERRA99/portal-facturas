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
  page.on('dialog', async d => { console.log('🔔 Dialog:', d.message()); await d.accept().catch(() => {}); });

  const apiCalls = [];
  page.on('response', async (resp) => {
    const url = resp.url();
    if (!/igasfac\.com\.mx/i.test(url) || /\.(js|css|png|jpg|svg|woff|ico)(\?|$)/i.test(url)) return;
    let body = null;
    try { body = (await resp.text()).slice(0, 500); } catch {}
    apiCalls.push({ status: resp.status(), url, body });
  });

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

  console.log('➡️ Click "Agregar" (abrir modal de ticket)...');
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim() === 'Agregar');
    if (b) b.click();
  });
  await page.waitForTimeout(1200);

  await page.waitForSelector('#Input_Folio', { visible: true, timeout: 10000 });
  await page.click('#Input_Folio');
  await page.keyboard.type('0637-00475232-00093301', { delay: 25 });

  const buf1 = await page.screenshot({ fullPage: true });
  console.log('📸 modal:', await subirArchivoR2(buf1, `debug/igasfac_modal_${Date.now()}.png`, 'image/png'));

  console.log('➡️ Click Agregar (dentro del modal)...');
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const modalBtn = btns.reverse().find(x => x.textContent.trim() === 'Agregar');
    if (modalBtn) modalBtn.click();
  });
  await page.waitForTimeout(2500);

  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 1200));
  console.log('BODY tras agregar ticket:\n', bodyText);
  const buf2 = await page.screenshot({ fullPage: true });
  console.log('📸 resultado:', await subirArchivoR2(buf2, `debug/igasfac_resultado_${Date.now()}.png`, 'image/png'));

  console.log('\n=== API CALLS ===');
  console.log(JSON.stringify(apiCalls, null, 2));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
