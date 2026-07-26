/**
 * Prueba EN VIVO del bot SushiO corregido, reproduciendo el ticket #72.
 * Usa el código único real (de la captura del usuario) + folio del #72.
 * Espera: { ok:false, error_code:'ticket_vencido', email_contacto:'caja@sushio.mx', ... }
 * Uso: node scripts/test-sushito-72.js
 */
require('dotenv').config();
const { facturarSushito } = require('../bots/sushito');

(async () => {
  console.log('▶️  Probando bot SushiO corregido contra el portal en vivo...\n');
  const r = await facturarSushito({
    referencia: '206197GVETHHC7',  // código único real (captura del usuario)
    folio: '79542',                // folio del ticket #72
    total: 1625,
    rfc: 'XAXX010101000',          // RFC genérico — solo para la prueba de detección
    razonSocial: 'PUBLICO EN GENERAL',
    regimenFiscal: '616',
    usoCfdi: 'S01',
    ticketId: 'test72',
    portalUrl: 'https://mefacturo.mx/sushio',
  });
  console.log('\n=== RESULTADO ===');
  console.log(JSON.stringify(r, null, 2));
  process.exit(0);
})().catch(e => { console.error('❌ Excepción:', e.message); process.exit(1); });
