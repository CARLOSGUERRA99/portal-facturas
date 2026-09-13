/**
 * Corrida en vivo de bots/fiarum.js — POR DEFECTO SIN TIMBRAR.
 *
 * El bot trae parada de seguridad propia (dryRun): recorre todo el flujo real
 * contra el portal — busca el folio, lo agrega a la tabla y rellena los datos
 * fiscales — y se detiene JUSTO ANTES de pulsar "Siguiente", que es el botón
 * que emite el CFDI y no tiene vuelta atrás.
 *
 * Uso:
 *   node scripts/probe-fiarum.js                        → #391, para antes de "Siguiente"
 *   node scripts/probe-fiarum.js 394                    → otro de los tickets conocidos
 *   node scripts/probe-fiarum.js 394 prefactura         → atraviesa "Siguiente" y para
 *                                                         ante "Generar CFDI" (no emite)
 *   node scripts/probe-fiarum.js 391 EMITIR             → ⚠️ TIMBRA DE VERDAD
 *
 * Los tres tickets son de la caseta Centinela–Rumorosa y llevan desde el 7-sep
 * en error por el portal que no existía (ficacentinela.com.mx).
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

// El WebSocket de Browserless emite un ErrorEvent suelto cuando contesta 429
// (límite de sesiones): sin estos handlers Node aborta antes de imprimir nada.
process.on('unhandledRejection', (e) => console.log('unhandledRejection:', (e && e.message) || String(e)));
process.on('uncaughtException', (e) => console.log('uncaughtException:', (e && e.message) || String(e)));

const { facturarFiarum } = require('../bots/fiarum');

// Datos fiscales REALES del receptor, leídos de la tabla `clientes` con
// scripts/_ver-fiscales.js. No inventar el CP: tiene que ser el del domicilio
// fiscal del SAT o el CFDI sale mal y no hay deshacer (en la primera versión de
// este probe puse 85000 a ojo, y el bueno es 80140).
const FISCALES = {
  rfc: 'GPR110128QD8',
  razonSocial: 'GPN PINTURAS Y RECUBRIMIENTOS',
  regimenFiscal: '601',
  usoCfdi: 'G03',
  codigoPostal: '80140',
  emailEntrega: 'buzonfacturas@serviciosga.site',
};

// Tal y como los trae el ocr_json de la BD. Ojo con el carril: el OCR leyó "8"
// y el portal lo reescribe a "108" al encontrar el cruce — el bot no debe
// abortar por eso (ver cabecera de bots/fiarum.js).
const TICKETS = {
  391: { folio: '3390346', carril: '8', fecha: '07/09/2026', hora: '15:23:28', total: 36, ticketId: 391 },
  394: { folio: '3390345', carril: '8', fecha: '07/09/2026', hora: '15:23:10', total: 36, ticketId: 394 },
  316: { folio: '3912056', carril: '4', fecha: '03/09/2026', hora: '16:22:25', total: 36, ticketId: 316 },
};

(async () => {
  const id = process.argv[2] || '391';
  const modo = (process.argv[3] || '').toLowerCase();
  const emitir = modo === 'emitir';
  const ticket = TICKETS[id];

  if (!ticket) {
    console.log(`No tengo el ticket ${id}. Conocidos: ${Object.keys(TICKETS).join(', ')}`);
    process.exit(1);
  }

  // "Siguiente" NO emite (solo abre la prefactura), así que parar en
  // 'prefactura' sigue siendo seguro: el botón que timbra es "Generar CFDI".
  const dryRun = emitir ? false : (modo === 'prefactura' ? 'prefactura' : 'siguiente');

  console.log(
    emitir
      ? `⚠️  MODO EMISIÓN REAL — el ticket #${id} se va a TIMBRAR. No hay deshacer.\n`
      : `⛔ Parada de seguridad: dryRun='${dryRun}' — no se emite nada.\n`
  );

  const r = await facturarFiarum({ ...FISCALES, ...ticket, dryRun });

  console.log('\n========== RESULTADO ==========');
  console.log(JSON.stringify(r, null, 1));
  process.exit(0);
})();
