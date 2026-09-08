# Revisión de flujo/UX — portal-facturas

Hallazgos recorriendo el camino del residente: sube foto → OCR → estado del ticket → recepción de factura.  
Ordenados por **impacto real para el residente**, no por facilidad de arreglo.

---

## 1. El residente no ve los estados que requieren su acción (impacto: alto)

- **Archivos**:  
  - `server.js` — función `enmascararParaResidente` (líneas cercanas a la sección “VISIBILIDAD POR ROL”).  
  - `public/mis-tickets.html` — `statusMap` y el bloque de botones/acciones dentro de `renderTickets` (aprox. líneas 390-550).
- **Qué pasa**: `enmascararParaResidente` convierte `error` y `pendiente_confirmacion` a `procesando` para quien no es admin y borra `error_msg`. En `mis-tickets.html` el badge, los botones (“Revisar datos”, “Editar datos”, “Reintentar”, “Solicitar por correo”, “Eliminar”) y el mensaje de error dependen del `status` real. Como llega enmascarado, esos caminos no se ejecutan: el residente ve “Procesando” para tickets que en realidad necesitan confirmar datos o están en error, y el auto-poll recarga la lista cada 6 s indefinidamente.
- **Qué cambiar**: desenmascarar al menos `pendiente_confirmacion` (el residente sí puede corregir sus datos) y darle a `error` una cara amigable con acción, por ejemplo “En revisión — Ver detalles”, en vez de ocultarlo. Si se prefiere mantener el enmascaramiento de errores técnicos, el badge debería ser “En revisión” y debe existir un botón que abra el modal de confirmación o el dashboard.
- **Costo**: medio — cambio en backend más ajuste de condiciones en `mis-tickets.html`; hay que cuidar que el admin siga viendo todo.

---

## 2. Mensajes crudos del portal llegan al residente en el dashboard (impacto: alto)

- **Archivos**:  
  - `server.js` — endpoint `GET /api/tickets/:id/estado-ocr` (no aplica `enmascararParaResidente`).  
  - `public/dashboard.html` — función `subirTicket`, rama `else if (estado.error)` (aprox. líneas 360-420).
- **Qué pasa**: cuando el OCR o la cola dejan el ticket en `error`, `/estado-ocr` devuelve `t.error_msg` tal cual. El dashboard lo pinta directo en la alerta (`estado.msg`). Esos mensajes vienen de portales de comercios (p. ej. textos de PINFRA, CAPUFE, OXXO, etc.) y no están pensados para el usuario final; en algunos casos son técnicos o en tercera persona del portal.
- **Qué cambiar**: mapear `error_code` / palabras clave a mensajes amigables en el frontend del dashboard, o que el backend devuelva un campo `msg_usuario` separado del `msg_tecnico`.
- **Costo**: bajo — es solo traducción de textos; no toca lógica de facturación.

---

## 3. La subida en lote deja tickets pendientes de confirmación sin avisar (impacto: alto)

- **Archivos**:  
  - `public/dashboard.html` — `subirLote` (aprox. líneas 400-430) y el flujo de un solo ticket `subirTicket`.  
  - `server.js` — `POST /upload-tickets`.
- **Qué pasa**: `subirLote` responde con un mensaje genérico de éxito y no hace polling ni abre modales por ticket. Si el OCR deja algún ticket en `pendiente_confirmacion` (campos dudosos), en “Mis Tickets” el estado llega enmascarado como “Procesando” (hallazgo 1), por lo que el residente nunca se entera de que debe revisar datos. Esos tickets se quedan atascados hasta que un admin los vea.
- **Qué cambiar**: después de un lote, consultar `/api/tickets` y, si hay tickets en `pendiente_confirmacion`, mostrar una alerta destacada con enlaces a confirmar uno a uno; o enviar una notificación push/web por cada ticket que requiera confirmación.
- **Costo**: medio — requiere polling/alerta post-lote y desenmascarar el estado en la lista.

---

## 4. `confianza:"media"` no se muestra en el modal de confirmación (impacto: medio)

- **Archivos**:  
  - `public/dashboard.html` — `abrirModalConfirmacion` (aprox. líneas 620-680).  
  - `server.js` — `GET /api/tickets/:id/estado-ocr` devuelve `confianza`.
- **Qué pasa**: el modal solo muestra la advertencia naranja si `campos_dudosos` tiene elementos. Si el OCR marcó `requiere_confirmacion` por `confianza: "media"` pero sin campos dudosos concretos, el modal se abre igual que si la lectura hubiera sido segura, y el residente no sabe por qué debe revisar.
- **Qué cambiar**: mostrar siempre una nota de confianza (“Lectura con confianza media — revisa todos los campos”) y, de ser posible, resaltar todos los campos obligatorios cuando la confianza no sea “alta”.
- **Costo**: bajo.

---

## 5. Divergencia entre campos de confirmación (dashboard) y edición (mis-tickets) (impacto: medio)

