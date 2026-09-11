// Rescata CFDI de Little Caesars que SÍ se timbraron pero no llegaron a la BD.
//
// El alta terminó bien en el portal y el bot no supo leerlo: el ticket quedó
// como procesado sin factura (#220) o como error "ya fue facturado" (#227).
// La reimpresión —que no tiene reCAPTCHA— los encuentra por tienda + ticket +
// fecha + total, así que se pueden recuperar sin volver a facturar nada.
//
//   node scripts/lc-rescatar-cfdi.js               → simulacro de 218, 220, 227
//   node scripts/lc-rescatar-cfdi.js --aplicar     → escribe en R2 y BD
//   node scripts/lc-rescatar-cfdi.js 231 --aplicar → un ticket concreto
require('dotenv').config();
const db = require('../lib/db');
const { reimprimirLittleCaesars } = require('../bots/littlecaesars');
const { verificarCFDI } = require('../lib/cfdi');

const APLICAR = process.argv.includes('--aplicar');
const IDS = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number);
const OBJETIVO = IDS.length ? IDS : [218, 220, 227];

(async () => {
  console.log(APLICAR ? '⚠️  MODO APLICAR: se escribe en R2 y BD\n' : 'ℹ️  Simulacro (usa --aplicar para escribir)\n');

  for (const id of OBJETIVO) {
    const [[t]] = await db.query(
      `SELECT t.id, t.user_id, t.comercio, t.status, t.ocr_json,
              COALESCE(c.rfc, u.rfc) AS rfc
         FROM tickets t
         JOIN users u ON t.user_id = u.id
         LEFT JOIN clientes c ON c.id = u.cliente_id
        WHERE t.id = ?`, [id]);
    if (!t) { console.log(`#${id} — no existe\n`); continue; }

    const d = JSON.parse(t.ocr_json || '{}');
    console.log(`#${id} ${t.comercio} · tienda ${d.tienda} · ticket ${d.ticketNumero || d.folio} · ${d.fecha} · $${d.total}`);

    const [[ya]] = await db.query('SELECT id, uuid, xml_url FROM facturas WHERE ticket_id = ? ORDER BY id DESC LIMIT 1', [id]);
    if (ya?.uuid && ya?.xml_url && /r2|cloudflarestorage|pub-/.test(ya.xml_url)) {
      console.log(`   ya archivada (UUID ${ya.uuid}) — se salta\n`);
      continue;
    }

    const r = await reimprimirLittleCaesars({
      tienda: d.tienda, ticketNumero: d.ticketNumero || d.folio, fecha: d.fecha, total: d.total,
    });

    if (!r.ok) { console.log(`   ❌ ${r.msg}\n`); continue; }

    const problemas = verificarCFDI(r.cfdi, { rfcEsperado: t.rfc, totalEsperado: Number(d.total) || 0 });
    const graves = problemas.filter((p) => p.gravedad === 'grave');
    problemas.forEach((p) => console.log(`   ${p.gravedad === 'grave' ? '🛑' : '⚠️ '} ${p.msg}`));
    console.log(`   ✅ ${r.uuid} · ${r.cfdi.emisorNombre} · $${r.cfdi.total} · serie ${r.cfdi.serie || ''}${r.cfdi.folio || ''}`);
    console.log(`      XML ${r.xmlUrl}`);
    console.log(`      PDF ${r.pdfUrl || '(no se pudo bajar)'}`);

    if (graves.length) { console.log(`   🛑 con problemas graves: no se toca la BD\n`); continue; }
    // El simulacro sí archiva en R2 —la sesión de descarga dura poco y el
    // nombre es el UUID, así que repetirlo no duplica nada—, pero no toca la BD.
    if (!APLICAR) { console.log('   (simulacro: archivos en R2, BD sin tocar)\n'); continue; }

    const resumen = problemas.length ? problemas.map((p) => p.msg).join(' · ').slice(0, 500) : null;
    const campos = [r.pdfUrl, r.xmlUrl, 'completado', r.uuid, r.cfdi.receptorRfc, r.cfdi.emisorRfc,
      (r.cfdi.emisorNombre || '').slice(0, 255) || null, r.cfdi.total ?? null,
      `${r.cfdi.serie || ''}${r.cfdi.folio || ''}`.slice(0, 60) || null,
      r.cfdi.fechaTimbrado ? r.cfdi.fechaTimbrado.replace('T', ' ').slice(0, 19) : null, resumen];

    // Si ya hay fila se actualiza — hay UNIQUE por ticket_id, e insertar
    // revienta. Vale tanto para la fila vacía que dejó el bot (#220) como para
    // la que quedó apuntando a una URL del portal que ya no sirve (#218).
    if (ya) {
      await db.query(
        `UPDATE facturas SET pdf_url=?, xml_url=?, status=?, uuid=?, receptor_rfc=?, emisor_rfc=?,
                emisor_nombre=?, total=?, serie_folio=?, fecha_timbrado=?, verificacion=?
          WHERE id = ?`, [...campos, ya.id]);
      console.log(`   💾 factura #${ya.id} completada`);
    } else {
      const [ins] = await db.query(
        `INSERT INTO facturas (user_id, ticket_id, comercio, pdf_url, xml_url, status, uuid, receptor_rfc,
                               emisor_rfc, emisor_nombre, total, serie_folio, fecha_timbrado, verificacion)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [t.user_id, id, t.comercio, ...campos]);
      console.log(`   💾 factura #${ins.insertId} creada`);
    }

    await db.query("UPDATE tickets SET status='procesado', error_msg=NULL, reintento_programado=NULL WHERE id=?", [id]);
    console.log(`   💾 ticket #${id} → procesado\n`);
  }

  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
