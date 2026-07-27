// Prueba solo "Validar Código" (sin llegar a Facturar conceptos) para
// desambiguar un carácter dudoso del OCR (I vs 1) usando al propio portal
// como fuente de verdad. Llena los datos fiscales reales (requeridos para
// que el botón valide) pero NO hace click en "Facturar conceptos".
require('dotenv').config();
const puppeteer = require('puppeteer');

const CANDIDATO = process.argv[2];
if (!CANDIDATO || CANDIDATO.length !== 18) {
  console.error('Uso: node validar-capufe-codigo.js <codigo-18-chars>');
  process.exit(1);
}

async function abrirYSeleccionar(page, dropdownIndex, matchFn) {
  const handles = await page.$$('.p-dropdown');
  await handles[dropdownIndex].click();
  await page.waitForTimeout(1000);
  const items = await page.evaluate(() => Array.from(document.querySelectorAll('li.p-dropdown-item')).map(li => li.textContent.trim()));
  const idx = items.findIndex(matchFn);
  const liHandles = await page.$$('li.p-dropdown-item');
  await liHandles[idx].click();
  await page.waitForTimeout(400);
}

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  await page.goto('https://facturacioncapufe.com.mx/Capufe/facturacionrapida', { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('#rfc', { timeout: 15000 });

  await page.click('#rfc'); await page.keyboard.type('GPR110128QD8', { delay: 20 });
  await page.click('#nombre');
  await page.waitForTimeout(2500);
  await page.evaluate(() => { document.getElementById('nombre').value = ''; });
  await page.click('#nombre'); await page.keyboard.type('GPN PINTURAS Y RECUBRIMIENTOS', { delay: 10 });
  await page.click('#domicilioFiscalReceptor'); await page.keyboard.type('80140', { delay: 15 });
  await page.click('#correo');
  await page.waitForTimeout(600);
  await abrirYSeleccionar(page, 0, t => t.startsWith('601'));
  await abrirYSeleccionar(page, 1, t => t.toUpperCase().startsWith('G03'));
  await page.click('#correo'); await page.keyboard.type('buzonfacturas@serviciosga.site', { delay: 10 });

  console.log(`➡️ Probando candidato: ${CANDIDATO}`);
  await page.click('#codigo');
  await page.keyboard.type(CANDIDATO, { delay: 25 });
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(x => /validar c[oó]digo/i.test(x.textContent || ''));
    if (b) b.click();
  });
  await page.waitForTimeout(3000);
  const texto = await page.evaluate(() => document.body.innerText);
  const relevante = texto.split('\n').filter(l =>
    /verificado|no existe|inv[aá]lid|capturado|no.?se.?encontr/i.test(l)
  ).join(' | ');
  console.log(`📋 Resultado: ${relevante || '(sin mensaje claro)'}`);

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
