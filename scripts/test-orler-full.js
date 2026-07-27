require('dotenv').config();
const { facturarOrler } = require('../bots/orler');

(async () => {
  const r = await facturarOrler({
    carril: '5801',
    folio: '0944056',
    fechaPago: '24/07/2026',
    importe: '101.00',
    ticketId: 'test-orler-1',
  });
  console.log('\n=== RESULTADO ===');
  console.log(JSON.stringify(r, null, 2));
  process.exit(0);
})();
