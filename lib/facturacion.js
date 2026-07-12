// Lógica central de facturación — extraída de server.js en FASE 1.
// Corre EXCLUSIVAMENTE en el worker (cola bots / cola agente).
// Cambio clave vs. la versión original: ya NO existe conColaPortal aquí — la
// concurrencia por portal la garantiza la cola de bots (tomarSlotPortal en worker.js).
const db = require("./db");
const { detectarYFacturar } = require("../bots/index");
const { orquestar } = require("../agentes/orquestador");
const { enviarCorreo } = require("./correo");
const {
  crearNotificacion, registrarIntento, proximaMedianoche, renombrarConUUID,
  corregirFolioOxxo, corregirIdVentaOxxo, validarDatosOxxo,
  PORTALES_CONOCIDOS, ADMIN_EMAIL,
} = require("./util");
const { encolarAgente } = require("../queues");

function emailFacturaLista({ nombre, comercio, xmlUrl, pdfUrl }) {
  return `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
    <div style="background:#3B6D11;padding:20px;border-radius:12px 12px 0 0;">
      <h2 style="color:#fff;margin:0;">GPN Pinturas y Recubrimientos</h2>
      <p style="color:#C0DD97;margin:4px 0 0;">Portal de Facturación Automática</p>
    </div>
    <div style="background:#f8faf6;padding:24px;border-radius:0 0 12px 12px;border:1px solid #e0edd5;">
      <p>Hola <strong>${nombre || ''}</strong>,</p>
      <p>Tu factura${comercio ? ` de <strong>${comercio}</strong>` : ''} está lista para descargar.</p>
      <div style="margin:20px 0;">
        ${xmlUrl ? `<a href="${xmlUrl}" style="display:inline-block;margin-right:10px;background:#EAF3DE;color:#27500A;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:500;">⬇ Descargar XML</a>` : ''}
        ${pdfUrl ? `<a href="${pdfUrl}" style="display:inline-block;background:#3B6D11;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:500;">⬇ Descargar PDF</a>` : ''}
      </div>
      <a href="https://portal-facturas-production.up.railway.app/mis-facturas" style="display:inline-block;background:#3B6D11;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:500;">Ver mis facturas →</a>
    </div>
  </div>`;
}

// ── LÓGICA DE FACTURACIÓN (job de la cola bots) ──────────────────────────────
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

    const resultado = await detectarYFacturar({
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
    }, db);

    const duracionMs = Date.now() - inicioMs;
    const botNombre = datos.portal || ticket.comercio || 'desconocido';

    if (resultado.sinPortal) {
      const comercioNombre = ticket.comercio || datos.comercio || 'desconocido';
      const portalUrl = datos.portalUrl || ticket.portal_url || '';
      await registrarIntento(ticketId, botNombre, 'agente', 'Portal nuevo — encolado para agente', duracionMs);
      await db.query(
        "UPDATE tickets SET status = 'procesando', error_msg = 'Agente analizando portal nuevo...' WHERE id = ?",
        [ticketId]
      );
      await crearNotificacion(userId, 'portal_desconocido',
        `Recibimos tu ticket de ${comercioNombre}. Te avisaremos cuando tu factura esté lista.`);
      // FASE 1: el agente corre en SU PROPIA cola (concurrencia 1) — un alta de
      // portal nuevo ya no ocupa lugares de la cola de bots ni congela el sistema.
      await encolarAgente(ticketId, userId, comercioNombre, portalUrl);
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
            html: emailFacturaLista({ nombre: ticket.user_nombre, comercio: ticket.comercio, xmlUrl, pdfUrl }),
          });
        }
      } catch {}
      await crearNotificacion(userId, 'factura_lista', `✅ Tu factura de ${ticket.comercio || 'este comercio'} está lista para descargar.`);
      return { ok: true, pdfUrl, xmlUrl };
    }

    // ── Ticket vencido — portal no acepta facturación en plazo ──
    if (resultado.error_code === 'ticket_vencido') {
      const emailContacto = resultado.email_contacto || null;
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

    // ── Portal requiere CAPTCHA — solo facturación manual ──
    if (resultado.error_code === 'captcha') {
      await db.query(
        "UPDATE tickets SET status = 'error', error_msg = ?, reintento_programado = NULL WHERE id = ?",
        [(resultado.msg || 'Requiere CAPTCHA — factura manual').slice(0, 500), ticketId]
      );
      await registrarIntento(ticketId, botNombre, 'error', `captcha|${resultado.portal_url || ''}`, duracionMs);
      await crearNotificacion(userId, 'factura_error',
        `Tu ticket de ${ticket.comercio || 'este comercio'} debe facturarse MANUALMENTE: el portal pide CAPTCHA. Tus datos ya están extraídos y listos.`
      ).catch(() => {});
      return { ok: false, error_code: 'captcha', msg: resultado.msg };
    }

    // ── OXXO: folio no disponible (escalación) ──
    if (resultado.tipo === 'folio_no_disponible') {
      const [[{ nIntentos }]] = await db.query(
        "SELECT COUNT(*) as nIntentos FROM ticket_intentos WHERE ticket_id = ? AND mensaje LIKE '%folio_no_disponible%'",
        [ticketId]
      );
      await registrarIntento(ticketId, botNombre, 'error', `folio_no_disponible|${resultado.msg}`, duracionMs);

      if (nIntentos >= 1) {
        await db.query("UPDATE tickets SET status = 'error', reintento_programado = NULL WHERE id = ?", [ticketId]);
        await crearNotificacion(userId, 'factura_error',
          `❌ Tu ticket de ${ticket.comercio} no puede facturarse. El folio no existe en el sistema después de 2 intentos. Te recomendamos levantar una aclaración directamente en tienda OXXO.`);
      } else {
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

// ── AGENTE: analizar portal nuevo y notificar resultado (job de la cola agente) ──
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
    const [[t]] = await db.query("SELECT portal_url, ocr_json FROM tickets WHERE id = ?", [ticketId]);
    const ocr = JSON.parse(t?.ocr_json || '{}');
    const urlFinal = ocr.portalUrl || t?.portal_url || portalUrl || '';

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

module.exports = { ejecutarFacturacion, manejarNuevoPortal, resumenAgente, emailFacturaLista };
