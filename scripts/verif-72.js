/**
 * Verificación READ-ONLY del fix SushiO para el ticket #72.
 * Muestra status, error_msg, email_contacto, flags de solicitud y últimos intentos.
 * Uso: node scripts/verif-72.js
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

  const [[t]] = await db.query(
    `SELECT id, comercio, status, error_msg, email_contacto,
            solicitud_correo_enviada, solicitud_correo_error, reintento_programado
     FROM tickets WHERE id = 72`
  );
  if (!t) { console.log('#72 no existe'); await db.end(); return; }

  console.log(`━━━ #72 ${t.comercio} [${t.status}]`);
  console.log(`    error_msg:            ${t.error_msg || '(vacío)'}`);
  console.log(`    email_contacto:       ${t.email_contacto || '(NULL)'}`);
  console.log(`    solicitud_enviada:    ${t.solicitud_correo_enviada}`);
  console.log(`    solicitud_error:      ${t.solicitud_correo_error || '(NULL)'}`);
  console.log(`    reintento_programado: ${t.reintento_programado ? new Date(t.reintento_programado).toISOString() : '(NULL → no reintenta)'}`);

  const [intentos] = await db.query(
    'SELECT * FROM ticket_intentos WHERE ticket_id = 72 ORDER BY id DESC LIMIT 5'
  ).catch(() => [[]]);
  console.log(`\n    ÚLTIMOS INTENTOS:`);
  for (const it of (intentos || [])) {
    const fecha = it.creado || it.created_at || it.fecha || '';
    const res = it.resultado || it.estado || it.status || '';
    const msg = it.mensaje || it.error || it.msg || it.detalle || '';
    console.log(`      · [${res}] ${String(msg).slice(0, 170)} ${fecha ? '(' + new Date(fecha).toISOString() + ')' : ''}`);
  }

  await db.end();
}
main().catch(e => { console.error('❌', e.message); process.exit(1); });
