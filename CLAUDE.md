# portal-facturas — Contexto del proyecto

Sistema de facturación electrónica automática para conjuntos residenciales.
Los residentes suben una foto de su ticket, el sistema extrae los datos con OCR (Claude Vision),
y un bot Puppeteer factura automáticamente en el portal del comercio.

## Stack

- **Backend:** Node.js + Express, puerto 8080
- **Hosting:** Railway
- **Browser automation:** Puppeteer conectado a Browserless (`wss://production-sfo.browserless.io?token=${BROWSERLESS_TOKEN}&stealth=true`)
- **IA:** Anthropic SDK (`@anthropic-ai/sdk`) — Haiku para detección, Sonnet para extracción
- **Storage:** Cloudflare R2 (`storage/r2.js` → `subirArchivoR2(buffer, key, contentType)`)
- **Email:** IMAP + mailparser + unzipper para recibir XML/PDF por correo
- **BD:** MySQL en Railway (`db.query`)
- **Sesiones:** express-session

## Variables de entorno (NUNCA en código, solo en Railway)

```
BROWSERLESS_TOKEN
ANTHROPIC_API_KEY
SMTP_HOST / SMTP_PORT / SMTP_SECURE / SMTP_USER / SMTP_PASS
IMAP_HOST / IMAP_PORT / IMAP_USER / IMAP_PASS
R2_ACCESS_KEY / R2_SECRET_KEY / R2_ENDPOINT / R2_BUCKET / R2_PUBLIC_URL
DB_HOST / DB_USER / DB_PASS / DB_NAME
SESSION_SECRET
```

Correo de captura de facturas: `buzonfacturas@serviciosga.site`

## Estructura de archivos

```
server.js              — servidor principal, endpoints, OCR pipeline
bots/
  index.js             — router: detecta portal y llama al bot correcto
  oxxo.js              — ✅ bot OXXO (caso de éxito confirmado)
  buzonfacturas.js     — ✅ bot ARCO/BuzonFacturas (caso de éxito confirmado)
  gasmaz.js            — ✅ bot Gasmaz/NexusFuel (caso de éxito confirmado)
  farmaciaguadalajara.js — ⚠️ bot en desarrollo, no tiene caso de éxito aún
mail/
  imap.js              — recibe XML/PDF por correo IMAP (buzonfacturas@)
storage/
  r2.js                — sube/borra archivos en Cloudflare R2
public/
  *.html               — frontend (dashboard, mis-tickets, login, perfil, admin)
  style.css            — estilos globales
portales/
  *.json               — configuración de portales (selectores, flujo, notas)
```

## Flujo principal (server.js)

1. **POST /api/tickets/subir** — usuario sube imagen del ticket
2. **Pasada 1 (Haiku)** — detecta portal: `oxxo | arco | gasmaz | farmaciaguadalajara | desconocido`
   - Fallback por URL del QR
   - Fallback por nombre del comercio (solo "oxxo" por nombre)
3. **Pasada 2 (Sonnet)** — extrae datos con prompt específico por portal
4. Guarda ticket en BD con status `pendiente_confirmacion`
5. **POST /api/tickets/:id/confirmar** — usuario confirma/corrige datos OCR
   - Merge genérico: `{ ...datosActuales, ...datosNuevos }`
6. **POST /api/tickets/:id/facturar** — lanza el bot del portal correspondiente
7. Bot retorna `{ ok, xmlUrl, pdfUrl }` o `{ ok, procesandoCorreo: true }`
8. Si `procesandoCorreo`: job IMAP espera el correo con los archivos adjuntos

## Estructura de un bot (patrón estándar)

```js
async function facturarXXX({ rfc, razonSocial, regimenFiscal, usoCfdi, ...camposEspecificos, ticketId }) {
  // 1. Conectar a Browserless con stealth=true
  // 2. Navegar al portal
  // 3. Llenar campos (helpers: fillInput, selectByText)
  // 4. Screenshots en cada paso → subirArchivoR2(buf, `debug/xxx_paso_${Date.now()}.png`, "image/png")
  // 5. Detectar confirmación o error
  // 6. Intentar descarga directa XML/PDF → subirArchivoR2
  // 7. Si falla descarga: return { ok: true, procesandoCorreo: true }
  // 8. En catch: screenshot de error, browser.close(), return { ok: false, msg }
}
module.exports = { facturarXXX };
```

**Retorno estándar:**
```js
{ ok: true, xmlUrl: "https://...", pdfUrl: "https://..." }  // éxito con archivos
{ ok: true, procesandoCorreo: true }                        // éxito, IMAP recogerá archivos
{ ok: false, msg: "descripción del error" }                 // fallo
```

## Helpers reutilizables en bots

```js
// Llenar input con teclado real (evita problemas con Angular/React)
async function fillInput(page, selector, value) {
  await page.click(selector);
  await page.keyboard.down("Control"); await page.keyboard.press("a"); await page.keyboard.up("Control");
  await page.keyboard.press("Delete");
  await page.keyboard.type(String(value), { delay: 60 });
}

// Seleccionar opción por texto (keywords parciales, case-insensitive)
async function selectByText(page, selector, keywords) {
  return await page.$eval(selector, (el, kws) => {
    const opt = Array.from(el.options).find(o => kws.some(k => o.text.toLowerCase().includes(k.toLowerCase())));
    if (!opt) return null;
    el.value = opt.value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return opt.text;
  }, keywords);
}
```

## Registro de portales activos

| Portal | Bot | Estado | Comercios que lo usan |
|--------|-----|--------|----------------------|
| OXXO | oxxo.js | ✅ Producción | Cualquier OXXO (San Javier, Misiones, etc.) |
| BuzonFacturas | buzonfacturas.js | ✅ Producción | Gasolineras ARCO |
| NexusFuel/Gasmaz | gasmaz.js | ✅ Producción | Gasmaz, RedMax, otras gasolineras NexusFuel |
| Farmacias Guadalajara | farmaciaguadalajara.js | ⚠️ En desarrollo | Farmacias Guadalajara (portal Angular) |

## Notas críticas

- **Portal OXXO:** Usa PrimeFaces (JSF). Datepicker complejo, polling activo para razón social. Tiene fallback de reimpresión. No usa stealth.
- **BuzonFacturas:** Flujo multi-step con navegaciones reales. Tiene Estrategia B (recuperar factura ya generada). No usa stealth.
- **Gasmaz/NexusFuel:** Formulario de 2 pasos. Selects con carga AJAX (esperar `options.length > 1`). Descarga via `DownloadInvoice.aspx`. Usa `evaluateHandle().asElement().click()` para evitar Target closed. Usa stealth.
- **IMAP:** Busca correos de los últimos 60 min con `esCFDI()`. Timeout de 120s. Extrae XML/PDF incluyendo ZIPs.
- **R2:** Todos los archivos van a `facturas/` o `debug/`. URL pública via `R2_PUBLIC_URL`.
- **Confirmación:** El endpoint `/confirmar` hace merge genérico, preserva todos los campos previos.
