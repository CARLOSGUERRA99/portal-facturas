/**
 * Corrida en vivo de bots/lossenderos.js SIN TIMBRAR.
 *
 * Usa la parada de seguridad del propio bot (LOSSENDEROS_PARAR_EN):
 *   prefactura   → para con el modal fiscal ya relleno, ANTES de pulsar el
 *                  "Facturar" que pide la previsualizacion. Es la parada mas
 *                  conservadora: quedan DOS botones por delante del que emite.
 *   confirmacion → para en el paso 2 con la prefactura a la vista, justo antes
 *                  del boton que abre el modal de confirmacion.
 *
 * Uso: node scripts/probe-senderos-bot.js [prefactura|confirmacion]
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

// El WebSocket de Browserless emite un ErrorEvent suelto cuando contesta 429
// (limite de sesiones): sin estos handlers Node aborta antes de imprimir nada.
process.on('unhandledRejection', (e) => console.log('unhandledRejection:', (e && e.message) || String(e)));
process.on('uncaughtException', (e) => console.log('uncaughtException:', (e && e.message) || String(e)));

process.env.LOSSENDEROS_PARAR_EN = process.argv[2] || 'prefactura';

const { facturarLosSenderos } = require('../bots/lossenderos');

// Ticket #350 tal y como lo trae el OCR, con la trampa incluida: folio/ticket
// son 217 (el numero del encabezado, que da E-05) y ticketUnico es 80 (el del
// pie, que es el bueno). El bot tiene que resolverlo solo.
const TICKET_350 = {
  comercio: 'KFC Central Durango', franquicia: 'KFC', sucursal: '1434', sucursalNombre: 'KFC CENTRAL DURANGO',
  fecha: '04/09/2026', folio: '217', ticket: '217', ticketUnico: '80', total: 149, formaPago: 'Efectivo',
  rfc: 'GPR110128QD8', razonSocial: 'GPN PINTURAS Y RECUBRIMIENTOS', regimenFiscal: '601', usoCfdi: 'G03',
  codigoPostal: '80140', calle: 'CALZADA AEROPUERTO', ext: '7569', int: '1', colonia: 'BACHIGUALATO',
  municipio: 'CULIACAN', estado: 'SINALOA', emailEntrega: 'buzonfacturas@serviciosga.site', ticketId: 350,
};

(async () => {
  console.log(`⛔ Parada de seguridad: LOSSENDEROS_PARAR_EN=${process.env.LOSSENDEROS_PARAR_EN}\n`);
  const r = await facturarLosSenderos(TICKET_350);
  console.log('\n========== RESULTADO ==========');
  console.log(JSON.stringify(r, null, 1));
  process.exit(0);
})();
