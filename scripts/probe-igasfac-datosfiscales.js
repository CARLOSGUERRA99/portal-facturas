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

  // Ahora inspeccionar TODOS los elementos de formulario (select, input, radio) relacionados a "forma de pago"
  const formInfo = await page.evaluate(() => {
    const selects = Array.from(document.querySelectorAll('select')).map(s => ({
      tag: 'select', id: s.id, name: s.name, value: s.value,
      selectedText: s.options[s.selectedIndex] ? s.options[s.selectedIndex].text : null,
      options: Array.from(s.options).map(o => ({ value: o.value, text: o.text })),
    }));
    // buscar cualquier elemento cuyo texto cercano diga "forma de pago"
    const labelMatches = Array.from(document.querySelectorAll('label, span, div')).filter(el =>
      /forma de pago/i.test(el.textContent || '') && el.children.length < 3
    ).map(el => ({ tag: el.tagName, text: el.textContent.trim().slice(0, 80), id: el.id, outerHTML: el.outerHTML.slice(0, 300) }));
    return { selects, labelMatches };
  });
  console.log('=== FORM INFO (tras Agregar Ticket) ===');
  console.log(JSON.stringify(formInfo, null, 2));

  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 2500));
  console.log('\n=== BODY TEXT ===\n', bodyText);

  const buf = await page.screenshot({ fullPage: true });
  console.log('📸', await subirArchivoR2(buf, `debug/igasfac_datosfiscales_${Date.now()}.png`, 'image/png'));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
