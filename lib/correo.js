// Envío de correo saliente. Railway BLOQUEA el SMTP saliente (25/465/587/2525 →
// ETIMEDOUT), así que en producción TODO sale por la API HTTP de Brevo (puerto 443).
// El transporter SMTP de nodemailer queda como fallback para entorno local.
// Acepta el mismo shape que nodemailer.sendMail():
//   { from, to, replyTo, subject, html, attachments }
const nodemailer = require("nodemailer");

const SMTP_PORT = parseInt(process.env.SMTP_PORT) || 465;
// `secure` DEBE coincidir con el puerto: 465 = SSL implícito (true); 587/25/2525 = STARTTLS (false).
const SMTP_SECURE = SMTP_PORT === 465 ? true : (process.env.SMTP_SECURE === 'true');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_SECURE,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  connectionTimeout: 10000,
  greetingTimeout: 10000,
  socketTimeout: 15000,
});

function _parseFrom(from) {
  const m = String(from || '').match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: (m[1] || '').trim() || undefined, email: m[2].trim() };
  return { email: String(from || process.env.SMTP_USER || 'buzonfacturas@serviciosga.site').trim() };
}

async function enviarCorreo(opts) {
  if (process.env.BREVO_API_KEY) {
    const sender = _parseFrom(opts.from);
    const destinatarios = (Array.isArray(opts.to) ? opts.to : String(opts.to || '').split(','))
      .map(e => String(e).trim()).filter(Boolean).map(email => ({ email }));
    const body = { sender, to: destinatarios, subject: opts.subject || '', htmlContent: opts.html || opts.text || ' ' };
    if (opts.replyTo) body.replyTo = { email: String(opts.replyTo).trim() };
    if (opts.attachments && opts.attachments.length) {
      body.attachment = opts.attachments.map(a => ({
        name: a.filename || 'adjunto',
        content: Buffer.isBuffer(a.content) ? a.content.toString('base64') : Buffer.from(a.content || '').toString('base64'),
      }));
    }
    const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      throw new Error(`Brevo ${resp.status}: ${txt.slice(0, 300)}`);
    }
    return { via: 'brevo' };
  }
  // Fallback SMTP (entorno local / dev donde el puerto no está bloqueado)
  return transporter.sendMail(opts).then(() => ({ via: 'smtp' }));
}

module.exports = { enviarCorreo, transporter };
