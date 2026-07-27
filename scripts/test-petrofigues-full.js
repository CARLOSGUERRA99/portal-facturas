require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  page.on('dialog', async d => { console.log('🔔 Dialog:', d.message()); await d.accept().catch(() => {}); });

  let facturarResp = null;
  page.on('response', async (resp) => {
    if (/Home\/(Invoice|Facturar|CreateInvoice|GenerateInvoice)/i.test(resp.url())) {
      facturarResp = { url: resp.url(), status: resp.status(), body: await resp.text().catch(() => null) };
    }
  });

  await page.goto('https://petrofigues.facturacionestacion.com/', { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('#txtReferencia', { timeout: 15000 });
  await page.click('#txtReferencia'); await page.keyboard.type('13697', { delay: 15 });
  await page.click('#txtFolio'); await page.keyboard.type('1067336', { delay: 15 });
  await page.click('#txtAmount'); await page.keyboard.type('1000.00', { delay: 15 });
  await page.click('#txtRFC'); await page.keyboard.type('GPR110128QD8', { delay: 15 });
  await page.click('#btnNext');
  await page.waitForTimeout(3000);

  const selects = await page.$$eval('select', els => els.map(e => ({ id: e.id, name: e.name, options: Array.from(e.options).map(o => o.text) })));
  console.log('SELECTS:', JSON.stringify(selects, null, 2));

  // Uso CFDI: buscar el select cuyo texto de opciones mencione "Gastos en general"
  const usoSelectId = await page.evaluate(() => {
    const sels = Array.from(document.querySelectorAll('select'));
    const target = sels.find(s => Array.from(s.options).some(o => /gastos en general/i.test(o.text)));
    return target ? target.id : null;
  });
  console.log('Select Uso CFDI id:', usoSelectId);
  const usoValorFinal = await page.evaluate((id) => {
    const el = document.getElementById(id);
    const opt = Array.from(el.options).find(o => /gastos en general/i.test(o.text));
    if (!opt) return null;
    el.value = opt.value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value;
  }, usoSelectId);
  console.log('Uso CFDI seleccionado (valor final):', usoValorFinal);
  await page.waitForTimeout(500);

  const buf1 = await page.screenshot({ fullPage: true });
  console.log('📸 antes facturar:', await subirArchivoR2(buf1, `debug/petrofigues_antes_facturar_${Date.now()}.png`, 'image/png'));

  console.log('\n➡️ Click Facturar (EMISIÓN REAL)...');
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(x => /^facturar$/i.test((x.textContent || '').trim()));
    if (b) b.click();
  });
  await page.waitForTimeout(5000);

  const textoFinal = await page.evaluate(() => document.body.innerText.slice(0, 1200));
  console.log('\nTexto final:\n', textoFinal);
  console.log('\nRespuesta facturar:', JSON.stringify(facturarResp));

  const buf2 = await page.screenshot({ fullPage: true });
  console.log('📸 final:', await subirArchivoR2(buf2, `debug/petrofigues_final_${Date.now()}.png`, 'image/png'));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
