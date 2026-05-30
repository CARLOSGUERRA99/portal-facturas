require("dotenv").config();
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const mysql = require("mysql2/promise");
const path = require("path");
const multer = require("multer");
const fs = require("fs");
const { execSync } = require("child_process");
const Anthropic = require("@anthropic-ai/sdk");
const nodemailer = require("nodemailer");
const { detectarYFacturar } = require("./bots/index");
const { orquestar, activarBot, restaurarBotsDinamicos } = require("./agentes/orquestador");
const { subirArchivoR2, borrarArchivoR2, listarArchivosR2 } = require("./storage/r2");
const { esperarFacturaPorCorreo } = require("./mail/imap");

// Extrae el UUID del CFDI desde el contenido XML (atributo UUID de TimbreFiscalDigital)
function extraerUUIDcfdi(xmlBuffer) {
  try {
    const xml = xmlBuffer.toString('utf8');
    const m = xml.match(/UUID="([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i);
    return m ? m[1].toLowerCase() : null;
  } catch { return null; }
}

// Descarga XML desde R2, extrae UUID, re-sube XML y PDF con nombre {comercio}_{uuid},
// borra los archivos originales y devuelve { xmlUrl, pdfUrl } con los nuevos nombres.
// Si no puede extraer UUID, devuelve las URLs originales sin cambios.
async function renombrarConUUID(xmlUrlOrig, pdfUrlOrig, comercio) {
  try {
    const r2Base = process.env.R2_PUBLIC_URL;
    if (!r2Base || !xmlUrlOrig) return { xmlUrl: xmlUrlOrig, pdfUrl: pdfUrlOrig };

    // Descargar XML para leer el UUID
    const xmlResp = await fetch(xmlUrlOrig).catch(() => null);
    if (!xmlResp?.ok) return { xmlUrl: xmlUrlOrig, pdfUrl: pdfUrlOrig };
    const xmlBuf = Buffer.from(await xmlResp.arrayBuffer());

    const uuid = extraerUUIDcfdi(xmlBuf);
    if (!uuid) {
      console.log('⚠️ UUID no encontrado en XML — se mantienen nombres originales');
      return { xmlUrl: xmlUrlOrig, pdfUrl: pdfUrlOrig };
    }

    const prefijo = `facturas/${uuid}`;
    console.log(`🔖 UUID CFDI: ${uuid}`);

    // Re-subir XML
    const xmlUrl = await subirArchivoR2(xmlBuf, `${prefijo}.xml`, 'application/xml');

    // Re-subir PDF si existe
    let pdfUrl = pdfUrlOrig;
    if (pdfUrlOrig) {
      const pdfResp = await fetch(pdfUrlOrig).catch(() => null);
      if (pdfResp?.ok) {
        const pdfBuf = Buffer.from(await pdfResp.arrayBuffer());
        pdfUrl = await subirArchivoR2(pdfBuf, `${prefijo}.pdf`, 'application/pdf');
      }
    }

    // Borrar archivos originales si cambiaron de nombre
    const xmlKeyOrig = xmlUrlOrig.replace(r2Base + '/', '');
    const pdfKeyOrig = pdfUrlOrig?.replace(r2Base + '/', '');
    if (xmlUrl && xmlKeyOrig !== `${prefijo}.xml`) await borrarArchivoR2(xmlKeyOrig);
    if (pdfUrl && pdfKeyOrig && pdfKeyOrig !== `${prefijo}.pdf`) await borrarArchivoR2(pdfKeyOrig);

    return { xmlUrl, pdfUrl };
  } catch (e) {
    console.log('⚠️ renombrarConUUID error:', e.message);
    return { xmlUrl: xmlUrlOrig, pdfUrl: pdfUrlOrig };
  }
}

// Construye el prompt de detección dinámicamente desde portales.json
function buildPromptDeteccion() {
  let portalesData = { portales: {} };
  try {
    const raw = fs.readFileSync(path.join(__dirname, "portales/portales.json"), "utf8");
    portalesData = JSON.parse(raw);
  } catch {}

  const portales = portalesData.portales || {};
  const claves = Object.keys(portales);
  const opcionesPortal = [...claves, "desconocido"].join('" | "');

  const lineasDeteccion = claves.map(clave => {
    const p = portales[clave];
    const det = p.deteccion || {};
    const pistas = [
      ...(det.por_texto_ocr || []),
      ...(det.por_comercio || []),
      ...(det.por_url_qr || []),
    ].filter((v, i, a) => a.indexOf(v) === i); // deduplicar
    return `- "${clave}": si ves ${pistas.map(s => `"${s}"`).join(", ")} o el nombre "${p.nombre}"`;
  });

  return `Identifica el tipo de ticket de compra. Responde SOLO este JSON:
{
  "portal": "${opcionesPortal}",
  "confianza": número del 0 al 100,
  "urlQR": "URL completa si hay un QR de facturación, o null",
  "comercio": "nombre del comercio"
}
${lineasDeteccion.join("\n")}
- "desconocido": cualquier otro caso`;
}

const app = express();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SMTP_PORT = parseInt(process.env.SMTP_PORT) || 465;
// `secure` DEBE coincidir con el puerto: 465 = SSL implícito (true); 587/25/2525 = STARTTLS (false).
// Lo derivamos del puerto en vez de confiar en SMTP_SECURE, porque si esa variable
// quedó mal puesta en Railway (p.ej. ausente) el socket a 465 se cuelga → "Connection timeout".
const SMTP_SECURE = SMTP_PORT === 465 ? true : (process.env.SMTP_SECURE === 'true');
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_SECURE,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  connectionTimeout: 10000,
  greetingTimeout: 10000,
  socketTimeout: 15000,
});

transporter.verify((error) => {
  if (error) console.log(`⚠️ SMTP no disponible (${SMTP_PORT}/secure=${SMTP_SECURE}):`, error.message);
  else console.log(`✅ SMTP conectado correctamente (${SMTP_PORT}/secure=${SMTP_SECURE})`);
});

// ── Envío de correo: API HTTP de Brevo (funciona en Railway, puerto 443) con
// fallback a SMTP para entorno local. Railway BLOQUEA el SMTP saliente (probado:
// 465/587/2525 dan ETIMEDOUT), por eso en producción se usa la API HTTP.
// Acepta el mismo shape que nodemailer.sendMail(): { from, to, replyTo, subject, html, attachments }.
function _parseFrom(from) {
  const m = String(from || '').match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: (m[1] || '').trim() || undefined, email: m[2].trim() };
  return { email: String(from || process.env.SMTP_USER || 'buzonfacturas@serviciosga.site').trim() };
}

