# Plan de mejoras — portal-facturas

**Origen:** auditoría del 13-sep-2026 (`docs/auditoria-2026-09-13.md`).
**Estado:** propuesta. Nada de esto está implementado.
**Cómo usarlo:** las fases están ordenadas por daño evitado / esfuerzo. Marca las casillas conforme avances.

Leyenda de esfuerzo: **S** = menos de medio día · **M** = 1-2 días · **L** = una semana o más.

---

## FASE 0 — Antes que nada (horas, hoy)

Tres cosas que están causando daño ahora mismo y se arreglan en minutos.

- [ ] **0.1 · Rotar la contraseña de MySQL de producción** — `S`
  Está en `.env.example` (versionado desde el commit inicial) y en `scripts/ver-tickets-lc.js:5`, en claro, apuntando al proxy TCP **público** de Railway. Rotar es obligatorio: borrar los archivos no la saca de los 488 commits del historial.
  Después: dejar `.env.example` sólo con los NOMBRES de las variables y añadirlo al `.gitignore` si se prefiere no tenerlo.
  *Verificación:* intentar conectar con la clave vieja y que falle.

- [ ] **0.2 · Apagar el borrado automático de CFDI** — `S`
  `worker.js:249` y `worker.js:254` llaman a `limpiarFacturasVencidas()`, que borra el XML y el PDF de R2 a los 60 días (`lib/imap-job.js:309-331`). El XML **es** el CFDI y hay que conservarlo cinco años.
  Comentar las dos líneas hoy; la política de retención se decide en la fase 5.
  *Verificación:* `GET /api/facturas/descargar-zip?mes=<un mes de hace 3 meses>` deja de devolver 404.

- [ ] **0.3 · Inventariar el daño ya hecho** — `S`
  Revisar en los respaldos de `backups/` de R2 qué facturas tienen `xml_url = NULL` y recuperar los archivos que la limpieza ya borró.

- [ ] **0.4 · Rotar también la cookie de OXXO GAS** — `S`
  `scripts/oxxogas-sesion.js:106` la guarda en claro en la tabla `config`, y `lib/backup-db.js` la publica en R2 cada 24 h dentro del dump completo.

---

## FASE 1 — Cerrar el grifo del doble timbrado (1-2 días)

El objetivo es que sea **estructuralmente imposible** emitir dos CFDI del mismo ticket, sin depender de que 49 bots se porten bien.

- [ ] **1.1 · Guarda de idempotencia + candado optimista en `ejecutarFacturacion`** — `S` — *el arreglo con mejor relación daño/esfuerzo de todo el plan*
  En `lib/facturacion.js`, antes de llamar a `detectarYFacturar`:
  ```
  a) SELECT 1 FROM facturas WHERE ticket_id = ?   → si existe, abortar sin facturar.
  b) UPDATE tickets SET status='procesando' … WHERE id = ? AND status <> 'procesando'
     → si affectedRows === 0, otro proceso ya lo tomó: abortar.
  ```
  Dos consultas cierran las ocho rutas de duplicado encontradas, incluidas las de los scripts que llaman a `ejecutarFacturacion` por fuera.
  *Referencia:* `lib/facturacion.js:136` · *Auditoría §2 ①*

- [ ] **1.2 · `default` explícito en el switch de `error_code`** — `S`
  Hoy un `error_code` desconocido cae en el error genérico y **programa reintento nocturno**. Invertir la regla: código no reconocido → error sin reintento + aviso al admin. 21 bugs silenciosos se vuelven ruido visible el primer día.
  *Referencia:* `lib/facturacion.js:392` · *Auditoría §2 ②*

- [ ] **1.3 · Rama propia para `ya_facturado`** — `S`
  18 bots lo devuelven y no existe la rama. Debe: dejar el ticket en `error`, **sin reintento**, con mensaje "el CFDI ya existe en el portal, hay que recuperarlo" y mandarlo a validación manual.
  *Referencia:* `lib/facturacion.js:392` · *Auditoría §2 ②*

- [ ] **1.4 · Tratar `timeout` como `timbrado_sin_archivos`** — `S`
  Tres archivos lo devuelven, incluido `commerce/rendichicas/hooks.js:61` **después** del click que emite.

