require('dotenv').config();
const { facturarTufesa } = require('../bots/tufesa');
(async () => {
  const r = await facturarTufesa({ folio: '63058973', fecha: '25/05/2026', origen: 'Hermosillo', rfc: 'GPR110128QD8', ticketId: 'test87' });
  console.log('\n=== RESULTADO ===', JSON.stringify(r, null, 2));
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
