# portal-facturas — Referencia del sistema

**Actualizado:** 13-sep-2026, sobre el commit `9acaeda`.
**Qué es esto:** todo lo que hay que saber del sistema en un solo sitio — arquitectura, datos, contratos, catálogo de portales, trampas conocidas y operación. Documento de consulta, no de lectura seguida.

Documentos hermanos:
- `docs/auditoria-2026-09-13.md` — qué está roto y por qué.
- `docs/plan-de-mejoras.md` — qué hacer al respecto.

---

## 1. Qué hace el sistema

Un residente o capturista sube la **foto de un ticket de compra**. El sistema lee el ticket con IA, identifica en qué portal se factura ese comercio, entra al portal, rellena los datos fiscales del cliente y descarga (o recibe por correo) el **CFDI** — XML y PDF.

**Quién lo usa:** el portal es de **Servicios Administrativos G&A**, que lo vende a varios clientes. Cada cliente es un contribuyente distinto con su propio RFC. Un cliente puede tener varios logins (p. ej. GPN tiene capturistas).

Jerarquía real de cuentas:

| Cuenta | Rol | Alcance |
|---|---|---|
| `facturas@serviciosga.site` | dueño de la plataforma (G&A) | ve todos los clientes |
| `carlosguerra@grupogpn.com` | admin del cliente GPN | sólo lo de GPN |
| `*@grupogpn.com` | capturistas de GPN | lo de GPN |
| `trasladosdga@gmail.com` | cliente DGA | sólo lo suyo |

Los **residentes** son una dimensión de reparto interna del cliente (a quién se le imputa el gasto), no usuarios del sistema.

---

## 2. Stack y hosting

| Pieza | Tecnología |
|---|---|
| Backend | Node.js 18 + Express, puerto 8080 |
| Hosting | Railway (Linux). **Bloquea SMTP saliente** (25/465/587/2525). No bloquea IMAP (993) ni HTTPS |
| Automatización de navegador | Puppeteer → Browserless `wss://production-sfo.browserless.io` (OXXO sin `stealth`) |
| IA | Anthropic SDK — `claude-sonnet-4-6` para detección, extracción y agentes |
| Base de datos | MySQL en Railway |
| Almacenamiento | Cloudflare R2 (bucket público por URL, sin listado) |
| Colas | BullMQ sobre Redis (red privada de Railway, IPv6) |
| Correo saliente | **API HTTP de Brevo** (no SMTP — Railway lo bloquea) |
| Correo entrante | IMAP a `buzonfacturas@serviciosga.site` |
| CAPTCHA | CapSolver (`ImageToTextTask` es **síncrono**, sin polling) |
| Despliegue | autodeploy desde `main`; ~2-10 min |

**Producción:** https://portal-facturas-production.up.railway.app
**Repo:** https://github.com/CARLOSGUERRA99/portal-facturas
**Dos servicios en Railway:** `portal-facturas` (`node server.js`) y `portal-facturas-worker` (`node worker.js`).

---

## 3. Variables de entorno

> Sólo nombres. Los valores viven en Railway y en el `.env` local (que **no** debe versionarse).
> ⚠️ **Pendiente crítico:** `.env.example` está versionado con la contraseña real de MySQL. Ver `docs/plan-de-mejoras.md` § 0.1.

### Infraestructura
`DB_HOST` · `DB_USER` · `DB_PASSWORD` · `DB_PORT` · `DB_DATABASE`
`REDIS_URL` · `SESSION_SECRET` · `PORT`
`R2_ACCESS_KEY` · `R2_SECRET_KEY` · `R2_ENDPOINT` · `R2_BUCKET` · `R2_PUBLIC_URL`
`BROWSERLESS_TOKEN` · `ANTHROPIC_API_KEY` · `CAPSOLVER_API_KEY`

### Correo
`BREVO_API_KEY` — correo saliente por HTTP (lo único que funciona en Railway)
`IMAP_HOST` · `IMAP_PORT` · `IMAP_USER` · `IMAP_PASS` — captura de CFDI
`SMTP_HOST` · `SMTP_PORT` · `SMTP_SECURE` · `SMTP_USER` · `SMTP_PASS` — legacy, sólo fallback local
`COPIA_SOLICITUDES` — a quién se copia cada solicitud de factura por correo

### Credenciales de portales (cuentas compartidas)
`G500_USER` · `G500_PASS` · `G500_PERMISO_CRE`
`IGAS_USER` · `IGAS_PASS`
`ORSAN_USER` · `ORSAN_PASS`
`ORLER_SINALOA_USER` · `ORLER_SINALOA_PASS`
`PINFRA_USER` · `PINFRA_EMAIL`
`OXXOGAS_USER` · `OXXOGAS_PASS` · `OXXOGAS_CI_SESSION` · `OXXOGAS_INCAP_*` · `OXXOGAS_VISID_INCAP`

