require('dotenv').config();
const { facturarFacturaGAS } = require('../bots/facturagas');

(async () => {
  const r = await facturarFacturaGAS({
    estacionNombre: 'Suministros Energeticos',
    folio: '2025730',
    webId: '60844255',
    rfc: 'GPR110128QD8',
    razonSocial: 'GPN PINTURAS Y RECUBRIMIENTOS',
    codigoPostal: '80140',
    regimenFiscal: '601',
    usoCfdi: 'G03',
    ticketId: 'test-facturagas-1',
  });
  console.log('\n=== RESULTADO ===');
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
})();
