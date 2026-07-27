require('dotenv').config();
const { facturarCapufe } = require('../bots/capufe');

(async () => {
  const r = await facturarCapufe({
    codigo: '5CBGBKG94776BDZLHQ', // ticket #118 real, Plaza 149 Fundición, $114.00
    rfc: 'GPR110128QD8',
    razonSocial: 'GPN PINTURAS Y RECUBRIMIENTOS',
    codigoPostal: '80140',
    regimenFiscal: '601',
    usoCfdi: 'G03',
    ticketId: 118,
  });
  console.log('\n=== RESULTADO ===');
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
})();