async function enviarCorreo(opts) {
  if (process.env.BREVO_API_KEY) {
    const sender = _parseFrom(opts.from);
    const destinatarios = (Array.isArray(opts.to) ? opts.to : String(opts.to || '').split(','))
      .map(e => String(e).trim()).filter(Boolean).map(email => ({ email }));
    const body = { sender, to: destinatarios, subject: opts.subject || '', htmlContent: opts.html || opts.text || ' ' };
    if (opts.replyTo) body.replyTo = { email: String(opts.replyTo).trim() };
    if (opts.attachments && opts.attachments.length) {
      body.attachment = opts.attachments.map(a => ({
        name: a.filename || 'adjunto',
        content: Buffer.isBuffer(a.content) ? a.content.toString('base64') : Buffer.from(a.content || '').toString('base64'),
      }));
    }
    const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      throw new Error(`Brevo ${resp.status}: ${txt.slice(0, 300)}`);
    }
    return { via: 'brevo' };
  }
  // Fallback SMTP (entorno local / dev donde el puerto no está bloqueado)
  return transporter.sendMail(opts).then(() => ({ via: 'smtp' }));
}

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
  res.json(out);
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

async function registrarIntento(ticketId, bot, resultado, mensaje, duracionMs, screenshotUrls = []) {
  try {
    await db.query(
      "INSERT INTO ticket_intentos (ticket_id, bot, resultado, mensaje, screenshot_urls, duracion_ms) VALUES (?, ?, ?, ?, ?, ?)",
      [ticketId, bot || null, resultado, mensaje || null,
       screenshotUrls.length ? JSON.stringify(screenshotUrls) : null, duracionMs || null]
    );
  } catch (e) {
    console.error("⚠️ registrarIntento:", e.message);
  }
}

// Calcula la próxima medianoche (hora local del servidor)
function proximaMedianoche() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  return d;
}

const PORTALES_CONOCIDOS = ['oxxo', 'arco', 'gasmaz', 'homedepot', 'buzonfacturas', 'farmaciaguadalajara', 'rendichicas', 'benavides', 'panama'];

// Cola por portal: garantiza que solo un bot del mismo portal corre a la vez.
// Portales distintos siguen corriendo en paralelo entre sí.
const _portalColas = new Map();
function conColaPortal(portalKey, fn) {
  const key = portalKey || 'desconocido';
  const anterior = _portalColas.get(key) || Promise.resolve();
  const siguiente = anterior.then(fn, fn); // corre aunque el anterior haya fallado
  _portalColas.set(key, siguiente.catch(() => {}));
  return siguiente;
}

// Envuelve un job de setInterval para que NUNCA se solape consigo mismo: si la
// corrida anterior aún no termina (p.ej. el job IMAP espera hasta 10 min/ticket),
// el siguiente tick se omite. Sin esto se acumulaban corridas concurrentes que
// abrían múltiples conexiones IMAP/sesiones Browserless y competían por los mismos
// correos — causa raíz de "se bugea con 2-3 tickets" y "no descarga XML/PDF".
function sinSolape(fn, nombre) {
  let corriendo = false;
  return async function () {
    if (corriendo) {
      console.log(`⏭️ [job:${nombre}] ciclo anterior aún en ejecución — se omite este tick`);
      return;
    }
    corriendo = true;
    try { await fn(); }
    catch (e) { console.error(`❌ [job:${nombre}]`, e?.message || e); }
    finally { corriendo = false; }
  };
}

