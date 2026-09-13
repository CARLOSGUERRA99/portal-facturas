// Devuelve a 'pendiente_confirmacion' un ticket que quedó atascado en
// 'procesando_correo' por un FALSO POSITIVO del bot — es decir, cuando el bot
// dio la factura por generada y en realidad no se emitió nada.
//
// Existe porque el MCP `resetear_ticket` solo actúa sobre status 'error': un
// ticket en 'procesando_correo' lleva el sello "FACTURA GENERADA … NO
// RELANZAR" y a propósito no se toca, para no emitir un CFDI duplicado.
//
// ⚠️ ÚSALO SOLO CON PRUEBA de que NO se timbró (el screenshot de la corrida
// mostrando que el portal seguía pidiendo el botón de emitir). Si la factura sí
// se generó, lo correcto es recuperarla con su folio/UUID, NO relanzar.
//
// Uso: node scripts/_destrabar-ticket.js 391
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const db = require('../lib/db');

(async () => {
  const id = Number(process.argv[2]);
  if (!id) { console.log('Uso: node scripts/_destrabar-ticket.js <ticketId>'); process.exit(1); }

  const [[antes]] = await db.query('SELECT id, status, error_msg, requiere_confirmacion FROM tickets WHERE id = ?', [id]);
  if (!antes) { console.log(`No existe el ticket #${id}`); process.exit(1); }

  console.log(`Antes  → status=${antes.status} | requiere_confirmacion=${antes.requiere_confirmacion}`);
  console.log(`         error_msg: ${String(antes.error_msg || '').slice(0, 160)}`);

  const [fact] = await db.query('SELECT id, uuid FROM facturas WHERE ticket_id = ?', [id]);
  if (fact.length) {
    console.log(`\n⛔ ABORTADO: el ticket #${id} YA tiene factura registrada (uuid=${fact[0].uuid}). No se destraba.`);
    process.exit(1);
  }

  await db.query(
    `UPDATE tickets
        SET status = 'pendiente_confirmacion', requiere_confirmacion = 0,
            error_msg = NULL, procesando_correo_desde = NULL, reintento_programado = NULL
      WHERE id = ?`, [id]);

  const [[despues]] = await db.query('SELECT id, status, error_msg, requiere_confirmacion FROM tickets WHERE id = ?', [id]);
  console.log(`Después → status=${despues.status} | requiere_confirmacion=${despues.requiere_confirmacion} | error_msg=${despues.error_msg}`);
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
