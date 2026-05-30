const fs = require("fs");
const path = require("path");
const vm = require("vm");

async function validarBot({ codigo, nombrePortal, datosTest }) {
  const errores = [];
  const advertencias = [];

  // ── Sintaxis (bloqueante) ──────────────────────────────────────────────────────
  // Compila sin ejecutar. Un bot truncado o malformado falla aquí y NUNCA llega a
  // pendiente_aprobacion. Es la primera barrera: sin código válido, nada más importa.
  try {
    new vm.Script(codigo, { filename: `${nombrePortal}.js` });
  } catch (e) {
    errores.push(`Error de sintaxis (bot incompleto o malformado): ${e.message}`);
    // Sin sintaxis válida no tiene sentido seguir analizando — abortamos temprano.
    return {
      ok: false,
      errores,
      advertencias,
      pasos_detectados: 0,
      test_live: { skipped: true, razon: "Código con error de sintaxis" },
      puede_desplegar: false,
    };
  }

  // ── Análisis estático ────────────────────────────────────────────────────────
  if (!/puppeteer/i.test(codigo))
    errores.push("No importa puppeteer");
  if (!codigo.includes("subirArchivoR2"))
    errores.push("No usa subirArchivoR2 para screenshots de debug");
  if (!codigo.includes("browserWSEndpoint") && !codigo.includes("browserless.io"))
    errores.push("No se conecta a Browserless");
  if (!codigo.includes("module.exports"))
    errores.push("No tiene module.exports");
  if (!/\bok\s*:\s*true\b/.test(codigo))
    errores.push("No tiene retorno estándar { ok: true }");
  if (!/\bok\s*:\s*false\b/.test(codigo))
    errores.push("No tiene retorno de error { ok: false }");

  if (!codigo.includes("buzonfacturas@serviciosga.site"))
    advertencias.push("No usa el email de captura buzonfacturas@serviciosga.site");
  if (!codigo.includes("procesandoCorreo"))
    advertencias.push("No maneja el caso procesandoCorreo (fallback IMAP)");
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

  // Fallo en la ejecución en vivo → el bot está roto → error para que el corrector lo arregle.
  // (a) Excepción/timeout (testLive.error). (b) {ok:false} SIN error_code controlado:
  // un bot bien hecho devuelve datos_invalidos/ya_facturado/vencido con datos de prueba;
  // si devuelve {ok:false} con un msg estructural ("no se encontró el formulario/botón"),
  // está roto, NO es un ticket inválido.
  if (testLive && testLive.error) {
    errores.push(`Falló en ejecución en vivo: ${String(testLive.error).slice(0, 200)}`);
  } else if (testLive && testLive.resultado && testLive.resultado.ok === false) {
    const ec = testLive.resultado.error_code;
    const controlado = ['datos_invalidos', 'ya_facturado', 'ticket_vencido', 'folio_no_disponible'].includes(ec);
    if (!controlado) {
      errores.push(`La prueba en vivo falló estructuralmente (sin error_code controlado): ${(testLive.resultado.msg || ec || 'desconocido').slice(0, 200)}`);
    }
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
