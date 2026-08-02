// Da de alta un LOGIN. Distinto de scripts/alta-cliente.js, que da de alta un
// CONTRIBUYENTE. Desde la separación multicliente son dos cosas:
//
//   · cliente = quién paga impuestos (RFC, régimen, domicilio).
//   · usuario = quién entra al portal. Cuelga de un cliente… salvo el dueño de
//     la plataforma, que no pertenece a ninguno.
//
// Los tres casos que existen:
//
//   1. DUEÑO DE LA PLATAFORMA (Servicios Administrativos G&A)
//      --plataforma --rol admin   → cliente_id NULL, ve a todos los clientes.
//
//   2. ADMIN DE UN CLIENTE (quien manda dentro de GPN)
//      --cliente 1 --rol admin
//
//   3. CAPTURISTA DE UN CLIENTE (las muchachas de GPN)
//      --cliente 1 --rol residente
//
// Ojo con el caso 3: solo tiene sentido si el cliente tiene
// permite_subusuarios = 1. Una persona física como Daniel Ávila factura sola,
// y crear logins sueltos bajo su RFC sería justo lo que la separación evita.
//
// La contraseña se genera aquí y solo se guarda como hash bcrypt.
//
// Uso:
//   node scripts/alta-usuario.js --email facturas@serviciosga.site \
//        --nombre "Servicios Administrativos G&A" --plataforma --rol admin --aplicar
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../lib/db');

const arg = (n, def = null) => {
  const i = process.argv.indexOf(`--${n}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
};
const flag = (n) => process.argv.includes(`--${n}`);

const APLICAR    = flag('aplicar');
const EMAIL      = arg('email');
const NOMBRE     = arg('nombre');
const ROL        = arg('rol', 'residente');
const PLATAFORMA = flag('plataforma');
const CLIENTE_ID = arg('cliente') ? Number(arg('cliente')) : null;

// Alfabeto sin caracteres ambiguos (nada de O/0 ni l/1): la contraseña temporal
// se suele dictar por teléfono.
function passwordTemporal() {
  const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bloque = () => Array.from(crypto.randomBytes(4)).map(b => abc[b % abc.length]).join('');
  return `${bloque()}-${bloque()}-${bloque()}`;
}

(async () => {
  if (!EMAIL || !NOMBRE) {
    console.error('faltan --email y --nombre');
    process.exit(1);
  }
  if (!PLATAFORMA && !CLIENTE_ID) {
    console.error('indica --cliente <id> o --plataforma (un login tiene que pertenecer a alguien, o a nadie a propósito)');
    process.exit(1);
  }
  if (!['admin', 'residente'].includes(ROL)) { console.error('--rol debe ser admin o residente'); process.exit(1); }

  const [ya] = await db.query('SELECT id, email FROM users WHERE email = ?', [EMAIL]);
  if (ya.length) { console.log(`⛔ Ya existe el usuario #${ya[0].id} con ese correo`); process.exit(0); }

  let cliente = null;
  if (CLIENTE_ID) {
    const [[c]] = await db.query('SELECT id, nombre, rfc, permite_subusuarios FROM clientes WHERE id = ?', [CLIENTE_ID]);
    if (!c) { console.error(`no existe el cliente #${CLIENTE_ID}`); process.exit(1); }
    cliente = c;
    if (ROL === 'residente' && !c.permite_subusuarios) {
      console.error(`⛔ El cliente "${c.nombre}" tiene permite_subusuarios = 0.`);
      console.error('   Si de verdad debe tener capturistas, actívalo antes en la tabla clientes.');
      process.exit(1);
    }
  }

  console.log(`Se creará el login: ${EMAIL}`);
  console.log(`   nombre  ${NOMBRE}`);
  console.log(`   rol     ${ROL}`);
  console.log(`   ámbito  ${PLATAFORMA ? 'PLATAFORMA (G&A) — ve todos los clientes' : `cliente #${cliente.id} ${cliente.nombre} (${cliente.rfc})`}`);

  const clave = passwordTemporal();
  console.log(`   clave   ${clave}   ← temporal`);
  if (!APLICAR) { console.log('\n(simulación — usa --aplicar)'); process.exit(0); }

  const hash = await bcrypt.hash(clave, 10);
  const [r] = await db.query(
    'INSERT INTO users (cliente_id, nombre, email, password_hash, rol, creado_por) VALUES (?,?,?,?,?,1)',
    [PLATAFORMA ? null : cliente.id, NOMBRE, EMAIL, hash, ROL]
  );
  console.log(`\n✅ Usuario #${r.insertId} creado.`);
  console.log(`   https://timbra.serviciosga.site  ·  ${EMAIL}  ·  ${clave}`);
  process.exit(0);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
