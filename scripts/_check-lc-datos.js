require('dotenv').config();
const db = require('../lib/db');

(async () => {
  // Revisar datos de los tickets LC
  const [rows] = await db.query(
    `SELECT id, comercio, status, error_msg, ocr_json 
     FROM tickets 
     WHERE id IN (218, 220, 227)
     ORDER BY id`
  );
  console.log('=== TICKETS LITTLE CAESARS ===\n');
  rows.forEach(r => {
    let j = {}; try { j = JSON.parse(r.ocr_json || '{}'); } catch(e) {}
    console.log('#' + r.id + ' | ' + r.status);
    console.log('  OCR JSON:', JSON.stringify(j, null, 2));
    console.log('');
  });
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
