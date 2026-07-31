require("dotenv").config();
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const path = require("path");
const multer = require("multer");
const fs = require("fs");
const { execSync } = require("child_process");
const { activarBot } = require("./agentes/orquestador");
const { subirArchivoR2, borrarArchivoR2, listarArchivosR2 } = require("./storage/r2");

// ── FASE 1: módulos compartidos con el worker ────────────────────────────────
// El servidor web ya NO ejecuta OCR, bots ni agentes: solo encola trabajos en
// Redis y responde de inmediato. El procesamiento vive en worker.js.
const db = require("./lib/db");
const { enviarCorreo } = require("./lib/correo");
const { crearNotificacion, renombrarConUUID } = require("./lib/util");
const { camposPorPortal } = require("./lib/vision");
const {
  encolarVision, encolarBot, encolarAgente, encolarOrquestacionManual, agenteQueue,
  listarColaMuerta, reintentarJobMuerto, borrarJobMuerto,
} = require("./queues");
const { RedisStore } = require("connect-redis");
const IORedis = require("ioredis");

const app = express();

// ── Diagnóstico TEMPORAL: valida la llave de Brevo desde Railway (sin enviar correo) ──
app.get('/api/diag-mail', async (req, res) => {
  const out = { brevoKeySet: !!process.env.BREVO_API_KEY };
  if (process.env.BREVO_API_KEY) {
    try {
      const r = await fetch('https://api.brevo.com/v3/account', {
        headers: { 'api-key': process.env.BREVO_API_KEY, accept: 'application/json' },
      });
      out.brevoKeyValid = r.ok;
      out.brevoStatus = r.status;
      if (!r.ok) out.brevoBody = (await r.text().catch(() => '')).slice(0, 200);
    } catch (e) { out.brevoError = e.message; }
  }
  // Prueba de conectividad IMAP (recepción de facturas por correo) desde Railway
  try {
    const Imap = require('imap');
    out.imap = await new Promise((resolve) => {
      const imap = new Imap({
        user: process.env.IMAP_USER, password: process.env.IMAP_PASS,
        host: process.env.IMAP_HOST, port: parseInt(process.env.IMAP_PORT) || 993,
        tls: true, tlsOptions: { rejectUnauthorized: false }, connTimeout: 8000, authTimeout: 8000,
      });
      const ini = Date.now();
      let done = false;
      const fin = (r) => { if (!done) { done = true; try { imap.end(); } catch {} resolve({ ...r, ms: Date.now() - ini }); } };
      imap.once('ready', () => fin({ ok: true }));
      imap.once('error', (e) => fin({ ok: false, err: e.message, code: e.code || null }));
      setTimeout(() => fin({ ok: false, err: 'timeout' }), 9000);
      try { imap.connect(); } catch (e) { fin({ ok: false, err: e.message }); }
    });
  } catch (e) { out.imap = { ok: false, err: e.message }; }
  res.json(out);
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

if (!process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET no configurada (Railway → Variables)");
}
// SIN_REDIS=1 es la salida explícita para levantar el servidor en local: el
// Redis de Railway vive en la red privada y no es alcanzable desde fuera. En
// ese modo la sesión usa el MemoryStore de express-session (se pierde al
// reiniciar y no vale con varias réplicas — por eso NO se usa en producción).
const SIN_REDIS = process.env.SIN_REDIS === "1";
if (!process.env.REDIS_URL && !SIN_REDIS) {
  throw new Error("REDIS_URL no configurada — la sesión requiere Redis (Railway → servicio Redis → variable REDIS_URL)");
}

// ── FASE 5: sesión persistente en Redis (antes MemoryStore: se perdía en cada
// restart/deploy, y no sirve si el web service llega a correr con >1 réplica).
// Conexión dedicada, separada de la de BullMQ en queues/index.js (esa usa
// maxRetriesPerRequest:null, pensado para Workers, no para un store de sesión).
const sessionRedis = SIN_REDIS ? null : new IORedis(process.env.REDIS_URL, {
  // Railway: la red privada (*.railway.internal) es IPv6-only y ioredis por
  // defecto resuelve solo IPv4 → ETIMEDOUT. family 0 = autodetectar (dual).
  family: 0,
});
if (sessionRedis) sessionRedis.on("error", (e) => console.error("⚠️ [session-redis]", e.message));

app.set("trust proxy", 1);
app.use(session({
  ...(sessionRedis ? { store: new RedisStore({ client: sessionRedis, prefix: "sess:" }) } : {}),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  name: "pf.sid",
  cookie: {
    httpOnly: true,
    // Railway (RAILWAY_ENVIRONMENT) siempre sirve HTTPS; en local (node server.js
    // sin Railway) no hay TLS, así que "secure" se desactiva para no romper el
    // login al probar localmente.
    secure: !!process.env.RAILWAY_ENVIRONMENT,
    sameSite: "lax",
    maxAge: 1000 * 60 * 60 * 24 * 7, // 7 días
  },
}));

// ── MODO MANTENIMIENTO ──
// Activar/desactivar desde Railway: variable MANTENIMIENTO=true
// Bypass para admin: agregar ?bypass=gpnadmin a cualquier URL
if (process.env.MANTENIMIENTO === 'true') {
  app.use((req, res, next) => {
    if (req.query.bypass === 'gpnadmin') return next();
    if (req.path === '/mantenimiento.html') return next();
    if (req.path.startsWith('/api/whatsapp')) return next(); // webhook siempre activo
    res.status(503).sendFile(path.join(__dirname, 'public', 'mantenimiento.html'));
  });
}

app.use(express.static(path.join(__dirname, "public")));

const facturasDir = path.join(__dirname, "facturas");
if (!fs.existsSync(facturasDir)) fs.mkdirSync(facturasDir, { recursive: true });
app.use("/facturas", express.static(facturasDir));

// ── CONSTANTES ──
const ADMIN_EMAIL = "carlosguerra@grupogpn.com";
const ADMIN_RESIDENTES = ["Luis Miguel", "Ines Beltran", "Jose Aparicio"];
const DEFAULT_RESIDENTES = [
  { nombre: "Fernando Iribe",    disponible: 1 },
  { nombre: "Angelica",          disponible: 1 },
  { nombre: "Cesar Payan",       disponible: 1 },
  { nombre: "Jesus Beltran",     disponible: 1 },
  { nombre: "Alejandro Beltran", disponible: 1 },
  { nombre: "Luis Miguel",       disponible: 0 },
  { nombre: "Ines Beltran",      disponible: 0 },
  { nombre: "Jose Aparicio",     disponible: 0 },
  { nombre: "Fernando Ramos",    disponible: 1 },
];

function getRol(email) {
  if (email === ADMIN_EMAIL) return "admin";
  if (email.endsWith("@grupogpn.com")) return "residente";
  return "residente";
}

async function assignAdminResidentes(adminId) {
  for (const nombre of ADMIN_RESIDENTES) {
    const [rs] = await db.query("SELECT id FROM residentes WHERE nombre = ?", [nombre]);
    if (!rs.length) continue;
    const [ex] = await db.query(
      "SELECT id FROM user_residentes WHERE user_id = ? AND residente_id = ?",
      [adminId, rs[0].id]
    );
    if (!ex.length) {
      await db.query(
        "INSERT INTO user_residentes (user_id, residente_id, asignado_por) VALUES (?, ?, ?)",
        [adminId, rs[0].id, adminId]
      );
    }
  }
}

// ── FASE 1: la lógica de facturación vive ahora en lib/facturacion.js y corre
// en el worker (cola bots). Aquí solo quedan los endpoints que ENCOLAN. ──────
// ── MIGRACIÓN DB ──
async function initDB() {
  try {
    await db.query("ALTER TABLE users ADD COLUMN rol ENUM('admin','residente') NOT NULL DEFAULT 'residente'");
  } catch(e) { /* columna ya existe */ }

  try {
    await db.query("ALTER TABLE users ADD COLUMN creado_por INT NULL");
  } catch(e) { /* columna ya existe */ }

  try {
    await db.query(`CREATE TABLE IF NOT EXISTS residentes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      nombre VARCHAR(100) NOT NULL,
      disponible TINYINT(1) DEFAULT 1,
      creado TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
  } catch(e) { /* tabla ya existe */ }

  try {
    await db.query(`CREATE TABLE IF NOT EXISTS user_residentes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      residente_id INT NOT NULL,
      asignado_por INT,
      creado TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (residente_id) REFERENCES residentes(id)
    )`);
  } catch(e) { /* tabla ya existe */ }

  try {
    await db.query("ALTER TABLE tickets ADD COLUMN residente_id INT NULL");
  } catch(e) { /* columna ya existe */ }

  try {
    await db.query("ALTER TABLE tickets ADD COLUMN portal_url VARCHAR(255) NULL");
  } catch(e) { /* columna ya existe */ }

  try {
    await db.query("ALTER TABLE tickets ADD COLUMN procesando_correo_desde TIMESTAMP NULL");
  } catch(e) { /* columna ya existe */ }

  try {
    await db.query("ALTER TABLE tickets MODIFY COLUMN status ENUM('pendiente','procesando','procesando_correo','procesado','error','pendiente_confirmacion') NOT NULL DEFAULT 'pendiente'");
  } catch(e) { /* enum ya actualizado */ }

  try {
    await db.query(`CREATE TABLE IF NOT EXISTS ticket_intentos (
      id INT AUTO_INCREMENT PRIMARY KEY,
      ticket_id INT NOT NULL,
      bot VARCHAR(60),
      resultado ENUM('ok','error','procesando_correo') NOT NULL,
      mensaje TEXT,
      screenshot_urls TEXT,
      duracion_ms INT,
      creado TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
    )`);
  } catch(e) { /* tabla ya existe */ }

  try {
    await db.query("ALTER TABLE tickets ADD COLUMN reintento_programado TIMESTAMP NULL");
  } catch(e) { /* columna ya existe */ }

  try {
    await db.query("ALTER TABLE tickets ADD COLUMN error_msg TEXT NULL");
  } catch(e) { /* columna ya existe */ }

  try {
    await db.query("ALTER TABLE tickets ADD COLUMN requiere_confirmacion TINYINT(1) NOT NULL DEFAULT 0");
  } catch(e) { /* columna ya existe */ }

  try {
    await db.query("ALTER TABLE ticket_intentos MODIFY COLUMN resultado VARCHAR(30) NOT NULL");
  } catch(e) { /* ya modificado */ }

  try {
    await db.query("ALTER TABLE tickets ADD COLUMN email_contacto VARCHAR(255) NULL");
  } catch(e) { /* columna ya existe */ }

  try {
    await db.query("ALTER TABLE tickets ADD COLUMN constancia_path TEXT NULL");
  } catch(e) { /* columna ya existe */ }

  try {
    await db.query("ALTER TABLE tickets ADD COLUMN solicitud_correo_enviada TINYINT(1) NOT NULL DEFAULT 0");
  } catch(e) { /* columna ya existe */ }

  try {
    await db.query("ALTER TABLE tickets ADD COLUMN solicitud_correo_fecha TIMESTAMP NULL");
  } catch(e) { /* columna ya existe */ }

  try {
    await db.query("ALTER TABLE tickets ADD COLUMN solicitud_correo_error TEXT NULL");
  } catch(e) { /* columna ya existe */ }

  try {
    await db.query("ALTER TABLE users ADD COLUMN constancia_url TEXT NULL");
  } catch(e) { /* columna ya existe */ }

  try {
    await db.query(`CREATE TABLE IF NOT EXISTS notificaciones (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      tipo VARCHAR(50) NOT NULL,
      mensaje TEXT NOT NULL,
      leida TINYINT(1) DEFAULT 0,
      creado TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )`);
  } catch(e) { /* tabla ya existe */ }

  try {
    await db.query(`CREATE TABLE IF NOT EXISTS portales_pendientes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      nombre VARCHAR(100) NOT NULL,
      url VARCHAR(500) NOT NULL,
      notas TEXT,
      registrado_por INT NOT NULL,
      creado TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (registrado_por) REFERENCES users(id)
    )`);
  } catch(e) { /* tabla ya existe */ }

  try {
    await db.query(`CREATE TABLE IF NOT EXISTS portales_agente (
      id INT AUTO_INCREMENT PRIMARY KEY,
      comercio VARCHAR(100) NOT NULL,
      nombre VARCHAR(200),
      portal_url TEXT,
      instrucciones TEXT,
      estado ENUM('analizando','generando','validando','corrigiendo','pendiente_aprobacion','activo','error') DEFAULT 'analizando',
      analisis JSON,
      bot_code LONGTEXT,
      nombre_archivo VARCHAR(100),
      nombre_funcion VARCHAR(100),
      intentos_correccion INT DEFAULT 0,
      error_msg TEXT,
      ticket_id INT,
      creado TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      actualizado TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`);
  } catch(e) { /* tabla ya existe */ }

  try {
    // Un ticket genera a lo más UNA factura. Sin este constraint, dos
    // procesos concurrentes (p.ej. el job de IMAP en dos ciclos que se
    // solapan, o un reprocesamiento manual corriendo a la par del job
    // automático) pueden insertar dos filas para el mismo ticket_id —
    // pasó en producción (ticket #116, mismo UUID duplicado). sinSolape()
    // solo evita que un mismo proceso se solape consigo mismo; esto cierra
    // la puerta también entre procesos distintos.
    await db.query("ALTER TABLE facturas ADD UNIQUE KEY uq_facturas_ticket_id (ticket_id)");
  } catch(e) { /* constraint ya existe */ }

  try {
    // La tabla vive en producción desde antes de que este archivo declarara
    // VARCHAR(100) para comercio — CREATE TABLE IF NOT EXISTS nunca ensancha
    // una columna ya existente, así que se quedó en VARCHAR(50) real. Un
    // comercio detectado por OCR más largo que eso (p.ej. "CAPUFE /
    // Comunicaciones y Transportes (plaza de cobro)") tronaba con
    // ER_DATA_TOO_LONG al guardar el ticket.
    await db.query("ALTER TABLE tickets MODIFY COLUMN comercio VARCHAR(150) NOT NULL");
  } catch(e) { /* columna ya ensanchada */ }

  try {
    const [[{ n }]] = await db.query("SELECT COUNT(*) AS n FROM residentes");
    if (n === 0) {
      for (const r of DEFAULT_RESIDENTES) {
        await db.query("INSERT INTO residentes (nombre, disponible) VALUES (?, ?)", [r.nombre, r.disponible]);
      }
      console.log("✅ Residentes iniciales insertados");
    }

    const [adminUsers] = await db.query("SELECT id FROM users WHERE email = ?", [ADMIN_EMAIL]);
    if (adminUsers.length > 0) {
      await db.query("UPDATE users SET rol = 'admin' WHERE email = ?", [ADMIN_EMAIL]);
      await assignAdminResidentes(adminUsers[0].id);
    }
  } catch (e) {
    console.log("ℹ️  DB seed/admin:", e.message);
  }

  console.log("✅ DB schema actualizado");

  // Migración one-time: renombrar facturas existentes que no tienen UUID en el nombre del archivo
  // Se ejecuta en cada arranque pero solo procesa las que aún no tienen UUID en su URL
  migrarUUIDFacturas().catch(e => console.log("⚠️ Migración UUID:", e.message));
  // FASE 1: restaurarBotsDinamicos ahora corre en el worker (los bots viven allá)
}
initDB();

async function migrarUUIDFacturas() {
  const [facturas] = await db.query(
    `SELECT id, comercio, xml_url, pdf_url FROM facturas
     WHERE xml_url IS NOT NULL
       AND xml_url NOT REGEXP 'facturas/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.xml'`
  );
  if (!facturas.length) return;
  console.log(`🔖 Migración UUID: ${facturas.length} factura(s) pendiente(s) de renombrar`);
  for (const f of facturas) {
    try {
      const { xmlUrl, pdfUrl } = await renombrarConUUID(f.xml_url, f.pdf_url, f.comercio);
      if (xmlUrl !== f.xml_url || pdfUrl !== f.pdf_url) {
        await db.query("UPDATE facturas SET xml_url = ?, pdf_url = ? WHERE id = ?", [xmlUrl, pdfUrl, f.id]);
        console.log(`✅ Factura #${f.id} (${f.comercio}) renombrada con UUID`);
      }
    } catch (e) {
      console.log(`⚠️ Factura #${f.id} no migrada: ${e.message}`);
    }
  }
  console.log("🔖 Migración UUID completada");
}

