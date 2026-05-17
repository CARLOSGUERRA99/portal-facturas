const { analizarPortal } = require("./analizador");
const { generarBot } = require("./generador");
const { validarBot } = require("./validador");

async function orquestarPortal({
  screenshotBase64,
  mimeType,
  url,
  notas,
  nombrePortal,
  datosTest,
}) {
  console.log(`🎭 Orquestador iniciando para: ${nombrePortal}`);

  // ── Agente 1: Análisis ──────────────────────────────────────────────────────
  console.log("🔍 Agente 1 — Analizando portal...");
  const analisis = await analizarPortal({ screenshotBase64, mimeType, url, notas });
  console.log(
    `✅ Análisis completo — tecnología: ${analisis.tecnologia} | pasos: ${analisis.pasos?.length || 0}`
  );

  // ── Agente 2: Generación ───────────────────────────────────────────────────
  console.log("⚙️ Agente 2 — Generando bot...");
  const { codigo, nombreArchivo, nombreFuncion } = await generarBot({
    analisisJson: analisis,
    nombrePortal,
  });
  console.log(`✅ Bot generado: ${nombreArchivo} (${codigo.length} chars)`);

  // ── Agente 3: Validación ───────────────────────────────────────────────────
  console.log("🔬 Agente 3 — Validando bot...");
  const validacion = await validarBot({ codigo, nombrePortal, datosTest });
  console.log(
    `✅ Validación: ${validacion.ok ? "APROBADO" : "CON ERRORES"} | ` +
      `errores: ${validacion.errores.length} | advertencias: ${validacion.advertencias.length}`
  );

  return {
    analisis,
    codigo,
    nombreArchivo,
    nombreFuncion,
    validacion,
    listo_para_aprobar: validacion.puede_desplegar,
  };
}

module.exports = { orquestarPortal };
