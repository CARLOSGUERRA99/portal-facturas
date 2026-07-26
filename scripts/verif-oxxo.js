/**
 * Verificación READ-ONLY del fix OXXO para tickets #97 y #101.
 * Muestra status, fecha OCR, facturas asociadas y últimos intentos.
 * Uso: node scripts/verif-oxxo.js
 * NO modifica nada — sólo SELECT.
 */
require('dotenv').config();
const mysql = require('mysql2/promise');

const IDS = [97, 101];

async function main() {
  const db = await mysql.createConnection({
    host:     process.env.DB_HOST,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    port:     parseInt(process.env.DB_PORT),
    database: process.env.DB_DATABASE,
    ssl:      { rejectUnauthorized: false },
  });

  console.log('Conectado ✅\n');

  for (const id of IDS) {
    const [[t]] = await db.query(
      'SELECT id, comercio, status, error_msg, ocr_json, updated_at, creado FROM tickets WHERE id = ?', [id]
    ).catch(async () => {
      // updated_at puede no existir; reintentar sin esa columna
      return db.query('SELECT id, comercio, status, error_msg, ocr_json, creado FROM tickets WHERE id = ?', [id]);
    });
    if (!t) { console.log(`#${id} — no existe\n`); continue; }

    let fecha = '?';
    try { fecha = JSON.parse(t.ocr_json || '{}').fecha || '?'; } catch {}

    console.log(`━━━━━━━━━━ #${id} ${t.comercio} [${t.status}]`);
    console.log(`    fecha OCR almacenada: ${fecha}`);
    console.log(`    error_msg: ${t.error_msg || '(vacío)'}`);
    if (t.updated_at) console.log(`    updated_at: ${new Date(t.updated_at).toISOString()}`);

    const [facturas] = await db.query(
      'SELECT id, status, xml_url, pdf_url, creado FROM facturas WHERE ticket_id = ? ORDER BY id DESC', [id]
    ).catch(() => [[]]);
    if (facturas && facturas.length) {
      console.log(`    FACTURAS (${facturas.length}):`);
      for (const f of facturas) {
        console.log(`      · factura#${f.id} [${f.status}]`);
        console.log(`         XML: ${f.xml_url || '(null)'}`);
        console.log(`         PDF: ${f.pdf_url || '(null)'}`);
        if (f.creado) console.log(`         creada: ${new Date(f.creado).toISOString()}`);
      }
    } else {
      console.log('    FACTURAS: (ninguna)');
    }

    const [intentos] = await db.query(
      'SELECT * FROM ticket_intentos WHERE ticket_id = ? ORDER BY id DESC LIMIT 5', [id]
    ).catch(() => [[]]);
    if (intentos && intentos.length) {
      console.log(`    ÚLTIMOS INTENTOS:`);
      for (const it of intentos) {
        const fechaIt = it.creado || it.created_at || it.fecha || '';
        const res = it.resultado || it.estado || it.status || '';
        const msg = it.mensaje || it.error || it.msg || it.detalle || '';
        console.log(`      · [${res}] ${String(msg).slice(0, 160)} ${fechaIt ? '(' + new Date(fechaIt).toISOString() + ')' : ''}`);
      }
    } else {
      console.log('    (sin intentos registrados)');
    }
    console.log('');
  }

  await db.end();
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
