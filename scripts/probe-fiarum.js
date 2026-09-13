/**
 * Corrida en vivo de bots/fiarum.js — POR DEFECTO SIN TIMBRAR.
 *
 * El bot trae parada de seguridad propia (dryRun): recorre todo el flujo real
 * contra el portal — busca el folio, lo agrega a la tabla y rellena los datos
 * fiscales — y se detiene JUSTO ANTES de pulsar "Siguiente", que es el botón
 * que emite el CFDI y no tiene vuelta atrás.
 *
 * Uso:
 *   node scripts/probe-fiarum.js            → ticket #391 en seco (no emite)
 *   node scripts/probe-fiarum.js 394        → otro de los tickets conocidos
 *   node scripts/probe-fiarum.js 391 EMITIR → ⚠️ TIMBRA DE VERDAD
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

// Datos fiscales del receptor: los mismos que el router pone por defecto
// (bots/index.js → normalizarDatos) y que se ven en los logs de producción.
const FISCALES = {
  rfc: 'GPR110128QD8',
  razonSocial: 'GPN PINTURAS Y RECUBRIMIENTOS',
  regimenFiscal: '601',
  usoCfdi: 'G03',
  codigoPostal: '85000',
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
  const emitir = (process.argv[3] || '').toUpperCase() === 'EMITIR';
  const ticket = TICKETS[id];

  if (!ticket) {
    console.log(`No tengo el ticket ${id}. Conocidos: ${Object.keys(TICKETS).join(', ')}`);
    process.exit(1);
  }

  console.log(
    emitir
      ? `⚠️  MODO EMISIÓN REAL — el ticket #${id} se va a TIMBRAR. No hay deshacer.\n`
      : `⛔ Parada de seguridad activa (dryRun): se recorre todo y se para antes de "Siguiente".\n`
  );

  const r = await facturarFiarum({ ...FISCALES, ...ticket, dryRun: !emitir });

  console.log('\n========== RESULTADO ==========');
  console.log(JSON.stringify(r, null, 1));
  process.exit(0);
})();
