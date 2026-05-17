require("dotenv").config();
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const mysql = require("mysql2/promise");
const path = require("path");
const multer = require("multer");
const fs = require("fs");
const Anthropic = require("@anthropic-ai/sdk");
const nodemailer = require("nodemailer");
const { detectarYFacturar } = require("./bots/index");
const { borrarArchivoR2 } = require("./storage/r2");
const { esperarFacturaPorCorreo } = require("./mail/imap");

const app = express();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT) || 465,
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  connectionTimeout: 10000,
  greetingTimeout: 10000,
  socketTimeout: 15000,
});

transporter.verify((error) => {
  if (error) console.log('⚠️ SMTP no disponible:', error.message);
  else console.log('✅ SMTP conectado correctamente');
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || "gpnsecret123",
  resave: false,
  saveUninitialized: false,
}));

const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  database: process.env.DB_DATABASE,
});

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

async function crearNotificacion(userId, tipo, mensaje) {
  try {
    await db.query(
      "INSERT INTO notificaciones (user_id, tipo, mensaje) VALUES (?, ?, ?)",
      [userId, tipo, mensaje]
    );
  } catch (e) {
    console.error("⚠️ crearNotificacion:", e.message);
  }
}

function corregirIdVentaOxxo(id) {
  if (!id) return id;
  const map = { T:'1', t:'1', I:'1', i:'1', O:'0', o:'0', S:'5', s:'5' };
  const result = id.split('');
  [0, 1, 5, 6].forEach(i => {
    if (result[i]) result[i] = result[i].replace(/[TtIiOoSs]/g, c => map[c] || c);
  });
  return result.join('').toUpperCase();
}

function corregirFolioOxxo(folio) {
  if (!folio) return folio;
  return String(folio).replace(/[OoSsIiTt]/g,
    c => ({ O:'0', o:'0', S:'5', s:'5', I:'1', i:'1', T:'1', t:'1' }[c] || c)
  );
}

function validarDatosOxxo(datos) {
  const errores = [];
  if (!datos.folio || !/^\d+$/.test(String(datos.folio).replace(/\s/, '')))
    errores.push('folio inválido: ' + datos.folio);
  if (!datos.idVenta || !/^\d{2}[A-Z]{3}\d{2}[A-Z0-9]+\d{1,2}$/.test(
    corregirIdVentaOxxo(String(datos.idVenta).toUpperCase())
  )) errores.push('idVenta inválido: ' + datos.idVenta);
  if (!datos.total || isNaN(parseFloat(datos.total)))
    errores.push('total inválido: ' + datos.total);
  return errores;
}

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
    await db.query("ALTER TABLE tickets MODIFY COLUMN status ENUM('pendiente','procesando','procesando_correo','procesado','error','pendiente_confirmacion') NOT NULL DEFAULT 'pendiente'");
  } catch(e) { /* enum ya actualizado */ }

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
}
initDB();

const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    cb(null, Date.now() + "-" + file.originalname.replace(/\s+/g, "_"));
  },
});
const upload = multer({ storage });

