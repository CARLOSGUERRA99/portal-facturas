# portal-facturas — Contexto del proyecto

Sistema de facturación electrónica automática para conjuntos residenciales.
Residentes suben foto de ticket → OCR extrae datos → engine/bot factura en el portal del comercio.

**Directorio local:** `C:\Users\carlo\portal-facturas`
**Repo:** https://github.com/CARLOSGUERRA99/portal-facturas
**Deploy:** Railway — autodeploy desde `main`. Cada `git push origin main` despliega (hoy tardó 3–10 min; normalmente ~2 min).
**App en producción:** https://portal-facturas-production.up.railway.app

---

## Stack

- **Backend:** Node.js 18 + Express, puerto 8080
- **Hosting:** Railway (Linux). ⚠️ **Railway BLOQUEA el SMTP saliente** (puertos 25/465/587/2525 → ETIMEDOUT). NO bloquea IMAP (993) ni HTTPS (443).
- **Browser automation:** Puppeteer → Browserless `wss://production-sfo.browserless.io?token=TOKEN&stealth=true` (OXXO sin stealth)
- **IA:** Anthropic SDK — modelo `claude-sonnet-4-6` (detección/OCR/agentes)
- **Storage:** Cloudflare R2 (`storage/r2.js` → `subirArchivoR2(buffer, key, contentType)`)
- **Correo SALIENTE:** **Brevo HTTP API** (`enviarCorreo()` en server.js) — porque Railway bloquea SMTP. NO usar nodemailer/SMTP en producción.
- **Correo ENTRANTE (captura facturas):** IMAP (`mail/imap.js`) — funciona en Railway.
- **CAPTCHA:** CapSolver (`ImageToTextTask`) para portales con captcha de imagen (7-Eleven).
- **BD:** MySQL Railway (`db.query`)

## Variables de entorno (solo en Railway, nunca en código)

```
BROWSERLESS_TOKEN   ANTHROPIC_API_KEY   SESSION_SECRET
BREVO_API_KEY              ← correo saliente por HTTP (Railway bloquea SMTP)
CAPSOLVER_API_KEY          ← resolver captchas (7-Eleven)
SMTP_HOST/PORT/SECURE/USER/PASS   ← legacy, en standby (Railway los bloquea)
IMAP_HOST/PORT/USER/PASS          ← recepción de facturas (sí funciona)
R2_ACCESS_KEY / R2_SECRET_KEY / R2_ENDPOINT / R2_BUCKET / R2_PUBLIC_URL
DB_HOST / DB_USER / DB_PASSWORD / DB_PORT / DB_DATABASE
PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true   MANTENIMIENTO=false
```

Correo de captura de facturas: `buzonfacturas@serviciosga.site`
Remitente Brevo verificado: `buzonfacturas@serviciosga.site` (DNS DKIM brevo1/brevo2 puestos; falta terminar DMARC+SPF para entregabilidad óptima).

---

## Correo: Brevo HTTP API (CRÍTICO)

Railway bloquea SMTP saliente, así que TODO el correo del sistema sale por la **API HTTP de Brevo** vía `enviarCorreo(mailOptions)` en server.js (POST a `https://api.brevo.com/v3/smtp/email` con header `api-key`). El `transporter` de nodemailer queda en standby (solo se usa si NO hay `BREVO_API_KEY`).

- Endpoint de salud: `GET /api/diag-mail` → `{brevoKeySet, brevoKeyValid, brevoStatus, imap:{ok,ms}}`
- Para ver correos enviados: **Brevo → Transactional → Logs** (NO aparecen en "Enviados" de Hostinger).

---

## Árbol de archivos

