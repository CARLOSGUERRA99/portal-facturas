/**
 * Corrida en vivo de bots/tijuanatecate.js SIN FACTURAR.
 *
 * Paradas del propio bot:
 *   agregado → mete el ticket en la tabla, comprueba que el portal lo encuentra
 *              y lo SUELTA. Es la prueba de que los datos del ticket valen.
 *   (defecto) → además llena los datos de facturación y para antes de "Facturar".
 *
 * Uso:
 *   node scripts/probe-tijuanatecate.js 393
 *   node scripts/probe-tijuanatecate.js 393 agregado
 *   node scripts/probe-tijuanatecate.js 393 facturar   ⚠️ EMITE DE VERDAD
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

process.on('unhandledRejection', (e) => console.log('unhandledRejection:', (e && e.message) || String(e)));
process.on('uncaughtException', (e) => console.log('uncaughtException:', (e && e.message) || String(e)));

const { facturarTijuanaTecate } = require('../bots/tijuanatecate');

const FISCALES = {
  rfc: 'GPR110128QD8',
  razonSocial: 'GPN PINTURAS Y RECUBRIMIENTOS',
  regimenFiscal: '601',
  usoCfdi: 'G03',
  codigoPostal: '80140',
  emailEntrega: 'buzonfacturas@serviciosga.site',
};

// Tal como está en el ocr_json, salvo el portal (que decía "pinfra" por error).
const TICKETS = {
  393: { folio: '0000360201', carril: '1009A', autopista: 'TIJUANA - TECATE', fecha: '07/09/2026', hora: '14:28:33', total: 168, ticketId: 393 },
};

(async () => {
  const id = process.argv[2] || '393';
  const modo = (process.argv[3] || '').toLowerCase();
  const ticket = TICKETS[id];
  if (!ticket) { console.log(`No tengo el ticket ${id}. Conocidos: ${Object.keys(TICKETS).join(', ')}`); process.exit(1); }

  const emitir = modo === 'facturar';
  const dryRun = emitir ? false : (modo === 'agregado' ? 'agregado' : 'fiscales');

  console.log(emitir
    ? `⚠️  MODO EMISIÓN REAL — el ticket #${id} se va a TIMBRAR. No hay deshacer.\n`
    : `⛔ Parada de seguridad: dryRun='${dryRun}' — no se factura nada.\n`);

  const r = await facturarTijuanaTecate({ ...FISCALES, ...ticket, dryRun });
  console.log('\n========== RESULTADO ==========');
  console.log(JSON.stringify(r, null, 1));
  process.exit(0);
})();
