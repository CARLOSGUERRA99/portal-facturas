const fs = require("fs");
const path = require("path");

async function validarBot({ codigo, nombrePortal, datosTest }) {
  const errores = [];
  const advertencias = [];

  // ── Análisis estático ────────────────────────────────────────────────────────
  if (!codigo.includes("puppeteer"))
    errores.push("No importa puppeteer");
  if (!codigo.includes("subirArchivoR2"))
    errores.push("No usa subirArchivoR2 para screenshots de debug");
  if (!codigo.includes("browserWSEndpoint") && !codigo.includes("browserless.io"))
    errores.push("No se conecta a Browserless");
  if (!codigo.includes("module.exports"))
    errores.push("No tiene module.exports");
  if (!codigo.includes("ok: true"))
    errores.push("No tiene retorno estándar { ok: true }");
  if (!codigo.includes("ok: false"))
    errores.push("No tiene retorno de error { ok: false }");

  if (!codigo.includes("buzonfacturas@serviciosga.site"))
    advertencias.push("No usa el email de captura buzonfacturas@serviciosga.site");
  if (!codigo.includes("procesandoCorreo"))
    advertencias.push("No maneja el caso procesandoCorreo (fallback IMAP)");
  if (!/ya.{0,10}facturad/i.test(codigo))
    advertencias.push('No detecta el caso "ya facturado"');
  if (!codigo.includes("browser.close"))
    advertencias.push("No cierra el browser en el bloque catch");

  const pasosDetectados = (codigo.match(/PASO \d+|screenshot\s*\(/gi) || []).length;

  // ── Test live ────────────────────────────────────────────────────────────────
  let testLive = null;

  if (errores.length === 0 && process.env.BROWSERLESS_TOKEN && datosTest) {
    testLive = await ejecutarConTimeout(codigo, nombrePortal, datosTest);
  } else if (!process.env.BROWSERLESS_TOKEN) {
    testLive = { skipped: true, razon: "BROWSERLESS_TOKEN no disponible en entorno" };
  } else if (!datosTest) {
    testLive = { skipped: true, razon: "No se proporcionaron datos de prueba" };
  }

  return {
    ok: errores.length === 0,
    errores,
    advertencias,
    pasos_detectados: pasosDetectados,
    test_live: testLive,
    puede_desplegar: errores.length === 0,
  };
}

async function ejecutarConTimeout(codigo, nombrePortal, datosTest) {
  const ts = Date.now();
  // Escribimos en bots/ para que require('../storage/r2') resuelva correctamente
  const tmpFile = path.join(__dirname, "..", "bots", `tmp_validate_${ts}.js`);

  try {
    fs.writeFileSync(tmpFile, codigo, "utf8");

    delete require.cache[require.resolve(tmpFile)];
    const mod = require(tmpFile);
    const fn = Object.values(mod)[0];

    if (typeof fn !== "function")
      throw new Error("El módulo no exporta una función ejecutable");

    const resultado = await Promise.race([
      fn({ ...datosTest, ticketId: `validate_${ts}` }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timeout 90s — bot se detuvo")), 90000)
      ),
    ]);

    return { ejecutado: true, resultado };
  } catch (err) {
    return { ejecutado: true, error: err.message };
  } finally {
    try {
      delete require.cache[require.resolve(tmpFile)];
      fs.unlinkSync(tmpFile);
    } catch {}
  }
}

module.exports = { validarBot };
