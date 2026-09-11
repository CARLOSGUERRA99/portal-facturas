/**
 * Reclama la REFACTURACIÓN de un CFDI que el comercio emitió a PÚBLICO EN
 * GENERAL (XAXX010101000) en lugar de al RFC que se le pidió.
 *
 * Por qué hace falta: cuando un comercio recibe la solicitud fuera de su
 * ventana normal, a veces contesta mandando su factura GLOBAL del día — la que
 * emite a XAXX010101000 con uso S01 "Sin efectos fiscales". Esa factura es
 * correcta para ellos y COMPLETAMENTE INÚTIL para nosotros: no es deducible y no
 * ampara nada a nombre del receptor.
 *
 * Y es peor que no recibir nada, porque el importe cuadra: si alguien la asocia
 * al ticket sin mirar el receptor, el ticket queda "resuelto" con un comprobante
 * que no sirve, y nadie vuelve a mirarlo hasta la declaración. Por eso
 * reconciliar-correo.js la descarta sola (compara el RFC del receptor) y por eso
 * existe este script: para pedir la sustitución en vez de dejarlo pasar.
 *
 * Lo que se pide es una SUSTITUCIÓN, no una factura nueva: el consumo ya está
 * dentro de su global, así que tienen que cancelarla o excluirlo y reexpedir.
 *
 * Uso:
 *   node scripts/reclamar-cfdi-publico-general.js <ticketId> [ticketId...] --uuid <uuid,uuid>
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const db = require('../lib/db');
const { enviarCorreo } = require('../lib/correo');
const { COPIA_SOLICITUDES } = require('../lib/solicitud-correo');

const args = process.argv.slice(2);
const IDS = args.filter((a) => /^\d+$/.test(a)).map(Number);
const iU = args.indexOf('--uuid');
const UUIDS = iU >= 0 ? String(args[iU + 1] || '').split(',').filter(Boolean) : [];

(async () => {
  if (!IDS.length) {
    console.error('Uso: node scripts/reclamar-cfdi-publico-general.js <ticketId>... [--uuid <uuid,uuid>]');
    process.exit(1);
  }

  const [tickets] = await db.query(
    `SELECT t.id, t.comercio, t.email_contacto, t.ocr_json,
            COALESCE(c.rfc, u.rfc) rfc, COALESCE(c.razon_social, u.razon_social) razon,
            COALESCE(c.codigo_postal, u.codigo_postal) cp,
            COALESCE(c.regimen_fiscal, u.regimen_fiscal) regimen
       FROM tickets t JOIN users u ON u.id = t.user_id
       LEFT JOIN clientes c ON c.id = u.cliente_id
      WHERE t.id IN (${IDS.map(() => '?').join(',')})`, IDS);

  if (!tickets.length) { console.error('No se encontraron esos tickets.'); process.exit(1); }
  const destino = tickets[0].email_contacto;
  if (!destino) { console.error('El ticket no tiene email_contacto.'); process.exit(1); }

  const filas = tickets.map((t) => {
    let o = {}; try { o = JSON.parse(t.ocr_json || '{}'); } catch {}
    return `<tr>
      <td style="padding:6px 10px;border:1px solid #ddd">${o.fecha || '—'}</td>
      <td style="padding:6px 10px;border:1px solid #ddd">${o.folio || '—'}</td>
      <td style="padding:6px 10px;border:1px solid #ddd;text-align:right">$${Number(o.total).toFixed(2)}</td>
    </tr>`;
  }).join('');

  const f = tickets[0];
  const html = `
<p>Buen día,</p>
<p>Gracias por atender nuestra solicitud. Sin embargo, los comprobantes que
recibimos fueron emitidos a <b>PÚBLICO EN GENERAL (XAXX010101000)</b> con uso de
CFDI <b>S01 — Sin efectos fiscales</b>${UUIDS.length ? `:<br><small>${UUIDS.join('<br>')}</small>` : '.'}</p>
<p>Con ese receptor el comprobante <b>no es deducible</b> para nosotros, así que
le agradeceríamos la <b>sustitución</b> de esos CFDI por otros emitidos a
nuestro RFC:</p>
<table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px">
  <tr><td style="padding:4px 10px"><b>RFC</b></td><td style="padding:4px 10px">${f.rfc}</td></tr>
  <tr><td style="padding:4px 10px"><b>Razón social</b></td><td style="padding:4px 10px">${f.razon}</td></tr>
  <tr><td style="padding:4px 10px"><b>Código postal</b></td><td style="padding:4px 10px">${f.cp}</td></tr>
  <tr><td style="padding:4px 10px"><b>Régimen fiscal</b></td><td style="padding:4px 10px">${f.regimen}</td></tr>
  <tr><td style="padding:4px 10px"><b>Uso de CFDI</b></td><td style="padding:4px 10px">G03 — Gastos en general</td></tr>
  <tr><td style="padding:4px 10px"><b>Forma de pago</b></td><td style="padding:4px 10px">Tarjeta de crédito</td></tr>
</table>
<p>Los consumos son:</p>
<table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px">
  <tr style="background:#f3f3f3">
    <th style="padding:6px 10px;border:1px solid #ddd">Fecha</th>
    <th style="padding:6px 10px;border:1px solid #ddd">Cuenta / Folio</th>
    <th style="padding:6px 10px;border:1px solid #ddd">Importe a facturar</th>
  </tr>
  ${filas}
</table>
<p style="font-size:13px;color:#555">Nota: el importe indicado es el del consumo,
<b>sin la propina</b>, que no es objeto de facturación.</p>
<p>Quedamos atentos. Gracias.</p>
<p style="font-size:12px;color:#888">GPN Pinturas y Recubrimientos · Facturación automatizada</p>`;

  const comercio = String(f.comercio).replace(/\s*\(.*$/, '');
  console.log(`📨 Reclamando sustitución a ${destino} — tickets ${IDS.join(', ')}`);
  await enviarCorreo({
    from: `"GPN Facturación" <${process.env.IMAP_USER || 'buzonfacturas@serviciosga.site'}>`,
    to: destino,
    cc: COPIA_SOLICITUDES,
    replyTo: process.env.IMAP_USER || 'buzonfacturas@serviciosga.site',
    subject: `Sustitución de CFDI — emitidos a público en general — ${f.rfc} — ${comercio}`,
    html,
  });
  console.log('✅ Enviado');
  process.exit(0);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