> ⚠️ Son cuentas **compartidas entre clientes**. Varios bots dejan que la cuenta decida el receptor del CFDI en vez de imponer el RFC del cliente. Ver auditoría § 2 ④.

### Modelos (permiten subir de modelo sin tocar código)
`MODELO_DETECCION` (def. `claude-sonnet-4-6`) · `MODELO_EXTRACCION` (def. `claude-sonnet-4-6`) · `MODELO_AGENTE` (def. `claude-sonnet-4-6`)

### Modo y depuración
`MANTENIMIENTO` — `true` sirve la página de mantenimiento (bypass con `?bypass=gpnadmin`)
`SIN_REDIS=1` — arranca sin colas, **sólo local**
`LOCAL_BROWSER=true` — Chromium local en vez de Browserless
`DEBUG_SHOTS` · `AUTOZONE_DEBUG` · `FACTURAGAS_DRY_RUN` · `YOUBUY_DRY_RUN` · `YOUBUY_ACTUALIZAR_CLIENTE` · `LOSSENDEROS_PARAR_EN` · `CAPUFE_INTENTAR_RECUPERAR`
`GIT_TOKEN` — permite que el servidor haga `git push` al aprobar un bot generado
`RAILWAY_ENVIRONMENT` · `RAILWAY_GIT_COMMIT_SHA` · `RAILWAY_GIT_BRANCH` — las inyecta Railway

---

## 4. Arquitectura

```
NAVEGADOR
   │
   ▼
server.js  ── proceso WEB ─────────────────────────────────────────────
   POST /upload-ticket → sube la foto a R2 → INSERT tickets(status='pendiente')
                       → encolarVision() → responde de inmediato
   El proceso web NO ejecuta OCR, ni bots, ni agentes. Sólo encola y sirve la API.
   │
   ▼
worker.js  ── proceso WORKER ──────────────────────────────────────────
   cola VISION  (concurrencia 6)
        lib/vision.js → 3 pasadas Sonnet → UPDATE ocr_json
        → status='pendiente_confirmacion'
        → si pasa el gate → encolarBot()

   cola BOTS    (concurrencia 2 = límite del plan de Browserless; máx 2 por portal)
        lib/facturacion.js :: ejecutarFacturacion()
             └→ bots/index.js :: normalizarDatos() + detectarYFacturar()
                     ├→ engine declarativo (commerce/{oxxo,gasmaz,ramsa,arco,rendichicas})
                     ├→ bot legacy         (bots/*.js — 49 archivos)
                     └→ bot dinámico       (generado por IA; disco o BD)
             ←─ RunnerResult → status, INSERT facturas, correo al residente, reintento

   cola AGENTE  (concurrencia 1, lock 50 min)
        agentes/orquestador → analizador → generador → validador → corrector×2
        → pendiente_aprobacion → un humano aprueba → activarBot()

   Jobs periódicos:
        IMAP        2 min    lib/imap-job.js :: procesarTicketsPorCorreo
        reintentos  5 min    lib/imap-job.js :: procesarReintentos
        rescate    60 s      worker.js :: rescatarTicketsSinEncolar
        limpiezas  24 h      cleanupTickets (tickets error +30d)
                             limpiarFacturasVencidas (CFDI +60d)  ← ver auditoría §2 ⑩
        respaldo   24 h      lib/backup-db.js → R2 (todas las tablas, gzip)
```

### Reintentos de BullMQ
`attempts: 3`, backoff exponencial 30s → 60s → 120s. Los jobs agotados quedan en el set `failed` = **cola muerta**, visible en `/api/admin/cola-muerta`.
⚠️ En la cola de bots casi nunca se activa: `ejecutarFacturacion` captura todas las excepciones y devuelve `{ok:false}`, así que BullMQ ve éxito.

### Concurrencia
- Cola bots: **2 globales** (`worker.js:172`) — es el límite del plan de Browserless, medido en el dashboard el 13/08/2026.
- Límite por portal: 2 (`queues/index.js:113`), implementado con contador en Redis y TTL de 15 min. Como el global ya es 2, en la práctica nunca llega a aplicar.
- `lockDuration` de la cola bots: **10 minutos** (`worker.js:183`). Sin esto BullMQ daba el job por "stalled" a los 30 s y lo entregaba a otro worker **mientras el primero seguía facturando** — el origen de los reintentos fantasma del 31/07.

---

## 5. Modelo de datos

Tablas: `users` · `clientes` · `residentes` · `user_residentes` · `tickets` · `facturas` · `ticket_intentos` · `notificaciones` · `portales_pendientes` · `portales_agente` · `config`

El esquema se crea y migra en `initDB()` (`server.js:184-374`) con `ALTER TABLE` envueltos en `try/catch` vacíos. **No hay archivos de migración.**

