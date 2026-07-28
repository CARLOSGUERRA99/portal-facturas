require('dotenv').config();
const db = require('../lib/db');

(async () => {
  const [ticketsCols] = await db.query('DESCRIBE tickets');
  console.log('=== tickets ===');
  console.log(JSON.stringify(ticketsCols, null, 2));

  const [facturasCols] = await db.query('DESCRIBE facturas');
  console.log('\n=== facturas ===');
  console.log(JSON.stringify(facturasCols, null, 2));

  const [u] = await db.query('SELECT id, email FROM usuarios LIMIT 5').catch(async () => {
    return db.query('SHOW TABLES').then(([rows]) => { console.log('No hay tabla usuarios; tablas:', rows); return [[]]; });
  });
  console.log('\n=== usuarios (muestra) ===');
  console.log(JSON.stringify(u, null, 2));

  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
