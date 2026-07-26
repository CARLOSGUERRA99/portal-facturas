/**
 * Script de diagnóstico: muestra error_msg de tickets y su historial en ticket_intentos.
 * Uso: node scripts/diag-errores.js
 */
require('dotenv').config();
const mysql = require('mysql2/promise');

const IDS = [101, 97, 95, 92, 91, 90, 89, 88, 87, 72];

async function main() {
  const db = await mysql.createConnection({
    host:     process.env.DB_HOST,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    port:     parseInt(process.env.DB_PORT),
    database: process.env.DB_DATABASE,
    ssl:      { rejectUnauthorized: false },
  });

  console.log('Conectado ✅\n');

  // Ver columnas de ticket_intentos
  const [cols] = await db.query("SHOW COLUMNS FROM ticket_intentos");
  console.log('Columnas ticket_intentos:', cols.map(c => c.Field).join(', '), '\n');

  for (const id of IDS) {
    const [[t]] = await db.query(
      'SELECT id, comercio, status, error_msg FROM tickets WHERE id = ?', [id]
    );
    if (!t) { console.log(`#${id} — no existe\n`); continue; }
    console.log(`━━━ #${id} ${t.comercio} [${t.status}]`);
    console.log(`    error_msg: ${t.error_msg || '(vacío)'}`);

    const [intentos] = await db.query(
      'SELECT * FROM ticket_intentos WHERE ticket_id = ? ORDER BY id DESC LIMIT 3', [id]
    );
    if (!intentos.length) { console.log('    (sin intentos registrados)\n'); continue; }
    for (const it of intentos) {
      const fecha = it.creado || it.created_at || it.fecha || '';
      const res = it.resultado || it.estado || it.status || '';
      const msg = it.mensaje || it.error || it.msg || it.detalle || '';
      console.log(`      · [${res}] ${String(msg).slice(0, 200)} ${fecha ? '(' + new Date(fecha).toISOString() + ')' : ''}`);
    }
    console.log('');
  }

  await db.end();
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