### `tickets` (columnas que importan)
`id` · `user_id` · `residente_id` · `nombre_archivo` · `ruta_archivo` (URL de R2) · `comercio` VARCHAR(150) · `portal_url` · `status` (enum) · `ocr_text` · `ocr_json` · `requiere_confirmacion` · `error_msg` TEXT · `reintento_programado` · `procesando_correo_desde` · `email_contacto` · `constancia_path` · `solicitud_correo_enviada` / `_fecha` / `_error` · `clave_dedupe` (columna generada) · `creado`

Índice `uq_ticket_dedupe` UNIQUE sobre `clave_dedupe` = `user_id | folio normalizado | total`. Es el candado anti-duplicados real (`scripts/candado-duplicados.js`).

### `facturas`
`id` · `user_id` · `ticket_id` **UNIQUE** · `comercio` **VARCHAR(50)** · `pdf_url` · `xml_url` · `status` · `uuid` · `receptor_rfc` · `emisor_rfc` · `emisor_nombre` · `total` · `serie_folio` · `fecha_timbrado` · `verificacion` · `creado`

> ⚠️ `comercio` es VARCHAR(50) y hay comercios más largos. Por eso `lib/facturacion.js:198` y `lib/imap-job.js:137` hacen `.slice(0,50)`: sin eso, `ER_DATA_TOO_LONG` tumba el INSERT de una factura **ya timbrada** y el ticket se reintenta.
> ⚠️ **No hay UNIQUE sobre `uuid`**: el mismo CFDI puede quedar en dos tickets.

### `clientes`
`id` · `nombre` · `rfc` · `razon_social` · `tipo_persona` · domicilio completo · `regimen_fiscal` · `uso_cfdi` · `email_contacto` · `mensualidad` · `estado_cuenta` (`prueba`/`activo`/`suspendido`) · `prueba_hasta` · `permite_subusuarios` · `marca_nombre` · `marca_logo` · `marca_color`

**Es la fuente de verdad fiscal.** `lib/facturacion.js:72-86` hace `COALESCE(c.campo, u.campo)` para no romper los logins sin cliente asignado.

### `ticket_intentos`
`ticket_id` (FK **ON DELETE CASCADE**) · `bot` · `resultado` · `mensaje` · `screenshot_urls` · `duracion_ms` · `creado`
⚠️ El CASCADE significa que borrar un ticket borra su historial: si `error_msg` no guardó el motivo, se pierde para siempre.

---

## 6. Estados del ticket

Enum (`server.js:227`): `pendiente` · `procesando` · `procesando_correo` · `procesado` · `error` · `pendiente_confirmacion`

```
[subida]
   └→ pendiente ──(cola vision)──→ pendiente_confirmacion
                                      ├─(gate OK + sin dudas)→ [cola bots] → procesando
                                      └─(dudas)→ espera al usuario

procesando ──┬→ procesado                 (ok:true con archivos)
             ├→ procesando_correo         (ok:true procesandoCorreo)
             ├→ pendiente_confirmacion    (datos_invalidos)
             └→ error                     (todo lo demás)

procesando_correo ──┬→ procesado          (IMAP encontró el CFDI)
                    └→ error              (expirador de 60 min, lib/imap-job.js:19-53)

error ──(si reintento_programado vencido)──→ [cola bots] → procesando
```

### Agujeros negros conocidos
| Estado | Cómo se llega | Por qué no sale |
|---|---|---|
| `pendiente` | `lib/facturacion.js:415` (429 de Browserless), `server.js:1022` (editar datos) | **ningún job selecciona `status='pendiente'`** |
| `procesando` | el worker muere a media facturación (redeploy) | no hay expirador ni botón en la UI |

---

## 7. Contrato de los bots

```js
{ ok: true,  xmlUrl, pdfUrl }          // el bot bajó los archivos
{ ok: true,  procesandoCorreo: true }  // el CFDI llegará por correo → lo recoge IMAP
{ ok: false, error_code, msg }         // error controlado
```

Campos opcionales que **sí se usan**: `email_contacto` (en `ticket_vencido`), `folioGenerado` y `uuid` (en `procesandoCorreo`, se conservan en `error_msg`), `portal_url`, `captcha_tipo`, `tipo: 'folio_no_disponible'` (escalación de OXXO).

### `error_code` — tabla de verdad