- [ ] **1.5 · Cambiar `reintentar_despues` → `timbrado_sin_archivos` en los siete puntos posteriores a la emisión** — `M`
  | Archivo | Línea |
  |---|---|
  | `bots/carljr.js` | 340 |
  | `bots/pinfra.js` | 325 |
  | `bots/gasolineros.js` | 274 |
  | `bots/littlecaesars.js` | 467 |
  | `bots/qualligas.js` | 477 |
  | `bots/orler.js` | 348 (además le falta el `error_code`) |
  | `commerce/rendichicas/hooks.js` | 61 |
  *Auditoría §2 ③*

- [ ] **1.6 · Tope de reintentos** — `S`
  `reintentar_despues` no tiene límite: reintenta cada noche hasta que `cleanupTickets` borre el ticket a los 30 días. Poner un máximo (5 noches) y no reintentar nunca más allá del plazo del portal.
  *Referencia:* `lib/facturacion.js:302`

- [ ] **1.7 · El bucle de 7-Eleven no debe volver a pulsar FACTURAR** — `S`
  `bots/7elevenmexicosadecv.js:460-497`: el click de emisión está dentro del bucle de 3 intentos de captcha. El reintento debe reiniciar sólo el captcha, nunca reenviar el formulario.

- [ ] **1.8 · Mover los scripts peligrosos y ponerles seguro** — `S`
  22 scripts timbran llamando a un bot directamente, sin mirar el status del ticket ni tomar candado. Mover a `scripts/_peligrosos/`, exigir `--confirmar` y hacer que pasen por `ejecutarFacturacion` (que tras 1.1 ya tiene candado) en vez de llamar al bot a pelo.
  Los tres más urgentes, porque reencolan tickets **ya timbrados** que esperan su CFDI:
  `scripts/ciclo-facturacion.js:63`, `scripts/reintentar-todos.js:39`, `scripts/releer-orler.js:32`.
  Renombrar `scripts/probe-capufe.js` — es una "sonda" que emite un CFDI real (línea 106).
  *Auditoría §3.4*

---

## FASE 2 — Que la factura salga a nombre de quien toca y llegue donde toca (2-3 días)

- [ ] **2.1 · `emailEntrega` sustituido en el router, no elegido por el bot** — `M` — *cambio de diseño, ver §Mejoras estructurales*
  En `bots/index.js :: normalizarDatos`, que `datos.email` **sea ya** el buzón de captura y el del residente viaje aparte como `datos.emailResidente`. Así el bot que se equivoca es el que tiene que esforzarse, no al revés.
  Hoy sólo 9 de 49 bots usan `emailEntrega`.
  *Referencia:* `bots/index.js:82-92`, `lib/facturacion.js:151` · *Auditoría §2 ⑥*

- [ ] **2.2 · Arreglar los bots que mandan el CFDI al correo del residente** — `M`
  - `bots/carljr.js:128` — el comentario dice que va al buzón y el código manda al residente.
  - `bots/albatros.js:105` — pone el residente en `#email` y el buzón en `#emailopc`; invertir.
  - `bots/index.js:289` — PINFRA se loguea con el correo del residente.

- [ ] **2.3 · Los cinco bots que nunca escriben correo y devuelven `procesandoCorreo`** — `M`
  `g500`, `gasolineros`, `igasfac`, `orsan`, `oxxogas`. O escriben el buzón, o no pueden devolver `procesandoCorreo`: hoy el 100 % de esos tickets muere a los 60 minutos por diseño.

- [ ] **2.4 · Que el receptor del CFDI sea siempre el cliente del ticket** — `L`
  | Bot | Qué pasa | Qué hacer |
  |---|---|---|
  | `bots/igasfac.js` | nunca usa el RFC (0 apariciones en todo el archivo) | teclear los datos fiscales del cliente, o bloquear el bot si el ticket no es del titular de la cuenta |
  | `bots/orsan.js:36` | recibe `rfc` y no lo usa | igual |
  | `bots/g500.js:178` | sólo elige cliente si la pantalla dice "seleccione un cliente" | quitar la condición y **releer** qué receptor quedó seleccionado, como hace `facturagas.js:461-500` |
  | `bots/orler.js:308` | compara contra `"GPR110128QD8"` literal | comparar contra `datos.rfc` |
  *Auditoría §2 ④*

