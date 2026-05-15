require("dotenv").config();
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const mysql = require("mysql2/promise");
const path = require("path");
const multer = require("multer");
const fs = require("fs");
const Anthropic = require("@anthropic-ai/sdk");
const { facturarOXXO } = require("./bots/oxxo");

const app = express();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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

// ── MIGRACIÓN DB ──
async function initDB() {
  try {
    await db.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS rol ENUM('admin','residente') NOT NULL DEFAULT 'residente'");
    await db.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS creado_por INT NULL");

    await db.query(`CREATE TABLE IF NOT EXISTS residentes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      nombre VARCHAR(100) NOT NULL,
      disponible TINYINT(1) DEFAULT 1,
      creado TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    await db.query(`CREATE TABLE IF NOT EXISTS user_residentes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      residente_id INT NOT NULL,
      asignado_por INT,
      creado TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (residente_id) REFERENCES residentes(id)
    )`);

    await db.query("ALTER TABLE tickets ADD COLUMN IF NOT EXISTS residente_id INT NULL");

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

    console.log("✅ DB schema actualizado");
  } catch (e) {
    console.log("ℹ️  DB migration:", e.message);
  }
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
    if (req.session.userRol === "admin") {
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
    } else {
      const [rows] = await db.query(`
        SELECT r.*
        FROM residentes r
        JOIN user_residentes ur ON r.id = ur.residente_id
        WHERE ur.user_id = ?
        ORDER BY r.nombre
      `, [req.session.userId]);
      res.json({ ok: true, residentes: rows });
    }
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

    console.log("🔍 Analizando ticket con Claude Haiku...");

    let datosOCR = {};
    let textoOCR = "";

    const promptOCR = `Analiza este ticket de compra de OXXO y extrae EXACTAMENTE estos datos en formato JSON.

REGLAS CRÍTICAS para tickets OXXO:

1. "folio" — es SOLO números, aparece después de "Fol_Vta:" en el ticket.
   Ejemplo: Fol_Vta:4682868 → folio = "4682868"

2. "idVenta" — aparece después de "ID=" en el ticket. Tiene este formato exacto:
   - Posición 1-2: SOLO NÚMEROS (ejemplo: 10)
   - Posición 3-5: SOLO LETRAS MAYÚSCULAS (ejemplo: OBR)
   - Posición 6-8: SOLO NÚMEROS (ejemplo: 500)
   - Posición 9-10: LETRAS Y NÚMEROS mezclados (ejemplo: NG)
   - Posición 11: SOLO UN NÚMERO (ejemplo: 1)
   - Resultado final ejemplo: 10OBR500NG1
   - MUY IMPORTANTE: NO confundas el número CERO (0) con la letra O mayúscula.
     Donde el formato dice NÚMEROS escribe dígitos 0-9, NUNCA letras.
     Donde el formato dice LETRAS escribe letras A-Z, NUNCA números.

3. "fecha" — fecha de la compra en formato DD/MM/YYYY

4. "total" — monto total en número sin signos ni texto

5. "folio" e "idVenta" son campos COMPLETAMENTE DIFERENTES, no los confundas.

Responde SOLO este JSON sin texto adicional:
{
  "comercio": "nombre del comercio",
  "fecha": "DD/MM/YYYY",
  "folio": "solo números del Fol_Vta",
  "idVenta": "código exacto del ID=",
  "total": número sin signos,
  "ok": true
}`;

    try {
      const response = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1000,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mimeType, data: base64Image } },
            { type: "text", text: promptOCR }
          ],
        }],
      });
      textoOCR = response.content[0].text;
      datosOCR = JSON.parse(textoOCR.replace(/```json|```/g, "").trim());
      console.log("✅ Haiku respondió:", datosOCR);
    } catch (e) {
      console.log("⚠️ Haiku falló, intentando Sonnet...");
    }

    if (!datosOCR.folio || !datosOCR.idVenta) {
      console.log("🔄 Reintentando con Sonnet...");
      try {
        const response2 = await anthropic.messages.create({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          messages: [{
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mimeType, data: base64Image } },
              { type: "text", text: promptOCR }
            ],
          }],
        });
        textoOCR = response2.content[0].text;
        datosOCR = JSON.parse(textoOCR.replace(/```json|```/g, "").trim());
        console.log("✅ Sonnet respondió:", datosOCR);
      } catch (e2) {
        datosOCR = { ok: false, raw: textoOCR };
      }
    }

    await db.query(
      "INSERT INTO tickets (user_id, nombre_archivo, ruta_archivo, ocr_text, ocr_json, comercio, status, residente_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [req.session.userId, req.file.originalname, req.file.path, textoOCR, JSON.stringify(datosOCR), datosOCR.comercio || "desconocido", "pendiente", residente_id]
    );

    res.json({ ok: true, msg: "Ticket procesado", datos: datosOCR });
  } catch (err) {
    console.error("❌ Error:", err.message);
    res.status(500).json({ ok: false, msg: err.message });
  }
});

// ── BOT FACTURAR ──
app.post("/facturar/:ticketId", auth, async (req, res) => {
  try {
    const { ticketId } = req.params;
    const [tickets] = await db.query(
      "SELECT * FROM tickets WHERE id = ? AND user_id = ?",
      [ticketId, req.session.userId]
    );
    if (tickets.length === 0) return res.json({ ok: false, msg: "Ticket no encontrado" });
    const ticket = tickets[0];
    const datos = JSON.parse(ticket.ocr_json || "{}");

    const [users] = await db.query(
      "SELECT rfc, razon_social, calle, num_ext, num_int, colonia, municipio, estado, codigo_postal, regimen_fiscal, uso_cfdi FROM users WHERE id = ?",
      [req.session.userId]
    );
    if (users.length === 0) return res.json({ ok: false, msg: "Perfil fiscal no encontrado" });
    const perfil = users[0];

    if (!perfil.rfc)    return res.json({ ok: false, msg: "Completa tu perfil fiscal primero" });
    if (!datos.folio)   return res.json({ ok: false, msg: "El ticket no tiene folio detectado" });
    if (!datos.idVenta) return res.json({ ok: false, msg: "El ticket no tiene ID de venta detectado" });

    await db.query("UPDATE tickets SET status = 'procesando' WHERE id = ?", [ticketId]);

    const resultado = await facturarOXXO({
      fecha: datos.fecha,
      folio: datos.folio,
      idVenta: datos.idVenta,
      total: datos.total,
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
    });

    if (resultado.ok) {
      await db.query(
        "INSERT INTO facturas (user_id, ticket_id, comercio, pdf_url, xml_url, status) VALUES (?, ?, ?, ?, ?, ?)",
        [req.session.userId, ticketId, ticket.comercio, resultado.pdf, resultado.xml, "completado"]
      );
      await db.query("UPDATE tickets SET status = 'procesado' WHERE id = ?", [ticketId]);
      res.json({ ok: true, pdf: resultado.pdf, xml: resultado.xml });
    } else {
      await db.query("UPDATE tickets SET status = 'error' WHERE id = ?", [ticketId]);
      res.json({ ok: false, msg: resultado.msg });
    }
  } catch (err) {
    console.error("❌ Error:", err.message);
    res.status(500).json({ ok: false, msg: err.message });
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

// ── DEBUG SCREENSHOT ──
app.get("/debug-screenshot", auth, async (req, res) => {
  const resultado = await facturarOXXO({
    fecha: "10/05/2026", folio: "4682868", idVenta: "10OBR500NG1", total: "57.00",
    rfc: "XAXX010101000", razonSocial: "PUBLICO EN GENERAL", calle: "AV TEST",
    ext: "123", colonia: "CENTRO", municipio: "CD OBREGON",
    codigoPostal: "85000", estado: "SONORA", regimenFiscal: "616", usoCfdi: "S01",
  });
  if (resultado.screenshot) {
    res.send(`<img src="data:image/png;base64,${resultado.screenshot}" style="max-width:100%">`);
  } else {
    res.json(resultado);
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`🚀 Servidor corriendo en puerto ${PORT}`));
