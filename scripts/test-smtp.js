/**
 * Diagnóstico de conectividad SMTP (READ-ONLY, no envía correos).
 * Prueba verify() en 465/SSL y 587/STARTTLS. No imprime la contraseña.
 * Uso: node scripts/test-smtp.js
 */
require('dotenv').config();
const nodemailer = require('nodemailer');

const auth = { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS };
const host = process.env.SMTP_HOST;

async function probar(nombre, cfg) {
  const t = nodemailer.createTransport({
    host, auth, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000, ...cfg,
  });
  const ini = Date.now();
  try {
    await t.verify();
    console.log(`✅ ${nombre} OK — conexión + auth exitosas (${Date.now() - ini}ms)`);
    return true;
  } catch (e) {
    console.log(`❌ ${nombre} falló: ${e.message} (code=${e.code || 'n/a'}, ${Date.now() - ini}ms)`);
    return false;
  }
}

(async () => {
  console.log(`Host: ${host} | User: ${auth.user} | Pass: ${auth.pass ? '(definida)' : '(VACÍA ❌)'}\n`);
  await probar('465 / SSL (secure:true)',     { port: 465, secure: true });
  await probar('587 / STARTTLS (secure:false)', { port: 587, secure: false, requireTLS: true });
  process.exit(0);
})();