- [ ] **2.5 · PINFRA: marcar sólo el checkbox del folio de este ticket** — `S`
  `bots/pinfra.js:231` marca **todos** los checkboxes de **todas** las tablas. Un CFDI puede englobar tickets de otro residente o de otra corrida.

- [ ] **2.6 · Sacar el RFC de GPN del código** — `M`
  `bots/index.js:95` (`d.rfc = primero(d.rfc, 'GPR110128QD8')`), `bots/estrellablanca.js:99` (`RFC_GPN` + `DOMICILIO_GPN`), y las referencias en `g500`, `grupoarlosa`, `orler`, `oxxogas`, `youbuy`.
  **Regla:** si falta el dato fiscal del cliente, reventar con un error explícito. Un valor por defecto que es el RFC de un contribuyente concreto no es un default, es una trampa.

- [ ] **2.7 · Llamar a `verificarCFDI` en los cinco caminos** — `M`
  Hoy sólo corre en `lib/facturacion.js:182` (bot con XML) y `lib/imap-job.js:111` (CFDI por correo). Faltan: validación manual (`server.js:1219`), recuperación de 7-Eleven (`lib/imap-job.js:202`) y estrategia B de ARCO (`lib/imap-job.js:239`).
  Y arreglar `lib/facturacion.js:215`: hoy `datos ? verificarCFDI(...) : []` significa que **si el XML no es un CFDI no se reporta nada**, justo el caso en que hacía falta la alarma.

- [ ] **2.8 · Régimen y uso de CFDI del cliente, no fijos** — `M`
  `bots/grupocentra.js:334` (ternario con las dos ramas iguales), `bots/capufe.js:212` (elige por posición del dropdown), y los cinco bots con 601/G03 a fuego.

---

## FASE 3 — Que se vea lo que pasa (2-3 días)

- [ ] **3.1 · Arreglar el enmascarado al residente** — `S` — *alto impacto, cambio pequeño*
  `server.js:1294-1307` reescribe `status` a `'procesando'` y la UI decide los botones a partir de ese valor falseado (`public/mis-tickets.html:420-424`). Resultado: el residente no puede confirmar datos, ni reintentar, ni editar, ni solicitar por correo.
  **Solución:** conservar el `status` real en la respuesta y ocultar sólo `error_msg`. La UI ya tiene `_enRevision` para pintar el badge amable.
  *Auditoría §2 ⑧*

- [ ] **3.2 · Salida para los tickets atascados** — `S`
  - `status='pendiente'` (puesto por `lib/facturacion.js:415` tras un 429, y por `server.js:1022` al editar datos): **ningún job lo recoge**. Añadirlo a `rescatarTicketsSinEncolar` o cambiar el estado.
  - `status='procesando'` huérfano tras un redeploy: no hay job ni botón. Añadir un expirador como el de `procesando_correo`.

- [ ] **3.3 · Escapar la salida en el frontend** — `S`
  - `public/mis-tickets.html:480` — `${t.nombre_archivo}` en `innerHTML` (el nombre del archivo lo controla quien sube).
  - `public/mis-tickets.html:479, 483` — `${t.comercio}` y `${errorMsg}`, que vienen del OCR y del portal.
  - `public/admin-residentes.html:484` — comercio dentro de `onclick="…'${…}'…"` escapando sólo la comilla simple.

- [ ] **3.4 · Arreglar la clave `folio` duplicada** — `S`
  `public/dashboard.html:704` y `:714` definen `folio` dos veces en el mismo objeto. La segunda gana, así que el modal le pide a **todos** los portales el código de barras de AutoZone.

- [ ] **3.5 · `filtroAlcance` en los endpoints de admin que lo omiten** — `M`
  `server.js:715` (`/api/admin/tickets`), `:1355` (imagen de cualquier ticket), `:2174` (intentos), `:2193` (errores), `:2231` (revertir factura), `:2272` (reproceso IMAP), `:2415` (resetear), `:2466` (limpiar comercio), `:699` (residentes de un usuario).
  Hoy un admin de cliente ve y opera los tickets de los demás clientes.

