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

  const netLog = [];
  page.on('response', async (resp) => {
    const url = resp.url();
    if (!/ModificarDatosFiscales|Facturacion\/Nueva/i.test(url)) return;
    let body = null;
    try { body = (await resp.text()).slice(0, 800); } catch {}
    netLog.push({ status: resp.status(), url, method: resp.request().method(), body });
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

  // Inspeccionar el <form> completo de Datos Fiscales: atributos data-ajax, todos los inputs/valores
  const formDetail = await page.evaluate(() => {
    const f = document.getElementById('submitModificarDatosFiscales');
    if (!f) return null;
    return {
      action: f.action, method: f.method,
      dataset: Object.assign({}, f.dataset),
      inputs: Array.from(f.querySelectorAll('input,select')).map(el => ({
        tag: el.tagName, id: el.id, name: el.name, type: el.type, value: el.value, required: el.required,
      })),
    };
  });
  console.log('=== FORM submitModificarDatosFiscales (antes de seleccionar) ===');
  console.log(JSON.stringify(formDetail, null, 2));

  // Seleccionar usando la interacción REAL de Puppeteer (select) en vez de JS puro
  const selectHandle = await page.$('#ClaveFormaPago');
  if (selectHandle) {
    await page.select('#ClaveFormaPago', '28');
  }
  await page.waitForTimeout(300);

  const valorTrasSelect = await page.$eval('#ClaveFormaPago', el => el.value);
  console.log('Valor de ClaveFormaPago tras page.select():', valorTrasSelect);

  console.log('➡️ Click submit real (elementHandle.click)...');
  const submitBtn = await page.evaluateHandle(() => {
    const f = document.getElementById('submitModificarDatosFiscales');
    return f ? f.querySelector('button[type=submit]') : null;
  });
  const submitEl = submitBtn.asElement();
  if (submitEl) {
    await submitEl.click();
  }
  await page.waitForTimeout(3000);

  console.log('\n=== NETWORK LOG (ModificarDatosFiscales / Nueva) ===');
  console.log(JSON.stringify(netLog, null, 2));

  const bodyTras = await page.evaluate(() => document.body.innerText.slice(0, 800));
  console.log('\nBODY tras submit real:\n', bodyTras);

  const buf = await page.screenshot({ fullPage: true });
  console.log('📸', await subirArchivoR2(buf, `debug/igasfac_diag_${Date.now()}.png`, 'image/png'));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
