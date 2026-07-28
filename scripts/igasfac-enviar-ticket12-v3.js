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

  const netLog = [];
  page.on('response', async (resp) => {
    const url = resp.url();
    if (!/Facturacion/i.test(url)) return;
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

  // ¿El ticket ya persiste de la corrida anterior (perfil ya tiene forma de pago)?
  let bodyNow = await page.evaluate(() => document.body.innerText.slice(0, 900));
  console.log('BODY al entrar a Nueva Factura:\n', bodyNow);

  const yaTieneTicket = bodyNow.includes('0637-00475232-00093301');
  const yaTieneFormaPago = !bodyNow.includes('Seleccione forma de pago');
  console.log('Ticket ya presente:', yaTieneTicket, '| Forma de pago ya guardada:', yaTieneFormaPago);

  if (!yaTieneTicket) {
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

    if (!yaTieneFormaPago) {
      await page.select('#ClaveFormaPago', '28');
      await page.waitForTimeout(300);
      const navPromise = page.waitForNavigation({ waitUntil: 'load', timeout: 10000 }).catch(() => {});
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => b.form && b.form.id === 'submitModificarDatosFiscales');
        if (btn) btn.click();
      });
      await navPromise;
      await page.waitForTimeout(1500);
    }
  }

  bodyNow = await page.evaluate(() => document.body.innerText.slice(0, 900));
  console.log('\nBODY justo antes de Enviar solicitud:\n', bodyNow);

  console.log('\n➡️ Click Enviar solicitud (con navegación esperada)...');
  const navPromise2 = page.waitForNavigation({ waitUntil: 'load', timeout: 15000 }).then(() => 'nav-ok').catch((e) => 'nav-timeout:' + e.message);
  const clickedEnviar = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button, a')).find(x => /enviar solicitud/i.test(x.textContent || ''));
    if (b) { b.click(); return true; }
    return false;
  });
  console.log('Click realizado:', clickedEnviar);
  const navResult = await navPromise2;
  console.log('Resultado navegación:', navResult);
  await page.waitForTimeout(3000);

  const bodyFinal = await page.evaluate(() => document.body.innerText.slice(0, 2000));
  console.log('\nBODY FINAL (tras esperar):\n', bodyFinal);

  console.log('\n=== NETWORK LOG (Facturacion*) — últimos 15 ===');
  console.log(JSON.stringify(netLog.slice(-15), null, 2));

  const buf = await page.screenshot({ fullPage: true });
  console.log('📸', await subirArchivoR2(buf, `debug/igasfac_v3_final_${Date.now()}.png`, 'image/png'));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