- [ ] **3.6 · Manejo de 401 en todas las pantallas** — `S`
  Sólo Mis Facturas lo maneja. En el resto, la sesión caducada se ve como avería y el poll sigue golpeando cada 6 segundos.

- [ ] **3.7 · Advertencia al borrar un ticket en `procesando_correo`** — `S`
  Hoy se borra sin avisar de que el CFDI viene en camino.

---

## FASE 4 — Que no vuelva a pasar (1 semana)

- [ ] **4.1 · Registro único por portal** — `L` — *la mejora estructural más rentable*
  Hoy dar de alta un portal exige tocar cuatro sitios a mano (`bots/`, el routing de `bots/index.js`, el gate de `lib/util.js` y `portales/portales.json`) y olvidar uno falla en silencio.
  **Propuesta:** un solo archivo por portal con clave, patrones de detección, prompt de extracción, campos obligatorios, patrones de URL y función del bot. El gate, el router y los prompts se derivan de ahí.
  Con eso resuelto, **dar de alta en el OCR los ocho portales del punto ⑦**: `estrellablanca`, `lossenderos`, `grupoarlosa`, `youbuy`, `facturat`, `redco`, `topgas`, `orsan`.
  *Auditoría §2 ⑦ — es lo que explica los 11 tickets de gasolinas que no se pudieron facturar*

- [ ] **4.2 · `lib/bot-runner.js`: envoltura común para todos los bots** — `L`
  Que aporte de serie: conexión a Browserless, `page.on('dialog')`, screenshots a R2, la bandera de timbrado disparado, el correo de entrega ya resuelto y la **validación del `RunnerResult` antes de devolverlo** (si dice `ok:true` sin `xmlUrl`, `pdfUrl` ni `procesandoCorreo`, es un bug, no un éxito).
  Elimina ~200 líneas duplicadas por bot y hace imposible la mitad de los hallazgos de esta auditoría.
  Migrar primero los marcados PELIGROSO: `g500`, `gasolineros`, `igasfac`, `gasmaz`, `petrofigues`.

- [ ] **4.3 · Primeras pruebas deterministas** — `M`
  No hace falta cobertura; hace falta que **exista algo**. Hoy no hay ni una prueba que corra sin credenciales y sin timbrar.
  Empezar por las funciones puras donde un error cuesta una factura:
  `verificarCFDI`, `leerCFDI`, `corregirAnioReciente`, `corregirIdVentaOxxo`, `esPortalFacturable`, `filtroAlcance`, `extraerJson`, `elegirUrl`.
  Después: fixtures de HTML guardado por portal y test del `RunnerResult` de cada bot.

- [ ] **4.4 · `UNIQUE(uuid)` en `facturas`** — `S`
  Hoy sólo hay UNIQUE sobre `ticket_id`. Un mismo CFDI puede quedar registrado en dos tickets — es exactamente lo que pasó con #220/#227.

- [ ] **4.5 · Emparejador IMAP por folio/UUID, no sólo por importe** — `M`
  `mail/imap.js:298-348` empareja con monto ±$1 y palabras del comercio. Dos tickets del mismo importe el mismo día se cruzan.
  Además: `mail/imap.js:177` busca `UNSEEN + SINCE 60 minutos`; un CFDI que no case en esa hora queda invisible para siempre. Ampliar la ventana y llevar un registro de correos vistos y no emparejados.

- [ ] **4.6 · Constante compartida para `error_code`** — `S`
  `lib/codigos.js` con los códigos válidos, importada por los bots y por `lib/facturacion.js`. Un código inventado deja de ser posible.

---

## FASE 5 — Limpieza y consolidación (cuando haya aire)

- [ ] **5.1 · Borrar el código muerto** — `S`
  `bots/autozonedemexico.js` (truncado, no parsea), `bots/oxxo.js` (inalcanzable: el engine gana), `bots/elcaporalrestaurantecampestre.js` y `bots/allegrocaffezonadoradatxutxufo.js` (truncados; `index.js` enruta esos comercios a `sushito`).

