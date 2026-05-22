# portal-facturas — Contexto del proyecto

Sistema de facturación electrónica automática para conjuntos residenciales.
Residentes suben foto de ticket → OCR extrae datos → engine/bot factura en el portal del comercio.

**Directorio local:** `C:\Users\carlo\portal-facturas`
**Repo:** https://github.com/CARLOSGUERRA99/portal-facturas
**Deploy:** Railway — autodeploy desde `main`. Cada `git push origin main` despliega en ~2 min.

---

## Stack

- **Backend:** Node.js + Express, puerto 8080
- **Hosting:** Railway (Linux, Node 18)
- **Browser automation:** Puppeteer → Browserless `wss://production-sfo.browserless.io?token=TOKEN&stealth=true`
- **IA:** Anthropic SDK — Sonnet para detección y extracción OCR (2 pasadas)
- **Storage:** Cloudflare R2 (`storage/r2.js` → `subirArchivoR2(buffer, key, contentType)`)
- **Email:** IMAP + mailparser + unzipper (`mail/imap.js`)
- **BD:** MySQL Railway (`db.query`)
- **Templates:** Mustache.js (`{{variable}}`) — usado en flow.json del engine

## Variables de entorno (solo en Railway, nunca en código)

```
BROWSERLESS_TOKEN   ANTHROPIC_API_KEY   SESSION_SECRET
SMTP_HOST/PORT/SECURE/USER/PASS         IMAP_HOST/PORT/USER/PASS
R2_ACCESS_KEY / R2_SECRET_KEY / R2_ENDPOINT / R2_BUCKET / R2_PUBLIC_URL
DB_HOST / DB_USER / DB_PASSWORD / DB_PORT / DB_DATABASE
PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true   MANTENIMIENTO=false
```

Correo de captura de facturas: `buzonfacturas@serviciosga.site`

---

## Árbol de archivos

```
server.js                  — servidor principal, OCR pipeline, endpoints
bots/
  index.js                 — router: engine-first → fallback legacy
  gasmaz.js                — ✅ bot legacy NexusFuel (fallback del engine)
  oxxo.js                  — ✅ bot OXXO
  buzonfacturas.js         — ✅ bot ARCO/BuzonFacturas
  homedepot.js             — ✅ bot Home Depot
  rendichicasestacionpirusadecv.js — ✅ bot Rendichicas
  farmaciaguadalajara.js   — ⚠️ en desarrollo

engine/                    — motor declarativo (NO tocar sin entender el contrato)
  index.js                 — entry point: facturarConEngine(), tieneEngine()
  runner.js                — ejecutor de flow.json, buildContext(), validateContext()
  browser.js               — abre Browserless o LOCAL_BROWSER
  actions/
    goto.js / fill.js / click.js / waitFor.js / screenshot.js

commerce/                  — un directorio por portal migrado al engine
  gasmaz/                  — gasmazfactura.nexusfuel.mx
    config.json            — url_base, dominio, stealth, defaults, cfdi_keywords
    selectors.json         — mapa nombre→selector CSS
    flow.json              — 25 pasos declarativos con {{variables}} Mustache
    hooks.js               — lógica compleja que no cabe en JSON
  ramsa/                   — redmaxfactura.nexusfuel.mx (mismo mecanismo que gasmaz)
    config.json / selectors.json / flow.json / hooks.js

mail/
  imap.js                  — recibe XML/PDF por correo
storage/
  r2.js                    — sube/borra archivos R2
public/
  mantenimiento.html       — página de mantenimiento (activar con MANTENIMIENTO=true)
  *.html                   — frontend (dashboard, mis-tickets, login, perfil, admin)
scripts/                   — herramientas de validación local (no van a producción lógicamente)
  test-gasmaz.js           — test end-to-end del engine con ticket real
  validate-r2.js           — valida que R2 sube, es público, y borra correctamente
  validate-selectors-gasmaz.js — abre el portal real y verifica que existen los 13 selectores
mcp-server/
  index.js                 — servidor MCP (Railway) con tools para Claude Code
```

---

## Arquitectura: Engine Declarativo

El engine es la arquitectura nueva. Los bots legacy siguen intactos como fallback.

### Cómo funciona

