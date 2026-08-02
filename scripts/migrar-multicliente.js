// Separa "quién paga impuestos" de "quién se loguea".
//
// ── EL PROBLEMA ──────────────────────────────────────────────────────────────
// Hasta ahora una fila de `users` era las dos cosas a la vez: el login Y el
// contribuyente con su RFC. Eso funcionaba con un solo RFC (GPN), pero el
// producto es de SERVICIOS ADMINISTRATIVOS G&A y GPN es solo su primer cliente.
//
// Con el modelo viejo, dar de alta a las muchachas de GPN para que facturen
// obligaba a duplicarles el RFC en cada login — y a la primera corrección de
// domicilio habría que tocarlos todos, con el riesgo de que uno quede
// desactualizado y timbre mal. Ya nos pasó algo así con RAMCAL.
//
// ── EL MODELO ────────────────────────────────────────────────────────────────
//   clientes  → el CONTRIBUYENTE: RFC, régimen, domicilio, constancia. Uno por
//               cada cliente de G&A. GPN (moral, 601) y Daniel Ávila (física,
//               621) son dos clientes distintos, no dos usuarios.
//   users     → el LOGIN, con cliente_id. GPN tendrá varios (las muchachas);
//               Daniel Ávila, uno solo. La misma persona no comparte RFC con
//               otro cliente jamás.
//   tickets   → siguen colgando de user_id; los datos fiscales se resuelven
//               por el cliente de ese usuario.
//
// Los bots y el agente NO se tocan: son de la plataforma y se comparten entre
// todos los clientes. Ahí está el valor — cada portal nuevo que se automatiza
// sirve para los 30 clientes a la vez.
//
// La migración es ADITIVA: no borra ni renombra columnas. `users` conserva sus
// campos fiscales para que nada existente deje de funcionar mientras se migra
// el código; la fuente de verdad pasa a ser `clientes`.
//
// Uso: node scripts/migrar-multicliente.js [--aplicar]
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const db = require('../lib/db');

const APLICAR = process.argv.includes('--aplicar');
const paso = (t) => console.log(`\n── ${t}`);

(async () => {
  const [[{ hayTabla }]] = await db.query(
    "SELECT COUNT(*) hayTabla FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'clientes'"
  );

  paso('1. Tabla `clientes`');
  if (hayTabla) console.log('   ya existe');
  else if (!APLICAR) console.log('   se crearía');
  else {
    await db.query(`
      CREATE TABLE clientes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        nombre          VARCHAR(200) NOT NULL,
        rfc             VARCHAR(20)  NOT NULL UNIQUE,
        razon_social    VARCHAR(200),
        tipo_persona    ENUM('fisica','moral') NOT NULL DEFAULT 'moral',
        codigo_postal   VARCHAR(10),
        regimen_fiscal  VARCHAR(10),
        uso_cfdi        VARCHAR(10) DEFAULT 'G03',
        calle           VARCHAR(200),
        num_ext         VARCHAR(20),
        num_int         VARCHAR(20),
        colonia         VARCHAR(100),
        municipio       VARCHAR(100),
        estado          VARCHAR(50),
        constancia_url  TEXT,
        email_contacto  VARCHAR(100),
        -- Comerciales: para saber a quién se le factura el servicio y desde
        -- cuándo. La prueba gratis tiene fecha de fin, no se queda en el aire.
        mensualidad     DECIMAL(10,2) DEFAULT 0,
        estado_cuenta   ENUM('prueba','activo','suspendido') NOT NULL DEFAULT 'prueba',
        prueba_hasta    DATE NULL,
        -- Permite sub-usuarios (GPN sí, una persona física normalmente no).
        permite_subusuarios TINYINT(1) NOT NULL DEFAULT 0,
        creado          TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);
    console.log('   ✅ creada');
  }

  paso('2. Columna `users.cliente_id`');
  const [colU] = await db.query("SHOW COLUMNS FROM users LIKE 'cliente_id'");
  if (colU.length) console.log('   ya existe');
  else if (!APLICAR) console.log('   se añadiría');
  else {
    await db.query('ALTER TABLE users ADD COLUMN cliente_id INT NULL AFTER id');
    await db.query('ALTER TABLE users ADD INDEX idx_users_cliente (cliente_id)');
    console.log('   ✅ añadida');
  }

  paso('3. Un cliente por cada RFC que ya exista en `users`');
  const [usuarios] = await db.query(
    `SELECT id, nombre, email, rfc, razon_social, codigo_postal, regimen_fiscal,
            uso_cfdi, calle, num_ext, num_int, colonia, municipio, estado,
            constancia_url, rol
       FROM users WHERE rfc IS NOT NULL AND rfc <> '' ORDER BY id`
  );
  for (const u of usuarios) {
    // Persona física si el RFC tiene 13 caracteres; moral si 12.
    const fisica = String(u.rfc).trim().length === 13;
    console.log(`   ${u.rfc}  ${u.razon_social || u.nombre}  (${fisica ? 'física' : 'moral'}, rég ${u.regimen_fiscal || '?'})`);
    if (!APLICAR) continue;

    const [ya] = await db.query('SELECT id FROM clientes WHERE rfc = ?', [u.rfc]);
    let clienteId = ya.length ? ya[0].id : null;
    if (!clienteId) {
      const [r] = await db.query(
        `INSERT INTO clientes (nombre, rfc, razon_social, tipo_persona, codigo_postal,
           regimen_fiscal, uso_cfdi, calle, num_ext, num_int, colonia, municipio,
           estado, constancia_url, email_contacto, permite_subusuarios, estado_cuenta)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [u.razon_social || u.nombre, u.rfc, u.razon_social, fisica ? 'fisica' : 'moral',
         u.codigo_postal, u.regimen_fiscal, u.uso_cfdi || 'G03', u.calle, u.num_ext,
         u.num_int, u.colonia, u.municipio, u.estado, u.constancia_url, u.email,
         // Una persona física factura ella sola; una moral suele tener quien
         // capture por ella. Se puede cambiar cliente por cliente.
         fisica ? 0 : 1,
         'activo']
      );
      clienteId = r.insertId;
      console.log(`      → cliente #${clienteId} creado`);
    }
    await db.query('UPDATE users SET cliente_id = ? WHERE id = ?', [clienteId, u.id]);
    console.log(`      → user #${u.id} enlazado al cliente #${clienteId}`);
  }

  if (APLICAR) {
    paso('4. Comprobación');
    const [v] = await db.query(
      `SELECT u.id user_id, u.email, u.rol, c.id cliente_id, c.rfc, c.regimen_fiscal,
              c.tipo_persona, c.permite_subusuarios
         FROM users u LEFT JOIN clientes c ON c.id = u.cliente_id ORDER BY u.id`
    );
    for (const r of v) console.log('   ' + JSON.stringify(r));
    const [[{ huerfanos }]] = await db.query(
      "SELECT COUNT(*) huerfanos FROM users WHERE cliente_id IS NULL AND rfc IS NOT NULL AND rfc <> ''"
    );
    console.log(huerfanos ? `   ⚠️ ${huerfanos} usuario(s) con RFC y sin cliente` : '   ✅ ningún usuario con RFC quedó sin cliente');
  } else {
    console.log('\n(simulación — usa --aplicar para escribir)');
  }
  process.exit(0);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
