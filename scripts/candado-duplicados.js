// CANDADO ANTI-DUPLICADOS a nivel de BASE DE DATOS.
//
// Por qué hacía falta: el chequeo que había vivía solo en el código y además
// excluía los tickets en 'error' (`AND status NOT IN ('error')`). Como un
// ticket que falla queda justo en 'error', volver a subir la misma foto pasaba
// el filtro y creaba un duplicado — que es exactamente lo que venía pasando
// (10 grupos duplicados encontrados).
//
// Un índice UNIQUE es un candado de verdad: da igual por qué endpoint, script o
// worker entre el ticket, MySQL lo rechaza. La clave es
// user_id + comercio + folio (normalizados), y se ignora a los que no tienen
// folio legible, que no se pueden comparar.
//
// Uso:
//   node scripts/candado-duplicados.js            → solo informa
//   node scripts/candado-duplicados.js --aplicar  → borra duplicados y crea el índice
require('dotenv').config();
const db = require('../lib/db');

const APLICAR = process.argv.includes('--aplicar');
const parseJson = (v) => { if (!v) return {}; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return {}; } };

const folioDe = (o) => o.folio || o.codigoTicket || o.referencia || o.idFacturacion
  || o.folioFactura || o.idVenta || o.tc || null;

// Misma normalización que usará el índice: sin espacios, mayúsculas.
const norm = (s) => String(s || '').trim().toUpperCase().replace(/\s+/g, '');

