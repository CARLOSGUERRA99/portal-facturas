require('dotenv').config();
const { facturarDana } = require('../bots/dana');
(async () => {
  console.log('▶️  Probando bot Dana...\n');
  const r = await facturarDana({
    referencia: '0000000001', folio: '0000000001', total: 100,
    rfc: 'XAXX010101000', razonSocial: 'PUBLICO EN GENERAL', regimenFiscal: '601', usoCfdi: 'G03',
    ticketId: 'testdana',
  });
  console.log('\n=== RESULTADO ===');
  console.log(JSON.stringify(r, null, 2));
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