// FASE 1: multer en memoria — la imagen va directo a R2 (el worker la descarga
// de ahí). El disco de Railway es efímero y web/worker son contenedores distintos.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// ── MIDDLEWARE ──
// auth: usada por TODAS las rutas /api/* — responde 401 JSON (necesario para un
// frontend en otro origen/dominio; un redirect no es un patrón usable para fetch()).
function auth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ ok: false, msg: "No autenticado" });
  next();
}

// pageAuth: solo para las rutas que sirven HTML directamente (abajo) — conserva
// el redirect de siempre, útil mientras esas páginas sigan viviendo en Express.
function pageAuth(req, res, next) {
  if (!req.session.userId) return res.redirect("/");
  next();
}

function requireAdmin(req, res, next) {
  if (req.session.userRol !== "admin")
    return res.status(403).json({ ok: false, msg: "Solo el administrador puede hacer esto" });
  next();
}

// ── RUTAS WEB ──
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "login.html")));
app.get("/dashboard", pageAuth, (req, res) => res.sendFile(path.join(__dirname, "public", "dashboard.html")));
app.get("/mis-tickets", pageAuth, (req, res) => res.sendFile(path.join(__dirname, "public", "mis-tickets.html")));
app.get("/mis-facturas", pageAuth, (req, res) => res.sendFile(path.join(__dirname, "public", "mis-facturas.html")));
app.get("/perfil", pageAuth, (req, res) => res.sendFile(path.join(__dirname, "public", "perfil.html")));
app.get("/admin-residentes", pageAuth, requireAdmin, (req, res) =>
  res.sendFile(path.join(__dirname, "public", "admin-residentes.html")));

