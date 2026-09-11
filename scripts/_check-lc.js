require('dotenv').config();
const db = require('../lib/db');

(async () => {
  const [rows] = await db.query(
    `SELECT id, comercio, status, error_msg, ocr_json 
     FROM tickets 
     WHERE comercio LIKE '%Little Caesars%' 
        OR comercio LIKE '%littlecaesars%' 
        OR comercio LIKE '%Cafrema%' 
     ORDER BY id`
  );
  console.log('Little Caesars tickets:', rows.length);
  rows.forEach(r => {
    let j = {}; try { j = JSON.parse(r.ocr_json || '{}'); } catch(e) {}
    console.log('#' + r.id + ' | ' + r.status + ' | ' + r.comercio + ' | $' + (j.total || '?') + ' | ' + (r.error_msg || '').slice(0, 70));
  });
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
