/**
 * Recupera del portal de OXXO el PDF (y el XML si también falta) de una factura
 * YA TIMBRADA, usando su pantalla de Reimpresión.
 *
 * Para qué: el bot de OXXO baja XML y PDF en la misma sesión JSF, y a veces uno
 * de los dos se pierde (la descarga va por un POST de PrimeFaces que puede
 * devolver vacío sin fallar). El ticket queda como procesado —lo está, el CFDI
 * existe— pero sin el PDF, que es el que se entrega al contador. Le pasó a los
 * tickets #288, #290 y #366.
 *
 * ⚠️ ESTO NO VUELVE A FACTURAR. La pantalla de reimpresión solo CONSULTA una
 * factura ya emitida a partir de fecha + folio + total. No emite nada, así que
 * correrlo de más no puede generar un CFDI duplicado.
 *
 * ⚠️ La reimpresión pide la FECHA DEL TICKET, no la del timbrado. Con la fecha
 * equivocada el portal contesta "factura no encontrada" y parece que el folio
 * está mal.
 *
 * Uso:
 *   node scripts/oxxo-recuperar-pdf.js <ticketId> [ticketId...]
 *   node scripts/oxxo-recuperar-pdf.js --faltantes    → todos los de OXXO sin PDF
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const puppeteer = require('puppeteer');
const db = require('../lib/db');
const hooks = require('../commerce/oxxo/hooks');

const args = process.argv.slice(2);
const TODOS = args.includes('--faltantes');
const IDS = args.filter((a) => /^\d+$/.test(a)).map(Number);

(async () => {
  let objetivos = IDS;
  if (TODOS) {
    const [r] = await db.query(
      `SELECT f.ticket_id FROM facturas f
        WHERE f.comercio LIKE '%OXXO%' AND (f.pdf_url IS NULL OR f.pdf_url = '')
        ORDER BY f.ticket_id`
    );
    objetivos = r.map((x) => x.ticket_id);
  }
  if (!objetivos.length) {
    console.error('Uso: node scripts/oxxo-recuperar-pdf.js <ticketId>... | --faltantes');
    process.exit(1);
  }
  console.log(`🎯 ${objetivos.length} ticket(s): ${objetivos.join(', ')}\n`);

  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error('BROWSERLESS_TOKEN no definido');

  for (const ticketId of objetivos) {
    const [[t]] = await db.query('SELECT id, comercio, ocr_json FROM tickets WHERE id = ?', [ticketId]);
    if (!t) { console.log(`⚠️ #${ticketId} no existe`); continue; }
    const [[f]] = await db.query('SELECT id, uuid, pdf_url, xml_url FROM facturas WHERE ticket_id = ?', [ticketId]);
    if (!f) { console.log(`⚠️ #${ticketId} no tiene factura registrada`); continue; }
    if (f.pdf_url) { console.log(`✔️ #${ticketId} ya tiene PDF`); continue; }

    let o = {}; try { o = JSON.parse(t.ocr_json || '{}'); } catch {}
    const contexto = {
      ticketId,
      folio: o.folio || o.idVenta,
      idVenta: o.idVenta || o.folio,
      // `totalDecimal` se le pasa tal cual a page.type(), así que TIENE que ser
      // string: con un Number revienta con "text is not iterable". Y con dos
      // decimales, que es como lo pide el formulario (622.50, no 622.5).
      totalDecimal: Number(o.total).toFixed(2),
      total: Number(o.total),
      fecha: o.fecha,
      fechaTicket: o.fecha,
      // El hook seleccionarFecha() lee `fechaDMY` (DD/MM/YYYY) para mover el
      // datepicker de PrimeFaces. Sin ese nombre exacto revienta con
      // "Cannot read properties of undefined (reading 'split')".
      fechaDMY: o.fecha,
      datos: o,
    };
    if (!contexto.fechaDMY || !/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(contexto.fechaDMY)) {
      console.log(`   ⚠️ fecha del ticket ausente o con formato raro (${contexto.fechaDMY}); la reimpresión la necesita en DD/MM/YYYY`);
      continue;
    }
    console.log(`── #${ticketId} · folio ${contexto.folio} · $${contexto.totalDecimal} · ${contexto.fecha}`);

    // OXXO va SIN stealth a propósito (ver CLAUDE.md): con stealth su JSF falla.
    const browser = await puppeteer.connect({
      browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}`,
    });
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1366, height: 900 });
      page.on('dialog', async (d) => { await d.accept().catch(() => {}); });

      const r = await hooks.reimprimir(page, contexto);
      console.log(`   resultado: ${JSON.stringify(r).slice(0, 200)}`);

      if (r && r.ok && (r.pdfUrl || r.xmlUrl)) {
        const sets = [], vals = [];
        if (r.pdfUrl) { sets.push('pdf_url = ?'); vals.push(r.pdfUrl); }
        if (r.xmlUrl && !f.xml_url) { sets.push('xml_url = ?'); vals.push(r.xmlUrl); }
        if (sets.length) {
          vals.push(f.id);
          await db.query(`UPDATE facturas SET ${sets.join(', ')} WHERE id = ?`, vals);
          console.log(`   ✅ guardado: ${r.pdfUrl || '(sin pdf)'}`);
        } else {
          console.log('   ⚠️ el portal no devolvió PDF');
        }
      } else {
        console.log('   ⚠️ no se pudo recuperar (revisa los screenshots de debug en R2)');
      }
    } catch (e) {
      console.log(`   ❌ ${e.message}`);
    } finally {
      await browser.close().catch(() => {});
    }
  }
  process.exit(0);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
