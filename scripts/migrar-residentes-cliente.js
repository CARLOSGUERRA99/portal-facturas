// Los residentes pertenecen a un CLIENTE, no al sistema.
//
// Fernando Iribe, Angélica, GASOLINAS… son la gente de GPN. Sin dueño, el
// catálogo de residentes era global: el panel se los ofrecía a cualquier admin,
// incluido el de otro cliente. Con 30 clientes eso es una fuga — el admin de
// DGA vería los nombres de los empleados de GPN.
//
// Se les asigna el cliente #1 (GPN) porque es de donde salieron todos: se
// crearon cuando el portal era de un solo RFC.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const db = require('../lib/db');

const APLICAR = process.argv.includes('--aplicar');
const CLIENTE_ORIGEN = Number(process.env.CLIENTE || 1);

(async () => {
  const [col] = await db.query("SHOW COLUMNS FROM residentes LIKE 'cliente_id'");
  if (col.length) console.log('⏭️  residentes.cliente_id ya existe');
  else if (!APLICAR) console.log('   se añadiría residentes.cliente_id');
  else {
    await db.query('ALTER TABLE residentes ADD COLUMN cliente_id INT NULL');
    await db.query('ALTER TABLE residentes ADD INDEX idx_residentes_cliente (cliente_id)');
    console.log('✅ residentes.cliente_id añadida');
  }

  const [huerfanos] = await db.query('SELECT id, nombre FROM residentes WHERE cliente_id IS NULL');
  console.log(`\n${huerfanos.length} residente(s) sin cliente:`);
  for (const r of huerfanos) console.log(`   #${r.id} ${r.nombre}`);

  if (huerfanos.length && APLICAR) {
    await db.query('UPDATE residentes SET cliente_id = ? WHERE cliente_id IS NULL', [CLIENTE_ORIGEN]);
    console.log(`\n✅ asignados al cliente #${CLIENTE_ORIGEN}`);
  } else if (!APLICAR) {
    console.log(`\n(simulación — se asignarían al cliente #${CLIENTE_ORIGEN}; usa --aplicar)`);
  }

  const [fin] = await db.query(
    `SELECT c.nombre cliente, COUNT(r.id) residentes
       FROM residentes r LEFT JOIN clientes c ON c.id = r.cliente_id GROUP BY r.cliente_id`
  );
  console.log('');
  for (const f of fin) console.log(`   ${f.cliente || '(sin cliente)'}: ${f.residentes}`);
  process.exit(0);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