1. `bots/index.js` determina `enginePortal` (ver Routing abajo)
2. Si `tieneEngine(enginePortal)` → llama `facturarConEngine(enginePortal, datos)`
3. `engine/index.js` carga `commerce/{portal}/config.json`, `selectors.json`, `flow.json`, `hooks.js`
4. `runner.js` ejecuta `buildContext()` → `validateContext()` → steps del flow.json
5. Cada step usa un action de `engine/actions/`; los hooks llaman funciones de `hooks.js`
6. Si hay excepción → `[ENGINE FALLBACK]` → cae al bot legacy

### buildContext() — variables disponibles en flow.json

```
{{url}}            — portalUrl del ticket si matchea dominio, si no url_base del config
{{portal}}         — id del portal (gasmaz, ramsa, etc.)
{{ticketId}}       — id del ticket en BD
{{rfc}}            — RFC del cliente
{{razonSocial}}    — razón social
{{regimenFiscal}}  — régimen (ej. "601") — usa default del config si no viene en payload
{{usoCfdi}}        — uso CFDI (ej. "G03")
{{folio}}          — folio del ticket
{{referencia}}     — referencia del ticket (si no hay, usa folio)
{{total}}          — total como string
{{totalDecimal}}   — total con exactamente 2 decimales (ej. "908.19")
{{fecha}}          — fecha YYYY-MM-DD
{{fechaDMY}}       — fecha DD/MM/YYYY
{{email}}          — datos_fijos.email del config
{{selectors.xxx}}  — cualquier selector de selectors.json
```

### RunnerResult — único contrato de retorno del engine

```js
{ ok: true,  xmlUrl: "https://...", pdfUrl: "https://..." }  // éxito con archivos
{ ok: true,  procesandoCorreo: true }                        // factura generada, IMAP recogerá
{ ok: false, error_code: "...", msg: "..." }                 // error controlado
```

### error_code enum

| Código | Cuándo ocurre |
|---|---|
| `timeout` | waitFor o waitForAny excedió el tiempo límite |
| `ya_facturado` | el portal detectó que el folio ya tiene factura |
| `datos_invalidos` | el portal rechazó los datos (RFC, folio, total incorrecto) |
| `captcha` | el portal bloqueó con CAPTCHA |
| `portal_caido` | DNS o HTTP falló al navegar |
| `descarga_fallida` | la factura se generó pero no se pudo descargar |
| `hook_error` | excepción en una función de hooks.js |
| `desconocido` | cualquier otro error no clasificado |

### Logs de Railway — cómo identificar qué corrió

```
[ENGINE][ramsa] Iniciando engine declarativo...        ← engine arrancó
[ENGINE][ramsa] Resultado: ✅ OK                       ← engine terminó bien
[ENGINE][ramsa] Resultado: ❌ ya_facturado             ← error controlado del engine
[ENGINE FALLBACK][ramsa] Excepción no controlada: ... ← bug → cayó a legacy
[ENGINE FALLBACK][ramsa] Stack: TypeError: ...
[LEGACY][gasmaz] Ejecutando bot legacy NexusFuel/Gasmaz ← legacy corriendo
```

Screenshots de debug subidos automáticamente a R2: `debug/{portal}_{ticketId}_ERROR_step{N}_{action}_{ts}.png`

---

## Routing: cómo se decide qué engine usar

En `bots/index.js` (inicio de `detectarYFacturar`):

```js
// NexusFuel tiene dos subportales según el URL del ticket
let enginePortal = portal;
if (portal === 'gasmaz' || portalUrl.includes('nexusfuel') || portalUrl.includes('redmaxfactura')) {
  enginePortal = portalUrl.includes('redmaxfactura') ? 'ramsa' : 'gasmaz';
}
// Si tieneEngine(enginePortal) → engine; si excepción → legacy; si ok:false → retorna directo
```

| portalUrl del ticket | enginePortal | commerce/ usado |
|---|---|---|
| `redmaxfactura.nexusfuel.mx` | `ramsa` | `commerce/ramsa/` |
| `gasmazfactura.nexusfuel.mx` | `gasmaz` | `commerce/gasmaz/` |
| portal=oxxo | no tiene engine aún | `bots/oxxo.js` (legacy) |

---

## Agregar un nuevo portal al engine

1. Crear `commerce/{id}/` con 4 archivos: `config.json`, `selectors.json`, `flow.json`, `hooks.js`
2. Copiar `commerce/ramsa/` como plantilla si es NexusFuel; si es distinto, diseñar flow desde cero
3. Si el portal tiene variantes por URL, agregar condición de routing en `bots/index.js`
4. Validar localmente: `node scripts/validate-selectors-{id}.js` (crea uno nuevo copiando el de gasmaz)
5. Commit → push → Railway despliega → probar con ticket real

