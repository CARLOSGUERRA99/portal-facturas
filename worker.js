// ── WORKER (FASE 1) ───────────────────────────────────────────────────────────
// Servicio separado del servidor web. Procesa las tres colas:
//   vision  (concurrencia 6) — lectura de fotos con Sonnet
//   bots    (concurrencia 4, máx 2 por portal) — Puppeteer/portales
//   agente  (concurrencia 1) — alta de portales nuevos (15-40 min, aislado)
// Además corre los jobs periódicos: IMAP (2 min), reintentos (5 min),
// limpiezas (24 h) y un safety-net para tickets que se quedaron sin encolar.
//
// Arranque en Railway: `node worker.js` (servicio portal-facturas-worker).
require("dotenv").config();
const { Worker, DelayedError } = require("bullmq");
const db = require("./lib/db");
const {
  nuevaConexion, tomarSlotPortal, soltarSlotPortal, LIMITE_POR_PORTAL, encolarBot,
} = require("./queues");
const { procesarImagenTicket, buscarDuplicado } = require("./lib/vision");
const { ejecutarFacturacion, manejarNuevoPortal } = require("./lib/facturacion");
const { crearNotificacion, esPortalFacturable, sinSolape, esComercioBloqueado } = require("./lib/util");
const {
  procesarTicketsPorCorreo, procesarReintentos, cleanupTickets, limpiarFacturasVencidas,
} = require("./lib/imap-job");
const { respaldarBaseDatos } = require("./lib/backup-db");
const { restaurarBotsDinamicos, orquestar } = require("./agentes/orquestador");

const MIME_POR_EXT = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };

