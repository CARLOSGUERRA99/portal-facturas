require('dotenv').config();
const { facturarOrler } = require('../bots/orler');
(async () => {
  const r = await facturarOrler({ ticketId: 141, carril: '1501', folio: '2860513', fechaPago: '24/07/2026', importe: '107.00' });
  console.log('\n=== RESULTADO #141 ===');
  console.log(JSON.stringify(r, null, 2));
  process.exit(0);
})();
