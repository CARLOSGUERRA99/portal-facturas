// Lista los tickets pendientes de un usuario o cliente, buscando por nombre,
// correo o razon social. Sirve para responder "que le falta por timbrar a X".
//
// El portal es multicliente (es de Servicios Administrativos G&A, no de GPN):
// cada `users.cliente_id` apunta a un contribuyente distinto, asi que "los
// tickets de fulano" hay que resolverlos contra la BD, no suponerlos.
//
// Uso: node scripts/_ver-tickets-usuario.js "luis miguel"
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const db = require('../lib/db');

(async () => {
  const q = (process.argv.slice(2).join(' ') || '').trim();
  if (!q) { console.log('Uso: node scripts/_ver-tickets-usuario.js "<nombre|correo|razon social>"'); process.exit(1); }
  const like = `%${q}%`;

  const [usuarios] = await db.query(
    `SELECT u.id, u.nombre, u.email, u.cliente_id, c.nombre AS cliente, c.rfc, c.razon_social
       FROM users u LEFT JOIN clientes c ON c.id = u.cliente_id
      WHERE u.nombre LIKE ? OR u.email LIKE ? OR c.nombre LIKE ? OR c.razon_social LIKE ?`,
    [like, like, like, like]);

  if (!usuarios.length) {
    console.log(`Sin coincidencias para "${q}". Usuarios en el sistema:`);
    const [todos] = await db.query('SELECT u.id, u.nombre, u.email, c.nombre AS cliente FROM users u LEFT JOIN clientes c ON c.id = u.cliente_id ORDER BY u.id');
    for (const u of todos) console.log(`  #${u.id} ${u.nombre || '(sin nombre)'} · ${u.email} · cliente: ${u.cliente || '(ninguno)'}`);
    process.exit(0);
  }

  for (const u of usuarios) {
    console.log('═'.repeat(74));
    console.log(`Usuario #${u.id} — ${u.nombre || '(sin nombre)'} · ${u.email}`);
    console.log(`Cliente: ${u.cliente || '(ninguno)'} · RFC ${u.rfc || '—'}`);

    const [t] = await db.query(
      `SELECT id, status, comercio, portal_url, creado,
              JSON_UNQUOTE(JSON_EXTRACT(ocr_json,'$.portal')) AS portal,
              JSON_UNQUOTE(JSON_EXTRACT(ocr_json,'$.folio'))  AS folio,
              JSON_UNQUOTE(JSON_EXTRACT(ocr_json,'$.fecha'))  AS fecha,
              JSON_UNQUOTE(JSON_EXTRACT(ocr_json,'$.total'))  AS total,
              LEFT(COALESCE(error_msg,''), 90) AS error
         FROM tickets WHERE user_id = ? AND status <> 'procesado'
        ORDER BY FIELD(status,'error','pendiente_confirmacion','procesando','procesando_correo','pendiente'), id`,
      [u.id]);

    const [[hechos]] = await db.query("SELECT COUNT(*) n FROM tickets WHERE user_id = ? AND status = 'procesado'", [u.id]);
    console.log(`Timbrados: ${hechos.n} · Pendientes: ${t.length}\n`);

    let suma = 0;
    for (const r of t) {
      suma += parseFloat(r.total) || 0;
      console.log(`  #${r.id} [${r.status}] ${String(r.comercio || '').slice(0, 46)}`);
      console.log(`      portal=${r.portal || '—'} folio=${r.folio || '—'} fecha=${r.fecha || '—'} total=${r.total || '—'}`);
      if (r.error) console.log(`      ${r.error}`);
    }
    if (t.length) console.log(`\n  Suma pendiente: $${suma.toFixed(2)}`);
  }
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
