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

  // ¿Ya persiste el ticket agregado antes (0637-00475232-00093301)? Revisar tabla
  const tablaTexto = await page.evaluate(() => document.body.innerText);
  console.log('=== ¿Ticket ya presente? ===');
  console.log(tablaTexto.includes('0637-00475232-00093301') ? 'SÍ, ya está en la tabla' : 'NO, hay que re-agregarlo');

  // Inspeccionar todos los <select> visibles en la página (fuera del modal)
  const selects = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('select')).map(s => ({
      id: s.id,
      name: s.name,
      value: s.value,
      selectedText: s.options[s.selectedIndex] ? s.options[s.selectedIndex].text : null,
      options: Array.from(s.options).map(o => ({ value: o.value, text: o.text })),
      visible: !!(s.offsetWidth || s.offsetHeight || s.getClientRects().length),
    }));
  });
  console.log('\n=== SELECTS en la página ===');
  console.log(JSON.stringify(selects, null, 2));

  const buf = await page.screenshot({ fullPage: true });
  console.log('📸', await subirArchivoR2(buf, `debug/igasfac_formapago_${Date.now()}.png`, 'image/png'));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
