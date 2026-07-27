require('dotenv').config();
const { facturarPetrofigues } = require('../bots/petrofigues');

(async () => {
  const r = await facturarPetrofigues({
    referencia: '13697',
    folio: '1067336',
    importe: '1000.00',
    rfc: 'GPR110128QD8',
    ticketId: 'test-petrofigues-1',
  });
  console.log('\n=== RESULTADO ===');
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
})();
