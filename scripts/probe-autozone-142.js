// SONDA de diagnóstico del ticket #142 (AutoZone de México, $648, 27/07/2026,
// código de barras 07047995272072726). El ticket ya se borró de la BD y su
// historial de intentos se fue con él por ON DELETE CASCADE, así que la única
// forma de saber POR QUÉ no facturó es preguntárselo al portal.
//
// ⚠️ NO FACTURA. Recorre el wizard hasta la validación (código de barras →
// fecha → monto → Siguiente) y se detiene ahí, ANTES de tocar los datos
// fiscales y antes de generar nada. Solo lee lo que el portal responde.
//
// Además cronometra cada paso, para comprobar si el bot se está comiendo el
// tope de 60 s de sesión de Browserless — la hipótesis principal, porque
// bots/autozone.js tiene 39.5 s de esperas FIJAS antes de sumar cargas reales.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const puppeteer = require('puppeteer');

const DATOS = { barcode: '07047995272072726', fecha: '2026-07-27', total: '648' };
const URL = 'https://autozone.cdc.origon.cloud/facturacion/autozone';

const t0 = Date.now();
const marca = (etapa) => console.log(`   ⏱️  ${((Date.now() - t0) / 1000).toFixed(1)}s — ${etapa}`);

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error('BROWSERLESS_TOKEN no definido');

  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true`,
  });
  marca('conectado a Browserless');

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
  page.on('dialog', async (d) => { console.log('   🔔 dialog:', d.message()); await d.accept().catch(() => {}); });

  const clickNavBtn = async (texto) => {
    const rect = await page.evaluate((txt) => {
      const divs = Array.from(document.querySelectorAll('div.navigation-container'));
      const d = divs.find((d) => d.textContent.trim() === txt && d.getBoundingClientRect().width > 5);
      if (!d) return null;
      const r = d.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, texto);
    if (!rect) return false;
    await page.mouse.click(rect.x, rect.y);
    await page.waitForTimeout(300);
    return true;
  };

  try {
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 45000 });
    marca('portal cargado');
    await page.waitForTimeout(3000);

    await page.evaluate(() => {
      const a = Array.from(document.querySelectorAll('a')).find((a) => /facturaci[oó]n\s+r[aá]pida/i.test(a.textContent));
      if (a) a.click();
    });
    await page.waitForTimeout(2000);
    marca('facturación rápida');

    console.log('   iniciar:', await clickNavBtn('Iniciar') ? 'ok' : 'NO ENCONTRADO');
    await page.waitForTimeout(3000);
    marca('wizard abierto');

    const input = await page.waitForSelector('#mat-input-0', { timeout: 10000 }).catch(() => null);
    if (!input) {
      console.log('❌ no apareció el campo de código de barras (#mat-input-0)');
      console.log(await page.evaluate(() => document.body.innerText.slice(0, 600)));
      await browser.close(); process.exit(0);
    }
    await input.click({ clickCount: 3 });
    await input.type(DATOS.barcode, { delay: 60 });
    await clickNavBtn('Siguiente');
    await page.waitForTimeout(3500);
    marca('código de barras enviado');

    // Fecha: calendario con <td> por día. Se navega al mes correcto.
    const [fy, fm, fd] = DATOS.fecha.split('-').map(Number);
    const puesta = await page.evaluate((d) => {
      const celdas = Array.from(document.querySelectorAll('td'));
      const c = celdas.find((c) => c.textContent.trim() === String(d) && c.getBoundingClientRect().width > 5);
      if (c) { c.click(); return true; }
      return false;
    }, fd);
    console.log(`   fecha ${fd}/${fm}/${fy}:`, puesta ? 'seleccionada' : 'NO se encontró la celda del día');
    await page.waitForTimeout(1500);
    await clickNavBtn('Siguiente');
    await page.waitForTimeout(2500);
    marca('fecha enviada');

    const montoOk = await page.evaluate((v) => {
      const inp = Array.from(document.querySelectorAll('input')).find((i) => i.offsetParent !== null && i.type !== 'hidden');
      if (!inp) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, v);
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, DATOS.total);
    console.log('   monto:', montoOk ? 'escrito' : 'NO se encontró el campo');
    await page.waitForTimeout(500);

    // Este "Siguiente" dispara la validación real del ticket contra AutoZone.
    await clickNavBtn('Siguiente');
    await page.waitForTimeout(6000);
    marca('VALIDACIÓN — respuesta del portal');

    const texto = await page.evaluate(() => document.body.innerText.replace(/\n{2,}/g, '\n').trim());
    console.log('\n───────── lo que dice el portal ─────────');
    console.log(texto.slice(0, 1200));
    console.log('─────────────────────────────────────────');
    console.log(`\n⏱️  TOTAL hasta la validación: ${((Date.now() - t0) / 1000).toFixed(1)}s  (tope de sesión Browserless: 60s)`);
    console.log('🛑 La sonda se detiene aquí: NO se llenan datos fiscales ni se genera factura.');

    await browser.close();
    process.exit(0);
  } catch (e) {
    console.log(`\n❌ la sonda murió a los ${((Date.now() - t0) / 1000).toFixed(1)}s: ${e.message}`);
    console.log('   (si dice "Target closed"/"Session closed" a los ~60s, es el tope de Browserless)');
    await browser.close().catch(() => {});
    process.exit(1);
  }
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
