// Vuelve a pasar por el OCR tickets que se leyeron ANTES de que su portal
// tuviera prompt propio. Generaliza scripts/releer-orler.js, que hacía lo mismo
// pero solo para Orler.
//
// Por qué hace falta: la Pasada 1 arma su prompt SOLO desde portales.json, así
// que un ticket leído cuando su portal no estaba dado de alta salió con el
// prompt genérico y le faltan los campos que ese portal exige. Pasó con Orler
// (sin carril), con FIARUM y con Puente Colorado (sin carril ni hora, y el
// folio del #390 con un dígito de menos: guardó 052080 y el ticket dice
// 0524080).
//
// Compara ANTES y AHORA y solo escribe si la relectura trae los campos
// obligatorios del portal (lib/vision.js → CAMPOS por portal). Si no, deja el
// ticket como estaba y lo dice.
//
// Uso:
//   node scripts/releer-ticket.js 390 396
//   node scripts/releer-ticket.js 390 --dry      (solo compara, no escribe)
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const db = require('../lib/db');
const { procesarImagenTicket } = require('../lib/vision');

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const IDS = args.map(Number).filter(Boolean);
if (!IDS.length) { console.error('uso: node scripts/releer-ticket.js <id> [id...] [--dry]'); process.exit(1); }

// Lo que cada portal necesita de verdad para que su bot pueda buscar el cruce.
const OBLIGATORIOS = {
  puentecolorado: ['folio', 'carril', 'fecha', 'hora'],
  fiarum: ['folio', 'carril', 'fecha'],
  orler: ['folio', 'carril', 'fecha'],
  pinfra: ['folio', 'carril', 'fecha', 'hora'],
};

(async () => {
  for (const id of IDS) {
    const [[t]] = await db.query('SELECT id, comercio, status, ruta_archivo, ocr_json FROM tickets WHERE id = ?', [id]);
    if (!t) { console.log(`#${id} no existe`); continue; }

    const r = await fetch(t.ruta_archivo);
    if (!r.ok) { console.log(`#${id} no se pudo bajar la foto (${r.status})`); continue; }
    const buf = Buffer.from(await r.arrayBuffer());

    let antes = {}; try { antes = JSON.parse(t.ocr_json || '{}'); } catch {}
    console.log(`\n#${id} ${t.comercio} [${t.status}]`);
    console.log(`  antes: portal=${antes.portal} folio=${antes.folio} carril=${antes.carril ?? '(no existía)'} hora=${antes.hora ?? '(no existía)'} $${antes.total}`);

    const res = await procesarImagenTicket(buf, 'image/jpeg');
    const d = res.datosOCR || {};
    const portal = res.portalDetectado;
    console.log(`  ahora: portal=${portal} folio=${d.folio} carril=${d.carril ?? 'NULL'} hora=${d.hora ?? 'NULL'} $${d.total} ${d.fecha} · confianza ${d.confianza}`);
    if (d.webId) console.log(`         webId=${d.webId}`);

    const faltan = (OBLIGATORIOS[portal] || []).filter((k) => d[k] === undefined || d[k] === null || d[k] === '');
    if (faltan.length) { console.log(`  ⚠️ la relectura sigue sin: ${faltan.join(', ')} — NO se toca el ticket`); continue; }
    if (DRY) { console.log('  (--dry) no se escribe'); continue; }

    const nuevo = { ...d, portal };
    await db.query(
      `UPDATE tickets SET ocr_json = ?, portal_url = COALESCE(?, portal_url),
                          requiere_confirmacion = ?, error_msg = NULL, reintento_programado = NULL
        WHERE id = ?`,
      [JSON.stringify(nuevo), d.portalUrl || null, res.requiereConfirmacion ? 1 : 0, id]);
    console.log(`  ✅ ocr_json actualizado (requiere_confirmacion=${res.requiereConfirmacion ? 1 : 0})`);
  }
  process.exit(0);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