```
server.js                  — servidor principal, OCR pipeline, endpoints, enviarCorreo (Brevo)
bots/
  index.js                 — router: engine-first → legacy → bot dinámico (slug)
  oxxo.js / buzonfacturas.js / gasmaz.js / homedepot.js
  rendichicasestacionpirusadecv.js / benavides.js / panama.js / farmaciaguadalajara.js
  carljr.js                — ✅ Carl's Jr (ICR/RetailEDX). Maneja modal "ya generada" → #txt_dcorreopet/#btn_denviarpet
  sushito.js               — ✅ SushiO/mefacturo (SoftRestaurant). Botón Facturar es <a id="btn_facturar">. Detecta vencido
  autozone.js              — ✅ AutoZone (origon.cloud, Angular). Usa el CÓDIGO DE BARRAS, no el folio corto
  dana.js                  — ✅ Dana Comida Mexicana (SoftRestaurant variante: #unicCode/#folio/#RFC)
  tufesa.js                — ✅ TUFESA (form ASP.NET en iframe: ventas.tufesa.com.mx). Boletos de viaje + origen
  7elevenmexicosadecv.js   — ⚠️ 7-Eleven (Angular). CAPTCHA vía CapSolver. EN PRUEBA (session-close al type)
agentes/
  orquestador.js           — flujo analizar→generar→validar→[corregir×2]→pendiente_aprobacion. activarBot, restaurarBotsDinamicos
  analizador.js            — recorrido INTERACTIVO: sigue iframes, maneja <select>, incluye <a>, llena con datos reales, multi-paso
  generador.js             — escribe el bot (max_tokens 20k + anti-truncado + vm.Script)
  validador.js             — sintaxis (vm.Script) + prueba EN VIVO; marca error si {ok:false} sin error_code controlado
  corrector.js             — auto-arregla con feedback de la prueba en vivo (Sonnet, max_tokens 20k)
engine/                    — motor declarativo (commerce/{portal}/config|selectors|flow.json+hooks.js)
  actions/ (goto,fill,click,waitFor,screenshot) + runner.js + browser.js
commerce/oxxo/, gasmaz/, ramsa/  — portales migrados al engine (OXXO usa engine con hooks.js)
mail/imap.js               — recibe XML/PDF por correo (esCFDI reconoce retailedx, mefacturo, etc.)
storage/r2.js
public/*.html              — frontend (mis-tickets, dashboard, admin, perfil)
scripts/                   — herramientas de prueba/sondeo local (test-*, probe-*, verif-*, leer-docx)
```

---

## Portales y estado actual

| Portal | Bot/Mecanismo | Estado |
|---|---|---|
| OXXO | engine `commerce/oxxo` + hooks | ✅ Producción (verificado) |
| ARCO / BuzonFacturas | `buzonfacturas.js` | ✅ Producción |
| Gasmaz / RAMSA | engine | ✅ Validación |
| Home Depot | `homedepot.js` | ✅ Producción |
| Rendichicas | `rendichicas...js` | ✅ Producción |
| Carl's Jr (ICR) | `carljr.js` | ✅ Verificado (incl. "ya generada"→correo) |
| SushiO/El Caporal/Allegro | `sushito.js` | ✅ Verificado (vencido→ventana correo) |
| **AutoZone** | `autozone.js` | ✅ Alta hoy (OCR código de barras) |
| **Dana Comida Mexicana** | `dana.js` | ✅ Alta hoy (verificado en vivo) |
| **TUFESA** | `tufesa.js` | ✅ Alta hoy (verificado en vivo) |
| **7-Eleven** | `7elevenmexicosadecv.js` | ✅ Verificado en vivo. CapSolver + dialog handler + recupera CFDI ya facturado |
| KFC (PRB) | — | ⏸️ Portal `facturacion.prb.com.mx:444` en MANTENIMIENTO |
| Farmacias Guadalajara | `farmaciaguadalajara.js` | ⚠️ Datos (folio factura) |

---

## Flujo principal (server.js)

1. `POST /upload-ticket` — sube imagen. **La imagen se guarda en R2** (`tickets/`) y la URL queda en `ruta_archivo` (disco de Railway es efímero).
2. **Pasada 1 (Sonnet)** detecta portal; **Pasada 2 (Sonnet)** extrae datos con prompt por portal (`promptsPorPortal`, fallback `desconocido`).
3. Ticket en BD; `procesarCola` (30s) lo factura si pasa el gate (incluye autozone/origon/mefacturo/sushio/softrestaurant/tufesa/analytix360).
4. `bots/index.js` enruta → engine o bot legacy o bot dinámico (slug del comercio).
5. RunnerResult: `{ok:true,xmlUrl,pdfUrl}` | `{ok:true,procesandoCorreo:true}` (IMAP) | `{ok:false,error_code,msg}`.

### error_code → manejo en ejecutarFacturacion
- `ticket_vencido` → status error, para reintentos, guarda email_contacto, habilita ventana "Solicitar por correo".
- `captcha` → status error, para reintentos, notifica "facturar manualmente". (Usado si el captcha NO se puede resolver.)
- `ya_facturado` / `datos_invalidos` → error controlado.
- otros → error genérico con reintento a medianoche.

---

## OCR — notas por portal (promptsPorPortal en server.js)