// ── REGISTRO ──
app.post("/register", async (req, res) => {
  try {
    const { nombre, email, password } = req.body;
    const hashed = await bcrypt.hash(password, 10);
    const rol = getRol(email);
    const [result] = await db.query(
      "INSERT INTO users (nombre, email, password_hash, rol) VALUES (?, ?, ?, ?)",
      [nombre, email, hashed, rol]
    );
    if (rol === "admin") {
      await assignAdminResidentes(result.insertId);
    }
    res.json({ ok: true, rol });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

// ── LOGIN ──
app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const [rows] = await db.query("SELECT * FROM users WHERE email = ?", [email]);
    if (rows.length === 0) return res.json({ ok: false, msg: "Usuario no existe" });
    const match = await bcrypt.compare(password, rows[0].password_hash);
    if (!match) return res.json({ ok: false, msg: "Contraseña incorrecta" });
    // session.regenerate evita session fixation (no reusar el id de sesión pre-login)
    req.session.regenerate((err) => {
      if (err) return res.json({ ok: false, msg: "Error de sesión" });
      req.session.userId   = rows[0].id;
      req.session.userName = rows[0].nombre;
      req.session.userRfc  = rows[0].rfc || "";
      req.session.userRol  = rows[0].rol || "residente";
      req.session.save((err2) => {
        if (err2) return res.json({ ok: false, msg: "Error de sesión" });
        res.json({ ok: true });
      });
    });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

app.get("/api/me", auth, (req, res) => {
  res.json({
    id: req.session.userId,
    nombre: req.session.userName,
    rfc: req.session.userRfc,
    rol: req.session.userRol,
  });
});

app.get("/logout", (req, res) => req.session.destroy(() => res.redirect("/")));

// ── PERFIL FISCAL ──
app.get("/api/perfil", auth, async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT rfc, razon_social, calle, num_ext, num_int, colonia, municipio, estado, codigo_postal, regimen_fiscal, uso_cfdi, constancia_url FROM users WHERE id = ?",
      [req.session.userId]
    );
    res.json({ ok: true, perfil: rows[0] });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

app.post("/api/perfil", auth, async (req, res) => {
  try {
    const { rfc, razon_social, calle, num_ext, num_int, colonia, municipio, estado, codigo_postal, regimen_fiscal, uso_cfdi } = req.body;
    await db.query(
      "UPDATE users SET rfc=?, razon_social=?, calle=?, num_ext=?, num_int=?, colonia=?, municipio=?, estado=?, codigo_postal=?, regimen_fiscal=?, uso_cfdi=? WHERE id=?",
      [rfc, razon_social, calle, num_ext, num_int, colonia, municipio, estado, codigo_postal, regimen_fiscal, uso_cfdi, req.session.userId]
    );
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

// ── CONSTANCIA DE SITUACIÓN FISCAL ──
const multerConstancia = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png'];
    cb(null, allowed.includes(file.mimetype));
  },
}).single('constancia');

app.post("/api/perfil/constancia", auth, (req, res) => {
  multerConstancia(req, res, async (err) => {
    if (err) return res.json({ ok: false, msg: err.message || 'Archivo inválido (máx 5 MB, PDF/JPG/PNG)' });
    if (!req.file) return res.json({ ok: false, msg: 'No se recibió archivo' });
    try {
      const ext = req.file.originalname.split('.').pop().toLowerCase();
      const key = `constancias/user_${req.session.userId}_${Date.now()}.${ext}`;
      const url = await subirArchivoR2(req.file.buffer, key, req.file.mimetype);
      await db.query("UPDATE users SET constancia_url = ? WHERE id = ?", [url, req.session.userId]);
      res.json({ ok: true, constancia_url: url });
    } catch (e) {
      res.json({ ok: false, msg: e.message });
    }
  });
});

// ── RESIDENTES ──
app.get("/api/residentes", auth, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT r.*
      FROM residentes r
      JOIN user_residentes ur ON r.id = ur.residente_id
      WHERE ur.user_id = ?
      ORDER BY r.nombre
    `, [req.session.userId]);
    res.json({ ok: true, residentes: rows });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

// ── CATÁLOGO COMPLETO DE RESIDENTES (admin) ──
app.get("/api/admin/todos-residentes", auth, requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT r.*,
        GROUP_CONCAT(u.nombre ORDER BY u.nombre SEPARATOR ', ') AS asignados_a
      FROM residentes r
      LEFT JOIN user_residentes ur ON r.id = ur.residente_id
      LEFT JOIN users u ON ur.user_id = u.id
      GROUP BY r.id
      ORDER BY r.nombre
    `);
    res.json({ ok: true, residentes: rows });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

app.post("/api/residentes/crear", auth, requireAdmin, async (req, res) => {
  try {
    const { nombre, disponible = 1 } = req.body;
    if (!nombre) return res.json({ ok: false, msg: "Nombre requerido" });
    const [result] = await db.query(
      "INSERT INTO residentes (nombre, disponible) VALUES (?, ?)",
      [nombre, disponible ? 1 : 0]
    );
    res.json({ ok: true, id: result.insertId });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

app.post("/api/residentes/:id/asignar/:userId", auth, requireAdmin, async (req, res) => {
  try {
    const { id, userId } = req.params;
    const [ex] = await db.query(
      "SELECT id FROM user_residentes WHERE user_id = ? AND residente_id = ?",
      [userId, id]
    );
    if (ex.length > 0) return res.json({ ok: false, msg: "Ya está asignado" });
    await db.query(
      "INSERT INTO user_residentes (user_id, residente_id, asignado_por) VALUES (?, ?, ?)",
      [userId, id, req.session.userId]
    );
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

app.delete("/api/residentes/:id/quitar/:userId", auth, requireAdmin, async (req, res) => {
  try {
    const { id, userId } = req.params;
    await db.query(
      "DELETE FROM user_residentes WHERE user_id = ? AND residente_id = ?",
      [userId, id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

// ── MIS RESIDENTES CON CONTEOS ──
app.get('/api/residentes/mis-residentes', auth, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT r.id, r.nombre,
        COUNT(DISTINCT t.id) AS ticket_count,
        COUNT(DISTINCT f.id) AS factura_count
      FROM residentes r
      JOIN user_residentes ur ON r.id = ur.residente_id AND ur.user_id = ?
      LEFT JOIN tickets t ON t.residente_id = r.id AND t.user_id = ?
      LEFT JOIN facturas f ON f.ticket_id = t.id
      GROUP BY r.id, r.nombre
      ORDER BY r.nombre
    `, [req.session.userId, req.session.userId]);

    // Contar tickets/facturas sin asignar (residente_id IS NULL)
    const [[sinAsignar]] = await db.query(`
      SELECT
        COUNT(DISTINCT t.id)  AS sin_tickets,
        COUNT(DISTINCT f.id)  AS sin_facturas
      FROM tickets t
      LEFT JOIN facturas f ON f.ticket_id = t.id
      WHERE t.user_id = ? AND t.residente_id IS NULL
    `, [req.session.userId]);

    res.json({ ok: true, residentes: rows, sin_asignar: sinAsignar });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

// ── RESIDENTES DE UN USUARIO (admin) ──
app.get('/api/admin/residentes/:userId', auth, requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT r.id, r.nombre
      FROM residentes r
      JOIN user_residentes ur ON r.id = ur.residente_id
      WHERE ur.user_id = ?
      ORDER BY r.nombre
    `, [req.params.userId]);
    res.json({ ok: true, residentes: rows });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

// ── TICKETS ADMIN (filtrable por user_id y residente_id) ──
app.get('/api/admin/tickets', auth, requireAdmin, async (req, res) => {
  try {
    const { user_id, residente_id } = req.query;
    let query = `
      SELECT t.id, t.nombre_archivo, t.comercio, t.status, t.creado, t.ocr_json,
             u.nombre AS user_nombre, r.nombre AS residente_nombre
      FROM tickets t
      JOIN users u ON t.user_id = u.id
      LEFT JOIN residentes r ON t.residente_id = r.id
      WHERE 1=1
    `;
    const params = [];
    if (user_id) { query += ' AND t.user_id = ?'; params.push(user_id); }
    if (residente_id) { query += ' AND t.residente_id = ?'; params.push(residente_id); }
    query += ' ORDER BY t.creado DESC LIMIT 100';
    const [rows] = await db.query(query, params);
    res.json({ ok: true, tickets: rows });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

app.get("/api/admin/usuarios", auth, requireAdmin, async (req, res) => {
  try {
    const [usuarios] = await db.query(
      "SELECT id, nombre, email, rol, creado FROM users ORDER BY creado DESC"
    );
    for (const u of usuarios) {
      const [asignados] = await db.query(`
        SELECT r.id, r.nombre, r.disponible
        FROM residentes r
        JOIN user_residentes ur ON r.id = ur.residente_id
        WHERE ur.user_id = ?
        ORDER BY r.nombre
      `, [u.id]);
      u.residentes = asignados;
    }
    res.json({ ok: true, usuarios });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

// ── SUBIR TICKET (FASE 1: encola en Redis y responde de inmediato) ──
app.post("/upload-ticket", auth, upload.single("ticket"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, msg: "No se recibió archivo" });
    const residente_id = req.body.residente_id ? parseInt(req.body.residente_id) : null;

    // 1) Persistir la imagen en R2 — fuente única para el worker (el disco de
    //    Railway es efímero y web/worker son contenedores distintos).
    const extImg = ((req.file.originalname || '').split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
    const imagenTicketUrl = await subirArchivoR2(
      req.file.buffer,
      `tickets/${req.session.userId}_${Date.now()}.${extImg}`,
      req.file.mimetype || 'image/jpeg'
    );
    if (!imagenTicketUrl) {
      return res.status(500).json({ ok: false, msg: "No se pudo guardar la imagen — intenta de nuevo" });
    }

    // 2) Insertar el ticket en estado 'pendiente' (sin OCR aún)
    const [insertResult] = await db.query(
      "INSERT INTO tickets (user_id, nombre_archivo, ruta_archivo, comercio, status, residente_id, requiere_confirmacion) VALUES (?, ?, ?, ?, 'pendiente', ?, 1)",
      [req.session.userId, req.file.originalname, imagenTicketUrl, "Analizando…", residente_id]
    );
    const ticketId = insertResult.insertId;

    // 3) Encolar la lectura (cola vision del worker) y responder DE INMEDIATO
    await encolarVision(ticketId, req.session.userId);
    console.log(`📥 Ticket #${ticketId} recibido → cola vision`);
    res.json({ ok: true, enCola: true, ticketId, msg: "Ticket recibido — leyendo con IA" });
  } catch (err) {
    console.error("❌ upload-ticket:", err.message);
    res.status(500).json({ ok: false, msg: err.message });
  }
});

// ── SUBIR VARIOS TICKETS DE GOLPE ────────────────────────────────────────────
// Mismo pipeline que /upload-ticket pero en lote: sube todas las imágenes a R2,
// inserta todas las filas y las encola de una vez. Responde de inmediato SIN
// esperar el OCR de ninguna.
//
// Filosofía deliberada (pedida por el usuario): en lote NO se bloquea ni se
// avisa por ticket. Lo que falle, lo que resulte duplicado o lo que caiga en un
// portal sin bot se queda simplemente EN PROCESO dentro de "Mis Tickets" para
// revisión interna. Un solo archivo problemático no debe frenar a los demás:
// por eso cada archivo se procesa en su propio try/catch y el lote sigue.
// La cola de Redis ya serializa la facturación (máx. 2 concurrentes), así que
// aceptar muchos de golpe no satura nada.
const MAX_TICKETS_LOTE = 25;
app.post("/upload-tickets", auth, upload.array("tickets", MAX_TICKETS_LOTE), async (req, res) => {
  try {
    const archivos = req.files || [];
    if (!archivos.length) return res.status(400).json({ ok: false, msg: "No se recibió ningún archivo" });
    const residente_id = req.body.residente_id ? parseInt(req.body.residente_id) : null;

    const resultados = await Promise.all(archivos.map(async (file) => {
      try {
        const extImg = ((file.originalname || '').split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
        // Sufijo aleatorio además del timestamp: subidas en paralelo pueden caer
        // en el mismo milisegundo y sobrescribirse entre ellas en R2.
        const imagenTicketUrl = await subirArchivoR2(
          file.buffer,
          `tickets/${req.session.userId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${extImg}`,
          file.mimetype || 'image/jpeg'
        );
        if (!imagenTicketUrl) return { archivo: file.originalname, ok: false };

        const [ins] = await db.query(
          "INSERT INTO tickets (user_id, nombre_archivo, ruta_archivo, comercio, status, residente_id, requiere_confirmacion) VALUES (?, ?, ?, ?, 'pendiente', ?, 1)",
          [req.session.userId, file.originalname, imagenTicketUrl, "Analizando…", residente_id]
        );
        await encolarVision(ins.insertId, req.session.userId);
        return { archivo: file.originalname, ok: true, ticketId: ins.insertId };
      } catch (e) {
        console.error(`❌ upload-tickets (${file.originalname}):`, e.message);
        return { archivo: file.originalname, ok: false };
      }
    }));

    const encolados = resultados.filter(r => r.ok);
    console.log(`📥 Lote de ${archivos.length} ticket(s) → ${encolados.length} en cola vision`);
    res.json({
      ok: true,
      enCola: true,
      total: archivos.length,
      encolados: encolados.length,
      ticketIds: encolados.map(r => r.ticketId),
    });
  } catch (err) {
    console.error("❌ upload-tickets:", err.message);
    res.status(500).json({ ok: false, msg: err.message });
  }
});

// ── ESTADO DEL OCR (el frontend hace polling tras subir) ─────────────────────
// Devuelve la misma información que antes entregaba la respuesta síncrona de
// /upload-ticket: duplicado | agenteActivado | necesitaConfirmacion | autoFacturando.
app.get("/api/tickets/:id/estado-ocr", auth, async (req, res) => {
  try {
    const [[t]] = await db.query(
      "SELECT id, status, error_msg, ocr_json, comercio, requiere_confirmacion, portal_url FROM tickets WHERE id = ? AND user_id = ?",
      [req.params.id, req.session.userId]
    );
    if (!t) return res.json({ ok: false, msg: "Ticket no encontrado" });

    // OCR aún en proceso
    if (t.status === 'pendiente' && !t.ocr_json) return res.json({ ok: true, listo: false });

    let datos = {};
    try { datos = JSON.parse(t.ocr_json || '{}'); } catch {}

    if (t.status === 'error' && (t.error_msg || '').startsWith('duplicado:')) {
      return res.json({
        ok: true, listo: true, duplicado: true, ticketId: t.id,
        msg: `Este ticket ya fue registrado (${t.error_msg.slice(11).trim()}). Búscalo en "Mis Facturas".`,
      });
    }
    if (t.status === 'error') {
      return res.json({ ok: true, listo: true, error: true, ticketId: t.id, msg: t.error_msg || 'No se pudo leer el ticket' });
    }

    const portal = (datos.portal || 'desconocido').toLowerCase();
    if (portal === 'desconocido') {
      return res.json({
        ok: true, listo: true, agenteActivado: true, ticketId: t.id,
        comercio: datos.comercio || t.comercio || 'este comercio', urlQR: datos.portalUrl || t.portal_url || null,
      });
    }

    const campos = camposPorPortal[portal] || camposPorPortal.desconocido;
    if (t.requiere_confirmacion) {
      return res.json({
        ok: true, listo: true, necesitaConfirmacion: true, ticketId: t.id, datos, campos,
        campos_dudosos: Array.isArray(datos.campos_dudosos) ? datos.campos_dudosos : [],
        confianza: datos.confianza || 'media',
      });
    }
    return res.json({ ok: true, listo: true, autoFacturando: true, ticketId: t.id, datos, campos });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});


// ── CONFIRMAR / RECHAZAR DATOS OCR ──
app.post("/api/tickets/:id/confirmar", auth, async (req, res) => {
  try {
    const ticketId = req.params.id;
    const { accion, datos } = req.body; // accion: 'confirmar' | 'rechazar'

    const [tickets] = await db.query(
      "SELECT * FROM tickets WHERE id = ? AND user_id = ?",
      [ticketId, req.session.userId]
    );
    if (tickets.length === 0) return res.json({ ok: false, msg: "Ticket no encontrado" });
    const ticket = tickets[0];

    if (ticket.status !== 'pendiente_confirmacion' || !ticket.requiere_confirmacion) {
      return res.json({ ok: false, msg: "El ticket no está esperando confirmación" });
    }

    if (accion === 'rechazar') {
      if (ticket.ruta_archivo) {
        try { fs.unlinkSync(ticket.ruta_archivo); } catch {}
      }
      await db.query("DELETE FROM tickets WHERE id = ? AND user_id = ?", [ticketId, req.session.userId]);
      return res.json({ ok: true, msg: "Ticket eliminado" });
    }

    if (accion !== 'confirmar') {
      return res.json({ ok: false, msg: "Acción inválida" });
    }

    // Actualizar datos OCR con los confirmados por el usuario (merge genérico)
    const datosActuales = JSON.parse(ticket.ocr_json || '{}');
    const datosConfirmados = { ...datosActuales, ...datos };

    console.log(`📋 CONFIRMAR #${ticketId} — datos recibidos:`, JSON.stringify(datos));
    console.log(`📋 CONFIRMAR #${ticketId} — datosActuales:`, JSON.stringify(datosActuales));
    console.log(`📋 CONFIRMAR #${ticketId} — datosConfirmados (a guardar):`, JSON.stringify(datosConfirmados));

    await db.query(
      "UPDATE tickets SET ocr_json = ?, requiere_confirmacion = 0 WHERE id = ?",
      [JSON.stringify(datosConfirmados), ticketId]
    );

    // FASE 1: encolar en la cola de bots (el worker factura; máx 2 por portal)
    const portalKey = (datosConfirmados.portal || datosConfirmados.comercio || 'desconocido').toLowerCase().replace(/\s+/g, '');
    await encolarBot(parseInt(ticketId), req.session.userId, portalKey);
    res.json({ ok: true, autoFacturando: true, ticketId });
  } catch (err) {
    console.error("❌ Error confirmar:", err.message);
    res.status(500).json({ ok: false, msg: err.message });
  }
});

// ── EDITAR DATOS OCR (ticket en error) ──
app.put("/api/tickets/:id/datos", auth, async (req, res) => {
  try {
    const ticketId = req.params.id;
    const [rows] = await db.query(
      "SELECT id, status, ocr_json FROM tickets WHERE id = ? AND user_id = ?",
      [ticketId, req.session.userId]
    );
    if (!rows.length) return res.json({ ok: false, msg: "Ticket no encontrado" });
    const ticket = rows[0];

    // Permitir editar también tickets atascados en 'procesando'/'procesado' (p.ej.
    // los que pasaron por el agente). Solo bloqueamos los que esperan correo (IMAP).
    if (ticket.status === 'procesando_correo') {
      return res.json({ ok: false, msg: "El ticket está esperando su factura por correo — espera unos minutos" });
    }

    const datosActuales = JSON.parse(ticket.ocr_json || '{}');
    const datosNuevos = { ...datosActuales, ...req.body };

    await db.query(
      "UPDATE tickets SET ocr_json = ?, status = 'pendiente', error_msg = NULL WHERE id = ?",
      [JSON.stringify(datosNuevos), ticketId]
    );

    res.json({ ok: true, msg: "Datos actualizados", datos: datosNuevos });
  } catch (err) {
    console.error("❌ Error PUT datos:", err.message);
    res.status(500).json({ ok: false, msg: err.message });
  }
});

// ── BOT FACTURAR (reintento manual) ──
app.post("/facturar/:ticketId", auth, async (req, res) => {
  try {
    const { ticketId } = req.params;
    const [rows] = await db.query(
      "SELECT id, status FROM tickets WHERE id = ? AND user_id = ?",
      [ticketId, req.session.userId]
    );
    if (!rows.length) return res.json({ ok: false, msg: "Ticket no encontrado" });
    if (rows[0].status === 'procesando') return res.json({ ok: false, msg: "Ya está procesándose" });

    // FASE 1: encolar — la cola de bots controla la concurrencia (máx 2 por portal)
    const [[tk]] = await db.query("SELECT ocr_json, comercio FROM tickets WHERE id = ?", [ticketId]);
    let ocr = {}; try { ocr = JSON.parse(tk?.ocr_json || '{}'); } catch {}
    const portalKey = (ocr.portal || tk?.comercio || 'desconocido').toLowerCase().replace(/\s+/g, '');
    await encolarBot(parseInt(ticketId), req.session.userId, portalKey);
    res.json({ ok: true, procesando: true, msg: "Facturación encolada" });
  } catch (err) {
    console.error("❌ Error /facturar:", err.message);
    res.status(500).json({ ok: false, msg: err.message });
  }
});

// ── BORRAR TICKET ──
app.get("/api/tickets/:id", auth, async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT * FROM tickets WHERE id = ? AND user_id = ?",
      [req.params.id, req.session.userId]
    );
    if (!rows.length) return res.json({ ok: false, msg: "Ticket no encontrado" });
    res.json({ ok: true, ticket: rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

app.delete("/api/tickets/:id", auth, async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT * FROM tickets WHERE id = ? AND user_id = ?",
      [req.params.id, req.session.userId]
    );
    if (!rows.length) return res.json({ ok: false, msg: "Ticket no encontrado" });
    const ticket = rows[0];
    if (!["error", "pendiente", "pendiente_confirmacion", "procesando_correo"].includes(ticket.status))
      return res.json({ ok: false, msg: "Solo se pueden borrar tickets en error, pendiente o esperando correo" });

    if (ticket.ruta_archivo && fs.existsSync(ticket.ruta_archivo)) {
      fs.unlinkSync(ticket.ruta_archivo);
    }
    await db.query("DELETE FROM tickets WHERE id = ?", [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

// ── LISTAR TICKETS ──
app.get("/api/tickets", auth, async (req, res) => {
  try {
    const { residente_id } = req.query;
    let query = "SELECT id, nombre_archivo, comercio, status, creado, ocr_json, residente_id, error_msg, email_contacto, solicitud_correo_enviada, solicitud_correo_fecha, solicitud_correo_error FROM tickets WHERE user_id = ?";
    const params = [req.session.userId];
    if (residente_id === 'sin_asignar') {
      query += " AND residente_id IS NULL";
    } else if (residente_id) {
      query += " AND residente_id = ?";
      params.push(residente_id);
    }
    query += " ORDER BY creado DESC";
    const [rows] = await db.query(query, params);
    res.json({ ok: true, tickets: rows });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

// ── REASIGNAR TICKET A RESIDENTE ──
app.put("/api/tickets/:id/residente", auth, async (req, res) => {
  try {
    const rid = req.body.residente_id || null;
    await db.query(
      "UPDATE tickets SET residente_id = ? WHERE id = ? AND user_id = ?",
      [rid, req.params.id, req.session.userId]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, msg: e.message });
  }
});

// ── SOLICITAR FACTURA POR CORREO (ticket vencido) ──
app.post("/api/tickets/:id/solicitar-correo", auth, async (req, res) => {
  try {
    const ticketId = parseInt(req.params.id);
    const userId = req.session.userId;
    // Correo del comercio escrito manualmente por el usuario (portales sin
    // email_contacto pre-configurado, p.ej. SushiO/mefacturo). Opcional.
    const emailManual = (req.body && req.body.email) ? String(req.body.email).trim() : null;
    const formaPago = (req.body && req.body.formaPago) ? String(req.body.formaPago).trim() : 'Efectivo';

    const [[ticket]] = await db.query(
      `SELECT t.id, t.comercio, t.email_contacto, t.solicitud_correo_enviada,
              t.ocr_json, t.nombre_archivo, t.ruta_archivo, t.user_id,
              u.nombre AS user_nombre, u.email AS user_email,
              u.rfc, u.razon_social, u.constancia_url
       FROM tickets t JOIN users u ON t.user_id = u.id
       WHERE t.id = ? AND t.user_id = ?`,
      [ticketId, userId]
    );
    if (!ticket) return res.status(404).json({ ok: false, msg: "Ticket no encontrado" });

    // Correo destino: el pre-configurado o el que el usuario escribió ahora.
    const correoDestino = ticket.email_contacto || emailManual;
    if (!correoDestino) return res.json({ ok: false, msg: "Indica el correo de facturación del comercio para enviar la solicitud" });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(correoDestino)) return res.json({ ok: false, msg: "El correo del comercio no es válido" });
    if (!ticket.constancia_url) return res.json({ ok: false, msg: "Debes subir tu constancia de situación fiscal en tu perfil antes de solicitar" });
    if (ticket.solicitud_correo_enviada) return res.json({ ok: false, msg: "Ya se envió una solicitud por correo para este ticket" });

    // Persistir el correo manual y usarlo en el envío.
    if (!ticket.email_contacto && emailManual) {
      await db.query("UPDATE tickets SET email_contacto = ? WHERE id = ?", [emailManual, ticketId])
        .catch(e => console.log(`⚠️ email_contacto manual no guardado (${e.message})`));
    }
    ticket.email_contacto = correoDestino;
    ticket.formaPago = formaPago;

    // Marcar como en proceso de envío
    await db.query(
      "UPDATE tickets SET solicitud_correo_enviada = 0, solicitud_correo_error = NULL WHERE id = ?",
      [ticketId]
    );

    res.json({ ok: true, msg: "Solicitud recibida — enviando correo al comercio" });

    // Envío asíncrono (no bloquea respuesta al cliente)
    setImmediate(() => enviarSolicitudPorCorreo(ticket).catch(e =>
      console.error(`❌ enviarSolicitudPorCorreo #${ticketId}:`, e.message)
    ));

  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

async function enviarSolicitudPorCorreo(ticket) {
  const { id: ticketId, comercio, email_contacto, user_nombre, user_email,
          rfc, razon_social, constancia_url, ocr_json, formaPago, ruta_archivo } = ticket;

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
    from: `"GPN Pinturas — Facturación" <${process.env.SMTP_USER || 'buzonfacturas@serviciosga.site'}>`,
    to: email_contacto,
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
          <p style="color:#666;font-size:0.85rem;">Este correo fue generado automáticamente por GPN Pinturas y Recubrimientos — Portal de Facturación.</p>
        </div>
      </div>`,
    attachments,
  };

  // Verificar SMTP disponible antes de intentar
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER) {
    const errMsg = 'SMTP no configurado — no se puede enviar correo';
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

// ── LISTAR FACTURAS ──
app.get("/api/facturas", auth, async (req, res) => {
  try {
    const { residente_id } = req.query;
    let query = "SELECT f.id, f.comercio, f.status, f.xml_url, f.pdf_url, f.creado, t.ocr_json, t.id AS ticket_id, t.residente_id FROM facturas f LEFT JOIN tickets t ON f.ticket_id = t.id";
    const params = [req.session.userId];
    if (residente_id === 'sin_asignar') {
      query += " WHERE f.user_id = ? AND (t.residente_id IS NULL OR t.id IS NULL)";
    } else if (residente_id) {
      query += " WHERE f.user_id = ? AND t.residente_id = ?";
      params.push(residente_id);
    } else {
      query += " WHERE f.user_id = ?";
    }
    query += " ORDER BY f.creado DESC";
    const [rows] = await db.query(query, params);
    res.json({ ok: true, facturas: rows });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

// ── NOTIFICACIONES ──
app.get("/api/notificaciones", auth, async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT id, tipo, mensaje, leida, creado FROM notificaciones WHERE user_id = ? ORDER BY creado DESC LIMIT 50",
      [req.session.userId]
    );
    const noLeidas = rows.filter(n => !n.leida).length;
    res.json({ ok: true, notificaciones: rows, noLeidas });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

app.post("/api/notificaciones/:id/leer", auth, async (req, res) => {
  try {
    await db.query(
      "UPDATE notificaciones SET leida = 1 WHERE id = ? AND user_id = ?",
      [req.params.id, req.session.userId]
    );
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

app.post("/api/notificaciones/leer-todas", auth, async (req, res) => {
  try {
    await db.query(
      "UPDATE notificaciones SET leida = 1 WHERE user_id = ?",
      [req.session.userId]
    );
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

// ── PORTALES PENDIENTES (admin) ──
app.get("/api/portales-pendientes", auth, requireAdmin, async (req, res) => {
  try {
    const [grupos] = await db.query(`
      SELECT
        t.comercio,
        COUNT(*) AS total_tickets,
        MAX(t.creado) AS ultimo_ticket,
        MAX(pp.url)   AS url,
        MAX(pp.notas) AS notas
      FROM tickets t
      LEFT JOIN portales_pendientes pp ON pp.nombre LIKE CONCAT('%', t.comercio, '%')
      WHERE t.portal_url = 'desconocido'
        AND t.status = 'error'
      GROUP BY t.comercio
      ORDER BY ultimo_ticket DESC
    `);
    res.json({ ok: true, grupos });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

app.post("/api/portales-pendientes", auth, requireAdmin, async (req, res) => {
  try {
    const { nombre, url, notas, comercio } = req.body;
    if (!nombre || !url || !comercio) return res.json({ ok: false, msg: "Faltan campos requeridos" });

    await db.query(
      "INSERT INTO portales_pendientes (nombre, url, notas, registrado_por) VALUES (?, ?, ?, ?)",
      [nombre, url, notas || null, req.session.userId]
    );

    await db.query(
      "UPDATE tickets SET status = 'pendiente', portal_url = ? WHERE portal_url = 'desconocido' AND comercio = ?",
      [url, comercio]
    );

    const [affectedUsers] = await db.query(`
      SELECT DISTINCT user_id FROM tickets
      WHERE portal_url = ? AND comercio = ?
    `, [url, comercio]);

    for (const u of affectedUsers) {
      await crearNotificacion(
        u.user_id,
        "portal_registrado",
        `El portal de facturación de ${comercio} ya fue registrado. Puedes volver a intentar facturar tus tickets pendientes.`
      );
    }

    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

// ── CUESTIONARIO PORTAL NUEVO (usuario reporta cómo factura) ──
app.post("/api/tickets/:id/cuestionario-portal", auth, async (req, res) => {
  try {
    const ticketId = req.params.id;
    const { frecuencia, acceso, descripcion, linkPortal, campos } = req.body;

    const [[ticket]] = await db.query(
      "SELECT id, comercio, user_id FROM tickets WHERE id = ? AND user_id = ?",
      [ticketId, req.session.userId]
    );
    if (!ticket) return res.json({ ok: false, msg: "Ticket no encontrado" });

    const notas = JSON.stringify({ frecuencia, acceso, descripcion, linkPortal, campos });

    await db.query(
      "INSERT INTO portales_pendientes (nombre, url, notas, registrado_por) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE notas = VALUES(notas)",
      [ticket.comercio, linkPortal || "sin-url", notas, req.session.userId]
    );

    // Si el residente dio el link, guardarlo en el ticket para que el agente lo use
    if (linkPortal) {
      const [[t]] = await db.query("SELECT ocr_json FROM tickets WHERE id = ?", [ticketId]);
      const ocr = JSON.parse(t?.ocr_json || '{}');
      ocr.portalUrl = linkPortal;
      await db.query(
        "UPDATE tickets SET portal_url = ?, ocr_json = ? WHERE id = ?",
        [linkPortal, JSON.stringify(ocr), ticketId]
      );
    }

    // Guardar descripción del proceso como instrucciones para el agente
    const instrucciones = [
      acceso ? `Acceso: ${acceso}` : '',
      descripcion ? `Proceso: ${descripcion}` : '',
      campos?.length ? `Campos del portal: ${campos.join(', ')}` : '',
    ].filter(Boolean).join('\n');

    // FASE 1: disparar el agente directo en SU cola (concurrencia 1, aislada —
    // el alta de un portal nuevo ya no bloquea la facturación normal)
    await encolarAgente(parseInt(ticketId), ticket.user_id, ticket.comercio, linkPortal || null);

    // Notificar al admin
    const [admins] = await db.query("SELECT id FROM users WHERE rol = 'admin'");
    for (const admin of admins) {
      await crearNotificacion(
        admin.id,
        "portal_pendiente",
        `Agentes iniciados para "${ticket.comercio}" (ticket #${ticketId}). Info del residente: ${instrucciones || 'sin detalle'}.`
      );
    }

    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

// FASE 1: /debug-screenshot eliminado (corría un bot Puppeteer en el proceso web).
// Las limpiezas periódicas (tickets error +30d, R2 +60d) viven ahora en el worker.


// GET /api/portales-pendientes/datos?comercio=X — notas y URL guardadas para ese comercio
app.get("/api/portales-pendientes/datos", auth, requireAdmin, async (req, res) => {
  try {
    const { comercio } = req.query;
    if (!comercio) return res.json({ ok: false, msg: "Falta comercio" });
    const [rows] = await db.query(
      "SELECT nombre, url, notas FROM portales_pendientes WHERE nombre LIKE ? ORDER BY creado DESC LIMIT 1",
      [`%${comercio}%`]
    );
    if (!rows.length) return res.json({ ok: true, portal: null });
    res.json({ ok: true, portal: rows[0] });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

// ── AGENTES — Generar bot nuevo ──────────────────────────────────────────────

const { analizarPortal } = require("./agentes/analizador");
const { generarBot }     = require("./agentes/generador");
const { validarBot }     = require("./agentes/validador");

// POST /api/admin/agente/analizar
app.post("/api/admin/agente/analizar", auth, requireAdmin, async (req, res) => {
  try {
    const { screenshotBase64, mimeType, url, notas } = req.body;
    if (!screenshotBase64 && !url)
      return res.json({ ok: false, msg: "Envía screenshotBase64 o url" });

    console.log("🔍 Agente Analizador iniciado");
    const analisis = await analizarPortal({ screenshotBase64, mimeType, url, notas });
    res.json({ ok: true, analisis });
  } catch (err) {
    console.error("❌ Agente Analizador:", err.message);
    res.json({ ok: false, msg: err.message });
  }
});

// POST /api/admin/agente/generar
app.post("/api/admin/agente/generar", auth, requireAdmin, async (req, res) => {
  try {
    const { analisisJson, nombrePortal } = req.body;
    if (!analisisJson || !nombrePortal)
      return res.json({ ok: false, msg: "Faltan analisisJson o nombrePortal" });

    console.log(`⚙️ Agente Generador iniciado para: ${nombrePortal}`);
    const resultado = await generarBot({ analisisJson, nombrePortal });
    res.json({ ok: true, ...resultado });
  } catch (err) {
    console.error("❌ Agente Generador:", err.message);
    res.json({ ok: false, msg: err.message });
  }
});

// POST /api/admin/agente/validar
app.post("/api/admin/agente/validar", auth, requireAdmin, async (req, res) => {
  try {
    const { codigo, nombrePortal, datosTest } = req.body;
    if (!codigo || !nombrePortal)
      return res.json({ ok: false, msg: "Faltan codigo o nombrePortal" });

    console.log(`🔬 Agente Validador iniciado para: ${nombrePortal}`);
    const validacion = await validarBot({ codigo, nombrePortal, datosTest });
    res.json({ ok: true, validacion });
  } catch (err) {
    console.error("❌ Agente Validador:", err.message);
    res.json({ ok: false, msg: err.message });
  }
});

// POST /api/admin/agente/orquestar — pipeline completo con DB + corrección automática
app.post("/api/admin/agente/orquestar", auth, requireAdmin, async (req, res) => {
  try {
    const { portalUrl, url, comercioNombre, nombrePortal, instrucciones, notas } = req.body;
    const urlFinal = portalUrl || url;
    const nombreFinal = comercioNombre || nombrePortal;
    if (!urlFinal || !nombreFinal)
      return res.json({ ok: false, msg: "portalUrl y comercioNombre son requeridos" });

    // FASE 5: encolado (el pipeline puede tardar 40+ min — ya no cabe dentro de
    // un solo request HTTP, ni en Railway ni sobre todo detrás de Vercel). El
    // panel hace polling de GET /api/admin/agente/estado/:jobId.
    const job = await encolarOrquestacionManual(req.session.userId, nombreFinal, urlFinal, instrucciones || notas || '');
    console.log(`🎭 [Orquestador] Encolado job ${job.id} para: ${nombreFinal}`);
    res.json({ ok: true, encolado: true, jobId: job.id });
  } catch (err) {
    console.error("❌ Orquestador:", err.message);
    res.json({ ok: false, msg: err.message });
  }
});

// GET /api/admin/agente/estado/:jobId — polling del resultado de /orquestar
app.get("/api/admin/agente/estado/:jobId", auth, requireAdmin, async (req, res) => {
  try {
    const job = await agenteQueue.getJob(req.params.jobId);
    if (!job) return res.json({ ok: false, msg: "Job no encontrado" });
    const estado = await job.getState(); // waiting | active | completed | failed | delayed
    res.json({
      ok: true,
      estado,
      resultado: estado === "completed" ? job.returnvalue : null,
      error: estado === "failed" ? job.failedReason : null,
    });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

// POST /api/admin/agente/aprobar  — escribe archivos a producción
app.post("/api/admin/agente/aprobar", auth, requireAdmin, async (req, res) => {
  try {
    const { codigo, nombreArchivo, nombreFuncion, analisis, nombrePortal } = req.body;
    if (!codigo || !nombreArchivo || !nombreFuncion)
      return res.json({ ok: false, msg: "Faltan codigo, nombreArchivo o nombreFuncion" });

    const archivos = [];

    // 1) Escribir bots/{nombreArchivo}
    const botPath = path.join(__dirname, "bots", nombreArchivo);
    fs.writeFileSync(botPath, codigo, "utf8");
    archivos.push(`bots/${nombreArchivo}`);
    console.log(`📝 Bot escrito: ${botPath}`);

    // 2) Actualizar bots/index.js
    const indexPath = path.join(__dirname, "bots", "index.js");
    let indexJs = fs.readFileSync(indexPath, "utf8");

    const requireLine = `const { ${nombreFuncion} } = require('./${nombreArchivo}');`;
    if (!indexJs.includes(requireLine)) {
      // Insertar después del último require existente
      indexJs = indexJs.replace(
        /(const \{[^}]+\} = require\('[^']+'\);)\s*\n(?!const)/,
        (match) => match + `\n${requireLine}\n`
      );
      archivos.push("bots/index.js (require)");
    }

    const claveDeteccion = nombrePortal.toLowerCase().replace(/[^a-z0-9]/g, "");
    const ifBlock = `
  if (
    portal === '${claveDeteccion}' ||
    comercio.includes('${claveDeteccion}') ||
    texto.includes('${claveDeteccion}')
  ) {
    console.log('🎯 Portal detectado: ${nombrePortal}');
    return await ${nombreFuncion}(datos);
  }
`;
    if (!indexJs.includes(nombreFuncion + "(datos)")) {
      // Insertar antes del log de "Portal no reconocido"
      indexJs = indexJs.replace(
        "console.log('⚠️ Portal no reconocido:",
        ifBlock + "  console.log('⚠️ Portal no reconocido:"
      );
      archivos.push("bots/index.js (detección)");
    }

    fs.writeFileSync(indexPath, indexJs, "utf8");
    console.log(`📝 index.js actualizado`);

    // 3) Actualizar portales/portales.json
    const portalesPath = path.join(__dirname, "portales", "portales.json");
    const portalesJson = JSON.parse(fs.readFileSync(portalesPath, "utf8"));

    if (!portalesJson.portales[claveDeteccion]) {
      portalesJson.portales[claveDeteccion] = {
        nombre: analisis?.nombre || nombrePortal,
        bot: `bots/${nombreArchivo}`,
        estado: "en_desarrollo",
        url_base: analisis?.url_base || "",
        tecnologia: analisis?.tecnologia || "desconocida",
        stealth: true,
        comercios: [nombrePortal],
        deteccion: {
          por_portal_field: claveDeteccion,
          por_texto_ocr: [claveDeteccion],
          por_comercio: [claveDeteccion],
          por_url_qr: [],
        },
        campos_ticket: (analisis?.campos || [])
          .filter((c) => c.requerido)
          .map((c) => c.nombre),
        campos_fiscales: ["rfc", "razonSocial", "regimenFiscal", "usoCfdi"],
        flujo: analisis?.pasos || [],
        comportamientos_especiales: analisis?.casos_especiales || [],
        notas_desarrollo: "Bot generado por IA — pendiente validar caso de éxito",
      };
      portalesJson.actualizado = new Date().toISOString().split("T")[0];
      fs.writeFileSync(portalesPath, JSON.stringify(portalesJson, null, 2), "utf8");
      archivos.push("portales/portales.json");
      console.log(`📝 portales.json actualizado con: ${claveDeteccion}`);
    }

    // 4) Git commit + push (requiere GIT_TOKEN en Railway env vars)
    let gitMsg = null;
    try {
      const cwd = __dirname;
      const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

      // Configurar identidad git si no está
      try { execSync('git config user.email "bot@portal-facturas.com"', { cwd, env: gitEnv }); } catch {}
      try { execSync('git config user.name "Portal Facturas Bot"', { cwd, env: gitEnv }); } catch {}

      // Configurar remote con token si existe
      if (process.env.GIT_TOKEN) {
        const remoteUrl = execSync("git remote get-url origin", { cwd, env: gitEnv })
          .toString().trim();
        const tokenUrl = remoteUrl.replace("https://", `https://${process.env.GIT_TOKEN}@`);
        execSync(`git remote set-url origin "${tokenUrl}"`, { cwd, env: gitEnv });
      }

      execSync(`git add "${botPath}" "${indexPath}" "${portalesPath}"`, { cwd, env: gitEnv });
      execSync(`git commit -m "feat: bot ${nombreArchivo} generado por IA [auto]"`, { cwd, env: gitEnv });
      execSync("git push origin main", { cwd, env: gitEnv, timeout: 30000 });

      gitMsg = "Commit y push a main exitoso — Railway redesplegando...";
      archivos.push("git: commit + push a main");
      console.log(`✅ Git push exitoso: ${nombreArchivo}`);
    } catch (gitErr) {
      gitMsg = `Archivos escritos OK, pero git push falló: ${gitErr.message.split("\n")[0]}. Haz push manual.`;
      console.warn("⚠️ Git push falló (archivos escritos correctamente):", gitErr.message);
    }

    res.json({
      ok: true,
      msg: `Bot desplegado en ${archivos.length} archivo(s)`,
      archivos,
      git: gitMsg,
    });
  } catch (err) {
    console.error("❌ Aprobar bot:", err.message);
    res.json({ ok: false, msg: err.message });
  }
});

// ── ENDPOINT ADMIN: historial de intentos de un ticket ──
app.get("/api/admin/tickets/:id/intentos", auth, requireAdmin, async (req, res) => {
  try {
    const [intentos] = await db.query(
      `SELECT id, bot, resultado, mensaje, screenshot_urls, duracion_ms, creado
       FROM ticket_intentos WHERE ticket_id = ? ORDER BY creado DESC LIMIT 20`,
      [req.params.id]
    );
    res.json({ ok: true, intentos: intentos.map(i => ({
      ...i,
      screenshot_urls: i.screenshot_urls ? JSON.parse(i.screenshot_urls) : [],
      duracion_s: i.duracion_ms ? (i.duracion_ms / 1000).toFixed(1) + 's' : null,
    })) });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

// ── ENDPOINT ADMIN: forzar reproceso IMAP de un ticket atascado ──
// ── ENDPOINT ADMIN: tickets en error ──
app.get("/api/admin/tickets/errores", auth, requireAdmin, async (req, res) => {
  try {
    const [tickets] = await db.query(`
      SELECT t.id, t.comercio, t.status, t.ocr_json, t.creado,
             u.nombre AS user_nombre, u.email AS user_email
      FROM tickets t
      JOIN users u ON t.user_id = u.id
      WHERE t.status = 'error'
      ORDER BY t.creado DESC
      LIMIT 50
    `);
    res.json({ ok: true, tickets });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

// ── ENDPOINT ADMIN: debug screenshots de R2 ──
app.get("/api/admin/debug-files", auth, requireAdmin, async (req, res) => {
  try {
    const { comercio } = req.query;
    const prefijos = comercio
      ? [`debug/${comercio.toLowerCase().split(' ')[0]}`]
      : ['debug/'];
    const archivos = await listarArchivosR2(prefijos[0], 30);
    const soloImagenes = archivos
      .filter(a => a.key.endsWith('.png'))
      .sort((a, b) => new Date(b.fecha) - new Date(a.fecha))
      .slice(0, 20);
    res.json({ ok: true, archivos: soloImagenes });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

// ── ENDPOINT ADMIN: revertir factura errónea de un ticket ──
// Borra el XML/PDF de R2, elimina el registro de factura y resetea el ticket
// a procesando_correo para que el job IMAP lo reintente.
app.post("/api/admin/tickets/:id/revertir-factura", auth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const [[ticket]] = await db.query("SELECT id, status, comercio FROM tickets WHERE id = ?", [id]);
    if (!ticket) return res.json({ ok: false, msg: "Ticket no encontrado" });

    const [[factura]] = await db.query(
      "SELECT id, xml_url, pdf_url FROM facturas WHERE ticket_id = ? ORDER BY id DESC LIMIT 1",
      [id]
    );

    const borrados = [];
    if (factura) {
      const r2Base = process.env.R2_PUBLIC_URL || '';
      for (const url of [factura.xml_url, factura.pdf_url].filter(Boolean)) {
        const key = url.startsWith(r2Base) ? url.slice(r2Base.length + 1) : url;
        try { await borrarArchivoR2(key); borrados.push(key); }
        catch (e) { console.log(`⚠️ No se pudo borrar ${key}:`, e.message); }
      }
      await db.query("DELETE FROM facturas WHERE id = ?", [factura.id]);
      console.log(`🗑️ Admin: factura #${factura.id} del ticket #${id} eliminada. R2: ${borrados.join(', ')}`);
    } else {
      console.log(`ℹ️ Admin: ticket #${id} no tiene factura registrada`);
    }

    // Resetear a procesando_correo con timestamp fresco para que el job IMAP reintente
    await db.query(
      "UPDATE tickets SET status = 'procesando_correo', procesando_correo_desde = NOW(), error_msg = NULL WHERE id = ?",
      [id]
    );

    console.log(`🔄 Admin: ticket #${id} (${ticket.comercio}) revertido → procesando_correo`);
    res.json({
      ok: true,
      msg: `Ticket #${id} revertido. Factura eliminada. Archivos borrados de R2: ${borrados.join(', ') || 'ninguno'}. El job IMAP lo reintentará en los próximos 2 minutos.`,
    });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

app.post("/api/admin/tickets/:id/reprocess-imap", auth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const [[ticket]] = await db.query("SELECT id, status FROM tickets WHERE id = ?", [id]);
    if (!ticket) return res.json({ ok: false, msg: "Ticket no encontrado" });
    await db.query("UPDATE tickets SET status = 'procesando_correo', procesando_correo_desde = NOW() WHERE id = ?", [id]);
    console.log(`🔄 Admin: ticket #${id} marcado para reproceso IMAP (era: ${ticket.status})`);
    res.json({ ok: true, msg: `Ticket #${id} encolado para reproceso IMAP` });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

// ── ENDPOINT ADMIN: renombrar facturas existentes con UUID del CFDI ──
app.post("/api/admin/facturas/renombrar-uuid", auth, requireAdmin, async (req, res) => {
  try {
    const [facturas] = await db.query(
      `SELECT id, ticket_id, comercio, xml_url, pdf_url FROM facturas
       WHERE xml_url IS NOT NULL AND xml_url NOT REGEXP '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
       ORDER BY id ASC`
    );
    console.log(`🔖 Migración UUID: ${facturas.length} factura(s) sin UUID en nombre`);

    const resultados = [];
    for (const f of facturas) {
      try {
        const { xmlUrl, pdfUrl } = await renombrarConUUID(f.xml_url, f.pdf_url, f.comercio);
        if (xmlUrl !== f.xml_url || pdfUrl !== f.pdf_url) {
          await db.query(
            "UPDATE facturas SET xml_url = ?, pdf_url = ? WHERE id = ?",
            [xmlUrl, pdfUrl, f.id]
          );
          console.log(`✅ Factura #${f.id} renombrada`);
          resultados.push({ id: f.id, ok: true, xmlUrl, pdfUrl });
        } else {
          resultados.push({ id: f.id, ok: false, msg: 'UUID no extraído o nombre ya correcto' });
        }
      } catch (e) {
        resultados.push({ id: f.id, ok: false, msg: e.message });
      }
    }
    res.json({ ok: true, total: facturas.length, resultados });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

// FASE 1: los jobs de IMAP (conciliación por correo) y reintentos programados
// viven ahora en lib/imap-job.js y corren en el worker.


// ── AGENTES — Fase 5: CRUD portales gestionados ──────────────────────────────

// Listar todos los portales gestionados por agentes
app.get("/api/admin/agente/portales", auth, requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT id, comercio, nombre, estado, intentos_correccion, error_msg, nombre_archivo, nombre_funcion, creado, actualizado FROM portales_agente ORDER BY creado DESC"
    );
    res.json({ ok: true, portales: rows });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

// Detalle de un portal (incluye código generado y análisis)
app.get("/api/admin/agente/portales/:id", auth, requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM portales_agente WHERE id = ? LIMIT 1", [req.params.id]);
    if (!rows.length) return res.json({ ok: false, msg: "No encontrado" });
    res.json({ ok: true, portal: rows[0] });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

// Aprobar y activar bot generado
app.post("/api/admin/agente/portales/:id/aprobar", auth, requireAdmin, async (req, res) => {
  try {
    console.log(`✅ [Admin] Activando bot portal #${req.params.id}`);
    const resultado = await activarBot({ db, portalId: parseInt(req.params.id) });
    console.log(`✅ [Admin] Bot activado:`, JSON.stringify(resultado));
    res.json(resultado);
  } catch (e) {
    console.error(`❌ [Admin] Error activando bot #${req.params.id}:`, e.message);
    res.json({ ok: false, msg: e.message });
  }
});

// Rechazar y reiniciar orquestación con notas
app.post("/api/admin/agente/portales/:id/rechazar", auth, requireAdmin, async (req, res) => {
  const { notas } = req.body;
  try {
    await db.query(
      "UPDATE portales_agente SET estado = 'error', error_msg = ? WHERE id = ?",
      [notas || 'Rechazado manualmente', req.params.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

// Eliminar registro de portales_agente (limpiar bots malos)
app.delete("/api/admin/agente/portales/:id", auth, requireAdmin, async (req, res) => {
  try {
    await db.query("DELETE FROM portales_agente WHERE id = ?", [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

// Editar código del bot manualmente
app.put("/api/admin/agente/portales/:id/codigo", auth, requireAdmin, async (req, res) => {
  try {
    const { bot_code } = req.body;
    await db.query("UPDATE portales_agente SET bot_code = ? WHERE id = ?", [bot_code, req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

// Re-orquestar un portal existente (con notas corregidas)
app.post("/api/admin/agente/portales/:id/reorquestar", auth, requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM portales_agente WHERE id = ? LIMIT 1", [req.params.id]);
    if (!rows.length) return res.json({ ok: false, msg: "No encontrado" });
    const portal = rows[0];
    const { instrucciones } = req.body;
    // Mismo fix que /orquestar: el pipeline puede tardar 40+ min, no cabe inline
    // en un request HTTP. Se encola y el panel hace polling del jobId.
    const job = await encolarOrquestacionManual(
      req.session.userId, portal.nombre, portal.portal_url, instrucciones || portal.instrucciones || ''
    );
    res.json({ ok: true, encolado: true, jobId: job.id });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

// Resetear ticket: borra factura mal guardada y re-encola la facturación
app.post("/api/admin/tickets/:id/resetear", auth, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await db.query("DELETE FROM facturas WHERE ticket_id = ?", [id]);
    await db.query(
      "UPDATE tickets SET status='pendiente_confirmacion', requiere_confirmacion=0, error_msg=NULL, procesando_correo_desde=NULL, reintento_programado=NULL WHERE id=?",
      [id]
    );
    // FASE 1: encolar directo en la cola de bots (antes lo retomaba procesarCola)
    const [[tk]] = await db.query("SELECT user_id, ocr_json, comercio FROM tickets WHERE id = ?", [id]);
    if (tk) {
      let ocr = {}; try { ocr = JSON.parse(tk.ocr_json || '{}'); } catch {}
      const portalKey = (ocr.portal || tk.comercio || 'desconocido').toLowerCase().replace(/\s+/g, '');
      await encolarBot(id, tk.user_id, portalKey);
    }
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

// ── COLA MUERTA (FASE 1): jobs que agotaron sus reintentos ───────────────────
// Nada se pierde en silencio: aquí se listan, se reintentan o se descartan.
app.get("/api/admin/cola-muerta", auth, requireAdmin, async (req, res) => {
  try {
    const jobs = await listarColaMuerta(parseInt(req.query.limite) || 50);
    res.json({ ok: true, total: jobs.length, jobs });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

app.post("/api/admin/cola-muerta/:cola/:jobId/reintentar", auth, requireAdmin, async (req, res) => {
  try {
    await reintentarJobMuerto(req.params.cola, req.params.jobId);
    res.json({ ok: true, msg: `Job ${req.params.jobId} re-encolado en ${req.params.cola}` });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

app.delete("/api/admin/cola-muerta/:cola/:jobId", auth, requireAdmin, async (req, res) => {
  try {
    const borrado = await borrarJobMuerto(req.params.cola, req.params.jobId);
    res.json({ ok: borrado, msg: borrado ? "Job eliminado" : "Job no encontrado" });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

// ── LIMPIEZA TEMPORAL: borrar datos de un comercio ──────────────────────────
app.delete("/api/admin/limpiar-comercio/:slug", auth, requireAdmin, async (req, res) => {
  try {
    const slug = req.params.slug.toLowerCase();
    const [t] = await db.query("DELETE FROM tickets WHERE LOWER(comercio) LIKE ?", [`%${slug}%`]);
    const [pa] = await db.query("DELETE FROM portales_agente WHERE LOWER(comercio) LIKE ? OR LOWER(nombre) LIKE ?", [`%${slug}%`, `%${slug}%`]);
    const [pp] = await db.query("DELETE FROM portales_pendientes WHERE LOWER(nombre) LIKE ?", [`%${slug}%`]);
    res.json({ ok: true, tickets: t.affectedRows, portales_agente: pa.affectedRows, portales_pendientes: pp.affectedRows });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

// ── Endpoint de versión (diagnóstico) ─────────────────────────────────────────
// Railway no incluye .git/ en la imagen final (Nixpacks) → "git rev-parse" en
// runtime siempre fallaba y devolvía 'desconocido'. Railway sí inyecta el commit
// como variable de entorno en cada deploy — eso es lo que hay que leer.
app.get('/api/version', (req, res) => {
  let commit = process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) || null;
  if (!commit) {
    try { commit = execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim(); }
    catch { commit = 'desconocido'; }
  }
  res.json({
    commit,
    branch: process.env.RAILWAY_GIT_BRANCH || null,
    ts: new Date().toISOString(),
    node: process.version,
  });
});

// ─────────────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`🚀 Servidor corriendo en puerto ${PORT}`));