| Código | ¿Rama en `lib/facturacion.js`? | Efecto |
|---|---|---|
| `ticket_vencido` | ✅ :229 | error, **sin reintento**, guarda `email_contacto`, abre "solicitar por correo" |
| `captcha` | ✅ :284 | error, **sin reintento**, a validación manual |
| `reintentar_despues` | ✅ :302 | error, **reintento cada noche, sin tope** |
| `timbrado_sin_archivos` | ✅ :327 | error, **sin reintento**, aviso de recuperación manual |
| `datos_invalidos` | ✅ :350 | vuelve a `pendiente_confirmacion` |
| `ya_facturado` | ❌ **no existe** | cae al genérico → **reintento cada noche** (18 bots lo devuelven) |
| `timeout` | ❌ **no existe** | igual (3 archivos) |
| *sin `error_code`* | :392 | error genérico → **reintento cada noche** |

> ⚠️ `CLAUDE.md:117` afirma que `ya_facturado` es un "error controlado". No lo es.

### Reglas prácticas
- `reintentar_despues` es el **único** código que reintenta indefinidamente. **Nunca usarlo después del click que emite.**
- Si el bot ya pulsó el botón de emisión y algo falla, el código correcto es `timbrado_sin_archivos`.
- Un `{ok:false}` sin `error_code` equivale a "reintenta para siempre".

---

## 8. La doctrina de los bots

Siete reglas nacidas de bugs que costaron dinero. `bots/facturagas.js` es el único de los 49 que las cumple todas — **úsalo como plantilla**.

1. **Nunca `ok:true` sin prueba positiva.** UUID, folio, enlace de descarga o pantalla de resultado. Que la página contenga la palabra "descargar" no es prueba.
2. **`let timbradoDisparado = false` antes del `try`**, `true` justo **antes** del click que emite. Si el `catch` ocurre con la bandera en `true`, devolver `procesandoCorreo` o `timbrado_sin_archivos` — **nunca** `reintentar_despues`.
3. **Los clicks dentro de `page.evaluate` deben devolver si encontraron el botón.** `if (b) b.click();` sin `return` hace que "no había botón" y "lo pulsé" sean indistinguibles.
4. **Tipeo real** (`page.type` / `keyboard.type`) en React, Angular, Wicket y DevExpress. Asignar `.value` no dispara los eventos del framework y el campo queda vacío para la app.
5. **`page.on('dialog')` siempre.** Un `alert()` sin handler cuelga el hilo y Browserless mata la pestaña: es la causa real de "Session closed", "Target closed", "frame detached" y "main frame too early".
6. **El correo que se escribe en el portal es el buzón de captura, nunca el del residente.** Si el CFDI va al Gmail del residente, IMAP no lo ve y el ticket muere.
7. **`Promise.all([waitForNavigation, click])`** en botones que navegan. Si no, el `evaluate` siguiente muere con "Execution context was destroyed".

### Cumplimiento actual (medido sobre los 49 bots)

| Señal | Bots que la tienen |
|---|---:|
| `timbradoDisparado` o equivalente | 15 / 49 |
| `page.on('dialog')` | 33 / 49 |
| usan `emailEntrega` | 9 / 49 |
| devuelven `procesandoCorreo` en algún camino | 41 / 49 |

Bots marcados **PELIGROSO** en la auditoría (fallan varios puntos a la vez):
`g500` · `gasolineros` · `igasfac` · `gasmaz` · `petrofigues` · `sushito` · `littlecaesars` · `carljr` · `pinfra` · `panama`

---

## 9. OCR — tres pasadas

Todo en `lib/vision.js`. Medido con `node scripts/evaluar-ocr.js`: **98.5 % de campos, 23/24 tickets**.

| Pasada | Qué hace | Prompt |
|---|---|---|
| **1 — detección** | identifica el portal | **se arma leyendo `portales/portales.json`** (`lib/vision.js:36-82`) |
| **2 — extracción** | saca los campos | `promptsPorPortal[portal]`, con fallback a `desconocido` |
| **3 — relectura** | vuelve a preguntar sólo por los campos obligatorios nulos o dudosos, obligando a deletrear | `releerCamposDudosos` (`lib/vision.js:589`); máx. 3 campos |

**Consecuencia de diseño que hay que tener siempre presente:** un portal que **no esté en `portales.json`** nunca usa su prompt especializado, por bien escrito que esté. La Pasada 1 no lo puede nombrar → devuelve `desconocido` → corre el prompt genérico.

Cobertura actual: `portales.json` tiene 40 entradas; `promptsPorPortal` 29; `camposPorPortal` 32. **Ocho portales enrutados y en el gate no están en ninguno de los tres** (ver auditoría § 2 ⑦).

Piezas de apoyo:
- `extraerJson()` en vez de `JSON.parse()` — tres niveles de degradación. Un `JSON.parse` directo revienta si el modelo escribe una palabra antes del JSON y tira **todos** los datos del ticket.
- `corregirAnioReciente()` — aplicado tras la Pasada 2 **y** tras la 3.
- `repararReferenciaNetPay()` — reconstruye la referencia de Enerser/Enerfueltech cruzándola con el `Ticket:`.
- `corregirFolioOxxo` / `corregirIdVentaOxxo` — corrección posicional O→0, I→1, S→5 según el formato `NN LLL NN AAA N`.
- `ticketsEnFoto > 1` fuerza `requiereConfirmacion`: la foto trae varias compras y sólo se registra la primera. El voucher del banco o la "COPIA CLIENTE" de la **misma** venta no cuentan.