(async () => {
  const [tickets] = await db.query(`
    SELECT t.id, t.user_id, t.comercio, t.status, t.ocr_json, t.creado,
           -- Solo cuenta como factura si tiene XML de verdad: hay filas
           -- antiguas en `facturas` con xml_url NULL que no sirven de nada y
           -- hacían creer que un duplicado era intocable.
           (SELECT COUNT(*) FROM facturas f
             WHERE f.ticket_id = t.id AND f.xml_url IS NOT NULL AND f.xml_url <> '') AS tiene_factura
      FROM tickets t ORDER BY t.id`);

  // La clave es user_id + FOLIO + TOTAL, no el comercio: el OCR lee el nombre
  // del comercio distinto en cada subida de la misma foto ("Caseta El Pisal
  // (Orler" vs "Caseta El Pisal (Sinaloa)"), así que incluirlo dejaba escapar
  // duplicados reales. Que dos comercios distintos emitan el MISMO folio por el
  // MISMO importe al mismo cliente es prácticamente imposible.
  const grupos = {};
  for (const t of tickets) {
    const o = parseJson(t.ocr_json);
    const folio = folioDe(o);
    if (!folio || o.total == null) continue;
    const clave = `${t.user_id}|${norm(folio)}|${parseFloat(o.total).toFixed(2)}`;
    (grupos[clave] = grupos[clave] || []).push({ ...t, folio, total: o.total });
  }

  const duplicados = Object.entries(grupos).filter(([, v]) => v.length > 1);
  console.log(`🔍 ${tickets.length} tickets · ${duplicados.length} grupo(s) con duplicados\n`);

  const aBorrar = [];
  for (const [clave, lista] of duplicados) {
    // Se conserva el que TIENE factura; si ninguno la tiene, el más antiguo
    // (es el que ya acumuló historial de intentos y notas).
    const conFactura = lista.filter((t) => t.tiene_factura > 0);
    const superviviente = conFactura[0] || lista[0];
    const sobran = lista.filter((t) => t.id !== superviviente.id);
    console.log(`  folio ${clave.split('|')[1].slice(0, 30)} · $${clave.split('|')[2]}`);
    console.log(`     conservar #${superviviente.id}${superviviente.tiene_factura ? ' (tiene CFDI)' : ''} · borrar ${sobran.map((t) => '#' + t.id).join(', ')}`);
    for (const t of sobran) {
      if (t.tiene_factura > 0) { console.log(`     ⚠️ #${t.id} también tiene CFDI — NO se borra, revisar a mano`); continue; }
      aBorrar.push(t.id);
    }
  }

  if (!APLICAR) {
    console.log(`\n(simulación) se borrarían ${aBorrar.length} ticket(s). Ejecuta con --aplicar para hacerlo.`);
    process.exit(0);
  }

  if (aBorrar.length) {
    const [r] = await db.query(`DELETE FROM tickets WHERE id IN (${aBorrar.map(() => '?').join(',')})`, aBorrar);
    console.log(`\n🗑️ ${r.affectedRows} ticket(s) duplicado(s) borrado(s)`);
  }

  // ── El candado ────────────────────────────────────────────────────────────
  // Columna generada con la clave de deduplicación + índice UNIQUE. Es NULL
  // cuando no hay folio legible, y MySQL no aplica UNIQUE sobre NULL, así que
  // los tickets sin folio (que no se pueden comparar) siguen entrando.
  try {
    await db.query(`
      ALTER TABLE tickets
      ADD COLUMN clave_dedupe VARCHAR(180)
      GENERATED ALWAYS AS (
        CASE WHEN COALESCE(
               JSON_UNQUOTE(JSON_EXTRACT(ocr_json,'$.folio')),
               JSON_UNQUOTE(JSON_EXTRACT(ocr_json,'$.codigoTicket')),
               JSON_UNQUOTE(JSON_EXTRACT(ocr_json,'$.referencia')),
               JSON_UNQUOTE(JSON_EXTRACT(ocr_json,'$.idFacturacion')),
               JSON_UNQUOTE(JSON_EXTRACT(ocr_json,'$.folioFactura')),
               JSON_UNQUOTE(JSON_EXTRACT(ocr_json,'$.idVenta')),
               JSON_UNQUOTE(JSON_EXTRACT(ocr_json,'$.tc'))
             ) IS NULL
             OR JSON_EXTRACT(ocr_json,'$.total') IS NULL THEN NULL
             ELSE CONCAT_WS('|', user_id,
                    UPPER(REPLACE(COALESCE(
                      JSON_UNQUOTE(JSON_EXTRACT(ocr_json,'$.folio')),
                      JSON_UNQUOTE(JSON_EXTRACT(ocr_json,'$.codigoTicket')),
                      JSON_UNQUOTE(JSON_EXTRACT(ocr_json,'$.referencia')),
                      JSON_UNQUOTE(JSON_EXTRACT(ocr_json,'$.idFacturacion')),
                      JSON_UNQUOTE(JSON_EXTRACT(ocr_json,'$.folioFactura')),
                      JSON_UNQUOTE(JSON_EXTRACT(ocr_json,'$.idVenta')),
                      JSON_UNQUOTE(JSON_EXTRACT(ocr_json,'$.tc'))
                    ),''),' ',''),
                    FORMAT(CAST(JSON_EXTRACT(ocr_json,'$.total') AS DECIMAL(12,2)), 2))
        END
      ) STORED`);
    console.log('✅ columna clave_dedupe creada');
  } catch (e) {
    console.log(`ℹ️ clave_dedupe: ${e.code === 'ER_DUP_FIELDNAME' ? 'ya existía' : e.message}`);
  }

  try {
    await db.query('ALTER TABLE tickets ADD UNIQUE INDEX uq_ticket_dedupe (clave_dedupe)');
    console.log('🔒 índice UNIQUE uq_ticket_dedupe creado — el candado ya está puesto');
  } catch (e) {
    console.log(`ℹ️ uq_ticket_dedupe: ${/Duplicate key name/i.test(e.message) ? 'ya existía' : e.message}`);
  }

  // Mismo candado para las FACTURAS: el mismo CFDI no puede registrarse dos
  // veces (pasó con los tickets #159 y #161, que apuntaban al UUID de otro).
  try {
    await db.query('ALTER TABLE facturas ADD UNIQUE INDEX uq_factura_xml (xml_url)');
    console.log('🔒 índice UNIQUE uq_factura_xml creado — un CFDI no se puede registrar dos veces');
  } catch (e) {
    console.log(`ℹ️ uq_factura_xml: ${/Duplicate key name/i.test(e.message) ? 'ya existía' : e.message}`);
  }

  const [[c]] = await db.query('SELECT COUNT(*) n FROM tickets');
  console.log(`\n📊 quedan ${c.n} tickets`);
  process.exit(0);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
