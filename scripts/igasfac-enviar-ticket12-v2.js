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

  // Forma de Pago = 28 (Tarjeta de Débito, confirmado por el usuario)
  await page.select('#ClaveFormaPago', '28');
  await page.waitForTimeout(300);

  console.log('➡️ Confirmando Datos Fiscales (botón asociado vía atributo form=, no es descendiente del <form>)...');
  try {
    const navPromise = page.waitForNavigation({ waitUntil: 'load', timeout: 10000 });
    const clicked = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.form && b.form.id === 'submitModificarDatosFiscales');
      if (btn) { btn.click(); return true; }
      return false;
    });
    console.log('¿Botón encontrado vía b.form.id y clickeado?:', clicked);
    await navPromise;
    console.log('✅ Navegación tras confirmar Datos Fiscales');
  } catch (e) {
    console.log('⚠️ waitForNavigation:', e.message);
  }
  await page.waitForTimeout(1500);

  const bodyTrasDF = await page.evaluate(() => document.body.innerText.slice(0, 700));
  console.log('BODY tras Datos Fiscales:\n', bodyTrasDF);
  const yaGuardado = !bodyTrasDF.includes('Seleccione forma de pago');
  console.log('¿Forma de pago ya NO muestra placeholder? (guardado OK):', yaGuardado);

  if (!yaGuardado) {
    console.log('❌ El perfil sigue sin forma de pago guardada. Abortando antes de Enviar solicitud.');
    const bufAbort = await page.screenshot({ fullPage: true });
    console.log('📸 abort:', await subirArchivoR2(bufAbort, `debug/igasfac_v2_abort_${Date.now()}.png`, 'image/png'));
    await browser.close();
    process.exit(2);
  }

  // Puede que el ticket ya no esté en la tabla tras el reload — verificar y re-agregar si hace falta
  const tieneTicket = await page.evaluate(() => document.body.innerText.includes('0637-00475232-00093301'));
  console.log('¿Ticket sigue en la tabla tras guardar Datos Fiscales?:', tieneTicket);

  if (!tieneTicket) {
    console.log('➡️ Re-agregando el ticket (se perdió tras el reload)...');
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim() === 'Agregar');
      if (b) b.click();
    });
    await page.waitForTimeout(1200);
    await page.waitForSelector('#Input_Folio', { visible: true, timeout: 10000 });
    const h2 = await page.$('#Input_Folio');
    await h2.click({ clickCount: 3 });
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
    await page.waitForTimeout(2000);
  }

  console.log('➡️ Click Enviar solicitud...');
  const clickEnviar = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button, a')).find(x => /enviar solicitud/i.test(x.textContent || ''));
    if (b) { b.click(); return true; }
    return false;
  });
  console.log('Botón "Enviar solicitud" clickeado:', clickEnviar);
  await page.waitForTimeout(4000);

  const bodyFinal = await page.evaluate(() => document.body.innerText.slice(0, 1500));
  console.log('\nBODY FINAL:\n', bodyFinal);

  const buf2 = await page.screenshot({ fullPage: true });
  console.log('📸 resultado final v2:', await subirArchivoR2(buf2, `debug/igasfac_v2_final_${Date.now()}.png`, 'image/png'));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
