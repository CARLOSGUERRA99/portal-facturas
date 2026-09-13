/**
 * Corrida en vivo de bots/puentecolorado.js (portal qrplus) SIN FACTURAR.
 *
 * Paradas de seguridad del propio bot:
 *   registro → registra el ticket, vuelca los botones del Paso 1 y lo LIBERA.
 *   (por defecto) → llega al Paso 2 (Datos Fiscales), lo vuelca y libera.
 *
 * Uso:
 *   node scripts/probe-puentecolorado.js 396
 *   node scripts/probe-puentecolorado.js 390 registro
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

process.on('unhandledRejection', (e) => console.log('unhandledRejection:', (e && e.message) || String(e)));
process.on('uncaughtException', (e) => console.log('uncaughtException:', (e && e.message) || String(e)));

const { facturarPuenteColorado } = require('../bots/puentecolorado');

// Datos fiscales REALES, leídos con scripts/_ver-fiscales.js.
const FISCALES = {
  rfc: 'GPR110128QD8',
  razonSocial: 'GPN PINTURAS Y RECUBRIMIENTOS',
  regimenFiscal: '601',
  usoCfdi: 'G03',
  codigoPostal: '80140',
  emailEntrega: 'buzonfacturas@serviciosga.site',
};

// ⚠️ Leídos A MANO de las fotos en R2, NO del ocr_json: el OCR de estos dos se
// hizo con el prompt genérico viejo y no trae carril ni hora, y en el #390
// ademas se comió un dígito del folio (guardó 052080; el ticket dice 0524080).
// El prompt nuevo de lib/vision.js ya pide caseta, carril, hora y webId.
const TICKETS = {
  390: { folio: '0524080', carril: '4', caseta: 'SAN LUIS RIO COLORADO', fecha: '07/09/2026', hora: '17:07:45', total: 15, ticketId: 390 },
  396: { folio: '0231102', carril: '6', caseta: 'SAN LUIS RIO COLORADO', fecha: '07/09/2026', hora: '17:00:06', total: 15, ticketId: 396 },
};

(async () => {
  const id = process.argv[2] || '396';
  const modo = (process.argv[3] || '').toLowerCase();
  const ticket = TICKETS[id];
  if (!ticket) { console.log(`No tengo el ticket ${id}. Conocidos: ${Object.keys(TICKETS).join(', ')}`); process.exit(1); }

  // 'registro' → para tras meterlo en la rejilla
  // 'fiscales' → para con el Paso 2 lleno (por defecto)
  // 'paso3'    → llega al Paso 3 y vuelca sus botones, sin facturar
  // 'FACTURAR' → ⚠️ emite de verdad
  const emitir = modo === 'facturar';
  const dryRun = emitir ? false : (['registro', 'paso3'].includes(modo) ? modo : 'fiscales');

  console.log(emitir
    ? `⚠️  MODO EMISIÓN REAL — el ticket #${id} se va a TIMBRAR. No hay deshacer.\n`
    : `⛔ Parada de seguridad: dryRun='${dryRun}' — no se factura nada.\n`);

  const r = await facturarPuenteColorado({ ...FISCALES, ...ticket, dryRun });
  console.log('\n========== RESULTADO ==========');
  console.log(JSON.stringify(r, null, 1));
  process.exit(0);
})();
