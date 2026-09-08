/**
 * Asocia un CFDI (XML+PDF ya descargados a mano) a su ticket: sube los archivos
 * a R2, registra la factura y deja el ticket en 'procesado'.
 *
 * Versión genérica del viejo scripts/asociar-cfdi-274.js — sirve para cualquier
 * ticket, no solo el de Carl's Jr.
 *
 * Verifica ANTES de escribir que el XML corresponda de verdad al ticket:
 * compara el TOTAL del comprobante contra el del ticket y el RFC del receptor.
 *
 * Uso:
 *   node scripts/asociar-cfdi.js <ticketId> <ruta.xml> <ruta.pdf> [--dry]
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const [, , ticketIdArg, xmlPath, pdfPath] = process.argv;
const DRY = process.argv.includes('--dry');
const TICKET_ID = Number(ticketIdArg);

function campo(xml, re) { return (xml.match(re) || [])[1] || null; }

async function main() {
  if (!TICKET_ID || !xmlPath) {
    console.error('Uso: node scripts/asociar-cfdi.js <ticketId> <ruta.xml> [ruta.pdf] [--dry]');
    process.exit(1);
  }
  for (const p of [xmlPath, pdfPath].filter(Boolean)) {
    if (!fs.existsSync(p)) { console.error('❌ No encontrado:', p); process.exit(1); }
  }

  const xml = fs.readFileSync(xmlPath, 'utf8');
  const uuid = (campo(xml, /UUID="([^"]+)"/) || '').toLowerCase();
  const total = parseFloat(campo(xml, /[\s"]Total="([^"]+)"/) || '0');
  const receptor = campo(xml, /Receptor[^>]*Rfc="([^"]+)"/) || campo(xml, /Rfc="(G[^"]+)"/);
  const emisorRfc = campo(xml, /Emisor[^>]*Rfc="([^"]+)"/);
  const emisorNombre = campo(xml, /Emisor[^>]*Nombre="([^"]+)"/) || '';
  const serie = campo(xml, /Serie="([^"]+)"/) || '';
  const folio = campo(xml, /Folio="([^"]+)"/) || '';
  const fechaTimbrado = (campo(xml, /FechaTimbrado="([^"]+)"/) || '').replace('T', ' ').slice(0, 19);

  if (!uuid) { console.error('❌ El XML no trae UUID (¿está timbrado?)'); process.exit(1); }

  const db = require('../lib/db');
  const [[ticket]] = await db.query('SELECT id, user_id, comercio, ocr_json, status FROM tickets WHERE id = ?', [TICKET_ID]);
  if (!ticket) { console.error('❌ Ticket', TICKET_ID, 'no existe'); process.exit(1); }

  let datos = {}; try { datos = JSON.parse(ticket.ocr_json || '{}'); } catch {}
  const totalTicket = Number(datos.total) || 0;

  console.log(`Ticket #${TICKET_ID} — ${ticket.comercio} (${ticket.status})`);
  console.log(`  CFDI: ${serie}-${folio} | UUID ${uuid}`);
  console.log(`  Total CFDI: $${total}  vs  total del ticket: $${totalTicket}`);
  console.log(`  Emisor: ${emisorRfc} ${emisorNombre} | Receptor: ${receptor}`);

  // Comprobaciones antes de tocar nada: un CFDI asociado al ticket equivocado
  // es peor que no tenerlo, porque nadie lo vuelve a revisar.
  if (totalTicket && Math.abs(total - totalTicket) > 0.5) {
    console.error(`❌ El total del CFDI ($${total}) no cuadra con el del ticket ($${totalTicket}). Abortado.`);
    process.exit(1);
  }
  const [yaUsado] = await db.query('SELECT ticket_id FROM facturas WHERE uuid = ? AND ticket_id <> ?', [uuid.toUpperCase(), TICKET_ID]);
  if (yaUsado.length) {
    console.error(`❌ Ese UUID ya está asociado al ticket #${yaUsado[0].ticket_id}. Abortado.`);
    process.exit(1);
  }
  console.log('✅ Verificaciones OK');
  if (DRY) { console.log('🧪 --dry: no se sube nada ni se toca la BD.'); process.exit(0); }

  const { subirArchivoR2 } = require('../storage/r2');
  const xmlUrl = await subirArchivoR2(fs.readFileSync(xmlPath), `facturas/${uuid}.xml`, 'application/xml');
  const pdfUrl = pdfPath ? await subirArchivoR2(fs.readFileSync(pdfPath), `facturas/${uuid}.pdf`, 'application/pdf') : null;

  const [existente] = await db.query('SELECT id FROM facturas WHERE ticket_id = ?', [TICKET_ID]);
  const valores = [xmlUrl, pdfUrl, (ticket.comercio || '').slice(0, 50), uuid.toUpperCase(), receptor,
                   emisorRfc, emisorNombre.slice(0, 255), total, `${serie}-${folio}`.slice(0, 60), fechaTimbrado || null];
  if (existente.length) {
    await db.query(
      `UPDATE facturas SET xml_url=?, pdf_url=?, comercio=?, status='completado', uuid=?,
       receptor_rfc=?, emisor_rfc=?, emisor_nombre=?, total=?, serie_folio=?, fecha_timbrado=? WHERE id=?`,
      [...valores, existente[0].id]);
    console.log(`✅ Factura actualizada (id=${existente[0].id})`);
  } else {
    const [res] = await db.query(
      `INSERT INTO facturas (user_id, ticket_id, xml_url, pdf_url, comercio, status, uuid,
       receptor_rfc, emisor_rfc, emisor_nombre, total, serie_folio, fecha_timbrado)
       VALUES (?,?,?,?,?,'completado',?,?,?,?,?,?,?)`,
      [ticket.user_id, TICKET_ID, ...valores.slice(0, 2), valores[2], ...valores.slice(3)]);
    console.log(`✅ Factura creada (id=${res.insertId})`);
  }

  await db.query("UPDATE tickets SET status='procesado', error_msg=NULL, reintento_programado=NULL WHERE id=?", [TICKET_ID]);
  console.log(`✅ Ticket #${TICKET_ID} → procesado`);
  console.log(`   ${xmlUrl}`);
  process.exit(0);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