// ── Worker VISION ─────────────────────────────────────────────────────────────
const visionWorker = new Worker("vision", async (job) => {
  const { ticketId, userId } = job.data;
  console.log(`👁️ [vision] Ticket #${ticketId} — leyendo imagen...`);

  const [[ticket]] = await db.query("SELECT id, user_id, ruta_archivo, nombre_archivo FROM tickets WHERE id = ?", [ticketId]);
  if (!ticket) { console.log(`⚠️ [vision] Ticket #${ticketId} no existe — job descartado`); return; }

  // La imagen vive en R2 (el disco de Railway es efímero y web/worker son contenedores distintos)
  if (!/^https?:\/\//i.test(ticket.ruta_archivo || "")) {
    throw new Error(`Ticket #${ticketId} sin URL de imagen en R2 (ruta: ${ticket.ruta_archivo})`);
  }
  const resp = await fetch(ticket.ruta_archivo);
  if (!resp.ok) throw new Error(`No se pudo descargar imagen del ticket #${ticketId} (HTTP ${resp.status})`);
  const imageBuffer = Buffer.from(await resp.arrayBuffer());
  const ext = (ticket.ruta_archivo.split(".").pop() || "jpg").toLowerCase();
  const mimeType = MIME_POR_EXT[ext] || "image/jpeg";

  let r;
  try {
    r = await procesarImagenTicket(imageBuffer, mimeType);
  } catch (e) {
    if (e.sinComercio) {
      await db.query("UPDATE tickets SET status = 'error', error_msg = 'No se pudo identificar el portal ni el comercio en la imagen' WHERE id = ?", [ticketId]);
      await crearNotificacion(userId, "factura_error", "No pudimos leer tu ticket. Sube una foto más clara o completa los datos manualmente.");
      return; // error de datos, no reintentar
    }
    throw e; // error de API/red → BullMQ reintenta con backoff
  }

  const { datosOCR, textoOCR, portalDetectado, confianza, camposDudosos, requiereConfirmacion, portalUrl } = r;

  // Comercios cuyo portal bloquea el acceso automatizado (ver esComercioBloqueado
  // en lib/util.js) — no se tratan como "portal nuevo" para el agente de alta
  // automática, se rechazan explícitamente con un mensaje claro.
  if (esComercioBloqueado(datosOCR.comercio || ticket.comercio)) {
    const comercioNombre = datosOCR.comercio || ticket.comercio || "este comercio";
    const msg = `${comercioNombre} no se puede facturar de forma automática: su portal bloquea el acceso automatizado (protección anti-bots) y por eso no está soportado. Solicita esta factura directamente en el sitio del comercio.`;
    console.log(`🛑 [vision] Ticket #${ticketId} — comercio bloqueado (${comercioNombre})`);
    await db.query("UPDATE tickets SET status = 'error', error_msg = ?, ocr_json = ?, comercio = ? WHERE id = ?",
      [msg, JSON.stringify(datosOCR), comercioNombre, ticketId]);
    await crearNotificacion(userId, "factura_error", msg);
    return;
  }

  // Anti-duplicados (misma regla que antes, ahora post-OCR): si ya existe un
  // ticket del mismo comercio+folio no-error, este se marca como duplicado.
  const dup = await buscarDuplicado(ticket.user_id, datosOCR, ticketId);
  if (dup) {
    const fechaPrev = dup.creado ? new Date(dup.creado).toLocaleDateString("es-MX") : "";
    const msg = `duplicado: folio ${dup.folio} ya registrado${fechaPrev ? " el " + fechaPrev : ""} — ticket #${dup.id}`;
    console.log(`🚫 [vision] Ticket #${ticketId} es duplicado de #${dup.id}`);
    // ⚠️ NO se guarda ocr_json en un duplicado: la columna generada
    // `clave_dedupe` saldría idéntica a la del ticket original y el índice
    // UNIQUE `uq_ticket_dedupe` rechazaría el UPDATE, dejando el ticket colgado
    // sin explicación. Se conserva la fila (para que quede el rastro de que se
    // intentó subir) pero sin los datos que colisionan.
    await db.query("UPDATE tickets SET status = 'error', error_msg = ?, comercio = ? WHERE id = ?",
      [msg, datosOCR.comercio || "desconocido", ticketId]);
    return;
  }

  try {
    await db.query(
      `UPDATE tickets SET ocr_text = ?, ocr_json = ?, comercio = ?, portal_url = ?,
       requiere_confirmacion = ?, status = 'pendiente_confirmacion' WHERE id = ?`,
      [textoOCR, JSON.stringify(datosOCR), datosOCR.comercio || "desconocido",
       datosOCR.portalUrl || portalUrl || null, requiereConfirmacion, ticketId]
    );
  } catch (e) {
    // Red de seguridad del candado: si el chequeo de arriba no lo vio pero el
    // índice UNIQUE sí (p.ej. dos fotos idénticas subidas a la vez y leídas en
    // paralelo), MySQL rechaza el UPDATE con ER_DUP_ENTRY. Se marca el ticket
    // como duplicado en vez de dejar el job reventado y el ticket colgado.
    if (e.code === 'ER_DUP_ENTRY') {
      const [[orig]] = await db.query(
        'SELECT id FROM tickets WHERE clave_dedupe = (SELECT CONCAT(?, "|", UPPER(REPLACE(?," ","")), "|", CAST(? AS DECIMAL(12,2)))) AND id <> ? LIMIT 1',
        [ticket.user_id, String(datosOCR.folio || datosOCR.codigoTicket || datosOCR.referencia || ''), datosOCR.total, ticketId]
      ).catch(() => [[]]);
      const msg = `duplicado: este ticket ya está registrado${orig ? ` — ticket #${orig.id}` : ''}`;
      console.log(`🚫 [vision] Ticket #${ticketId} bloqueado por el candado anti-duplicados`);
      await db.query("UPDATE tickets SET status='error', error_msg=?, comercio=? WHERE id=?",
        [msg, datosOCR.comercio || 'desconocido', ticketId]);
      return;
    }
    throw e;
  }
  console.log(`✅ [vision] Ticket #${ticketId} — portal: ${portalDetectado}, confianza: ${confianza}, dudosos: [${camposDudosos.join(",")}], confirmación: ${requiereConfirmacion}`);

  // Confianza alta + portal facturable → directo a la cola de bots.
  // Portal desconocido → el frontend abre el cuestionario (que encola al agente).
  if (!requiereConfirmacion && portalDetectado !== "desconocido" && esPortalFacturable(datosOCR, datosOCR.portalUrl || portalUrl)) {
    await db.query("UPDATE tickets SET requiere_confirmacion = 0 WHERE id = ?", [ticketId]);
    const portalKey = (datosOCR.portal || datosOCR.comercio || "desconocido").toLowerCase().replace(/\s+/g, "");
    await encolarBot(ticketId, ticket.user_id, portalKey);
    console.log(`📤 [vision] Ticket #${ticketId} → cola bots [${portalKey}]`);
  }
}, {
  connection: nuevaConexion(),
  concurrency: 6,
});

