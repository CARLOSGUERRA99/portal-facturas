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

  const reqLog = [];
  page.on('request', (req) => {
    const url = req.url();
    if (!/Facturacion\/Nueva\?(handler|accion)=/i.test(url)) return;
    reqLog.push({ url, method: req.method(), postData: req.postData() || null });
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

  // Inspeccionar el valor EXACTO del CP en el input justo antes de confirmar
  const cpInput = await page.evaluate(() => {
    const el = document.getElementById('Input_CP');
    return el ? el.value : null;
  });
  console.log('Valor de Input_CP en el modal justo antes de confirmar:', JSON.stringify(cpInput));

  const razonSocialInput = await page.evaluate(() => {
    const el = document.getElementById('Input_RazonSocial');
    return el ? el.value : null;
  });
  console.log('Valor de Input_RazonSocial:', JSON.stringify(razonSocialInput));

  const regimenInput = await page.evaluate(() => {
    const sel = document.querySelector('select[name="Input.RegimenFiscal"]');
    return sel ? { value: sel.value, text: sel.options[sel.selectedIndex]?.text } : null;
  });
  console.log('Régimen Fiscal seleccionado:', JSON.stringify(regimenInput));

  await page.select('#ClaveFormaPago', '28');
  await page.waitForTimeout(300);
  const navPromise = page.waitForNavigation({ waitUntil: 'load', timeout: 10000 }).then(() => 'nav-ok').catch((e) => 'nav-timeout:' + e.message);
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.form && b.form.id === 'submitModificarDatosFiscales');
    if (btn) btn.click();
  });
  console.log('Datos Fiscales nav:', await navPromise);
  await page.waitForTimeout(1500);

  console.log('\n➡️ Click Enviar solicitud...');
  const navPromise2 = page.waitForNavigation({ waitUntil: 'load', timeout: 15000 }).then(() => 'nav-ok').catch((e) => 'nav-timeout:' + e.message);
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button, a')).find(x => /enviar solicitud/i.test(x.textContent || ''));
    if (b) b.click();
  });
  console.log('nav resultado:', await navPromise2);
  await page.waitForTimeout(2500);

  const bodyFinal = await page.evaluate(() => document.body.innerText.slice(0, 1200));
  console.log('\nBODY FINAL:\n', bodyFinal);

  console.log('\n=== REQUEST LOG (bodies POST) ===');
  reqLog.forEach(r => {
    console.log(`\n--- ${r.method} ${r.url}`);
    if (r.postData) console.log(r.postData);
  });

  const buf = await page.screenshot({ fullPage: true });
  console.log('\n📸', await subirArchivoR2(buf, `debug/igasfac_payload_${Date.now()}.png`, 'image/png'));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