// ── LÓGICA COMPARTIDA DE FACTURACIÓN (usada por auto-facturar y endpoint manual) ──
async function ejecutarFacturacion(ticketId, userId) {
  try {
    const [[ticket]] = await db.query(
      `SELECT t.*, u.rfc, u.razon_social, u.calle, u.num_ext, u.num_int, u.colonia,
              u.municipio, u.estado, u.codigo_postal, u.regimen_fiscal, u.uso_cfdi, u.email,
              u.nombre AS user_nombre
       FROM tickets t JOIN users u ON t.user_id = u.id WHERE t.id = ?`,
      [ticketId]
    );
    if (!ticket) return;
    if (!ticket.rfc) {
      await crearNotificacion(userId, 'factura_error', 'Completa tu perfil fiscal para facturar automáticamente.');
      return;
    }

    const datos = JSON.parse(ticket.ocr_json || '{}');
    if (datos.portal === 'oxxo' || (ticket.comercio || '').toLowerCase().includes('oxxo')) {
      datos.folio = corregirFolioOxxo(datos.folio);
      datos.idVenta = corregirIdVentaOxxo(datos.idVenta);

      // Validar datos ANTES de invocar el engine/bot (catch temprano → mejor UX)
      const erroresOxxo = validarDatosOxxo(datos);
      if (erroresOxxo.length > 0) {
        const msg = 'Datos OXXO inválidos: ' + erroresOxxo.join('; ');
        console.log(`⚠️ [OXXO] Validación fallida ticket #${ticketId}: ${msg}`);
        await db.query("UPDATE tickets SET status = 'error', error_msg = ? WHERE id = ?", [msg, ticketId]);
        await registrarIntento(ticketId, 'oxxo', 'error', msg, 0);
        await crearNotificacion(userId, 'factura_error',
          `Tu ticket OXXO tiene datos que no pudimos leer correctamente (${erroresOxxo.join(', ')}). Por favor edita los datos y vuelve a intentarlo.`
        );
        return { ok: false, msg };
      }
    }

    const inicioMs = Date.now();
    await db.query("UPDATE tickets SET status = 'procesando', reintento_programado = NULL WHERE id = ?", [ticketId]);

    const portalKey = datos.portal || (ticket.comercio || '').toLowerCase().replace(/\s+/g, '') || 'desconocido';
    console.log(`🔒 Cola portal [${portalKey}] — ticket #${ticketId} en espera si hay otro corriendo`);

    const resultado = await conColaPortal(portalKey, () => detectarYFacturar({
      ...datos,
      rfc: ticket.rfc,
      razonSocial: ticket.razon_social,
      calle: ticket.calle,
      ext: ticket.num_ext,
      int: ticket.num_int,
      colonia: ticket.colonia,
      municipio: ticket.municipio,
      estado: ticket.estado,
      codigoPostal: ticket.codigo_postal,
      regimenFiscal: ticket.regimen_fiscal,
      usoCfdi: ticket.uso_cfdi || 'G03',
      email: ticket.email,
      ticketId,
      ocr_text: ticket.ocr_text,
      portalUrl: datos.portalUrl || ticket.portal_url || null,
      comercio: ticket.comercio,
    }, db));

    const duracionMs = Date.now() - inicioMs;
    const botNombre = datos.portal || ticket.comercio || 'desconocido';

    if (resultado.sinPortal) {
      const comercioNombre = ticket.comercio || datos.comercio || 'desconocido';
      const portalUrl = datos.portalUrl || ticket.portal_url || '';
      await registrarIntento(ticketId, botNombre, 'agente', 'Portal nuevo — iniciando agente', duracionMs);
      await db.query(
        "UPDATE tickets SET status = 'procesando', error_msg = 'Agente analizando portal nuevo...' WHERE id = ?",
        [ticketId]
      );
      await crearNotificacion(userId, 'portal_desconocido',
        `Recibimos tu ticket de ${comercioNombre}. Te avisaremos cuando tu factura esté lista.`);
      setImmediate(() => manejarNuevoPortal(ticketId, userId, comercioNombre, portalUrl).catch(console.error));
      return { ok: true, agente: true };
    }

    if (resultado.ok && resultado.procesandoCorreo) {
      await db.query("UPDATE tickets SET status = 'procesando_correo', procesando_correo_desde = NOW() WHERE id = ?", [ticketId]);
await registrarIntento(ticketId, botNombre, 'procesando_correo', 'Factura generada — esperando correo', duracionMs);
      return { ok: true, procesandoCorreo: true };
    }

    if (resultado.ok) {
      let pdfUrl = resultado.pdfUrl || resultado.pdf || null;
      let xmlUrl = resultado.xmlUrl || resultado.xml || null;
      if (xmlUrl) {
        const renombrado = await renombrarConUUID(xmlUrl, pdfUrl, ticket.comercio);
        xmlUrl = renombrado.xmlUrl;
        pdfUrl = renombrado.pdfUrl;
      }
      await registrarIntento(ticketId, botNombre, 'ok', `XML: ${xmlUrl || 'n/a'} | PDF: ${pdfUrl || 'n/a'}`, duracionMs);
      await db.query("INSERT INTO facturas (user_id, ticket_id, comercio, pdf_url, xml_url, status) VALUES (?, ?, ?, ?, ?, ?)",
        [userId, ticketId, ticket.comercio, pdfUrl, xmlUrl, 'completado']);
      await db.query("UPDATE tickets SET status = 'procesado' WHERE id = ?", [ticketId]);
      try {
        if (ticket.email) {
          await enviarCorreo({
            from: '"GPN Facturas" <buzonfacturas@serviciosga.site>',
            to: ticket.email,
            subject: '✅ Tu factura está lista — GPN Pinturas y Recubrimientos',
            html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
              <div style="background:#3B6D11;padding:20px;border-radius:12px 12px 0 0;">
                <h2 style="color:#fff;margin:0;">GPN Pinturas y Recubrimientos</h2>
                <p style="color:#C0DD97;margin:4px 0 0;">Portal de Facturación Automática</p>
              </div>
              <div style="background:#f8faf6;padding:24px;border-radius:0 0 12px 12px;border:1px solid #e0edd5;">
                <p>Hola <strong>${ticket.user_nombre || ''}</strong>,</p>
                <p>Tu factura fue generada exitosamente.</p>
                <div style="margin:20px 0;">
                  ${xmlUrl ? `<a href="${xmlUrl}" style="display:inline-block;margin-right:10px;background:#EAF3DE;color:#27500A;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:500;">⬇ Descargar XML</a>` : ''}
                  ${pdfUrl ? `<a href="${pdfUrl}" style="display:inline-block;background:#3B6D11;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:500;">⬇ Descargar PDF</a>` : ''}
                </div>
                <a href="https://portal-facturas-production.up.railway.app/mis-facturas" style="display:inline-block;background:#3B6D11;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:500;">Ver mis facturas →</a>
              </div>
            </div>`,
          });
        }
      } catch {}
      await crearNotificacion(userId, 'factura_lista', `✅ Tu factura de ${ticket.comercio || 'este comercio'} está lista para descargar.`);
      return { ok: true, pdfUrl, xmlUrl };
    }

    // ── Ticket vencido — portal no acepta facturación en plazo ──
    if (resultado.error_code === 'ticket_vencido') {
      const emailContacto = resultado.email_contacto || null;
      // Separar en dos queries: error_msg siempre se guarda aunque email_contacto falle
      await db.query(
        "UPDATE tickets SET status = 'error', error_msg = 'ticket_vencido', reintento_programado = NULL WHERE id = ?",
        [ticketId]
      );
      await db.query("UPDATE tickets SET email_contacto = ? WHERE id = ?", [emailContacto, ticketId])
        .catch(e => console.log(`⚠️ email_contacto no guardado (${e.message})`));
      await registrarIntento(ticketId, botNombre, 'error', `ticket_vencido|email_contacto:${emailContacto}`, duracionMs);
      await crearNotificacion(userId, 'factura_error',
        `El plazo para facturar tu ticket de ${ticket.comercio || 'este comercio'} ha vencido. Puedes solicitar la factura por correo desde "Mis Tickets".`
      ).catch(() => {});
      return { ok: false, error_code: 'ticket_vencido', email_contacto: emailContacto };
    }

    // ── Error del bot ──
    // Detectar folio no disponible en OXXO (escalación)
    if (resultado.tipo === 'folio_no_disponible') {
      const [[{ nIntentos }]] = await db.query(
        "SELECT COUNT(*) as nIntentos FROM ticket_intentos WHERE ticket_id = ? AND mensaje LIKE '%folio_no_disponible%'",
        [ticketId]
      );
      await registrarIntento(ticketId, botNombre, 'error', `folio_no_disponible|${resultado.msg}`, duracionMs);

      if (nIntentos >= 1) {
        // 2do+ intento: escalar a aclaración directa en tienda
        await db.query("UPDATE tickets SET status = 'error', reintento_programado = NULL WHERE id = ?", [ticketId]);
        await crearNotificacion(userId, 'factura_error',
          `❌ Tu ticket de ${ticket.comercio} no puede facturarse. El folio no existe en el sistema después de 2 intentos. Te recomendamos levantar una aclaración directamente en tienda OXXO.`);
      } else {
        // 1er intento: reintento a medianoche
        const medianoche = proximaMedianoche();
        await db.query("UPDATE tickets SET status = 'error', reintento_programado = ? WHERE id = ?", [medianoche, ticketId]);
        await crearNotificacion(userId, 'factura_error',
          `⚠️ Tu ticket de ${ticket.comercio} no está disponible aún — los tickets OXXO tardan hasta 24h en activarse. Lo reintentaremos esta noche a las 12:00 am. Si los datos son incorrectos, usa "Editar datos" para corregirlos.`);
      }
      return { ok: false, tipo: 'folio_no_disponible', msg: resultado.msg };
    }

    // Error genérico
    const medianoche = proximaMedianoche();
    await db.query("UPDATE tickets SET status = 'error', reintento_programado = ? WHERE id = ?", [medianoche, ticketId]);
    await registrarIntento(ticketId, botNombre, 'error', resultado.msg || 'Error desconocido', duracionMs);
    const esPortalConocido = PORTALES_CONOCIDOS.includes((datos.portal || '').toLowerCase());
    await crearNotificacion(userId, 'factura_error', esPortalConocido
      ? `Tu factura de ${ticket.comercio || 'este comercio'} no pudo generarse. Reintentaremos esta noche a las 12:00 am. Si los datos son incorrectos, usa "Editar datos".`
      : `Tu ticket de ${ticket.comercio || 'este comercio'} está en revisión. Te avisaremos en 24-48 horas.`);
    return { ok: false, msg: resultado.msg };

  } catch (err) {
    console.error(`❌ ejecutarFacturacion #${ticketId}:`, err.message);
    await db.query("UPDATE tickets SET status = 'error' WHERE id = ?", [ticketId]).catch(() => {});
    return { ok: false, msg: err.message };
  }
}

// ── AGENTE: analizar portal nuevo y notificar resultado ──────────────────────
function resumenAgente(resultado, comercioNombre) {
  if (!resultado.ok) {
    const etapa = resultado.etapa || 'desconocida';
    return {
      corto: `Agente falló en "${etapa}": ${resultado.msg || 'error desconocido'}`,
      usuario: `Tu ticket de ${comercioNombre} está en revisión. Te avisaremos cuando tu factura esté lista.`,
      admin: `❌ Agente falló en etapa "${etapa}" para ${comercioNombre}. Error: ${resultado.msg}. Requiere configuración manual.`,
    };
  }
  const val = resultado.validacion || {};
  const errores = val.errores || [];
  const advertencias = val.advertencias || [];
  const archivo = resultado.nombreArchivo || 'bot.js';

  if (errores.length === 0) {
    return {
      corto: `Bot generado (${archivo}) — pendiente aprobación.`,
      usuario: `Tu ticket de ${comercioNombre} está en proceso. Te avisaremos cuando tu factura esté lista.`,
      admin: `✅ Bot listo sin errores: ${archivo}. ${advertencias.length} advertencia(s). Aprueba en Portales Pendientes.`,
    };
  }
  const listaErrores = errores.slice(0, 3).join(' | ');
  return {
    corto: `Bot con ${errores.length} error(es): ${listaErrores}`,
    usuario: `Tu ticket de ${comercioNombre} está en revisión. Te avisaremos cuando tu factura esté lista.`,
    admin: `⚠️ Bot generado con ${errores.length} error(es): ${listaErrores}. ${advertencias.length} advertencia(s). Revisa en Portales Pendientes.`,
  };
}

async function manejarNuevoPortal(ticketId, userId, comercioNombre, portalUrl) {
  console.log(`🤖 [Agente] Iniciando para "${comercioNombre}" — ticket #${ticketId}`);
  try {
    // Releer el ticket por si el cuestionario actualizó el portalUrl o agregó instrucciones
    const [[t]] = await db.query("SELECT portal_url, ocr_json FROM tickets WHERE id = ?", [ticketId]);
    const ocr = JSON.parse(t?.ocr_json || '{}');
    const urlFinal = ocr.portalUrl || t?.portal_url || portalUrl || '';

    // Leer instrucciones del residente desde portales_pendientes
    const [[pendiente]] = await db.query(
      "SELECT notas FROM portales_pendientes WHERE nombre = ? ORDER BY id DESC LIMIT 1",
      [comercioNombre]
    ).catch(() => [[null]]);
    let instrucciones = '';
    if (pendiente?.notas) {
      try {
        const n = JSON.parse(pendiente.notas);
        instrucciones = [
          n.acceso ? `Acceso: ${n.acceso}` : '',
          n.descripcion ? `Proceso según residente: ${n.descripcion}` : '',
          n.campos?.length ? `Campos del portal: ${n.campos.join(', ')}` : '',
        ].filter(Boolean).join('\n');
      } catch {}
    }

    const resultado = await orquestar({ db, ticketId, portalUrl: urlFinal, comercioNombre, instrucciones });
    const resumen = resumenAgente(resultado, comercioNombre);
    console.log(`🤖 [Agente] Terminó — ticket #${ticketId}: ${resumen.corto}`);

    await db.query(
      "UPDATE tickets SET status = 'error', error_msg = ? WHERE id = ?",
      [resumen.corto, ticketId]
    );
    await crearNotificacion(userId, 'factura_error', resumen.usuario);

    const [adminRows] = await db.query('SELECT id FROM users WHERE email = ?', [ADMIN_EMAIL]);
    if (adminRows.length) await crearNotificacion(adminRows[0].id, 'portal_pendiente', resumen.admin);
  } catch (err) {
    console.error(`❌ [Agente] manejarNuevoPortal #${ticketId}:`, err.message);
    await db.query(
      "UPDATE tickets SET status = 'error', error_msg = ? WHERE id = ?",
      [`Error del agente: ${err.message}`, ticketId]
    );
  }
}

// Verifica concurrencia y ejecuta (o encola si ya hay 2 procesando)
async function autoFacturar(ticketId, userId) {
  const [[{ procesando }]] = await db.query(
    "SELECT COUNT(*) as procesando FROM tickets WHERE status = 'procesando'"
  );
  if (procesando >= 2) {
    console.log(`⏳ Cola llena (${procesando} procesando) — ticket #${ticketId} en espera`);
    return; // queda en pendiente_confirmacion, procesarCola lo tomará
  }
  await ejecutarFacturacion(ticketId, userId);
}

// Job cada 30s: procesa tickets en cola cuando hay slots disponibles
async function procesarCola() {
  try {
    const [[{ procesando }]] = await db.query(
      "SELECT COUNT(*) as procesando FROM tickets WHERE status = 'procesando'"
    );
    if (procesando >= 2) return;
    const slots = 2 - procesando;
    const [enCola] = await db.query(
      `SELECT t.id, t.user_id FROM tickets t
       JOIN users u ON t.user_id = u.id
       WHERE t.status = 'pendiente_confirmacion' AND t.requiere_confirmacion = 0
       AND u.rfc IS NOT NULL AND u.rfc != ''
       AND (
         JSON_UNQUOTE(JSON_EXTRACT(t.ocr_json, '$.portal')) IN ('oxxo','arco','gasmaz','farmaciaguadalajara','homedepot','buzonfacturas','rendichicas','benavides','panama','sushito','sushio','carljr','elcaporal','elcaporalrestaurante','allegro','allegrecaffe','allegrezonadorada','autozone')
         OR (
           -- Portales con portal=desconocido pero portalUrl conocida
           JSON_UNQUOTE(JSON_EXTRACT(t.ocr_json, '$.portal')) = 'desconocido'
           AND t.portal_url IS NOT NULL
           AND (
             t.portal_url LIKE '%autozone%'         OR
             t.portal_url LIKE '%origon.cloud%'     OR
             t.portal_url LIKE '%mefacturo.mx%'     OR
             t.portal_url LIKE '%elcaporal%'        OR
             t.portal_url LIKE '%allegre%'          OR
             t.portal_url LIKE '%sushio%'           OR
             t.portal_url LIKE '%analytix360%'      OR
             t.portal_url LIKE '%tufesa%'
           )
         )
         OR (
           -- Fallback por comercio cuando portal=desconocido
           JSON_UNQUOTE(JSON_EXTRACT(t.ocr_json, '$.portal')) = 'desconocido'
           AND LOWER(JSON_UNQUOTE(JSON_EXTRACT(t.ocr_json, '$.comercio'))) LIKE '%autozone%'
         )
       )
       ORDER BY t.creado ASC LIMIT ?`,
      [slots]
    );
    for (const t of enCola) {
      ejecutarFacturacion(t.id, t.user_id).catch(console.error);
    }
  } catch {}
}
setInterval(sinSolape(procesarCola, 'procesarCola'), 30 * 1000);

function corregirIdVentaOxxo(id) {
  if (!id) return id;
  const s = String(id).toUpperCase().replace(/\s/g, '');
  if (s.length !== 11) return s;
  const c = s.split('');
  // Posiciones de DÍGITO (0,1,5,6,10): letra confundible → dígito
  const L2D = { O:'0', I:'1', L:'1', T:'1', S:'5', B:'8', G:'6', Z:'2' };
  // Posiciones de LETRA (2,3,4): dígito confundible → letra
  const D2L = { '0':'O', '1':'I', '5':'S', '8':'B', '6':'G', '2':'Z' };
  for (const i of [0, 1, 5, 6, 10]) c[i] = L2D[c[i]] ?? c[i];
  for (const i of [2, 3, 4])        c[i] = D2L[c[i]] ?? c[i];
  return c.join('');
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
  const idVentaNorm = corregirIdVentaOxxo(String(datos.idVenta || '').toUpperCase().replace(/\s/g, ''));
  if (!idVentaNorm || idVentaNorm.length !== 11 || !/^\d{2}[A-Z]{3}\d{2}[A-Z0-9]+\d{1,2}$/.test(idVentaNorm))
    errores.push(`idVenta inválido (${idVentaNorm.length} chars, esperado 11): ${datos.idVenta}`);
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
  restaurarBotsDinamicos(db).catch(e => console.log("⚠️ restaurarBots:", e.message));
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

// Corrige el AÑO mal leído por el OCR. Los tickets siempre son recientes (días),
// así que si el OCR leyó un año implausible (ej. 2026→2025, o 2020), reasignamos
// el año más reciente —entre el actual y el anterior— que NO caiga en el futuro,
// conservando día y mes. Soporta "DD/MM/YYYY" y "YYYY-MM-DD". Si no puede parsear,
// devuelve el string original sin tocarlo. Es no-op cuando el año ya es correcto.
function corregirAnioReciente(fechaStr) {
  if (!fechaStr || typeof fechaStr !== 'string') return fechaStr;
  const s = fechaStr.trim();
  let dd, mm, yyyy, formato, m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)))      { yyyy = +m[1]; mm = +m[2]; dd = +m[3]; formato = 'YMD'; }
  else if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) { dd = +m[1]; mm = +m[2]; yyyy = +m[3]; formato = 'DMY'; }
  else return fechaStr;
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return fechaStr;

  const hoy = new Date();
  const cap = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() + 2); // tolera 2 días (desfase/dígito mal leído)
  let mejor = null;
  for (const a of [hoy.getFullYear(), hoy.getFullYear() - 1]) {
    const d = new Date(a, mm - 1, dd);
    if (d <= cap && (!mejor || d > mejor.d)) mejor = { a, d };
  }
  if (!mejor || mejor.a === yyyy) return fechaStr;
  const p2 = (n) => String(n).padStart(2, '0');
  return formato === 'YMD' ? `${mejor.a}-${p2(mm)}-${p2(dd)}` : `${p2(dd)}/${p2(mm)}/${mejor.a}`;
}

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

    // ── PASADA 1: Detección de portal (Sonnet) ──
    console.log("🔍 Pasada 1: detección con Sonnet...");
    const t1start = Date.now();
    try {
      const resp1 = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 200,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mimeType, data: base64Image } },
            { type: "text", text: buildPromptDeteccion() }
          ],
        }],
      });
      const t1ms = Date.now() - t1start;
      const det = JSON.parse(resp1.content[0].text.replace(/```json|```/g, "").trim());
      portalDetectado = det.portal || "desconocido";
      const urlQR = det.urlQR || null;
      if (det.comercio) datosOCR.comercio = det.comercio;
      console.log(`⏱️ Sonnet detección: ${t1ms}ms | Portal: ${portalDetectado} (${det.confianza || 0}pts)`);

      // Si desconocido pero hay URL en QR, intentar resolver por URL
      if (portalDetectado === "desconocido" && urlQR) {
        const urlLow = urlQR.toLowerCase();
        if (urlLow.includes("nexusfuel") || urlLow.includes("gasmaz")) portalDetectado = "gasmaz";
        else if (urlLow.includes("buzonfacturas") || urlLow.includes("arco")) portalDetectado = "arco";
        else if (urlLow.includes("oxxo")) portalDetectado = "oxxo";
        else if (urlLow.includes("farmaciasguadalajara")) portalDetectado = "farmaciaguadalajara";
        else if (urlLow.includes("rendilitros") || urlLow.includes("rendichicas")) portalDetectado = "rendichicas";
        else if (urlLow.includes("homedepot.com.mx")) portalDetectado = "homedepot";
        else if (urlLow.includes("e-facturate.com/benavides")) portalDetectado = "benavides";
        else if (urlLow.includes("facturacion4.icr.mx") || urlLow.includes("icr.mx")) portalDetectado = "carljr";
        else if (urlLow.includes("grupopanama.mx")) portalDetectado = "panama";
        if (portalDetectado !== "desconocido")
          console.log(`🔗 Portal resuelto por URL del QR: ${portalDetectado}`);
        datosOCR.portalUrl = urlQR;
      }

      // Si sigue desconocido pero el comercio contiene "oxxo", enrutar a oxxo.js
      if (portalDetectado === "desconocido" && det.comercio && det.comercio.toLowerCase().includes("oxxo")) {
        portalDetectado = "oxxo";
        console.log(`🏪 Portal resuelto por nombre OXXO: ${det.comercio}`);
      }
    } catch (e) {
      console.log("⚠️ Sonnet detección falló:", e.message);
    }

    // ── PASADA 2: Extracción dirigida (Sonnet) ──
    // Instrucción de confianza que se agrega al final de cada prompt
    const INSTRUCCION_CONFIANZA = `
"confianza": "alta|media|baja",
"campos_dudosos": [],
"ok": true
}
Reglas de confianza:
- alta: todos los campos requeridos están claros y legibles sin ambigüedad.
- media: corregiste caracteres ambiguos (O/0, I/1, S/5) pero estás bastante seguro del resultado.
- baja: algún campo requerido es ilegible, parcialmente visible o muy incierto.
campos_dudosos: lista los nombres exactos de los campos con incertidumbre (array vacío si confianza=alta).`;

    const promptsPorPortal = {
      oxxo: `Extrae estos datos del ticket OXXO. Responde SOLO JSON sin texto adicional:
{
  "comercio": "OXXO",
  "fecha": "DD/MM/YYYY",
  "folio": "SOLO dígitos después de Fol_Vta: — corrige O→0 S→5 I→1 T→1",
  "idVenta": "código después de ID= — formato exacto: 2dígitos + 3LETRAS + 2dígitos + 3alfanum + 1dígito (11 chars). En posiciones 1-2 y 6-7 y 11 (dígito): O→0 I→1 S→5. En posiciones 3-5 (SOLO LETRAS): 0→O 1→I 5→S. Ejemplo: '100BR50UZD1' → '10OBR50UZD1' porque pos 3 debe ser letra",
  "total": número sin signos,
  "portal": "oxxo",
${INSTRUCCION_CONFIANZA}`,
      arco: `Extrae estos datos del ticket ARCO/BuzonFacturas. Responde SOLO JSON sin texto adicional:
{
  "comercio": "nombre exacto de la gasolinera ARCO",
  "fecha": "DD/MM/YYYY",
  "codigoTicket": "número de barcode o código grande impreso para facturación (bajo el código de barras o etiquetado como Código/Folio)",
  "total": número sin signos,
  "portal": "arco",
${INSTRUCCION_CONFIANZA}`,
      gasmaz: `Extrae estos datos del ticket GASMAZ/NexusFuel. Responde SOLO JSON sin texto adicional:
{
  "comercio": "nombre de la gasolinera",
  "fecha": "DD/MM/YYYY",
  "referencia": "número de referencia grande (primer número prominente del ticket)",
  "folio": "número de ticket o folio",
  "total": número sin signos,
  "portalUrl": "URL COMPLETA del QR de facturación (debe incluir nexusfuel.mx), o null",
  "portal": "gasmaz",
${INSTRUCCION_CONFIANZA}`,
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
${INSTRUCCION_CONFIANZA}`,
      homedepot: `Extrae estos datos del ticket de The Home Depot México. Responde SOLO JSON sin texto adicional:
{
  "comercio": "Home Depot Mexico",
  "fecha": "DD/MM/YYYY",
  "folio": "EL NÚMERO BAJO EL CÓDIGO DE BARRAS — es el código numérico más largo del ticket, entre 18 y 23 dígitos. Lee cada dígito con cuidado: NO omitas ni agregues dígitos. Si hay ambigüedad entre 0 y O, usa 0. Si no puedes leerlo con certeza, devuelve null.",
  "total": número sin signos,
  "portal": "homedepot",
${INSTRUCCION_CONFIANZA}`,
      rendichicas: `Extrae estos datos del ticket de gasolinera con portal Rendichicas/rendilitros. Responde SOLO JSON sin texto adicional:
{
  "comercio": "nombre de la estación (ej. ESTACION PIRU SA DE CV)",
  "fecha": "DD/MM/YYYY",
  "folio": "número de folio o ticket (el número largo impreso)",
  "total": número sin signos,
  "portalUrl": "URL completa del QR de facturación si aparece (debe incluir rendilitros o rendichicas), o null",
  "portal": "rendichicas",
${INSTRUCCION_CONFIANZA}`,
      benavides: `Extrae estos datos del ticket de Farmacias Benavides. Responde SOLO JSON sin texto adicional:
{
  "comercio": "Farmacias Benavides",
  "fecha": "DD/MM/YYYY",
  "folio": "número entre asteriscos *XXXXXXXXXXXXXX* o el número de ticket largo impreso",
  "total": número sin signos,
  "portal": "benavides",
${INSTRUCCION_CONFIANZA}`,
      panama: `Extrae estos datos del ticket de Panamá Restaurante y Pastelería. Responde SOLO JSON sin texto adicional:
{
  "comercio": "nombre exacto del establecimiento (ej. PASTELERIAS PANAMA DE MAZATLAN SA DE CV)",
  "fecha": "DD/MM/YYYY",
  "idFacturacion": "número que aparece después de la leyenda SU ID DE FACTURACION ES (solo dígitos)",
  "total": número sin signos,
  "portal": "panama",
${INSTRUCCION_CONFIANZA}`,
      carljr: `Extrae estos datos del ticket de Carl's Jr (ICR S.A. de C.V.). Responde SOLO JSON sin texto adicional:
{
  "comercio": "ICR S.A. DE C.V.",
  "fecha": "DD/MM/YYYY",
  "referencia": "número que aparece junto a la leyenda REFERENCIA: (es un número largo ~14 dígitos, también puede aparecer como código de comedor al inicio del ticket)",
  "total": número sin signos (campo Total o Totall del ticket),
  "portalUrl": "URL del portal de facturación si aparece (facturacion4.icr.mx o carlsjrclub.com.mx), o null",
  "portal": "carljr",
${INSTRUCCION_CONFIANZA}`,
      desconocido: `Extrae los datos que puedas de este ticket. Si reconoces el portal, identifícalo.
Portales conocidos: oxxo (tiendas OXXO), arco (gasolineras ARCO, portal buzonfacturas.com), gasmaz (gasolineras Gasmaz/RedMax/NexusFuel), farmaciaguadalajara (Farmacias Guadalajara), benavides (Farmacias Benavides), homedepot (Home Depot México), rendichicas (gasolineras con QR a rendilitros.com o rendichicas.com), panama (Panamá Restaurante y Pastelería, portal grupopanama.mx), carljr (Carl's Jr / ICR S.A. de C.V., portal facturacion4.icr.mx).
Responde SOLO JSON sin texto adicional:
{
  "comercio": "nombre del comercio",
  "fecha": "DD/MM/YYYY",
  "folio": "número de folio o ticket, o null",
  "total": número sin signos,
  "portalUrl": "URL de QR de facturación si aparece, o null",
  "portal": "oxxo|arco|gasmaz|farmaciaguadalajara|benavides|homedepot|rendichicas|panama|carljr|desconocido",
${INSTRUCCION_CONFIANZA}`,
    };

    console.log(`🔍 Pasada 2: extracción Sonnet para portal '${portalDetectado}'...`);
    const t2start = Date.now();
    try {
      const resp2 = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 600,
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
      // Corrección de año mal leído por el OCR (2026→2025, 2020, etc.)
      for (const campo of ['fecha', 'fechaCompra']) {
        if (datosOCR[campo]) {
          const corr = corregirAnioReciente(datosOCR[campo]);
          if (corr !== datosOCR[campo]) {
            console.log(`📅 Año corregido en '${campo}': ${datosOCR[campo]} → ${corr}`);
            datosOCR[campo] = corr;
          }
        }
      }
      const nCampos = Object.values(datosOCR).filter(v => v !== null && v !== undefined).length;
      console.log(`⏱️ Sonnet extracción: ${t2ms}ms | Campos: ${nCampos}`);
      console.log("✅ Datos extraídos:", datosOCR);
    } catch (e) {
      console.log("⚠️ Sonnet extracción falló:", e.message);
      if (!datosOCR.comercio) {
        return res.json({ ok: false, error: "No se pudo identificar el portal" });
      }
    }

    // Si la detección no identificó el portal pero Sonnet extrajo "OXXO" en el comercio, reclasificar
    if (portalDetectado === "desconocido" && (datosOCR.comercio || "").toLowerCase().includes("oxxo")) {
      portalDetectado = "oxxo";
      datosOCR.portal = "oxxo";
      console.log(`🏪 Portal reclasificado como OXXO por comercio Sonnet: ${datosOCR.comercio}`);
    }

    // Si Pasada 2 extrajo un portal específico, tomarlo (cubre portales que Pasada 1 no reconoce visualmente)
    if (portalDetectado === "desconocido" && datosOCR.portal && datosOCR.portal !== "desconocido") {
      portalDetectado = datosOCR.portal;
      console.log(`🔄 Portal reclasificado por Pasada 2: ${portalDetectado}`);
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
      homedepot:           ['folio', 'fecha', 'total'],
      rendichicas:         ['folio', 'fecha', 'total'],
      benavides:           ['folio', 'fecha', 'total'],
      carljr:              ['referencia', 'total'],
      panama:              ['idFacturacion', 'total', 'comercio'],
      sushito:             ['referencia', 'folio', 'total'],
      sushio:              ['referencia', 'folio', 'total'],
      desconocido:         ['fecha', 'total'],
    };
    const campos = camposPorPortal[portalDetectado] || camposPorPortal.desconocido;

    const confianza = datosOCR.confianza || 'media';
    const camposDudosos = Array.isArray(datosOCR.campos_dudosos) ? datosOCR.campos_dudosos : [];
    const requiereConfirmacion = (portalDetectado !== 'desconocido') && (confianza !== 'alta' || camposDudosos.length > 0) ? 1 : 0;

    console.log(`💾 Insertando ticket — portal: ${portalDetectado}, confianza: ${confianza}, requiere_confirmacion: ${requiereConfirmacion}`);
    const [insertResult] = await db.query(
      "INSERT INTO tickets (user_id, nombre_archivo, ruta_archivo, ocr_text, ocr_json, comercio, status, residente_id, portal_url, requiere_confirmacion) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [req.session.userId, req.file.originalname, req.file.path, textoOCR, JSON.stringify(datosOCR), datosOCR.comercio || "desconocido", "pendiente_confirmacion", residente_id, datosOCR.portalUrl || portalUrl || null, requiereConfirmacion]
    );
    const ticketId = insertResult.insertId;
    console.log(`✅ Ticket #${ticketId} insertado — enviando respuesta al cliente`);

    if (portalDetectado === 'desconocido') {
      return res.json({ ok: true, agenteActivado: true, comercio: datosOCR.comercio || 'este comercio', urlQR: datosOCR.portalUrl || null, ticketId });
    }

    if (!requiereConfirmacion) {
      setImmediate(() => autoFacturar(ticketId, req.session.userId).catch(console.error));
      return res.json({ ok: true, autoFacturando: true, msg: "Ticket recibido — iniciando facturación automática", datos: datosOCR, ticketId, campos });
    }

    res.json({ ok: true, necesitaConfirmacion: true, confianza, campos_dudosos: camposDudosos, ticketId, datos: datosOCR, campos });
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

    setImmediate(() => autoFacturar(ticketId, req.session.userId).catch(console.error));
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

    if (!['error', 'pendiente', 'pendiente_confirmacion'].includes(ticket.status)) {
      return res.json({ ok: false, msg: "Solo puedes editar tickets en estado error o pendiente" });
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

    // Verificar concurrencia
    const [[{ procesando }]] = await db.query("SELECT COUNT(*) as procesando FROM tickets WHERE status = 'procesando'");
    if (procesando >= 2) return res.json({ ok: false, enCola: true, msg: "Ya hay 2 tickets procesándose. Este se iniciará automáticamente cuando terminen." });

    // Ejecutar en background y responder de inmediato
    ejecutarFacturacion(parseInt(ticketId), req.session.userId).catch(console.error);
    res.json({ ok: true, procesando: true, msg: "Facturación iniciada" });
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

    const [[ticket]] = await db.query(
      `SELECT t.id, t.comercio, t.email_contacto, t.solicitud_correo_enviada,
              t.ocr_json, t.nombre_archivo, t.user_id,
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
          rfc, razon_social, constancia_url, ocr_json } = ticket;

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
            <tr><td style="padding:8px 12px;font-weight:bold;">Correo de respuesta</td><td style="padding:8px 12px;">${user_email || 'Ver en adjunto'}</td></tr>
          </table>
          <p>Adjunto mi constancia de situación fiscal del SAT.</p>
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

    // Disparar agentes ahora que tenemos el contexto del residente
    setImmediate(() => autoFacturar(ticketId, ticket.user_id).catch(console.error));

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
    const { ticketId, portalUrl, url, comercioNombre, nombrePortal, instrucciones, notas } = req.body;
    const urlFinal = portalUrl || url;
    const nombreFinal = comercioNombre || nombrePortal;
    if (!urlFinal || !nombreFinal)
      return res.json({ ok: false, msg: "portalUrl y comercioNombre son requeridos" });

    console.log(`🎭 [Orquestador] Iniciando para: ${nombreFinal}`);
    const resultado = await orquestar({ db, ticketId: ticketId || null, portalUrl: urlFinal, comercioNombre: nombreFinal, instrucciones: instrucciones || notas || '' });
    res.json(resultado);
  } catch (err) {
    console.error("❌ Orquestador:", err.message);
    res.json({ ok: false, msg: err.message });
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

// ── JOB IMAP: procesar tickets en espera de correo ──
async function procesarTicketsPorCorreo() {
  let rows;
  try {
    // Hacer timeout de seguridad: tickets en procesando_correo por más de 60 min → error
    // Usa procesando_correo_desde (cuándo entró al estado) no creado (cuándo se creó el ticket)
    const [atascados] = await db.query(
      `SELECT t.id, t.user_id, t.comercio FROM tickets t
       WHERE t.status = 'procesando_correo'
         AND procesando_correo_desde < DATE_SUB(NOW(), INTERVAL 60 MINUTE)`
    );
    for (const t of atascados) {
      await db.query("UPDATE tickets SET status = 'error' WHERE id = ?", [t.id]);
      await crearNotificacion(
        t.user_id,
        "factura_error",
        `El correo con tu factura de ${t.comercio || "comercio"} no llegó en el tiempo esperado. Por favor intenta facturar de nuevo.`
      );
      console.log(`⏰ Job IMAP: ticket #${t.id} expirado (>60 min en procesando_correo) → error`);
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
    // Comercio usado para filtrar emails y no asignar facturas de otro portal
    const expectedComercio = ticket.comercio || datos.comercio || null;
    console.log(`📧 Procesando ticket #${ticket.id} (${ticket.comercio}) — buscando correo${expectedComercio ? ` [comercio: ${expectedComercio}]` : ''}...`);

    try {
      // Espera corta por ticket (3 min): si el correo no llegó, se deja en
      // procesando_correo y el siguiente ciclo (cada 2 min) reintenta. Evita que
      // un ticket sin correo bloquee a los demás del lote hasta 10 min cada uno.
      const { xmlBuffer, pdfBuffer } = await esperarFacturaPorCorreo(codigoTicket, 3 * 60 * 1000, expectedComercio);

      // UUID desde el contenido del XML (fuente canónica del CFDI)
      // Fallback: timestamp si el XML no está disponible
      const uuid = xmlBuffer ? extraerUUIDcfdi(xmlBuffer) : null;
      const prefijo = `facturas/${uuid || Date.now()}`;
      console.log(`📄 UUID CFDI: ${uuid || 'no encontrado'}`);

      let xmlUrl = null, pdfUrl = null;
      if (xmlBuffer) xmlUrl = await subirArchivoR2(xmlBuffer, `${prefijo}.xml`, "application/xml");
      if (pdfBuffer) pdfUrl = await subirArchivoR2(pdfBuffer, `${prefijo}.pdf`, "application/pdf");

      await db.query(
        "INSERT INTO facturas (user_id, ticket_id, comercio, pdf_url, xml_url, status) VALUES (?, ?, ?, ?, ?, ?)",
        [ticket.user_id, ticket.id, ticket.comercio, pdfUrl, xmlUrl, "completado"]
      );
      await db.query("UPDATE tickets SET status = 'procesado' WHERE id = ?", [ticket.id]);
      console.log(`✅ Job IMAP: ticket #${ticket.id} procesado`);

      try {
        if (ticket.email) {
          await enviarCorreo({
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

      // Estrategia B solo aplica para BuzonFacturas/ARCO
      const portalDelTicket = (datos.portal || ticket.comercio || "").toLowerCase();
      const esArco = portalDelTicket === "arco" || portalDelTicket === "buzonfacturas" ||
        (ticket.comercio || "").toLowerCase().includes("arco");

      if (!esArco) {
        // Dejar en procesando_correo para que el próximo ciclo (2 min) reintente.
        // El expirador de 30 min convertirá a error si el correo nunca llega.
        console.log(`⚠️ IMAP: correo no encontrado aún para ticket #${ticket.id} (${portalDelTicket}) — reintentará en siguiente ciclo`);
        continue;
      }

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
setInterval(sinSolape(procesarTicketsPorCorreo, 'IMAP-correo'), 2 * 60 * 1000);

// ── JOB REINTENTOS AUTOMÁTICOS: corre cada 5 min, procesa tickets con reintento_programado <= NOW() ──
async function procesarReintentos() {
  let tickets;
  try {
    const [rows] = await db.query(
      `SELECT t.*, u.email, u.nombre AS user_nombre,
              u.rfc, u.razon_social, u.codigo_postal, u.regimen_fiscal, u.uso_cfdi
       FROM tickets t
       JOIN users u ON t.user_id = u.id
       WHERE t.status = 'error'
         AND t.reintento_programado IS NOT NULL
         AND t.reintento_programado <= NOW()`
    );
    tickets = rows;
  } catch { return; }
  if (!tickets.length) return;

  console.log(`🔄 Reintentos automáticos: ${tickets.length} ticket(s)`);

  for (const t of tickets) {
    // Bloqueo: no reintentar si ya está siendo procesado
    const [[check]] = await db.query("SELECT status FROM tickets WHERE id = ?", [t.id]);
    if (check?.status === 'procesando') continue;

    await db.query("UPDATE tickets SET status = 'procesando', reintento_programado = NULL WHERE id = ?", [t.id]);
    console.log(`🔄 Reintentando ticket #${t.id} (${t.comercio})`);

    const inicioMs = Date.now();
    try {
      const datos = JSON.parse(t.ocr_json || "{}");
      const resultado = await detectarYFacturar({
        ...datos,
        rfc: t.rfc, razonSocial: t.razon_social,
        codigoPostal: t.codigo_postal, regimenFiscal: t.regimen_fiscal,
        usoCfdi: t.uso_cfdi || "G03", ticketId: t.id,
        comercio: t.comercio, ocr_text: t.ocr_text,
      }, db);
      const durMs = Date.now() - inicioMs;

      if (resultado.ok && resultado.procesandoCorreo) {
        await db.query("UPDATE tickets SET status = 'procesando_correo', procesando_correo_desde = NOW() WHERE id = ?", [t.id]);
        await registrarIntento(t.id, datos.portal || t.comercio, 'procesando_correo', 'Reintento automático — esperando correo', durMs);
      } else if (resultado.ok) {
        let xmlUrl = resultado.xmlUrl || resultado.xml || null;
        let pdfUrl = resultado.pdfUrl || resultado.pdf || null;
        if (xmlUrl) { const r = await renombrarConUUID(xmlUrl, pdfUrl, t.comercio); xmlUrl = r.xmlUrl; pdfUrl = r.pdfUrl; }
        await registrarIntento(t.id, datos.portal || t.comercio, 'ok', 'Reintento automático exitoso', durMs);
        await db.query("INSERT INTO facturas (user_id, ticket_id, comercio, pdf_url, xml_url, status) VALUES (?,?,?,?,?,?)",
          [t.user_id, t.id, t.comercio, pdfUrl, xmlUrl, 'completado']);
        await db.query("UPDATE tickets SET status = 'procesado' WHERE id = ?", [t.id]);
        await crearNotificacion(t.user_id, "factura_lista",
          `✅ Tu factura de ${t.comercio} fue generada en el reintento automático. Puedes descargarla en Mis Facturas.`);
        console.log(`✅ Reintento exitoso ticket #${t.id}`);
      } else {
        // Falló de nuevo — programar otro reintento para mañana a medianoche
        const sigMedianoche = proximaMedianoche();
        await db.query("UPDATE tickets SET status = 'error', reintento_programado = ? WHERE id = ?", [sigMedianoche, t.id]);
        await registrarIntento(t.id, datos.portal || t.comercio, 'error', `Reintento automático falló: ${resultado.msg}`, durMs);
        await crearNotificacion(t.user_id, "factura_error",
          `Tu factura de ${t.comercio} sigue en proceso — el sistema la reintentará mañana a las 12:00 am. Si es urgente, entra a Mis Tickets y da click en Reintentar.`);
        console.log(`⚠️ Reintento fallido ticket #${t.id}: ${resultado.msg}`);
      }
    } catch (e) {
      await db.query("UPDATE tickets SET status = 'error', reintento_programado = ? WHERE id = ?", [proximaMedianoche(), t.id]);
      await registrarIntento(t.id, t.comercio, 'error', `Excepción en reintento: ${e.message}`, Date.now() - inicioMs);
      console.log(`❌ Excepción reintentando ticket #${t.id}:`, e.message);
    }
  }
}
setInterval(sinSolape(procesarReintentos, 'reintentos'), 5 * 60 * 1000);

// ── AGENTES — Fase 5: CRUD portales gestionados ──────────────────────────────

// Listar todos los portales gestionados por agentes
app.get("/api/admin/agente/portales", requireAdmin, async (req, res) => {
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
app.get("/api/admin/agente/portales/:id", requireAdmin, async (req, res) => {
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
app.post("/api/admin/agente/portales/:id/rechazar", requireAdmin, async (req, res) => {
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
app.put("/api/admin/agente/portales/:id/codigo", requireAdmin, async (req, res) => {
  try {
    const { bot_code } = req.body;
    await db.query("UPDATE portales_agente SET bot_code = ? WHERE id = ?", [bot_code, req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

// Re-orquestar un portal existente (con notas corregidas)
app.post("/api/admin/agente/portales/:id/reorquestar", requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM portales_agente WHERE id = ? LIMIT 1", [req.params.id]);
    if (!rows.length) return res.json({ ok: false, msg: "No encontrado" });
    const portal = rows[0];
    const { instrucciones } = req.body;
    const resultado = await orquestar({
      db,
      portalUrl: portal.portal_url,
      comercioNombre: portal.nombre,
      instrucciones: instrucciones || portal.instrucciones || '',
    });
    res.json(resultado);
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

// Resetear ticket: borra factura mal guardada y regresa a pendiente_confirmacion
app.post("/api/admin/tickets/:id/resetear", auth, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await db.query("DELETE FROM facturas WHERE ticket_id = ?", [id]);
    await db.query(
      "UPDATE tickets SET status='pendiente_confirmacion', error_msg=NULL, procesando_correo_desde=NULL, reintento_programado=NULL WHERE id=?",
      [id]
    );
    res.json({ ok: true });
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
app.get('/api/version', (req, res) => {
  const { execSync } = require('child_process');
  let commit = 'desconocido';
  try { commit = execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim(); } catch {}
  res.json({ commit, ts: new Date().toISOString(), node: process.version });
});

// ─────────────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`🚀 Servidor corriendo en puerto ${PORT}`));
