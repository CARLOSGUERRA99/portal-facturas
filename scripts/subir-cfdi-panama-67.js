/**
 * Sube el XML y PDF correctos de la factura Panama (ticket 67) a R2
 * y actualiza el registro en la BD.
 *
 * Uso: node scripts/subir-cfdi-panama-67.js
 */
require('dotenv').config();
const fs   = require('fs');
const path = require('path');

const XML_PATH = 'C:/Users/carlo/Downloads/GPR110128QD8-MW-129482.xml';
const PDF_PATH = 'C:/Users/carlo/Downloads/GPR110128QD8-MW-129482.pdf';
const TICKET_ID = 67;
const UUID      = '232e2a5c-cc11-4689-92bd-9a0fabc90d33';
const COMERCIO  = 'PASTELERIA PANAMA DE MAZATLAN S.A. DE C.V.';

async function main() {
  // Verificar que existen los archivos
  if (!fs.existsSync(XML_PATH)) { console.error('❌ XML no encontrado:', XML_PATH); process.exit(1); }
  if (!fs.existsSync(PDF_PATH)) { console.error('❌ PDF no encontrado:', PDF_PATH); process.exit(1); }

  const { subirArchivoR2 } = require('../storage/r2');
  const mysql = require('mysql2/promise');

  const xmlBuffer = fs.readFileSync(XML_PATH);
  const pdfBuffer = fs.readFileSync(PDF_PATH);

  console.log('📤 Subiendo XML a R2...');
  const xmlUrl = await subirArchivoR2(xmlBuffer, `facturas/panama_${UUID}.xml`, 'application/xml');
  console.log('✅ XML:', xmlUrl);

  console.log('📤 Subiendo PDF a R2...');
  const pdfUrl = await subirArchivoR2(pdfBuffer, `facturas/panama_${UUID}.pdf`, 'application/pdf');
  console.log('✅ PDF:', pdfUrl);

  // Conectar a BD
  const db = await mysql.createConnection({
    host:     process.env.DB_HOST,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    port:     parseInt(process.env.DB_PORT || '3306'),
    database: process.env.DB_DATABASE,
  });

  // Verificar si ya existe factura para este ticket
  const [rows] = await db.query('SELECT id, xml_url, pdf_url FROM facturas WHERE ticket_id = ?', [TICKET_ID]);
  if (rows.length > 0) {
    console.log(`📝 Factura existente (id=${rows[0].id}), actualizando URLs...`);
    console.log('   Antes xml_url:', rows[0].xml_url);
    console.log('   Antes pdf_url:', rows[0].pdf_url);
    await db.query(
      'UPDATE facturas SET xml_url = ?, pdf_url = ?, comercio = ?, status = "completado" WHERE ticket_id = ?',
      [xmlUrl, pdfUrl, COMERCIO, TICKET_ID]
    );
    console.log('✅ Factura actualizada');
  } else {
    // Obtener user_id del ticket
    const [[ticket]] = await db.query('SELECT user_id FROM tickets WHERE id = ?', [TICKET_ID]);
    await db.query(
      'INSERT INTO facturas (user_id, ticket_id, comercio, xml_url, pdf_url, status) VALUES (?, ?, ?, ?, ?, "completado")',
      [ticket.user_id, TICKET_ID, COMERCIO, xmlUrl, pdfUrl]
    );
    console.log('✅ Factura creada');
  }

  // Asegurar que el ticket quede en procesado
  await db.query('UPDATE tickets SET status = "procesado" WHERE id = ?', [TICKET_ID]);
  console.log('✅ Ticket 67 marcado como procesado');

  await db.end();
  console.log('\n🎉 Listo. Recarga Mis Facturas para ver el XML y PDF correctos.');
}

main().catch(err => { console.error('❌ Error:', err.message); process.exit(1); });
