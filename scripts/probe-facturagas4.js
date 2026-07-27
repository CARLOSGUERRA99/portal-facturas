require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1000 });
  page.on('dialog', async d => { console.log('🔔 Dialog:', d.message()); await d.accept().catch(() => {}); });

  const apiCalls = [];
  page.on('response', async (resp) => {
    const url = resp.url();
    if (!/facturagas\.net/i.test(url) || /\.(js|css|png|jpg|svg|woff|ico|gif|ttf|axd)(\?|$)/i.test(url)) return;
    let body = null;
    try { body = (await resp.text()).slice(0, 700); } catch {}
    apiCalls.push({ status: resp.status(), url, body });
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

  console.log('➡️ RFC...');
  await page.click('#inputRfc2');
  await page.keyboard.type('GPR110128QD8', { delay: 25 });
  await page.waitForTimeout(2000);

  const valores1 = await page.evaluate(() => {
    const ids = ['inputRazon', 'inputCorreo', 'inputCp'];
    const out = {};
    for (const id of ids) { const el = document.getElementById(id); out[id] = el ? el.value : '?'; }
    return out;
  });
  console.log('Valores tras RFC:', JSON.stringify(valores1));

  console.log('➡️ Llenando manualmente (sin autofill)...');
  await page.click('#inputRazon'); await page.keyboard.type('GPN PINTURAS Y RECUBRIMIENTOS', { delay: 12 });
  await page.click('#inputCorreo'); await page.keyboard.type('buzonfacturas@serviciosga.site', { delay: 12 });
  await page.click('#inputCp'); await page.keyboard.type('80140', { delay: 15 });

  const regimenOk = await page.evaluate(() => {
    const sel = document.getElementById('cmbRegimen');
    const opt = Array.from(sel.options).find(o => /^601\b/.test(o.text) || /general de ley personas morales/i.test(o.text));
    if (!opt) return false;
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  });
  console.log('Régimen seleccionado:', regimenOk);
  await page.waitForTimeout(500);

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

  const buf1 = await page.screenshot({ fullPage: true });
  console.log('📸 form completo:', await subirArchivoR2(buf1, `debug/facturagas_form_completo_${Date.now()}.png`, 'image/png'));

  console.log('\n➡️ Click Agregar...');
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button, a, input[type=button]')).find(x => /^agregar$/i.test((x.textContent || x.value || '').trim()));
    if (b) b.click();
  });
  await page.waitForTimeout(2000);
  const buf1b = await page.screenshot({ fullPage: true });
  console.log('📸 tras agregar:', await subirArchivoR2(buf1b, `debug/facturagas_tras_agregar_${Date.now()}.png`, 'image/png'));
  const bodyTextAgregar = await page.evaluate(() => document.body.innerText.slice(0, 1200));
  console.log('Texto tras Agregar:\n', bodyTextAgregar);

  console.log('\n=== API CALLS ===');
  console.log(JSON.stringify(apiCalls, null, 2));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
