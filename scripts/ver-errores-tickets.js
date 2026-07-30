require('dotenv').config();
const db = require('../lib/db');

(async () => {
  const [rows] = await db.query(
    `SELECT id, comercio, status, error_msg, portal_url, reintento_programado,
            requiere_confirmacion, solicitud_correo_enviada
     FROM tickets WHERE id >= 129 ORDER BY id`
  );
  for (const r of rows) {
    console.log(`\n#${r.id} [${r.status}] ${r.comercio}`);
    console.log(`   portal_url: ${r.portal_url || '(null)'} | requiere_confirmacion: ${r.requiere_confirmacion}`);
    if (r.error_msg) console.log(`   ❌ error_msg: ${r.error_msg}`);
    if (r.reintento_programado) console.log(`   ⏰ reintento: ${r.reintento_programado}`);
  }

  const [facturas] = await db.query(
    `SELECT f.id, f.ticket_id, f.comercio, f.status, f.xml_url IS NOT NULL AS tiene_xml,
            f.pdf_url IS NOT NULL AS tiene_pdf
     FROM facturas f WHERE f.ticket_id >= 129 ORDER BY f.ticket_id`
  );
  console.log('\n\n=== FACTURAS de tickets >= 129 ===');
  console.log(JSON.stringify(facturas, null, 2));
  process.exit(0);
})().catch(e => { console.error('💥', e.message); process.exit(1); });
