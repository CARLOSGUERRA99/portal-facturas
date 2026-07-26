require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

const FOLIO = '18132905202621000068200100084801077';

(async () => {
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  // Escuchar eventos de navegación / cierre
  page.on('framenavigated', f => console.log('FRAME NAVIGATED:', f.url()));
  page.on('close', () => console.log('PAGE CLOSED EVENT'));
  page.on('error', e => console.log('PAGE ERROR:', e.message));

  await page.goto('https://www.e7-eleven.com.mx/facturacion/KPortalExterno/', { waitUntil: 'networkidle2', timeout: 40000 });
  await page.waitForTimeout(3000);

  // Click FACTURA EXPRESS
  await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('button,a,.btn')).find(e => e.offsetParent && (e.textContent||'').trim().toUpperCase() === 'FACTURA EXPRESS');
    if (el) el.click();
  });
  await page.waitForTimeout(4500);
  console.log('Estado tras FACTURA EXPRESS - URL:', page.url());

  // Esperar el campo
  const inp = await page.$('input[name="noTicket"]');
  console.log('Campo noTicket encontrado:', !!inp);
  if (!inp) { await browser.close(); return; }

  // Escribir solo 5 caracteres primero y verificar que la página sigue viva
  await inp.click({ clickCount: 3 });
  await inp.type('18132', { delay: 60 });
  await page.waitForTimeout(500);
  console.log('URL tras 5 chars:', page.url());
  const vivo1 = await page.evaluate(() => !!document.body).catch(() => false);
  console.log('Página viva tras 5 chars:', vivo1);

  // Continuar con el resto
  await inp.type('905202621000068200100084801077', { delay: 30 });
  await page.waitForTimeout(1000);
  const vivo2 = await page.evaluate(() => !!document.body).catch(() => false);
  console.log('Página viva tras folio completo:', vivo2);

  const buf = await page.screenshot({ fullPage: false }).catch(() => null);
  if (buf) console.log('shot:', await subirArchivoR2(buf, `debug/p7e_type_${Date.now()}.png`, 'image/png'));

  // Leer qué hay en el campo
  const val = await page.evaluate(() => {
    const i = document.querySelector('input[name="noTicket"]');
    return i ? i.value : 'no encontrado';
  }).catch(e => 'error: ' + e.message);
  console.log('Valor en noTicket:', val);

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌ OUTER:', e.message); process.exit(1); });
