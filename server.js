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

const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    cb(null, Date.now() + "-" + file.originalname.replace(/\s+/g, "_"));
  },
});
const upload = multer({ storage });

function auth(req, res, next) {
  if (!req.session.userId) return res.redirect("/");
  next();
}

// ── RUTAS WEB ──
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "login.html")));
app.get("/dashboard", auth, (req, res) => res.sendFile(path.join(__dirname, "public", "dashboard.html")));
app.get("/mis-tickets", auth, (req, res) => res.sendFile(path.join(__dirname, "public", "mis-tickets.html")));
app.get("/mis-facturas", auth, (req, res) => res.sendFile(path.join(__dirname, "public", "mis-facturas.html")));
app.get("/perfil", auth, (req, res) => res.sendFile(path.join(__dirname, "public", "perfil.html")));

// ── REGISTRO ──
app.post("/register", async (req, res) => {
  try {
    const { nombre, email, password } = req.body;
    const hashed = await bcrypt.hash(password, 10);
    await db.query("INSERT INTO users (nombre, email, password_hash) VALUES (?, ?, ?)", [nombre, email, hashed]);
    res.json({ ok: true });
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
    req.session.userId = rows[0].id;
    req.session.userName = rows[0].nombre;
    req.session.userRfc = rows[0].rfc || "";
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

app.get("/api/me", auth, (req, res) => {
  res.json({ id: req.session.userId, nombre: req.session.userName, rfc: req.session.userRfc });
});

app.get("/logout", (req, res) => req.session.destroy(() => res.redirect("/")));

// ── PERFIL FISCAL - GET ──
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

// ── PERFIL FISCAL - SAVE ──
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

// ── SUBIR TICKET + OCR CON CLAUDE VISION ──
app.post("/upload-ticket", auth, upload.single("ticket"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, msg: "No se recibió archivo" });

    const imageData = fs.readFileSync(req.file.path);
    const base64Image = imageData.toString("base64");
    const mimeType = req.file.mimetype;

    console.log("🔍 Analizando ticket con Claude Haiku...");

    let datosOCR = {};
    let textoOCR = "";

    const promptOCR = `Analiza este ticket de compra de OXXO y extrae EXACTAMENTE estos datos en formato JSON.

IMPORTANTE para tickets OXXO:
- "folio" es el número que aparece después de "Fol_Vta:" o "Folio:"
- "idVenta" es el código alfanumérico que aparece después de "ID=" (ejemplo: 1OOBR500NG1)
- Son campos DIFERENTES, no los confundas
- "fecha" es la fecha de la compra en formato DD/MM/YYYY
- "total" es el monto total en números sin signos

Responde SOLO este JSON sin texto adicional:
{
  "comercio": "nombre del comercio",
  "fecha": "DD/MM/YYYY",
  "folio": "solo números del Fol_Vta",
  "idVenta": "código alfanumérico del ID=",
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
      "INSERT INTO tickets (user_id, nombre_archivo, ruta_archivo, ocr_text, ocr_json, comercio, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [req.session.userId, req.file.originalname, req.file.path, textoOCR, JSON.stringify(datosOCR), datosOCR.comercio || "desconocido", "pendiente"]
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

    if (!perfil.rfc) return res.json({ ok: false, msg: "Completa tu perfil fiscal primero" });
    if (!datos.folio) return res.json({ ok: false, msg: "El ticket no tiene folio detectado" });
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
    const [rows] = await db.query(
      "SELECT id, nombre_archivo, comercio, status, creado, ocr_json FROM tickets WHERE user_id = ? ORDER BY creado DESC",
      [req.session.userId]
    );
    res.json({ ok: true, tickets: rows });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

// ── LISTAR FACTURAS ──
app.get("/api/facturas", auth, async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT id, comercio, status, xml_url, pdf_url, creado FROM facturas WHERE user_id = ? ORDER BY creado DESC",
      [req.session.userId]
    );
    res.json({ ok: true, facturas: rows });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

// ── DEBUG SCREENSHOT ──
app.get("/debug-screenshot", auth, async (req, res) => {
  const resultado = await facturarOXXO({
    fecha: "10/05/2026",
    folio: "4682868",
    idVenta: "1OOBR500NG1",
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

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`🚀 Servidor corriendo en puerto ${PORT}`));
