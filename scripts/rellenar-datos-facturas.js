/**
 * Rellena los datos fiscales (uuid, total, emisor, receptor, serie/folio, fecha
 * de timbrado) de las filas de `facturas` que se guardaron solo con las URLs.
 *
 * Por qué existen esas filas: scripts/reconciliar-correo.js insertaba únicamente
 * ticket_id + urls. El XML estaba correctamente subido a R2, pero las columnas
 * quedaban NULL, así que cualquier consulta o reporte por UUID, por emisor o por
 * importe no encontraba esas facturas. No se perdió nada — el dato siempre
 * estuvo dentro del XML —, pero había que ir a leerlo a mano.
 *
 * Lee el XML de R2 y rellena SOLO las columnas vacías. No toca ninguna fila que
 * ya tenga uuid, y no reescribe las urls.
 *
 * Uso:
 *   node scripts/rellenar-datos-facturas.js [--dry]
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const db = require('../lib/db');

const DRY = process.argv.includes('--dry');
const campo = (xml, re) => (xml.match(re) || [])[1] || null;

(async () => {
  const [filas] = await db.query(
    "SELECT id, ticket_id, xml_url FROM facturas WHERE uuid IS NULL AND xml_url IS NOT NULL AND xml_url <> '' ORDER BY ticket_id"
  );
  console.log(`🔎 ${filas.length} factura(s) sin datos fiscales\n`);
  let ok = 0, fallo = 0;

  for (const f of filas) {
    let xml;
    try {
      const r = await fetch(f.xml_url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      xml = await r.text();
    } catch (e) {
      console.log(`   ⚠️ ticket #${f.ticket_id}: no se pudo bajar el XML (${e.message})`);
      fallo++; continue;
    }
    if (!/cfdi:Comprobante/i.test(xml)) {
      console.log(`   ⚠️ ticket #${f.ticket_id}: el archivo no es un CFDI`);
      fallo++; continue;
    }

    const d = {
      uuid: (campo(xml, /UUID="([^"]+)"/i) || '').toLowerCase() || null,
      receptor_rfc: campo(xml, /<(?:cfdi:)?Receptor[^>]*\sRfc="([^"]+)"/i),
      emisor_rfc: campo(xml, /<(?:cfdi:)?Emisor[^>]*\sRfc="([^"]+)"/i),
      emisor_nombre: (campo(xml, /<(?:cfdi:)?Emisor[^>]*\sNombre="([^"]+)"/i) || '').slice(0, 255) || null,
      total: parseFloat(campo(xml, /[\s"]Total="([^"]+)"/) || '') || null,
      serie_folio: `${campo(xml, /\sSerie="([^"]+)"/) || ''}${campo(xml, /\sFolio="([^"]+)"/) || ''}`.slice(0, 60) || null,
      fecha_timbrado: (campo(xml, /FechaTimbrado="([^"]+)"/) || '').replace('T', ' ').slice(0, 19) || null,
    };

    console.log(`   #${f.ticket_id} · ${d.serie_folio || '—'} · $${d.total} · ${String(d.emisor_nombre).slice(0, 30)} → ${d.receptor_rfc}`);
    if (DRY) { ok++; continue; }
    await db.query(
      `UPDATE facturas SET uuid=?, receptor_rfc=?, emisor_rfc=?, emisor_nombre=?, total=?, serie_folio=?, fecha_timbrado=?
        WHERE id=?`,
      [d.uuid, d.receptor_rfc, d.emisor_rfc, d.emisor_nombre, d.total, d.serie_folio, d.fecha_timbrado, f.id]
    );
    ok++;
  }

  console.log(`\n${DRY ? '🔎 (dry) ' : '✅ '}${ok} rellenada(s)${fallo ? ` · ${fallo} sin poder leer` : ''}`);
  process.exit(0);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
