const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function nombreFuncionDesde(nombrePortal) {
  const limpio = nombrePortal
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9 ]/g, " ")
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join("");
  return "facturar" + limpio;
}

function nombreArchivoDesde(nombrePortal) {
  return (
    nombrePortal
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 30) + ".js"
  );
}

async function generarBot({ analisisJson, nombrePortal }) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const gasmazCode = fs.readFileSync(
    path.join(__dirname, "../bots/gasmaz.js"),
    "utf8"
  );

  const nombreFuncion = nombreFuncionDesde(nombrePortal);
  const nombreArchivo = nombreArchivoDesde(nombrePortal);
  const prefixDebug = nombreArchivo.replace(".js", "");

  const prompt = `Eres experto en Puppeteer y portales de facturación electrónica mexicanos SAT.

Genera un bot Puppeteer completo para el siguiente portal.

=== BOT DE REFERENCIA (gasmaz.js) ===
${gasmazCode}

=== ANÁLISIS DEL NUEVO PORTAL ===
${JSON.stringify(analisisJson, null, 2)}

=== INSTRUCCIONES ===
- Nombre del portal: ${nombrePortal}
- Nombre de la función: ${nombreFuncion}
- Nombre del archivo: ${nombreArchivo}

REGLAS OBLIGATORIAS (NO las incumplas):
1. Función principal: async function ${nombreFuncion}({ rfc, razonSocial, regimenFiscal, usoCfdi, ticketId, ...camposEspecificos })
2. Conexión Browserless: wss://production-sfo.browserless.io?token=\${process.env.BROWSERLESS_TOKEN}&stealth=true
3. Helpers fillInput y selectByText COPIADOS EXACTAMENTE de gasmaz.js (sin modificar)
4. Screenshot en CADA paso: subirArchivoR2(buf, \`debug/${prefixDebug}_\${label}_\${Date.now()}.png\`, "image/png")
5. Email de captura FIJO: buzonfacturas@serviciosga.site
6. Régimen fiscal default: 601 | Uso CFDI default: G03
7. Detectar y manejar caso "ya facturado" si el portal lo expone
8. Retorno estándar:
   - { ok: true, xmlUrl, pdfUrl }           → éxito con archivos directos
   - { ok: true, procesandoCorreo: true }    → éxito, IMAP recogerá archivos
   - { ok: false, msg: "descripción" }       → fallo con descripción
9. Cierre siempre: try { await browser.close(); } catch {}
10. module.exports = { ${nombreFuncion} }

Responde SOLO con el código JavaScript completo. Sin texto adicional, sin bloques markdown.`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 20000,
    messages: [{ role: "user", content: prompt }],
  });

  // Si el modelo se quedó sin tokens, el código viene truncado a media instrucción.
  // Detectarlo aquí evita guardar bots inválidos que luego rompen producción.
  if (response.stop_reason === "max_tokens") {
    throw new Error(
      `Generación truncada: el bot excedió max_tokens (20000). El portal ${nombrePortal} es demasiado complejo para un solo paso — divide el flujo o sube el límite.`
    );
  }

  let codigo = response.content[0].text;
  codigo = codigo
    .replace(/^```javascript\n?/m, "")
    .replace(/^```js\n?/m, "")
    .replace(/^```\n?/m, "")
    .replace(/\n?```$/m, "")
    .trim();

  // Validación de sintaxis: compila (sin ejecutar) para garantizar que el bot
  // generado es JavaScript válido y completo. Un bot truncado falla aquí.
  try {
    new vm.Script(codigo, { filename: nombreArchivo });
  } catch (e) {
    throw new Error(
      `El bot generado para ${nombrePortal} tiene un error de sintaxis (${e.message}). Probablemente está incompleto o malformado — no se guardará.`
    );
  }

  // Verificación mínima de contrato: debe exportar la función esperada.
  if (!codigo.includes(`function ${nombreFuncion}`)) {
    throw new Error(
      `El bot generado para ${nombrePortal} no contiene la función esperada "${nombreFuncion}".`
    );
  }

  return { codigo, nombreArchivo, nombreFuncion };
}

module.exports = { generarBot, nombreFuncionDesde, nombreArchivoDesde };
