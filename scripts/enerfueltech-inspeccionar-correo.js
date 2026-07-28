require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

const REFERENCIA = '049847152458CE1';

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('dialog', async d => { await d.accept().catch(() => {}); });

  await page.goto('https://factura.enerfueltech.com/', { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForTimeout(2500);
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button, a')).find(x => /facturar sin registro/i.test(x.textContent || ''));
    if (b) b.click();
  });
  await page.waitForTimeout(2000);

  const inputsVisibles = await page.$$('input[type="text"]');
  const refField = inputsVisibles[inputsVisibles.length - 1];
  await refField.click({ clickCount: 3 });
  await page.keyboard.type(REFERENCIA, { delay: 40 });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim() === 'Buscar');
    if (b) b.click();
  });
  await page.waitForTimeout(2500);

  const allInputs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('input')).map((el, i) => {
      const r = el.getBoundingClientRect();
      return { idx: i, type: el.type, visible: r.width > 0 && r.height > 0, top: Math.round(r.top), left: Math.round(r.left), placeholder: el.placeholder };
    });
  });
  console.log('=== TODOS los <input> tras Buscar (ya facturado) ===');
  console.log(JSON.stringify(allInputs, null, 2));

  const allButtons = await page.evaluate(() => Array.from(document.querySelectorAll('button')).map(b => b.textContent.trim()).filter(Boolean));
  console.log('\n=== BOTONES ===', JSON.stringify(allButtons));

  const buf = await page.screenshot({ fullPage: true });
  console.log('📸', await subirArchivoR2(buf, `debug/enerfueltech_inspeccion_${Date.now()}.png`, 'image/png'));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