- **Archivos**:  
  - `public/dashboard.html` — objeto `CAMPOS_POR_PORTAL` (aprox. líneas 600-610).  
  - `public/mis-tickets.html` — array `CAMPOS_EDITABLES` (aprox. líneas 780-790).
- **Qué pasa**: el dashboard pide campos específicos por portal (p. ej. OXXO pide `fecha`, `folio`, `idVenta`, `total`; Farmacias Guadalajara pide `folioFactura`, `caja`, etc.), mientras que “Editar datos” en `mis-tickets.html` muestra un formulario genérico (`folio`, `referencia`, `idVenta`, `codigoTicket`, etc.). Además, cuando un ticket va a `pendiente_confirmacion` por `datos_invalidos`, el modal no muestra el `error_msg` del portal, así que el residente no sabe qué corregir.
- **Qué cambiar**: compartir la misma definición de campos por portal entre el modal de confirmación y la edición; y pasar el mensaje de error del portal al modal como advertencia.
- **Costo**: medio — implica unificar config y tocar dos frontends legacy.

---

## 6. Los correos al residente siguen con marca GPN para todos los clientes (impacto: medio)

- **Archivos**:  
  - `lib/facturacion.js` — `emailFacturaLista`: asunto “✅ Tu factura está lista — GPN Pinturas y Recubrimientos”.  
  - `server.js` — `enviarSolicitudPorCorreo`: remitente “GPN Pinturas — Facturación”.
- **Qué pasa**: el sistema es multi-cliente (GPN, DGA, etc.), pero los correos que recibe el residente siempre dicen GPN. Para un cliente distinto esto genera confusión y desconfianza.
- **Qué cambiar**: usar el nombre del cliente (`/api/marca` o `ticket.cliente_nombre`) en el remitente, asunto y cuerpo del correo.
- **Costo**: bajo.

---

## 7. `web/app/*` no se pudo inspeccionar; la migración a Next.js podría estar incompleta (impacto: medio-alto a largo plazo)

- **Archivos**: solo se encontró en el chat `web/lib/api.js`; no se proporcionaron páginas en `web/app/*`.
- **Qué pasa**: mientras dure la migración, `public/*.html` sigue siendo la fuente de verdad en producción. Cualquier arreglo de UX que solo se haga en `web/app/*` no llegará al residente, y se corre el riesgo de que ambos frontends diverjan en mensajes, estados y flujos.
- **Qué cambiar**: definir un único origen de campos, textos de estado y mensajes de error compartido entre legacy y Next.js (p. ej. JSON estático o endpoint `/api/config-ui`), y migrar página a página.
- **Costo**: alto — es trabajo de migración, no un fix puntual.

---

## 8. `procesando_correo` no se distingue de `procesando` (impacto: bajo)

- **Archivos**: `public/mis-tickets.html` — `statusMap` (aprox. líneas 390-400).
- **Qué pasa**: ambos estados se pintan con el mismo badge “Procesando”. El residente no sabe que el sistema está esperando la factura por correo y no actively facturando.
- **Qué cambiar**: agregar un badge distinto, p. ej. “Esperando factura por correo”.
- **Costo**: trivial.

---

## Nota de Claude (verificación + aplicado)

Verifiqué varios hallazgos contra el código real antes de aplicar nada:

- **#2 y #6 confirmados exactos** (línea por línea).
- **#1 estaba incompleto**: el backend YA manda una señal para esto
  (`_enRevision: true` en `enmascararParaResidente`, server.js) pero
  `mis-tickets.html` nunca la leía — la corrección real es conectar ese flag,
  no desenmascarar el status.

**Aplicado ahora** (bajo costo, sin tocar bots/engine/agentes):
1. `mis-tickets.html` — badge "En revisión" cuando `t._enRevision` (fix real de #1).
2. `mis-tickets.html` — `procesando_correo` ahora dice "Esperando correo" (#8).
3. `server.js` — `/api/tickets/:id/estado-ocr` ya no manda `error_msg` crudo,
   usa `mensajeAmigablePara()` (fix de #2).
4. `server.js` + `lib/facturacion.js` — la marca en los 3 correos (factura
   lista, solicitud al comercio) ahora usa `cliente_nombre` en vez de "GPN"
   fijo, con fallback a GPN si el ticket no tiene cliente asignado (fix de #6).

**Pendientes, requieren decisión de producto** (no se tocaron):
- #3 (aviso post-lote de pendientes de confirmación) — medio costo.
- #4/#5 (unificar campos por portal entre confirmación y edición) — medio costo.
- #7 (única fuente de config UI entre legacy y Next.js) — es la migración
  completa, no un fix puntual.

## Resumen de prioridad

1. Resolver el enmascaramiento de `pendiente_confirmacion` y `error` en la lista del residente.  
2. Traducir `error_msg` antes de mostrarlo en el dashboard.  
3. Avisar por ticket cuando un lote deja confirmaciones pendientes.  
4. Unificar campos por portal entre confirmación y edición.  
5. Quitar la marca GPN hardcodeada de los correos.  
6. Seguir la migración Next.js con una única fuente de config de UI.
