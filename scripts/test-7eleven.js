require('dotenv').config();
const { facturar7Eleven } = require('../bots/7elevenmexicosadecv');

(async () => {
  console.log('▶️  Probando bot 7-Eleven con folio real #105...\n');
  const r = await facturar7Eleven({
    folio: '18132905202621000068200100084801077', // 35 dígitos
    total: 56,
    fecha: '29/05/2026',
    rfc: 'GPR110128QD8',
    razonSocial: 'GPN PINTURAS Y RECUBRIMIENTOS',
    regimenFiscal: '601',
    usoCfdi: 'G03',
    codigoPostal: '83000',
    ticketId: 'test105',
  });
  console.log('\n=== RESULTADO ===');
  console.log(JSON.stringify(r, null, 2));
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