// ── Worker BOTS (máx 2 en paralelo POR PORTAL) ────────────────────────────────
const botsWorker = new Worker("bots", async (job, token) => {
  const { ticketId, userId, portalKey } = job.data;
  const portal = portalKey || "desconocido";

  // Límite por portal: si ya hay LIMITE_POR_PORTAL bots corriendo contra este
  // portal, el job se pospone 15-30s (no bloquea el worker ni consume intento).
  const slot = await tomarSlotPortal(portal);
  if (!slot) {
    const espera = 15000 + Math.floor(Math.random() * 15000);
    console.log(`⏳ [bots][${portal}] límite de ${LIMITE_POR_PORTAL} alcanzado — ticket #${ticketId} pospuesto ${Math.round(espera / 1000)}s`);
    await job.moveToDelayed(Date.now() + espera, token);
    throw new DelayedError();
  }

  try {
    console.log(`🤖 [bots][${portal}] Facturando ticket #${ticketId}...`);
    const r = await ejecutarFacturacion(ticketId, userId);
    console.log(`🤖 [bots][${portal}] Ticket #${ticketId} → ${r?.ok ? "OK" : `error: ${r?.error_code || r?.msg || "?"}`}`);
    return r;
  } finally {
    await soltarSlotPortal(portal);
  }
}, {
  connection: nuevaConexion(),
  concurrency: 4,
  // ⚠️ SIN ESTO EL SISTEMA PUEDE EMITIR LA MISMA FACTURA DOS VECES.
  //
  // El lock por defecto de BullMQ es 30s, pero un bot tarda bastante más:
  // medido en ticket_intentos, hasta 253s, y OXXO ronda los 58s. Pasados los
  // 30s BullMQ da el job por "stalled" y lo entrega a otro worker MIENTRAS EL
  // PRIMERO SIGUE FACTURANDO. De ahí salían los reintentos fantasma del 31/07:
  // 7 tickets encolados 4 veces cada uno al agente a lo largo de 5 horas.
  //
  // 10 minutos cubre con margen al bot más lento (7-Eleven, ~279s) sin dejar un
  // job zombi bloqueado media hora si el proceso muere de verdad.
  lockDuration: 10 * 60 * 1000,
});

// ── Worker AGENTE (concurrencia 1 — nunca bloquea la facturación normal) ─────
const agenteWorker = new Worker("agente", async (job) => {
  // "alta-portal": flujo automático disparado por un ticket con portal desconocido.
  if (job.name === "alta-portal") {
    const { ticketId, userId, comercioNombre, portalUrl } = job.data;
    console.log(`🧠 [agente] Alta de portal nuevo: ${comercioNombre} (ticket #${ticketId})`);
    await manejarNuevoPortal(ticketId, userId, comercioNombre, portalUrl);
    return;
  }
  // "orquestar-manual": botón "Orquestar" del panel admin — antes corría inline
  // en el request HTTP; el resultado queda en job.returnvalue para que
  // GET /api/admin/agente/estado/:jobId lo reporte (polling).
  if (job.name === "orquestar-manual") {
    const { comercioNombre, portalUrl, instrucciones } = job.data;
    console.log(`🎭 [agente] Orquestación manual: ${comercioNombre}`);
    return await orquestar({ db, ticketId: null, portalUrl, comercioNombre, instrucciones: instrucciones || '' });
  }
  console.log(`⚠️ [agente] Job de tipo desconocido: ${job.name}`);
}, {
  connection: nuevaConexion(),
  concurrency: 1,
  lockDuration: 50 * 60 * 1000, // el pipeline del agente puede tardar 40+ min
});