**NO es necesario** tocar `engine/runner.js` ni las actions para un portal nuevo. Solo `commerce/`.

---

## Flujo principal (server.js)

1. `POST /api/tickets/subir` — usuario sube imagen
2. **Pasada 1 (Sonnet)** — detecta portal: `oxxo | arco | gasmaz | farmaciaguadalajara | desconocido`
3. **Pasada 2 (Sonnet)** — extrae datos con prompt específico por portal
4. Guarda ticket en BD con status `pendiente_confirmacion`
5. `POST /api/tickets/:id/confirmar` — usuario confirma/corrige datos (merge genérico)
6. `POST /api/tickets/:id/facturar` → `bots/index.js` → engine o legacy
7. Engine/bot retorna RunnerResult
8. Si `procesandoCorreo`: job IMAP espera correo con XML/PDF

---

## Portales y estado actual

| Portal | Mecanismo | Estado | Comercios |
|---|---|---|---|
| RAMSA / RedMax | Engine `ramsa` | ✅ En validación | RAMSA del Yaqui y otras gasolineras RedMax |
| Gasmaz | Engine `gasmaz` | ✅ Listo (pendiente test) | Gasolineras Gasmaz |
| OXXO | Legacy `oxxo.js` | ✅ Producción | Cualquier OXXO |
| ARCO / BuzonFacturas | Legacy `buzonfacturas.js` | ✅ Producción | Gasolineras ARCO |
| Home Depot | Legacy `homedepot.js` | ✅ Producción | Home Depot México |
| Rendichicas | Legacy `rendichicasestacionpirusadecv.js` | ✅ Producción | Estación Piru |
| Farmacias Guadalajara | Legacy `farmaciaguadalajara.js` | ⚠️ En desarrollo | Farmacias Guadalajara |

**Próximos portales a migrar al engine:** Rendichicas → OXXO → ARCO (en ese orden de complejidad)

---

## Notas críticas por portal

- **RAMSA/Gasmaz (NexusFuel):** Formulario 2 pasos. Selects con carga AJAX — esperar `options.length > 1` antes de seleccionar CFDI. Descarga via `DownloadInvoice.aspx`. Click en "Facturar" se hace por texto con `evaluateHandle` (evita Target closed). Usa stealth. R2 keys: `facturas/ramsa_*.xml` / `facturas/gasmaz_*.xml`
- **OXXO:** PrimeFaces (JSF). Datepicker complejo, polling para razón social. Fallback de reimpresión. Sin stealth.
- **BuzonFacturas:** Multi-step con navegaciones reales. Estrategia B (recuperar factura existente). Sin stealth.
- **IMAP:** Busca correos últimos 60 min con `esCFDI()`. Timeout 120s. Extrae XML/PDF incluyendo ZIPs.
- **R2:** `facturas/` para documentos finales, `debug/` para screenshots. URL pública via `R2_PUBLIC_URL`.
- **Mantenimiento:** `MANTENIMIENTO=true` en Railway bloquea toda la app. Bypass: `?bypass=gpnadmin`.

---

## Patrones del engine — fill strategies

El action `fill` soporta 4 estrategias para portales con frameworks distintos:

| strategy | Cuándo usar |
|---|---|
| `keyboard` (default) | Formularios HTML estándar |
| `angular` | Angular 2+ (usa native setter via Object.getOwnPropertyDescriptor) |
| `angularjs` | AngularJS 1.x (click + delete + type + events) |
| `js` | Último recurso (asigna `.value` directo + dispara `change`) |

---

## MCP tools disponibles en Claude Code

Configurado en Claude Code con HTTP transport → `portal-facturas-mcp-production.up.railway.app`

| Tool | Qué hace |
|---|---|
| `estado_sistema` | Tickets por status, atascados, errores recientes, portales pendientes |
| `consultar_tickets` | Filtra tickets por status/comercio |
| `reprocesar_ticket` | Reactiva ticket atascado en procesando_correo |
| `logs_railway` | Últimas N líneas de logs con filtro opcional |
| `estado_r2` | Verifica conectividad R2 |
| `consultar_portales_pendientes` | Lista portales sin bot configurado |
