require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

async function dump(page, label) {
  const buf = await page.screenshot({ fullPage: true }).catch(() => null);
  if (buf) {
    const u = await subirArchivoR2(buf, `debug/erfc_probe_${label}_${Date.now()}.png`, 'image/png');
    console.log(`📸 [${label}]: ${u}`);
  }
  const bodyText = await page.evaluate(() => (document.body.innerText || '').slice(0, 1200));
  console.log(`\n=== ${label} ===\n${bodyText}`);
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
    if (!/erfc\.com\.mx/i.test(url) || /\.(js|css|png|jpg|svg|woff|ico)(\?|$)/i.test(url)) return;
    let body = null;
    try { body = (await resp.text()).slice(0, 500); } catch {}
    apiCalls.push({ status: resp.status(), url, method: resp.request().method(), body });
  });

  await page.goto('https://www.erfc.com.mx', { waitUntil: 'load', timeout: 30000 });
  await page.click('#correo'); await page.keyboard.type('buzonfacturas@serviciosga.site', { delay: 15 });
  await page.click('#rfc'); await page.keyboard.type('GPR110128QD8', { delay: 15 });
  await page.click('#link_terminos_condiciones');
  await page.waitForTimeout(500);
  await page.click('#accept_terminos_condiciones');
  await page.click('#btn-access');
  await page.waitForTimeout(2500);
  await dump(page, 'p1_facturacion');

  console.log('\n➡️ Llenando datos fiscales...');
  await page.click('#DomicilioFiscalReceptor'); await page.keyboard.type('80140', { delay: 15 });
  await page.waitForTimeout(500);
  await dump(page, 'p2_post_cp');

  await page.click('#nombre').catch(()=>{});
  const nombreVal = await page.$eval('#nombre', el => el.value).catch(()=>null);
  console.log('nombre autollenado:', nombreVal);
  if (!nombreVal) { await page.keyboard.type('GPN PINTURAS Y RECUBRIMIENTOS', { delay: 10 }); }

  await page.select('#RegimenFiscalReceptor', '601').catch(async e => {
    console.log('select régimen falló:', e.message);
  });

  await page.click('#email'); await page.keyboard.type('buzonfacturas@serviciosga.site', { delay: 10 });

  console.log('\n➡️ Llenando código IDW...');
  await page.click('#idw_tmp_01'); await page.keyboard.type('OOO', { delay: 20 });
  await page.click('#idw_tmp_02'); await page.keyboard.type('CF4o', { delay: 20 });
  await page.click('#idw_tmp_03'); await page.keyboard.type('11LX', { delay: 20 });
  await page.click('#idw_tmp_04'); await page.keyboard.type('SAEO', { delay: 20 });
  await page.click('#idw_tmp_05'); await page.keyboard.type('3R1A', { delay: 20 });
  await dump(page, 'p3_idw_lleno');

  console.log('\n➡️ Click "+" (btn_idw) para agregar el ticket...');
  await page.click('#btn_idw');
  await page.waitForTimeout(2000);
  await dump(page, 'p4_post_agregar_idw');

  console.log('\n=== API CALLS ===');
  console.log(JSON.stringify(apiCalls, null, 2));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
