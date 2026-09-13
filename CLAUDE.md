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
- **CAPTCHA:** CapSolver, tres tipos de tarea y conviene no confundirlos:
  - `ImageToTextTask` — captcha de imagen. **Síncrono**: `createTask` ya devuelve `solution.text`; hacer polling da `ERROR_TASK_NOT_FOUND`. En `lib/capsolver.js` y en 7-Eleven.
  - `ReCaptchaV2TaskProxyLess` — **reCAPTCHA v2, SÍ se resuelve** (`bots/littlecaesars.js:47-95`, y con `isInvisible:true` en `youbuy.js`). **Asíncrono**: devuelve `taskId` y hay que sondear `getTaskResult` hasta `ready`; tarda 10-40 s. El token se deposita en `#g-recaptcha-response` y se invoca el callback.
  - `AntiTurnstileTaskProxyLess` — Cloudflare Turnstile (Home Depot, Wansoft).
- **BD:** MySQL Railway (`db.query`)

## Variables de entorno (solo en Railway, nunca en código)

```
BROWSERLESS_TOKEN   ANTHROPIC_API_KEY   SESSION_SECRET
BREVO_API_KEY              ← correo saliente por HTTP (Railway bloquea SMTP)
CAPSOLVER_API_KEY          ← resolver captchas: imagen, reCAPTCHA v2 y Turnstile
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
  carljr.js                — ✅ Carl's Jr (ICR). ⚠️ Portal NUEVO desde ago-2026: Egrid
                             (egridhub.com:6027/icr/autofactura, Next.js + shadcn). Ya NO es RetailEDX.
                             Captura el PDF/XML hookeando el <a download> del blob
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
| Carl's Jr (ICR) | `carljr.js` | ✅ Reescrito 29-ago-2026 para el portal Egrid (tickets #206 y #273 timbrados en vivo) |
| SushiO/El Caporal/Allegro | `sushito.js` | ✅ Verificado (vencido→ventana correo) |
| **AutoZone** | `autozone.js` | ✅ Alta hoy (OCR código de barras) |
| **Dana Comida Mexicana** | `dana.js` | ✅ Alta hoy (verificado en vivo) |
| **TUFESA** | `tufesa.js` | ✅ Alta hoy (verificado en vivo) |
| **7-Eleven** | `7elevenmexicosadecv.js` | ✅ Verificado en vivo. CapSolver + dialog handler + recupera CFDI ya facturado |
| **Little Caesars** | `littlecaesars.js` | 🔶 CapSolver reCAPTCHA v2 integrado (15/08) y **el solver SÍ corrió en vivo** — así se descubrió `/lc/validar/`, que está detrás del captcha, y el commit 981f418 dice "ticket #218 facturado en producción". Lo que sigue sin confirmar es el ENVÍO del paso 2 fiscal con este código. ⚠️ La cabecera del bot aún dice "el CAPTCHA lo resuelve SIEMPRE una persona": está obsoleta. ⚠️ `docs/auditoria-2026-09-13.md:812` lo marca CRÍTICO por riesgo de doble timbrado |
| **OXXO GAS** | `oxxogas.js` | 🔶 Hoy depende de una cookie de sesión puesta a mano (`scripts/oxxogas-sesion.js`), y sin ella todo ticket acaba en error. **Automatizarlo está APROBADO** (Carlos, 13-sep-2026): su login lleva reCAPTCHA v2, que este repo ya resuelve. Falta escribirlo — ver abajo |
| KFC (PRB) | — | ⏸️ Portal `facturacion.prb.com.mx:444` en MANTENIMIENTO |
| Farmacias Guadalajara | `farmaciaguadalajara.js` | ⚠️ Datos (folio factura) |

---

## Flujo principal (server.js)

1. `POST /upload-ticket` — sube imagen. **La imagen se guarda en R2** (`tickets/`) y la URL queda en `ruta_archivo` (disco de Railway es efímero).
2. **Pasada 1 (Sonnet)** detecta portal; **Pasada 2 (Sonnet)** extrae datos con prompt por portal (`promptsPorPortal`, fallback `desconocido`).
3. Ticket en BD; `procesarCola` (30s, máx 2 concurrentes) lo factura si `requiere_confirmacion=0` y pasa el gate de portales (oxxo/arco/gasmaz/homedepot/rendichicas/.../autozone/7eleven + por portal_url para desconocidos). Anti-duplicados rechaza antes de insertar.
4. `bots/index.js` enruta → engine o bot legacy o bot dinámico (slug del comercio).
5. RunnerResult: `{ok:true,xmlUrl,pdfUrl}` | `{ok:true,procesandoCorreo:true}` (IMAP) | `{ok:false,error_code,msg}`.

### error_code → manejo en ejecutarFacturacion
- `ticket_vencido` → status error, para reintentos, guarda email_contacto, habilita ventana "Solicitar por correo".
- `captcha` → status error, para reintentos, notifica "facturar manualmente". (Usado si el captcha NO se puede resolver.)
- `ya_facturado` / `datos_invalidos` → error controlado.
- otros → error genérico con reintento a medianoche.

---

## OCR — 3 pasadas, en `lib/vision.js` (ya NO en server.js)

Medido con `node scripts/evaluar-ocr.js`: **98.5% de campos, 23/24 tickets**.
El banco corre el pipeline real sobre 24 fotos que fallaron en producción y
avisa si un cambio empeora. `GUARDAR=1` fija una nueva línea base. **Antes de
tocar un prompt, correr el banco; después, volver a correrlo.**

- **Pasada 1** — detecta el portal. Su prompt se ARMA SOLO desde
  `portales/portales.json`. Un portal que no esté ahí **nunca** usa su prompt
  especializado, por muy bien escrito que esté: sale `desconocido` y corre el
  genérico. Para desambiguar pistas que se solapan (OXXO vs OXXO GAS) está
  `deteccion.nota_deteccion`.
- **Pasada 2** — extrae con `promptsPorPortal[portal]`.
- **Pasada 3** — `releerCamposDudosos()`: relee la misma foto preguntando SOLO
  por los campos obligatorios que quedaron nulos o dudosos, obligando a
  deletrearlos. Solo se dispara si la Pasada 2 admitió duda.

⚠️ `extraerJson()` en vez de `JSON.parse()` en las tres. Un `JSON.parse` directo
revienta si el modelo escribe una palabra antes del JSON y tira TODOS los datos
del ticket. Era la causa real de los tickets que "no extraían nada".

**Cuando dos números parecen "el folio", casi siempre vale el otro:**
- **NetPay (Enerser / Enerfueltech):** la `Referencia:` del PIE, no el `Folio:`
  con guiones de la terminal bancaria. La Referencia es
  estación(5)+nºticket+verificador(4), así que `repararReferenciaNetPay()` la
  reconstruye cruzándola con el `Ticket:` impreso aparte.
- **NexusFuel (gasmaz / gashr / petrofigues):** folio = el `Ticket:`; la
  `Referencia para facturar` es el número de estación.
- **IGasFac:** el Folioweb largo (4-8-8 con guiones) de abajo, no el `Folio:`
  corto de arriba.
- **AutoZone:** el número largo bajo el código de barras.
- **7-Eleven:** código de barras de **exactamente 35 dígitos**.
- **OXXO GAS** no es OXXO: otro portal, otro prompt.
- **SoftRestaurant (SushiO/Dana):** `referencia` = código de facturación.
- **TUFESA:** captura `origen`.

`ticketsEnFoto > 1` fuerza `requiereConfirmacion`: la foto trae varias compras y
solo se registra la primera, así que alguien tiene que subir el resto. El
voucher del banco o la "COPIA CLIENTE" de la MISMA venta no cuentan.

Año mal leído: `corregirAnioReciente`, aplicado tras la Pasada 2 **y** tras la 3.

### Dar de alta un portal: hay que tocar CUATRO sitios
`bots/`, el routing de `bots/index.js`, el gate de `procesarCola` **y
`portales/portales.json`**. Olvidar el cuarto no rompe nada al arrancar — el bot
simplemente nunca recibe los datos bien leídos.

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

⚠️ **Límite real:** el alta 100% autónoma no aplica a todos — los portales que solo revelan los pasos finales con un ticket válido necesitan ajuste manual.

⚠️ **El CAPTCHA ya NO es ese límite, y la documentación vieja de este repo decía lo contrario.**
Desde el 15-ago-2026 hay resolutor de reCAPTCHA v2 (`ReCaptchaV2TaskProxyLess`) y de Turnstile,
además del de imagen. Si encuentras un comentario que diga que un captcha "no se resuelve",
comprueba la fecha antes de creértelo: varios quedaron sin actualizar.

**No hay portales "bloqueados", hay tipos sin proveedor configurado.** El registro vivo está en
`lib/captcha.js` → `SOLVERS`, y es por TIPO y por PROVEEDOR a propósito: CapSolver no es bueno
en todo. En el captcha de **texto sensible a mayúsculas** (QualliGas, consulta de Parisina) va
0/14 y 0/4 — acierta los caracteres y falla la caja. Ese hueco se llena enchufando OTRO
proveedor en `SOLVERS['imagen_may']`, no insistiendo con este; en cuanto se configure, el resto
del sistema se entera solo (el agente de altas y el reintento de `lib/facturacion.js` consultan
ese mapa).
⚠️ `portales.json` puede corromperse por escrituras concurrentes en disco efímero (no rompe routing — usa DB/disco; se restaura en deploy).

---

## ✅ Hecho en la sesión del 31-may/1-jun (7-Eleven + anti-duplicados + fixes UI)

- **7-Eleven COMPLETO y verificado en vivo** (facturación nueva CFDI folio 12585 + recuperación). Detalles del flujo y selectores en `memory/project_puppeteer_lessons.md`. Resumen de los bugs resueltos:
  - `page.on('dialog')` obligatorio: el `$window.alert()` de AngularJS sin handler colgaba el hilo y Browserless mataba la pestaña (causa de "Session closed"/"main frame too early"/"Target closed"/"frame detached" — todos el mismo bug).
  - OCR: clave de portal `7eleven` con prompt dedicado (folio de 35 dígitos), detección por comercio/URL + normalización de variantes; gate de procesarCola incluye `7eleven`; routing explícito en `bots/index.js`.
  - CapSolver `ImageToTextTask` es **síncrono** (solución en `createTask`, NO hacer polling). `module:"common"`.
  - Forma de Pago: modo TARJETA (`<select #formaPago>` 28=débito) vs EFECTIVO (`#formaPagoAux`).
  - Botón FACTURAR es `type=submit` sin ng-click → NO cambiar type. Tras FACTURAR → modal "CONFIRMAR DATOS" → pulsar CONTINUAR. Timbrado ~30s, detectar éxito por texto "CFDI generado". Timeout ≥50s.
  - Estrategia IMAP 7-Eleven en server.js: si cae en `procesando_correo`, recupera el CFDI del portal (`recuperarFacturaExistente`).