// ── MIDDLEWARE ──
function auth(req, res, next) {
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
app.get("/dashboard", auth, (req, res) => res.sendFile(path.join(__dirname, "public", "dashboard.html")));
app.get("/mis-tickets", auth, (req, res) => res.sendFile(path.join(__dirname, "public", "mis-tickets.html")));
app.get("/mis-facturas", auth, (req, res) => res.sendFile(path.join(__dirname, "public", "mis-facturas.html")));
app.get("/perfil", auth, (req, res) => res.sendFile(path.join(__dirname, "public", "perfil.html")));
app.get("/admin-residentes", auth, requireAdmin, (req, res) =>
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
    req.session.userId   = rows[0].id;
    req.session.userName = rows[0].nombre;
    req.session.userRfc  = rows[0].rfc || "";
    req.session.userRol  = rows[0].rol || "residente";
    res.json({ ok: true });
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
      "SELECT rfc, razon_social, calle, num_ext, num_int, colonia, municipio, estado, codigo_postal, regimen_fiscal, uso_cfdi FROM users WHERE id = ?",
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
    res.json({ ok: true, residentes: rows });
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

// ── SUBIR TICKET + OCR ──
app.post("/upload-ticket", auth, upload.single("ticket"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, msg: "No se recibió archivo" });

    const imageData = fs.readFileSync(req.file.path);
    const base64Image = imageData.toString("base64");
    const mimeType = req.file.mimetype;
    const residente_id = req.body.residente_id ? parseInt(req.body.residente_id) : null;

    let datosOCR = {};
    let textoOCR = "";
    let portalDetectado = "desconocido";

    // ── PASADA 1: Detección de portal (Haiku) ──
    console.log("🔍 Pasada 1: detección con Haiku...");
    const t1start = Date.now();
    try {
      const resp1 = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mimeType, data: base64Image } },
            { type: "text", text: `Identifica el tipo de ticket de compra. Responde SOLO este JSON:
{
  "portal": "oxxo" | "arco" | "gasmaz" | "farmaciaguadalajara" | "desconocido",
  "confianza": número del 0 al 100,
  "urlQR": "URL completa si hay un QR de facturación, o null",
  "comercio": "nombre del comercio"
}
- "oxxo": si ves logo/nombre OXXO, o texto "Fol_Vta:" e "ID="
- "arco": si ves ARCO o referencia a buzonfacturas.com
- "gasmaz": si ves GASMAZ, NexusFuel, o URL nexusfuel.mx
- "farmaciaguadalajara": si ves Farmacias Guadalajara, Fragua, Corporativo Fragua, o URL farmaciasguadalajara.com
- "desconocido": cualquier otro caso` }
          ],
        }],
      });
      const t1ms = Date.now() - t1start;
      const det = JSON.parse(resp1.content[0].text.replace(/```json|```/g, "").trim());
      portalDetectado = det.portal || "desconocido";
      const urlQR = det.urlQR || null;
      if (det.comercio) datosOCR.comercio = det.comercio;
      console.log(`⏱️ Haiku detección: ${t1ms}ms | Portal: ${portalDetectado} (${det.confianza || 0}pts)`);

      // Si desconocido pero hay URL en QR, intentar resolver por URL
      if (portalDetectado === "desconocido" && urlQR) {
        const urlLow = urlQR.toLowerCase();
        if (urlLow.includes("nexusfuel") || urlLow.includes("gasmaz")) portalDetectado = "gasmaz";
        else if (urlLow.includes("buzonfacturas") || urlLow.includes("arco")) portalDetectado = "arco";
        else if (urlLow.includes("oxxo")) portalDetectado = "oxxo";
        else if (urlLow.includes("farmaciasguadalajara")) portalDetectado = "farmaciaguadalajara";
        if (portalDetectado !== "desconocido")
          console.log(`🔗 Portal resuelto por URL del QR: ${portalDetectado}`);
        datosOCR.portalUrl = urlQR;
      }

      // Si sigue desconocido, resolver por nombre del comercio detectado
      if (portalDetectado === "desconocido" && det.comercio) {
        const c = det.comercio.toLowerCase();
        if (c.includes("oxxo")) portalDetectado = "oxxo";
        else if (c.includes("arco")) portalDetectado = "arco";
        else if (c.includes("gasmaz") || c.includes("nexusfuel")) portalDetectado = "gasmaz";
        else if (c.includes("guadalajara") || c.includes("fragua")) portalDetectado = "farmaciaguadalajara";
        if (portalDetectado !== "desconocido")
          console.log(`🏪 Portal resuelto por nombre de comercio: ${portalDetectado}`);
      }
    } catch (e) {
      console.log("⚠️ Haiku detección falló:", e.message);
    }

    // ── PASADA 2: Extracción dirigida (Sonnet) ──
    const promptsPorPortal = {
      oxxo: `Extrae estos datos del ticket OXXO. Responde SOLO JSON sin texto adicional:
{
  "comercio": "OXXO",
  "fecha": "DD/MM/YYYY",
  "folio": "SOLO dígitos después de Fol_Vta: — corrige O→0 S→5 I→1 T→1",
  "idVenta": "código después de ID= — corrige O→0 S→5 I→1 en posiciones 0,1,5,6 — formato 2dig+3let+2dig+alfanum+1dig",
  "total": número sin signos,
  "portal": "oxxo",
  "ok": true
}`,
      arco: `Extrae estos datos del ticket ARCO/BuzonFacturas. Responde SOLO JSON sin texto adicional:
{
  "comercio": "nombre exacto de la gasolinera ARCO",
  "fecha": "DD/MM/YYYY",
  "codigoTicket": "número de barcode o código grande impreso para facturación (bajo el código de barras o etiquetado como Código/Folio)",
  "total": número sin signos,
  "portal": "arco",
  "ok": true
}`,
      gasmaz: `Extrae estos datos del ticket GASMAZ/NexusFuel. Responde SOLO JSON sin texto adicional:
{
  "comercio": "nombre de la gasolinera",
  "fecha": "DD/MM/YYYY",
  "referencia": "número de referencia grande (primer número prominente del ticket)",
  "folio": "número de ticket o folio",
  "total": número sin signos,
  "portalUrl": "URL COMPLETA del QR de facturación (debe incluir nexusfuel.mx), o null",
  "portal": "gasmaz",
  "ok": true
}`,
      farmaciaguadalajara: `Extrae estos datos del ticket de Farmacias Guadalajara. Responde SOLO JSON sin texto adicional:
{
  "comercio": "Farmacias Guadalajara",
  "fecha": "YYYY-MM-DD",
  "folioFactura": "número de folio formato XXXXXX-XXXXXX-X (con guiones)",
  "caja": "número de caja",
  "fechaCompra": "fecha de compra en formato YYYY-MM-DD",
  "noTicket": "número de ticket",
  "total": número sin signos,
  "portal": "farmaciaguadalajara",
  "ok": true
}`,
      desconocido: `Extrae los datos que puedas de este ticket. Responde SOLO JSON sin texto adicional:
{
  "comercio": "nombre del comercio",
  "fecha": "DD/MM/YYYY",
  "folio": "número de folio o ticket, o null",
  "total": número sin signos,
  "portalUrl": "URL de QR de facturación si aparece, o null",
  "portal": "desconocido",
  "ok": true
}`,
    };

    console.log(`🔍 Pasada 2: extracción Sonnet para portal '${portalDetectado}'...`);
    const t2start = Date.now();
    try {
      const resp2 = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 500,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mimeType, data: base64Image } },
            { type: "text", text: promptsPorPortal[portalDetectado] || promptsPorPortal.desconocido }
          ],
        }],
      });
      const t2ms = Date.now() - t2start;
      textoOCR = resp2.content[0].text;
      const extraido = JSON.parse(textoOCR.replace(/```json|```/g, "").trim());
      datosOCR = { ...datosOCR, ...extraido };
      const nCampos = Object.values(datosOCR).filter(v => v !== null && v !== undefined).length;
      console.log(`⏱️ Sonnet extracción: ${t2ms}ms | Campos: ${nCampos}`);
      console.log("✅ Datos extraídos:", datosOCR);
    } catch (e) {
      console.log("⚠️ Sonnet extracción falló:", e.message);
      if (!datosOCR.comercio) {
        return res.json({ ok: false, error: "No se pudo identificar el portal" });
      }
    }

    // Si Haiku no identificó el portal pero Sonnet extrajo el nombre del comercio, resolver ahora
    if (portalDetectado === "desconocido" && datosOCR.comercio) {
      const c = (datosOCR.comercio || "").toLowerCase();
      if (c.includes("oxxo")) portalDetectado = "oxxo";
      else if (c.includes("arco")) portalDetectado = "arco";
      else if (c.includes("gasmaz") || c.includes("nexusfuel")) portalDetectado = "gasmaz";
      else if (c.includes("guadalajara") || c.includes("fragua")) portalDetectado = "farmaciaguadalajara";
      if (portalDetectado !== "desconocido") {
        console.log(`🏪 Portal reclasificado por comercio Sonnet: ${portalDetectado}`);
        datosOCR.portal = portalDetectado;
      }
    }

    // Correcciones SOLO para OXXO
    if (portalDetectado === "oxxo" || datosOCR.portal === "oxxo") {
      datosOCR.folio = corregirFolioOxxo(datosOCR.folio);
      datosOCR.idVenta = corregirIdVentaOxxo(datosOCR.idVenta);
    }

    const portalUrl = datosOCR.portalUrl || (portalDetectado === "arco" ? "buzonfacturas" : null) || null;

    const camposPorPortal = {
      oxxo:                ['fecha', 'folio', 'idVenta', 'total'],
      arco:                ['codigoTicket', 'total'],
      gasmaz:              ['portalUrl', 'referencia', 'folio', 'total'],
      farmaciaguadalajara: ['folioFactura', 'caja', 'fechaCompra', 'noTicket'],
      desconocido:         ['fecha', 'total'],
    };
    const campos = camposPorPortal[portalDetectado] || camposPorPortal.desconocido;

    const ticketStatus = portalDetectado === "desconocido" ? "error" : "pendiente_confirmacion";
    const ticketPortalUrl = portalDetectado === "desconocido" ? "desconocido" : portalUrl;

    const [insertResult] = await db.query(
      "INSERT INTO tickets (user_id, nombre_archivo, ruta_archivo, ocr_text, ocr_json, comercio, status, residente_id, portal_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [req.session.userId, req.file.originalname, req.file.path, textoOCR, JSON.stringify(datosOCR), datosOCR.comercio || "desconocido", ticketStatus, residente_id, ticketPortalUrl]
    );
    const ticketId = insertResult.insertId;

    if (portalDetectado === "desconocido") {
      await crearNotificacion(
        req.session.userId,
        "portal_desconocido",
        `No reconocemos el portal de facturación de "${datosOCR.comercio || 'este comercio'}". El administrador fue notificado y lo configuraremos pronto.`
      );
      const [adminRows] = await db.query("SELECT id FROM users WHERE email = ?", [ADMIN_EMAIL]);
      if (adminRows.length > 0) {
        await crearNotificacion(
          adminRows[0].id,
          "portal_pendiente",
          `Nuevo portal detectado en ticket #${ticketId} de "${datosOCR.comercio || 'comercio desconocido'}". Revisa la sección Portales Pendientes.`
        );
      }
      return res.json({ ok: true, sinPortal: true, comercio: datosOCR.comercio || "desconocido", urlQR: datosOCR.portalUrl || null, datos: datosOCR, ticketId, campos });
    }

    res.json({ ok: true, msg: "Ticket procesado", datos: datosOCR, ticketId, campos });
  } catch (err) {
    console.error("❌ Error:", err.message);
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

    if (ticket.status !== 'pendiente_confirmacion') {
      return res.json({ ok: false, msg: "El ticket no está en estado de confirmación" });
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
      "UPDATE tickets SET ocr_json = ?, status = 'pendiente' WHERE id = ?",
      [JSON.stringify(datosConfirmados), ticketId]
    );

    res.json({ ok: true, msg: "Datos confirmados", ticketId });
  } catch (err) {
    console.error("❌ Error confirmar:", err.message);
    res.status(500).json({ ok: false, msg: err.message });
  }
});

