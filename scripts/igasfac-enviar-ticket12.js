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

  // Modal "Datos Fiscales" se abre automáticamente. Seleccionar Forma de Pago = 28 (Tarjeta Débito)
  await page.evaluate(() => {
    const sel = document.getElementById('ClaveFormaPago');
    if (sel) { sel.value = '28'; sel.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await page.waitForTimeout(300);

  console.log('➡️ Confirmando Datos Fiscales (Forma de Pago = Tarjeta de Débito)...');
  await page.evaluate(() => {
    const forms = Array.from(document.querySelectorAll('form'));
    const f = forms.find(x => x.id === 'submitModificarDatosFiscales');
    if (f) {
      const btn = f.querySelector('button[type=submit]');
      if (btn) btn.click();
    }
  });
  await page.waitForTimeout(2500);

  const bodyTras1 = await page.evaluate(() => document.body.innerText.slice(0, 1000));
  console.log('BODY tras confirmar Datos Fiscales:\n', bodyTras1);

  const buf1 = await page.screenshot({ fullPage: true });
  console.log('📸 tras datos fiscales:', await subirArchivoR2(buf1, `debug/igasfac_tras_datosfiscales_${Date.now()}.png`, 'image/png'));

  // Ahora buscar y click "Enviar solicitud"
  console.log('➡️ Click Enviar solicitud...');
  const clickEnviar = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button, a')).find(x => /enviar solicitud/i.test(x.textContent || ''));
    if (b) { b.click(); return true; }
    return false;
  });
  console.log('Botón "Enviar solicitud" encontrado y clickeado:', clickEnviar);
  await page.waitForTimeout(3500);

  const bodyFinal = await page.evaluate(() => document.body.innerText.slice(0, 1500));
  console.log('\nBODY FINAL:\n', bodyFinal);

  const buf2 = await page.screenshot({ fullPage: true });
  console.log('📸 resultado final:', await subirArchivoR2(buf2, `debug/igasfac_resultado_final_${Date.now()}.png`, 'image/png'));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
