require('dotenv').config();
const db = require('../lib/db');
(async () => {
  const ids = process.argv.slice(2).map(Number);
  const [rows] = await db.query(`SELECT * FROM tickets WHERE id IN (${ids.map(()=>'?').join(',')}) ORDER BY id`, ids);
  for (const r of rows) {
    console.log('─'.repeat(72));
    for (const [k, v] of Object.entries(r)) {
      if (v !== null && v !== '' && !/^(ruta_archivo|imagen)/.test(k)) console.log(`  ${k}: ${String(v).slice(0,260)}`);
    }
  }
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
