// Reintenta EN SERIE todos los tickets sin factura, insistiendo varias veces
// por ticket antes de darlo por perdido.
//
// Por qué en serie y no en paralelo: Browserless corta la sesión a los 60 s y
// además devuelve HTTP 429 si se abren varias a la vez con este plan. Ir de
// uno en uno es más lento pero es lo único que cierra facturas de verdad.
//
// Uso:
//   node scripts/reintentar-todos.js                 → todos los que faltan
//   node scripts/reintentar-todos.js 136 137 138     → solo esos
//   INTENTOS=3 node scripts/reintentar-todos.js      → nº de intentos por ticket
require('dotenv').config();
const db = require('../lib/db');
const { ejecutarFacturacion } = require('../lib/facturacion');

const INTENTOS = parseInt(process.env.INTENTOS || '2', 10);
const ESPERA_ENTRE_INTENTOS = parseInt(process.env.ESPERA || '20000', 10);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// Errores en los que insistir NO sirve de nada: el problema es el dato o el
// portal, no una falla transitoria. Reintentar solo quema sesiones.
const DEFINITIVOS = /captcha|ya (fue )?facturad|duplicad|vencid|no est[aá] dado de alta|c[oó]digo .*(inv[aá]lido|no lo reconoce)|sin portal|no reconoce NINGUNA/i;

(async () => {
  const idsArg = process.argv.slice(2).map((n) => parseInt(n, 10)).filter(Boolean);

  let objetivo;
  if (idsArg.length) {
    const [r] = await db.query(`SELECT id, user_id, comercio FROM tickets WHERE id IN (${idsArg.map(() => '?').join(',')}) ORDER BY id`, idsArg);
    objetivo = r;
  } else {
    const [r] = await db.query(`
      SELECT t.id, t.user_id, t.comercio
        FROM tickets t LEFT JOIN facturas f ON f.ticket_id = t.id
       WHERE f.id IS NULL AND t.status <> 'procesado'
       ORDER BY t.id`);
    objetivo = r;
  }

  console.log(`🔁 ${objetivo.length} ticket(s) a reintentar, hasta ${INTENTOS} intento(s) cada uno\n`);
  const informe = [];

  for (const t of objetivo) {
    console.log(`${'═'.repeat(72)}`);
    console.log(`#${t.id} ${String(t.comercio || '?').slice(0, 52)}`);
    console.log('═'.repeat(72));

    let resultado = null;
    for (let intento = 1; intento <= INTENTOS; intento++) {
      // Cada intento parte de cero: si el ticket quedó en 'error' o esperando
      // confirmación, la cola no lo tomaría.
      await db.query(
        "UPDATE tickets SET status='pendiente', error_msg=NULL, requiere_confirmacion=0, reintento_programado=NULL WHERE id=?",
        [t.id]
      );
      console.log(`  · intento ${intento}/${INTENTOS}`);
      try {
        await ejecutarFacturacion(t.id, t.user_id);
      } catch (e) {
        console.log(`    excepción: ${e.message.slice(0, 120)}`);
      }

      const [[d]] = await db.query('SELECT status, error_msg FROM tickets WHERE id=?', [t.id]);
      const [f] = await db.query('SELECT xml_url FROM facturas WHERE ticket_id=?', [t.id]);
      resultado = { status: d.status, error: d.error_msg || '', xml: f[0]?.xml_url || null };

      if (f.length) { console.log(`    ✅ FACTURADO — ${f[0].xml_url}`); break; }
      if (d.status === 'procesando_correo') { console.log('    📧 enviado, esperando CFDI por correo'); break; }
      console.log(`    ✖ ${String(d.error_msg || d.status).slice(0, 140)}`);

      if (DEFINITIVOS.test(String(d.error_msg || ''))) {
        console.log('    ⏹ error definitivo, no tiene sentido insistir');
        break;
      }
      if (intento < INTENTOS) await dormir(ESPERA_ENTRE_INTENTOS);
    }

    informe.push({ id: t.id, comercio: t.comercio, ...resultado });
    await dormir(4000); // respiro entre tickets para no chocar con el 429 de Browserless
  }

  console.log(`\n${'█'.repeat(72)}\nRESUMEN\n${'█'.repeat(72)}`);
  const ok = informe.filter((r) => r.xml);
  const correo = informe.filter((r) => !r.xml && r.status === 'procesando_correo');
  const fallo = informe.filter((r) => !r.xml && r.status !== 'procesando_correo');
  console.log(`✅ facturados: ${ok.length}   📧 esperando correo: ${correo.length}   ✖ sin cerrar: ${fallo.length}`);
  ok.forEach((r) => console.log(`  ✅ #${r.id} ${String(r.comercio).slice(0, 40)} → ${r.xml}`));
  correo.forEach((r) => console.log(`  📧 #${r.id} ${String(r.comercio).slice(0, 40)}`));
  fallo.forEach((r) => console.log(`  ✖ #${r.id} ${String(r.comercio).slice(0, 36)} :: ${String(r.error).slice(0, 110)}`));
  process.exit(0);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