- [ ] **5.2 · Fusionar los gemelos** — `M`
  `estrellablanca` + `lossenderos` (1,831 líneas para un solo backend AMS Integra, con nueve divergencias de comportamiento) y `commerce/gasmaz` + `commerce/ramsa` (idénticos salvo 3 líneas).

- [ ] **5.3 · Triaje de `scripts/`** — `M`
  320 archivos, 25,900 líneas. Separar en `scripts/operacion/` (herramientas vivas), `scripts/_peligrosos/` (timbran o borran) y borrar las 79 sondas `probe-*` ya cumplidas. Quitar los datos personales versionados (`alta-cliente.js:21`, `ramcal-facturar-final.js:43`).

- [ ] **5.4 · Cerrar `/register`** — `S`
  Hoy cualquiera crea cuenta (`server.js:471`) y consume cuota de Sonnet, Browserless y CapSolver. Pasar a alta por invitación desde el panel.

- [ ] **5.5 · Aislar el agente de altas** — `L`
  Hoy `agentes/validador.js:92` escribe código generado por un modelo en `bots/`, lo `require()` dentro del worker (con todas las credenciales) y lo ejecuta contra el portal real; y `server.js:2149-2151` hace `git commit` + `git push origin main` desde producción, lo que dispara un despliegue.
  **Propuesta:** el bot generado se queda siempre en `pendiente_aprobacion`, se prueba en un proceso aparte sin credenciales de producción, y el push lo hace una persona.

- [ ] **5.6 · Política de retención de CFDI** — `S`
  Sustituir el borrado a 60 días por archivado (almacenamiento frío) con retención de 5 años.

- [ ] **5.7 · Terminar la migración al engine** — `L`
  5 portales migrados, 44 sin migrar. Es la dirección correcta para no tener 49 bots divergentes, pero a medio camino tiene el peor de los dos mundos: dos formas de hacer lo mismo.

---

## Mejoras estructurales (el porqué de varias tareas de arriba)

**1. El `error_code` debe ser un tipo cerrado, no una cadena suelta.**
Hoy un bot puede devolver `'timeout'` y el sistema lo trata como error desconocido reintentable. Una constante compartida más un `default` que **no** programe reintento convierte 21 bugs silenciosos en ruido visible.

**2. La regla que falta no es "no reintentar", es "no emitir dos veces".**
En vez de confiar en que 49 bots usen bien `timbradoDisparado`, poner la guarda donde no se puede esquivar: al principio de `ejecutarFacturacion`. Dos consultas cierran ocho rutas de duplicado.

**3. Los bots necesitan un contrato ejecutable, no una doctrina en comentarios.**
La doctrina está bien pensada y escrita en varios sitios del repo; el problema es que se cumple a ojo. Una envoltura común la hace obligatoria.

**4. `emailEntrega` no debería ser un campo que el bot elige usar.**
Es el correo del sistema: debería llegar ya sustituido y que el del residente viaje aparte.

**5. Dar de alta un portal no puede requerir tocar cuatro archivos a mano.**
El fallo de los ocho portales sin OCR propio es estructural, no un descuido: el diseño actual garantiza que se repita.

**6. Hace falta una prueba que corra sin timbrar.**
No cobertura: existencia. Las funciones puras del sistema son todas deterministas y son justo donde un error cuesta una factura.

**7. Retención en vez de borrado.**
Los CFDI se conservan cinco años. Si R2 pesa, almacenamiento frío; nunca borrar.

**8. El agente que escribe bots es potente y hoy no tiene freno.**
Escribe código de un modelo a disco, lo ejecuta con credenciales de producción contra portales reales, y puede pushear a `main`.

---

## Orden recomendado si hay poco tiempo

Si sólo se pueden hacer cinco cosas, estas cinco:

1. **0.1** rotar la contraseña de MySQL.
2. **0.2** apagar el borrado de CFDI.
3. **1.1** candado de idempotencia en `ejecutarFacturacion`.
4. **1.2 + 1.3** `default` del switch y rama de `ya_facturado`.
5. **3.1** dejar de esconderle al residente los botones que necesita.

Cuestan menos de dos días entre todas y eliminan el grueso del riesgo de doble timbrado, la fuga de credenciales, la pérdida de documentos fiscales y el atasco operativo.
