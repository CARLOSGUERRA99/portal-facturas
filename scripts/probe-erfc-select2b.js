require('dotenv').config();
const puppeteer = require('puppeteer');

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1000 });

  const apiCalls = [];
  page.on('response', async (resp) => {
    const url = resp.url();
    if (!/select\.controller\.php/i.test(url)) return;
    let body = null;
    try { body = await resp.text(); } catch {}
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

  const selSelections = await page.$$('.select2-selection');
  console.log('Cantidad .select2-selection encontradas:', selSelections.length);

  console.log('➡️ Click real (Puppeteer) en el primer .select2-selection (Régimen Fiscal)...');
  await selSelections[0].click();
  await page.waitForTimeout(1500);

  const items = await page.evaluate(() => Array.from(document.querySelectorAll('.select2-results__option')).map(o => o.textContent.trim()));
  console.log('Opciones select2 tras click real:', JSON.stringify(items));

  console.log('\n=== API CALLS select.controller.php ===');
  console.log(JSON.stringify(apiCalls, null, 2));

  const buf = await page.screenshot({ fullPage: true });
  require('fs').writeFileSync('C:/Users/carlo/AppData/Local/Temp/claude/C--Users-carlo/bd061180-d7e6-4587-97d7-6edd69b553bc/scratchpad/erfc_select2b.png', buf);

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
