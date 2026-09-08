// Solicitud de factura POR CORREO al comercio, para tickets que ningun bot
// puede facturar (portal con captcha, plazo vencido, o el comercio emite a
// mano). Adjunta la constancia de situacion fiscal y la foto del ticket.
//
// Vivia dentro de server.js, lo que impedia usarla desde un script o desde el
// worker: para importarla habia que cargar server.js entero, que arranca el
// servidor. Se extrajo tal cual, sin cambios de comportamiento.
const db = require("./db");
const { enviarCorreo } = require("./correo");
const { crearNotificacion } = require("./util");
// Copia de TODA solicitud de factura por correo. Se deja configurable por
// entorno para que un cliente distinto de GPN pueda apuntar a su propio
// administrador sin tocar código.
const COPIA_SOLICITUDES = process.env.COPIA_SOLICITUDES || 'carlosguerra@grupogpn.com';

async function enviarSolicitudPorCorreo(ticket) {
  const { id: ticketId, comercio, email_contacto, user_nombre, user_email,
          rfc, razon_social, constancia_url, ocr_json, formaPago, ruta_archivo,
          cliente_nombre } = ticket;
  // El sistema es multi-cliente (GPN, DGA, ...) pero este correo lo recibe el
  // COMERCIO, no el residente — si siempre dice "GPN" para un cliente distinto
  // confunde al comercio sobre a nombre de quién está facturando.
  const marca = cliente_nombre || 'GPN Pinturas y Recubrimientos';

  console.log(`📨 Enviando solicitud de factura por correo — ticket #${ticketId} → ${email_contacto}`);

  // Descargar constancia desde R2
  let constanciaBuffer = null;
  let constanciaFilename = 'constancia.pdf';
  try {
    const resp = await fetch(constancia_url);
    if (resp.ok) {
      constanciaBuffer = Buffer.from(await resp.arrayBuffer());
      const ext = constancia_url.split('.').pop().split('?')[0].toLowerCase();
      constanciaFilename = `constancia_${(rfc || 'cliente').replace(/[^a-z0-9]/gi, '')}.${ext}`;
    }
  } catch (e) {
    console.log(`⚠️ No se pudo descargar constancia: ${e.message}`);
  }

  // Datos del ticket para el correo
  let datosTicket = {};
  try { datosTicket = JSON.parse(ocr_json || '{}'); } catch {}
  const folioInfo = datosTicket.folio ? ` (Folio: ${datosTicket.folio})` : '';
  const totalInfo = datosTicket.total ? ` — Total: $${datosTicket.total}` : '';
  const fechaInfo = datosTicket.fecha ? ` del ${datosTicket.fecha}` : '';

  const attachments = [];
  if (constanciaBuffer) {
    attachments.push({
      filename: constanciaFilename,
      content: constanciaBuffer,
      contentType: constancia_url.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg',
    });
  }

  // Adjuntar la imagen del ticket original si está guardada en R2
  let ticketAdjuntado = false;
  if (ruta_archivo && /^https?:\/\//i.test(ruta_archivo)) {
    try {
      const respT = await fetch(ruta_archivo);
      if (respT.ok) {
        const ticketBuf = Buffer.from(await respT.arrayBuffer());
        const extT = (ruta_archivo.split('.').pop().split('?')[0] || 'jpg').toLowerCase();
        attachments.push({
          filename: `ticket_${(comercio || 'compra').replace(/[^a-z0-9]/gi, '')}.${extT}`,
          content: ticketBuf,
          contentType: extT === 'pdf' ? 'application/pdf' : (extT === 'png' ? 'image/png' : 'image/jpeg'),
        });
        ticketAdjuntado = true;
        console.log(`🖼️ Imagen del ticket adjuntada (${ticketBuf.length} bytes)`);
      }
    } catch (e) {
      console.log(`⚠️ No se pudo adjuntar imagen del ticket: ${e.message}`);
    }
  }

  const mailOptions = {
    from: `"${marca} — Facturación" <${process.env.SMTP_USER || 'buzonfacturas@serviciosga.site'}>`,
    to: email_contacto,
    // Copia al administrador: estas solicitudes las contesta el COMERCIO por
    // fuera del sistema (manda el CFDI cuando quiere, o pide algo más), así que
    // sin copia nadie del lado de GPN se entera de que salió ni puede darle
    // seguimiento. El buzón de captura no sirve para esto: solo mira adjuntos.
    cc: COPIA_SOLICITUDES,
    replyTo: user_email || undefined,
    subject: `Solicitud de factura — ${rfc || 'Cliente'} — ${comercio || 'Ticket'}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <div style="background:#3B6D11;padding:20px;border-radius:12px 12px 0 0;">
          <h2 style="color:#fff;margin:0;">Solicitud de Factura Electrónica</h2>
          <p style="color:#C0DD97;margin:4px 0 0;">${comercio || 'Comercio'}</p>
        </div>
        <div style="background:#f8faf6;padding:24px;border-radius:0 0 12px 12px;border:1px solid #e0edd5;">
          <p>Por este medio solicito la emisión de mi factura electrónica (CFDI) con los siguientes datos fiscales:</p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0;">
            <tr style="background:#eaf3de;"><td style="padding:8px 12px;font-weight:bold;width:40%;">RFC</td><td style="padding:8px 12px;">${rfc || 'N/A'}</td></tr>
            <tr><td style="padding:8px 12px;font-weight:bold;">Razón Social</td><td style="padding:8px 12px;">${razon_social || 'N/A'}</td></tr>
            <tr style="background:#eaf3de;"><td style="padding:8px 12px;font-weight:bold;">Ticket</td><td style="padding:8px 12px;">${comercio || ''}${folioInfo}${fechaInfo}${totalInfo}</td></tr>
            <tr><td style="padding:8px 12px;font-weight:bold;">Forma de pago</td><td style="padding:8px 12px;">${formaPago || 'Efectivo'}</td></tr>
            <tr style="background:#eaf3de;"><td style="padding:8px 12px;font-weight:bold;">Uso de CFDI</td><td style="padding:8px 12px;">Gastos en general (G03)</td></tr>
            <tr><td style="padding:8px 12px;font-weight:bold;">Correo de respuesta</td><td style="padding:8px 12px;">${user_email || 'Ver en adjunto'}</td></tr>
          </table>
          <p>Adjunto mi constancia de situación fiscal del SAT${ticketAdjuntado ? ' y la imagen del ticket de compra' : ''}.</p>
          <p style="color:#666;font-size:0.85rem;">Este correo fue generado automáticamente por ${marca} — Portal de Facturación.</p>
        </div>
      </div>`,
    attachments,
  };

  // El correo sale por Brevo (Railway bloquea SMTP); SMTP solo es el fallback
  // local. Esta guarda exigía SMTP_HOST/SMTP_USER aunque hubiera BREVO_API_KEY,
  // así que en un entorno con Brevo pero sin las variables SMTP legacy la
  // solicitud se descartaba antes de intentarlo.
  if (!process.env.BREVO_API_KEY && (!process.env.SMTP_HOST || !process.env.SMTP_USER)) {
    const errMsg = 'Sin BREVO_API_KEY ni SMTP configurado — no se puede enviar correo';
    console.log(`⚠️ ${errMsg}`);
    await db.query(
      "UPDATE tickets SET solicitud_correo_error = ? WHERE id = ?",
      [errMsg, ticketId]
    );
    return;
  }

  try {
    await enviarCorreo(mailOptions);
    await db.query(
      "UPDATE tickets SET solicitud_correo_enviada = 1, solicitud_correo_fecha = NOW(), solicitud_correo_error = NULL WHERE id = ?",
      [ticketId]
    );
    console.log(`✅ Solicitud de factura enviada — ticket #${ticketId} → ${email_contacto}`);

    // Notificar al usuario que el correo fue enviado
    await crearNotificacion(ticket.user_id || null, 'factura_ok',
      `Tu solicitud de factura de ${comercio} fue enviada a ${email_contacto}. Te contactarán cuando esté lista.`
    ).catch(() => {});
  } catch (e) {
    console.error(`❌ Error enviando correo ticket #${ticketId}:`, e.message);
    await db.query(
      "UPDATE tickets SET solicitud_correo_error = ? WHERE id = ?",
      [e.message.substring(0, 500), ticketId]
    );
  }
}

module.exports = { enviarSolicitudPorCorreo, COPIA_SOLICITUDES };
