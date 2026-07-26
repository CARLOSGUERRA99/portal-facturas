/**
 * Script temporal: resetear tickets en error a pendiente_confirmacion
 * Equivalente a POST /api/admin/tickets/:id/resetear pero sin sesion admin.
 * Uso: node scripts/reset-error-tickets.js
 */
require('dotenv').config();
const mysql = require('mysql2/promise');

// Tickets a resetear — elegidos por tener fix disponible
// Excluidos: #95 (arco 26/04, ticket vencido >30d), #87 TUFESA, #89 LC, #72 SushiO 2020
const TICKETS_A_RESETEAR = [88, 91, 90, 92, 93];

async function main() {
  const db = await mysql.createConnection({
    host:     process.env.DB_HOST,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    port:     parseInt(process.env.DB_PORT),
    database: process.env.DB_DATABASE,
    ssl:      { rejectUnauthorized: false },
  });

  console.log('Conectado a Railway MySQL ✅');

  for (const id of TICKETS_A_RESETEAR) {
    const [[ticket]] = await db.query(
      'SELECT id, status, comercio, error_msg FROM tickets WHERE id = ?',
      [id]
    );
    if (!ticket) {
      console.log(`  #${id} — no encontrado`);
      continue;
    }
    if (ticket.status !== 'error') {
      console.log(`  #${id} ${ticket.comercio} — status es '${ticket.status}', se omite`);
      continue;
    }

    await db.query('DELETE FROM facturas WHERE ticket_id = ?', [id]);
    await db.query(
      "UPDATE tickets SET status='pendiente_confirmacion', error_msg=NULL, procesando_correo_desde=NULL, reintento_programado=NULL WHERE id=?",
      [id]
    );
    console.log(`  ✅ #${id} ${ticket.comercio} → pendiente_confirmacion  (era: ${(ticket.error_msg || '').slice(0, 80)})`);
  }

  await db.end();
  console.log('\nListo. Los tickets serán procesados en el próximo ciclo de procesarCola (cada 60s).');
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
