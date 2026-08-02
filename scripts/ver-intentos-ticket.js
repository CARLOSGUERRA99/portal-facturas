// Muestra el historial REAL de intentos de facturación de un ticket.
//
// Hace falta porque `tickets.error_msg` NO siempre guarda el motivo: las rutas
// de "error genérico" y del catch en lib/facturacion.js ponen status='error'
// sin escribir el mensaje, así que el ticket queda en error "sin motivo". El
// motivo sí queda en `ticket_intentos`, que además sobrevive al borrado del
// ticket. Esta es la única forma de saber por qué falló algo ya borrado.
//
// Uso: node scripts/ver-intentos-ticket.js 142
//      node scripts/ver-intentos-ticket.js autozone   → por nombre de bot
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const db = require('../lib/db');

(async () => {
  const arg = process.argv[2];
  if (!arg) { console.error('uso: node scripts/ver-intentos-ticket.js <id | nombre-de-bot>'); process.exit(1); }

  const esId = /^\d+$/.test(arg);
  const [filas] = esId
    ? await db.query(
        `SELECT id, ticket_id, bot, resultado, mensaje, duracion_ms, creado
           FROM ticket_intentos WHERE ticket_id = ? ORDER BY id`, [arg])
    : await db.query(
        `SELECT id, ticket_id, bot, resultado, mensaje, duracion_ms, creado
           FROM ticket_intentos WHERE bot LIKE ? ORDER BY id DESC LIMIT 25`, [`%${arg}%`]);

  if (!filas.length) { console.log(`sin intentos registrados para "${arg}"`); process.exit(0); }

  console.log(`${filas.length} intento(s) para "${arg}":\n`);
  for (const r of filas) {
    const seg = r.duracion_ms != null ? `${(r.duracion_ms / 1000).toFixed(1)}s` : '—';
    console.log(`#${r.ticket_id}  ${new Date(r.creado).toISOString().slice(0, 16).replace('T', ' ')}  bot=${r.bot}  ${r.resultado}  (${seg})`);
    console.log(`   ${r.mensaje || '(sin mensaje)'}\n`);
  }
  process.exit(0);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
