// Recupera el CFDI de un ticket de Farmacias Similares YA FACTURADO en
// Factura-T (KURIGAGE), sin volver a facturar nada.
//
// Con la clave de sucursal + total + código de barras, el botón "Verificar"
// devuelve directamente el modal "Sus archivos están listos para ser
// descargados" y dentro va un <a href="/download/{RFC}-{SERIE}-{UUID}"> con el
// ZIP (XML + PDF). Aquí se saca ese enlace, se baja con la cookie de la sesión,
// se descomprime y se archiva en R2 como facturas/{uuid}.
//
//   node scripts/similares-recuperar-cfdi.js 212
//   node scripts/similares-recuperar-cfdi.js 212 --aplicar
require('dotenv').config();
const puppeteer = require('puppeteer');
const unzipper = require('unzipper');
const db = require('../lib/db');
const { subirArchivoR2 } = require('../storage/r2');
const { leerCFDI, verificarCFDI } = require('../lib/cfdi');

const PORTAL = 'https://facturacion.appskurigage.com';
const APLICAR = process.argv.includes('--aplicar');
const TICKET_ID = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a))) || 212;
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log(APLICAR ? '⚠️  MODO APLICAR\n' : 'ℹ️  Simulacro (--aplicar para escribir en BD)\n');

  const [[t]] = await db.query(
    `SELECT t.id, t.user_id, t.comercio, t.status, t.ocr_json, COALESCE(c.rfc, u.rfc) AS rfc
       FROM tickets t JOIN users u ON t.user_id = u.id
       LEFT JOIN clientes c ON c.id = u.cliente_id WHERE t.id = ?`, [TICKET_ID]);
  if (!t) { console.log(`#${TICKET_ID} no existe`); process.exit(1); }

  const d = JSON.parse(t.ocr_json || '{}');
  const sucursal = d.sucursal;
  const codigoBarras = d.codigoBarras;
  const total = Number(d.total).toFixed(2);
  if (!sucursal || !codigoBarras) {
    console.log(`#${TICKET_ID}: falta sucursal o codigoBarras en el ocr_json (el "folio" que guarda el OCR es el TC Ticket, un UUID interno, y no sirve).`);
    process.exit(1);
  }
  console.log(`#${TICKET_ID} ${t.comercio} · sucursal ${sucursal} · código ${codigoBarras} · $${total}`);

  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}&stealth=true`,
  });
  const page = await browser.newPage();
  page.on('dialog', async (x) => { console.log('🔔', x.message()); await x.accept().catch(() => {}); });

  try {
    await page.goto(`${PORTAL}/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('#inputSucursalClave', { timeout: 25000 });
    await dormir(1000);

    const poner = (sel, v) => page.evaluate((s, val) => {
      const e = document.querySelector(s);
      if (!e) return false;
      e.value = val;
      ['input', 'change', 'keyup', 'blur'].forEach((ev) => e.dispatchEvent(new Event(ev, { bubbles: true })));
      return true;
    }, sel, String(v));

    await poner('#inputSucursalClave', sucursal);
    await poner('#inputVentaTotal', total);
    await poner('#inputVentaId', codigoBarras);

    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button, input[type=submit], a'))
        .find((x) => /verificar/i.test(x.textContent || x.value || '') && x.offsetParent);
      if (b) b.click();
    });
    await dormir(9000);

    const enlace = await page.evaluate(() => {
      const a = Array.from(document.querySelectorAll('a')).find((x) => /descargar\s*zip/i.test(x.textContent || ''));
      return a ? a.getAttribute('href') : null;
    });

    if (!enlace) {
      const txt = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 400));
      console.log('❌ el portal no ofreció el zip. Puede que este ticket todavía no esté facturado.');
      console.log('   pantalla:', txt);
      await browser.close();
      process.exit(1);
    }
    console.log(`   enlace del zip: ${enlace}`);

    const cookie = (await page.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
    await browser.close();

    const res = await fetch(new URL(enlace, PORTAL).href, { headers: { Cookie: cookie } });
    const zip = Buffer.from(await res.arrayBuffer());
    console.log(`   zip: HTTP ${res.status} · ${zip.length} bytes · ${res.headers.get('content-type')}`);

    const dir = await unzipper.Open.buffer(zip);
    console.log(`   contenido: ${dir.files.map((f) => f.path).join(', ')}`);

    const buscar = (re) => dir.files.find((f) => re.test(f.path));
    const fXml = buscar(/\.xml$/i);
    const fPdf = buscar(/\.pdf$/i);
    if (!fXml) { console.log('❌ el zip no trae XML'); process.exit(1); }

    const xmlBuf = await fXml.buffer();
    const cfdi = leerCFDI(xmlBuf);
    if (!cfdi) { console.log('❌ el XML del zip no es un CFDI legible'); process.exit(1); }

    const problemas = verificarCFDI(cfdi, { rfcEsperado: t.rfc, totalEsperado: Number(d.total) || 0 });
    problemas.forEach((p) => console.log(`   ${p.gravedad === 'grave' ? '🛑' : '⚠️ '} ${p.msg}`));
    const uuid = (cfdi.uuid || '').toLowerCase();
    console.log(`   ✅ CFDI ${uuid} · ${cfdi.emisorNombre} (${cfdi.emisorRfc}) · $${cfdi.total} · ${cfdi.serie || ''}${cfdi.folio || ''} · receptor ${cfdi.receptorRfc}`);

    if (problemas.some((p) => p.gravedad === 'grave')) { console.log('🛑 problemas graves: no se toca la BD'); process.exit(1); }

    const xmlUrl = await subirArchivoR2(xmlBuf, `facturas/${uuid}.xml`, 'application/xml');
    let pdfUrl = null;
    if (fPdf) pdfUrl = await subirArchivoR2(await fPdf.buffer(), `facturas/${uuid}.pdf`, 'application/pdf');
    console.log(`   XML ${xmlUrl}\n   PDF ${pdfUrl || '(el zip no traía PDF)'}`);

    if (!APLICAR) { console.log('\n(simulacro: archivos en R2, BD sin tocar)'); process.exit(0); }

    const resumen = problemas.length ? problemas.map((p) => p.msg).join(' · ').slice(0, 500) : null;
    const campos = [pdfUrl, xmlUrl, 'completado', uuid, cfdi.receptorRfc, cfdi.emisorRfc,
      (cfdi.emisorNombre || '').slice(0, 255) || null, cfdi.total ?? null,
      `${cfdi.serie || ''}${cfdi.folio || ''}`.slice(0, 60) || null,
      cfdi.fechaTimbrado ? cfdi.fechaTimbrado.replace('T', ' ').slice(0, 19) : null, resumen];

    const [[ya]] = await db.query('SELECT id FROM facturas WHERE ticket_id = ? LIMIT 1', [TICKET_ID]);
    if (ya) {
      await db.query(
        `UPDATE facturas SET pdf_url=?, xml_url=?, status=?, uuid=?, receptor_rfc=?, emisor_rfc=?,
                emisor_nombre=?, total=?, serie_folio=?, fecha_timbrado=?, verificacion=? WHERE id=?`,
        [...campos, ya.id]);
      console.log(`   💾 factura #${ya.id} actualizada`);
    } else {
      const [ins] = await db.query(
        `INSERT INTO facturas (user_id, ticket_id, comercio, pdf_url, xml_url, status, uuid, receptor_rfc,
                               emisor_rfc, emisor_nombre, total, serie_folio, fecha_timbrado, verificacion)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [t.user_id, TICKET_ID, t.comercio, ...campos]);
      console.log(`   💾 factura #${ins.insertId} creada`);
    }
    await db.query("UPDATE tickets SET status='procesado', error_msg=NULL, reintento_programado=NULL WHERE id=?", [TICKET_ID]);
    console.log(`   💾 ticket #${TICKET_ID} → procesado`);
    process.exit(0);
  } catch (e) {
    console.error('❌', e.message);
    await browser.close().catch(() => {});
    process.exit(1);
  }
})();
