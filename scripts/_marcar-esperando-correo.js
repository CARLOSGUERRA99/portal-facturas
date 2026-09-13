// Marca un ticket como FACTURADO Y ESPERANDO EL CORREO, cuando el bot devolvió
// error pero la factura SÍ se emitió (falso negativo).
//
// Es el inverso de _destrabar-ticket.js. Existe porque el otro fallo también
// pasa: un bot que no reconoce el acuse deja el ticket en 'error', y el
// siguiente intento —automático a medianoche o manual— emitiría un CFDI
// DUPLICADO, que en autofactura solo se arregla cancelando ante el SAT.
//
// Caso que lo originó: el ticket #393 (Tijuana-Tecate). El portal mostró
// "Factura generada correctamente" en un MODAL, y el bot solo miraba snackbars.
//
// ⚠️ Úsalo solo con PRUEBA de que sí se emitió (el screenshot de la corrida con
// el acuse a la vista). Deja el ticket en 'procesando_correo' para que el job
// de IMAP asocie el CFDI cuando llegue al buzón de captura.
//
// Uso: node scripts/_marcar-esperando-correo.js 393 "folio interno 0000360201"
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const db = require('../lib/db');

(async () => {
  const id = Number(process.argv[2]);
  const referencia = process.argv[3] || '';
  if (!id) { console.log('uso: node scripts/_marcar-esperando-correo.js <id> ["referencia"]'); process.exit(1); }

  const [[t]] = await db.query('SELECT id, comercio, status, error_msg FROM tickets WHERE id = ?', [id]);
  if (!t) { console.log(`No existe el ticket #${id}`); process.exit(1); }

  const [fact] = await db.query('SELECT id, uuid FROM facturas WHERE ticket_id = ?', [id]);
  if (fact.length) {
    console.log(`\n⛔ ABORTADO: el ticket #${id} YA tiene factura registrada (uuid=${fact[0].uuid}). No hace falta.`);
    process.exit(1);
  }

  console.log(`#${id} ${t.comercio}`);
  console.log(`  antes → status=${t.status}`);

  const msg = `FACTURA GENERADA${referencia ? ` (${referencia})` : ''} — esperando el correo. `
    + 'NO RELANZAR: el portal confirmó la emisión aunque el bot no reconoció el acuse; '
    + 'reintentar emitiría un CFDI duplicado.';

  await db.query(
    `UPDATE tickets
        SET status = 'procesando_correo', procesando_correo_desde = NOW(),
            reintento_programado = NULL, error_msg = ?
      WHERE id = ?`, [msg, id]);

  const [[d]] = await db.query('SELECT status, error_msg FROM tickets WHERE id = ?', [id]);
  console.log(`  después → status=${d.status}`);
  console.log(`  ${d.error_msg}`);
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
