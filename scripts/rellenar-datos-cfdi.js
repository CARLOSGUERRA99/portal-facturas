// Rellena las columnas nuevas de `facturas` (uuid, receptor, emisor, total,
// serie-folio, fecha de timbrado) leyendo los XML que ya están en R2.
//
// Se ejecuta una vez, para las facturas anteriores a que el pipeline empezara a
// verificar el CFDI al guardarlo. De aquí en adelante lo hace lib/facturacion.js.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const db = require('../lib/db');
const { leerCFDI, verificarCFDI } = require('../lib/cfdi');

(async () => {
  const [filas] = await db.query(`
    SELECT f.id, f.xml_url, f.user_id, f.ticket_id,
           COALESCE(c.rfc, u.rfc) AS rfc, t.ocr_json
      FROM facturas f
      LEFT JOIN users    u ON u.id = f.user_id
      LEFT JOIN clientes c ON c.id = u.cliente_id
      LEFT JOIN tickets  t ON t.id = f.ticket_id
     WHERE f.xml_url IS NOT NULL AND f.uuid IS NULL
     ORDER BY f.id`);

  console.log(`${filas.length} facturas por rellenar\n`);
  let hechas = 0, fallidas = 0;

  for (const f of filas) {
    const r = await fetch(f.xml_url).catch(() => null);
    if (!r?.ok) { console.log(`  ✗ #${f.id} XML inaccesible`); fallidas++; continue; }
    const d = leerCFDI(Buffer.from(await r.arrayBuffer()));
    if (!d) { console.log(`  ✗ #${f.id} XML ilegible`); fallidas++; continue; }

    let totalTicket = 0;
    try { totalTicket = Number(JSON.parse(f.ocr_json || '{}').total) || 0; } catch {}
    const probs = verificarCFDI(d, { rfcEsperado: f.rfc, totalEsperado: totalTicket });

    await db.query(
      `UPDATE facturas SET uuid=?, receptor_rfc=?, emisor_rfc=?, emisor_nombre=?, total=?,
                           serie_folio=?, fecha_timbrado=?, verificacion=? WHERE id=?`,
      [d.uuid, d.receptorRfc, d.emisorRfc, (d.emisorNombre || '').slice(0, 255) || null, d.total,
       `${d.serie || ''}${d.folio || ''}`.slice(0, 60) || null,
       d.fechaTimbrado ? d.fechaTimbrado.replace('T', ' ').slice(0, 19) : null,
       probs.length ? probs.map((p) => p.msg).join(' · ').slice(0, 500) : null,
       f.id]);

    hechas++;
    process.stdout.write(probs.length ? '!' : '.');
  }

  console.log(`\n\n${hechas} rellenadas · ${fallidas} sin poder leer`);
  const [[s]] = await db.query('SELECT COUNT(*) n, COUNT(uuid) con_uuid, COUNT(verificacion) con_aviso FROM facturas');
  console.log(`total ${s.n} · con UUID ${s.con_uuid} · con aviso ${s.con_aviso}`);
  process.exit(0);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
