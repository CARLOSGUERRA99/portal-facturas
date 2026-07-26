/**
 * Prueba EN VIVO del bot Carl's Jr corregido con los datos del #90 (ya facturado).
 * Debe detectar "Ya ha sido generada su factura!" y RECUPERAR la factura existente
 * (descargar XML+PDF) en vez de quedarse en timeout.
 * Uso: node scripts/test-carljr-90.js
 */
require('dotenv').config();
const { facturarCarlsJr } = require('../bots/carljr');

(async () => {
  console.log('▶️  Probando bot Carl\'s Jr (ICR) con #90 (ya facturado)...\n');
  const r = await facturarCarlsJr({
    referencia: '56007072082652',
    total: 372,
    rfc: 'GPR110128QD8',
    razonSocial: 'GPN PINTURAS Y RECUBRIMIENTOS',
    regimenFiscal: '601',
    usoCfdi: 'G03',
    ticketId: 'test90',
  });
  console.log('\n=== RESULTADO ===');
  console.log(JSON.stringify(r, null, 2));
  process.exit(0);
})().catch(e => { console.error('❌ Excepción:', e.message); process.exit(1); });
