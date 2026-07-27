require('dotenv').config();
const { facturarPetrofigues } = require('../bots/petrofigues');

(async () => {
  const r = await facturarPetrofigues({
    referencia: '13698',
    folio: '1381230',
    importe: '1000.00',
    rfc: 'GPR110128QD8',
    ticketId: 'test-petrofigues-2',
  });
  console.log('\n=== RESULTADO ===');
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
})();
