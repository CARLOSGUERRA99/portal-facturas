// Vuelve a pasar por el OCR los tickets de Orler que se leyeron ANTES de que
// existiera su prompt (los #207/#229/#230 salieron sin el CARRIL, que el portal
// exige). Reescribe su ocr_json y los devuelve a la cola.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const db = require('../lib/db');
const { procesarImagenTicket } = require('../lib/vision');

const IDS = process.argv.slice(2).map(Number).filter(Boolean);
if (!IDS.length) { console.error('uso: node scripts/releer-orler.js 207 229 230'); process.exit(1); }

(async () => {
  for (const id of IDS) {
    const [[t]] = await db.query('SELECT id, comercio, ruta_archivo, ocr_json FROM tickets WHERE id = ?', [id]);
    if (!t) { console.log(`#${id} no existe`); continue; }

    const r = await fetch(t.ruta_archivo);
    if (!r.ok) { console.log(`#${id} no se pudo bajar la foto (${r.status})`); continue; }
    const buf = Buffer.from(await r.arrayBuffer());

    console.log(`\n#${id} ${t.comercio}`);
    let antes = {}; try { antes = JSON.parse(t.ocr_json || '{}'); } catch {}
    console.log(`  antes: portal=${antes.portal} folio=${antes.folio} carril=${antes.carril ?? '(no existía)'}`);

    const res = await procesarImagenTicket(buf, 'image/jpeg');
    const d = res.datosOCR || {};
    console.log(`  ahora: portal=${res.portalDetectado} folio=${d.folio} carril=${d.carril ?? 'NULL'} $${d.total} ${d.fecha} · confianza ${d.confianza}`);

    if (!d.carril) { console.log('  ⚠️ sigue sin carril — NO se toca el ticket'); continue; }

    const nuevo = { ...d, portal: res.portalDetectado };
    await db.query(
      `UPDATE tickets SET ocr_json = ?, status = 'pendiente', requiere_confirmacion = ?,
                          error_msg = NULL, reintento_programado = NULL WHERE id = ?`,
      [JSON.stringify(nuevo), res.requiereConfirmacion ? 1 : 0, id]
    );
    console.log(`  ✅ actualizado y devuelto a la cola (requiere_confirmacion=${res.requiereConfirmacion})`);
  }
  process.exit(0);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
