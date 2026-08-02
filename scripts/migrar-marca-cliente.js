// Añade a `clientes` los campos de MARCA, para que cada cliente vea su propio
// portal y no el de otro.
//
// Por qué importa comercialmente: G&A le vende a ~30 clientes el mismo motor,
// pero lo que el cliente ve tiene que sentirse SUYO. Es la diferencia entre
// "uso un software de un tercero" y "este es mi portal de facturación".
//
// Se guarda lo mínimo que cambia la percepción y nada más:
//   marca_nombre → el título de la barra ("Timbra" para GPN, otro para Daniel)
//   marca_logo   → URL del logo en R2
//   marca_color  → color principal en hexadecimal
//
// Si un cliente no tiene marca propia, hereda la de G&A. Nadie ve una pantalla
// rota por no haber subido un logo.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const db = require('../lib/db');

const APLICAR = process.argv.includes('--aplicar');

const COLUMNAS = [
  ['marca_nombre', "VARCHAR(60) NULL"],
  ['marca_logo',   "TEXT NULL"],
  ['marca_color',  "VARCHAR(9) NULL"],
];

(async () => {
  const [cols] = await db.query('SHOW COLUMNS FROM clientes');
  const existentes = new Set(cols.map((c) => c.Field));

  for (const [nombre, tipo] of COLUMNAS) {
    if (existentes.has(nombre)) { console.log(`⏭️  ${nombre} ya existe`); continue; }
    if (!APLICAR) { console.log(`   se añadiría ${nombre} ${tipo}`); continue; }
    await db.query(`ALTER TABLE clientes ADD COLUMN ${nombre} ${tipo}`);
    console.log(`✅ ${nombre} añadida`);
  }

  if (APLICAR) {
    // GPN ya venía usando la marca Timbra: se deja tal cual para no cambiarle
    // el portal de debajo de los pies a quien ya lo está usando.
    await db.query(
      "UPDATE clientes SET marca_nombre = COALESCE(marca_nombre, 'Timbra'), marca_color = COALESCE(marca_color, '#7B1220') WHERE id = 1"
    );
    const [r] = await db.query('SELECT id, nombre, marca_nombre, marca_color, marca_logo FROM clientes');
    console.log('');
    for (const c of r) console.log('   ' + JSON.stringify(c));
  } else {
    console.log('\n(simulación — usa --aplicar)');
  }
  process.exit(0);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
