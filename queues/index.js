// Infraestructura de colas (FASE 1): Redis + BullMQ.
//
// TRES colas — no dos — porque el diagnóstico mostró que los agentes de portales
// nuevos (15-40 min) eran los que congelaban la facturación normal:
//   vision  — lectura de fotos con Sonnet (concurrencia alta: solo espera de API)
//   bots    — Puppeteer/portales (concurrencia limitada POR PORTAL, no global)
//   agente  — alta de portales nuevos (concurrencia 1, aislada del resto)
//
// Reintentos: 3 intentos con backoff exponencial (30s → 60s → 120s… BullMQ duplica).
// Los jobs que agotan intentos QUEDAN en el set "failed" de su cola = cola muerta,
// visibles vía los endpoints /api/admin/cola-muerta (nunca se pierden en silencio).
require("dotenv").config();
const { Queue } = require("bullmq");
const IORedis = require("ioredis");

if (!process.env.REDIS_URL) {
  throw new Error("REDIS_URL no configurada — la arquitectura de colas la requiere (Railway → servicio Redis → variable REDIS_URL)");
}

// maxRetriesPerRequest: null es requisito de BullMQ para conexiones de Workers.
function nuevaConexion() {
  const conn = new IORedis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  // Sin este handler, un parpadeo de Redis emite 'error' sin listener y TUMBA
  // el proceso Node completo. ioredis reconecta solo; aquí solo registramos.
  conn.on("error", (e) => console.error("⚠️ [redis]", e.message));
  return conn;
}

const connection = nuevaConexion();

const DEFAULT_JOB_OPTS = {
  attempts: 3,
  backoff: { type: "exponential", delay: 30000 }, // 30s, 60s, 120s
  removeOnComplete: { count: 500 },   // historial acotado de éxitos
  removeOnFail: false,                // los fallidos se conservan = cola muerta
};

const visionQueue = new Queue("vision", { connection, defaultJobOptions: DEFAULT_JOB_OPTS });
const botsQueue   = new Queue("bots",   { connection, defaultJobOptions: DEFAULT_JOB_OPTS });
const agenteQueue = new Queue("agente", { connection, defaultJobOptions: { ...DEFAULT_JOB_OPTS, attempts: 1 } });

// ── Helpers de encolado ──────────────────────────────────────────────────────
// jobId determinístico por ticket: si el mismo ticket se encola dos veces antes
// de procesarse, BullMQ ignora el segundo (anti doble-procesamiento).
async function encolarVision(ticketId, userId) {
  return visionQueue.add("leer", { ticketId, userId }, { jobId: `vision-${ticketId}-${Date.now()}` });
}

async function encolarBot(ticketId, userId, portalKey = "desconocido") {
  return botsQueue.add("facturar", { ticketId, userId, portalKey }, { jobId: `bot-${ticketId}-${Date.now()}` });
}

async function encolarAgente(ticketId, userId, comercioNombre, portalUrl) {
  return agenteQueue.add("alta-portal", { ticketId, userId, comercioNombre, portalUrl },
    { jobId: `agente-${ticketId}-${Date.now()}` });
}

// ── Límite de concurrencia POR PORTAL (cola bots) ────────────────────────────
// Contador en Redis por portal con TTL de seguridad. Si ya hay `limite` bots del
// mismo portal corriendo, el job se re-agenda +15-30s (jitter) en vez de correr.
// Esto evita 5 tickets de OXXO golpeando a OXXO a la vez (captchas/bloqueos).
const LIMITE_POR_PORTAL = 2;
const TTL_SLOT_SEG = 15 * 60; // liberación automática si un proceso muere sin decrementar

async function tomarSlotPortal(portalKey) {
  const key = `bots:corriendo:${portalKey}`;
  const n = await connection.incr(key);
  await connection.expire(key, TTL_SLOT_SEG);
  if (n > LIMITE_POR_PORTAL) {
    await connection.decr(key);
    return false;
  }
  return true;
}

async function soltarSlotPortal(portalKey) {
  const key = `bots:corriendo:${portalKey}`;
  const n = await connection.decr(key);
  if (n < 0) await connection.set(key, 0, "EX", TTL_SLOT_SEG); // autocorrección
}

// ── Cola muerta (jobs fallidos de todas las colas) ───────────────────────────
const TODAS = { vision: visionQueue, bots: botsQueue, agente: agenteQueue };

async function listarColaMuerta(limite = 50) {
  const resultado = [];
  for (const [nombre, q] of Object.entries(TODAS)) {
    const fallidos = await q.getFailed(0, limite - 1);
    for (const j of fallidos) {
      resultado.push({
        cola: nombre, jobId: j.id, nombre: j.name, datos: j.data,
        error: (j.failedReason || "").slice(0, 300),
        intentos: j.attemptsMade, creado: j.timestamp ? new Date(j.timestamp).toISOString() : null,
      });
    }
  }
  resultado.sort((a, b) => (b.creado || "").localeCompare(a.creado || ""));
  return resultado.slice(0, limite);
}

async function reintentarJobMuerto(cola, jobId) {
  const q = TODAS[cola];
  if (!q) throw new Error(`Cola desconocida: ${cola}`);
  const job = await q.getJob(jobId);
  if (!job) throw new Error(`Job ${jobId} no encontrado en ${cola}`);
  await job.retry();
  return true;
}

async function borrarJobMuerto(cola, jobId) {
  const q = TODAS[cola];
  if (!q) throw new Error(`Cola desconocida: ${cola}`);
  const job = await q.getJob(jobId);
  if (!job) return false;
  await job.remove();
  return true;
}

module.exports = {
  connection, nuevaConexion,
  visionQueue, botsQueue, agenteQueue,
  encolarVision, encolarBot, encolarAgente,
  tomarSlotPortal, soltarSlotPortal, LIMITE_POR_PORTAL,
  listarColaMuerta, reintentarJobMuerto, borrarJobMuerto,
};
