require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

async function shot(page, label) {
  const buf = await page.screenshot({ fullPage: true }).catch(() => null);
  if (buf) console.log(`📸 [${label}]:`, await subirArchivoR2(buf, `debug/redpetroil4_${label}_${Date.now()}.png`, 'image/png'));
  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 900)).catch(e => 'ERR:' + e.message);
  console.log(`[${label}] body:`, bodyText);
}

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('dialog', async d => { console.log('🔔 Dialog:', d.message()); await d.accept().catch(() => {}); });

  await page.goto('https://es11469.migasolinera.net/bajatufactura/', { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('#btn_facturar', { timeout: 10000 });
  await shot(page, 'a_inicio');

  await page.click('#btn_facturar');
  await page.waitForSelector('#rfc', { timeout: 10000 });
  await shot(page, 'b_rfc_form');

  await page.click('#rfc'); await page.keyboard.type('GPR110128QD8', { delay: 15 });
  await page.evaluate(() => document.querySelector('input[name="btn_submit_codigo"]').click());
  await page.waitForFunction(() => /CLIENTES ENCONTRADOS/i.test(document.body.innerText), { timeout: 10000 });
  await shot(page, 'c_clientes');

  await page.waitForTimeout(1000);
  const selHandle = await page.evaluateHandle(() => Array.from(document.querySelectorAll('a')).find(x => /seleccionar/i.test(x.textContent || '')));
  const selEl = selHandle.asElement();
  console.log('Seleccionar encontrado:', !!selEl);
  if (selEl) await selEl.click();
  await page.waitForFunction(() => /Introduzca el n[uú]mero de codigo/i.test(document.body.innerText), { timeout: 15000 }).catch(async (e) => {
    console.log('⚠️ timeout esperando pantalla de código:', e.message);
  });
  await shot(page, 'd_codigo_form');

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
