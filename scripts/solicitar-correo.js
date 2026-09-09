/**
 * Manda la solicitud de factura POR CORREO al comercio, para tickets que
 * ningún bot puede facturar (portal con captcha, plazo vencido, o el comercio
 * simplemente emite a mano).
 *
 * Hace lo mismo que el botón "Solicitar por correo" de Mis Tickets, pero desde
 * la terminal y en lote. Adjunta la constancia de situación fiscal y la foto
 * del ticket, y manda copia al administrador (COPIA_SOLICITUDES).
 *
 * Uso:
 *   node scripts/solicitar-correo.js 331 295 297
 *   node scripts/solicitar-correo.js 328 --email facturacion@comercio.com
 *   node scripts/solicitar-correo.js 331 --forma Tarjeta
 *   node scripts/solicitar-correo.js --pendientes     → solo LISTA candidatos
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const db = require('../lib/db');
const { enviarSolicitudPorCorreo, COPIA_SOLICITUDES } = require('../lib/solicitud-correo');

const args = process.argv.slice(2);
const idx = (f) => args.indexOf(f);
const valorDe = (f) => (idx(f) >= 0 ? args[idx(f) + 1] : null);
const EMAIL = valorDe('--email');
const FORMA = valorDe('--forma') || 'Efectivo';
const SOLO_LISTA = args.includes('--pendientes');
// El comercio no siempre contesta a la primera. --reenviar permite insistir
// sobre una solicitud ya mandada; sin el flag se omite, para no acribillar al
// comercio con la misma peticion por error.
const REENVIAR = args.includes('--reenviar');
const IDS = args.filter((a) => /^\d+$/.test(a)).map(Number);

const SQL_TICKET = `
  SELECT t.id, t.comercio, t.email_contacto, t.solicitud_correo_enviada,
         t.ocr_json, t.nombre_archivo, t.ruta_archivo, t.user_id, t.status,
         u.nombre AS user_nombre, u.email AS user_email,
         u.rfc, u.razon_social, u.constancia_url,
         c.nombre AS cliente_nombre
  FROM tickets t
  JOIN users u ON t.user_id = u.id
  LEFT JOIN clientes c ON c.id = u.cliente_id
`;

(async () => {
  if (SOLO_LISTA) {
    const [r] = await db.query(
      `${SQL_TICKET} WHERE t.status IN ('error','pendiente_confirmacion')
         AND COALESCE(t.solicitud_correo_enviada,0) = 0
       ORDER BY t.id DESC LIMIT 60`
    );
    console.log(`\n=== ${r.length} tickets sin solicitud enviada ===`);
    console.log('  (✉ = ya tiene correo de contacto; los demás necesitan --email)\n');
    for (const t of r) {
      console.log(`  ${t.email_contacto ? '✉' : ' '} #${t.id} [${t.status}] ${String(t.comercio || '').slice(0, 44)}`);
      if (t.email_contacto) console.log(`      → ${t.email_contacto}`);
      if (!t.constancia_url) console.log('      ⚠️ el usuario NO tiene constancia subida — la solicitud fallaría');
    }
    process.exit(0);
  }

  if (!IDS.length) {
    console.error('Uso: node scripts/solicitar-correo.js <ticketId...> [--email x@y.com] [--forma Efectivo|Tarjeta]');
    console.error('     node scripts/solicitar-correo.js --pendientes');
    process.exit(1);
  }
  if (IDS.length > 1 && EMAIL) {
    console.error('❌ --email aplica a UN solo ticket; con varios, cada uno usa su email_contacto.');
    process.exit(1);
  }

  console.log(`Copia de todas las solicitudes → ${COPIA_SOLICITUDES}\n`);
  for (const id of IDS) {
    const [[t]] = await db.query(`${SQL_TICKET} WHERE t.id = ?`, [id]);
    if (!t) { console.log(`#${id}: no existe`); continue; }

    const destino = t.email_contacto || EMAIL;
    if (!destino) { console.log(`#${id} ${t.comercio}: ⚠️ sin correo de contacto — pásalo con --email`); continue; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(destino)) { console.log(`#${id}: ⚠️ correo inválido (${destino})`); continue; }
    if (!t.constancia_url) { console.log(`#${id}: ⚠️ el usuario no tiene constancia subida`); continue; }
    // La misma guarda que el endpoint: mandar dos veces la misma solicitud al
    // comercio es ruido para ellos y confusión para nosotros.
    if (t.solicitud_correo_enviada && !REENVIAR) { console.log(`#${id} ${t.comercio}: ya se había enviado — se omite (usa --reenviar para insistir)`); continue; }
    if (t.solicitud_correo_enviada && REENVIAR) console.log(`#${id}: reenviando (ya se había mandado antes)`);

    if (!t.email_contacto && EMAIL) {
      await db.query('UPDATE tickets SET email_contacto = ? WHERE id = ?', [EMAIL, id]).catch(() => {});
    }
    t.email_contacto = destino;
    t.formaPago = FORMA;

    await db.query('UPDATE tickets SET solicitud_correo_enviada = 0, solicitud_correo_error = NULL WHERE id = ?', [id]);
    try {
      await enviarSolicitudPorCorreo(t);
      const [[d]] = await db.query('SELECT solicitud_correo_enviada s, solicitud_correo_error e FROM tickets WHERE id = ?', [id]);
      console.log(d.s ? `#${id} ${String(t.comercio).slice(0, 34)} → ✅ enviada a ${destino}` : `#${id}: ❌ ${d.e || 'no se marcó como enviada'}`);
    } catch (e) {
      console.log(`#${id}: ❌ ${e.message}`);
    }
  }
  process.exit(0);
})().catch((e) => { console.error('❌', e); process.exit(1); });