- **Anti-duplicados** (server.js, POST /upload-ticket): rechaza ticket del mismo comercio+folio (folio/codigoTicket/referencia/idFacturacion/folioFactura/idVenta) ya registrado (status != error) → `{ok:false, duplicado:true, msg}`.
- **Fixes UI (`public/mis-tickets.html`):** "Error de conexión al guardar" al editar datos era `facturar(editarTicketId)` llamado tras `cerrarModal()` (que pone editarTicketId=null) → ahora se captura `tid` antes; `facturar()` con guardas null; `res.json()` con `.catch`. DELETE + canDelete permiten `procesando_correo`.
- **Endpoint admin `/api/admin/tickets/:id/resetear`** ahora pone `requiere_confirmacion=0` (para que la cola lo retome).

## Pendientes / dónde seguir

0. **OXXO GAS — automatizar el login (APROBADO por Carlos el 13-sep-2026).**
   Queda **derogada** la regla que había en `bots/oxxogas.js` ("no se resuelve el reCAPTCHA v2
   del login bajo ninguna circunstancia"): se escribió cuando el repo no sabía resolver v2, y
   desde el 15-ago sí sabe. El formulario de facturación **no tiene captcha**; el único
   obstáculo es entrar. Orden de trabajo:
   1. **Recon del login** con `scripts/investigar-oxxogas-sesion.js`, anotando `name`/`id` de
      usuario y contraseña, el `data-sitekey` del `.g-recaptcha`, si hay hidden CSRF de
      CodeIgniter y qué devuelve el POST (302 vs JSON).
   2. **Extraer `resolverRecaptchaV2` a `lib/capsolver.js`** en vez de copiarlo: hoy vive
      duplicado en `littlecaesars.js` y `youbuy.js`. ⚠️ Es asíncrono (polling), no como el de
      imagen. **No tocar `littlecaesars.js` al extraerlo** — está marcado CRÍTICO en la auditoría.
   3. **`iniciarSesion(page)`** en `oxxogas.js`: `OXXOGAS_USER` / `OXXOGAS_PASS` ya existen en
      `.env` y hoy no las lee nadie. Éxito = el mismo criterio que ya usa el bot (`/Hola/i`).
   4. **Guardar la sesión** en la tabla `config`, clave `oxxogas_sesion`, reutilizando el
      `INSERT … ON DUPLICATE KEY` de `scripts/oxxogas-sesion.js:106`. Sin esto se paga un
      captcha por ticket.
      🔴 **Cífrala primero.** `docs/auditoria-2026-09-13.md` marca esto como severidad alta:
      hoy esa cookie —una sesión autenticada del portal fiscal— se guarda **en claro**, y
      `lib/backup-db.js` vuelca **todas** las tablas a R2 cada 24 h, a un bucket público
      (sin listado, pero cualquier key adivinable se descarga). Automatizar el login mete
      además usuario y contraseña vivos en ese mismo circuito. Cifrar **antes** de ampliarlo,
      no después.
   5. **Reescribir los dos cortes** (`oxxogas.js:180` sin cookie y `:224` cookie muerta): en vez
      de devolver `error_code:'captcha'`, llamar al login; el `'captcha'` se reserva para cuando
      el login falle.

   ⚠️ **Tres cosas que NO cambian y condicionan el diseño:**
   - **El presupuesto de 60 s de Browserless.** Login + CapSolver (10-40 s) + facturación no
     caben en una sesión, y quedarse sin tiempo justo antes de timbrar es el peor sitio.
     El login va en su **propio script/cron** que solo renueva la cookie.
   - **La cuenta es compartida entre clientes.** Si el WAF (Incapsula) marca el login como
     automatizado, el bloqueo no afecta a un ticket sino a todos. Lo único verificado hasta hoy
     es que la cookie inyectada pasa el WAF — nunca que un login desde la IP de Browserless pase.
   - **No tocar la marca `timbradoDisparado`** (`oxxogas.js:216`, `:383`, `:470`). Existe porque
     ya hubo un doble CFDI; cualquier reintento nuevo tiene que respetarla.

1. **Rendimiento de facturación (el usuario reporta que tarda mucho):** medir y optimizar. 7-Eleven es el más lento (Browserless connect + form + sleep 5s CFDI + CapSolver + timbrado ~30s + recuperación con 2ª conexión). Ideas: reducir sleeps fijos por waits condicionales; reusar la sesión en vez de abrir 2ª conexión para recuperar; subir XML/PDF a R2 en paralelo. Revisar también límite de 2 concurrentes en `procesarCola`.
2. **Limpiar `portales_pendientes`:** tiene muchos duplicados de portales que YA tienen bot activo (Home Depot ×3, AutoZone ×2, Rendichicas ×4, TUFESA, SushiO, El Caporal, Allegro, Little Caesars). No rompe nada pero ensucia el panel admin. Hacer dedup / borrar los que ya tienen bot.
3. **Home Depot — descarga por correo:** el usuario reportó "error al descargar archivos" (Home Depot solo entrega por correo/IMAP). Revisar el flujo IMAP de Home Depot (matching del correo → XML/PDF). Portal con Cloudflare Turnstile (CapSolver lo resuelve).
4. **KFC (PRB):** portal `facturacion.prb.com.mx:444` estaba en MANTENIMIENTO. Reintentar cuando vuelva.
5. **Little Caesars #89** (analytix360): bot truncado viejo, falta re-alta limpia.
6. **DNS Brevo:** terminar DMARC (`v=DMARC1; p=none; rua=mailto:rua@dmarc.brevo.com`) + SPF (`include:spf.brevo.com`).
7. **Limpieza:** quitar endpoints temporales `/api/diag-mail` y `/api/diag-smtp`; `portales.json` escritura atómica.
8. **Debug local > Railway:** hay `.env` local con TODAS las credenciales → correr `node scripts/probe-*.js` da feedback en segundos contra el Browserless de producción. NO iterar a ciegas con `git push`.

---

## MCP tools disponibles en Claude Code

`estado_sistema`, `consultar_tickets`, `reprocesar_ticket`, `logs_railway`, `estado_r2`, `consultar_portales_pendientes`, `resetear_ticket` → `portal-facturas-mcp-production.up.railway.app`
