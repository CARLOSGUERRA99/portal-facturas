// Muestra los datos fiscales del RECEPTOR que el pipeline le pasaria al bot
// para unos tickets dados — la misma consulta que hace lib/facturacion.js, con
// el COALESCE contra `users` para logins sin cliente asignado.
//
// Sirve para no timbrar con datos inventados: el codigo postal tiene que ser el
// del domicilio fiscal registrado en el SAT o el CFDI sale mal y no hay deshacer.
//
// Uso: node scripts/_ver-fiscales.js 391 394 316
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const db = require('../lib/db');

(async () => {
  const ids = process.argv.slice(2).map(Number).filter(Boolean);
  if (!ids.length) { console.log('Uso: node scripts/_ver-fiscales.js <id> [id...]'); process.exit(1); }

  const [rows] = await db.query(
    `SELECT t.id, t.status, t.comercio, t.portal_url, t.reintento_programado, t.error_msg,
            COALESCE(c.rfc,            u.rfc)            AS rfc,
            COALESCE(c.razon_social,   u.razon_social)   AS razon_social,
            COALESCE(c.codigo_postal,  u.codigo_postal)  AS codigo_postal,
            COALESCE(c.regimen_fiscal, u.regimen_fiscal) AS regimen_fiscal,
            COALESCE(c.uso_cfdi,       u.uso_cfdi)       AS uso_cfdi,
            u.email, c.nombre AS cliente
     FROM tickets t
     JOIN users u ON t.user_id = u.id
     LEFT JOIN clientes c ON c.id = u.cliente_id
     WHERE t.id IN (${ids.map(() => '?').join(',')})
     ORDER BY t.id`, ids);

  for (const r of rows) {
    console.log('─'.repeat(72));
    for (const [k, v] of Object.entries(r)) {
      if (v !== null && v !== '') console.log(`  ${k}: ${String(v).slice(0, 200)}`);
    }
  }
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
