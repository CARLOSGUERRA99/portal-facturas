// Jobs periódicos del worker — extraídos de server.js en FASE 1:
//   procesarTicketsPorCorreo — concilia tickets en 'procesando_correo' vía IMAP
//   procesarReintentos       — re-encola tickets con reintento_programado vencido
//   cleanupTickets           — borra tickets en error con +30 días
//   limpiarFacturasVencidas  — borra XML/PDF de R2 con +60 días
const db = require("./db");
const { esperarFacturaPorCorreo } = require("../mail/imap");
const { subirArchivoR2, borrarArchivoR2 } = require("../storage/r2");
const { enviarCorreo } = require("./correo");
const { crearNotificacion, extraerUUIDcfdi, ADMIN_EMAIL } = require("./util");
const { emailFacturaLista } = require("./facturacion");
const { encolarBot } = require("../queues");
const fs = require("fs");

async function procesarTicketsPorCorreo() {
  let rows;
  try {
    // Timeout de seguridad: tickets en procesando_correo por más de 60 min → error
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

  for (const ticket of rows) {
    const datos = JSON.parse(ticket.ocr_json || "{}");
    const codigoTicket = datos.codigoTicket || String(ticket.id);
    const expectedComercio = ticket.comercio || datos.comercio || null;
    console.log(`📧 Procesando ticket #${ticket.id} (${ticket.comercio}) — buscando correo...`);

    try {
      const { xmlBuffer, pdfBuffer } = await esperarFacturaPorCorreo(codigoTicket, 3 * 60 * 1000, expectedComercio, datos.total ?? null);

      const uuid = xmlBuffer ? extraerUUIDcfdi(xmlBuffer) : null;
      const prefijo = `facturas/${uuid || Date.now()}`;
      console.log(`📄 UUID CFDI: ${uuid || 'no encontrado'}`);

      let xmlUrl = null, pdfUrl = null;
      if (xmlBuffer) xmlUrl = await subirArchivoR2(xmlBuffer, `${prefijo}.xml`, "application/xml");
      if (pdfBuffer) pdfUrl = await subirArchivoR2(pdfBuffer, `${prefijo}.pdf`, "application/pdf");

      // facturas.ticket_id es UNIQUE (ver initDB en server.js) — si otro
      // proceso ya insertó para este mismo ticket (dos ciclos del job
      // solapados, reprocesar_ticket corriendo a la par, o un ticket
      // reprocesado que ya tenía una fila vieja sin XML/PDF), esto truena
      // con ER_DUP_ENTRY. Caso real encontrado en producción (tickets #5 y
      // #68): reprocesar_ticket no borraba la fila incompleta anterior, y
      // cuando el correo sí llegaba se creaba una SEGUNDA fila en vez de
      // completar la primera. Por eso NO basta con "omitir": si la fila
      // existente está incompleta (sin XML) y esta corrida sí trae XML, se
      // ACTUALIZA la fila existente. Solo se omite si la existente ya
      // estaba completa (ahí sí ganó la carrera otro proceso).
      try {
        await db.query(
          "INSERT INTO facturas (user_id, ticket_id, comercio, pdf_url, xml_url, status) VALUES (?, ?, ?, ?, ?, ?)",
          [ticket.user_id, ticket.id, ticket.comercio, pdfUrl, xmlUrl, "completado"]
        );
      } catch (dupErr) {
        if (dupErr.code === "ER_DUP_ENTRY") {
          const [[existente]] = await db.query("SELECT id, xml_url FROM facturas WHERE ticket_id = ?", [ticket.id]);
          if (existente && !existente.xml_url && xmlUrl) {
            await db.query("UPDATE facturas SET pdf_url=?, xml_url=?, status='completado' WHERE id=?", [pdfUrl, xmlUrl, existente.id]);
            console.log(`♻️ Job IMAP: ticket #${ticket.id} — fila #${existente.id} estaba incompleta (sin XML), se completó con los archivos de esta corrida`);
          } else {
            console.log(`⏭️ Job IMAP: ticket #${ticket.id} ya tenía factura completa (otro proceso ganó la carrera) — se omite, sin duplicar ni renotificar`);
          }
          await db.query("UPDATE tickets SET status = 'procesado' WHERE id = ? AND status != 'procesado'", [ticket.id]);
          continue;
        }
        throw dupErr;
      }
      await db.query("UPDATE tickets SET status = 'procesado' WHERE id = ?", [ticket.id]);
      console.log(`✅ Job IMAP: ticket #${ticket.id} procesado`);

      try {
        if (ticket.email) {
          await enviarCorreo({
            from: '"GPN Facturas" <buzonfacturas@serviciosga.site>',
            to: ticket.email,
            subject: "✅ Tu factura está lista — GPN Pinturas y Recubrimientos",
            html: emailFacturaLista({ nombre: ticket.user_nombre, comercio: ticket.comercio, xmlUrl, pdfUrl }),
          });
          console.log(`📧 Job IMAP: correo enviado a ${ticket.email}`);
        }
      } catch (mailErr) {
        console.log("⚠️ Job IMAP: error enviando correo:", mailErr.message);
      }

    } catch (imapErr) {
      console.log(`⚠️ Job IMAP: no llegó correo para ticket #${ticket.id} — evaluando estrategias...`);

      const portalDelTicket = (datos.portal || ticket.comercio || "").toLowerCase();
      const esArco = portalDelTicket === "arco" || portalDelTicket === "buzonfacturas" ||
        (ticket.comercio || "").toLowerCase().includes("arco");

      // Estrategia 7-Eleven: la factura NO llega por correo — se recupera del
      // portal con los endpoints REST (findLastCfdi → descargaCfdiXml/Pdf).
      const es7Eleven = portalDelTicket.includes("eleven") || (ticket.comercio || "").toLowerCase().includes("eleven");
      if (es7Eleven) {
        try {
          const { recuperarFacturaExistente } = require("../bots/7elevenmexicosadecv");
          const folio7e = datos.folio || datos.referencia || "";
          console.log(`♻️ Job IMAP: recuperando CFDI de 7-Eleven del portal para #${ticket.id} (folio ${folio7e})...`);
          const rec = await recuperarFacturaExistente(folio7e, ticket.id);
          if (rec && (rec.xmlUrl || rec.pdfUrl)) {
            await db.query(
              "INSERT INTO facturas (user_id, ticket_id, comercio, pdf_url, xml_url, status) VALUES (?, ?, ?, ?, ?, ?)",
              [ticket.user_id, ticket.id, ticket.comercio, rec.pdfUrl || null, rec.xmlUrl || null, "completado"]
            );
            await db.query("UPDATE tickets SET status = 'procesado' WHERE id = ?", [ticket.id]);
            console.log(`✅ Job IMAP: 7-Eleven recuperado para #${ticket.id} (UUID ${rec.uuid}, folio ${rec.folio})`);
            await crearNotificacion(ticket.user_id, "factura_lista",
              `Tu factura de ${ticket.comercio || "7-Eleven"} ya está lista para descargar.`).catch(() => {});
            try {
              if (ticket.email) {
                await enviarCorreo({
                  from: '"GPN Facturas" <buzonfacturas@serviciosga.site>',
                  to: ticket.email,
                  subject: "✅ Tu factura está lista — GPN Pinturas y Recubrimientos",
                  html: emailFacturaLista({ nombre: ticket.user_nombre, comercio: ticket.comercio, xmlUrl: rec.xmlUrl, pdfUrl: rec.pdfUrl }),
                });
              }
            } catch (mailErr) { console.log("⚠️ Job IMAP: error enviando correo:", mailErr.message); }
          } else {
            console.log(`⚠️ Job IMAP: no se pudo recuperar CFDI de 7-Eleven para #${ticket.id} — reintentará en siguiente ciclo`);
          }
        } catch (e7) {
          console.log(`⚠️ Job IMAP: error recuperando 7-Eleven #${ticket.id}: ${e7.message} — reintentará`);
        }
        continue;
      }

      if (!esArco) {
        console.log(`⚠️ IMAP: correo no encontrado aún para ticket #${ticket.id} (${portalDelTicket}) — reintentará en siguiente ciclo`);
        continue;
      }

      // Estrategia B (solo ARCO/BuzonFacturas): re-descarga del portal
      try {
        const { facturarBuzonFacturas } = require("../bots/buzonfacturas");
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

// ── Reintentos programados: re-ENCOLA en la cola de bots (respeta límites por portal) ──
async function procesarReintentos() {
  let tickets;
  try {
    const [rows] = await db.query(
      `SELECT t.id, t.user_id, t.comercio, t.ocr_json FROM tickets t
       WHERE t.status = 'error'
         AND t.reintento_programado IS NOT NULL
         AND t.reintento_programado <= NOW()`
    );
    tickets = rows;
  } catch { return; }
  if (!tickets.length) return;

  console.log(`🔄 Reintentos automáticos: ${tickets.length} ticket(s) → encolando`);
  for (const t of tickets) {
    const datos = JSON.parse(t.ocr_json || "{}");
    await db.query("UPDATE tickets SET reintento_programado = NULL WHERE id = ?", [t.id]);
    await encolarBot(t.id, t.user_id, (datos.portal || t.comercio || 'desconocido').toLowerCase().replace(/\s+/g, ''));
  }
}

// ── Limpiezas diarias ──
async function cleanupTickets() {
  try {
    const [rows] = await db.query(
      "SELECT id, ruta_archivo FROM tickets WHERE status = 'error' AND creado < NOW() - INTERVAL 30 DAY"
    );
    for (const t of rows) {
      if (t.ruta_archivo && !/^https?:\/\//i.test(t.ruta_archivo) && fs.existsSync(t.ruta_archivo)) {
        fs.unlinkSync(t.ruta_archivo);
      }
      await db.query("DELETE FROM tickets WHERE id = ?", [t.id]);
    }
    if (rows.length) console.log(`🧹 Cleanup: ${rows.length} ticket(s) eliminados`);
  } catch (e) {
    console.error("❌ cleanupTickets:", e.message);
  }
}

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

module.exports = { procesarTicketsPorCorreo, procesarReintentos, cleanupTickets, limpiarFacturasVencidas };
