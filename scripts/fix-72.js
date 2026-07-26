/**
 * Deja el ticket #72 (SushiO, vencido) en el estado correcto para solicitar la
 * factura por correo: corrige el código único real, marca ticket_vencido y
 * pre-carga el correo del comercio (caja@sushio.mx). Reporta si el usuario tiene
 * constancia (requerida para poder enviar la solicitud).
 * Uso: node scripts/fix-72.js
 */
require('dotenv').config();
const mysql = require('mysql2/promise');

async function main() {
  const db = await mysql.createConnection({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, port: parseInt(process.env.DB_PORT),
    database: process.env.DB_DATABASE, ssl: { rejectUnauthorized: false },
  });
  console.log('Conectado ✅\n');

  const [[row]] = await db.query(
    `SELECT t.id, t.status, t.ocr_json, t.email_contacto, t.solicitud_correo_enviada,
            u.id AS user_id, u.rfc, u.razon_social, u.email AS user_email, u.constancia_url
     FROM tickets t JOIN users u ON t.user_id = u.id WHERE t.id = 72`
  );
  if (!row) { console.log('#72 no existe'); await db.end(); return; }

  console.log('── ANTES ──');
  console.log('  status:          ', row.status);
  console.log('  email_contacto:  ', row.email_contacto || '(NULL)');
  console.log('  ocr_json:        ', row.ocr_json);
  console.log('  usuario RFC:     ', row.rfc || '(NULL)');
  console.log('  razón social:    ', row.razon_social || '(NULL)');
  console.log('  constancia_url:  ', row.constancia_url ? 'SÍ ✅' : 'NO ❌ (requerida para enviar la solicitud)');
  console.log('  solicitud_enviada:', row.solicitud_correo_enviada);

  // Corregir OCR: agregar el código único real y arreglar el año (2020 → 2026)
  let ocr = {};
  try { ocr = JSON.parse(row.ocr_json || '{}'); } catch {}
  ocr.referencia = '206197GVETHHC7';            // código único real (captura del usuario)
  if (ocr.fecha) ocr.fecha = ocr.fecha.replace(/\/20\d{2}$/, '/2026'); // corrige año mal leído
  const nuevoOcr = JSON.stringify(ocr);

  await db.query(
    `UPDATE tickets
       SET ocr_json = ?, email_contacto = 'caja@sushio.mx',
           error_msg = 'ticket_vencido', reintento_programado = NULL
     WHERE id = 72`,
    [nuevoOcr]
  );

  const [[after]] = await db.query(
    'SELECT status, error_msg, email_contacto, ocr_json, reintento_programado FROM tickets WHERE id = 72'
  );
  console.log('\n── DESPUÉS ──');
  console.log('  status:          ', after.status);
  console.log('  error_msg:       ', after.error_msg);
  console.log('  email_contacto:  ', after.email_contacto);
  console.log('  reintento:       ', after.reintento_programado ? new Date(after.reintento_programado).toISOString() : '(NULL → no reintenta)');
  console.log('  ocr_json:        ', after.ocr_json);
  console.log('\n✅ #72 listo. La ventana "Solicitar por correo" aparecerá pre-cargada con caja@sushio.mx.');

  await db.end();
}
main().catch(e => { console.error('❌', e.message); process.exit(1); });
