require('dotenv').config();
const puppeteer = require('puppeteer');

const VARIANTE = process.argv[2]; // 5 bloques separados por espacio
if (!VARIANTE) { console.error('Uso: node test-erfc-idw-variant.js "B1 B2 B3 B4 B5"'); process.exit(1); }
const [b1, b2, b3, b4, b5] = VARIANTE.split(' ');

async function selectRegimen(page, matchStr) {
  const sels = await page.$$('.select2-selection');
  await sels[0].click();
  await page.waitForTimeout(1200);
  const items = await page.$$('.select2-results__option');
  const texts = await page.$$eval('.select2-results__option', els => els.map(e => e.textContent.trim()));
  const idx = texts.findIndex(t => t.startsWith(matchStr));
  await items[idx].click();
  await page.waitForTimeout(500);
}

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1000 });

  let idwStatus = null, idwBody = null;
  page.on('response', async (resp) => {
    if (/revisaIDW\.php/i.test(resp.url())) {
      idwStatus = resp.status();
      idwBody = await resp.text().catch(() => null);
    }
  });

  await page.goto('https://www.erfc.com.mx', { waitUntil: 'load', timeout: 30000 });
  await page.click('#correo'); await page.keyboard.type('buzonfacturas@serviciosga.site', { delay: 8 });
  await page.click('#rfc'); await page.keyboard.type('GPR110128QD8', { delay: 8 });
  await page.click('#link_terminos_condiciones');
  await page.waitForTimeout(400);
  await page.click('#accept_terminos_condiciones');
  await page.click('#btn-access');
  await page.waitForTimeout(2200);

  await page.click('#DomicilioFiscalReceptor'); await page.keyboard.type('80140', { delay: 10 });
  await page.click('#nombre'); await page.keyboard.type('GPN PINTURAS Y RECUBRIMIENTOS', { delay: 8 });
  await selectRegimen(page, '601');
  await page.evaluate(() => { document.getElementById('email').value = ''; });
  await page.click('#email'); await page.keyboard.type('buzonfacturas@serviciosga.site', { delay: 8 });

  await page.click('#idw_tmp_01'); await page.keyboard.type(b1, { delay: 20 });
  await page.click('#idw_tmp_02'); await page.keyboard.type(b2, { delay: 20 });
  await page.click('#idw_tmp_03'); await page.keyboard.type(b3, { delay: 20 });
  await page.click('#idw_tmp_04'); await page.keyboard.type(b4, { delay: 20 });
  await page.click('#idw_tmp_05'); await page.keyboard.type(b5, { delay: 20 });

  console.log(`➡️ Probando variante: ${b1} ${b2} ${b3} ${b4} ${b5}`);
  await page.click('#btn_idw');
  await page.waitForTimeout(2200);

  console.log(`Resultado revisaIDW.php: status=${idwStatus} body=${JSON.stringify(idwBody)}`);
  const bodyText = await page.evaluate(() => document.body.innerText);
  const totalMatch = bodyText.match(/Tickets Totales:\s*(\d+)/);
  console.log('Tickets Totales:', totalMatch ? totalMatch[1] : '?');

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
