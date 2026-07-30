// Descarga el CFDI (XML+PDF) de UNA factura Orler por invocación. Un browser
// fresco por factura — el menú de React de material-ui se rompe si se reusa la
// misma pestaña para varias filas (Target closed).
// Uso: node scripts/orler-descargar-una.js <folioFactura>
require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');
const { extraerUUIDcfdi } = require('../lib/util');

const folioFactura = process.argv[2];
if (!folioFactura) { console.error('Uso: node orler-descargar-una.js <folioFactura>'); process.exit(1); }

(async () => {
  const user = process.env.ORLER_SINALOA_USER;
  const pass = process.env.ORLER_SINALOA_PASS;
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000 });
  page.on('dialog', async d => { await d.accept().catch(() => {}); });

  const archivos = [];
  const urlsApi = [];
  page.on('response', async (r) => {
    const u = r.url();
    const ct = r.headers()['content-type'] || '';
    const disp = r.headers()['content-disposition'] || '';
    if (/descarga|download|xml|pdf|cfdi|factura/i.test(u) && !/\.(js|css|png|jpg|svg|woff)/i.test(u)) {
      urlsApi.push({ u, ct, status: r.status() });
    }
    if (/xml|pdf|octet-stream|zip/i.test(ct) || /attachment/i.test(disp)) {
      try { const buf = await r.buffer(); if (buf.length > 200) { archivos.push({ url: u, ct, buf }); console.log(`📎 ${u.slice(0,110)} (${ct}, ${buf.length}b)`); } } catch {}
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
  await page.waitForTimeout(6000);

  for (const etiqueta of ['Descargar XML', 'Descargar PDF']) {
    console.log(`➡️ ${etiqueta} de la factura ${folioFactura}...`);
    // Reabrir el menú desde cero cada vez (el menú se desmonta al elegir opción)
    const abierto = await page.evaluate((folio) => {
      const row = Array.from(document.querySelectorAll('tr')).find(tr => tr.textContent.includes(folio));
      if (!row) return false;
      const btn = row.querySelector('button');
      if (!btn) return false;
      btn.click();
      return true;
    }, folioFactura);
    if (!abierto) { console.log('   ❌ fila/botón no encontrado'); break; }
    await page.waitForTimeout(1600);

    const clic = await page.evaluate((et) => {
      const items = Array.from(document.querySelectorAll('span, div, [role=menuitem]'))
        .filter(el => el.children.length === 0 && el.textContent.trim() === et);
      const el = items[items.length - 1];
      if (!el) return false;
      const clickable = el.closest('[role=menuitem]') || el.closest('div[tabindex]') || el;
      clickable.click();
      return true;
    }, etiqueta);
    console.log(`   click en "${etiqueta}": ${clic}`);
    await page.waitForTimeout(5000);
  }

  console.log('\n=== URLs de API observadas ===');
  console.log(JSON.stringify(urlsApi.slice(-12), null, 2));

  const xmlA = archivos.find(a => /xml/i.test(a.ct) || /\.xml/i.test(a.url));
  const pdfA = archivos.find(a => /pdf/i.test(a.ct) || /\.pdf/i.test(a.url));

  if (!xmlA) {
    console.log('❌ No se capturó el XML');
    const buf = await page.screenshot({ fullPage: true });
    console.log('📸', await subirArchivoR2(buf, `debug/orler_desc_fail_${folioFactura}_${Date.now()}.png`, 'image/png'));
    await browser.close(); process.exit(1);
  }

  const xml = xmlA.buf.toString('utf8');
  const uuid = extraerUUIDcfdi(xmlA.buf);
  const total = (xml.match(/<(?:cfdi:)?Comprobante\b[^>]*\sTotal="([\d.]+)"/i) || [])[1];
  const rfcEmisor = (xml.match(/<(?:cfdi:)?Emisor[^>]*\sRfc="([^"]+)"/i) || [])[1];
  const rfcReceptor = (xml.match(/<(?:cfdi:)?Receptor[^>]*\sRfc="([^"]+)"/i) || [])[1];
  const conceptoDesc = (xml.match(/Descripcion="([^"]{0,200})"/i) || [])[1];
  const fechaTimbrado = (xml.match(/FechaTimbrado="([^"]+)"/i) || [])[1];

  console.log('\n=== CFDI REAL ===');
  console.log('Folio factura :', folioFactura);
  console.log('UUID          :', uuid);
  console.log('Total         :', total);
  console.log('RFC Emisor    :', rfcEmisor);
  console.log('RFC Receptor  :', rfcReceptor);
  console.log('Timbrado      :', fechaTimbrado);
  console.log('Concepto      :', conceptoDesc);

  if (rfcReceptor !== 'GPR110128QD8') { console.log('❌ RFC receptor no es GPN — no se sube'); await browser.close(); process.exit(1); }

  const xmlUrl = await subirArchivoR2(xmlA.buf, `facturas/${uuid}.xml`, 'application/xml');
  const pdfUrl = pdfA ? await subirArchivoR2(pdfA.buf, `facturas/${uuid}.pdf`, 'application/pdf') : null;
  console.log('☁️ XML:', xmlUrl);
  console.log('☁️ PDF:', pdfUrl || '(no capturado)');
  console.log('\nJSON:', JSON.stringify({ folioFactura, uuid, total: parseFloat(total), conceptoDesc, xmlUrl, pdfUrl }));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
