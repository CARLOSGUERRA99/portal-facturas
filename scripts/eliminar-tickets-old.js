require('dotenv').config();
const mysql = require('mysql2/promise');

const IDS = [72, 87, 88, 89, 91, 92, 95];

async function main() {
  const db = await mysql.createConnection({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, port: parseInt(process.env.DB_PORT),
    database: process.env.DB_DATABASE, ssl: { rejectUnauthorized: false },
  });
  console.log('Conectado ✅\n');

  // Borrar intentos primero (FK)
  const [r1] = await db.query('DELETE FROM ticket_intentos WHERE ticket_id IN (?)', [IDS]);
  console.log(`🗑️  ticket_intentos eliminados: ${r1.affectedRows}`);

  // Borrar facturas asociadas
  const [r2] = await db.query('DELETE FROM facturas WHERE ticket_id IN (?)', [IDS]);
  console.log(`🗑️  facturas eliminadas: ${r2.affectedRows}`);

  // Borrar tickets
  const [r3] = await db.query('DELETE FROM tickets WHERE id IN (?)', [IDS]);
  console.log(`🗑️  tickets eliminados: ${r3.affectedRows}`);

  console.log('\n✅ Limpio. IDs eliminados:', IDS.join(', '));
  await db.end();
}
main().catch(e => { console.error('❌', e.message); process.exit(1); });