### Cuando dos números parecen "el folio", casi siempre vale el otro

| Portal | Cuál es el bueno |
|---|---|
| NetPay (Enerser / Enerfueltech) | la `Referencia:` del **pie**, no el `Folio:` con guiones de la terminal bancaria |
| NexusFuel (gasmaz / gashr / petrofigues) | el `Ticket:`; la "Referencia para facturar" es el **número de estación** |
| IGasFac | el Folioweb largo (4-8-8 con guiones) de abajo |
| AutoZone | el número largo **bajo el código de barras** |
| 7-Eleven | el código de barras de **exactamente 35 dígitos** |
| SoftRestaurant (SushiO / Dana) | `referencia` = código de facturación |
| TUFESA | además hay que capturar `origen` |
| OXXO GAS | **no es OXXO**: otro portal, otro prompt |

---

## 10. Dar de alta un portal: CUATRO sitios

Olvidar uno no rompe nada al arrancar — falla en silencio semanas después.

1. `bots/<portal>.js` — el bot.
2. `bots/index.js` — el `if` de routing. **El orden importa** (ver § 11).
3. `lib/util.js` — `PORTALES_FACTURABLES` y/o `URLS_FACTURABLES`. Sin esto el ticket se queda en `pendiente_confirmacion` y, peor, el agente de altas lo trata como portal nuevo y genera un bot **duplicado** (pasó de verdad: `autopistadecuotacasetaelpisals.js` compitiendo con `orler.js`).
4. `portales/portales.json` — si falta, el OCR nunca usa su prompt (§ 9).

Conviene además: `promptsPorPortal` y `camposPorPortal` en `lib/vision.js`, y el fallback por URL del QR (`lib/vision.js:776-813`).

---

## 11. Trampas conocidas del routing

El orden de los `if` en `bots/index.js` es significativo. Casos que ya mordieron:

| Regla | Va antes de | Porque |
|---|---|---|
| OXXO GAS | OXXO | "OXXO GAS" **contiene** "oxxo" |
| `nexusfuel.com.mx` → GASHR | el engine de gasmaz | `nexusfuel.mx` y `nexusfuel.com.mx` son plantillas distintas |
| Grupo A-Losa | Carl's Jr | la franquicia lleva el logo de Carl's Jr pero factura en su propio portal |
| Los Senderos | Estrella Blanca | el OCR escribió `portal:'estrellablanca'` en un ticket de KFC; la marca de la franquicia es la señal fiable |
| TopGas | IGasFac | los tickets de TopGas no nombran su portal y caían en IGasFac por parecido del folio |
| Little Caesars (Cafrema) | el fallback dinámico | hay un segundo Little Caesars (Navojoa, CAFRENA) |

Otras trampas:
- **`mefacturo.mx` vs `mefacturo.com`** son familias distintas con selectores distintos: `.mx` → `sushito.js`, `.com` → `dana.js`. Una letra mal leída manda el ticket al bot equivocado.
- **`facturacionestacion.com` y `petrosistemas.com.mx`** dan un subdominio **por estación**: hay que reconocer el dominio entero, no el subdominio concreto.
- **El OCR lee `1gasfac` como `lgasfac`** y `grupoarlosa` como `grupoa-losa`: se aceptan las tres grafías.
- **KFC El Refugio** no es Los Senderos: se distingue porque su referencia es un folio de 16 dígitos.

---

## 12. Catálogo de portales

40 entradas en `portales/portales.json`, 49 archivos en `bots/`, 5 portales en el engine.

