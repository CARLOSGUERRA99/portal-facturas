require('dotenv').config();
const puppeteer = require('puppeteer');

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1000 });
  page.on('console', m => console.log('CONSOLE:', m.text()));
  page.on('pageerror', e => console.log('PAGEERROR:', e.message));

  const apiCalls = [];
  page.on('response', async (resp) => {
    const url = resp.url();
    if (!/erfc\.com\.mx/i.test(url) || /\.(js|css|png|jpg|svg|woff|ico|jpeg)(\?|$)/i.test(url)) return;
    let body = null;
    try { body = (await resp.text()).slice(0, 500); } catch {}
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

  console.log('➡️ Click en el contenedor visual de select2 para Régimen Fiscal...');
  const abierto = await page.evaluate(() => {
    const select = document.getElementById('RegimenFiscalReceptor');
    // El contenedor select2 suele ser el siguiente sibling o buscar por data-select2-id
    const span = document.querySelector('span[aria-owns="select2-RegimenFiscalReceptor-results"]') ||
                 select.nextElementSibling;
    if (span) { span.querySelector('.select2-selection, .select2-selection__rendered')?.click(); span.click(); return true; }
    return false;
  });
  console.log('Click abierto:', abierto);
  await page.waitForTimeout(1500);

  const items = await page.evaluate(() => Array.from(document.querySelectorAll('.select2-results__option')).map(o => o.textContent.trim()));
  console.log('Opciones select2 visibles:', JSON.stringify(items));

  const buf = await page.screenshot({ fullPage: true });
  require('fs').writeFileSync('C:/Users/carlo/AppData/Local/Temp/claude/C--Users-carlo/bd061180-d7e6-4587-97d7-6edd69b553bc/scratchpad/erfc_select2.png', buf);

  console.log('\n=== API CALLS ===');
  console.log(JSON.stringify(apiCalls, null, 2));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
