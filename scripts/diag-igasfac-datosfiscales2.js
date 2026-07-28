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
  page.on('console', m => console.log('CONSOLE:', m.text()));
  page.on('pageerror', e => console.log('PAGEERROR:', e.message));

  const netLog = [];
  page.on('response', async (resp) => {
    const url = resp.url();
    if (!/ModificarDatosFiscales|Facturacion\/Nueva/i.test(url)) return;
    netLog.push({ status: resp.status(), url, method: resp.request().method() });
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
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim() === 'Agregar');
    if (b) b.click();
  });
  await page.waitForTimeout(1200);
  await page.waitForSelector('#Input_Folio', { visible: true, timeout: 10000 });

  const handle = await page.$('#Input_Folio');
  await handle.click({ clickCount: 3 });
  await page.waitForTimeout(300);
  for (const d of '06370047523200093301') {
    await page.keyboard.press(d);
    await page.waitForTimeout(70);
  }
  await page.waitForTimeout(1500);

  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const modalBtn = btns.reverse().find(x => x.textContent.trim() === 'Agregar');
    if (modalBtn) modalBtn.click();
  });
  await page.waitForTimeout(2500);

  // Confirmar que el selector CSS del botón submit existe de verdad
  const existeBoton = await page.evaluate(() => !!document.querySelector('#submitModificarDatosFiscales button[type=submit]'));
  console.log('¿Existe #submitModificarDatosFiscales button[type=submit]?:', existeBoton);

  await page.select('#ClaveFormaPago', '28');
  const valorTrasSelect = await page.$eval('#ClaveFormaPago', el => el.value);
  console.log('Valor de ClaveFormaPago tras select:', valorTrasSelect);

  console.log('➡️ Click con page.click() + waitForNavigation en paralelo...');
  try {
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'load', timeout: 10000 }),
      page.click('#submitModificarDatosFiscales button[type=submit]'),
    ]);
    console.log('✅ Navegación completada tras submit');
  } catch (navErr) {
    console.log('⚠️ No hubo navegación tras el click (timeout o no ocurrió):', navErr.message);
  }
  await page.waitForTimeout(1500);

  console.log('\n=== NETWORK LOG ===');
  console.log(JSON.stringify(netLog, null, 2));

  const bodyTras = await page.evaluate(() => document.body.innerText.slice(0, 800));
  console.log('\nBODY final:\n', bodyTras);

  const buf = await page.screenshot({ fullPage: true });
  console.log('📸', await subirArchivoR2(buf, `debug/igasfac_diag2_${Date.now()}.png`, 'image/png'));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
