# Auditoría de portal-facturas — 13 de septiembre de 2026

**Alcance:** revisión de solo lectura del sistema completo.
**Commit auditado:** `9acaeda` (rama `master`, árbol limpio).
**Tamaño:** ~66,000 líneas de aplicación + 25,900 de `scripts/`. 488 commits.
**Método:** lectura del código. No se ejecutó nada, no se tocó la base de datos, no se conectó a ningún portal, no se modificó ningún archivo durante la auditoría.

---

## Cómo leer este documento

- **Sección 1** — mapa del sistema: qué hace cada pieza y dónde vive cada dato.
- **Sección 2** — los diez problemas que de verdad cuestan dinero, explicados a fondo. **Todos verificados leyendo las líneas citadas.**
- **Sección 3** — el resto del inventario, agrupado por familia.
- **Sección 4** — lo que está bien hecho y no hay que romper.
- **Anexo A** — los 116 hallazgos completos tal como salieron de la revisión, con su escenario.

Marcas de fiabilidad:

| Marca | Qué significa |
|---|---|
| ✅ **VERIFICADO** | Se leyeron las líneas citadas y el hallazgo se sostiene. |
| ⚠️ **REPORTADO** | Sale de la lectura sistemática pero no se volvió a comprobar a mano. Trátalo como hipótesis fuerte, no como hecho. |
| ❌ **DESCARTADO** | Se reportó y al releerlo no se sostuvo. Se documenta para que nadie lo vuelva a levantar. |

Hallazgos descartados en la verificación (no son bugs):

- *"El cruce de monto de wansoft compara el importe contra sí mismo"* — falso. `bots/wansoft.js:883-895` usa dos fuentes fuertes independientes (el JSON del AJAX y el campo del formulario) y sólo cae al texto de pantalla cuando no hay ninguna. Está bien hecho.
- *"Albatros manda el CFDI sólo al residente"* — parcial. `bots/albatros.js:105-106` pone el correo del residente en `#email` **pero también el buzón en `#emailopc`**. El problema es real (el residente recibe el documento fiscal) pero no rompe la captura por IMAP. Rebajado de crítico a medio.

---

## 1. MAPA DEL SISTEMA

### 1.1 Arquitectura

Dos procesos separados en Railway, tres colas de BullMQ sobre Redis, una base de datos MySQL, almacenamiento en Cloudflare R2.

```
NAVEGADOR
   │
   ▼
server.js  ── proceso WEB ─────────────────────────────────────────────
   POST /upload-ticket → sube la foto a R2 → INSERT tickets(status='pendiente')
                       → encolarVision() → responde de inmediato
   El proceso web NO ejecuta OCR, ni bots, ni agentes. Sólo encola.
   │
   ▼
worker.js  ── proceso WORKER ──────────────────────────────────────────
   cola VISION  (concurrencia 6)
        lib/vision.js → 3 pasadas con Sonnet → UPDATE ocr_json
        → status='pendiente_confirmacion'
        → si pasa el gate (lib/util.js) → encolarBot()

   cola BOTS    (concurrencia 2 — es el límite del plan de Browserless)
        lib/facturacion.js :: ejecutarFacturacion()
             └→ bots/index.js :: normalizarDatos() + detectarYFacturar()
                     ├→ engine declarativo    (commerce/{oxxo,gasmaz,ramsa,arco,rendichicas})
                     ├→ bot legacy            (bots/*.js — 49 archivos, 24,006 líneas)
                     └→ bot dinámico          (escrito por IA, cargado de disco o de la BD)
             ←─ RunnerResult → decide status, INSERT facturas, correo, reintento

   cola AGENTE  (concurrencia 1)
        agentes/ → analiza un portal nuevo → escribe un bot con Sonnet
        → lo ejecuta EN VIVO → pendiente_aprobacion → un humano aprueba

   Jobs periódicos:
        IMAP        cada  2 min   lib/imap-job.js :: procesarTicketsPorCorreo
        reintentos  cada  5 min   lib/imap-job.js :: procesarReintentos
        rescate     cada 60 s     worker.js :: rescatarTicketsSinEncolar
        limpiezas   cada 24 h     cleanupTickets + limpiarFacturasVencidas
        respaldo    cada 24 h     lib/backup-db.js → R2
```

### 1.2 Estados del ticket

Enum real, declarado en `server.js:227`:

`pendiente` · `procesando` · `procesando_correo` · `procesado` · `error` · `pendiente_confirmacion`

| Estado | Quién lo pone | Quién lo saca de ahí |
|---|---|---|
| `pendiente` | `POST /upload-ticket` (`server.js:814`) | la cola vision |
| `pendiente_confirmacion` | worker tras el OCR (`worker.js:92`) | el usuario confirma, o `rescatarTicketsSinEncolar` |
| `procesando` | `lib/facturacion.js:136` | el propio bot al terminar |
| `procesando_correo` | `lib/facturacion.js:192` | el job IMAP, o el expirador de 60 min |
| `procesado` | `lib/facturacion.js:245` | nadie (estado final bueno) |
| `error` | muchas rutas | `procesarReintentos` si hay `reintento_programado` |

**Dos agujeros negros en esta máquina de estados** (detalle en §2 y §3):

1. `status='pendiente'` puesto por `lib/facturacion.js:415` (tras un 429 de Browserless) y por `server.js:1022` (tras editar datos): **ningún job selecciona ese estado**. El ticket se queda ahí salvo que el usuario pulse un botón.
2. `status='procesando'` si el worker muere a media facturación (redeploy de Railway): no hay job que lo recoja y la UI no ofrece ninguna acción.

### 1.3 Contrato de resultado de un bot

```js
{ ok: true,  xmlUrl, pdfUrl }          // el bot bajó los archivos
{ ok: true,  procesandoCorreo: true }  // el CFDI llegará por correo; lo recoge IMAP
{ ok: false, error_code, msg }         // error controlado
```

`error_code` reconocidos por `lib/facturacion.js`:

| Código | Rama | Qué hace |
|---|---|---|
| `ticket_vencido` | :229 | error, sin reintento, guarda `email_contacto`, abre "solicitar por correo" |
| `captcha` | :284 | error, sin reintento, a validación manual |
| `reintentar_despues` | :302 | error, **reintento cada noche, sin tope** |
| `timbrado_sin_archivos` | :327 | error, sin reintento, aviso de recuperación manual |
| `datos_invalidos` | :350 | vuelve a `pendiente_confirmacion` para que un humano revise |
| *(cualquier otro / ninguno)* | :392 | error genérico, **reintento cada noche** |

### 1.4 Dónde vive cada verdad

| Qué | Dónde |
|---|---|
| Datos fiscales del receptor | tabla `clientes`, con `COALESCE` contra `users` — `lib/facturacion.js:72-86` |
| Qué portal es un ticket (Pasada 1) | `portales/portales.json` — el prompt se arma leyendo este archivo (`lib/vision.js:36-82`) |
| Cómo extraer los campos (Pasada 2) | `promptsPorPortal` en `lib/vision.js` (29 portales) |
| Qué campos son obligatorios | `camposPorPortal` en `lib/vision.js:520-567` (32 portales) |
| Qué puede facturar la cola | `PORTALES_FACTURABLES` + `URLS_FACTURABLES` — `lib/util.js:22-83` |
| Qué bot corre | cadena de ~40 `if` en `bots/index.js:102-852` |
| Qué hacer con cada error | `lib/facturacion.js:229-402` |
| Emparejar el CFDI que llega por correo | `mail/imap.js:298-348` (monto ±$1 + palabras del comercio) |
| Alcance de datos por cliente | `filtroAlcance()` — `server.js:438-448` |

### 1.5 Inventario

| Carpeta | Archivos | Líneas |
|---|---:|---:|
| `bots/` | 49 | 24,006 |
| `scripts/` | 320 | 25,901 |
| `public/` | 11 | 6,021 |
| `server.js` | 1 | 2,499 |
| `lib/` | 10 | 2,622 |
| `commerce/` | 20 | 1,848 |
| `portales/` | 3 | 1,917 |
| `agentes/` | 5 | 1,065 |
| `engine/` | 8 | 690 |
| `mail/`, `queues/`, `storage/`, `worker.js` | 4 | 898 |

**Pruebas automatizadas: cero.** Hay 39 scripts `test-*`, 79 `probe-*` y 12 `verif-*`, y todos necesitan credenciales reales y un portal vivo para correr. La única red de seguridad que no timbra es `scripts/evaluar-ocr.js` (24 fotos, llamadas reales a Sonnet).

---

## 2. LOS DIEZ PROBLEMAS QUE DE VERDAD IMPORTAN

### ① No existe candado por ticket: dos procesos pueden timbrar el mismo ticket a la vez
**`lib/facturacion.js:136` · `queues/index.js:76` · CRÍTICO · esfuerzo S · ✅ VERIFICADO**

```js
// lib/facturacion.js:136
await db.query("UPDATE tickets SET status = 'procesando', reintento_programado = NULL WHERE id = ?", [ticketId]);
```

No hay `WHERE status <> 'procesando'`, no hay `SELECT` previo contra `facturas`, y `encolarBot` genera `jobId: bot-${ticketId}-${Date.now()}`, así que la deduplicación de BullMQ nunca se activa — el propio comentario de `queues/index.js:79-92` lo admite para la cola del agente y lo deja a propósito en las otras dos.

**Escenario:** 00:00, `procesarReintentos` (`lib/imap-job.js:270`) toma el ticket #400 (`status='error'`, reintento vencido) y lo encola. Cinco segundos después el usuario pulsa "Reintentar": `/facturar/:id` (`server.js:1042`) comprueba `status === 'procesando'` — todavía es `'error'`, el worker no lo ha tomado — y encola un segundo job. Concurrencia 2 y límite por portal 2: **ambos corren**. Dos sesiones de Browserless facturando el mismo folio. Dos CFDI timbrados ante el SAT.

El segundo `INSERT INTO facturas` choca con `uq_facturas_ticket_id`, la excepción sube al catch genérico (`lib/facturacion.js:425`) y el ticket queda en `error` con "Excepción: ER_DUP_ENTRY". **El segundo CFDI existe, está timbrado, y el sistema no tiene registro de él.**

**Por qué no se ha notado:** hace falta una coincidencia de segundos. Con un cliente es rarísimo; con diez y reintentos nocturnos masivos deja de serlo. Y el síntoma visible es "un error raro de base de datos", no "timbramos dos veces".

---

### ② El contrato de `error_code` está roto: 21 bots devuelven códigos que nadie maneja
**`lib/facturacion.js:392` · ALTO · esfuerzo S · ✅ VERIFICADO**

Ramas implementadas: `ticket_vencido`, `captcha`, `reintentar_despues`, `timbrado_sin_archivos`, `datos_invalidos`.

Códigos que los bots realmente devuelven (conteo sobre `bots/` y `commerce/`):

| `error_code` | usos | archivos | ¿rama? |
|---|---:|---:|---|
| `datos_invalidos` | 153 | — | ✅ |
| `reintentar_despues` | 138 | — | ✅ |
| **`ya_facturado`** | **31** | **18 bots** | ❌ **no existe** |
| `ticket_vencido` | 31 | — | ✅ |
| `timbrado_sin_archivos` | 19 | — | ✅ |
| `captcha` | 17 | — | ✅ |
| **`timeout`** | **3** | **3 archivos** | ❌ **no existe** |

`ya_facturado` cae en el error genérico, que programa `reintento_programado = proximaMedianoche()`. Es decir: **el portal dice literalmente "este ticket ya está facturado" y el sistema responde volviendo cada noche a pedir la misma factura**, durante 30 días, hasta que `cleanupTickets` borre el ticket. Cada noche consume una sesión completa de Browserless (60-250 s) de las dos disponibles.

En QualliGas cada vuelta son además 3 llamadas a CapSolver y ~150 s de navegador, sobre un CFDI que ya existe.

`CLAUDE.md:117` documenta lo contrario (*"`ya_facturado` / `datos_invalidos` → error controlado"*). La documentación miente y por eso nadie lo revisó.

---

### ③ Siete bots devuelven `reintentar_despues` DESPUÉS de pulsar el botón que emite
**CRÍTICO · esfuerzo M · ✅ VERIFICADO**

`reintentar_despues` es el único código que reintenta cada noche sin tope. Usarlo después del click de emisión es pedir un CFDI duplicado por noche.

| Bot | Línea | Lo que dice su propio mensaje |
|---|---|---|
| `bots/carljr.js` | 340 | *"puede haberse generado igual; revisar la captura antes de reintentar"* |
| `bots/pinfra.js` | 325 | *"la factura **SÍ se timbró** (transacción X) pero no se pudo mandar al buzón"* |
| `bots/gasolineros.js` | 274 | *"Puede haberse generado igual: revisar Historial antes de reintentar"* |
| `bots/littlecaesars.js` | 467 | *"se envió y el portal no confirmó ni rechazó"* |
| `bots/qualligas.js` | 477 | pone `timbradoDisparado=true` en :457 y lo contradice 20 líneas después |
| `bots/orler.js` | 348 | `{ok:false}` **sin `error_code`** → misma consecuencia |
| `commerce/rendichicas/hooks.js` | 61 | `error_code:'timeout'` tras pulsar `btnFacturar` → sin rama → genérico → medianoche |

El caso de PINFRA es el más claro: **el mensaje afirma que la factura se timbró y aun así elige el código que la vuelve a emitir esta noche.** El mensaje lo lee un humano; el sistema sólo mira el `error_code`.

Es exactamente el bug que ya se corrigió en `bots/topgas.js` creando `timbrado_sin_archivos` (ver el comentario de `lib/facturacion.js:315-326`). El arreglo no se propagó a los otros seis.

**Caso especial — `commerce/rendichicas/hooks.js:61`:** el flujo declarativo pulsa `btnFacturar` en `flow.json:28` (emisión real) y el hook espera `#btnPdf` 30 segundos. El timbrado pasa por un PAC; si tarda 31 s, `Promise.race` cae en `'timeout'`, `runner.js:220` lo devuelve tal cual, `bots/index.js:178` lo propaga, y `lib/facturacion.js` no tiene rama → error genérico → medianoche → el flujo entero se vuelve a ejecutar, incluido el click que emite.

---

### ④ El CFDI puede salir a nombre del contribuyente equivocado
**CRÍTICO · esfuerzo M-L · ✅ VERIFICADO**

Cinco caminos distintos, todos comprobados leyendo el código:

**a) `bots/igasfac.js` — el bot nunca usa el RFC del cliente.**
`grep -n "rfc|razonSocial|codigoPostal|total" bots/igasfac.js` devuelve **cero resultados en todo el archivo**. La firma (`igasfac.js:40-42`) sólo lee `folio` y `formaPago`. El bot entra con la cuenta `IGAS_USER`, mete el folio, elige forma de pago y pulsa enviar: el receptor es el que esa cuenta tenga guardado. Si un segundo cliente sube un ticket de IGasFac, su factura sale a nombre del primero — y como el bot devuelve `procesandoCorreo`, `verificarCFDI` no llega a correr nunca por ese camino.

**b) `bots/orsan.js:36` — recibe `rfc` y no lo usa.** La cuenta compartida decide el receptor.

**c) `bots/g500.js:178` — el RFC sólo se usa si la pantalla dice una frase concreta.**
```js
const textoCliente = await page.evaluate(() => document.body.innerText || "");
if (/seleccione un cliente/i.test(textoCliente)) {
  // … aquí y SÓLO aquí se busca la fila cuyo RFC coincide
}
```
ControlGAS es un portal con sesión: en cuanto recuerde el último cliente usado, o cambie el rótulo a "Cliente:" o "Datos del receptor", la condición es falsa, el bloque entero se salta y se timbra con el receptor anterior. El propio comentario de la línea 172 avisa de que la cuenta tiene **dos** clientes dados de alta (GPR110128QD8 y GPN000829S72).

Y aunque la condición se cumpla, tras el `btn.click()` **nadie relee qué receptor quedó seleccionado** — justo la precaución que `bots/facturagas.js:461-500` documenta durante diez líneas para el combo de estación, en la misma plataforma Telerik.

**d) `bots/orler.js:308` — el RFC de GPN escrito a fuego como validación.**
```js
if (datosModal.rfc && datosModal.rfc !== "GPR110128QD8") {
  return { ok: false, msg: `Orler: el modal muestra un RFC receptor inesperado (${datosModal.rfc})` };
}
```
Cualquier otro cliente no puede facturar en Orler **y** su ticket se reintenta cada noche, porque el `return` no lleva `error_code`.

**e) `bots/pinfra.js:231` — marca TODOS los checkboxes antes de facturar.**
```js
document.querySelectorAll("table input[type=checkbox], table input[type=radio]")
  .forEach((c) => { if (!c.checked) c.click(); });
```
PINFRA acumula tickets en una bandeja del portal. Si quedó algo de una corrida anterior o de otro residente, **un solo CFDI los engloba todos**. Y el login usa el correo del residente (`bots/index.js:289`), así que con dos clientes la bandeja es compartida.

**Además:** `bots/index.js:95` pone `d.rfc = primero(d.rfc, 'GPR110128QD8')` como valor por defecto, y `bots/estrellablanca.js:99` declara `RFC_GPN` y `DOMICILIO_GPN` completos. El sistema tiene la tabla `clientes` bien resuelta, pero **seis bots llevan el RFC de GPN en el código**: `estrellablanca`, `g500`, `grupoarlosa`, `orler`, `oxxogas`, `youbuy`.

---

### ⑤ `ok:true` sin ninguna prueba — y el sistema lo convierte en "no reintentar"
**CRÍTICO · esfuerzo M · ✅ VERIFICADO**