- **OXXO:** folio + idVenta (formato 2díg+3LETRAS+2díg+3alfanum+1díg) + corrección de año.
- **AutoZone:** el folio es el **NÚMERO LARGO BAJO EL CÓDIGO DE BARRAS**, no el folio corto.
- **7-Eleven:** el folio es el código de barras de **EXACTAMENTE 35 dígitos** (el portal rechaza si son menos).
- **SoftRestaurant (SushiO/Dana):** `referencia` = código de facturación (distinto del folio).
- **TUFESA:** captura `origen` (ciudad de origen del boleto).
- Año mal leído se corrige con `corregirAnioReciente` en Pasada 2.

---

## Solicitud de factura por correo (tickets vencidos / manuales)

Ventana en Mis Tickets (modal): correo del comercio (pre-cargado de `email_contacto`) + **Forma de pago (Efectivo/Tarjeta)** + Uso CFDI fijo "Gastos en general (G03)". `POST /api/tickets/:id/solicitar-correo` con `{email, formaPago}` → `enviarSolicitudPorCorreo` arma el correo (adjunta **constancia + imagen del ticket** desde R2) y lo manda por Brevo.

---

## Motor de agentes (alta automática de portales nuevos)

Cuando llega un ticket de portal desconocido → `orquestador.orquestar()`:
1. **analizador** carga el portal, **sigue el iframe del form real** si existe (TUFESA/KFC), **selecciona opciones de `<select>`** que revelan campos, llena con datos reales del ticket, avanza por pasos (incluye `<a>`/FACTURA EXPRESS/Iniciar), captura DOM+screenshots de cada pantalla.
2. **generador** escribe el bot con selectores reales.
3. **validador** lo corre EN VIVO; si crashea o devuelve `{ok:false}` SIN error_code controlado → lo marca roto.
4. **corrector** (hasta 2 veces) lo arregla con el error + screenshots.
5. Queda en `pendiente_aprobacion` → Admin lo aprueba → `activarBot` (escribe a disco + DB `portales_agente`).

⚠️ **Límite real:** portales con CAPTCHA o que requieren ticket válido para revelar pasos finales necesitan ajuste manual. El alta 100% autónoma no aplica a todos.
⚠️ `portales.json` puede corromperse por escrituras concurrentes en disco efímero (no rompe routing — usa DB/disco; se restaura en deploy).

---

## Pendientes / dónde nos quedamos (última sesión)

1. **7-Eleven:** ✅ RESUELTO. Causa raíz era `$window.alert()` de AngularJS sin `page.on('dialog')` → el alert colgaba el hilo y Browserless mataba la pestaña (daba "Session closed"/"main frame too early"/"Target closed", todos el mismo bug). Fix: dialog handler captura el mensaje y lo acepta; `clasificarAlert()` lo mapea a error_code. `addRow()` es AJAX (no navega); botón `type=submit ng-click` → cambiar a `type=button` antes de click. Si "ya facturado" → `recuperarFacturaExistente()` (conexión nueva, CONSULTA FACTURA → CONSULTAR → Descargar XML/PDF, captura bodies con `page.on('response')`, endpoints `findLastCfdi`/`descargaCfdiXml`/`descargaCfdiPdf`). Validado en vivo (#105, CFDI 4.0 Folio 12584). Falta: prueba con ticket NUEVO no facturado para ver el flujo CAPTCHA→FACTURAR completo. CAPTCHA: `img#Kaptcha` + `#captcha` + reload `img#reload`. ⚠️ `fetch()` directo en evaluate cuelga el target — usar clicks + response capture.
2. **KFC (PRB):** portal `facturacion.prb.com.mx:444` estaba en MANTENIMIENTO. Reintentar cuando vuelva.
3. **Little Caesars #89** (analytix360): bot truncado viejo, falta re-alta limpia.
4. **DNS Brevo:** terminar DMARC (`v=DMARC1; p=none; rua=mailto:rua@dmarc.brevo.com`) + SPF (`include:spf.brevo.com`) para entregabilidad.
5. **Limpieza:** quitar endpoints temporales `/api/diag-mail` y `/api/diag-smtp`; `portales.json` escritura atómica.

---

## MCP tools disponibles en Claude Code

`estado_sistema`, `consultar_tickets`, `reprocesar_ticket`, `logs_railway`, `estado_r2`, `consultar_portales_pendientes`, `resetear_ticket` → `portal-facturas-mcp-production.up.railway.app`
