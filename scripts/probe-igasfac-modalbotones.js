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

  // Seleccionar Forma de Pago = 28 (Tarjeta de Débito)
  const seleccionOk = await page.evaluate(() => {
    const sel = document.getElementById('ClaveFormaPago');
    if (!sel) return false;
    sel.value = '28';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return sel.value === '28';
  });
  console.log('Forma de pago seleccionada (28):', seleccionOk);

  // Listar botones dentro del modal "Datos Fiscales"
  const modalButtons = await page.evaluate(() => {
    const modal = Array.from(document.querySelectorAll('.modal.show, .modal[style*="display: block"]'))[0];
    if (!modal) return { encontrado: false };
    const btns = Array.from(modal.querySelectorAll('button, input[type=submit]')).map(b => ({
      tag: b.tagName, type: b.type, text: (b.textContent || b.value || '').trim(), id: b.id, formId: b.form ? b.form.id : null,
    }));
    return { encontrado: true, btns, modalId: modal.querySelector('form') ? modal.querySelector('form').id : null };
  });
  console.log('Botones del modal Datos Fiscales:', JSON.stringify(modalButtons, null, 2));

  const buf = await page.screenshot({ fullPage: true });
  console.log('📸', await subirArchivoR2(buf, `debug/igasfac_modalbotones_${Date.now()}.png`, 'image/png'));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