Es el bug que ya costó dinero en `dana.js` (tickets #349 y #356) y que sigue vivo en al menos ocho bots.

```js
// bots/sushito.js:252 — atiende SushiO, El Caporal y Allegro (3 comercios)
if (!generado) {
  console.log("⚠️ Sin confirmación de generación — fallback IMAP");
  return { ok: true, procesandoCorreo: true };     // ← ninguna confirmación = éxito
}
```
Y el test de "generado" (`sushito.js:246`) es `/factura\s+generada|exitosamente|descarga|xml|pdf/i`: la palabra "descarga" o "pdf" en cualquier menú de la página ya lo valida.

```js
// bots/littlecaesars.js:464
if (/correo|email|enviad|generad|gracias/i.test(t)) return { ok: true, procesandoCorreo: true };
```
La etiqueta "Correo electrónico" del propio formulario que no se envió ya pasa.

```js
// bots/g500.js:233
if (/factura.*(generad|emitid|exitos|timbrad)|descargar|xml/i.test(textoFinal))
```
La alternancia hace que `descargar` **suelto** valide el éxito.

**Lo grave no es el falso positivo, es lo que pasa después.** `lib/imap-job.js:34-45` mira el último intento, ve "Factura generada" y a los 60 minutos escribe:

> *"El CFDI SÍ se generó en el portal (el bot lo confirmó) pero el correo no llegó en 60 minutos. **NO reintentar: se emitiría un duplicado.** Buscarlo en el portal o correr scripts/reconciliar-correo.js cuando llegue."*

y al residente: *"Tu factura ya se generó, pero el correo no ha llegado. La estamos recuperando — no hace falta que hagas nada."*

**Las dos frases son mentira** y bloquean el único camino que habría funcionado: volver a intentarlo. El ticket queda muerto con un cartel que dice "no lo toques".

Mismo patrón en `panama.js:720`, `homedepot.js:672`, `farmaciaguadalajara.js:304`, `buzonfacturas.js:252`, `dana.js:526`, `7elevenmexicosadecv.js:516`, `cadisa.js:287`.

---

### ⑥ El CFDI se manda al correo del residente, no al buzón que el sistema lee
**CRÍTICO · esfuerzo S · ✅ VERIFICADO**

`normalizarDatos` (`bots/index.js:82-92`) distingue con toda claridad los dos correos y lo explica con el caso real de Casa Ley y La Parisina, cuyos CFDI acabaron en `GASTOSCULIACAN@GMAIL.COM`:

```js
d.emailEntrega = primero(d.emailEntrega, process.env.IMAP_USER, 'buzonfacturas@serviciosga.site');
```

**Sólo 9 de los 49 bots usan `emailEntrega`.**

El caso peor es `bots/carljr.js:126-128`, porque el comentario afirma lo contrario de lo que hace el código:

```js
// El correo va al buzón del sistema a propósito: si la captura del blob
// fallara, el CFDI llega igual por correo y el job de IMAP lo levanta.
const correo = email || "buzonfacturas@serviciosga.site";
```

`email` **siempre** viene relleno: `lib/facturacion.js:151` lo pone con `email: ticket.email`, que es el del login del residente. El fallback no se ejecuta jamás. La factura se va al correo del residente, el buzón no la ve, el ticket espera 60 minutos y muere.

Y hay cinco bots que **nunca escriben ningún correo** y aun así devuelven `procesandoCorreo`: `g500`, `gasolineros`, `igasfac`, `orsan`, `oxxogas`. `bots/gasolineros.js:22-24` incluso presume de que el portal autocompleta el correo desde el perfil del RFC — o sea, el del cliente o el de la estación, nunca el buzón. **El 100 % de esos tickets muere a los 60 minutos, por diseño.**

`bots/albatros.js:105-106` es el caso intermedio: pone el correo del residente en `#email` y el buzón en `#emailopc`. La captura funciona, pero el documento fiscal de un cliente llega al buzón personal de un empleado.

---

### ⑦ Los ocho portales más nuevos corren con el OCR genérico
**ALTO · esfuerzo S · ✅ VERIFICADO — esto explica los 11 tickets de gasolinas que no se pudieron facturar**

`estrellablanca`, `lossenderos`, `grupoarlosa`, `youbuy`, `facturat`, `redco`, `topgas` y `orsan` están enrutados en `bots/index.js` y presentes en el gate de `lib/util.js`, pero:

```
portal            fallback_URL_vision   en_portales.json   en_gate
estrellablanca            0                    0              sí
lossenderos               0                    0              sí
grupoarlosa               0                    0              sí
youbuy                    0                    0              sí
facturat                  0                    0              sí
redco                     0                    0              sí
topgas                    0                    0              sí
orsan                     0                    0              sí
```

**No aparecen ni una sola vez en `lib/vision.js` ni en `portales/portales.json`.**

El prompt de la Pasada 1 se arma leyendo `portales.json` (`lib/vision.js:36-82`), así que el modelo **no puede nombrarlos**: devuelve `desconocido`. La Pasada 2 usa entonces `promptsPorPortal.desconocido`, que pide `folio`, `total`, `fecha`, `referencia` y `origen`. Nunca pide `webId`, `NoComprobante`, `NoTr`, `Franquicia`, `Sucursal` ni `secuencia` — que es exactamente lo que esos portales necesitan para encontrar el ticket.

Peor: `camposPorPortal` (`lib/vision.js:520-567`) tampoco los tiene, así que `campos` cae a `['fecha','total']` y `requiereConfirmacion` sale **0**. El ticket va derecho al bot sin los datos que el bot necesita, el bot falla, y el error genérico lo reintenta cada noche.

El sistema sólo los salva cuando el OCR alcanza a copiar la URL impresa, porque entonces `URLS_FACTURABLES` (`lib/util.js:74-83`) y el routing por `portalUrl` los rescatan. Si la tira térmica está borrosa, no hay nada que hacer.

Es el cuarto sitio que `CLAUDE.md:164-168` advierte que hay que tocar y del que dice que *"olvidarlo no rompe nada al arrancar"*. Rompe esto.

---

### ⑧ La interfaz le esconde al residente justo los tickets en los que tiene que actuar
**CRÍTICO de negocio · esfuerzo S · ✅ VERIFICADO**

`server.js:1294-1307` enmascara para todo el que no sea admin:

```js
const ESTADOS_OCULTOS_A_RESIDENTE = ['error', 'pendiente_confirmacion'];
// → devuelve status:'procesando', error_msg:null, _enRevision:true
```

Y `public/mis-tickets.html:420-424` decide qué botones pintar a partir de ese status ya falseado:

```js
const isPendingConfirm = t.status === 'pendiente_confirmacion';   // siempre false
const isError          = t.status === 'error';                    // siempre false
const isProcessing     = ['procesando','procesando_correo'].includes(t.status); // siempre true
```

Consecuencia para una capturista (rol `residente`):

| Estado real | Lo que necesita hacer | Lo que ve |
|---|---|---|
| `pendiente_confirmacion` | confirmar los datos del OCR | "En revisión" + botón gris "Procesando..." desactivado. **El botón "Revisar datos" (`mis-tickets.html:487`) no se pinta nunca.** |
| `error` (bot falló) | reintentar o editar datos | lo mismo. Sin "Reintentar", sin "Editar datos" |
| `error` (`ticket_vencido`) | solicitar por correo | lo mismo. `btnSolicitar` cuelga de `isError` (línea 438), así que **tampoco aparece** |

El sistema pide confirmación y esconde el botón de confirmar. Todo el camino de recuperación autoservicio está muerto para quien no es admin, y como el badge dice "En revisión", nadie escala nada.

La intención (*"el residente no debe ver fallos técnicos"*) es correcta; la ejecución le quitó también las acciones.

**Añadido:** un ticket que se quede en `'procesando'` de verdad — un redeploy de Railway a media facturación — no tiene **ninguna** salida ni para el admin: `canDelete` (`mis-tickets.html:424`) no incluye `procesando` y ningún job recoge ese estado.

---

### ⑨ La contraseña root de la base de datos de producción está versionada en git, dos veces
**CRÍTICO · esfuerzo S · ✅ VERIFICADO**

```
.env.example                    → DB_HOST=yamanote.proxy.rlwy.net  DB_USER=root
                                   DB_PASSWORD=jynqk…  DB_PORT=13642  DB_DATABASE=railway
scripts/ver-tickets-lc.js:3-6   → los mismos valores, en claro, dentro del código
```

Comprobado: **esos valores siguen siendo los del `.env` actual**. `.env.example` está trackeado desde el commit inicial (`b1e7391`, 14-may-2026); `.gitignore` protege `.env` pero no `.env.example`. `yamanote.proxy.rlwy.net:13642` es el proxy TCP **público** de Railway: quien tenga el repositorio tiene root sobre la base de datos de producción desde cualquier parte del mundo.

Y encadena: con acceso a la BD se puede escribir en `portales_agente.bot_code`, que `bots/index.js:810-839` lee, escribe a disco y **ejecuta** dentro del worker — que lleva el token de Browserless, las llaves de R2 y la API key de Anthropic.

**Hay que rotar esa contraseña aunque el repositorio sea privado.** Está en el historial de 488 commits y no se borra quitando el archivo.

Relacionado: `scripts/oxxogas-sesion.js:106` guarda en MySQL, en claro, una cookie de sesión viva del portal fiscal de OXXO GAS, y `lib/backup-db.js:22` vuelca **todas** las tablas a R2 cada 24 horas.

---

### ⑩ El sistema borra los CFDI de sus clientes a los 60 días
**ALTO · esfuerzo S · ✅ VERIFICADO**

```js
// lib/imap-job.js:309-331 — corre cada 24 h y también al arrancar el worker (worker.js:254)
const limite = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
… borrarArchivoR2(key) …
await db.query("UPDATE facturas SET xml_url = NULL, pdf_url = NULL WHERE id = ?", [f.id]);
```

Borra el XML y el PDF de R2 y pone las URLs a NULL. **El XML es el CFDI**; el PDF es sólo su representación impresa — lo dice el propio `RESUMEN.txt` que genera el ZIP (`server.js:1773`). El SAT exige conservarlos cinco años.

Consecuencia directa y comprobable: el endpoint de descarga por periodo filtra `rows.filter(f => f.xml_url || f.pdf_url)` (`server.js:1699`) y devuelve **404 "No hay facturas con archivos en ese periodo"** para cualquier mes de hace más de dos meses. El contador pide las facturas de julio y el sistema contesta que no hay ninguna.

En la misma línea, `cleanupTickets` (`lib/imap-job.js:292`) borra tickets en error de más de 30 días y `ticket_intentos` tiene `ON DELETE CASCADE` (`server.js:240`): se va también el historial que explicaba por qué falló.

---

## 3. EL RESTO DEL INVENTARIO

### 3.1 Doble timbrado y reintentos

| Hallazgo | Dónde | Fiab. |
|---|---|---|
| 7-Eleven vuelve a pulsar FACTURAR dentro de la misma corrida (bucle de 3 intentos de captcha, el click está dentro del bucle) | `bots/7elevenmexicosadecv.js:460-497` | ✅ |
| `reintentar_despues` no tiene tope: RedCo puede quemar 3 min de Browserless por ticket y por noche, indefinidamente | `lib/facturacion.js:302` | ✅ |
| Un ticket que cae por 429 de Browserless queda en `status='pendiente'`; **ningún job recoge ese estado** y el comentario promete un reintento que no existe | `lib/facturacion.js:415` | ✅ |
| 9 de 11 bots de gasolineras no tienen `timbradoDisparado`: cualquier excepción tras el click que emite cae en el error genérico | `gasmaz:343`, `gashr:254`, `petrofigues:211`, `enerser:216`, `enerfueltech:246`, `topgas:296`, `igasfac:331`, `g500:251`, `gasolineros:325` | ⚠️ |
| RedCo no reinicia `timbradoDisparado` entre los dos folios que prueba | `bots/redco.js:414` | ⚠️ |
| RedCo evalúa "verifique sus datos" antes del patrón de éxito y vuelve a pulsar Facturar con el otro folio | `bots/redco.js:780` | ⚠️ |
| RAMCAL revienta después de emitir y tira el folio, lo único con lo que se recuperaba | `bots/ramcal.js:257` | ⚠️ |
| `lib/facturacion.js` descarta el `msg` de todo `procesandoCorreo` sin `folioGenerado`: las instrucciones de recuperación no llegan a nadie | `lib/facturacion.js:186` | ⚠️ |
| CAPUFE: cinco salidas sin `error_code` después de pulsar "Facturar conceptos", y sin `page.on('dialog')` | `bots/capufe.js:379` | ⚠️ |
| Nueve bots devuelven `{ok:false}` sin `error_code`: cada fallo determinista se reintenta cada noche para siempre | `bots/autozone.js:729` y 8 más | ⚠️ |
| `caffenio.js` no tiene implementado el timbrado y devuelve `{ok:false}` sin `error_code` | `bots/caffenio.js:151` | ⚠️ |

### 3.2 Fiscal

| Hallazgo | Dónde | Fiab. |
|---|---|---|
| La verificación del CFDI se descarta justo cuando el XML **no** es un CFDI (`datos ? verificarCFDI(...) : []`): el caso en que hacía falta la alarma produce silencio | `lib/facturacion.js:215` | ✅ |
| Grupo Centra: ternario con las dos ramas idénticas → el `usoCfdi` del cliente se ignora siempre; la forma de pago se adivina "débito" | `bots/grupocentra.js:334` | ⚠️ |
| Cinco bots escriben 601/G03 a fuego ignorando los del cliente | `7eleven:393`, `rendichicas…:75` y 3 más | ⚠️ |
| CAPUFE elige régimen y uso de CFDI por **posición** del dropdown, no por identidad | `bots/capufe.js:212` | ⚠️ |
| AutoZone redondea el total a entero antes de mandarlo al portal | `bots/autozone.js:39` | ⚠️ |
| Bodega Aurrera cierra tickets como `procesado` con PDF y sin XML, y fija tarjeta de crédito | `bots/bodegaaurrera.js:155` | ⚠️ |
| CAPUFE y PINFRA calculan fechas y horas en UTC sobre un contenedor sin TZ | `bots/pinfra.js:275` | ⚠️ |
| QualliGas decide el vencimiento con hora UTC y asumiendo DD/MM/AAAA: puede matar un ticket todavía facturable (el día 1 a las 00:30 UTC son las 18:30 del último día del mes en México) | `bots/qualligas.js:81` | ⚠️ |
| Nadie lee la propina: la lógica de wansoft está muerta y `verificarCFDI` marca "grave" todas las facturas de restaurante con propina | `bots/wansoft.js:303` | ⚠️ |
| `pinfra-descargar-cfdi.js` registra como "completado" un CFDI que su propia verificación acaba de marcar como GRAVE | `scripts/pinfra-descargar-cfdi.js:130` | ⚠️ |

### 3.3 Multi-cliente, datos y seguridad

| Hallazgo | Dónde | Fiab. |
|---|---|---|
| ~10 endpoints de admin **sin** `filtroAlcance`: un admin de cliente ve y opera tickets de los demás clientes | `server.js:715, 1355, 2174, 2193, 2231, 2272, 2415, 2466, 699` | ✅ |
| `/register` es abierto: cualquiera crea cuenta y consume cuota de Sonnet, Browserless y CapSolver | `server.js:471` | ✅ |
| El emparejador IMAP usa monto ±$1 + palabras del comercio, sin folio ni UUID: dos tickets del mismo importe el mismo día se cruzan (ya pasó: #220/#227) | `mail/imap.js:298-348` | ✅ |
| El buscador IMAP es `UNSEEN + SINCE 60 minutos`: un CFDI que no case en esa hora queda invisible para siempre | `mail/imap.js:177` | ✅ |
| `facturas` no tiene UNIQUE sobre `uuid`: un mismo CFDI puede quedar registrado en dos tickets | `server.js:336` | ✅ |
| XSS almacenado: el nombre del archivo subido se interpola en `innerHTML` | `public/mis-tickets.html:480` | ✅ |
| Inyección de atributo: el comercio del OCR va dentro de `onclick="…'${comercio}'…"` escapando sólo la comilla simple | `public/admin-residentes.html:484` | ✅ |
| Clave `folio` **duplicada** en el objeto LABELS: la segunda gana y el modal le pide a todos los portales el código de barras de AutoZone | `public/dashboard.html:704` y `:714` | ✅ |
| Salvo Mis Facturas, ninguna pantalla maneja el 401: la sesión caducada se ve como avería y el poll sigue cada 6 s | `public/mis-tickets.html:721` | ⚠️ |
| Se puede eliminar un ticket en `procesando_correo` sin ninguna advertencia de que el CFDI viene en camino | `public/mis-tickets.html:424` | ✅ |
| `migrar-residentes-cliente.js` reasigna a GPN todos los residentes sin cliente, y `server.js` crea todos los residentes sin cliente | `scripts/migrar-residentes-cliente.js:31` | ⚠️ |
| Los scripts de reconciliación fijan `user_id=1` en la fila de facturas sin mirar de quién es el ticket | `scripts/recuperar-arco.js:86` | ⚠️ |

### 3.4 La carpeta `scripts/` — 320 archivos, 25,900 líneas, sin dueño

| Categoría | Cuántos | Ejemplos |
|---|---:|---|
| Scripts que **timbran** llamando a un bot, sin mirar el status ni tomar candado | 22 | `facturar-ticket.js:28`, `correr-ticket.js`, `ramcal-facturar-final.js:53` |
| Scripts que escriben o borran en MySQL | 25 | — |
| Sondas `probe-*` que **emiten un CFDI real** | ≥2 | `probe-capufe.js:106` (*"Click «Facturar conceptos» (EMISIÓN REAL)"*), `probe-pioneros4.js:264` |
| Scripts que reencolan tickets en `procesando_correo` — ya timbrados, esperando su CFDI — y provocan el segundo | 3 | `ciclo-facturacion.js:63`, `reintentar-todos.js:39`, `releer-orler.js:32` |
| Scripts que borran la fila de `facturas` y reencolan: destruyen la prueba del timbrado y provocan el siguiente | 2 | `reset-error-tickets.js:39`, `candado-duplicados.js:77` |
| Datos personales reales versionados (CURP, RFC, domicilio, 4 dígitos de tarjeta) | 2 | `alta-cliente.js:21`, `ramcal-facturar-final.js:43` |
| Credenciales de producción en claro | 1 | `ver-tickets-lc.js:5` |
| Lógica duplicada de `lib/` que ya divergió | varios | `registrar-cfdi-manual.js:83` no recibió ninguno de los arreglos de `reconciliar-correo.js` |

Verificado en `ciclo-facturacion.js:63` y `reintentar-todos.js:39`: la consulta es
`WHERE f.id IS NULL AND t.status <> 'procesado'`, que **incluye `procesando_correo`** — tickets ya timbrados esperando su CFDI. Reejecutarlos emite el segundo.

### 3.5 Código muerto y duplicado

- **`bots/autozonedemexico.js` está truncado a media instrucción** (410 líneas que ni siquiera parsean). Igual `elcaporalrestaurantecampestre.js:351` y `allegrocaffezonadoradatxutxufo.js`. `bots/index.js:407-426` enruta esos comercios a `facturarSushito`, así que los tres archivos son decoración. ⚠️
- **`bots/oxxo.js`** (528 líneas) es inalcanzable: `bots/index.js:149-151` manda todo lo que huela a OXXO al engine. ✅
- **`estrellablanca.js` + `lossenderos.js` = 1,831 líneas para un solo backend** (AMS Integra), con nueve divergencias de comportamiento entre gemelos. ⚠️
- **`commerce/gasmaz/hooks.js` y `commerce/ramsa/hooks.js` son idénticos** salvo el prefijo del nombre del archivo en R2 (3 líneas de 155). ✅
- **`bots/grupoarlosa.js`**: 1,227 líneas que, según su propia cabecera (línea 171), nunca han pasado del paso 1 — y ya está enrutado en producción. ⚠️
- Cuatro entradas de `portales.json` sin bot: `casaley`, `puentecolorado`, `similares`, `littlecaesarsnavojoa` (esta última sí tiene archivo pero no ruta en `index.js`). ✅

### 3.6 Coste

Con la información del código (no se consultó ninguna factura real):

- **Por ticket:** 2 llamadas a Sonnet con la imagen completa (Pasadas 1 y 2) + una tercera condicional (`releerCamposDudosos`, `lib/vision.js:589`). Orden de magnitud: $0.03-0.05 por ticket sólo en OCR.
- **Por reintento nocturno:** una sesión completa de Browserless (60-250 s medidos en `ticket_intentos` según `worker.js:177`). Sin tope, indefinidamente, hasta que `cleanupTickets` borre el ticket a los 30 días. Un ticket irrecuperable cuesta ~30 sesiones.
- **Por alta de portal nuevo:** ~66,000 tokens de salida en Sonnet (generador 20k + corrector 20k×2) — el propio comentario de `queues/index.js:85-89` lo cifra en "del orden de un dólar".
- **Cuello de botella real:** concurrencia 2 en la cola de bots, que es el límite del plan de Browserless. Los reintentos nocturnos de tickets muertos compiten por esos dos huecos con los tickets nuevos.

---

## 4. LO QUE ESTÁ BIEN HECHO

Esto no es cortesía: son decisiones que costaron caro aprender y que no hay que romper al arreglar lo demás.

1. **Los comentarios son el mejor activo del repositorio.** Casi cada arreglo lleva escrito el caso real que lo motivó, con número de ticket y fecha: `lib/imap-job.js:129-137`, `queues/index.js:79-92`, `engine/runner.js:266-277`, `lib/util.js:11-21`. Eso es lo que hizo posible auditar 66,000 líneas sin ejecutar nada.

2. **`lib/cfdi.js` es correcto y es la pieza más valiosa del sistema.** Abre el XML y comprueba receptor, importe, timbre, versión y tipo, sin dependencias nuevas y sin poder tumbar una facturación buena. El problema no es la función: es que sólo se llama en dos de los cinco caminos por los que entra un CFDI.

3. **La arquitectura de colas es la correcta.** Tres colas con la del agente aislada, `lockDuration` de 10 minutos razonado contra medidas reales de `ticket_intentos` (`worker.js:173-183`), `sinSolape` para los jobs periódicos, cola muerta consultable desde el panel, y `rescatarTicketsSinEncolar` como red de seguridad.

4. **El candado anti-duplicados a nivel de índice** (`uq_ticket_dedupe`, `uq_facturas_ticket_id`) es el razonamiento bueno: el chequeo en código da el mensaje bonito, el candado de verdad lo pone MySQL.

5. **`extraerJson`** (`lib/vision.js:97`) con su degradación en tres niveles, y la decisión —**medida**, no intuida— de no bajar a Haiku porque confundía dos gasolineras (`lib/vision.js:13-31`).

6. **El banco de pruebas de OCR** (`scripts/evaluar-ocr.js` + `pruebas/ocr/`): 24 fotos que ya fallaron en producción, con línea base guardada. Es el único sitio del proyecto donde un cambio se mide antes y después.

7. **`bots/facturagas.js` es el bot de referencia.** Es el único de los 49 que cumple los siete puntos de la doctrina y el único que **relee** el campo del correo antes de emitir (línea 700). Debería ser la plantilla.

8. **`filtroAlcance`** (`server.js:438-448`) entendió bien el problema multi-cliente: el alcance es el cliente, no el login. Sólo falta aplicarlo en los diez endpoints donde se olvidó.

9. **La separación web/worker** y el hecho de que el proceso web no ejecute nada pesado. Es lo que permite que la app responda mientras 2 bots están facturando.

10. **El engine declarativo** (`engine/` + `commerce/`) es la dirección correcta para no tener 49 bots divergentes. Está a medio camino: 5 portales migrados, 44 sin migrar.

---

## Anexo A — Los 116 hallazgos completos

Salida íntegra de la revisión sistemática. Los escenarios están truncados a 700 caracteres.
Los marcados ✅ en las secciones 2 y 3 de este documento fueron reverificados a mano; el resto son hipótesis fuertes que conviene confirmar antes de tocar código.


---

#### G500 emite a QUIEN el portal tenga preseleccionado: el RFC del cliente sólo se usa si aparece un texto concreto en pantalla
**Archivo:** `bots/g500.js:178`
**Severidad:** critica | CAT: fuga entre clientes / CFDI al RFC equivocado
**Escenario:** La cuenta G500_USER tiene varios clientes dados de alta (el propio comentario de la línea 170 lo dice: GPN Pinturas GPR110128QD8 y General Paint GPN000829S72). El bot sólo entra a elegir fila si el body contiene literalmente 'seleccione un cliente'. ControlGAS es un portal con sesión: en cuanto recuerde el último cliente usado, o cambie el rótulo a 'Cliente:' / 'Datos del receptor', esa condición es falsa, el bloque entero se salta, y el bot pulsa Facturar con el receptor que quedó de la vez anterior. Ticket de un cliente, CFDI a nombre de otro. Y aunque la condición SÍ se cumpla, tras hacer btn.click() en la fila nadie vuelve a leer qué receptor quedó seleccionado: exactamente el


---

#### IGasFac factura SIEMPRE al titular de la cuenta IGAS_USER: datos.rfc no se usa ni una sola vez en todo el bot
**Archivo:** `bots/igasfac.js:40`
**Severidad:** critica | CAT: fuga entre clientes / CFDI al RFC equivocado
**Escenario:** Sube un ticket de IGasFac un cliente que NO es el dueño de la cuenta IGAS_USER. El bot entra con esa cuenta, mete el folio web, elige forma de pago y pulsa 'Guardar datos fiscales' + 'Enviar solicitud'. Los datos fiscales que guarda son los que la cuenta ya tenía: el CFDI sale a nombre del titular de IGAS_USER, no del cliente que subió el ticket. El sistema lo da por bueno (ok:true, procesandoCorreo), el CFDI llega por IMAP, y en lib/facturacion.js la verificación de receptor sólo corre en la rama de ok:true CON xmlUrl — aquí se entra por la rama procesandoCorreo (facturacion.js:177). El cliente B acaba con el gasto deducido por el cliente A y sin comprobante propio.


---

#### G500 y Gasolineros.mx devuelven procesandoCorreo sin haber escrito nunca el buzón de captura: el CFDI se va a otro correo y el IMAP jamás lo verá
**Archivo:** `bots/g500.js:237`
**Severidad:** critica | CAT: dinero perdido / ticket muerto
**Escenario:** Los dos bots terminan en {ok:true, procesandoCorreo:true} con el comentario 'el portal manda el CFDI por correo; el job de IMAP lo recoge'. Pero ninguno de los dos escribe jamás un correo en el portal: G500 nunca toca un campo de email, y Gasolineros.mx presume en su cabecera (gasolineros.js:22-24) que el portal AUTOCOMPLETA el correo desde el perfil del RFC — o sea, el correo del cliente o el que la estación tenga guardado, no buzonfacturas@serviciosga.site. El CFDI se emite de verdad y aterriza en un buzón que el sistema no lee. A los 60 minutos lib/imap-job.js:19-53 marca el ticket como error con reintento NULL y el texto 'NO reintentar'. Resultado: el 100% de los tickets de estos do


---

#### Gasolineros.mx devuelve reintentar_despues DESPUÉS de pulsar Facturar, y el propio mensaje admite que la factura pudo salir
**Archivo:** `bots/gasolineros.js:274`
**Severidad:** alta | CAT: doble timbrado
**Escenario:** Tras el click en #btnFacturar_I, si esperarTexto() no reconoce nada en 60 s, el bot devuelve error_code 'reintentar_despues' con el texto 'Puede haberse generado igual: revisar Historial de facturas antes de reintentar'. Ese aviso lo lee un humano; el sistema sólo mira el error_code, y reintentar_despues es precisamente el que reagenda a medianoche (lib/facturacion.js:302-312) y, si vuelve a fallar igual, cada noche indefinidamente. Es el mismo error que lib/facturacion.js:320-326 dice haber erradicado de topgas.js — la lección se escribió y no se aplicó a este bot. El portal parece bloquear el duplicado con el alert 'Recibo ya facturado', pero eso es suerte del portal, no del bot: en 


---

#### 9 de 11 bots no tienen timbradoDisparado: cualquier excepción después del click que emite cae en el error genérico, que reintenta a medianoche
**Archivo:** `bots/gasmaz.js:343`
**Severidad:** alta | CAT: doble timbrado / reintentos infinitos
**Escenario:** El catch final de gasmaz.js:343, gashr.js:254, petrofigues.js:211, enerser.js:216, enerfueltech.js:246, topgas.js:296, igasfac.js:331, g500.js:251 y gasolineros.js:325 devuelve {ok:false, msg} SIN error_code. lib/facturacion.js lo manda al error genérico (línea ~390): status error + reintento_programado = próxima medianoche, y así cada noche. Todos esos catch envuelven el click que emite. Escenario concreto y barato: en gashr/petrofigues el bot pulsa Facturar, el portal timbra, y a los 30 s se cae la sesión de Browserless mientras se sondea el texto → 'Session closed' → catch → reintento nocturno. También hay returns explícitos sin error_code después de haber timbrado: gashr.js


---

#### error_code 'ya_facturado' no existe en lib/: los 5 bots que lo devuelven condenan el ticket a reintentarse cada noche indefinidamente
**Archivo:** `bots/qualligas.js:288`
**Severidad:** alta | CAT: reintentos infinitos / coste
**Escenario:** qualligas.js:288, g500.js:157, gasolineros.js:223 y :269, igasfac.js:159 y :192 devuelven error_code 'ya_facturado'. `grep -rn ya_facturado lib/ server.js` no encuentra NI UNA rama que lo mire (lo confirmé; facturagas.js:151-155 ya lo había comprobado y por eso devuelve procesandoCorreo en su lugar). Cae al error genérico → status error + reintento a medianoche → el ticket vuelve al portal cada noche, hace todo el recorrido (login, captcha en qualligas, agregar consumo), el portal le vuelve a decir 'ya facturado', y otra vez a medianoche. Para siempre. El caso más caro es qualligas: cada vuelta son 3 llamadas a CapSolver y ~150 s de Browserless, sobre un ticket cuyo CFDI ya existe y 


---

#### QualliGas implementa timbradoDisparado y luego lo contradice: reintentar_despues 20 líneas después de ponerlo en true
**Archivo:** `bots/qualligas.js:477`
**Severidad:** alta | CAT: doble timbrado
**Escenario:** qualligas.js:457 pone timbradoDisparado=true en cuanto el modal del captcha se cierra (la prueba dura de que el ACEPTAR entró). Veinte líneas más abajo, si la pantalla resultante contiene 'captcha incorrecto/inválido', devuelve error_code 'reintentar_despues' con el texto 'No se emitió nada; reintentar es seguro'. Pero ya no se puede afirmar eso: el modal se cerró, y el portal pudo perfectamente haber aceptado la solicitud y estar mostrando un aviso residual del intento anterior (los avisos de este portal se desvanecen solos — lo dice el comentario de qualligas.js:320-324). Si el CFDI salió, ese reintentar_despues emite un segundo CFDI a la noche siguiente. Es el único bot del grup


---

#### Petrofigues se quedó sin los dos arreglos que su gemelo GASHR sí recibió: espera fija de 4.5 s y domicilio fiscal del tenant sin corregir
**Archivo:** `bots/petrofigues.js:124`
**Severidad:** alta | CAT: divergencia / doble timbrado / fiscal
**Escenario:** gashr.js y petrofigues.js son el MISMO formulario NexusFuel (lo dice la cabecera de gashr.js:2-5). GASHR recibió dos parches medidos en vivo que petrofigues no tiene: (1) gashr.js:158-172 sondea hasta ~42 s porque 'facturadieselmax.petrosistemas tarda bastante más y en el ticket #326 el bot dictaminó no se confirmó la emisión con la factura probablemente generándose'; petrofigues.js:124 sigue con un `waitForTimeout(4500)` seco y petrofigues.js:132 devuelve {ok:false} sin error_code → error genérico → reintento nocturno sobre una factura que se estaba timbrando. (2) gashr.js:86-130 sobrescribe el domicilio fiscal porque 'cada tenant NexusFuel guarda SU PROPIO registro del cliente y


---

#### FacturaGAS promete servir a los ControlGasFE auto-hospedados pero la URL está fija: esas estaciones no se pueden facturar nunca y cada intento gasta una sesión
**Archivo:** `bots/facturagas.js:515`
**Severidad:** media | CAT: coste / ticket atascado
**Escenario:** La cabecera explica largamente que muchas estaciones ControlGasFE corren su propia instancia en un DDNS (hemajolasuerte.ddns.net:8087, pioneros4.ddns.net:82, y www.gpopioneros.com lista cinco más) y que el bot 'también vale para los portales propios' (facturagas.js:577-580). No vale: consultarTicket() navega siempre a app.facturagas.net. Una estación no listada en esa fachada recorre todos los candidatos del autocomplete (abriendo Browserless, tecleando, esperando 2.5 s por candidato — hasta una docena de candidatos por ticket), falla con 'no aparece en el autocomplete', y sale por facturagas.js:952 como datos_invalidos → pendiente_confirmacion. El operador confirma los datos —que s


---

#### QualliGas decide el vencimiento con la hora UTC del servidor y asumiendo DD/MM/AAAA: puede matar definitivamente un ticket todavía facturable
**Archivo:** `bots/qualligas.js:81`
**Severidad:** media | CAT: dinero perdido / fecha
**Escenario:** fueraDePlazo() compara el mes del ticket contra new Date() del proceso. Railway corre en UTC: el día 1 a las 00:30 UTC son las 18:30 del último día del mes en hora de México. Un ticket de ese último día subido esa tarde se declara 'fuera del mes natural' cuando aún le quedan cinco horas y media de plazo, y el sistema lo cierra con ticket_vencido → status error, reintento NULL, ventana de 'solicitar por correo' (lib/facturacion.js:262-280). No hay vuelta atrás automática: el ticket se pierde por una zona horaria. Segundo filo: el regex asume DD/MM/AAAA y lee m[2] como el mes; si el OCR devuelve MM/DD/AAAA (el modelo lo hace cuando el ticket imprime el mes en inglés o el formato es


---

#### normalizarDatos() pone el RFC de GPN por defecto: cualquier llamada sin RFC timbra a nombre de otro cliente
**Archivo:** `bots/index.js:95`
**Severidad:** media | CAT: fuga entre clientes
**Escenario:** `d.rfc = primero(d.rfc, 'GPR110128QD8')`. Hoy el camino de producción está protegido porque lib/facturacion.js:93-96 aborta si el cliente no tiene RFC y lo pasa siempre explícito. Pero detectarYFacturar() es exportada y la llaman también el validador de agentes (que corre bots EN VIVO contra portales reales, según CLAUDE.md) y cualquier script de scripts/. Una llamada sin rfc no falla ni avisa: emite un CFDI real a nombre de GPN Pinturas con el ticket de otro cliente. Un valor por defecto que es el RFC de un contribuyente concreto no es un default, es una trampa: lo correcto es reventar.


---

#### El engine de Rendichicas devuelve error_code 'timeout' DESPUÉS del click que timbra → reintento nocturno → CFDI duplicado
**Archivo:** `commerce/rendichicas/hooks.js:61`
**Severidad:** critica | CAT: doble_timbrado
**Escenario:** flow.json:28 hace el click en btnFacturar (emisión real). flow.json:30 llama al hook esperarResultadoYDescargar, que espera #btnPdf 30 s. El timbrado de Rendichicas pasa por un PAC; si tarda 31 s el Promise.race cae en 'timeout' y el hook devuelve {ok:false, error_code:'timeout'}. runner.js:220 convierte ese objeto en el resultado del flow, bots/index.js:178 lo devuelve tal cual, y lib/facturacion.js NO tiene rama para 'timeout' (solo ticket_vencido, captcha, reintentar_despues, timbrado_sin_archivos, datos_invalidos): cae al error genérico de la línea 392-396, que pone reintento_programado = medianoche. lib/imap-job.js:284-288 lo reencola. A medianoche el flow entero se vuelve a ejecutar


---

#### Albatros pide el CFDI al correo del RESIDENTE, no al buzón de captura
**Archivo:** `bots/albatros.js:105`
**Severidad:** critica | CAT: entrega_fiscal
**Escenario:** lib/facturacion.js:151 pasa `email: ticket.email`, que es el correo del LOGIN del residente (users.email). normalizarDatos() de bots/index.js rellena emailEntrega pero no toca `email`. Albatros escribe `email || buzonfacturas@...` en #email, el campo principal de envío del CFDI. Resultado: la factura se timbra y se manda al Gmail del residente; IMAP nunca la ve; el ticket se queda en procesando_correo o en error para siempre y el boleto NO se puede re-facturar. Es exactamente el caso que la cabecera de bots/index.js:88-91 documenta como ya ocurrido con Casa Ley y La Parisina (CFDI perdidos en GASTOSCULIACAN@GMAIL.COM).


---

#### Orler compara el RFC receptor contra la constante GPR110128QD8: factura al contribuyente equivocado sin enterarse
**Archivo:** `bots/orler.js:308`
**Severidad:** critica | CAT: fuga_entre_clientes
**Escenario:** El portal es de G&A y sirve a varios clientes (GPN, DGA…), cada uno con su RFC (lib/facturacion.js:62-84 lo dice con todas las letras). Orler ni siquiera recibe el rfc del ticket: su firma (línea 96) es {carril, folio, fechaPago, importe, ticketId}. Entra con la cuenta compartida ORLER_SINALOA_USER, cuyo perfil fiscal es el de GPN, y el modal llega pre-llenado con GPR110128QD8. La única 'validación' compara ese valor contra un literal, así que SIEMPRE pasa. Un ticket de caseta de un cliente que no es GPN se timbra a nombre de GPN: el gasto se lo deduce quien no lo pagó, el cliente real se queda sin comprobante, y el arreglo es cancelar el CFDI ante el SAT y volver a pedirlo dentro de 


---

#### Orler pulsa TIMBRAR y, si no ve la frase exacta en 9 s, devuelve {ok:false} sin error_code → reintento cada noche sobre el botón de emisión
**Archivo:** `bots/orler.js:348`
**Severidad:** critica | CAT: doble_timbrado
**Escenario:** Línea 315-320: click en TIMBRAR (emisión real). Línea 327: `waitForTimeout(9000)` fijo y UNA sola lectura de pantalla. Si el PAC tarda 10 s, la línea 340 no encuentra 'la factura ha sido timbrada correctamente' y la 348 devuelve {ok:false, msg} SIN error_code → lib/facturacion.js:392-396 → reintento_programado = medianoche → imap-job:284 reencola → el bot vuelve a entrar, vuelve a BUSCAR y vuelve a pulsar TIMBRAR. Lo mismo el catch de la línea 354, que se dispara con 'Execution context was destroyed' justo porque el click navegó. No existe `timbradoDisparado` en ninguna parte del archivo. Compárese con ORSAN, que para el mismo problema espera hasta 120 s con waitForFunction (o


---

#### RAMCAL revienta DESPUÉS de emitir y tira el folio de la factura, que es lo único con lo que se podía recuperar
**Archivo:** `bots/ramcal.js:257`
**Severidad:** critica | CAT: factura_perdida
**Escenario:** Línea 215: click en #btn_facturar (emisión real). Línea 225: el bot ya LEYÓ el folio real de la factura (ej. P275856). Líneas 236-262: navega a 'Descargar Factura' para mandarse el CFDI al buzón; si el portal cambia de pantalla o tarda, la línea 257 hace `throw new Error('no se encontró el campo de correo')`. El catch (268-273) devuelve {ok:false, msg: err.message} SIN error_code y SIN el folio: lib/facturacion.js cae al genérico, guarda 'RAMCAL: no se encontró el campo de correo' y programa reintento a medianoche. El reintento fracasa siempre, porque la cabecera del propio bot (líneas 32-34) dice que el código del ticket se invalida al usarse: se devolverá datos_invalidos. Resu


---

#### lib/facturacion.js tira el msg de todo ok:true+procesandoCorreo: las instrucciones 'NO RELANZAR / cómo recuperar' nunca llegan a un humano
**Archivo:** `lib/facturacion.js:186`
**Severidad:** alta | CAT: contrato_roto
**Escenario:** Cinco de los diez bots redactan con enorme cuidado el mensaje del catch posterior al timbrado: redco.js:948, grupoarlosa.js:1108, cadisa.js:416, orsan.js:350 y orsan.js:332 explican que el CFDI puede existir, que no se relance y por qué ruta exacta se recupera a mano. lib/facturacion.js:186-194 solo conserva `resultado.folioGenerado` y `resultado.uuid`; `resultado.msg` no se guarda en ningún sitio, y si no hay rastro se escribe error_msg = NULL, borrando además lo que hubiera. El ticket queda en procesando_correo sin una sola letra. Si el correo nunca llega, lib/imap-job.js:230 se limita a registrar 'reintentará en siguiente ciclo' eternamente (la estrategia B solo aplica a ARCO). De los


---

#### ya_facturado está en el contrato pero lib/facturacion.js no tiene rama: 18 bots lo devuelven y el sistema reintenta 30 noches un ticket que YA tiene factura
**Archivo:** `lib/facturacion.js:392`
**Severidad:** alta | CAT: reintento_infinito
**Escenario:** albatros.js:148, orler.js:281 y 346, redco.js:776, grupoarlosa.js:660 y 1058 (y 12 bots más) devuelven error_code 'ya_facturado'. lib/facturacion.js solo tiene ramas para ticket_vencido (262), captcha (284), reintentar_despues (302), timbrado_sin_archivos (327) y datos_invalidos (350). 'ya_facturado' cae al error genérico de la línea 392, que programa reintento a medianoche; imap-job:284 lo reencola; el bot abre Browserless, hace login, rellena el formulario, vuelve a leer 'ya facturado' y vuelve a programar otra medianoche. Así 30 días seguidos, hasta que cleanupTickets (imap-job:292-307) borra el ticket. Además la notificación que ve el residente miente: 'Reintentaremos esta noche a


---

#### RedCo evalúa 'verifique sus datos / intente de nuevo' ANTES del patrón de éxito y, si casa, vuelve a pulsar Facturar con el otro folio
**Archivo:** `bots/redco.js:780`
**Severidad:** alta | CAT: doble_timbrado
**Escenario:** Tras el click que emite (línea 751), el bot clasifica la pantalla por orden: vencido (765), ya facturado (770), NO ENCONTRADO (780) y solo al final éxito (872). El patrón de la 780 incluye `verifique (sus )?datos` e `intente de nuevo`, dos frases que los portales ASP.NET llevan impresas de fábrica como instrucción permanente, y se prueba contra `aviso + document.body.innerText` entero. Si la pantalla de éxito contiene cualquiera de esas frases —cosa que nadie ha visto, porque la cabecera del archivo (puntos 1 y 2, líneas 44-60) admite que NUNCA se envió el formulario— gana el ramo 'no encontrado', se marca probarOtroFolio y el bucle de las líneas 920-933 entra a `intentar()` otr


---

#### ORSAN recibe el rfc del ticket y no lo usa nunca: el receptor lo decide la cuenta compartida
**Archivo:** `bots/orsan.js:36`
**Severidad:** alta | CAT: fuga_entre_clientes
**Escenario:** `rfc` se desestructura en la firma y no vuelve a aparecer en las 321 líneas restantes (grep: única ocurrencia). El bot entra con ORSAN_USER/ORSAN_PASS —una sola cuenta para todo el sistema— y la cabecera (líneas 24-25) explica que 'el RFC ya viene seleccionado si la razón social está dada de alta'. Es decir: el receptor del CFDI es el que la cuenta tenga seleccionado por defecto, no el del cliente dueño del ticket, y no se verifica en ningún momento. Si la cuenta tiene varias razones sociales en #/businessname, o si el ticket es de otro cliente de G&A, el CFDI sale a nombre de quien no compró. Mismo agujero que Orler pero sin siquiera el comparador contra el literal. Además el '


---

#### CADISA devuelve ok:true+procesandoCorreo sin ninguna prueba cuando el portal dice 'ya facturado', y ese CFDI no va al buzón que el sistema lee
**Archivo:** `bots/cadisa.js:287`
**Severidad:** alta | CAT: ok_sin_prueba
**Escenario:** Si al pulsar 'Agregar Ticket' el portal contesta que ya está facturado, la línea 287 devuelve {ok:true, procesandoCorreo:true} — sin folio, sin UUID, sin archivo y sin haber comprobado nada. lib/facturacion.js:191 pone el ticket en procesando_correo con error_msg=NULL. Pero la cabecera de este mismo bot (líneas 56-58) dice que el portal manda el CFDI al correo de la FICHA del cliente (carlosguerra@grupogpn.com), NO al buzón de captura: el correo que ese ticket espera no va a llegar nunca por IMAP. El ticket se queda en procesando_correo para siempre, contado como éxito en las métricas, y la factura de verdad está en otro buzón. El catch de la línea 412 hace lo mismo tras el timbra


---

#### Grupo Centra: ternario con las dos ramas idénticas — el usoCfdi del cliente se ignora siempre; y la forma de pago se adivina 'débito'
**Archivo:** `bots/grupocentra.js:334`
**Severidad:** alta | CAT: fiscal
**Escenario:** `elegir(\


---

#### Rendichicas (bot legacy): forma de pago 28 clavada a fuego y catch sin error_code después de pulsar Facturar
**Archivo:** `bots/rendichicasestacionpirusadecv.js:75`
**Severidad:** alta | CAT: fiscal
**Escenario:** Línea 75: `selectNG('#form-field-FormaPago', '28')` — 28 es 'tarjeta de débito' y se manda siempre, pague el residente en efectivo o con crédito; el dato sale impreso en el CFDI. El mismo valor está clavado en el engine (commerce/rendichicas/hooks.js:15-20), así que no hay camino donde se respete el ticket. Y en el mismo archivo: línea 109 pulsa Facturar (btnSiguienteCD), línea 111 espera #btnPdf 30 s; si no aparece, el waitForSelector lanza, el catch de la línea 186 devuelve {ok:false, msg} sin error_code → error genérico → reintento a medianoche → segundo CFDI. No hay timbradoDisparado ni page.on('dialog') en todo el archivo (único de los diez junto con erfc que no maneja


---

#### Albatros acepta la palabra 'gracias' como prueba de que se timbró, y si no la ve devuelve reintentar_despues tras haber pulsado Facturar
**Archivo:** `bots/albatros.js:189`
**Severidad:** alta | CAT: ok_sin_prueba
**Escenario:** Tras pulsar Facturar (167-171, click mudo dentro de evaluate: no devuelve si encontró el botón) y esperar 15 s fijos, la línea 189 da por emitido si la pantalla casa con /factura.*(generad|emitid|timbrad)|se envi|enviad[ao] a su correo|gracias/. 'gracias' suelta aparece en el pie de cualquier portal ('Gracias por su preferencia'): basta con que el portal devuelva a la página de inicio para que el bot declare ok:true+procesandoCorreo y el ticket espere un correo que no existe. Y por el otro lado: si el portal SÍ timbró pero tarda más de 15 s, la línea 196 devuelve reintentar_despues, que lib/facturacion.js:302 reintenta CADA NOCHE PARA SIEMPRE — sobre un boleto de autobús que ya ti


---

#### RedCo no reinicia timbradoDisparado entre los dos folios: una excepción en el segundo intento se reporta como CFDI emitido que no existe
**Archivo:** `bots/redco.js:414`
**Severidad:** media | CAT: falso_positivo
**Escenario:** `timbradoDisparado` se declara fuera del bucle (414) y se pone a true antes del click de cada intento (750). Si el intento 0 se rechaza sin emitir (probarOtroFolio) el bucle entra al intento 1, donde la bandera sigue en true desde el intento anterior. Si ahora falla el `page.goto` de la línea 697 o cualquier cosa antes del click —Browserless corta la sesión, el DDNS se cae a media corrida—, el catch de la 944 ve timbradoDisparado=true y devuelve {ok:true, procesandoCorreo:true, 'NO RELANZAR: comprobar primero en el portal'}. El ticket pasa a procesando_correo por una factura que nunca se emitió: nadie lo reintenta, nadie lo revisa y el residente se queda sin comprobante. Es el fallo d


---

#### eRFC: page.once('response') lo consume la primera respuesta cualquiera, así que el diagnóstico del IDW es inventado
**Archivo:** `bots/erfc.js:129`
**Severidad:** media | CAT: diagnostico_falso
**Escenario:** `page.once(\


---

#### reintentar_despues no tiene tope y RedCo puede quemar 3 minutos de Browserless por ticket y por noche, indefinidamente
**Archivo:** `lib/facturacion.js:302`
**Severidad:** media | CAT: costo
**Escenario:** La rama reintentar_despues reprograma medianoche sin contador de intentos ('se reintenta cada noche indefinidamente hasta que el portal lo reconozca', dice su propio comentario). RedCo devuelve ese código cuando ninguna instancia responde (redco.js:681-686) tras un sondeo que puede llegar a 17 puertos por host con un presupuesto de 180 s (redco.js:662) — y el portal es un DDNS doméstico que puede no volver nunca. Con un solo ticket son ~3 minutos de sesión de Browserless cada noche, para siempre, sin que nadie lo mire; con diez clientes y un puñado de tickets así, la cola de bots (máx. 2 concurrentes) empieza a competir consigo misma y los tickets nuevos esperan detrás de tickets mu


---

#### ORSAN mete el usuario de la cuenta compartida en el msg, que se pinta crudo al residente; y sin credenciales devuelve error_code 'captcha'
**Archivo:** `bots/orsan.js:332`
**Severidad:** media | CAT: credenciales
**Escenario:** Las líneas 320, 332 y 350 interpolan `process.env.ORSAN_USER` en el msg. Ese msg acaba en tickets.error_msg (lib/facturacion.js:329 para timbrado_sin_archivos), lo devuelve /api/tickets (server.js:1319) y public/mis-tickets.html:463 lo imprime crudo —truncado a 117 caracteres— al residente que subió la foto: el correo de acceso al portal corporativo de ORSAN queda a la vista de cualquier usuario. Aparte: si faltan ORSAN_USER/ORSAN_PASS la línea 46 devuelve error_code 'captcha', que lib/facturacion.js:284 convierte en error permanente sin reintento y en la notificación 'el portal pide CAPTCHA' — una explicación falsa. Un deploy que olvide esas dos variables convierte silenciosament


---

#### grupoarlosa: 1,227 líneas de bot que nunca se han ejecutado más allá del paso 1, ya enrutado en producción
**Archivo:** `bots/grupoarlosa.js:138`
**Severidad:** media | CAT: riesgo_operativo
**Escenario:** El propio archivo (líneas 138-202) dice que el reconocimiento paró en 'Datos Personales' y que guardarCuenta, generarVistaPrevia, el renombrado del botón a 'Facturar', el toast SI/NO, la descarga de #documentos y el camino de recuperación NO se han visto ejecutar. Aun así bots/index.js:620-630 ya lo enruta y la cola lo puede lanzar. El primer ticket real de Carl's Jr/Star Laguna será la primera ejecución completa, contra un portal que —según la propia cabecera, línea 45— NO PERMITE RE FACTURAR. Si algo del tramo no verificado se comporta distinto a lo leído en autofacturacion.js, el fallo es irreversible. Además el bot no puede correr todavía: exige SERIE de 6 letras + FOLIO 


---

#### sushito.js da por facturado TODO lo que llega al paso 2, aunque no haya pulsado un solo botón — y atiende a tres comercios
**Archivo:** `bots/sushito.js:252`
**Severidad:** critica | CAT: ok_true_sin_prueba
**Escenario:** Un residente sube un ticket de El Caporal. index.js:407-426 lo manda a facturarSushito (NO a su propio archivo). El bot llena código+folio+RFC, pulsa Facturar, detecta el paso 2 y en :235-242 hace `page.evaluate(() => { const btn = cand.find(...); if (btn) btn.click(); })` SIN devolver si encontró el botón. Si el botón se llama 'Guardar' o 'Siguiente »' —que es exactamente como se llaman en la otra rama de SoftRestaurant, según el mapeo en vivo que documenta dana.js:181-187— no encuentra nada y no pulsa nada. A continuación espera 30s un texto que casa con /factura generada|exitosamente|descarga|xml|pdf/; si no lo ve devuelve {ok:true, procesandoCorreo:true} (:255), y si lo ve per


---

#### sushito.js ni siquiera captura razón social ni código postal: en CFDI 4.0 ese timbrado no puede existir
**Archivo:** `bots/sushito.js:43`
**Severidad:** critica | CAT: ok_true_sin_prueba
**Escenario:** La firma del bot recibe `razonSocial`, `regimenFiscal`, `usoCfdi` y `total`, y NINGUNO se usa salvo régimen. No hay parámetro `codigoPostal` siquiera. El paso 2 sólo escribe el correo y elige el régimen (:204-229). Desde CFDI 4.0 el SAT exige nombre y C.P. del receptor exactamente como en la constancia, y el propio hermano de este bot lo demuestra: dana.js:216-269 tiene que dar de alta al cliente rellenando #Name y #CustomerAddress_Code porque el tenant lo pide. En cualquier tenant de mefacturo que pida esos datos, sushito no puede completar el formulario — y por el hallazgo anterior devuelve ok:true igual. Resultado: el ticket se cierra como facturado y no hay CFDI. Además nunca usa 


---

#### carljr.js devuelve reintentar_despues DESPUÉS de haber pulsado Facturar: el reintento de medianoche emite un segundo CFDI
**Archivo:** `bots/carljr.js:340`
**Severidad:** critica | CAT: doble_timbrado
**Escenario:** El bot pulsa 'Facturar' en :331 y espera 90 s el texto 'Factura generada exitosamente'. Si el PAC tarda 91 s, o si el portal pinta otra cosa, `exito` es null y :340 devuelve `error_code: 'reintentar_despues'`. lib/facturacion.js:302-312 programa el ticket para medianoche y lo re-encola; la noche siguiente el bot vuelve a entrar, el portal Egrid le vuelve a aceptar la referencia (que ya no debería, pero si la venta admite refacturación o el estado tardó en propagarse, sí) y se emite un segundo CFDI del mismo ticket. Y como reintentar_despues no escala nunca a error permanente (lo dice el comentario de facturacion.js:296-301: «se reintenta cada noche indefinidamente»), puede repetirse mu


---

#### El catch de carljr.js devuelve {ok:false} sin error_code: reintento cada noche para siempre y, si la excepción llegó tras Facturar, CFDI duplicado
**Archivo:** `bots/carljr.js:394`
**Severidad:** critica | CAT: doble_timbrado
**Escenario:** Cualquier excepción después de :331 —un 'Execution context was destroyed' porque el portal navegó, un 'Target closed' de Browserless, un fallo de red mientras se bajan los blobs en :356-360— cae en el catch de :390 y devuelve `{ ok: false, msg: ... }` SIN error_code. En lib/facturacion.js eso no casa con ninguna rama (ticket_vencido, captcha, reintentar_despues, timbrado_sin_archivos, datos_invalidos) y va al error genérico de :392-396, que programa reintento a medianoche. La factura ya está emitida y el bot la vuelve a emitir. Es exactamente el escenario que el proyecto ya pagó una vez.


---

#### littlecaesars.js declara facturado cualquier pantalla que contenga la palabra «correo» o «email» — incluido el propio formulario que no se envió
**Archivo:** `bots/littlecaesars.js:464`
**Severidad:** critica | CAT: ok_true_sin_prueba
**Escenario:** enviarYLeer pulsa 'Enviar' con `page.evaluate(() => { const b = ...find(...); if (b) b.click(); })` SIN devolver si lo encontró, dos veces: en :364-368 (paso /lc/crear/) y en :432-436 (paso /lc/validar/, que es donde se timbra de verdad). Si el botón no está —cambió el texto, está deshabilitado, el sweetAlert lo tapa— no se envía nada. Después espera 12 s fijos y clasifica la pantalla por texto. Las tres reglas de fallo (:453 ya facturado, :455 no reconocido, :457 vencido) no casan con un formulario en blanco; entonces llega a :464 `if (/correo|email|enviad|generad|gracias/i.test(t)) return { ok: true, procesandoCorreo: true }`. Y la pantalla /lc/validar/ SIEMPRE contiene esa pala


---

#### littlecaesars.js: reintentar_despues y catch sin error_code después del envío que timbra
**Archivo:** `bots/littlecaesars.js:467`
**Severidad:** critica | CAT: doble_timbrado
**Escenario:** Cuando el segundo 'Enviar' (:432, el de /lc/validar/) sí sale y el portal responde algo que no casa con ningún patrón, :467-470 devuelve `error_code: 'reintentar_despues'` — con el CFDI posiblemente ya emitido. facturacion.js lo reintenta cada noche indefinidamente. Y el catch de :346-350 devuelve `{ok:false, msg}` sin error_code, que acaba en el error genérico con el mismo reintento. Nunca se levanta ninguna bandera de timbrado disparado: la palabra no aparece en el archivo. Peor: el reintento vuelve a gastar CapSolver (hasta 120 s de polling, :66-79) en cada vuelta.


---

#### carljr.js y littlecaesars.js escriben en el portal el correo del RESIDENTE, no el buzón de captura: el CFDI sale y el sistema no lo ve jamás
**Archivo:** `bots/carljr.js:128`
**Severidad:** critica | CAT: ticket_atascado
**Escenario:** lib/facturacion.js:151 mete `email: ticket.email` en los datos, y el propio bots/index.js:82-91 avisa en mayúsculas de que `d.email` es el del residente y `d.emailEntrega` el buzón del sistema. carljr.js hace `const correo = email || \


---

#### error_code 'ya_facturado' y 'timeout' no existen en lib/facturacion.js: el ticket vuelve al portal cada noche para siempre
**Archivo:** `bots/sushito.js:196`
**Severidad:** alta | CAT: reintento_infinito
**Escenario:** lib/facturacion.js sólo tiene rama para ticket_vencido (:262), captcha (:284), reintentar_despues (:302), timbrado_sin_archivos (:327) y datos_invalidos (:350). Todo lo demás cae al error genérico de :392-396, que programa reintento a medianoche SIN tope. sushito.js devuelve `ya_facturado` (:137, :188) y un `timeout` inventado (:196); dana.js devuelve `ya_facturado` (:109, :154) y `timeout` (:156); carljr.js `ya_facturado` (:245); littlecaesars.js `ya_facturado` (:454); caffenio.js `ya_facturado` (:138). Un ticket ya facturado —que es un estado FINAL, no recuperable— se re-encola todas las noches de aquí a la eternidad: abre Browserless, carga el portal, teclea, lee «ya fue facturad


---

#### caffenio.js no tiene implementado el timbrado y devuelve {ok:false} sin error_code: cada ticket de CAFFENIO reintenta cada noche sin poder acertar nunca
**Archivo:** `bots/caffenio.js:151`
**Severidad:** alta | CAT: reintento_infinito
**Escenario:** Cuando el portal SÍ encuentra la orden —o sea, cuando todo va bien— el bot llega a :151 y devuelve `{ ok: false, msg: \


---

#### lib/facturacion.js tira a la basura la verificación del CFDI justo cuando el XML no es un CFDI — que es cuando hacía falta
**Archivo:** `lib/facturacion.js:215`
**Severidad:** alta | CAT: verificacion_rota
**Escenario:** `const problemas = datos ? verificarCFDI(datos, {...}) : [];`. lib/cfdi.js:53 contempla precisamente ese caso: `if (!cfdi) return [{ gravedad: \


---

#### Nadie lee la propina: la lógica de wansoft está muerta y el verificador marca «grave» todas las facturas de restaurante con propina
**Archivo:** `bots/wansoft.js:303`
**Severidad:** alta | CAT: fiscal
**Escenario:** La palabra 'propina' aparece en TODO el repo sólo en wansoft.js (y en un script de correo). wansoft:303 hace `const propina = num(datos.propina) === null ? 0 : num(datos.propina)` y :779-784 calcula `totalFacturar = total - propina` — pero lib/vision.js nunca extrae `propina` y bots/index.js:62-99 nunca la normaliza, así que SIEMPRE vale 0 y «Total del ticket» y «Total a facturar» se escriben iguales. Eso significa que si el OCR leyó el importe cargado a la tarjeta (consumo + propina), wansoft le dice al portal que el consumo fue esa cantidad. En los portales de restaurante que SÍ validan contra su propio registro pasa lo contrario y es peor: youbuy.js:847 aborta con `datos_invalid


---

#### El cruce de monto de wansoft en el flujo B compara el importe contra sí mismo: la guarda es decorativa justo donde el bot escribe la cifra
**Archivo:** `bots/wansoft.js:889`
**Severidad:** alta | CAT: verificacion_rota
**Escenario:** El bloque «CRUCE DEL MONTO antes de timbrar» (:884-926) busca fuentes 'fuertes': el JSON del AJAX y «el campo del formulario». Pero `selCampo(\


---

#### wansoft.escribir() da por bueno cualquier campo que no quede vacío: el RFC —el único campo que decide de quién es la factura— nunca se coteja
**Archivo:** `bots/wansoft.js:468`
**Severidad:** alta | CAT: rfc_equivocado
**Escenario:** `escribir()` termina con `return { ok: String(leido || \


---

#### Tres bots están truncados a media línea y no cargan; el comentario de index.js afirma lo contrario del de Navojoa
**Archivo:** `bots/elcaporalrestaurantecampestre.js:351`
**Severidad:** media | CAT: codigo_muerto
**Escenario:** elcaporalrestaurantecampestre.js (corta en :351 con `if (!btnEl2) throw new Error(\


---

#### Una letra mal leída por el OCR (mefacturo.com vs .mx) manda El Caporal al bot equivocado y lo deja atascado para siempre
**Archivo:** `bots/index.js:355`
**Severidad:** media | CAT: routing
**Escenario:** El bloque de dana (:341-360) va ANTES que el de sushito (:407-426) e incluye `portalUrl.includes('mefacturo.com')`. Las dos familias se distinguen sólo por el TLD: mefacturo.mx usa #CodigoUnicoTicket/#FolioTicket/#RFC (sushito) y mefacturo.com usa #unicCode/#folio/#RFC (dana). El propio CLAUDE.md documenta que el OCR confunde letras en URLs impresas (1gasfac / lgasfac / igasfac). Si la foto de un ticket de El Caporal se lee como 'mefacturo.com/elcaporal', el ticket va a dana.js, que hace `waitForSelector(\


---

#### sushito.js y dana.js no registran page.on('dialog'), que es la causa número uno de «Target closed» documentada en este proyecto
**Archivo:** `bots/dana.js:56`
**Severidad:** media | CAT: robustez
**Escenario:** Ninguno de los dos bots de SoftRestaurant registra el handler de diálogos, pese a que la memoria del proyecto (project_puppeteer_lessons.md) y CLAUDE.md lo declaran obligatorio: un alert()/confirm() sin manejar cuelga el hilo y Browserless mata la pestaña con errores que parecen otra cosa («Session closed», «main frame too early», «frame detached»). Y estos portales sí lanzan confirmaciones: dana.js:377-383 espera un modal «¿Estás seguro… / deseas generar?». Si en algún tenant ese confirm es NATIVO en vez de DOM, la pestaña muere. En dana el catch está protegido por timbradoDisparado (bien); en sushito el catch devuelve {ok:false} sin error_code → reintento eterno, y si e


---

#### La «variante antigua» de dana.js cierra el ticket como procesado con cualquier enlace que diga PDF y sin XML que verificar
**Archivo:** `bots/dana.js:526`
**Severidad:** media | CAT: ok_true_sin_prueba
**Escenario:** Si el tenant no es el wizard (no existe #TaxRegime ni #ListTaxRegimes), dana cae al camino de :479-535. Ahí pulsa un botón de generar —eso sí lo comprueba, :502-517, y devuelve reintentar_despues honesto si no lo encuentra— pero luego busca los archivos con `find(a => /\\.pdf(\\?|$)|DownLoadPDF|descargar.*pdf|pdf.*descargar/i.test(a.href + \


---

#### normalizarDatos cablea el RFC de GPN como valor por defecto para cualquier ticket sin RFC
**Archivo:** `bots/index.js:95`
**Severidad:** media | CAT: fuga_entre_clientes
**Escenario:** `d.rfc = primero(d.rfc, 'GPR110128QD8')`. Hoy no se dispara porque lib/facturacion.js:94-97 corta antes si `!ticket.rfc`, y ese es el único llamador de detectarYFacturar. Pero es una mina: en cuanto alguien llame al router desde un script, desde el validador de agentes o desde un endpoint de admin (que es exactamente lo que pasa cuando se dan de alta portales nuevos), un ticket de OTRO cliente de G&A sin perfil fiscal se timbra a nombre de GPN Pinturas y Recubrimientos. Un CFDI al RFC equivocado no se corrige: se cancela y se vuelve a pedir dentro de plazo. Y el portal es de G&A, no de GPN: con diez clientes el valor por defecto de uno de ellos dentro del router compartido es una bomba de r


---

#### Coste por ticket y por reintento: tiempos muertos fijos que se multiplican por el reintento nocturno
**Archivo:** `bots/littlecaesars.js:373`
**Severidad:** media | CAT: coste
**Escenario:** littlecaesars.js gasta 12 s fijos tras el primer Enviar (:373) y otros 12 s tras el segundo (:438) = 24 s de espera ciega por corrida, más hasta 120 s de polling a CapSolver (:66-79, 40 iteraciones × 3 s) y la tarifa del reCAPTCHA. carljr.js espera hasta 90 s el timbrado (:335) y hasta 20 s más bajando blobs (:356-360). wansoft.js puede gastar 35 s esperando los catálogos (:718) más otros 35 s si cae al flujo B (:788) más 75 s de Turnstile (:273-287). caffenio.js gasta 9 s de sleeps fijos para no facturar nada. Todo eso se paga ENTERO otra vez en cada reintento de medianoche, y por los hallazgos anteriores hay tickets que reintentan indefinidamente. Es la causa del pendiente nº1 de CL


---

#### PINFRA devuelve reintentar_despues sobre una factura que él mismo dice que SÍ se timbró
**Archivo:** `bots/pinfra.js:325`
**Severidad:** critica | CAT: doble_timbrado
**Escenario:** Ticket de caseta Santa Ana-Altar, $139. El bot entra, agrega el ticket, confirma el uso de CFDI, espera 15 s, va a Consultar Facturas y ENCUENTRA la fila 'Facturado' con su número de transacción (línea 306 lo imprime). Sólo falla el último paso: el icono #btnSendEmail de esa fila no aparece o cambió de id. Entonces devuelve {ok:false, error_code:'reintentar_despues'} con el texto literal 'la factura SÍ se timbró (transacción X) pero no se pudo mandar al buzón'. lib/facturacion.js:302-313 lee ese error_code, pone reintento_programado = próxima medianoche y NO escala nunca. A las 00:00 el worker vuelve a correr el bot sobre el mismo ticket. El mensaje decía 'no reintentar', pero es


---

#### PINFRA marca TODOS los checkboxes de TODAS las tablas antes de facturar: un CFDI puede englobar tickets de otros residentes
**Archivo:** `bots/pinfra.js:231`
**Severidad:** critica | CAT: fuga_entre_clientes
**Escenario:** La cuenta de PINFRA se identifica con RFC + un correo asociado, y la pantalla 'Tickets por Facturar' es un carrito SERVIDOR compartido por ese RFC. Las líneas 253 y 268 dejan tickets AGREGADOS a propósito cuando algo falla ('El ticket sigue AGREGADO y reservado en el portal'). Con dos o tres corridas fallidas de residentes distintos del mismo cliente, el carrito acumula N tickets. En la siguiente corrida buena, la línea 231 hace querySelectorAll('table input[type=checkbox], table input[type=radio]') sobre TODA la página y marca cuanto encuentra, y el 'Facturar' de la línea 234 emite UN SOLO CFDI por todos. Resultado: un comprobante que mezcla consumos de varios residentes, mientras los 


---

#### 7-Eleven vuelve a pulsar FACTURAR dentro de la MISMA corrida si no reconoce la pantalla de éxito
**Archivo:** `bots/7elevenmexicosadecv.js:553`
**Severidad:** critica | CAT: doble_timbrado
**Escenario:** El bucle for de la línea 460 corre hasta 3 intentos. Dentro, la línea 496 pulsa FACTURAR y la 502 pulsa CONTINUAR del modal 'CONFIRMAR DATOS' — a partir de ahí el CFDI puede existir. El sondeo de la línea 510 espera 50 s. El propio comentario dice que el timbrado 'tarda ~30s', o sea que 50 s es un margen de 20 s. Si el timbrado tarda más, o si la pantalla final se pinta con un texto que no casa con la regex de la línea 521, facResult queda en 'timeout' y la línea 553 recarga el captcha y entra a la vuelta 2, que resuelve un captcha nuevo y VUELVE A PULSAR FACTURAR sobre el mismo ticket ya cargado en la tabla. No interviene la cola ni el reintento nocturno: es el propio bot emitiendo


---

#### OXXO GAS es inejecutable desde producción: rfcId y estacionId nunca llegan, y el fallo se reintenta cada noche para siempre
**Archivo:** `bots/oxxogas.js:276`
**Severidad:** critica | CAT: reintento_infinito
**Escenario:** La firma de facturarOxxoGas (línea 161) destructura rfcId y estacionId. bots/index.js:125 la invoca con el objeto de normalizarDatos(), que NO produce ninguno de los dos campos (los rellena como folio/importe/codigo/emailEntrega, nunca rfcId ni estacionId). El prompt de OCR de lib/vision.js:187-197 devuelve comercio, fecha, folio, bomba, litros, precioLitro, total — tampoco. Así que rfcId es undefined: la línea 273 busca una opción cuyo texto incluya 'UNDEFINED', no la encuentra, y la 276 lanza 'el RFC undefined no aparece en el selector de RFCs de la cuenta'. El catch ve timbradoDisparado=false y devuelve error_code 'reintentar_despues', que lib/facturacion.js:302-313 programa a media


---

#### Panamá declara la factura hecha sin comprobar absolutamente nada
**Archivo:** `bots/panama.js:720`
**Severidad:** critica | CAT: ok_sin_prueba
**Escenario:** Tras el click de FACTURAR (línea 609) el bot espera 5 s, intenta descargar XML y PDF, y si no consigue ninguno de los dos ejecuta la línea 720: return {ok:true, procesandoCorreo:true}. No mira la pantalla, no busca UUID, no busca folio, no comprueba que el click llegara. Hay dos caminos concretos que llevan ahí sin haber emitido nada: (a) selectMUI de la línea 511 o 518 devuelve false y el código IGNORA el valor de retorno, así que el régimen o la forma de pago quedan vacíos, el portal rechaza el submit y se queda en la misma pantalla; (b) el botón se localiza por b.textContent.includes('FACTURAR') (línea 600), que casa también con 'GENERAR FACTURA' de la navegación. En ambos cas


---

#### Home Depot: mismo ok:true sin prueba, y además cierra como 'esperando correo' facturas que son de otro
**Archivo:** `bots/homedepot.js:672`
**Severidad:** alta | CAT: ok_sin_prueba
**Escenario:** Dos caminos. (1) Línea 672: si intentarDescarga() no consigue archivos —que es el caso NORMAL según el punto 3 de 'Pendientes' del CLAUDE.md: 'Home Depot solo entrega por correo'— devuelve ok:true procesandoCorreo. La única guarda previa es la línea 656, un check por negación ('si veo la palabra error y no veo descarg/xml/pdf'). Si el modal de confirmación no apareció (línea 648) o el 'Continuar' no se encontró (línea 625 lo registra en un log y NO actúa), nunca se timbró y aun así se devuelve éxito. (2) Línea 517: cuando el portal muestra 'Reenviar Factura' significa que ESE ticket ya lo facturó alguien —posiblemente a otro RFC— y el bot devuelve ok:true procesandoCo


---

#### Farmacias Guadalajara: el click que emite no reporta si encontró el botón, y el bot da éxito igual
**Archivo:** `bots/farmaciaguadalajara.js:304`
**Severidad:** alta | CAT: ok_sin_prueba
**Escenario:** El page.evaluate de la línea 304 hace `if (btn) { btn.scrollIntoView(); btn.click(); }` y NO devuelve nada: es el incumplimiento textual del punto 3 de la doctrina, y encima en el botón que emite. Si el rótulo cambia de 'Obtener Factura' a 'Generar Factura' (o si queda dentro de un modal), no se pulsa nada. El bot duerme 12 s, lee el body —que no contiene 'excede 30 días' ni 'ya facturado'—, entra al PASO 7, no encuentra enlaces de PDF ni XML porque no hay pantalla de resultado, y ejecuta la línea 376: ok:true procesandoCorreo. Ticket en procesando_correo para siempre, sin factura, sin reintento y sin motivo. Es el mismo final que Panamá y Home Depot pero con un disparador aún má


---

#### BuzonFacturas enciende la bandera de no-retorno ANTES de saber si el botón existía, y luego devuelve ok:true
**Archivo:** `bots/buzonfacturas.js:252`
**Severidad:** alta | CAT: ok_sin_prueba
**Escenario:** La línea 252 pone facturaDisparada = true y la 255-261 hace `if (btn) { btn.removeAttribute('disabled'); btn.click(); }` sin devolver si lo encontró. Si el portal cambia el botón (es button[name=\


---

#### Los Senderos deja tickets en procesando_correo eterno cuando el click de emitir NO salió (su gemelo estrellablanca sí lo resuelve)
**Archivo:** `bots/lossenderos.js:862`
**Severidad:** alta | CAT: ok_sin_prueba
**Escenario:** La línea 862 pone timbradoDisparado=true y la 863-872 pulsa el 'Aceptar' del modal; el evaluate SÍ devuelve si encontró el botón y el resultado se guarda en pulsadoAceptar, que se imprime en el log (873)... y no se usa para nada más. Si pulsadoAceptar es false (el modal se cerró solo, el botón cambió de clase), no se emitió nada, pero la bandera queda en true y nunca se revierte. El flujo sigue: waitForFunction de 120 s que no se cumple, facturas vacío, cfdiEnPortal null tras tres sondeos de 5 s. El Caso 1 exige conError (no lo hay) y el Caso 2 exige alguna prueba (no la hay), así que cae en el Caso 3 de la línea 952: {ok:true, procesandoCorreo:true, uuid:null}. Ticket en procesa


---

#### Cinco bots escriben el régimen fiscal y el uso de CFDI a fuego (601 / G03) ignorando los del cliente
**Archivo:** `bots/7elevenmexicosadecv.js:393`
**Severidad:** alta | CAT: fiscal
**Escenario:** En 7-Eleven la condición es `if (o.value === d.regimenFiscal || o.text.includes(\


---

#### Nueve bots devuelven {ok:false} sin error_code: cada fallo determinista se reintenta cada noche para siempre
**Archivo:** `bots/autozone.js:729`
**Severidad:** alta | CAT: reintento_infinito
**Escenario:** lib/facturacion.js:392-396 trata cualquier {ok:false} sin error_code como error genérico y programa reintento a la próxima medianoche, sin tope. Conté los returns sin error_code: autozone.js 13 (54, 125, 135, 243, 272, 338, 572, 614, 628, 649, 671, 717, 729), panama.js 6 (254, 266, 275, 730 y los throws de 223/604/607 que caen en el 730), homedepot.js 4 (168, 502, 530, 662, 682), capufe.js 5 (222, 231, 302, 335, 350, 379, 384), farmaciaguadalajara.js 4 (222, 231, 317, 386), bodegaaurrera.js 3 (98, 157, 167, 325, 335), 7eleven.js 3 (167, 179, 289, 372, 567), oxxo.js 3 (123, 289, 298, 524), pinfra.js 2 (107, 331), benavides.js 1 (389). Escenario concreto y caro: un ticket de AutoZone cuyo a


---

#### CAPUFE: cinco salidas sin error_code DESPUÉS de haber pulsado 'Facturar conceptos', y sin page.on('dialog')
**Archivo:** `bots/capufe.js:379`
**Severidad:** alta | CAT: doble_timbrado
**Escenario:** La emisión real son dos clicks: 'Facturar conceptos' (línea 340) y 'Si estoy seguro' (línea 355). El resultado de confirmo NO se comprueba: si el modal no aparece, la línea 362 imprime un aviso y el bot SIGUE. Después, si textoFinal no casa con la regex de éxito, la línea 379 devuelve {ok:false, msg} SIN error_code, y el catch de la 384 hace lo mismo ante cualquier excepción posterior (los 9 s de espera y el screenshot son terreno fértil para 'Target closed', más aún porque el propio archivo documenta en la línea 264 que la sesión de Browserless se agota). Resultado: reintento a medianoche sobre un código que, según la cabecera del propio archivo (líneas 11-14 y 318-322), VAL


---

#### PINFRA se loguea con el correo del RESIDENTE: con más de un cliente, todos los tickets de casetas fallan
**Archivo:** `bots/index.js:289`
**Severidad:** alta | CAT: multicliente
**Escenario:** bots/index.js:289 invoca facturarPinfra({...datos, email: datos.email}), y datos.email es ticket.email, el correo del LOGIN del residente (lib/facturacion.js:151). La cabecera de bots/pinfra.js:8-12 es explícita: 'NO vale cualquier correo. Con buzonfacturas@serviciosga.site contesta RFC o Correo Incorrectos; con carlosguerra@grupogpn.com entra'. O sea, el portal exige un correo YA dado de alta contra ese RFC. Funciona hoy porque el único residente que sube tickets de PINFRA es el dueño de la cuenta. En cuanto una muchacha de captura o un residente cualquiera suba un ticket de caseta, la línea 151-160 devuelve datos_invalidos ('RFC o Correo Incorrectos') y el ticket va a pendiente_confirm


---

#### bots/autozonedemexico.js está TRUNCADO a media instrucción: 410 líneas de código muerto que además no parsea
**Archivo:** `bots/autozonedemexico.js:411`
**Severidad:** media | CAT: codigo_muerto
**Escenario:** El archivo termina literalmente en `await fillInput(page, sel,` — sin cerrar la llamada, la función ni el módulo. No es sintácticamente válido. Nadie lo nota porque bots/index.js no lo requiere arriba y el routing de la línea 302 ('portal === autozone || comercio.includes(autozone) || origon.cloud') captura TODOS los tickets de AutoZone y los manda a facturarAutoZone mucho antes de llegar al fallback dinámico por slug de la línea 772. Y si llegara, el pre-chequeo con vm.Script de la línea 785 lo descartaría. O sea: el archivo es inalcanzable por partida triple. El riesgo no es que corra, es que existe: duplica helpers (fillInput, selectByText, descargarArchivos) que alguien puede 


---

#### bots/oxxo.js es código muerto, pero su fallback de reimpresión devuelve ok:true habiendo hecho cero clicks comprobados
**Archivo:** `bots/oxxo.js:120`
**Severidad:** media | CAT: ok_sin_prueba
**Escenario:** Confirmado: bots/index.js:149-151 pone enginePortal='oxxo' para cualquier ticket con 'oxxo' en portal/texto/comercio, commerce/oxxo/flow.json existe (tieneEngine=true), y la línea 165-187 devuelve el resultado del engine DIRECTAMENTE tanto si es ok:true como ok:false. El bot legacy de la línea 452-455 sólo se alcanza si facturarConEngine LANZA una excepción no controlada. Es decir, oxxo.js está muerto en operación normal. El problema es qué pasa el día que el engine sí reviente: fallbackReimpresionOxxo (líneas 4-125) hace seis page.evaluate seguidos del tipo `const el = document.querySelector(...); if (el) { el.click(); }` sobre ids autogenerados de JSF (#form:j_idt62, :j_idt66, :j


---

#### CAPUFE y PINFRA: fechas y horas calculadas en UTC sobre un contenedor sin TZ, y la hora del ticket entra sin normalizar
**Archivo:** `bots/pinfra.js:275`
**Severidad:** media | CAT: fecha_zona_horaria
**Escenario:** No hay process.env.TZ en el código ni en railway.json: el contenedor corre en UTC, y México va 6-7 h por detrás. Tres efectos concretos. (1) bots/pinfra.js:275-278 arma el rango de Consultar Facturas con new Date() del servidor: si la factura se emite el último día del mes entre las 18:00 y las 24:00 hora de México, en UTC ya es el día 1 del mes siguiente, así que desde='01/MM+1' y hasta='01/MM+1' y la factura recién emitida —fechada el último día del mes anterior— queda FUERA del rango, 'emitida' sale null y se devuelve el reintentar_despues de la línea 304 sobre un CFDI que sí existe. (2) bots/pinfra.js:194 mete `hora` tal cual viene del OCR en #hora, sin ninguna normaliza


---

#### AutoZone redondea el total a entero antes de mandárselo al portal
**Archivo:** `bots/autozone.js:39`
**Severidad:** media | CAT: fiscal
**Escenario:** La línea 39 hace String(Math.round(parseFloat(total || 0))): un ticket de $648.50 se envía como 649 y uno de $399.40 como 399. El portal valida el trío código de barras + fecha + monto (comentario de la línea 8), así que con el monto redondeado no encuentra el ticket y la línea 286 devuelve datos_invalidos — 'Verifica código de barras, fecha y monto' — que manda el ticket a confirmación humana culpando al OCR cuando el OCR leyó bien. Peor caso, si el portal tolerara el redondeo, se timbraría por un importe distinto al del ticket; verificarCFDI lo cazaría (lib/cfdi.js:66-73) pero sólo como aviso si la diferencia es menor a $1, y aquí puede ser hasta $0.50 en cada sentido. Cu


---

#### Bodega Aurrera cierra tickets como 'procesado' con PDF y sin XML, y hardcodea tarjeta de crédito
**Archivo:** `bots/bodegaaurrera.js:155`
**Severidad:** media | CAT: fiscal
**Escenario:** recuperarFactura devuelve {ok:true, pdfUrl, xmlUrl:null, sinXml:true, msg:'Solo se pudo recuperar el PDF — falta el XML, revisar manualmente'}. lib/facturacion.js:200-258 ve resultado.ok, entra en la rama de éxito, y como xmlUrl es null se salta renombrarConUUID, leerCFDIdesdeUrl(null) devuelve null, verificarCFDI no corre, la fila de facturas se inserta con uuid/receptor/total en NULL, el ticket pasa a 'procesado' y al residente le llega el correo '✅ Tu factura está lista'. El campo msg con el 'revisar manualmente' se descarta por completo: nadie revisa nada. Un PDF sin XML no es un CFDI: no se puede validar ante el SAT ni deducir. Aparte, la línea 287 fija formaPagoValor='04' (tarje


---

#### AMS Integra duplicado: 1,831 líneas para un solo backend, con nueve divergencias de comportamiento entre los gemelos
**Archivo:** `bots/lossenderos.js:712`
**Severidad:** media | CAT: duplicacion
**Escenario:** estrellablanca.js (861 líneas, 796 no vacías) y lossenderos.js (970 / 901) hablan con el MISMO API (apifacturasestrellablanca.amsintegra.com.mx/main, idEmpresa GEB) y el MISMO build de React; sólo cambian el paso 1 y el claveTicket (AUTOBUS vs CONSUMO). Sólo 218 líneas son literalmente idénticas, pero están duplicados los NUEVE bloques funcionales: bajarDeS3, consulta previa de CFDI, plazo mes+7, apertura/cierre de modales, cascada RFC→régimen→uso, captura de la respuesta de generarCfdi, subida a R2, marcado de casillas y pulsación del Aceptar que timbra. Y divergen en formas que importan: (a) estrellablanca.js:179 codifica el keyUrl de S3 con encodeURIComponent y lossenderos.js


---

#### 7-Eleven abre una SEGUNDA conexión a Browserless por ticket, y eso choca con el límite de 2 concurrentes de la cola
**Archivo:** `bots/7elevenmexicosadecv.js:56`
**Severidad:** media | CAT: costo
**Escenario:** recuperarFacturaExistente hace su propio puppeteer.connect (línea 56), navega la home, pulsa CONSULTA FACTURA, teclea el folio, pulsa CONSULTAR y pulsa Descargar XML y Descargar PDF — unos 15 s de sleeps fijos más la carga. Se llama SIEMPRE en el camino de éxito (línea 544) y también en el de 'ya facturado' (353). El browser principal se cierra antes, así que no se solapan dentro de una corrida; el problema es entre corridas: procesarCola admite 2 tickets concurrentes, cada uno con hasta 2 sesiones secuenciales, y lib/facturacion.js:407-419 documenta que los tickets #229 y #230 murieron con 429 de Browserless 'en el mismo segundo'. Un ticket de 7-Eleven cuesta hoy: conexión 1 (~60 s


---

#### 7-Eleven clasifica como ÉXITO cualquier alert que contenga 'gener', 'correo' o 'enviad'
**Archivo:** `bots/7elevenmexicosadecv.js:516`
**Severidad:** media | CAT: ok_sin_prueba
**Escenario:** Tras pulsar FACTURAR, la línea 516 examina el texto del alert del portal: `if (/correo|enviad|gener|exitos|factura.*list|descarg/.test(m)) { facResult = \


---

#### facturat rellena el CP y la razón social de GPN cuando el cliente no los tiene
**Archivo:** `bots/facturat.js:223`
**Severidad:** media | CAT: multicliente
**Escenario:** Las líneas 218 y 223 hacen razonSocial || 'GPN PINTURAS Y RECUBRIMIENTOS' y codigoPostal || '80140' (el CP de la Constancia de GPN, según el propio comentario). lib/facturacion.js:94 sólo exige que el cliente tenga RFC; razon_social y codigo_postal pueden venir NULL del COALESCE de clientes/users (líneas 74-84). Escenario: un cliente nuevo dado de alta con RFC y sin domicilio fiscal completo sube un ticket de Church's Chicken. El bot captura el RFC del cliente con el nombre y el CP de GPN. El PAC rechaza el timbrado porque en CFDI 4.0 nombre + RFC + CP del receptor tienen que coincidir con la lista del SAT — y el ticket acaba en datos_invalidos culpando al portal. Si por lo que fuera p


---

#### CAPUFE elige régimen y uso de CFDI por POSICIÓN del dropdown, no por identidad
**Archivo:** `bots/capufe.js:212`
**Severidad:** media | CAT: fiscal
**Escenario:** abrirYSeleccionar(page, 0, ...) y abrirYSeleccionar(page, 1, ...) indexan el array de document.querySelectorAll('.p-dropdown') por posición: el primero se asume Régimen Fiscal y el segundo Uso CFDI. PrimeReact pinta un .p-dropdown por cada combo de la pantalla; en cuanto el portal añada uno (país, tipo de persona, plaza de cobro) los índices se corren y el bot elegirá '601' en el combo equivocado o, si la opción existe en ambos, pondrá el uso de CFDI donde va el régimen. Y cuando no encuentra la opción, abrirYSeleccionar LANZA (línea 32) → cae en el catch de la 380 → {ok:false} sin error_code → reintento nocturno eterno sobre un fallo que no cambia solo. El mismo patrón por


---

#### Contraseña root de la base de datos de producción en claro y commiteada en git
**Archivo:** `scripts/ver-tickets-lc.js:5`
**Severidad:** critica | CAT: credenciales
**Escenario:** El archivo contiene, literal y versionado: host 'yamanote.proxy.rlwy.net', puerto 13642, user 'root', password 'jynqkMxSAsopdErnUIejloYGYpbUmDSW', database 'railway'. `git ls-files` lo confirma rastreado y `git log` lo ata al commit 0d5c33c. No usa process.env, no usa lib/db, no usa ssl. Cualquiera con lectura del repo — un colaborador, un fork, un token de CI filtrado, el propio historial si el repo se hace público algún día — se conecta como root a la base de todos los clientes de G&A: tickets, ocr_json con folios y totales, RFC, razones sociales, domicilios fiscales, URLs de constancias y de todos los CFDI. No es lectura: root escribe y borra. Un `UPDATE facturas SET xml_url=...` o


---

#### reintentar-todos.js relanza el bot sobre tickets que ya están esperando el CFDI por correo: doble timbrado garantizado
**Archivo:** `scripts/reintentar-todos.js:39`
**Severidad:** critica | CAT: doble_timbrado
**Escenario:** La consulta de objetivos es `WHERE f.id IS NULL AND t.status <> 'procesado'`. Un ticket en 'procesando_correo' no tiene fila en facturas (llega después, por IMAP) y no está 'procesado' — entra en el lote. Acto seguido, la línea 57 lo pisa: `UPDATE tickets SET status='pendiente', error_msg=NULL, requiere_confirmacion=0` y llama a ejecutarFacturacion(). El portal ya emitió ese CFDI y lo está mandando al buzón. El bot vuelve a entrar, vuelve a rellenar, vuelve a pulsar Facturar: segundo CFDI para el mismo consumo. El cliente acredita IVA dos veces sobre el mismo gasto, y cancelar un CFDI ya timbrado requiere aceptación del receptor y deja huella en el SAT. Con `node scripts/reintentar-


---

#### reset-error-tickets.js borra la fila de facturas y reencola el ticket: destruye la única prueba del timbrado y provoca el segundo
**Archivo:** `scripts/reset-error-tickets.js:39`
**Severidad:** critica | CAT: doble_timbrado
**Escenario:** Para cada id de una lista fija hace `DELETE FROM facturas WHERE ticket_id = ?` sin mirar si esa fila existe ni qué contiene, y después pone el ticket en 'pendiente_confirmacion' para que la cola lo vuelva a tomar (el propio script lo anuncia: 'serán procesados en el próximo ciclo de procesarCola'). La única guarda es `ticket.status !== 'error'` (:34) — pero 'error' es exactamente el estado en que cae un ticket cuyo bot SÍ timbró y se cayó después (el catch que se traga el timbrado, punto 2 de la doctrina). En ese caso el flujo es: existía la fila con el UUID real → se borra → el ticket vuelve a la cola → el bot timbra otra vez. Segundo CFDI, y sin la fila borrada ya no qued


---

#### registrar-cfdi-huerfano.js engancha el CFDI al ticket solo por usuario + importe, sin mirar emisor ni fecha
**Archivo:** `scripts/registrar-cfdi-huerfano.js:126`
**Severidad:** critica | CAT: factura_al_ticket_equivocado
**Escenario:** La consulta que elige el ticket al que pegar la factura es: mismo user_id, sin factura, `ABS(ocr_json.total - ?) < 0.01`, `ORDER BY t.id DESC LIMIT 1`. Nada más. Ni nombre del emisor, ni fecha, ni folio. Es el ÚNICO de los tres reconciliadores que no compara el emisor — reconciliar-correo.js y registrar-cfdi-manual.js sí lo hacen, y sus comentarios explican con casos reales por qué es imprescindible ('a un ticket de café de $72 se le asignó un CFDI de HSBC'). Escenario concreto: llega al buzón el CFDI de CAFFENIO por $120 de un ticket que se borró; el mismo usuario tiene un ticket de PEMEX de $120 sin facturar; `ORDER BY t.id DESC` elige el más reciente, que es el de PEMEX; se le 


---

#### reconciliar-correo.js puede pegarle a un cliente el CFDI timbrado al RFC de otro
**Archivo:** `scripts/reconciliar-correo.js:78`
**Severidad:** critica | CAT: fuga_entre_clientes
**Escenario:** La lista de tickets candidatos se saca sin ningún filtro de usuario ni de cliente: todos los tickets del sistema que no tengan factura y no estén 'procesado'. Después, la única comprobación fiscal es `if (rfcReceptor !== RFC_GPN) continue` con RFC_GPN fijo a 'GPR110128QD8' (:22, :147). Las dos cosas juntas dan el peor cruce posible: solo se aceptan CFDI timbrados a GPN, pero se pueden pegar a tickets de CUALQUIER cliente. Un ticket de $1,000 de Daniel Ávila (persona física, régimen 621) que casualmente cuadre en importe con un CFDI de GPN — y el propio código documenta que cuadrar al céntimo es habitual, hay tres casos reales de $1,000 en los comentarios — recibe una factura em


---

#### Dos tickets del mismo importe: se elige por id, se prueba solo uno, y el CFDI se descarta o se pega mal
**Archivo:** `scripts/reconciliar-correo.js:189`
**Severidad:** alta | CAT: factura_al_ticket_equivocado
**Escenario:** Respuesta directa a la pregunta. Con dos o más tickets del mismo importe pasa esto: (1) se ordenan por `puntua` (:181-185), que cuenta palabras del comercio de más de 4 letras presentes en el emisor; (2) se toma `candidatos[0]` y SOLO ese (:189); (3) si no pasa la comprobación de emisor, `continue` (:258/:261) — el CFDI se descarta entero sin probar candidatos[1]. Los tres modos de fallo: (a) si ambos puntúan 0 —lo habitual, porque `puntua` exige >4 caracteres y por tanto ignora justo las siglas distintivas (GMV, ICR, KFC, OXXO) que la validación final sí acepta con >=3 (:238)— el `sort` es estable y gana el de menor id, es decir, el más viejo. Dos tickets de CAFFENIO de $120 de


---

#### El anti-duplicado busca el UUID dentro de xml_url, y hay facturas guardadas con nombre de timestamp
**Archivo:** `scripts/reconciliar-correo.js:171`
**Severidad:** alta | CAT: doble_timbrado
**Escenario:** Tres scripts comprueban si un CFDI ya está registrado con `SELECT ... FROM facturas WHERE xml_url LIKE '%<uuid>%'` (reconciliar-correo.js:171, registrar-cfdi-manual.js:69, registrar-cfdi-huerfano.js:114) en vez de usar la columna `uuid`, que existe y que ellos mismos rellenan. Eso solo funciona si el nombre del archivo en R2 contiene el UUID. Pero lib/imap-job.js:87 guarda con ``facturas/${uuid || Date.now()}`` — cuando el UUID no se pudo leer del XML, el archivo se llama por timestamp. Esas filas son invisibles para el LIKE, así que el mismo CFDI se vuelve a reconciliar y acaba pegado a un SEGUNDO ticket: dos tickets cerrados con un único comprobante, uno de ellos ajeno. Es exactamente


---

#### La solicitud por correo al comercio manda el RFC y la constancia de users, no de clientes
**Archivo:** `scripts/solicitar-correo.js:36`
**Severidad:** alta | CAT: factura_al_rfc_equivocado
**Escenario:** El SELECT hace `LEFT JOIN clientes c` (:40) pero de `clientes` solo saca `c.nombre` (:37). Los datos que de verdad viajan al proveedor —`u.rfc, u.razon_social, u.constancia_url`— salen de `users`. Y lib/solicitud-correo.js:18 los recibe tal cual y los pinta en el cuerpo del correo (:97-98) y adjunta la constancia descargada de `u.constancia_url` (:31). migrar-multicliente.js declara en su cabecera que `clientes` pasa a ser la fuente de verdad precisamente para que una corrección de domicilio no haya que replicarla en cada login, 'con el riesgo de que uno quede desactualizado y timbre mal — ya nos pasó algo así con RAMCAL'. Pero la migración es aditiva y `users` conserva sus columna


---

#### respaldar-y-borrar-sin-factura.js borra los tickets pendientes de todos los clientes a la vez, incluidos los que esperan CFDI
**Archivo:** `scripts/respaldar-y-borrar-sin-factura.js:95`
**Severidad:** alta | CAT: perdida_de_datos
**Escenario:** Con `--borrar` ejecuta `DELETE FROM facturas WHERE ticket_id IN (...)` y `DELETE FROM tickets WHERE id IN (...)` sobre TODO lo que devuelve la consulta de :29-34: sin filtro de cliente, sin filtro de fecha, sin excluir estados en vuelo. Entran ahí los tickets en 'procesando_correo' (el portal ya emitió y el CFDI viene en camino), los que están en 'procesando' ahora mismo en el worker, y los recién subidos hace cinco minutos. Se borra el ticket, llega el CFDI al buzón esa noche y ya no tiene a qué engancharse: factura huérfana que hay que rescatar a mano — el caso que motivó registrar-cfdi-huerfano.js ('ese ticket se había borrado en la limpieza de julio'). El DELETE de facturas es


---

#### subir-cfdi-carljr-69.js y subir-cfdi-panama-67.js suben un XML sin verificarlo y marcan el ticket como procesado
**Archivo:** `scripts/subir-cfdi-panama-67.js:31`
**Severidad:** alta | CAT: ok_sin_prueba
**Escenario:** Los dos leen un archivo de C:/Users/carlo/Downloads por ruta fija, lo suben a R2 y escriben la factura + `status='procesado'`. No parsean el XML ni una sola vez: no comprueban UUID (la constante UUID está declarada y nunca se usa para validar), ni total, ni RFC receptor, ni FechaTimbrado. Es la violación limpia del punto 1 de la doctrina: se declara facturado sin ninguna prueba positiva de que ese archivo sea el CFDI de ese ticket. Si en Downloads hay otro archivo con ese nombre, o el que se descargó era el CFDI equivocado, el ticket queda cerrado con un comprobante ajeno y nadie lo vuelve a mirar. Contrasta con verificar-carljr-117.js, que sí exige UUID + FechaTimbrado + RfcProvCertif +


---

#### ramcal-facturar-final.js timbra de verdad sin ninguna guarda, sin marca de timbrado y sin leer el resultado
**Archivo:** `scripts/ramcal-facturar-final.js:53`
**Severidad:** alta | CAT: doble_timbrado
**Escenario:** `node scripts/ramcal-facturar-final.js` — sin flags, sin --aplicar, sin confirmación — entra al portal de RAMCAL, teclea el RFC de GPN, el código 01292742361, los últimos 4 dígitos de una tarjeta real ('8510', en claro en :43) y pulsa `#btn_facturar`, que el propio log llama 'emisión real' (:52). Rompe cuatro puntos de la doctrina de golpe: (1) no hay prueba positiva — tras el click hace `waitForTimeout(6000)` y vuelca `document.body.innerText` y una captura a R2; no extrae UUID, ni folio, ni link de descarga, así que 'funcionó' es una foto que alguien tiene que mirar; (2) no existe `timbradoDisparado`: si el proceso muere entre el click y el volcado, no queda constancia de que 


---

#### El correo de reclamación fija forma de pago 'Tarjeta de crédito' y firma como GPN sea de quien sea el ticket
**Archivo:** `scripts/reclamar-cfdi-publico-general.js:76`
**Severidad:** alta | CAT: fiscal
**Escenario:** Tres problemas en el mismo correo, que es lo que el proveedor va a usar para timbrar. (1) La forma de pago está clavada en el HTML: 'Tarjeta de crédito' (:76), igual que el uso 'G03' (:75). solicitar-correo.js tiene un flag `--forma` con default 'Efectivo' precisamente porque esto varía. Si el consumo fue en efectivo, el proveedor emite el CFDI con FormaPago 04 cuando debía ser 01: la forma de pago del comprobante no coincide con la realidad, y para efectivo por encima de $2,000 el gasto directamente no es deducible. Corregirlo exige otra sustitución. (2) La firma (:90) y el remitente (:95) dicen 'GPN Pinturas y Recubrimientos' y 'GPN Facturación' en duro, pero los datos fiscales del c


---

#### registrar-cfdi-manual.js no recibió ninguno de los arreglos que sí se le hicieron a reconciliar-correo.js
**Archivo:** `scripts/registrar-cfdi-manual.js:83`
**Severidad:** media | CAT: duplicacion_de_logica
**Escenario:** Los dos scripts hacen lo mismo (emparejar CFDI con tickets por importe + parecido de emisor) con dos copias divergentes del algoritmo. registrar-cfdi-manual.js se quedó con las tres versiones viejas: (a) `objetivos.find(...)` (:83) toma el primer ticket por id sin ordenar por parecido, y si falla la comprobación descarta el CFDI sin probar los demás candidatos — el bug que reconciliar-correo.js documenta como corregido; (b) `.filter((p) => p.length > 4 ...)` (:113) descarta las siglas, que es lo que reconciliar-correo.js bajó a >=3 tras el caso 'SERVICIO GMV'; (c) `RFC_GPN = 'GPR110128QD8'` fijo (:22, :68) rechaza los CFDI de los otros nueve clientes. Y al revés, tiene una defensa que


---

#### similares-recuperar-cfdi.js diagnostica 'todavía no está facturado' cuando en realidad no encontró el botón
**Archivo:** `scripts/similares-recuperar-cfdi.js:69`
**Severidad:** media | CAT: ok_sin_prueba
**Escenario:** El click sobre 'Verificar' va en un `page.evaluate` que no devuelve nada: `if (b) b.click();` (:69). Si el portal cambia el rótulo o el botón no está visible todavía, no se pulsa nada, el script duerme 9 segundos, no encuentra el enlace del ZIP y concluye por consola: 'el portal no ofreció el zip. Puede que este ticket todavía no esté facturado' (:80). Ese mensaje es el opuesto de la verdad y es el que va a leer el operador. La acción natural ante 'no está facturado' es mandar el ticket a facturar — y el ticket SÍ estaba facturado, porque el script existe precisamente para recuperar el CFDI de uno ya timbrado. Resultado: segundo CFDI en Factura-T por un consumo ya amparado. Es el


---

#### releer-orler.js devuelve tickets a la cola sin comprobar si ya tienen factura
**Archivo:** `scripts/releer-orler.js:32`
**Severidad:** media | CAT: doble_timbrado
**Escenario:** Reprocesa el OCR de los ids que se le pasen y, si ahora sale el carril, hace `UPDATE tickets SET ocr_json=?, status='pendiente', error_msg=NULL, reintento_programado=NULL`. La única guarda es `if (!d.carril) continue` (:29). No mira `facturas`, no mira el status actual. Si el ticket ya está 'procesado' con su CFDI, o está en 'procesando_correo' esperándolo, lo devuelve igualmente a la cola y el bot vuelve a facturar. Los ids que la cabecera cita (207, 229, 230) ya no significan hoy lo que significaban: el sistema va por el #387. El riesgo es exactamente el de reintentar-todos.js pero por otra puerta, y aquí es más silencioso porque el script se presenta como una corrección de OCR, no 


---

#### asociar-cfdi.js no compara el RFC del receptor con el del cliente, y se salta la comprobación de total si el OCR no lo leyó
**Archivo:** `scripts/asociar-cfdi.js:59`
**Severidad:** media | CAT: factura_al_rfc_equivocado
**Escenario:** Dos huecos en el script que existe precisamente para validar antes de escribir. (1) El RFC receptor se lee (:36), se imprime (:55) y se guarda (:70) pero nunca se compara contra el RFC del cliente dueño del ticket — ni siquiera se consulta `clientes`; el SELECT del ticket (:46) no lo trae. Se puede colgar del ticket del cliente B un CFDI timbrado al RFC del cliente A y el script dice '✅ Verificaciones OK'. El fallback de lectura empeora el dato: `campo(xml, /Rfc=\


---

#### migrar-multicliente.js crea la fuente de verdad nueva pero no migra ningún lector: quedan dos RFC
**Archivo:** `scripts/migrar-multicliente.js:33`
**Severidad:** media | CAT: fiscal
**Escenario:** La migración es explícitamente aditiva (:33-35): crea `clientes`, añade `users.cliente_id`, copia los datos fiscales, y deja las columnas de `users` intactas 'para que nada existente deje de funcionar mientras se migra el código'. El problema es que el paso 'migrar el código' no está en ninguna parte y el repo quedó a medias: rellenar-datos-cfdi.js:13-14, similares-recuperar-cfdi.js:35-37 y reclamar-cfdi-publico-general.js:38-42 usan `COALESCE(c.rfc, u.rfc)` — bien; pero solicitar-correo.js:36 lee `u.rfc` a pelo, y reconciliar-correo.js:22, registrar-cfdi-manual.js:22, recuperar-arco.js:15, reconciliar-ramcal.js:6, reconciliar-oxxogas-t02.js:6, reconciliar-enerfueltech.js:6, reconci


---

#### Los scripts de reconciliación fijan user_id=1 en la fila de facturas sin mirar de quién es el ticket
**Archivo:** `scripts/recuperar-arco.js:86`
**Severidad:** media | CAT: fuga_entre_clientes
**Escenario:** recuperar-arco.js declara `USER_ID = 1` (:13) y lo usa en el INSERT de facturas (:86) aunque el ticket al que se engancha salga de un mapa fijo de ids (:16) que puede pertenecer a otro usuario. Lo mismo hacen reconciliar-ramcal.js:5+74, reconciliar-oxxogas-t02.js:5, reconciliar-enerfueltech.js:5, reconciliar-gasolineras-batch.js:19+196 y, como fallback, registrar-cfdi-huerfano.js:121 (`const userId = dueno ? dueno.id : 1`). Consecuencia: la fila de `facturas` queda colgada del usuario 1 (GPN) mientras el ticket cuelga de otro. Cualquier listado o reporte que filtre facturas por user_id le enseña a GPN la factura de otro cliente y se la esconde a su dueño, que ve el ticket 'procesado' sin f


---

#### Las sondas que 'solo validan' reservan el folio en el portal y dejan el ticket muerto para el bot
**Archivo:** `scripts/probe-pioneros4.js:264`
**Severidad:** media | CAT: ticket_atascado
**Escenario:** Varios probe-*/recon-* pulsan botones que declaran no timbrar pero que sí consumen el folio en el portal. probe-pioneros4.js PASO 5 pulsa `#btnAgregar` — 'valida/agrega el ticket, NO timbra'— tras resolver un captcha de imagen con CapSolver. Pero el propio repo documenta que esa acción no es inocua: sincronizar-deteccion-bots.js, en la ficha de CAPUFE, avisa 'Consultar el código lo RESERVA: si se valida y no se llega a Facturar conceptos, queda tomado'; y recon-pinfra-modal.js abre con 'El ticket #210 sigue reservado en Tickets por Facturar'. Correr una sonda sobre un ticket de un cliente real deja el folio tomado en el portal; después el bot de producción entra, el portal responde 


---

#### verificar-carljr-117.js escribe CFDI reales dentro del árbol de trabajo de git
**Archivo:** `scripts/verificar-carljr-117.js:53`
**Severidad:** baja | CAT: credenciales
**Escenario:** Guarda el XML y el PDF timbrados en `C:/Users/carlo/portal-facturas/scripts/tmp_carljr_117.xml` y `.pdf`, dentro del repositorio. El .gitignore cubre `tmp/` (el directorio) y `.probe-*/`, pero no `scripts/tmp_*`: un `git add .` en una sesión posterior mete en el historial documentos fiscales reales con RFC emisor y receptor, folio, importe y sello del PAC. Hoy no están en el árbol (los borraron), pero el script los vuelve a crear cada vez que se ejecuta. El comentario del .gitignore dice literalmente que hay una carpeta que nunca debe subirse porque 'aqui han llegado a caer credenciales y CFDI reales' — la preocupación está identificada, la ruta que usa este script se escapa de ella.


---

#### ciclo-facturacion.js reencola tickets YA TIMBRADOS que esperan el CFDI por correo — doble CFDI en serie
**Archivo:** `scripts/ciclo-facturacion.js:63`
**Severidad:** critica | CAT: doble_timbrado
**Escenario:** Un ticket de OXXO GAS se timbra bien. lib/facturacion.js:192 lo deja en status='procesando_correo' con error_msg NULL, y la fila en `facturas` NO existe todavía: la crea lib/imap-job.js cuando llega el correo, que puede tardar horas. Se corre `node scripts/ciclo-facturacion.js`. La consulta de accionables() en la línea 60-64 es `WHERE f.id IS NULL AND t.status <> 'procesado'` — 'procesando_correo' NO está excluido y f.id ES NULL, así que el ticket entra. El filtro IRRECUPERABLE de la línea 65 mira error_msg, que está vacío, así que pasa. La línea 88 pasa ese id a reintentar-todos.js, que en su línea 56-59 hace UPDATE tickets SET status='pendiente', error_msg=NULL, requiere_confir


---

#### probe-capufe.js se llama sonda y TIMBRA un CFDI real con un código de ticket hardcodeado
**Archivo:** `scripts/probe-capufe.js:106`
**Severidad:** critica | CAT: timbrado_no_autorizado
**Escenario:** La cabecera (líneas 1-6) dice literalmente 'Sonda de reconocimiento DOM real'. Todo el vocabulario del repo asocia probe-* a solo lectura, y 14 de los otros probe-* del rango lo declaran explícitamente ('⛔ NO TIMBRA'). Este no: la línea 95 clava `const CODIGO = '5CBGBKG94776BDZLHQ'; // ticket #118 real` y la línea 106-110 hace click en 'Facturar conceptos (EMISIÓN REAL)'. Con CAPUFE eso tiene un filo doble que el propio repo documenta en scripts/facturar-capufe-199.js:3-6: consultar el código LO RESERVA y, una vez emitido, CAPUFE avisa que el CFDI no se puede corregir ni remitir a otro RFC. Correr este 'probe' para 'ver cómo es el DOM' emite una factura real a GPR110128QD8 (hardcode


---

#### correr-ticket.js y facturar-ticket.js llaman a ejecutarFacturacion sin mirar el status ni tomar el candado 'procesando'
**Archivo:** `scripts/facturar-ticket.js:28`
**Severidad:** critica | CAT: doble_timbrado
**Escenario:** facturar-local.js:8-13 y facturar-todo.js:13-17 documentan a fondo la carrera con el worker y por eso ponen `UPDATE tickets SET status='procesando'` ANTES de llamar al pipeline (facturar-local.js:31, facturar-todo.js:71), y facturar-local.js:25 además salta los que ya están en 'procesado'. Estos dos no hacen ninguna de las dos cosas: facturar-ticket.js lee el status en la línea 21, lo imprime en la 25 y llama a ejecutarFacturacion en la 28 pase lo que pase; correr-ticket.js hace exactamente lo mismo en las líneas 23 y 31. Dos consecuencias concretas. (1) `node scripts/facturar-ticket.js 288` sobre un ticket ya 'procesado' con su CFDI en `facturas` vuelve a correr el bot y emite un segund


---

#### oxxogas-procesar-ticket.js timbra, sube el CFDI a R2 y no escribe una línea en la BD: el ticket queda listo para reintentarse
**Archivo:** `scripts/oxxogas-procesar-ticket.js:191`
**Severidad:** critica | CAT: doble_timbrado
**Escenario:** El script hace el ciclo completo: agrega el ticket (línea 97), selecciona forma de pago, pulsa FACTURAR TICKETS (línea 135, 'emisión real'), busca la factura en Mis Facturas, la descarga y la sube a R2 (líneas 191-192). Y ahí termina: `process.exit(0)`. Nunca hace INSERT en `facturas` ni UPDATE de `tickets`. Resultado: el CFDI existe en el SAT, el XML existe en R2, y el sistema sigue creyendo que el ticket no tiene factura — lo recogerá procesarReintentos (lib/imap-job.js:270) o rescatarTicketsSinEncolar (worker.js:226) o el propio ciclo-facturacion, y se emitirá un segundo. Tres agravantes en el mismo archivo. (a) Línea 81: `page.select('#rfc', '2186617')`, un id interno opaco del


---

#### pinfra-descargar-cfdi.js registra como 'completado' un CFDI que su propia verificación acaba de marcar como GRAVE
**Archivo:** `scripts/pinfra-descargar-cfdi.js:130`
**Severidad:** critica | CAT: fiscal
**Escenario:** Las líneas 129-131 llaman a verificarCFDI y pintan cada problema con 🛑 o ⚠️. Y luego no hacen nada con el resultado: la línea 133 sube el XML a R2, la 139-146 inserta en `facturas` con status='completado' y la 147 deja el ticket en 'procesado'. El único rastro del problema es la columna `verificacion` (línea 146), un texto que ninguna pantalla lee. Compárese con scripts/lc-rescatar-cfdi.js:55 — `if (graves.length) { console.log('🛑 con problemas graves: no se toca la BD'); continue; }` — que es la conducta correcta y vive en el mismo repo. Dos defectos más lo convierten en casi garantizado: (a) la línea 130 pasa `totalEsperado: 139` HARDCODEADO, el total del ticket #208, 


---

#### pinfra-facturar-pendientes.js timbra TODO lo que haya en la cola del portal y manda el CFDI a un correo personal
**Archivo:** `scripts/pinfra-facturar-pendientes.js:42`
**Severidad:** alta | CAT: timbrado_no_autorizado
**Escenario:** Tres problemas encadenados. (1) Las líneas 42-46 marcan TODOS los checkboxes/radios de la tabla ('por si el portal exige selección') y la línea 49-53 pulsa Facturar. 'Tickets por Facturar' es una lista del lado del servidor asociada a la cuenta del RFC: lo que haya quedado ahí de una sesión anterior, o de otro ticket que alguien agregó y no timbró, se emite también. No hay forma de acotarlo a un ticket. (2) La línea 11 pone `const CORREO = process.argv[3] || 'carlosguerra@grupogpn.com'` y la línea 25 lo teclea en el portal: sin tercer argumento, el CFDI de un cliente de la plataforma se manda al buzón personal de un empleado de GPN, no a buzonfacturas@serviciosga.site. IMAP nunca 


---

#### candado-duplicados.js borra tickets que ya timbraron y están esperando su CFDI por correo
**Archivo:** `scripts/candado-duplicados.js:77`
**Severidad:** alta | CAT: perdida_de_datos
**Escenario:** La decisión de qué se conserva sale de la subconsulta `tiene_factura` de las líneas 35-36: cuenta filas de `facturas` con xml_url no nulo. Un ticket en 'procesando_correo' —que YA se timbró en el portal y espera a que lib/imap-job.js recoja el correo— todavía no tiene fila en `facturas`, así que tiene_factura=0. Si ese ticket es el 'sobrante' de un grupo duplicado (línea 62), la línea 67 lo mete en aBorrar y la 77 lo borra. Consecuencias en cadena: el CFDI llega minutos después, imap-job no encuentra a qué ticket asociarlo y queda huérfano; el residente vuelve a subir la foto porque 'se perdió'; y ahora el nuevo ticket dispara un segundo timbrado del mismo folio. Encima, la l


---

#### asociar-cfdi.js promete verificar el RFC del receptor y no lo verifica; el regex puede devolver el RFC del emisor
**Archivo:** `scripts/asociar-cfdi.js:59`
**Severidad:** alta | CAT: fiscal
**Escenario:** La cabecera (líneas 8-9) dice 'Verifica ANTES de escribir que el XML corresponda de verdad al ticket: compara el TOTAL del comprobante contra el del ticket y el RFC del receptor'. El código sólo compara el total (líneas 59-62) y comprueba que el UUID no esté ya usado (63-67). La variable `receptor` se extrae en la línea 36, se IMPRIME en la 55, se guarda en la BD en la 76 — y nunca se compara contra el RFC del dueño del ticket, que estaría a un JOIN de distancia (el ticket ya se lee en la línea 46). Peor: el fallback del regex de la línea 36 es `campo(xml, /Rfc=\


---

#### migrar-residentes-cliente.js reasigna a GPN todos los residentes sin cliente, y server.js crea todos los residentes sin cliente
**Archivo:** `scripts/migrar-residentes-cliente.js:31`
**Severidad:** alta | CAT: fuga_entre_clientes
**Escenario:** La línea 31 hace `UPDATE residentes SET cliente_id = ? WHERE cliente_id IS NULL` con CLIENTE_ORIGEN = 1 (GPN). Es correcto UNA vez, para los residentes históricos. El problema es que el alta de residentes nunca se actualizó: server.js:627 y server.js:353 insertan `INSERT INTO residentes (nombre, disponible) VALUES (?, ?)` — sin cliente_id. Así que cada residente que da de alta CUALQUIER cliente nace con cliente_id NULL. La segunda vez que alguien corra este script (y la cabecera no dice que sea de un solo uso; el propio script informa cuántos huérfanos hay y ofrece --aplicar, lo cual invita a repetirlo) los empleados que el admin de DGA acaba de capturar pasan a ser de GPN. Eso es ex


---

#### oxxogas-sesion.js guarda en MySQL, en claro, una cookie de sesión viva del portal fiscal — y el respaldo diario la publica en R2
**Archivo:** `scripts/oxxogas-sesion.js:106`
**Severidad:** alta | CAT: credenciales
**Escenario:** Las líneas 106-109 hacen `INSERT INTO config (clave, valor) ... ON DUPLICATE KEY UPDATE` con `JSON.stringify(cookies)`: ci_sessions y las cookies del WAF de Incapsula, en texto plano, en una tabla sin cifrado. Esa cookie es una sesión AUTENTICADA de facturacion.oxxogas.com — quien la tenga puede facturar, ver 'Mis Facturas' (el historial fiscal completo de la cuenta) y descargar los XML de todo lo emitido. La cabecera del script razona que es mejor que el .env 'porque el .env se versiona por error'; el razonamiento se cae porque lib/backup-db.js:17-24 hace `SHOW TABLES` y vuelca TODAS las tablas —config incluida— a un JSON gzip que la línea 35 sube a R2 con subirArchivoR2, y storage


---

#### Seis copias de enerfueltech-* timbran el mismo folio hardcodeado, sin prueba y sin bandera de timbrado disparado
**Archivo:** `scripts/enerfueltech-enviar.js:108`
**Severidad:** alta | CAT: doble_timbrado
**Escenario:** enerfueltech-enviar.js, -enviar-correo.js, -facturar-final.js, -final2.js, -final3.js y -final4.js son el mismo flujo con `const REFERENCIA = '049847152458CE1'` en la línea 5 de cada uno. Cualquiera de los seis, corrido sin argumentos (no aceptan ninguno), vuelve a pulsar FACTURAR sobre la misma referencia. Cuatro incumplimientos de doctrina en el mismo archivo: (1) la prueba de éxito es leer 2500 caracteres del body (línea 111) — no hay UUID, folio ni enlace; (2) no hay `let timbradoDisparado = false` antes del try: el catch de la línea 122 devuelve el mismo '❌ mensaje + exit 1' tanto si falló antes del click de la línea 108 como si falló DESPUÉS, cuando el CFDI ya existe — y 


---

#### facturar-todo.js timbra tickets cuyo OCR el residente todavía no ha confirmado
**Archivo:** `scripts/facturar-todo.js:44`
**Severidad:** alta | CAT: fiscal
**Escenario:** La consulta de las líneas 39-45 excluye 'procesado', 'procesando_correo' y 'procesando' — bien — pero no filtra `requiere_confirmacion`. Cuando el OCR sale con poca confianza, lib/facturacion.js:352 deja el ticket en 'pendiente_confirmacion' con requiere_confirmacion=1 precisamente para que una persona corrija folio, fecha y total antes de timbrar; server.js:935 y :962 implementan esa pantalla y worker.js:226 respeta la bandera (sólo recoge requiere_confirmacion=0). facturar-todo.js se la salta: recoge esos tickets y los pasa por ejecutarFacturacion, que tampoco la mira. Se emite un CFDI con el folio o el importe que el OCR leyó mal. En CFDI eso no se corrige: se cancela y se vuelve a


---

#### 80 scripts suben capturas de pantalla con datos fiscales a un bucket R2 público que nada purga
**Archivo:** `scripts/probe-capufe.js:14`
**Severidad:** media | CAT: fuga_de_datos
**Escenario:** 80 de los 160 archivos del rango llaman a subirArchivoR2 con claves del tipo `debug/<portal>_<etiqueta>_${Date.now()}.png`, y casi todas son `page.screenshot({ fullPage: true })` de un formulario de facturación ya relleno: RFC, razón social, domicilio fiscal, régimen, importes y folio del ticket. Algunas son peores: diag-igasfac-*.js, explorar-igasfac-correo.js y oxxogas-verificar-mis-facturas.js capturan pantallas de una sesión AUTENTICADA, incluido el listado 'Mis Facturas'. storage/r2.js:22 construye la URL con R2_PUBLIC_URL y lib/backup-db.js:28 confirma por escrito que el bucket es público. La única barrera es adivinar el milisegundo del Date.now(); conocido el día en que se corr


---

#### alta-cliente.js lleva versionados el CURP, RFC, domicilio y correo de una persona física real
**Archivo:** `scripts/alta-cliente.js:21`
**Severidad:** media | CAT: datos_personales
**Escenario:** Las líneas 20-43 contienen el expediente fiscal completo de Daniel Alejandro Guerra Ávila: idCIF 16020603575, CURP GUAD770708HSRRVN08, RFC GUAD770708BQ0, correo trasladosdga@gmail.com y el domicilio con calle, número, colonia, municipio y estado. CURP + RFC + domicilio de una persona física es el paquete con el que se suplanta una identidad ante el SAT y ante cualquier institución mexicana. Está en el árbol de git, así que sigue ahí aunque se borre el archivo, y viaja en cada clon del repo. Además el script está construido para editarse y volver a correrse: el objeto CLIENTE es una constante, no argumentos, así que el patrón que enseña es 'pega aquí los datos del siguiente cli


---

#### ramcal-facturar-final.js timbra con los últimos 4 dígitos de una tarjeta real escritos en el código
**Archivo:** `scripts/ramcal-facturar-final.js:43`
**Severidad:** media | CAT: datos_personales
**Escenario:** La línea 43 teclea '8510' en el campo `cuentapago` del portal de RAMCAL — son los últimos cuatro dígitos de la tarjeta con la que se pagó ese consumo, un dato de medio de pago de un cliente, en claro y versionado (ramcal-descargar.js:48 repite el mismo valor). Junto con el código '01292742361' de la línea 36 y el RFC de la línea 25, el archivo es un juego completo de credenciales de facturación de un consumo concreto: cualquiera con acceso al repo puede reemitir esa factura. Y el script la reemite: la línea 53 pulsa #btn_facturar ('emisión real') y la única comprobación posterior es imprimir 2000 caracteres del body (línea 56) y un screenshot (línea 63) — sin UUID, sin foli


---

#### El ticket que el sistema dice que necesita al usuario es justo el que la UI le esconde y nadie vuelve a tocar
**Archivo:** `public/mis-tickets.html:412`
**Severidad:** critica | CAT: ticket_atascado_para_siempre
**Escenario:** Un residente sube 12 tickets en lote (el flujo que el propio dashboard recomienda: \


---

#### XSS almacenado por el nombre del archivo subido, que se ejecuta en la sesión del dueño de G&A (la única que escribe código de bot a disco)
**Archivo:** `public/mis-tickets.html:480`
**Severidad:** critica | CAT: seguridad
**Escenario:** Una capturista de cualquier cliente (o alguien que se registre solo: /register es abierto, server.js:471) renombra una foto de ticket a `t<img src=x onerror=\


---

#### El panel admin inyecta el nombre del comercio del OCR dentro de un atributo onclick con comillas dobles, escapando solo la comilla simple
**Archivo:** `public/admin-residentes.html:484`
**Severidad:** alta | CAT: seguridad
**Escenario:** El OCR de un ticket devuelve un comercio con comilla doble — o alguien lo provoca a propósito poniendo en la foto un rótulo tipo `X\


---

#### Un ticket que se queda en 'procesando' (deploy de Railway a media facturación) no tiene NINGUNA salida desde la UI
**Archivo:** `public/mis-tickets.html:424`
**Severidad:** alta | CAT: ticket_atascado_para_siempre
**Escenario:** lib/facturacion.js:136 pone status='procesando' y reintento_programado=NULL antes de arrancar Puppeteer. Railway hace autodeploy en cada push a main (CLAUDE.md lo dice: \


---

#### Cualquier rol admin —incluido el admin de un cliente— puede descargar la foto de CUALQUIER ticket de CUALQUIER otro cliente por enumeración de id
**Archivo:** `server.js:1355`
**Severidad:** alta | CAT: fuga_entre_clientes
**Escenario:** El admin de GPN (rol='admin', cliente_id=GPN) abre la consola y hace un bucle sobre /api/tickets/1/imagen ... /api/tickets/5000/imagen. El endpoint comprueba SOLO `req.session.userRol === 'admin'` y, si lo es, consulta `WHERE id = ?` sin ningún filtro de cliente. Se baja las fotos de los tickets de Daniel Ávila y de los otros ~28 clientes: importes, folios, tarjetas parcialmente visibles, ubicaciones y hábitos de compra de contribuyentes que son competencia entre sí. Es exactamente el escenario que filtroAlcance() fue escrito para impedir, y todo el resto del sistema lo respeta: /api/tickets, /api/facturas, /api/admin/validacion-manual y hasta el ZIP de facturas usan filtroAlcance — es


---

#### Clave `folio` duplicada en LABELES: el modal de confirmación etiqueta mal el campo folio de TODOS los portales y le pide al usuario el dato equivocado
**Archivo:** `public/dashboard.html:714`
**Severidad:** alta | CAT: datos_invalidos_inducidos
**Escenario:** El objeto LABELES define `folio: 'Folio'` en la línea 704 y vuelve a definir `folio: 'No. de Ticket (código bajo el código de barras, 18–23 dígitos) ✏️'` en la 714. En JavaScript gana la última, así que la primera se pierde. Consecuencia: cuando llega un ticket de OXXO (campos ['fecha','folio','idVenta','total']), de Gasmaz (['portalUrl','referencia','folio','total']) o de Home Depot (['folio','fecha','total']), el modal etiqueta el campo folio como \


---

#### El alcance de lectura es del CLIENTE pero el de escritura es del USUARIO: la UI ofrece acciones sobre tickets de compañeros que fallan en silencio o devuelven ok:true sin hacer nada
**Archivo:** `public/mis-tickets.html:548`
**Severidad:** alta | CAT: correccion
**Escenario:** Dos capturistas de GPN, Ana y Rosa. /api/tickets usa filtroAlcance (alcance de cliente, server.js:1318) así que Ana ve en su lista los tickets que subió Rosa. Ana cambia el select \


---

#### Se puede eliminar un ticket en 'procesando_correo' sin ninguna advertencia de que el CFDI ya viene en camino
**Archivo:** `public/mis-tickets.html:424`
**Severidad:** media | CAT: doble_timbrado
**Escenario:** 'procesando_correo' significa exactamente que el bot YA pulsó el botón que emite y el CFDI está viajando por IMAP hacia buzonfacturas@serviciosga.site. La UI permite borrar ese ticket y el diálogo dice solo \


---

#### Salvo Mis Facturas, ninguna pantalla maneja el 401: la sesión caducada se disfraza de avería y el poll sigue golpeando cada 6 s indefinidamente
**Archivo:** `public/mis-tickets.html:721`
**Severidad:** media | CAT: correccion
**Escenario:** Caduca la sesión (el caso que mis-facturas.html:229-231 documenta como \


---

#### RFC de GPN cableado como valor por defecto en el normalizador de todos los bots
**Archivo:** `bots/index.js:95`
**Severidad:** alta | CAT: factura_al_rfc_equivocado
**Escenario:** normalizarDatos() cierra con `d.rfc = primero(d.rfc, 'GPR110128QD8')` — el RFC de GPN Pinturas — y lo mismo con régimen '601' y uso 'G03'. Si por cualquier camino los datos llegan al bot con rfc vacío o en blanco (y '' es falsy, así que un campo presente pero vacío también dispara el fallback), el bot teclea el RFC de GPN en el portal de otro cliente y se emite un CFDI a nombre de GPN por un gasto de Daniel Ávila. Eso no se corrige: como recuerda el propio comentario de validacion-manual.html:176-178, \
