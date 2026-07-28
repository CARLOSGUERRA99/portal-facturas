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

  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim() === 'Agregar');
    if (b) b.click();
  });
  await page.waitForTimeout(1200);
  await page.waitForSelector('#Input_Folio', { visible: true, timeout: 10000 });
  const h = await page.$('#Input_Folio');
  await h.click({ clickCount: 3 });
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

  // SIEMPRE seleccionar y confirmar Forma de Pago para esta solicitud (se resetea en cada solicitud nueva)
  console.log('➡️ Seleccionando y confirmando Forma de Pago (Tarjeta de Débito) para esta solicitud...');
  await page.select('#ClaveFormaPago', '28');
  await page.waitForTimeout(300);
  const navPromise = page.waitForNavigation({ waitUntil: 'load', timeout: 10000 }).then(() => 'nav-ok').catch((e) => 'nav-timeout:' + e.message);
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.form && b.form.id === 'submitModificarDatosFiscales');
    if (btn) btn.click();
  });
  console.log('Datos Fiscales:', await navPromise);
  await page.waitForTimeout(1500);

  let bodyChk = await page.evaluate(() => document.body.innerText.slice(0, 900));
  const guardado = !bodyChk.includes('Seleccione forma de pago') && bodyChk.includes('0637-00475232-00093301');
  console.log('Forma de pago confirmada Y ticket presente:', guardado);
  console.log(bodyChk);

  if (!guardado) {
    console.log('❌ No se pudo confirmar forma de pago / ticket antes de enviar. Abortando sin dar clic en Enviar solicitud.');
    const bufAbort = await page.screenshot({ fullPage: true });
    console.log('📸 abort:', await subirArchivoR2(bufAbort, `debug/igasfac_finalabort_${Date.now()}.png`, 'image/png'));
    await browser.close();
    process.exit(2);
  }

  console.log('\n➡️ Click Enviar solicitud...');
  const navPromise2 = page.waitForNavigation({ waitUntil: 'load', timeout: 15000 }).then(() => 'nav-ok').catch((e) => 'nav-timeout:' + e.message);
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button, a')).find(x => /enviar solicitud/i.test(x.textContent || ''));
    if (b) b.click();
  });
  console.log('Resultado navegación:', await navPromise2);
  await page.waitForTimeout(2500);

  const bodyFinal = await page.evaluate(() => document.body.innerText.slice(0, 1800));
  console.log('\nBODY FINAL:\n', bodyFinal);

  const buf = await page.screenshot({ fullPage: true });
  console.log('📸 resultado final:', await subirArchivoR2(buf, `debug/igasfac_final_${Date.now()}.png`, 'image/png'));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