| Clave | Nombre | Bot | Estado declarado |
|---|---|---|---|
| `oxxo` | OXXO Facturación Electrónica | engine `commerce/oxxo` (`bots/oxxo.js` es código muerto) | produccion |
| `oxxogas` | OXXO GAS | `oxxogas.js` | manual **por trabajo pendiente, no por bloqueo**: el login lleva reCAPTCHA v2, que sí se resuelve. Automatizarlo está aprobado (13-sep-2026); hoy sigue con cookie a mano porque el login aún no está escrito |
| `arco` | BuzonFacturas (ARCO) | `buzonfacturas.js` + engine `commerce/arco` | produccion |
| `gasmaz` | NexusFuel / Gasmaz | engine `commerce/gasmaz` + `commerce/ramsa` | produccion |
| `gashr` | NexusFuel / facturacionestacion.com | `gashr.js` | activo |
| `petrofigues` | Petrofigues | `petrofigues.js` | activo |
| `rendichicas` | Rendichicas / Rendilitros | engine `commerce/rendichicas` | produccion |
| `homedepot` | Home Depot México | `homedepot.js` | produccion |
| `bodegaaurrera` | Walmart de México (Bodega Aurrera, Sam's, Superama) | `bodegaaurrera.js` | produccion |
| `7eleven` | 7-Eleven México | `7elevenmexicosadecv.js` | activo |
| `autozone` | AutoZone de México | `autozone.js` (`autozonedemexico.js` está truncado) | activo |
| `benavides` | Farmacias Benavides | `benavides.js` | produccion |
| `farmaciaguadalajara` | Farmacias Guadalajara | `farmaciaguadalajara.js` | en_desarrollo |
| `carljr` | Carl's Jr (ICR) | `carljr.js` | produccion |
| `panama` | Panamá Restaurante y Pastelería | `panama.js` | produccion |
| `sushito` | SushiO (mefacturo.mx) | `sushito.js` | produccion |
| `elcaporal` | El Caporal | `sushito.js` | produccion |
| `allegro` | Allegro Caffe / Txutxu | `sushito.js` | produccion |
| `dana` | Dana Comida Mexicana | `dana.js` | activo |
| `littlecaesars` | Little Caesars (Cafrema) | `littlecaesars.js` | en_desarrollo |
| `littlecaesarsnavojoa` | Little Caesars Navojoa | `littlecaesarsnavojoa.js` | produccion |
| `caffenio` | CAFFENIO | `caffenio.js` | activo (timbrado sin verificar) |
| `tufesa` | TUFESA | `tufesa.js` | activo |
| `albatros` | Albatros Autobuses | `albatros.js` | activo |
| `capufe` | CAPUFE — casetas | `capufe.js` | activo |
| `pinfra` | PINFRA — casetas | `pinfra.js` | activo |
| `orler` | Casetas de Sinaloa (Orler) | `orler.js` | activo |
| `facturagas` | FacturaGAS / ControlGAS (ATIO) | `facturagas.js` | activo |
| `g500` | G500 Network | `g500.js` | activo_con_limitacion |
| `igasfac` | IGasFac | `igasfac.js` | activo |
| `erfc` | eRFC | `erfc.js` | activo |
| `enerser` | Enerser | `enerser.js` | activo |
| `enerfueltech` | Enerfuel Tech | `enerfueltech.js` | activo |
| `grupocentra` | Grupo Centra (Karmi) | `grupocentra.js` | activo |
| `cadisa` | Grupo CADISA / AutoFacturas RADEC | `cadisa.js` | activo |
| `ramcal` | RAMCAL | `ramcal.js` | activo |
| `qualligas` | QualliGas | `qualligas.js` | activo; su captcha (texto sensible a mayúsculas) no lo acierta CapSolver — 0/14 medido. No está bloqueado: falta configurar otro proveedor en `lib/captcha.js` → `SOLVERS['imagen_may']` |
| `casaley` | Casa Ley | — | mapeado_sin_bot |
| `puentecolorado` | Fideicomiso Puente Colorado | — | pendiente_bot |
| `similares` | Farmacias Similares | — | pendiente_bot |

### Portales con bot y routing pero **sin entrada en `portales.json`**
`estrellablanca` · `lossenderos` · `grupoarlosa` · `youbuy` · `facturat` · `redco` · `topgas` · `orsan` · `gasolineros` · `pollofeliz`

→ El OCR corre con el prompt genérico. **Es la causa de los tickets de gasolineras que no se pueden facturar.** Ver auditoría § 2 ⑦.

### Familias de portal (mismo software, varios comercios)

| Familia | Comercios / bots |
|---|---|
| SoftRestaurant (mefacturo) | SushiO, El Caporal, Allegro (`sushito.js`); Dana, Pollo Feliz (`dana.js`) |
| NexusFuel | gasmaz, ramsa (engine); gashr, petrofigues (bots) |
| ControlGAS / ATIO | facturagas (`app.facturagas.net`, 2,393 estaciones), g500 |
| AMS Integra | estrellablanca, lossenderos (mismo backend, 1,831 líneas duplicadas) |
| RetailEDX / Egrid | benavides, carljr |
| pade.mx | rendichicas, caffenio |
| buzonfacturas.com | todas las gasolineras ARCO |
| Alianza RedCo | ~18 grupos gasolineros con el mismo `facturaenlinea.aspx` |
| CADISA / RADEC | una instancia por gasolinera, cada una en su DDNS |
| Kernotek | topgas, migasolinera |

---

## 13. Correo

### Saliente — Brevo por HTTP
Railway bloquea SMTP, así que **todo** sale por `enviarCorreo()` (`lib/correo.js`) → `POST https://api.brevo.com/v3/smtp/email`. Nodemailer queda como fallback local.
Remitente verificado: `buzonfacturas@serviciosga.site`. Los envíos se ven en **Brevo → Transactional → Logs**, no en el webmail.
Soporta `cc`/`bcc` y adjuntos en base64.

### Entrante — captura de CFDI por IMAP
`mail/imap.js` busca en `INBOX` correos **`UNSEEN` de los últimos 60 minutos**, y para cada ticket en `procesando_correo` (máx. 5 por ciclo, timeout 3 min) intenta emparejar:

1. Extrae adjuntos (incluye ZIP) o, si no hay, sigue los enlaces "Clic para descargar" del cuerpo HTML.
2. **Un XML que parsea como Comprobante es un CFDI, lo mande quien lo mande** — esto permite reenvíos manuales.
3. Filtro por comercio, con excepciones para plataformas agregadoras (`platformPortalMap`) y mirando también el `Nombre` del Emisor dentro del XML.
4. **Verificación por monto, obligatoria**: tolerancia $1.00. "No poder verificar" (correo sólo-PDF, XML sin `Total`, ticket sin total) **no** es coincidencia: el correo se deja sin marcar leído.
5. Al emparejar, marca el correo como leído por UID.

Limitaciones conocidas: empareja por importe + palabras del comercio, sin folio ni UUID (dos tickets del mismo importe se cruzan), y un CFDI que no case en 60 minutos sale de la ventana `SINCE` y queda invisible.

### Solicitud de factura al comercio
Para tickets vencidos o portales imposibles. `POST /api/tickets/:id/solicitar-correo` → `lib/solicitud-correo.js`: adjunta la **constancia de situación fiscal** y la **foto del ticket** desde R2, copia a `COPIA_SOLICITUDES`, y pone `replyTo` al correo del usuario.
⚠️ Toma el RFC y la constancia de `users`, no de `clientes`.

---

## 14. El motor de agentes (alta automática de portales)

Cuando llega un ticket de un portal desconocido:

1. **analizador** (`agentes/analizador.js`) — carga el portal, sigue el iframe del formulario real si existe, selecciona `<select>` que revelan campos, rellena con datos reales del ticket y avanza hasta 4 pantallas capturando DOM y screenshots. **Evita los botones de emisión final** (`/generar|emitir|timbrar/`).
2. **generador** (`agentes/generador.js`) — escribe el bot con Sonnet (`max_tokens` 20k + anti-truncado + `vm.Script`).
3. **validador** (`agentes/validador.js`) — análisis estático + **prueba en vivo**: escribe el código en `bots/tmp_validate_*.js`, lo `require()` y lo ejecuta con `DATOS_TEST` (RFC `XAXX010101000`, folio `0000000001`).
4. **corrector** (`agentes/corrector.js`) — hasta 2 intentos con el error y los screenshots.
5. Queda en `pendiente_aprobacion` → el admin aprueba → `activarBot()` escribe el archivo, actualiza `portales.json` y guarda `bot_code` en la BD.

Coste: ~66,000 tokens de salida por alta (del orden de un dólar).

**Límites reales:**
- Los portales que exigen un ticket válido para revelar los pasos finales necesitan ajuste manual.
- ⚠️ **El CAPTCHA ya NO es un límite** (derogado el 13-sep-2026): se resuelve con CapSolver —
  reCAPTCHA v2, Turnstile e imagen. La única excepción medida es el captcha de texto sensible a
  mayúsculas (Parisina/QualliGas). La lista viva está en `lib/captcha.js` → `SOLVERS`.
- `portales.json` puede corromperse por escrituras concurrentes en disco efímero.
- Los bots generados viven en disco efímero: `restaurarBotsDinamicos()` los reescribe desde la BD al arrancar el worker.
- `POST /api/admin/agente/aprobar` (`server.js:2131-2159`) hace **`git commit` + `git push origin main`** desde producción si hay `GIT_TOKEN`, lo que dispara un despliegue.

---

## 15. Operación

### Endpoints de diagnóstico
| Endpoint | Para qué |
|---|---|
| `GET /api/version` | commit desplegado, rama, versión de Node |
| `GET /api/diag-mail` | valida la llave de Brevo y prueba la conexión IMAP |
| `GET /api/admin/cola-muerta` | jobs que agotaron sus reintentos |
| `GET /api/admin/validacion-manual` | bandeja de todo lo que necesita mano humana, clasificado por acción |
| `GET /api/admin/tickets/:id/intentos` | historial de intentos con screenshots |
| `GET /api/admin/debug-files` | últimas capturas de R2 |

### Scripts útiles
```
node scripts/evaluar-ocr.js                  # banco de pruebas del OCR (24 fotos)
GUARDAR=1 node scripts/evaluar-ocr.js        # fija una nueva línea base
node scripts/correr-ticket.js <id> [id...]   # factura tickets concretos
node scripts/reconciliar-correo.js           # empareja CFDI del buzón con tickets
node scripts/asociar-cfdi.js <ticket> <xml>  # asocia un CFDI conseguido a mano
node scripts/candado-duplicados.js           # informa (sin --aplicar no toca nada)
node scripts/oxxogas-sesion.js --estado      # ¿sigue viva la sesión de OXXO GAS?
```
⚠️ **Antes de tocar un prompt de OCR: correr el banco. Después: volver a correrlo.**
⚠️ Hay 22 scripts que **timbran de verdad** sin ninguna guarda. Ver auditoría § 3.4.

### Depuración local
Hay un `.env` local con todas las credenciales: `node scripts/probe-*.js` da feedback en segundos contra el Browserless de producción. **No iterar a ciegas con `git push`.**
`SIN_REDIS=1` permite arrancar sin colas. `LOCAL_BROWSER=true` usa Chromium local.

### Herramientas MCP disponibles
`estado_sistema` · `consultar_tickets` · `reprocesar_ticket` · `resetear_ticket` · `logs_railway` · `estado_r2` · `consultar_portales_pendientes`
Servidor: `portal-facturas-mcp-production.up.railway.app`, protegido por `MCP_API_KEY` (si no está configurada, **no pide autenticación**).

---

## 16. Costes

| Concepto | Orden de magnitud |
|---|---|
| OCR por ticket | 2 llamadas a Sonnet con la imagen + 1 condicional → ~$0.03-0.05 |
| Facturación por ticket | 1 sesión de Browserless, 60-250 s según el portal (7-Eleven es el más lento, ~279 s) |
| Reintento nocturno | otra sesión completa, **sin tope**, hasta que el ticket se borre a los 30 días |
| Alta de portal nuevo | ~66,000 tokens de salida ≈ $1 |
| CapSolver | por captcha resuelto; QualliGas gasta 3 por intento con 0/14 de acierto documentado |

**Cuello de botella:** la concurrencia 2 de la cola de bots, que es el límite del plan de Browserless. Los reintentos nocturnos de tickets irrecuperables compiten por esos dos huecos con los tickets nuevos.

---

## 17. Lecciones aprendidas que no hay que volver a aprender

- **`page.on('dialog')` es obligatorio.** Un `alert()` de AngularJS sin handler cuelga el hilo y Browserless mata la pestaña. Es la causa única de "Session closed", "Target closed", "frame detached" y "main frame too early".
- **CapSolver `ImageToTextTask` es síncrono**: la solución viene en `createTask`, no hay que hacer polling. `module: "common"`.
- **Los botones `type=submit` sin `ng-click` no se deben convertir a `type=button`**: su acción *es* el submit del formulario.
- **`Promise.all([waitForNavigation, click])`** o el `evaluate` siguiente muere con "Execution context was destroyed".
- **`JSON.parse` directo sobre la respuesta del modelo revienta** en cuanto escribe una palabra antes del JSON. Usar `extraerJson`.
- **Haiku se probó y se descartó con datos**: 92.6 % frente a 98.5 % de Sonnet, y confundió dos gasolineras distintas — o sea, enrutar al bot equivocado. La regla del proyecto es no sacrificar calidad por coste.
- **`www.` puede costar 15 segundos** desde Browserless: `elegirUrl()` (`engine/runner.js:43`) normaliza el host.
- **Un ticket rechazado por el portal enseña más que una duda del modelo**: por eso el gate del OCR se abrió y `datos_invalidos` devuelve el ticket a confirmación con las palabras del portal.
- **Railway corre en UTC.** Cualquier cálculo de plazo fiscal en hora local está mal por 7 horas.
- **`CREATE TABLE IF NOT EXISTS` no ensancha una columna existente**: por eso `facturas.comercio` se quedó en VARCHAR(50) aunque el código declarara 100.

---

## 18. Estado conocido a 13-sep-2026

- **49 bots**, de los cuales 1 (`facturagas.js`) cumple la doctrina completa y 10 están marcados PELIGROSO.
- **40 portales** en `portales.json`, 3 sin bot, **10 portales con bot pero sin entrada** (OCR genérico).
- **5 portales migrados al engine** de 44 posibles.
- **0 pruebas automatizadas.** 130 scripts de prueba manual que necesitan credenciales y portales vivos.
- **320 scripts** sin triaje: 22 timbran, 25 escriben en la BD, 2 sondas emiten CFDI reales.
- **Deuda de seguridad abierta:** contraseña root de producción en el repositorio (ver `docs/plan-de-mejoras.md` § 0.1).
- **Deuda fiscal abierta:** el sistema borra los CFDI a los 60 días (§ 0.2).
