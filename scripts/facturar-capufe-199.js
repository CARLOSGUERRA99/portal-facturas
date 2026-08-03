// Factura el ticket #199 (CAPUFE, Plaza 151 Guaymas, $48) del cliente DGA.
//
// ⚠️ ESTE SÍ FACTURA, y con CAPUFE eso tiene un filo especial: consultar el
// código LO RESERVA. Si el flujo se corta antes de "Facturar conceptos", el
// portal lo marca como "ya se encuentra capturado" y ese código queda quemado
// para siempre. Por eso se corre UNO solo y vigilado, no los dos a la vez.
//
// Los datos fiscales salen de la tabla `clientes` — no se teclean aquí. Es el
// mismo camino que usa la cola, así que si algo estuviera mal en el alta de
// Daniel, se ve ahora y no en el CFDI ya timbrado (que CAPUFE avisa que NO se
// puede corregir ni remitir a otro RFC).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const db = require('../lib/db');
const { facturarCapufe } = require('../bots/capufe');

const TICKET_ID = Number(process.argv[2] || 199);

(async () => {
  const [[t]] = await db.query(
    `SELECT t.id, t.comercio, t.status, t.ocr_json,
            c.rfc, c.razon_social, c.codigo_postal, c.regimen_fiscal, c.uso_cfdi, c.nombre AS cliente
       FROM tickets t
       JOIN users u    ON u.id = t.user_id
       LEFT JOIN clientes c ON c.id = u.cliente_id
      WHERE t.id = ?`, [TICKET_ID]);
  if (!t) throw new Error(`no existe el ticket #${TICKET_ID}`);

  const o = typeof t.ocr_json === 'object' ? (t.ocr_json || {}) : JSON.parse(t.ocr_json || '{}');
  // El código puede venir como `codigo` (prompt nuevo) o `referencia` (lecturas
  // hechas con el prompt genérico, que es el caso de este ticket).
  const codigo = String(o.codigo || o.referencia || '').trim();
  const limpio = codigo.replace(/\s+/g, '').toUpperCase();

  console.log(`🧾 Ticket #${t.id} — ${t.comercio}`);
  console.log(`   cliente : ${t.cliente} · RFC ${t.rfc} · rég ${t.regimen_fiscal} · CP ${t.codigo_postal}`);
  console.log(`   código  : "${codigo}" → ${limpio} (${limpio.length} caracteres)`);
  console.log(`   total   : $${o.total}`);

  // Guardas ANTES de tocar el portal: una consulta con el dato equivocado
  // quema el código, así que más vale abortar aquí.
  if (limpio.length !== 18) throw new Error(`el código tiene ${limpio.length} caracteres y CAPUFE pide 18 — se aborta para no quemarlo`);
  if (!t.rfc) throw new Error('el cliente no tiene RFC');
  if (!t.regimen_fiscal) throw new Error('el cliente no tiene régimen fiscal');

  console.log('\n▶️  Lanzando el bot…\n');
  const t0 = Date.now();
  const r = await facturarCapufe({
    codigo: limpio,
    rfc: t.rfc,
    razonSocial: t.razon_social,
    codigoPostal: t.codigo_postal,
    regimenFiscal: t.regimen_fiscal,
    usoCfdi: t.uso_cfdi || 'G03',
    ticketId: t.id,
  });

  console.log(`\n⏱️  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('RESULTADO:', JSON.stringify(r, null, 2));
  process.exit(0);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
