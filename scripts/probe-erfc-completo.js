require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

async function selectRegimen(page, matchStr) {
  const sels = await page.$$('.select2-selection');
  await sels[0].click();
  await page.waitForTimeout(1200);
  const items = await page.$$('.select2-results__option');
  const texts = await page.$$eval('.select2-results__option', els => els.map(e => e.textContent.trim()));
  const idx = texts.findIndex(t => t.startsWith(matchStr));
  if (idx === -1) throw new Error(`No se encontró régimen "${matchStr}" en [${texts.join(' | ')}]`);
  await items[idx].click();
  await page.waitForTimeout(500);
}

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1000 });

  const apiCalls = [];
  page.on('response', async (resp) => {
    const url = resp.url();
    if (!/erfc\.com\.mx\/controllers/i.test(url)) return;
    let body = null;
    try { body = (await resp.text()).slice(0, 1000); } catch {}
    apiCalls.push({ status: resp.status(), url, body });
  });

  await page.goto('https://www.erfc.com.mx', { waitUntil: 'load', timeout: 30000 });
  await page.click('#correo'); await page.keyboard.type('buzonfacturas@serviciosga.site', { delay: 10 });
  await page.click('#rfc'); await page.keyboard.type('GPR110128QD8', { delay: 10 });
  await page.click('#link_terminos_condiciones');
  await page.waitForTimeout(500);
  await page.click('#accept_terminos_condiciones');
  await page.click('#btn-access');
  await page.waitForTimeout(2500);

  console.log('➡️ CP + nombre...');
  await page.click('#DomicilioFiscalReceptor'); await page.keyboard.type('80140', { delay: 15 });
  await page.click('#nombre'); await page.keyboard.type('GPN PINTURAS Y RECUBRIMIENTOS', { delay: 10 });

  console.log('➡️ Régimen Fiscal (601)...');
  await selectRegimen(page, '601');

  console.log('➡️ Email (limpiar autofill + escribir)...');
  await page.evaluate(() => { document.getElementById('email').value = ''; });
  await page.click('#email'); await page.keyboard.type('buzonfacturas@serviciosga.site', { delay: 10 });

  const buf1 = await page.screenshot({ fullPage: true });
  const u1 = await subirArchivoR2(buf1, `debug/erfc_completo_fiscales_${Date.now()}.png`, 'image/png');
  console.log('📸 fiscales:', u1);

  console.log('\n➡️ IDW...');
  await page.click('#idw_tmp_01'); await page.keyboard.type('OOO', { delay: 20 });
  await page.click('#idw_tmp_02'); await page.keyboard.type('CF4o', { delay: 20 });
  await page.click('#idw_tmp_03'); await page.keyboard.type('11LX', { delay: 20 });
  await page.click('#idw_tmp_04'); await page.keyboard.type('SAEO', { delay: 20 });
  await page.click('#idw_tmp_05'); await page.keyboard.type('3R1A', { delay: 20 });

  console.log('➡️ Click "+"...');
  await page.click('#btn_idw');
  await page.waitForTimeout(2500);

  const buf2 = await page.screenshot({ fullPage: true });
  const u2 = await subirArchivoR2(buf2, `debug/erfc_completo_post_idw_${Date.now()}.png`, 'image/png');
  console.log('📸 post idw:', u2);

  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 1500));
  console.log('\nTexto tras agregar IDW:\n', bodyText);

  console.log('\n=== API CALLS ===');
  console.log(JSON.stringify(apiCalls, null, 2));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
