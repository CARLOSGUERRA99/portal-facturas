require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('dialog', async d => { console.log('🔔 Dialog:', d.message()); await d.accept().catch(() => {}); });

  await page.goto('http://ramcal.no-ip.net:8082/bajatufactura/', { waitUntil: 'networkidle2', timeout: 25000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('input,button')).find(x => /generaci[oó]n de factura$/i.test((x.value || x.textContent || '').trim()));
    if (b) b.click();
  });
  await page.waitForTimeout(1200);
  await page.click('#rfc');
  await page.keyboard.type('GPR110128QD8', { delay: 30 });
  await page.waitForTimeout(300);
  await page.click('input[name="btn_submit_codigo"]');
  await page.waitForTimeout(2000);
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('input,button,a')).find(x => /seleccionar/i.test((x.value || x.textContent || '').trim()));
    if (b) b.click();
  });
  await page.waitForTimeout(2000);

  // Ver el hint "Encuentra el código" antes de escribir, por si aclara qué dato usar
  const hintInfo = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('*')).find(x => x.children.length === 0 && /encuentra el c[oó]digo/i.test(x.textContent || ''));
    return el ? { text: el.textContent.trim(), href: el.tagName === 'A' ? el.href : (el.closest('a') ? el.closest('a').href : null), onclick: el.getAttribute('onclick') || (el.closest('a') ? el.closest('a').getAttribute('onclick') : null) } : null;
  });
  console.log('Hint "Encuentra el código":', JSON.stringify(hintInfo, null, 2));

  console.log('➡️ Escribiendo código 01292742361...');
  const codigoInput = await page.$('input[name="codigo[]"]');
  await codigoInput.click();
  await page.keyboard.type('01292742361', { delay: 30 });
  await page.waitForTimeout(300);
  await page.click('input[name="btn_submit_nf"]');
  await page.waitForTimeout(2500);

  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 2000));
  console.log('BODY tras código:\n', bodyText);

  const buf = await page.screenshot({ fullPage: true });
  console.log('📸', await subirArchivoR2(buf, `debug/ramcal_codigo_result_${Date.now()}.png`, 'image/png'));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
