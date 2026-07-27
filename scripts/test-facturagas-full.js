require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1000 });
  page.on('dialog', async d => { console.log('🔔 Dialog:', d.message()); await d.accept().catch(() => {}); });

  let genResp = null;
  page.on('response', async (resp) => {
    if (/generar_factura\.aspx\/(generarFactura|GenerarFactura|guardarFactura)/i.test(resp.url())) {
      genResp = { url: resp.url(), status: resp.status(), body: await resp.text().catch(() => null) };
    }
  });

  await page.goto('https://app.facturagas.net/generar_factura.aspx', { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('#rstation_Input', { timeout: 15000 });
  await page.click('#rstation_Input');
  await page.keyboard.type('Suministros Energeticos', { delay: 25 });
  await page.waitForTimeout(1800);
  await page.evaluate(() => { const items = Array.from(document.querySelectorAll('li, .dx-item, [role="option"]')); const el = items.find(i => /SUMINISTROS ENERGETICOS/i.test(i.textContent || '') && i.offsetParent !== null); if (el) el.click(); });
  await page.waitForTimeout(1000);
  await page.click('#despacho'); await page.keyboard.type('2025730', { delay: 20 });
  await page.click('#webId'); await page.keyboard.type('60844255', { delay: 20 });
  await page.click('#btnSerchTk');
  await page.waitForTimeout(3000);

  console.log('➡️ RFC + Agregar...');
  await page.click('#inputRfc2');
  await page.keyboard.type('GPR110128QD8', { delay: 25 });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button, a, input[type=button]')).find(x => /^agregar$/i.test((x.textContent || x.value || '').trim()));
    if (b) b.click();
  });
  await page.waitForTimeout(2000);

  const buf1 = await page.screenshot({ fullPage: true });
  console.log('📸 tras agregar rfc:', await subirArchivoR2(buf1, `debug/facturagas_tras_agregar_rfc_${Date.now()}.png`, 'image/png'));

  console.log('➡️ Llenando datos fiscales (ahora activos)...');
  await page.click('#inputRazon'); await page.keyboard.type('GPN PINTURAS Y RECUBRIMIENTOS', { delay: 12 });
  await page.click('#inputCorreo'); await page.keyboard.type('buzonfacturas@serviciosga.site', { delay: 12 });
  await page.click('#inputCp'); await page.keyboard.type('80140', { delay: 15 });

  const regimenOk = await page.evaluate(() => {
    const sel = document.getElementById('cmbRegimen');
    const opt = Array.from(sel.options).find(o => /^601\b/.test(o.text));
    if (!opt) return false;
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  });
  console.log('Régimen seleccionado:', regimenOk);
  await page.waitForTimeout(800);

  const usoOpciones = await page.evaluate(() => Array.from(document.getElementById('cmbUsos').options).map(o => o.text));
  console.log('Opciones Uso CFDI:', JSON.stringify(usoOpciones));
  const usoOk = await page.evaluate(() => {
    const sel = document.getElementById('cmbUsos');
    const opt = Array.from(sel.options).find(o => /gastos en general/i.test(o.text));
    if (!opt) return false;
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  });
  console.log('Uso CFDI seleccionado:', usoOk);
  await page.waitForTimeout(500);

  const buf2 = await page.screenshot({ fullPage: true });
  console.log('📸 form listo:', await subirArchivoR2(buf2, `debug/facturagas_form_listo_${Date.now()}.png`, 'image/png'));

  console.log('\n➡️ Click Generar Factura (EMISIÓN REAL)...');
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button, a')).find(x => /^generar factura$/i.test((x.textContent || '').trim()));
    if (b) b.click();
  });
  await page.waitForTimeout(5000);

  const textoFinal = await page.evaluate(() => document.body.innerText.slice(0, 1500));
  console.log('\nTexto final:\n', textoFinal);
  console.log('\nRespuesta generar:', JSON.stringify(genResp));

  const buf3 = await page.screenshot({ fullPage: true });
  console.log('📸 final:', await subirArchivoR2(buf3, `debug/facturagas_final_${Date.now()}.png`, 'image/png'));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
