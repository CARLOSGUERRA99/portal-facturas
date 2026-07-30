require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

const folioBuscar = process.argv[2] || '24203273';

(async () => {
  const user = process.env.ORLER_SINALOA_USER;
  const pass = process.env.ORLER_SINALOA_PASS;
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000 });
  page.on('dialog', async d => { await d.accept().catch(() => {}); });

  const archivos = [];
  page.on('response', async (r) => {
    const ct = r.headers()['content-type'] || '';
    const disp = r.headers()['content-disposition'] || '';
    if (/xml|pdf|octet-stream|zip/i.test(ct) || /attachment/i.test(disp)) {
      try { const buf = await r.buffer(); if (buf.length > 200) { archivos.push({ url: r.url(), ct, buf }); console.log(`📎 ${r.url()} (${ct}, ${buf.length}b)`); } } catch {}
    }
  });

  await page.goto('https://facturacion.sinaloa.gob.mx/login', { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('input[name="user"]', { timeout: 15000 });
  await page.click('input[name="user"]'); await page.keyboard.type(user, { delay: 25 });
  await page.click('input[name="password"]'); await page.keyboard.type(pass, { delay: 25 });
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(x => /iniciar|entrar|acceder/i.test(x.textContent || ''));
    if (b) b.click();
  });
  await page.waitForTimeout(5000);

  console.log(`➡️ Abriendo menú de acciones de la factura ${folioBuscar}...`);
  const btnHandle = await page.evaluateHandle((folio) => {
    const row = Array.from(document.querySelectorAll('tr')).find(tr => tr.textContent.includes(folio));
    return row ? row.querySelector('button') : null;
  }, folioBuscar);
  const btnEl = btnHandle.asElement();
  if (!btnEl) { console.log('❌ No se encontró el botón'); await browser.close(); process.exit(1); }
  await btnEl.click();
  await page.waitForTimeout(1500);

  const opciones = await page.evaluate(() => {
    // El menú de material-ui se monta al final del body en un layer
    const items = Array.from(document.querySelectorAll('[role=menuitem], .menu-item, span, div'))
      .filter(el => el.children.length === 0 && /xml|pdf|descargar|correo|enviar|ver/i.test(el.textContent || ''))
      .map(el => el.textContent.trim());
    return [...new Set(items)].slice(0, 20);
  });
  console.log('Opciones visibles:', JSON.stringify(opciones, null, 2));

  const buf = await page.screenshot({ fullPage: true });
  console.log('📸', await subirArchivoR2(buf, `debug/orler_menu_abierto_${Date.now()}.png`, 'image/png'));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