for (const [nombre, w] of Object.entries({ vision: visionWorker, bots: botsWorker, agente: agenteWorker })) {
  w.on("failed", (job, err) => {
    if (err instanceof DelayedError) return; // pospuesto por límite de portal, no es fallo
    const agotado = job && job.attemptsMade >= (job.opts.attempts || 1);
    console.error(`❌ [${nombre}] Job ${job?.id} falló (intento ${job?.attemptsMade}/${job?.opts?.attempts}): ${err.message}${agotado ? " — A COLA MUERTA" : ""}`);
  });
  w.on("error", (err) => console.error(`❌ [${nombre}] worker error:`, err.message));
}

// ── Safety-net: tickets confirmados que no llegaron a la cola (p.ej. Redis
// caído justo al encolar). Cada 60s busca pendiente_confirmacion+requiere_confirmacion=0
// con más de 3 min de antigüedad y los encola. jobId en cubetas de 10 min evita duplicar.
async function rescatarTicketsSinEncolar() {
  const [rows] = await db.query(
    `SELECT t.id, t.user_id, t.ocr_json FROM tickets t
     JOIN users u ON t.user_id = u.id
     WHERE t.status = 'pendiente_confirmacion' AND t.requiere_confirmacion = 0
       AND t.ocr_json IS NOT NULL
       AND u.rfc IS NOT NULL AND u.rfc != ''
       AND t.creado < DATE_SUB(NOW(), INTERVAL 3 MINUTE)
     LIMIT 10`
  );
  for (const t of rows) {
    const datos = JSON.parse(t.ocr_json || "{}");
    if (!esPortalFacturable(datos, datos.portalUrl)) continue;
    const portalKey = (datos.portal || datos.comercio || "desconocido").toLowerCase().replace(/\s+/g, "");
    const cubeta = Math.floor(Date.now() / (10 * 60 * 1000));
    const { botsQueue } = require("./queues");
    await botsQueue.add("facturar", { ticketId: t.id, userId: t.user_id, portalKey },
      { jobId: `bot-rescate-${t.id}-${cubeta}` }).catch(() => {});
    console.log(`🛟 [rescate] Ticket #${t.id} re-encolado [${portalKey}]`);
  }
}

// ── Jobs periódicos (viven en el worker, ya no en el proceso web) ─────────────
setInterval(sinSolape(procesarTicketsPorCorreo, "IMAP-correo"), 2 * 60 * 1000);
setInterval(sinSolape(procesarReintentos, "reintentos"), 5 * 60 * 1000);
setInterval(sinSolape(rescatarTicketsSinEncolar, "rescate"), 60 * 1000);
setInterval(cleanupTickets, 24 * 60 * 60 * 1000);
setInterval(limpiarFacturasVencidas, 24 * 60 * 60 * 1000);
// Respaldo diario de la BD a R2 (capa extra — los backups de volumen de Railway
// se administran aparte en el dashboard)
setInterval(() => respaldarBaseDatos().catch(e => console.error("❌ respaldo DB:", e.message)), 24 * 60 * 60 * 1000);
cleanupTickets();
limpiarFacturasVencidas();
respaldarBaseDatos().catch(e => console.error("❌ respaldo DB:", e.message));

// Restaurar bots dinámicos (generados por agentes) al disco de ESTE contenedor
restaurarBotsDinamicos(db).catch(e => console.log("⚠️ restaurarBots:", e.message));

// ── Apagado limpio (Railway envía SIGTERM en cada redeploy) ──────────────────
async function shutdown(sig) {
  console.log(`🛑 ${sig} — cerrando workers (esperando jobs activos)...`);
  try {
    await Promise.allSettled([visionWorker.close(), botsWorker.close(), agenteWorker.close()]);
    await db.end().catch(() => {});
  } finally {
    process.exit(0);
  }
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

console.log("🏭 Worker de colas corriendo — vision(6) | bots(4, máx 2/portal) | agente(1)");
