// Runner genérico: pasa uno o varios tickets por la MISMA ruta que usa
// producción (lib/facturacion.ejecutarFacturacion), en vez de escribir un
// script ad-hoc por portal como se venía haciendo.
//
// Uso:
//   node scripts/facturar-ticket.js 164
//   node scripts/facturar-ticket.js 164 157 170
//
// Ventaja sobre los scripts ad-hoc: lo que se prueba aquí es exactamente lo
// que va a correr en Railway — mismo routing, mismo gate, mismo manejo de
// error_code. Si funciona aquí, funciona en producción.
require('dotenv').config();
const db = require('../lib/db');
const { ejecutarFacturacion } = require('../lib/facturacion');

(async () => {
  const ids = process.argv.slice(2).map((n) => parseInt(n, 10)).filter(Boolean);
  if (!ids.length) { console.error('uso: node scripts/facturar-ticket.js <id> [id...]'); process.exit(1); }

  for (const id of ids) {
    const [[t]] = await db.query('SELECT id, user_id, comercio, status FROM tickets WHERE id=?', [id]);
    if (!t) { console.log(`\n#${id} ❌ no existe`); continue; }

    console.log(`\n${'═'.repeat(70)}`);
    console.log(`#${t.id} ${String(t.comercio).slice(0, 50)} [${t.status}]`);
    console.log('═'.repeat(70));
    try {
      await ejecutarFacturacion(t.id, t.user_id);
    } catch (e) {
      console.log(`   ❌ excepción: ${e.message}`);
    }

    const [[d]] = await db.query('SELECT status, error_msg FROM tickets WHERE id=?', [id]);
    const [f] = await db.query('SELECT xml_url, pdf_url FROM facturas WHERE ticket_id=?', [id]);
    console.log(`   → status: ${d.status}${d.error_msg ? ' | ' + String(d.error_msg).slice(0, 140) : ''}`);
    if (f.length) console.log(`   → ✅ factura: ${f[0].xml_url}`);
  }
  process.exit(0);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
