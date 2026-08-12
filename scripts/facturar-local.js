// Factura tickets concretos desde esta máquina, con el pipeline REAL
// (lib/facturacion.js → bots/ → R2 → BD de producción).
//
// Para qué: cuando Railway tiene despliegues encolados el worker está parado y
// los tickets se quedan quietos. Aquí hay .env con todas las credenciales, así
// que se puede facturar de verdad sin esperar al deploy.
//
// ⚠️ CARRERA CON EL WORKER. rescatarTicketsSinEncolar() del worker recoge todo
// lo que esté en 'pendiente_confirmacion' con requiere_confirmacion=0. Si el
// worker vuelve mientras esto corre, los dos facturarían el MISMO ticket y
// saldrían dos CFDI del mismo folio — que ya no se corrige, se cancela.
// Por eso el ticket se pone en 'procesando' ANTES de empezar: ese estado el
// rescate no lo mira. Si algo revienta, se devuelve a su estado anterior.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const db = require('../lib/db');
const { ejecutarFacturacion } = require('../lib/facturacion');

const IDS = process.argv.slice(2).map(Number).filter(Boolean);
if (!IDS.length) { console.error('uso: node scripts/facturar-local.js 207 208 …'); process.exit(1); }

(async () => {
  for (const id of IDS) {
    const [[t]] = await db.query('SELECT id, user_id, comercio, status, ocr_json FROM tickets WHERE id = ?', [id]);
    if (!t) { console.log(`#${id} no existe`); continue; }
    if (t.status === 'procesado') { console.log(`#${id} ya está facturado — se salta`); continue; }

    let j = {}; try { j = JSON.parse(t.ocr_json || '{}'); } catch {}
    console.log(`\n${'═'.repeat(62)}\n#${id} ${t.comercio} · ${j.portal} · $${j.total} · ${j.fecha}`);

    const estadoPrevio = t.status;
    await db.query("UPDATE tickets SET status = 'procesando' WHERE id = ?", [id]);

    const t0 = Date.now();
    let r;
    try {
      r = await ejecutarFacturacion(id, t.user_id);
    } catch (e) {
      await db.query('UPDATE tickets SET status = ? WHERE id = ?', [estadoPrevio, id]);
      console.log(`  💥 excepción: ${e.message} — devuelto a '${estadoPrevio}'`);
      continue;
    }

    const [[fin]] = await db.query('SELECT status, error_msg FROM tickets WHERE id = ?', [id]);
    // ejecutarFacturacion deja el estado final. Si lo dejó en 'procesando' es
    // que salió por un camino que no lo toca: se devuelve para que no se quede
    // invisible para la cola.
    if (fin.status === 'procesando') await db.query('UPDATE tickets SET status = ? WHERE id = ?', [estadoPrevio, id]);

    console.log(`  ⏱️  ${((Date.now() - t0) / 1000).toFixed(1)}s → ${r?.ok ? '✅ FACTURADO' : `❌ ${r?.error_code || ''} ${r?.msg || ''}`}`);
    console.log(`  estado final: ${fin.status}${fin.error_msg ? ` — ${fin.error_msg.slice(0, 160)}` : ''}`);
  }
  process.exit(0);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
