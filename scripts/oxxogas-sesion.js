/**
 * Guarda la cookie de sesión de OXXO GAS para que el bot pueda facturar, y la
 * comprueba contra el portal antes de darla por buena.
 *
 * Por qué existe: facturacion.oxxogas.com tiene reCAPTCHA v2 EN EL LOGIN. El
 * formulario de facturación (RFC → Estación → Folio → Monto → Facturar) NO tiene
 * captcha en ningún paso — el único obstáculo es entrar. Así que basta con que
 * una persona inicie sesión UNA vez y el bot reutilice esa sesión hasta que
 * caduque.
 *
 * Antes eso exigía copiar hasta cuatro cookies a mano y pasarlas como variables
 * de entorno en cada invocación, que es justo la clase de trámite que no se hace
 * y deja los tickets parados. Aquí se guardan una vez y el bot las toma solo.
 *
 * CÓMO OBTENER LA COOKIE (2 minutos):
 *   1. Entra a https://facturacion.oxxogas.com en tu navegador y haz login
 *      normal (tú resuelves el captcha).
 *   2. F12 → Application → Cookies → facturacion.oxxogas.com
 *   3. Copia el VALOR de `ci_sessions`. Si ves cookies `incap_ses_*` o
 *      `visid_incap_*`, cópialas también (son del WAF y ayudan a que no te
 *      corte).
 *
 * Uso:
 *   node scripts/oxxogas-sesion.js --ci <valor_ci_sessions>
 *   node scripts/oxxogas-sesion.js --ci <valor> --incap117 <v> --incap363 <v> --visid <v>
 *   node scripts/oxxogas-sesion.js --estado      → dice si la sesión guardada sigue viva
 *
 * La sesión se guarda en la tabla `config` (no en .env ni en el código: son
 * credenciales de sesión reales y el .env se versiona por error con demasiada
 * facilidad).
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const db = require('../lib/db');

const args = process.argv.slice(2);
const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const SOLO_ESTADO = args.includes('--estado');

const CLAVE = 'oxxogas_sesion';

async function asegurarTabla() {
  await db.query(`CREATE TABLE IF NOT EXISTS config (
    clave VARCHAR(64) PRIMARY KEY,
    valor TEXT,
    actualizado DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);
}

// Comprueba la sesión pidiendo una página que SOLO responde a un usuario
// autenticado. Si devuelve el login, la cookie no sirve — y es mejor saberlo
// ahora que cuando el bot esté a medio facturar.
async function verificar(cookies) {
  const cookieStr = Object.entries(cookies).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('; ');
  const r = await fetch('https://facturacion.oxxogas.com/facturacion', {
    headers: {
      Cookie: cookieStr,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0 Safari/537.36',
      'Accept-Language': 'es-MX,es;q=0.9',
    },
    redirect: 'follow',
  });
  const html = await r.text();
  const esLogin = /g-recaptcha|type=["']password["']|iniciar sesi/i.test(html);
  const esPortal = /facturaci[oó]n|estaci[oó]n|folio/i.test(html) && !esLogin;
  return { status: r.status, url: r.url, viva: esPortal, esLogin, muestra: html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 180) };
}

(async () => {
  await asegurarTabla();

  if (SOLO_ESTADO) {
    const [[fila]] = await db.query('SELECT valor, actualizado FROM config WHERE clave = ?', [CLAVE]);
    if (!fila) { console.log('❌ No hay ninguna sesión guardada. Corre este script con --ci <valor>.'); process.exit(1); }
    const cookies = JSON.parse(fila.valor);
    console.log(`🍪 Sesión guardada el ${new Date(fila.actualizado).toLocaleString('es-MX')}`);
    const v = await verificar(cookies);
    console.log(v.viva ? '✅ La sesión SIGUE VIVA — el bot puede facturar.' : '❌ La sesión ya NO sirve: vuelve a iniciar sesión y guárdala otra vez.');
    console.log(`   HTTP ${v.status} · ${v.url}`);
    if (!v.viva) console.log(`   respuesta: ${v.muestra}`);
    process.exit(v.viva ? 0 : 2);
  }

  const ci = val('--ci');
  if (!ci) {
    console.error('Uso: node scripts/oxxogas-sesion.js --ci <valor_ci_sessions> [--incap117 v] [--incap363 v] [--visid v]');
    console.error('     node scripts/oxxogas-sesion.js --estado');
    process.exit(1);
  }
  const cookies = {
    ci_sessions: ci,
    incap_ses_117_3020163: val('--incap117') || undefined,
    incap_ses_363_3020163: val('--incap363') || undefined,
    visid_incap_3020163: val('--visid') || undefined,
  };

  console.log('🔎 Comprobando la sesión contra el portal antes de guardarla...');
  const v = await verificar(cookies);
  if (!v.viva) {
    console.error('❌ Esa cookie NO abre el portal — no se guarda nada.');
    console.error(`   HTTP ${v.status} · ${v.url}`);
    console.error(`   respuesta: ${v.muestra}`);
    console.error('   Revisa que copiaste el valor de `ci_sessions` DESPUÉS de iniciar sesión.');
    process.exit(2);
  }

  await db.query(
    'INSERT INTO config (clave, valor) VALUES (?, ?) ON DUPLICATE KEY UPDATE valor = VALUES(valor)',
    [CLAVE, JSON.stringify(cookies)]
  );
  console.log('✅ Sesión verificada y guardada. El bot de OXXO GAS ya puede facturar.');

  const [pend] = await db.query(
    `SELECT id, comercio FROM tickets
      WHERE (ocr_json LIKE '%oxxogas%' OR LOWER(comercio) LIKE '%oxxo gas%')
        AND NOT EXISTS (SELECT 1 FROM facturas f WHERE f.ticket_id = tickets.id)`
  );
  if (pend.length) {
    console.log(`\n📋 ${pend.length} ticket(s) de OXXO GAS esperando:`);
    for (const t of pend) console.log(`   #${t.id} ${t.comercio}`);
    console.log(`\n   node scripts/correr-ticket.js ${pend.map((t) => t.id).join(' ')}`);
  }
  process.exit(0);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