// ── BOT FACTURAR ──
app.post("/facturar/:ticketId", auth, async (req, res) => {
  try {
    const { ticketId } = req.params;
    const [tickets] = await db.query(
      "SELECT t.*, u.email, u.nombre AS user_nombre FROM tickets t JOIN users u ON t.user_id = u.id WHERE t.id = ? AND t.user_id = ?",
      [ticketId, req.session.userId]
    );
    if (tickets.length === 0) return res.json({ ok: false, msg: "Ticket no encontrado" });
    const ticket = tickets[0];
    const datos = JSON.parse(ticket.ocr_json || "{}");
    console.log(`🎯 FACTURAR #${ticketId} — ocr_json leído de DB:`, JSON.stringify(datos));
    if (datos.portal === "oxxo" || (ticket.comercio || "").toLowerCase().includes("oxxo")) {
      datos.folio = corregirFolioOxxo(datos.folio);
      datos.idVenta = corregirIdVentaOxxo(datos.idVenta);
    }

    const [userRows] = await db.query(
      "SELECT rfc, razon_social, calle, num_ext, num_int, colonia, municipio, estado, codigo_postal, regimen_fiscal, uso_cfdi FROM users WHERE id = ?",
      [req.session.userId]
    );
    if (userRows.length === 0) return res.json({ ok: false, msg: "Perfil fiscal no encontrado" });
    const perfil = userRows[0];

    if (!perfil.rfc) return res.json({ ok: false, msg: "Completa tu perfil fiscal primero" });

    await db.query("UPDATE tickets SET status = 'procesando' WHERE id = ?", [ticketId]);

    const resultado = await detectarYFacturar({
      ...datos,
      rfc: perfil.rfc,
      razonSocial: perfil.razon_social,
      calle: perfil.calle,
      ext: perfil.num_ext,
      int: perfil.num_int,
      colonia: perfil.colonia,
      municipio: perfil.municipio,
      estado: perfil.estado,
      codigoPostal: perfil.codigo_postal,
      regimenFiscal: perfil.regimen_fiscal,
      usoCfdi: perfil.uso_cfdi || "G03",
      email: ticket.email,
      ticketId,
      ocr_text: ticket.ocr_text,
      portalUrl: datos.portalUrl || ticket.portal_url || null,
      comercio: ticket.comercio,
    });

    if (resultado.sinPortal) {
      await db.query(
        "UPDATE tickets SET status = 'error', portal_url = 'desconocido' WHERE id = ?",
        [ticketId]
      );
      await crearNotificacion(
        req.session.userId,
        "portal_desconocido",
        `No pudimos facturar tu ticket de ${ticket.comercio || "comercio desconocido"} porque no reconocemos el portal de facturación. El administrador ha sido notificado.`
      );
      const [adminRows] = await db.query("SELECT id FROM users WHERE email = ?", [ADMIN_EMAIL]);
      if (adminRows.length > 0) {
        await crearNotificacion(
          adminRows[0].id,
          "portal_pendiente",
          `Nuevo portal detectado en ticket #${ticketId} de ${ticket.comercio || "comercio desconocido"}. Revisa la sección Portales Pendientes.`
        );
      }
      return res.json({ ok: false, msg: "Portal de facturación no reconocido. El administrador ha sido notificado." });
    }

    if (resultado.ok && resultado.procesandoCorreo) {
      await db.query("UPDATE tickets SET status = 'procesando_correo' WHERE id = ?", [ticketId]);
      return res.json({ ok: true, procesandoCorreo: true, msg: "Factura generada — esperando correo con archivos XML/PDF. Te avisaremos cuando estén listos." });
    }

    if (resultado.ok) {
      const pdfUrl = resultado.pdfUrl || resultado.pdf || null;
      const xmlUrl = resultado.xmlUrl || resultado.xml || null;

      await db.query(
        "INSERT INTO facturas (user_id, ticket_id, comercio, pdf_url, xml_url, status) VALUES (?, ?, ?, ?, ?, ?)",
        [req.session.userId, ticketId, ticket.comercio, pdfUrl, xmlUrl, "completado"]
      );
      await db.query("UPDATE tickets SET status = 'procesado' WHERE id = ?", [ticketId]);

      // Enviar correo al usuario
      try {
        if (ticket.email) {
          await transporter.sendMail({
            from: '"GPN Facturas" <buzonfacturas@serviciosga.site>',
            to: ticket.email,
            subject: "✅ Tu factura está lista — GPN Pinturas y Recubrimientos",
            html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
              <div style="background:#3B6D11;padding:20px;border-radius:12px 12px 0 0;">
                <h2 style="color:#fff;margin:0;">GPN Pinturas y Recubrimientos</h2>
                <p style="color:#C0DD97;margin:4px 0 0;">Portal de Facturación Automática</p>
              </div>
              <div style="background:#f8faf6;padding:24px;border-radius:0 0 12px 12px;border:1px solid #e0edd5;">
                <p>Hola <strong>${ticket.user_nombre || ""}</strong>,</p>
                <p>Tu factura fue generada exitosamente y está lista para descargar.</p>
                <div style="margin:20px 0;">
                  ${xmlUrl ? `<a href="${xmlUrl}" style="display:inline-block;margin-right:10px;background:#EAF3DE;color:#27500A;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:500;">⬇ Descargar XML</a>` : ""}
                  ${pdfUrl ? `<a href="${pdfUrl}" style="display:inline-block;background:#3B6D11;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:500;">⬇ Descargar PDF</a>` : ""}
                </div>
                <p style="color:#555;">También puedes verla en el portal:</p>
                <a href="https://portal-facturas-production.up.railway.app/mis-facturas" style="display:inline-block;background:#3B6D11;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:500;">Ver mis facturas →</a>
                <p style="color:#999;font-size:12px;margin-top:20px;">
                  Los archivos estarán disponibles 60 días.<br>
                  GPN Facturas — Sistema automático de facturación.
                </p>
              </div>
            </div>`,
          });
          console.log("📧 Correo enviado a:", ticket.email);
        }
      } catch (mailErr) {
        console.log("⚠️ Error enviando correo (no crítico):", mailErr.message);
      }

      res.json({ ok: true, pdf: pdfUrl, xml: xmlUrl });
    } else {
      await db.query("UPDATE tickets SET status = 'error' WHERE id = ?", [ticketId]);
      res.json({ ok: false, msg: resultado.msg });
    }
  } catch (err) {
    console.error("❌ Error:", err.message);
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
    if (!["error", "pendiente", "pendiente_confirmacion"].includes(ticket.status))
      return res.json({ ok: false, msg: "Solo se pueden borrar tickets en estado error o pendiente" });

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
    let query = "SELECT id, nombre_archivo, comercio, status, creado, ocr_json, residente_id FROM tickets WHERE user_id = ?";
    const params = [req.session.userId];
    if (residente_id) {
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

// ── LISTAR FACTURAS ──
app.get("/api/facturas", auth, async (req, res) => {
  try {
    const { residente_id } = req.query;
    let query = "SELECT f.id, f.comercio, f.status, f.xml_url, f.pdf_url, f.creado FROM facturas f";
    const params = [req.session.userId];
    if (residente_id) {
      query += " JOIN tickets t ON f.ticket_id = t.id WHERE f.user_id = ? AND t.residente_id = ?";
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
        comercio,
        COUNT(*) AS total_tickets,
        MAX(creado) AS ultimo_ticket
      FROM tickets
      WHERE portal_url = 'desconocido'
        AND status = 'error'
      GROUP BY comercio
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

// ── DEBUG SCREENSHOT ──
app.get("/debug-screenshot", auth, async (req, res) => {
  const resultado = await detectarYFacturar({
    ocr_text: "oxxo fol_vta:4682868 id=10obr500ng1",
    comercio: "OXXO",
    fecha: "10/05/2026",
    folio: "4682868",
    idVenta: "10OBR500NG1",
    total: "57.00",
    rfc: "XAXX010101000",
    razonSocial: "PUBLICO EN GENERAL",
    calle: "AV TEST",
    ext: "123",
    colonia: "CENTRO",
    municipio: "CD OBREGON",
    codigoPostal: "85000",
    estado: "SONORA",
    regimenFiscal: "616",
    usoCfdi: "S01",
  });
  if (resultado.screenshot) {
    res.send(`<img src="data:image/png;base64,${resultado.screenshot}" style="max-width:100%">`);
  } else {
    res.json(resultado);
  }
});

// ── LIMPIEZA AUTOMÁTICA DE TICKETS ──
async function cleanupTickets() {
  try {
    const [rows] = await db.query(
      "SELECT id, ruta_archivo FROM tickets WHERE status = 'error' AND creado < NOW() - INTERVAL 30 DAY"
    );
    for (const t of rows) {
      if (t.ruta_archivo && fs.existsSync(t.ruta_archivo)) {
        fs.unlinkSync(t.ruta_archivo);
      }
      await db.query("DELETE FROM tickets WHERE id = ?", [t.id]);
    }
    if (rows.length) console.log(`🧹 Cleanup: ${rows.length} ticket(s) eliminados`);
  } catch (e) {
    console.error("❌ cleanupTickets:", e.message);
  }
}
cleanupTickets();
setInterval(cleanupTickets, 24 * 60 * 60 * 1000);

// ── LIMPIEZA DE FACTURAS VENCIDAS EN R2 ──
async function limpiarFacturasVencidas() {
  try {
    const limite = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    const [rows] = await db.query(
      "SELECT id, xml_url, pdf_url FROM facturas WHERE creado < ? AND xml_url IS NOT NULL",
      [limite]
    );
    for (const f of rows) {
      if (f.xml_url?.includes("r2.dev")) {
        const key = f.xml_url.split(".dev/")[1];
        await borrarArchivoR2(key);
      }
      if (f.pdf_url?.includes("r2.dev")) {
        const key = f.pdf_url.split(".dev/")[1];
        await borrarArchivoR2(key);
      }
      await db.query("UPDATE facturas SET xml_url = NULL, pdf_url = NULL WHERE id = ?", [f.id]);
    }
    if (rows.length > 0) console.log(`🗑️ ${rows.length} facturas vencidas limpiadas de R2`);
  } catch (e) {
    console.log("⚠️ Error en limpieza R2:", e.message);
  }
}
limpiarFacturasVencidas();
setInterval(limpiarFacturasVencidas, 24 * 60 * 60 * 1000);

// ── ENDPOINT ADMIN: forzar reproceso IMAP de un ticket atascado ──
app.post("/api/admin/tickets/:id/reprocess-imap", auth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const [[ticket]] = await db.query("SELECT id, status FROM tickets WHERE id = ?", [id]);
    if (!ticket) return res.json({ ok: false, msg: "Ticket no encontrado" });
    await db.query("UPDATE tickets SET status = 'procesando_correo' WHERE id = ?", [id]);
    console.log(`🔄 Admin: ticket #${id} marcado para reproceso IMAP (era: ${ticket.status})`);
    res.json({ ok: true, msg: `Ticket #${id} encolado para reproceso IMAP` });
  } catch (err) {
    res.status(500).json({ ok: false, msg: err.message });
  }
});

// ── JOB IMAP: procesar tickets en espera de correo ──
async function procesarTicketsPorCorreo() {
  let rows;
  try {
    // Hacer timeout de seguridad: tickets en procesando_correo por más de 30 min → error
    const [atascados] = await db.query(
      `SELECT t.id, t.user_id, t.comercio FROM tickets t
       WHERE t.status = 'procesando_correo'
         AND t.creado < DATE_SUB(NOW(), INTERVAL 30 MINUTE)`
    );
    for (const t of atascados) {
      await db.query("UPDATE tickets SET status = 'error' WHERE id = ?", [t.id]);
      await crearNotificacion(
        t.user_id,
        "factura_error",
        `El correo con tu factura de ${t.comercio || "comercio"} no llegó en el tiempo esperado. Por favor intenta facturar de nuevo.`
      );
      console.log(`⏰ Job IMAP: ticket #${t.id} expirado (>30 min en procesando_correo) → error`);
    }

    [rows] = await db.query(
      `SELECT t.id, t.ocr_json, t.comercio, t.user_id, u.email, u.nombre AS user_nombre
       FROM tickets t
       JOIN users u ON t.user_id = u.id
       WHERE t.status = 'procesando_correo'
       ORDER BY t.creado ASC
       LIMIT 5`
    );
  } catch (e) {
    console.log("⚠️ procesarTicketsPorCorreo query:", e.message);
    return;
  }
  if (!rows.length) return;

  console.log(`📬 Job IMAP: ${rows.length} ticket(s) esperando correo`);
  console.log(`🎫 Tickets en espera:`, rows.map(t => `#${t.id} (${t.comercio})`).join(", "));

  for (const ticket of rows) {
    const datos = JSON.parse(ticket.ocr_json || "{}");
    const codigoTicket = datos.codigoTicket || String(ticket.id);
    console.log(`📧 Procesando ticket #${ticket.id} (${ticket.comercio}) — buscando correo...`);

    try {
      const { xmlBuffer, pdfBuffer } = await esperarFacturaPorCorreo(codigoTicket, 10 * 60 * 1000);

      const ts = Date.now();
      let xmlUrl = null, pdfUrl = null;
      if (xmlBuffer) {
        const { subirArchivoR2 } = require("./storage/r2");
        xmlUrl = await subirArchivoR2(xmlBuffer, `facturas/imap_${ts}.xml`, "application/xml");
      }
      if (pdfBuffer) {
        const { subirArchivoR2 } = require("./storage/r2");
        pdfUrl = await subirArchivoR2(pdfBuffer, `facturas/imap_${ts}.pdf`, "application/pdf");
      }

      await db.query(
        "INSERT INTO facturas (user_id, ticket_id, comercio, pdf_url, xml_url, status) VALUES (?, ?, ?, ?, ?, ?)",
        [ticket.user_id, ticket.id, ticket.comercio, pdfUrl, xmlUrl, "completado"]
      );
      await db.query("UPDATE tickets SET status = 'procesado' WHERE id = ?", [ticket.id]);
      console.log(`✅ Job IMAP: ticket #${ticket.id} procesado`);

      try {
        if (ticket.email) {
          await transporter.sendMail({
            from: '"GPN Facturas" <buzonfacturas@serviciosga.site>',
            to: ticket.email,
            subject: "✅ Tu factura está lista — GPN Pinturas y Recubrimientos",
            html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
              <div style="background:#3B6D11;padding:20px;border-radius:12px 12px 0 0;">
                <h2 style="color:#fff;margin:0;">GPN Pinturas y Recubrimientos</h2>
                <p style="color:#C0DD97;margin:4px 0 0;">Portal de Facturación Automática</p>
              </div>
              <div style="background:#f8faf6;padding:24px;border-radius:0 0 12px 12px;border:1px solid #e0edd5;">
                <p>Hola <strong>${ticket.user_nombre || ""}</strong>,</p>
                <p>Tu factura de <strong>${ticket.comercio || "comercio"}</strong> está lista para descargar.</p>
                <div style="margin:20px 0;">
                  ${xmlUrl ? `<a href="${xmlUrl}" style="display:inline-block;margin-right:10px;background:#EAF3DE;color:#27500A;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:500;">⬇ Descargar XML</a>` : ""}
                  ${pdfUrl ? `<a href="${pdfUrl}" style="display:inline-block;background:#3B6D11;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:500;">⬇ Descargar PDF</a>` : ""}
                </div>
                <a href="https://portal-facturas-production.up.railway.app/mis-facturas" style="display:inline-block;background:#3B6D11;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:500;">Ver mis facturas →</a>
                <p style="color:#999;font-size:12px;margin-top:20px;">Los archivos estarán disponibles 60 días.</p>
              </div>
            </div>`,
          });
          console.log(`📧 Job IMAP: correo enviado a ${ticket.email}`);
        }
      } catch (mailErr) {
        console.log("⚠️ Job IMAP: error enviando correo:", mailErr.message);
      }

    } catch (imapErr) {
      console.log(`⚠️ Job IMAP: no llegó correo para ticket #${ticket.id} — intentando Estrategia B...`);

      try {
        const { facturarBuzonFacturas } = require("./bots/buzonfacturas");
        const datos = JSON.parse(ticket.ocr_json || "{}");
        const r = await facturarBuzonFacturas({ ...datos, ticketId: ticket.id, rfc: null });
        if (r.ok && (r.xmlUrl || r.pdfUrl)) {
          await db.query(
            "INSERT INTO facturas (user_id, ticket_id, comercio, pdf_url, xml_url, status) VALUES (?, ?, ?, ?, ?, ?)",
            [ticket.user_id, ticket.id, ticket.comercio, r.pdfUrl || null, r.xmlUrl || null, "completado"]
          );
          await db.query("UPDATE tickets SET status = 'procesado' WHERE id = ?", [ticket.id]);
          console.log(`✅ Job IMAP: Estrategia B exitosa para ticket #${ticket.id}`);
        } else {
          throw new Error(r.msg || "Estrategia B sin archivos");
        }
      } catch (bErr) {
        console.log(`❌ Job IMAP: Estrategia B falló para ticket #${ticket.id}:`, bErr.message);
        await db.query("UPDATE tickets SET status = 'error' WHERE id = ?", [ticket.id]);
        await crearNotificacion(
          ticket.user_id,
          "factura_error",
          `No se pudieron recuperar los archivos de tu factura de ${ticket.comercio || "comercio"}. Por favor intenta de nuevo o contacta al administrador.`
        );
        const [adminRows] = await db.query("SELECT id FROM users WHERE email = ?", [ADMIN_EMAIL]);
        if (adminRows.length > 0) {
          await crearNotificacion(
            adminRows[0].id,
            "factura_error_admin",
            `Error recuperando factura del ticket #${ticket.id} (${ticket.comercio || "?"}): ${bErr.message}`
          );
        }
      }
    }
  }
}
setInterval(procesarTicketsPorCorreo, 2 * 60 * 1000);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`🚀 Servidor corriendo en puerto ${PORT}`));
