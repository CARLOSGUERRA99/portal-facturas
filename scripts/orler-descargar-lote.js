// Descarga y VERIFICA los CFDI reales de Orler desde el historial del portal
// ("Descargar XML" / "Descargar PDF" en el menú de 3 puntos de cada fila).
// Uso: node scripts/orler-descargar-lote.js <folioFactura1> <folioFactura2> ...
//   o sin argumentos → descarga las facturas timbradas HOY.
require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');
const { extraerUUIDcfdi } = require('../lib/util');

const foliosArg = process.argv.slice(2);

async function abrirMenuYDescargar(page, folioFactura, archivos) {
  archivos.length = 0;
  const btnHandle = await page.evaluateHandle((folio) => {
    const row = Array.from(document.querySelectorAll('tr')).find(tr => tr.textContent.includes(folio));
    return row ? row.querySelector('button') : null;
  }, folioFactura);
  const btnEl = btnHandle.asElement();
  if (!btnEl) return { error: 'fila/botón no encontrado' };

  for (const etiqueta of ['Descargar XML', 'Descargar PDF']) {
    await btnEl.click();
    await page.waitForTimeout(1200);
    const opcHandle = await page.evaluateHandle((et) => {
      const items = Array.from(document.querySelectorAll('span, div, [role=menuitem]'))
        .filter(el => el.children.length === 0 && el.textContent.trim() === et);
      return items[items.length - 1] || null;
    }, etiqueta);
    const opcEl = opcHandle.asElement();
    if (!opcEl) { console.log(`   ⚠️ opción "${etiqueta}" no encontrada`); continue; }
    await opcEl.click();
    await page.waitForTimeout(4000);
  }
  return { ok: true };
}

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
      try { const buf = await r.buffer(); if (buf.length > 200) archivos.push({ url: r.url(), ct, buf }); } catch {}
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

  // Descubrir los folios de factura timbrados hoy si no se pasaron por argumento
  let folios = foliosArg;
  if (!folios.length) {
    folios = await page.evaluate(() => {
      const hoy = new Date();
      const dd = String(hoy.getDate()).padStart(2, '0');
      const mm = String(hoy.getMonth() + 1).padStart(2, '0');
      const hoyStr = `${dd}/${mm}/${hoy.getFullYear()}`;
      return Array.from(document.querySelectorAll('tr'))
        .filter(tr => tr.innerText.includes(hoyStr))
        .map(tr => { const m = tr.innerText.match(/\b(24\d{6})\b/); return m ? m[1] : null; })
        .filter(Boolean);
    });
    console.log(`Folios de factura detectados (timbrados hoy): ${JSON.stringify(folios)}`);
  }

  const resultados = [];
  for (const folioFactura of folios) {
    console.log(`\n➡️ Descargando CFDI de la factura ${folioFactura}...`);
    await abrirMenuYDescargar(page, folioFactura, archivos);

    const xmlA = archivos.find(a => /xml/i.test(a.ct) || /\.xml/i.test(a.url));
    const pdfA = archivos.find(a => /pdf/i.test(a.ct) || /\.pdf/i.test(a.url));
    if (!xmlA) { console.log('   ❌ No se capturó XML'); resultados.push({ folioFactura, ok: false }); continue; }

    const xml = xmlA.buf.toString('utf8');
    const uuid = extraerUUIDcfdi(xmlA.buf);
    const total = (xml.match(/<(?:cfdi:)?Comprobante\b[^>]*\sTotal="([\d.]+)"/i) || [])[1];
    const rfcEmisor = (xml.match(/<(?:cfdi:)?Emisor[^>]*\sRfc="([^"]+)"/i) || [])[1];
    const rfcReceptor = (xml.match(/<(?:cfdi:)?Receptor[^>]*\sRfc="([^"]+)"/i) || [])[1];
    const conceptoDesc = (xml.match(/Descripcion="([^"]{0,180})"/i) || [])[1];

    console.log(`   UUID: ${uuid} | Total: ${total} | Emisor: ${rfcEmisor} | Receptor: ${rfcReceptor}`);
    console.log(`   Concepto: ${conceptoDesc}`);

    if (rfcReceptor !== 'GPR110128QD8') { console.log('   ❌ RFC receptor NO es GPN — se descarta'); resultados.push({ folioFactura, ok: false }); continue; }

    const xmlUrl = await subirArchivoR2(xmlA.buf, `facturas/${uuid}.xml`, 'application/xml');
    const pdfUrl = pdfA ? await subirArchivoR2(pdfA.buf, `facturas/${uuid}.pdf`, 'application/pdf') : null;
    console.log(`   ☁️ XML: ${xmlUrl}`);
    console.log(`   ☁️ PDF: ${pdfUrl || '(no capturado)'}`);
    resultados.push({ folioFactura, ok: true, uuid, total: parseFloat(total), rfcEmisor, rfcReceptor, conceptoDesc, xmlUrl, pdfUrl });
  }

  console.log('\n\n=== RESULTADOS (JSON para reconciliar) ===');
  console.log(JSON.stringify(resultados.filter(r => r.ok), null, 2));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
