// Da de alta un CLIENTE nuevo (otro RFC, otra empresa) en el portal.
//
// El sistema es multicliente: cada fila de `users` es un contribuyente con su
// propio RFC, domicilio y régimen, y sus tickets y facturas quedan aislados por
// user_id. Este script es el alta administrativa — no el registro público.
//
// La contraseña se genera aquí, aleatoria, y se guarda SOLO como hash bcrypt.
// Es temporal por diseño: el cliente debe cambiarla al primer acceso.
//
// Uso:
//   node scripts/alta-cliente.js                → muestra lo que haría
//   node scripts/alta-cliente.js --aplicar      → lo crea
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../lib/db');

const APLICAR = process.argv.includes('--aplicar');

// ── Datos leídos de la Constancia de Situación Fiscal (emitida 30/07/2026) ────
// idCIF 16020603575 · CURP GUAD770708HSRRVN08
const CLIENTE = {
  nombre: 'DANIEL ALEJANDRO GUERRA AVILA',
  email: 'trasladosdga@gmail.com',
  rfc: 'GUAD770708BQ0',
  razon_social: 'DANIEL ALEJANDRO GUERRA AVILA',   // persona física: va el nombre
  codigo_postal: '85096',
  // ⚠️ La constancia lista "Régimen de Incorporación Fiscal" (RIF) VIGENTE desde
  // el 15/05/2021, que en el catálogo del SAT es la clave 621. Se pone lo que
  // dice la constancia, no lo que uno supondría: el RegimenFiscalReceptor del
  // CFDI tiene que coincidir EXACTAMENTE con lo que el SAT tiene registrado, o
  // el PAC rechaza el timbrado (es el mismo tipo de fallo que el CFDI40147 que
  // ya nos tumbó una factura por el domicilio).
  regimen_fiscal: '621',
  uso_cfdi: 'G03',
  calle: 'PASEO VILLAFONTANA',
  num_ext: '1308',
  num_int: null,
  colonia: 'VILLA FONTANA',
  municipio: 'CAJEME',
  estado: 'SONORA',
  rol: 'residente',
};

// Contraseña temporal legible pero no adivinable: 4 bloques del alfabeto sin
// caracteres ambiguos (nada de O/0, l/1) para que se pueda dictar por teléfono.
function passwordTemporal() {
  const alfabeto = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bloque = () => Array.from(crypto.randomBytes(4))
    .map(b => alfabeto[b % alfabeto.length]).join('');
  return `${bloque()}-${bloque()}-${bloque()}`;
}

(async () => {
  const [ya] = await db.query('SELECT id, email, rfc FROM users WHERE email = ? OR rfc = ?',
    [CLIENTE.email, CLIENTE.rfc]);
  if (ya.length) {
    console.log(`⛔ Ya existe un usuario con ese correo o RFC: #${ya[0].id} ${ya[0].email} (${ya[0].rfc})`);
    console.log('   No se crea nada. Si hay que actualizarlo, hazlo desde el panel.');
    process.exit(0);
  }

  const clave = passwordTemporal();
  console.log('Se dará de alta:');
  for (const [k, v] of Object.entries(CLIENTE)) console.log(`   ${k.padEnd(15)} ${v ?? '—'}`);
  console.log(`   ${'password'.padEnd(15)} ${clave}   ← temporal, a cambiar en el primer acceso`);

  if (!APLICAR) { console.log('\n(simulación — usa --aplicar para crearlo)'); process.exit(0); }

  const hash = await bcrypt.hash(clave, 10);
  const [r] = await db.query(
    `INSERT INTO users (nombre, email, password_hash, rfc, razon_social, codigo_postal,
                        regimen_fiscal, uso_cfdi, calle, num_ext, num_int, colonia,
                        municipio, estado, rol, creado_por)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`,
    [CLIENTE.nombre, CLIENTE.email, hash, CLIENTE.rfc, CLIENTE.razon_social,
     CLIENTE.codigo_postal, CLIENTE.regimen_fiscal, CLIENTE.uso_cfdi, CLIENTE.calle,
     CLIENTE.num_ext, CLIENTE.num_int, CLIENTE.colonia, CLIENTE.municipio,
     CLIENTE.estado, CLIENTE.rol]
  );

  console.log(`\n✅ Cliente #${r.insertId} creado.`);
  console.log(`   Entra en https://timbra.serviciosga.site con ${CLIENTE.email}`);
  console.log(`   Contraseña temporal: ${clave}`);
  process.exit(0);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
