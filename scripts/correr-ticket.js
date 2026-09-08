/**
 * Corre el pipeline REAL de facturación contra un ticket, desde la máquina local.
 *
 * Usa `ejecutarFacturacion()` — el mismo camino que sigue producción — para que
 * la prueba valga: renombra por UUID, verifica el CFDI contra el RFC/total
 * esperados, inserta en `facturas` y deja el ticket en 'procesado'.
 *
 * Debuggear así (con el .env local, contra el mismo Browserless y la misma BD)
 * da respuesta en un minuto; iterar con git push → Railway cuesta 2-10 min por
 * intento y a ciegas.
 *
 * Uso: node scripts/correr-ticket.js 273
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const ticketId = Number(process.argv[2]);
if (!ticketId) { console.error('Uso: node scripts/correr-ticket.js <ticketId>'); process.exit(1); }

(async () => {
  const db = require('../lib/db');
  const { ejecutarFacturacion } = require('../lib/facturacion');

  const [[t]] = await db.query('SELECT id, user_id, comercio, status, error_msg FROM tickets WHERE id = ?', [ticketId]);
  if (!t) { console.error(`No existe el ticket #${ticketId}`); process.exit(1); }

  console.log(`\n▶️  Ticket #${t.id} — ${t.comercio} (status actual: ${t.status})`);
  if (t.error_msg) console.log(`   Último error: ${String(t.error_msg).slice(0, 160)}`);
  console.log('─'.repeat(70));

  const t0 = Date.now();
  const res = await ejecutarFacturacion(t.id, t.user_id);
  console.log('─'.repeat(70));
  console.log(`⏱️  ${((Date.now() - t0) / 1000).toFixed(1)}s — resultado:`, JSON.stringify(res));

  const [[despues]] = await db.query('SELECT status, error_msg FROM tickets WHERE id = ?', [ticketId]);
  const [fact] = await db.query('SELECT id, uuid, total, xml_url FROM facturas WHERE ticket_id = ?', [ticketId]);
  console.log(`📌 Status final: ${despues.status}`);
  if (despues.error_msg) console.log(`   error_msg: ${despues.error_msg}`);
  if (fact.length) console.log(`🧾 Factura: uuid=${fact[0].uuid} total=${fact[0].total}\n   ${fact[0].xml_url}`);

  process.exit(0);
})().catch((e) => { console.error('❌', e); process.exit(1); });
