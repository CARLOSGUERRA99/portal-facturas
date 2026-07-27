require('dotenv').config();
const { facturarGASHR } = require('../bots/gashr');

(async () => {
  const r = await facturarGASHR({
    referencia: '6060',
    folio: '1929725',
    importe: '399.00',
    rfc: 'GPR110128QD8',
    ticketId: 'test-gashr-1',
  });
  console.log('\n=== RESULTADO ===');
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
})();
