Genera un bot Puppeteer completo para el portal analizado.

Antes de escribir código, lee:
1. `portales/portales.json` — para entender los patrones de cada portal
2. `bots/gasmaz.js` — es el bot de referencia más moderno, copia su estructura exacta
3. `bots/index.js` — para saber cómo agregar el nuevo bot al router

Usa el JSON de análisis del portal (resultado de /nuevo-portal) como especificación.

El bot generado debe cumplir EXACTAMENTE con:

**Estructura:**
- `async function facturarNOMBRE({ rfc, razonSocial, regimenFiscal, usoCfdi, ticketId, ...camposEspecificos })`
- Helpers `fillInput` y `selectByText` copiados de gasmaz.js
- Browserless: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}&stealth=true`
- `module.exports = { facturarNOMBRE }`

**Retorno estándar:**
- `{ ok: true, xmlUrl, pdfUrl }` — éxito con archivos
- `{ ok: true, procesandoCorreo: true }` — éxito, IMAP recogerá archivos
- `{ ok: false, msg: "..." }` — fallo con descripción

**Obligatorio en cada paso:**
- Screenshot: `subirArchivoR2(buf, \`debug/nombre_paso_${Date.now()}.png\`, "image/png")`
- Log descriptivo con emoji
- Manejo del caso "ya facturado" si aplica

**Datos fijos siempre:**
- Email de captura: `buzonfacturas@serviciosga.site`
- Régimen fiscal default: 601
- Uso CFDI default: G03 (Gastos en general)

Después de generar el bot, indica exactamente qué líneas agregar en `bots/index.js` para registrarlo.
