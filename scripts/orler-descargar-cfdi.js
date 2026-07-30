require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');
const { extraerUUIDcfdi } = require('../lib/util');

// Uso: node scripts/orler-descargar-cfdi.js [folioFactura]
const folioBuscar = process.argv[2] || null;

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
    if (/xml|pdf|octet-stream/i.test(ct) || /attachment/i.test(disp)) {
      try {
        const buf = await r.buffer();
        if (buf.length > 200) { archivos.push({ url: r.url(), ct, disp, buf }); console.log(`📎 ${r.url()} (${ct}, ${buf.length}b)`); }
      } catch {}
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

  // Volcar la estructura de la primera fila con Acciones (para ver los botones reales)
  const filaInfo = await page.evaluate((folioBuscar) => {
    const rows = Array.from(document.querySelectorAll('tr'));
    const row = folioBuscar
      ? rows.find(tr => tr.textContent.includes(folioBuscar))
      : rows.find(tr => /\$\d/.test(tr.textContent) && tr.querySelectorAll('td').length > 3);
    if (!row) return { error: 'fila no encontrada' };
    return {
      texto: row.innerText.replace(/\s+/g, ' ').slice(0, 200),
      html: row.outerHTML.slice(0, 2500),
      clicables: Array.from(row.querySelectorAll('a, button, i, svg, [onclick]')).map(el => ({
        tag: el.tagName, cls: el.className && el.className.toString().slice(0, 60),
        href: el.href || null, onclick: (el.getAttribute('onclick') || '').slice(0, 120), title: el.title || null,
      })),
    };
  }, folioBuscar);
  console.log('=== FILA ===');
  console.log(JSON.stringify(filaInfo, null, 2));

  const buf = await page.screenshot({ fullPage: true });
  console.log('📸', await subirArchivoR2(buf, `debug/orler_historial_${Date.now()}.png`, 'image/png'));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
