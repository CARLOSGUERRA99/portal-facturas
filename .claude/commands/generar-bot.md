Genera la implementación completa para el portal analizado.

Antes de escribir nada, lee:
1. `CLAUDE.md` — arquitectura actual (engine + legacy, routing, convenciones)
2. `commerce/ramsa/` — plantilla engine de referencia
3. `bots/gasmaz.js` — referencia para bots legacy
4. `bots/index.js` — router actual

---

## Decisión previa obligatoria

Antes de generar código, determina explícitamente:

**¿Engine o Legacy?**
- **Engine** → portal con formulario estándar, flujo lineal, selects, descarga directa
- **Legacy** → portal con estado complejo entre páginas, iframes, CAPTCHAs, lógica muy dinámica

---

## Si es ENGINE — crea `commerce/{id}/`

Copia `commerce/ramsa/` como base y adapta cada archivo:

**`config.json`**
```json
{
  "id": "{id}",
  "nombre": "{nombre comercial}",
  "url_base": "{url del portal}",
  "dominio": "{dominio.com}",
  "stealth": true,
  "timeout": 30000,
  "datos_fijos": { "email": "buzonfacturas@serviciosga.site" },
  "defaults": { "regimenFiscal": "601", "usoCfdi": "G03", "formaPago": "debito" },
  "cfdi_keywords": { "G03": ["Gastos en general"], "S01": ["Sin efectos fiscales"] }
}
```

**`selectors.json`** — uno por campo, nombre descriptivo → selector CSS exacto

**`flow.json`** — pasos declarativos. Actions disponibles:
- `goto` → `{ "action":"goto", "url":"{{url}}" }`
- `waitFor` → `{ "action":"waitFor", "selector":"{{selectors.x}}", "timeout":10000 }`
- `waitForAny` → `{ "action":"waitForAny", "saveAs":"var", "selectors":{"key":"{{selectors.x}}"}, "timeout":15000 }`
- `fill` → `{ "action":"fill", "selector":"...", "value":"{{variable}}", "strategy":"keyboard|angular|angularjs|js" }`
- `click` → `{ "action":"click", "selector":"..." }`
- `screenshot` → `{ "action":"screenshot", "name":"nombre_paso" }`
- `hook` → `{ "action":"hook", "name":"nombreHook" }`
- `on` → `{ "action":"on", "value":"var", "equals":"key", "steps":[...] }`
- `exit` → `{ "action":"exit", "result":{ "ok":false, "error_code":"...", "msg":"..." } }`

**`hooks.js`** — solo lógica no expresable en JSON: selectByText AJAX, descargas con cookies, clicks por texto.
Copia las funciones helper de `commerce/ramsa/hooks.js` y adapta.
Cambia el prefijo R2 de `gasmaz_` a `{id}_` en los nombres de archivo.

---

## Si es LEGACY — crea `bots/{id}.js`

Estructura obligatoria (copia de `bots/gasmaz.js`):
- Función: `async function facturarNOMBRE({ rfc, razonSocial, regimenFiscal, usoCfdi, ticketId, ...camposEspecificos })`
- Browserless: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}&stealth=true`
- Helpers `fillInput` y `selectByText` copiados literalmente
- Screenshot en cada paso: `subirArchivoR2(buf, \`debug/{id}_paso_${Date.now()}.png\`, "image/png")`
- Email: `buzonfacturas@serviciosga.site` | Régimen: 601 | UsoCFDI: G03
- Retorno: `{ ok:true, xmlUrl, pdfUrl }` | `{ ok:true, procesandoCorreo:true }` | `{ ok:false, msg }`
- `module.exports = { facturarNOMBRE }`

---

## Registro en `bots/index.js`

Muestra exactamente qué líneas agregar:
- Engine: condición en el bloque `enginePortal` o llamada a `tieneEngine('{id}')`
- Legacy: `require` al inicio + bloque `if` de detección por portal/URL/texto

**No hagas los cambios sin confirmación del usuario.**
