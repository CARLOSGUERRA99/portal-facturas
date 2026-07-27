/**
 * Sonda de reconocimiento DOM real de facturacioncapufe.com.mx/Capufe/facturacionrapida.
 * Objetivo: mapear el flujo real (datos fiscales por RFC + código de 18 caracteres +
 * validar + agregar + facturar), con selectores/API reales, no especulativos.
 * Uso: node scripts/probe-capufe.js
 */
require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

async function screenshot(page, label) {
  const buf = await page.screenshot({ fullPage: true }).catch(() => null);
  if (buf) {
    const u = await subirArchivoR2(buf, `debug/capufe_probe_${label}_${Date.now()}.png`, 'image/png');
    console.log(`📸 [${label}]: ${u}`);
  }
}

async function dumpForm(page, label) {
  const info = await page.evaluate(() => {
    const visible = el => el.offsetParent !== null;
    const inputs = Array.from(document.querySelectorAll('input, textarea')).filter(visible).map(i => ({
      id: i.id || null, name: i.name || null, placeholder: i.placeholder || null, value: (i.value || '').slice(0, 60),
    }));
    return { inputs, bodyText: (document.body.innerText || '').slice(0, 800) };
  });
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(info, null, 2));
}

async function selectPrimeDropdown(page, dropdownIndex, matchFn, label) {
  const handles = await page.$$('.p-dropdown');
  if (!handles[dropdownIndex]) { console.log(`⚠️ No existe dropdown #${dropdownIndex}`); return false; }
  await handles[dropdownIndex].click();
  await page.waitForTimeout(1200);
  const items = await page.evaluate(() => Array.from(document.querySelectorAll('li.p-dropdown-item')).map(li => li.textContent.trim()));
  console.log(`   ${label} — opciones visibles (${items.length}): ${JSON.stringify(items.slice(0, 10))}`);
  const idx = items.findIndex(matchFn);
  if (idx === -1) { console.log(`   ⚠️ No se encontró opción para ${label}`); await page.keyboard.press('Escape'); return false; }
  const liHandles = await page.$$('li.p-dropdown-item');
  await liHandles[idx].click();
  await page.waitForTimeout(500);
  return true;
}

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error('BROWSERLESS_TOKEN no definido');
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

  const apiCalls = [];
  page.on('response', async (resp) => {
    const url = resp.url();
    if (!/capufe-quadrum-backend/i.test(url)) return;
    let body = null;
    try { body = (await resp.text()).slice(0, 600); } catch {}
    apiCalls.push({ status: resp.status(), url: url.replace('https://facturacioncapufe.com.mx/capufe-quadrum-backend/', ''), body });
  });

  console.log('🌐 Cargando facturacionrapida...');
  await page.goto('https://facturacioncapufe.com.mx/Capufe/facturacionrapida', { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(1500);

  console.log('\n➡️ RFC...');
  await page.click('#rfc'); await page.keyboard.type('GPR110128QD8', { delay: 30 });
  await page.click('#nombre'); // dispara blur del RFC
  await page.waitForTimeout(2500); // esperar buscar_receptor_por_rfc + usocfdi_rfc

  console.log('➡️ Nombre / CP...');
  await page.evaluate(() => { document.getElementById('nombre').value = ''; });
  await page.click('#nombre'); await page.keyboard.type('GPN PINTURAS Y RECUBRIMIENTOS', { delay: 15 });
  await page.click('#domicilioFiscalReceptor'); await page.keyboard.type('80140', { delay: 20 });
  await page.click('#correo'); // blur CP
  await page.waitForTimeout(800);

  await dumpForm(page, 'antes_de_dropdowns');
  await screenshot(page, 'p2c_antes_dropdowns');

  console.log('\n➡️ Abriendo dropdown Régimen Fiscal (índice 0)...');
  await selectPrimeDropdown(page, 0, t => t.includes('601'), 'Régimen Fiscal (601)');
  await screenshot(page, 'p2d_post_regimen');

  console.log('\n➡️ Abriendo dropdown Uso CFDI (índice 1)...');
  await selectPrimeDropdown(page, 1, t => t.toUpperCase().includes('G03'), 'Uso CFDI (G03)');
  await screenshot(page, 'p2e_post_usocfdi');

  console.log('\n➡️ Correo...');
  await page.click('#correo'); await page.keyboard.type('buzonfacturas@serviciosga.site', { delay: 15 });
  await dumpForm(page, 'fiscales_completos');
  await screenshot(page, 'p2f_fiscales_completos');

  const CODIGO = '5CBGBKG94776BDZLHQ'; // ticket #118 real, confianza alta
  console.log(`\n➡️ Código (18): ${CODIGO} + Validar...`);
  await page.click('#codigo'); await page.keyboard.type(CODIGO, { delay: 30 });
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(x => /validar c[oó]digo/i.test(x.textContent || ''));
    if (b) b.click();
  });
  await page.waitForTimeout(4000);
  await dumpForm(page, 'post_validar_codigo');
  await screenshot(page, 'p3_post_validar_codigo');

  console.log('\n➡️ Click "Facturar conceptos" (EMISIÓN REAL)...');
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(x => /facturar conceptos/i.test(x.textContent || ''));
    if (b) b.click();
  });
  await page.waitForTimeout(6000);
  await dumpForm(page, 'post_facturar');
  await screenshot(page, 'p4_post_facturar');

  console.log('\n=== API CALLS (capufe-quadrum-backend) ===');
  console.log(JSON.stringify(apiCalls, null, 2));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌ Error:', e.message); process.exit(1); });
