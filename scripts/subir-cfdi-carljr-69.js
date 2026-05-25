/**
 * Fix ticket #69 (Carl's Jr) — sube XML/PDF correctos a R2 y actualiza DB
 * Fix ticket #68 (OXXO)     — limpia factura incorrecta (era de ICR) y resetea a procesando_correo
 *
 * Uso: node scripts/subir-cfdi-carljr-69.js
 */
require('dotenv').config();
const fs   = require('fs');

const XML_PATH = 'C:/Users/carlo/Downloads/31e6880c-1ae7-49e4-ad32-16d4610786d1.xml';
const PDF_PATH = 'C:/Users/carlo/Downloads/31e6880c-1ae7-49e4-ad32-16d4610786d1.pdf';
const TICKET_ICR  = 69;
const TICKET_OXXO = 68;
const UUID        = '31e6880c-1ae7-49e4-ad32-16d4610786d1';
const COMERCIO    = 'ICR S.A. DE C.V.';

async function main() {
  if (!fs.existsSync(XML_PATH)) { console.error('❌ XML no encontrado:', XML_PATH); process.exit(1); }
  if (!fs.existsSync(PDF_PATH)) { console.error('❌ PDF no encontrado:', PDF_PATH); process.exit(1); }

  const { subirArchivoR2 } = require('../storage/r2');
  const mysql = require('mysql2/promise');

  const db = await mysql.createConnection({
    host:     process.env.DB_HOST,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    port:     parseInt(process.env.DB_PORT || '3306'),
    database: process.env.DB_DATABASE,
  });

  // ── 1. Subir archivos de ICR a R2 ─────────────────────────────────────
  console.log('📤 Subiendo XML a R2...');
  const xmlUrl = await subirArchivoR2(
    fs.readFileSync(XML_PATH),
    `facturas/carljr_${UUID}.xml`,
    'application/xml'
  );
  console.log('✅ XML:', xmlUrl);

  console.log('📤 Subiendo PDF a R2...');
  const pdfUrl = await subirArchivoR2(
    fs.readFileSync(PDF_PATH),
    `facturas/carljr_${UUID}.pdf`,
    'application/pdf'
  );
  console.log('✅ PDF:', pdfUrl);

  // ── 2. Limpiar factura incorrecta del ticket #68 (OXXO) ───────────────
  console.log('\n🧹 Limpiando factura incorrecta del ticket OXXO #68...');
  const [facOxxo] = await db.query('SELECT id, xml_url FROM facturas WHERE ticket_id = ?', [TICKET_OXXO]);
  if (facOxxo.length) {
    console.log(`   Factura incorrecta encontrada (id=${facOxxo[0].id}) — XML: ${facOxxo[0].xml_url}`);
    await db.query('DELETE FROM facturas WHERE ticket_id = ?', [TICKET_OXXO]);
    console.log('   ✅ Factura incorrecta eliminada');
  } else {
    console.log('   ℹ️  No había factura registrada para ticket #68');
  }

  // Resetear ticket #68 a procesando_correo para que espere el email de OXXO esta noche
  await db.query(
    "UPDATE tickets SET status = 'procesando_correo', procesando_correo_desde = NOW() WHERE id = ?",
    [TICKET_OXXO]
  );
  console.log('✅ Ticket OXXO #68 reseteado a procesando_correo');

  // ── 3. Crear/actualizar factura para ticket #69 (Carl's Jr) ───────────
  console.log('\n📝 Registrando factura correcta para ticket ICR #69...');
  const [facIcr] = await db.query('SELECT id FROM facturas WHERE ticket_id = ?', [TICKET_ICR]);

  const [[ticketIcr]] = await db.query('SELECT user_id FROM tickets WHERE id = ?', [TICKET_ICR]);

  if (facIcr.length) {
    await db.query(
      "UPDATE facturas SET xml_url = ?, pdf_url = ?, comercio = ?, status = 'completado' WHERE ticket_id = ?",
      [xmlUrl, pdfUrl, COMERCIO, TICKET_ICR]
    );
    console.log('✅ Factura actualizada para ticket #69');
  } else {
    await db.query(
      "INSERT INTO facturas (user_id, ticket_id, comercio, xml_url, pdf_url, status) VALUES (?, ?, ?, ?, ?, 'completado')",
      [ticketIcr.user_id, TICKET_ICR, COMERCIO, xmlUrl, pdfUrl]
    );
    console.log('✅ Factura creada para ticket #69');
  }

  await db.query("UPDATE tickets SET status = 'procesado' WHERE id = ?", [TICKET_ICR]);
  console.log('✅ Ticket ICR #69 marcado como procesado');

  await db.end();
  console.log('\n🎉 Listo.');
  console.log('   • Ticket #69 (Carl\'s Jr): ✅ procesado con archivos correctos');
  console.log('   • Ticket #68 (OXXO): 🕛 esperando correo de OXXO (job medianoche)');
}

main().catch(err => { console.error('❌ Error:', err.message); process.exit(1); });
