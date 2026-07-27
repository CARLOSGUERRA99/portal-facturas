require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

async function valores(page) {
  return page.evaluate(() => {
    const ids = ['rfc','DomicilioFiscalReceptor','nombre','RegimenFiscalReceptor','selectUsoCfdi','email','idw_tmp_01','idw_tmp_02','idw_tmp_03','idw_tmp_04','idw_tmp_05'];
    const out = {};
    for (const id of ids) {
      const el = document.getElementById(id);
      out[id] = el ? el.value : '(no existe)';
    }
    return out;
  });
}

async function dump(page, label) {
  const buf = await page.screenshot({ fullPage: true }).catch(() => null);
  if (buf) {
    const u = await subirArchivoR2(buf, `debug/erfc_probe_${label}_${Date.now()}.png`, 'image/png');
    console.log(`📸 [${label}]: ${u}`);
  }
  console.log(`\n=== ${label} — valores ===`);
  console.log(JSON.stringify(await valores(page), null, 2));
}

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1000 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

  const apiCalls = [];
  page.on('response', async (resp) => {
    const url = resp.url();
    if (!/erfc\.com\.mx\/(controllers|secure)/i.test(url)) return;
    let body = null;
    try { body = (await resp.text()).slice(0, 800); } catch {}
    apiCalls.push({ status: resp.status(), url, method: resp.request().method(), body });
  });
  page.on('requestfinished', async (req) => {
    if (/revisaIDW|form_peticiones|enviarPeticion/i.test(req.url()) && req.method() === 'POST') {
      console.log('📤 POST DATA:', req.postData());
    }
  });

  await page.goto('https://www.erfc.com.mx', { waitUntil: 'load', timeout: 30000 });
  await page.click('#correo'); await page.keyboard.type('buzonfacturas@serviciosga.site', { delay: 15 });
  await page.click('#rfc'); await page.keyboard.type('GPR110128QD8', { delay: 15 });
  await page.click('#link_terminos_condiciones');
  await page.waitForTimeout(500);
  await page.click('#accept_terminos_condiciones');
  await page.click('#btn-access');
  await page.waitForTimeout(2500);
  await dump(page, 'p1_facturacion_inicial');

  console.log('\n➡️ Llenando RFC en la página de facturación...');
  await page.click('#rfc'); await page.keyboard.type('GPR110128QD8', { delay: 15 });
  await page.click('#DomicilioFiscalReceptor'); await page.keyboard.type('80140', { delay: 15 });
  await page.waitForTimeout(1000);
  await dump(page, 'p2_post_rfc_cp');

  const nombreVal = await page.$eval('#nombre', el => el.value).catch(()=>null);
  if (!nombreVal) {
    await page.click('#nombre'); await page.keyboard.type('GPN PINTURAS Y RECUBRIMIENTOS', { delay: 10 });
  }

  const regimenSelected = await page.$eval('#RegimenFiscalReceptor', el => el.value).catch(()=>null);
  console.log('Régimen ya seleccionado:', regimenSelected);
  if (!regimenSelected) {
    const opciones = await page.$$eval('#RegimenFiscalReceptor option', opts => opts.map(o => ({ value: o.value, text: o.text })));
    console.log('Opciones régimen:', JSON.stringify(opciones));
    const opt601 = opciones.find(o => o.value.includes('601') || o.text.includes('601'));
    if (opt601) await page.select('#RegimenFiscalReceptor', opt601.value);
  }

  await page.click('#email'); await page.keyboard.type('buzonfacturas@serviciosga.site', { delay: 10 });
  await dump(page, 'p3_fiscales_completos');

  console.log('\n➡️ Llenando código IDW...');
  await page.click('#idw_tmp_01'); await page.keyboard.type('OOO', { delay: 20 });
  await page.click('#idw_tmp_02'); await page.keyboard.type('CF4o', { delay: 20 });
  await page.click('#idw_tmp_03'); await page.keyboard.type('11LX', { delay: 20 });
  await page.click('#idw_tmp_04'); await page.keyboard.type('SAEO', { delay: 20 });
  await page.click('#idw_tmp_05'); await page.keyboard.type('3R1A', { delay: 20 });
  await dump(page, 'p4_idw_lleno');

  console.log('\n➡️ Click "+" (btn_idw)...');
  await page.click('#btn_idw');
  await page.waitForTimeout(2500);
  await dump(page, 'p5_post_agregar');

  console.log('\n=== API CALLS ===');
  console.log(JSON.stringify(apiCalls, null, 2));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
