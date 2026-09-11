// Sonda de SOLO LECTURA para el ticket #387 (Enerfuel Tech / NetPay).
//
// Comprueba qué contesta el portal a dos referencias:
//   · 052007273914E40  ← la que usó el bot (OCR leyó "4E40" el verificador)
//   · 052007273914EAD  ← la impresa de verdad en el ticket (verificada en foto)
//
// ⛔ SOLO pulsa "Buscar". NUNCA toca "Continuar" ni "FACTURAR": emitir el CFDI
//    es irreversible. El timbrado lo lanza una persona después.
require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

const REFS = process.argv.slice(2).length ? process.argv.slice(2)
  : ['052007273914E40', '052007273914EAD'];

async function probar(browser, referencia) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('dialog', async d => { console.log('🔔 Dialog:', d.message()); await d.accept().catch(() => {}); });

  console.log(`\n=== Referencia ${referencia} ===`);
  await page.goto('https://factura.enerfueltech.com/NoUserInvoice', { waitUntil: 'networkidle2', timeout: 45000 });
  await page.waitForTimeout(2500);
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button, a')).find(x => /facturar sin registro/i.test(x.textContent || ''));
    if (b) b.click();
  });
  await page.waitForTimeout(2000);

  const inputs = await page.$$('input[type="text"]');
  if (!inputs.length) { console.log('❌ No hay campo de referencia. URL:', page.url()); await page.close(); return; }
  const refField = inputs[inputs.length - 1];
  await refField.click({ clickCount: 3 });
  await page.keyboard.type(String(referencia), { delay: 30 });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim() === 'Buscar');
    if (b) b.click();
  });
  await page.waitForTimeout(4000);

  const texto = await page.evaluate(() => document.body.innerText);
  console.log('--- texto de la página ---\n' + texto.slice(0, 1200));
  const botones = await page.evaluate(() => Array.from(document.querySelectorAll('button'))
    .filter(b => b.offsetParent !== null)
    .map(b => `"${b.textContent.replace(/\s+/g, ' ').trim()}"${b.disabled ? ' (deshabilitado)' : ''}`));
  console.log('Botones visibles:', botones.join(', '));

  try {
    const buf = await page.screenshot({ fullPage: true });
    console.log('📸', await subirArchivoR2(buf, `debug/enerfueltech_probe387_${referencia}_${Date.now()}.png`, 'image/png'));
  } catch (e) { console.log('(sin screenshot:', e.message, ')'); }

  await page.close();
}

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error('BROWSERLESS_TOKEN no definido');
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  for (const r of REFS) await probar(browser, r).catch(e => console.log('❌', r, e.message));
  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌ Error:', e.message); process.exit(1); });
