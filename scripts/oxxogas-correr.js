// Ejecuta el bot de OXXO GAS ya corregido (entrada por la home) para un ticket
// concreto, y si la sesión muere tras emitir, recupera el CFDI por fetch.
require('dotenv').config();
const { facturarOxxoGas } = require('../bots/oxxogas');

(async () => {
  const [estacionId, folio, monto] = process.argv.slice(2);
  console.log(`▶ estación=${estacionId} folio=${folio} monto=${monto}`);
  const r = await facturarOxxoGas({
    rfcId: 'GPR110128QD8', regimenFiscal: '601', usoCfdi: 'G03',
    estacionId, folio, monto, ticketId: `t${folio}`,
  });
  console.log('RESULTADO:', JSON.stringify(r).slice(0, 600));
  process.exit(r.ok ? 0 : 1);
})();
