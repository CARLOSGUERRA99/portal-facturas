/**
 * Diagnóstico: el código 5CBGBKG94776BDZLHQ quedó marcado "ya capturado" por el
 * backend de CAPUFE tras una validación anterior que nunca llegó a "Facturar
 * conceptos". Antes de reintentar nada, usar el flujo real "Recuperar una
 * factura, por código alfanumérico" para ver el estado real: ¿sigue pendiente
 * (recuperable) o ya se emitió un CFDI?
 */
require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  const apiCalls = [];
  page.on('response', async (resp) => {
    const url = resp.url();
    if (!/capufe-quadrum-backend/i.test(url)) return;
    let body = null;
    try { body = (await resp.text()).slice(0, 800); } catch {}
    apiCalls.push({ status: resp.status(), url: url.replace('https://facturacioncapufe.com.mx/capufe-quadrum-backend/', ''), body });
  });

  await page.goto('https://facturacioncapufe.com.mx/Capufe/facturacionrapida', { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(1500);

  console.log('➡️ Click "Recuperar una factura, por código alfanumérico"...');
  await page.evaluate(() => {
    const a = Array.from(document.querySelectorAll('a')).find(x => /recuperar una factura/i.test(x.textContent || ''));
    if (a) a.click();
  });
  await page.waitForTimeout(1500);

  const info1 = await page.evaluate(() => ({
    inputs: Array.from(document.querySelectorAll('input')).filter(i => i.offsetParent !== null).map(i => ({ id: i.id, name: i.name, placeholder: i.placeholder })),
    bodyText: document.body.innerText.slice(0, 500),
  }));
  console.log(JSON.stringify(info1, null, 2));

  const buf1 = await page.screenshot({ fullPage: true });
  console.log('📸', await subirArchivoR2(buf1, `debug/capufe_recuperar_1_${Date.now()}.png`, 'image/png'));

  // Buscar el campo de código en esta pantalla y probar con nuestro código
  const codigoInput = await page.$('#codigo, input[placeholder*="ódigo" i], input[placeholder*="lfanum" i]');
  if (codigoInput) {
    await codigoInput.click();
    await page.keyboard.type('5CBGBKG94776BDZLHQ', { delay: 30 });
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => /buscar|consultar|recuperar/i.test(x.textContent || ''));
      if (b) b.click();
    });
    await page.waitForTimeout(3000);
    const info2 = await page.evaluate(() => document.body.innerText.slice(0, 1500));
    console.log('\n=== RESULTADO BÚSQUEDA ===');
    console.log(info2);
    const buf2 = await page.screenshot({ fullPage: true });
    console.log('📸', await subirArchivoR2(buf2, `debug/capufe_recuperar_2_${Date.now()}.png`, 'image/png'));
  } else {
    console.log('⚠️ No se encontró campo de código en esta pantalla');
  }

  console.log('\n=== API CALLS ===');
  console.log(JSON.stringify(apiCalls, null, 2));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
