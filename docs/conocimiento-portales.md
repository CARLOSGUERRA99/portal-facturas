# Conocimiento de portales — portal-facturas

Extraído del repositorio el 2026-08-07. **No** de historial de chat: todo lo de aquí está en `portales.json`, en las cabeceras de `bots/*.js` y en la base de datos, y se puede verificar abriendo esos archivos.

**31 portales · 29 con bot · 28 en el gate de la cola · 3 dados de alta por el agente**

## Tecnologías

- SoftRestaurant / mefacturo.mx — 3
- EDX Retail — 2
- Por determinar — 2
- ASP.NET WebForms — 1
- JSF PrimeFaces — 1
- ASP.NET MVC — 1
- ASP.NET WebForms + AJAX — 1
- Angular SPA — 1
- Angular 15 con reactive forms y ng-mask — 1
- Next.js + Material UI v5 — 1
- AngularJS SPA — 1
- Origon Cloud — 1
- Desconocida — 1
- ASP.NET Core con login de cuenta — 1
- SPA con jQuery Chosen; login con reCAPTCHA v2 — 1
- SPA con autocomplete de drives — 1
- AngularJS con CAPTCHA de imagen — 1
- Blazor/MudBlazor — 1
- misma plataforma que Enerfuel Tech — 1
- NexusFuel multi-tenant — 1
- NexusFuel — 1
- SPA React + PrimeReact — 1
- SoftRestaurant / AutoFactura — 1
- PHP + Select2 con catálogos por AJAX — 1
- ASP.NET — 1
- Portal estatal con login de cuenta — 1
- portal propio con registro de cliente — 1

## Portales con CAPTCHA

- **homedepot** — Cloudflare Turnstile
- **7eleven** — imagen

---

## Walmart de México (Bodega Aurrera / Mi Bodega Aurrera / Walmart / Sam's Club / Superama)  `bodegaaurrera`

- **URL:** https://facturacion.walmartmexico.com.mx/frmDatos.aspx
- **Tecnología:** ASP.NET WebForms
- **CAPTCHA:** ninguno
- **Campos que pide:** tc, tr, fecha, total
- **Bot:** ✅ bots/bodegaaurrera.js · en la cola
- **Historial:** 0/2 intentos con éxito · 43.8s de media
- **Errores que distingue:** datos_invalidos
- **Esperas fijas:** 14.2s (⚠️ el tope de sesión de Browserless son 60s)

## OXXO Facturación Electrónica  `oxxo`

- **URL:** https://www4.oxxo.com:9443/facturacionElectronica-web/views/layout/inicio.do
- **Tecnología:** JSF PrimeFaces (Java)
- **CAPTCHA:** ninguno
- **Campos que pide:** fecha, folio, idVenta, total
- **Bot:** ✅ bots/oxxo.js · en la cola
- **Historial:** 1/1 intentos con éxito · 51s de media
- **Esperas fijas:** 40.6s (⚠️ el tope de sesión de Browserless son 60s)

## BuzonFacturas (ARCO)  `arco`

- **URL:** https://buzonfacturas.com/GenerarCFDI/Index?avanzada=0
- **Tecnología:** ASP.NET MVC
- **CAPTCHA:** ninguno
- **Campos que pide:** codigoTicket, total
- **Bot:** ✅ bots/buzonfacturas.js · en la cola
- **Historial:** 0/11 intentos con éxito · 38.5s de media
- **Esperas fijas:** 10s (⚠️ el tope de sesión de Browserless son 60s)

## NexusFuel / Gasmaz  `gasmaz`

- **URL:** https://redmaxfactura.nexusfuel.mx/
- **Tecnología:** ASP.NET WebForms + AJAX
- **CAPTCHA:** ninguno
- **Campos que pide:** portalUrl, referencia, folio, total
- **Bot:** ✅ bots/gasmaz.js · en la cola
- **Historial:** 3/3 intentos con éxito · 32.2s de media
- **Esperas fijas:** 6.9s (⚠️ el tope de sesión de Browserless son 60s)

## Home Depot Mexico  `homedepot`

- **URL:** https://facturacion.homedepot.com.mx:2053/FacturacionWeb/#/portalweb
- **Tecnología:** Angular SPA (puerto 2053, HTTPS propio)
- **CAPTCHA:** Cloudflare Turnstile
- **Campos que pide:** folio, fecha, total
- **Bot:** ✅ bots/homedepot.js · en la cola
- **Esperas fijas:** 55.4s (⚠️ el tope de sesión de Browserless son 60s)

## Farmacias Guadalajara  `farmaciaguadalajara`

- **URL:** https://www.movil.farmaciasguadalajara.com/facturacion/
- **Tecnología:** Angular 15 con reactive forms y ng-mask
- **CAPTCHA:** ninguno
- **Campos que pide:** folioFactura, caja, fechaCompra, noTicket
- **Bot:** ✅ bots/farmaciaguadalajara.js · en la cola
- **Esperas fijas:** 21s (⚠️ el tope de sesión de Browserless son 60s)

> Bot tiene lógica correcta pero aún no tiene caso de éxito end-to-end validado

## Panamá Restaurante y Pastelería  `panama`

- **URL:** https://portalfacturacion.grupopanama.mx/
- **Tecnología:** Next.js + Material UI v5 (React SPA) — sin IDs en inputs, MUI Selects
- **CAPTCHA:** ninguno
- **Campos que pide:** idFacturacion, total, comercio
- **Bot:** ✅ bots/panama.js · en la cola
- **Historial:** 0/1 intentos con éxito · 253.8s de media
- **Errores que distingue:** ya_facturado, datos_invalidos
- **Esperas fijas:** 19.1s (⚠️ el tope de sesión de Browserless son 60s)

## Farmacias Benavides  `benavides`

- **URL:** https://e-facturate.com/benavides/
- **Tecnología:** EDX Retail (jQuery + Bootstrap), wizard 4 pasos
- **CAPTCHA:** ninguno · requiere cuenta
- **Campos que pide:** folio, fecha, total
- **Bot:** ✅ bots/benavides.js · en la cola
- **Historial:** 0/1 intentos con éxito · 55.5s de media
- **Errores que distingue:** datos_invalidos
- **Esperas fijas:** 16.7s (⚠️ el tope de sesión de Browserless son 60s)

## Carl's Jr (ICR S.A. de C.V.)  `carljr`

- **URL:** https://retailedx.com/ICR4/
- **Tecnología:** EDX Retail (jQuery + Bootstrap), wizard 4 pasos
- **CAPTCHA:** ninguno
- **Campos que pide:** referencia, total
- **Bot:** ✅ bots/carljr.js · en la cola
- **Historial:** 0/9 intentos con éxito · 88.3s de media
- **Errores que distingue:** ya_facturado, datos_invalidos
- **Esperas fijas:** 20.8s (⚠️ el tope de sesión de Browserless son 60s)

## Rendichicas / Rendilitros  `rendichicas`

- **URL:** https://facturacion.rendilitros.com/
- **Tecnología:** AngularJS SPA
- **CAPTCHA:** ninguno
- **Campos que pide:** folio, fecha, total
- **Bot:** ✅ bots/rendichicasestacionpirusadecv.js · en la cola
- **Historial:** 0/4 intentos con éxito · 40s de media

## SushiO (mefacturo.mx)  `sushito`

- **URL:** https://mefacturo.mx/sushio
- **Tecnología:** SoftRestaurant / mefacturo.mx (ASP.NET MVC)
- **CAPTCHA:** ninguno
- **Campos que pide:** referencia, folio, total
- **Bot:** ✅ bots/sushito.js · en la cola
- **Errores que distingue:** ya_facturado, datos_invalidos, ticket_vencido, timeout
- **Esperas fijas:** 5.4s (⚠️ el tope de sesión de Browserless son 60s)

## El Caporal Restaurante (mefacturo.mx)  `elcaporal`

- **URL:** https://mefacturo.mx/elcaporalrestaurante
- **Tecnología:** SoftRestaurant / mefacturo.mx — misma plataforma que SushiO
- **CAPTCHA:** ninguno
- **Campos que pide:** —
- **Bot:** ✅ bots/sushito.js · en la cola
- **Errores que distingue:** ya_facturado, datos_invalidos, ticket_vencido, timeout
- **Esperas fijas:** 5.4s (⚠️ el tope de sesión de Browserless son 60s)

## Allegro Caffe / Txutxu Food (mefacturo.mx)  `allegro`

- **URL:** https://mefacturo.mx/allegrezonadorada
- **Tecnología:** SoftRestaurant / mefacturo.mx — misma plataforma que SushiO
- **CAPTCHA:** ninguno
- **Campos que pide:** —
- **Bot:** ✅ bots/sushito.js · en la cola
- **Errores que distingue:** ya_facturado, datos_invalidos, ticket_vencido, timeout
- **Esperas fijas:** 5.4s (⚠️ el tope de sesión de Browserless son 60s)

## AutoZone de México  `autozone`

- **URL:** https://autozone.cdc.origon.cloud/facturacion/autozone
- **Tecnología:** Origon Cloud — plataforma SaaS de facturación
- **CAPTCHA:** ninguno · requiere cuenta
- **Campos que pide:** —
- **Bot:** ✅ autozone.js · en la cola
- **Errores que distingue:** ticket_vencido, datos_invalidos, ya_facturado
- **Esperas fijas:** 27.4s (⚠️ el tope de sesión de Browserless son 60s)

> Bot pendiente de crear. Plataforma Origon Cloud. Campos esperados: folio, fecha, total, barcode, RFC, razón social, CP, correo.

<details><summary>Reconocimiento real del portal</summary>

```
Bot AutoZone de México — plataforma CDC (Origon Cloud) — Angular Material

Flujo (multi-step wizard con DIV.navigation-container como botones de navegación):
  Inicio → Facturación Rápida → Iniciar →
  Paso 1 (0%)  : Código de barras (mat-input-0, text)
  Paso 2 (20%) : Fecha de compra (calendario con <td> clickeables)
  Paso 3 (30%) : Monto de compra (mat-input-1, number) → validación AJAX
  Paso 4 (40%+): Datos de Facturación (RFC, nombre, CP, régimen, CFDI, correo)
  Paso final   : Generar factura → descarga XML/PDF o correo

Tecnología: Angular Material v14+ con custom navigation-container buttons
```
</details>

## TUFESA  `tufesa`

- **URL:** https://www.tufesa.com.mx/facturacion
- **Tecnología:** Por determinar
- **CAPTCHA:** ninguno
- **Campos que pide:** —
- **Bot:** ✅ tufesa.js · en la cola
- **Errores que distingue:** ya_facturado, datos_invalidos
- **Esperas fijas:** 13.2s (⚠️ el tope de sesión de Browserless son 60s)

> Bot pendiente. Analizar formulario de facturación de boletos de autobús.

## Puente Colorado  `puentecolorado`

- **URL:** https://www.puentecoloradofacturacion.com.mx
- **Tecnología:** Por determinar
- **CAPTCHA:** ninguno
- **Campos que pide:** —
- **Bot:** ❌ sin bot · fuera del gate

> Bot pendiente. Analizar portal de facturación.

## Little Caesars Navojoa  `littlecaesarsnavojoa`

- **URL:** https://cfdi.analytix360.cloud/cafrena/lc/crear-cvo/
- **Tecnología:** Desconocida
- **CAPTCHA:** ninguno
- **Campos que pide:** —
- **Bot:** ✅ bots/littlecaesarsnavojoa.js · fuera del gate
- **Esperas fijas:** 9.4s (⚠️ el tope de sesión de Browserless son 60s)

## IGasFac (gasolineras)  `igasfac`

- **URL:** https://www.igasfac.com.mx
- **Tecnología:** ASP.NET Core con login de cuenta
- **CAPTCHA:** ninguno · requiere cuenta
- **Campos que pide:** folio, total
- **Bot:** ✅ igasfac.js · en la cola
- **Errores que distingue:** datos_invalidos, ya_facturado, reintentar_despues
- **Esperas fijas:** 15.8s (⚠️ el tope de sesión de Browserless son 60s)

> El folio que pide el portal es el FOLIOWEB largo (formato 4-8-8 con guiones) impreso DEBAJO de "Facturacion en: www.igasfac.com.mx", NO el "Folio:" corto de arriba. Ventana: hasta el ultimo dia del mes.

<details><summary>Reconocimiento real del portal</summary>

```
IGasFac — www.igasfac.com.mx

Portal con CUENTA: requiere login previo (credenciales solo por variables de
entorno IGAS_USER / IGAS_PASS, nunca en código).

Reconocimiento real (2026-07-29, cuenta real, ticket folio
0637-00475232-00093301). Los cuatro detalles que cuestan sangre:

  1. #Input_Folio lleva `data-mask="folioWeb"`. page.keyboard.type() y
     element.value = ... NO funcionan: la máscara los ignora y el campo se
     queda vacío o a medias. Hay que pulsar DÍGITO A DÍGITO con
     page.keyboard.press() y una pausa entre cada uno.

  2. Hay DOS botones "Agregar": el de la pantalla, que abre el modal, y el
     del propio modal, que confirma. Son iguales de texto, así que el
     segundo se busca recorriendo la lista AL REVÉS.

  3. El botón que guarda los Datos Fiscales NO es descendiente de su
     formulario: se asocia con el atributo HTML `form=`. No hay selector CSS
     que lo alcance desde el form, así que se localiza por
     `button.form.id === 'submitModificarDatosFiscales'`.

  4. La Forma de Pago se RESETEA en cada solicitud nueva, así que hay que
     seleccionarla y confirmarla SIEMPRE, aunque la cuenta ya la tenga
     guardada de una vez anterior.

Entrega: el portal NO descarga el CFDI en pantalla, lo manda por correo. El
bot devuelve procesandoCorreo:true y el CFDI lo recoge el flujo de IMAP.

⚠️ Rechazo conocido CFDI40147: es un desfase entre el PAC (SmartWeb) y la
lista masiva del SAT, NO un dato mal puesto. Se resuelve solo en 2-3 días;
reintentar entonces con el mismo folio.
```
</details>

## OXXO GAS  `oxxogas`

- **URL:** https://facturacion.oxxogas.com
- **Tecnología:** SPA con jQuery Chosen; login con reCAPTCHA v2
- **CAPTCHA:** ninguno · requiere cuenta
- **Campos que pide:** folio, fecha, total
- **Bot:** ✅ oxxogas.js · en la cola
- **Errores que distingue:** captcha
- **Esperas fijas:** 21.2s (⚠️ el tope de sesión de Browserless son 60s)

> NO es la tienda OXXO. El ticket trae "Folio:" de 7 digitos y "Bomba:". Requiere cookies de sesion inyectadas a mano: el login tiene reCAPTCHA v2 que no se resuelve. Entrar SIEMPRE por la home, nunca por deep link.

<details><summary>Reconocimiento real del portal</summary>

```
OXXO GAS — facturacion.oxxogas.com

══════════════════════════════════════════════════════════════════════════
⚠️ ES UNA SPA: HAY QUE ENTRAR SIEMPRE POR LA HOME. Medido el 2026-07-31.

  `https://facturacion.oxxogas.com/` es una single-page app: la URL NUNCA
  cambia, ni al entrar a Facturar ni a Mis Facturas. Todas las pantallas se
  pintan por JavaScript sobre la misma ruta.

  👉 Navegar DIRECTO a /facturacion/facturar devuelve un HTML degradado, sin
     una sola etiqueta <script src> (jQuery, Chosen y Angular ausentes).
     Eso hace que #regimen_fiscal y #usocfdi nunca se pueblen y que el clic
     en "Agregar Ticket" no dispare ninguna petición — el botón no tiene
     handler porque no hay JS. Ese falso síntoma se atribuyó por error a un
     bloqueo del WAF y a rate-limiting; no era ni lo uno ni lo otro.

  Entrando por la home y pulsando el enlace "ACCEDER A FACTURAR", el portal
  carga completo y verificado: 29 scripts, jQuery=true, Chosen=true, 5
  contenedores .chosen-container en el DOM, #estacion con 584 opciones. Y al
  elegir el RFC con page.select() los dependientes se pueblan solos
  (#regimen_fiscal 0→9 opciones, #usocfdi 0→4), así que el <select> nativo
  SÍ notifica correctamente pese a la decoración de Chosen.

  Corolario para cualquier bot futuro de este portal: nunca hacer deep link,
  siempre home + clic. Y comprobar que los selects dependientes se poblaron
  antes de seguir (page.select() no lanza error si la opción no existe: deja
  el campo vacío EN SILENCIO y el fallo aparece mucho después).

  Presupuesto: Browserless corta la sesión a los 60 s exactos en este plan y
  rechaza con HTTP 400 cualquier &timeout=. Por eso el flujo se parte en dos:
  emitir dentro del navegador, y recuperar el XML/PDF después con fetch()
  autenticado por la misma cookie (no hace falta navegador para eso).
══════════════════════════════════════════════════════════════════════════

⚠️ ESTE BOT NO ES AUTÓNOMO. Requiere una cookie de sesión ya
autenticada MANUALMENTE por el usuario (ver más abajo). NO intenta
resolver el reCAPTCHA v2 del login bajo ninguna circunstancia — esa
regla es absoluta e innegociable en este proyecto. La única forma de
operar este bot es:
  1. El usuario inicia sesión a mano en facturacion.oxxogas.com en un
     navegador real, resolviendo el reCAPTCHA él mismo.
  2. Copia el valor de la cookie `ci_sessions` (DevTools → Application
     → Cookies → facturacion.oxxogas.com) y, si existen, las cookies
     `incap_ses_*_3020163` / `visid_incap_3020163` (capa Incapsula/WAF).
  3. Esas cookies se pasan como variables de entorno
     OXXOGAS_CI_SESSION / OXXOGAS_INCAP_SES_117 / OXXOGAS_INCAP_SES_363
     / OXXOGAS_VISID_INCAP al invocar este bot — NUNCA hardcodeadas en
     código ni guardadas en .env (son credenciales de sesión reales).
  4. La sesión expira / se invalida con el tiempo (no confirmado cuánto
     dura) — hay que repetir el proceso periódicamente.

Reconocimiento y verificación real (2026-07-28, cuenta real GPN,
ticket real Estación Galerías BJX León, Folio 7540670, $800.00):
  - Con la cookie `ci_sessions` inyectada (CodeIgniter — el servidor
    ya la emite incluso sin login, y el login solo la marca como
    autenticada), el dashboard carga completo sin volver a pedir el
    reCAPTCHA. La capa Incapsula (WAF) NO rechazó las requests desde
    el servidor de automatización pese a venir de una IP distinta a
    la del usuario.
  - El formulario de Facturación (RFC → Régimen → Uso CFDI → Estación
    → Folio → Monto → "Agregar Ticket" → Forma de Pago → "Facturar
    Tickets") NO tiene CAPTCHA en ningún punto — solo el login lo
    tiene.
  - "Estación / Gasolinera" y "Seleccione los RFCs" son <select>
    decorados con la librería "Chosen" (jQuery) — para esos SÍ hace
    falta simular apertura+opción, pero en la práctica `page.select()`
    nativo de Puppeteer funciona bien porque el <select> real sigue
    presente en el DOM (solo oculto visualmente).
  - CRÍTICO: el <select> "Forma de Pago" que aparece en cada fila de
    "Tickets a Facturar" (tras Agregar Ticket) es un <select> nativo
    SIN decoración Chosen, y además SIN atributo `id` (solo `name`,
    con un sufijo numérico aleatorio por fila, ej.
    "tipopago_996633") — hay que ubicarlo por `name`, no por `id`, y
    usar `page.select('select[name="..."]', valor)` directo.
  - Tras seleccionar la Forma de Pago, ese <select> puede desaparecer
    del DOM casi de inmediato (la fila pasa a mostrar el texto fijo) —
    no hay que volver a consultarlo para verificar, solo confirmar que
    el placeholder "Seleccione un Tipo de Pago" ya no aparece en el
    body.
  - El carrito de "Tickets a Facturar" es estado del navegador
    (Angular), NO persiste en el servidor entre sesiones/pestañas
    nuevas — cada corrida de este bot debe re-agregar el ticket desde
    cero, no asumir que ya está ahí.
  - Tras "Facturar Tickets" exitoso, el formulario se resetea a vacío
    (RFC/Régimen/Uso CFDI en blanco, carrito vacío) — esa es la señal
    de éxito, no un mensaje de confirmación explícito en pantalla.
  - La factura real y sus enlaces de descarga (XML/PDF directos, más
    el link de verificación del SAT) aparecen en "Mis Facturas"
    (ACCEDER A MIS FACTURAS), columna "Acciones" de la fila con el
    folio recién generado — esos <a href> son URLs autenticadas por
    la misma cookie de sesión, descargables con fetch() + header
    Cookie manual (no requieren un segundo login).
  - Verificado en vivo: folio real 62703067, UUID
    d9edf987-788b-4f71-97cb-2ccc55d449af, Total $800.00 exacto, RFC
    receptor GPR110128QD8 correcto.
```
</details>

## CAFFENIO  `caffenio`

- **URL:** https://facturaciondrive.caffenio.com/ticket
- **Tecnología:** SPA con autocomplete de drives
- **CAPTCHA:** ninguno · requiere cuenta
- **Campos que pide:** folio, codFacturacion, drive, total
- **Bot:** ✅ caffenio.js · en la cola
- **Errores que distingue:** datos_invalidos, ya_facturado, ticket_vencido
- **Esperas fijas:** 11.6s (⚠️ el tope de sesión de Browserless son 60s)

> Exige folio + codigo de facturacion + nombre del drive, y los valida en conjunto. Ventana de 30 dias naturales. Sin CAPTCHA.

<details><summary>Reconocimiento real del portal</summary>

```
CAFFENIO — facturaciondrive.caffenio.com (plataforma de Servicios
Administrativos OSLO, S.A. de C.V., usada por los ~381 drives de CAFFENIO).

Reconocimiento real (2026-07-30, portal en vivo):
  - La home solo muestra el login de "MI CAFFENIO". El flujo SIN CUENTA vive
    en la ruta directa /ticket: el enlace "Factura sin cuenta MI CAFFENIO"
    apunta ahí, pero hacerle click (ni por JS ni sintético) no navega de forma
    confiable — este bot va DIRECTO a /ticket.
  - NO hay CAPTCHA en ningún punto del flujo (verificado en la home y en
    /ticket: sin iframes de recaptcha/turnstile, sin nodos [class*=captcha],
    y la palabra "captcha" no aparece en el HTML).
  - Formulario de /ticket, tres campos obligatorios:
      input[name="folio"]           (type=number, ej. "12345")
      input[name="codFacturacion"]  (type=number, ej. "12345678" — 8 dígitos)
      input[placeholder="Seleccione..."]  → autocomplete del "Drive"
    y el botón "Buscar ticket".
  - El Drive es un autocomplete con 381 opciones (todas las sucursales del
    país, con prefijo "Caffenio "). Hay que escribir para filtrar y luego
    hacer click en el <li>/[role=option] real; asignar el valor no basta.
  - VENTANA: el portal avisa "podrás facturar tu compra dentro de los 30 días
    naturales según la fecha impresa en tu ticket". Fuera de eso el folio ya
    no existe para el portal.
  - El portal valida folio+codFacturacion+drive EN CONJUNTO. Si algo no
    coincide responde "No se encontró orden con la información capturada."
    sin generar nada — probar un drive equivocado es inocuo.

⚠️ ESTADO: flujo de búsqueda verificado en vivo contra el portal real, pero el
cierre E2E (datos fiscales → timbrado → XML/PDF) NO está verificado todavía,
porque el único ticket real disponible (#145) tiene el folio y el código de
facturación ILEGIBLES en la foto (el OCR los marcó dudosos: se lee "2116b11",
con la "b" ambigua entre 6/8/0, y el código con 7 dígitos donde el portal
espera 8). Se probaron los 2 únicos drives de Cd. Obregón y ambos
respondieron "No se encontró orden". Falta una foto más nítida del ticket
para cerrar el ciclo y confirmar los pasos posteriores.
```
</details>

## 7-Eleven México  `7eleven`

- **URL:** https://www.e7-eleven.com.mx/facturacion/KPortalExterno/
- **Tecnología:** AngularJS con CAPTCHA de imagen (CapSolver)
- **CAPTCHA:** imagen
- **Campos que pide:** folio, fecha, total
- **Bot:** ✅ 7elevenmexicosadecv.js · en la cola
- **Errores que distingue:** ya_facturado, ticket_vencido, datos_invalidos, captcha

> El folio es el codigo de barras de EXACTAMENTE 35 digitos; el portal rechaza si faltan.

## Enerfuel Tech  `enerfueltech`

- **URL:** https://factura.enerfueltech.com/
- **Tecnología:** Blazor/MudBlazor — "Facturar sin registro" con un único campo Referencia
- **CAPTCHA:** ninguno
- **Campos que pide:** referencia, total
- **Bot:** ✅ enerfueltech.js · en la cola
- **Errores que distingue:** datos_invalidos
- **Esperas fijas:** 19.9s (⚠️ el tope de sesión de Browserless son 60s)

> Ticket impreso por terminal NetPay. El portal pide SOLO la Referencia. La ventana real NO es fija: hay que consultar y confiar en la respuesta del portal.

<details><summary>Reconocimiento real del portal</summary>

```
Enerfuel Tech — factura.enerfueltech.com (plataforma Blazor/MudBlazor
compartida por varias marcas de gasolineras, ej. Grupo Inmo SA de CV).

Reconocimiento real (2026-07-27, cuenta real GPN, ticket real Grupo Inmo
SA de CV, Ticket 715245, Referencia 049847152458CE1, $1,000.00):
  1. "Facturar sin registro" (sin cuenta) → campo único "Referencia"
     (impreso en el ticket) → "Buscar". Si no hay consumo, el portal
     responde literalmente "No se encontró el consumo." — NO asumir un
     límite fijo de horas: se probó un ticket de hace 144h (vencido, "No
     se encontró") y otro de 72h que SÍ seguía disponible, así que la
     ventana real no es "24h" como se creía inicialmente — hay que
     consultar siempre y confiar en la respuesta real del portal, nunca
     en una regla de tiempo fija.
  2. "Continuar" revela el panel "Mis datos fiscales": Nombre/RFC/Código
     Postal son <input> normales; Régimen/Uso CFDI son MudSelect
     (componentes Blazor) — requieren un click SINTÉTICO REAL de
     Puppeteer (elementHandle.click(), NO el .click() de JS vía
     evaluate) para que el popover de opciones abra correctamente.
  3. El botón FACTURAR se habilita solo cuando los 5 campos obligatorios
     están completos (Entidad Federativa/Ciudad/Colonia/Calle son
     opcionales).
  4. Tras Facturar, la propia página muestra el folio real (ej.
     "RB-69628") y un campo de correo con botón "Enviar"/"Reenviar" —
     esa es la única vía de entrega confirmada (no hay descarga directa
     confiable vía Puppeteer en esta app Blazor/SignalR). Reconsultar la
     misma Referencia después es idempotente: el portal dice "El consumo
     ya fue facturado" y muestra el mismo folio sin generar duplicado.
```
</details>

## Enerser  `enerser`

- **URL:** http://facturacion.enerser.com.mx/
- **Tecnología:** misma plataforma que Enerfuel Tech, otro dominio
- **CAPTCHA:** ninguno
- **Campos que pide:** referencia, total
- **Bot:** ❌ sin bot · fuera del gate

> Mismo formato de ticket y mismo campo Referencia que enerfueltech, pero OTRO dominio: falta confirmar en vivo que bots/enerfueltech.js sirva tal cual antes de marcarlo activo.

## NexusFuel / facturacionestacion.com (Grupo GASHR y estaciones asociadas)  `gashr`

- **URL:** https://valerogdl.facturacionestacion.com
- **Tecnología:** NexusFuel multi-tenant — un subdominio por estación
- **CAPTCHA:** ninguno
- **Campos que pide:** folio, referencia, total
- **Bot:** ✅ gashr.js · en la cola
- **Errores que distingue:** datos_invalidos
- **Esperas fijas:** 7.7s (⚠️ el tope de sesión de Browserless son 60s)

> El subdominio cambia por estación (valerogdl., lasconchas., …): reconocer el DOMINIO, no el subdominio. Ventana corta: el ticket avisa 24 hrs.

<details><summary>Reconocimiento real del portal</summary>

```
Grupo GASHR (Autoservicio Gashr / Valero GDL) — valerogdl.facturacionestacion.com
Misma plataforma NexusFuel que Petrofigues (bots/petrofigues.js) — campos,
flujo, confirm() al facturar y descarga directa idénticos, confirmado en
vivo. Único cambio real: la URL base (grupogashr.com.mx → "IR A
FACTURACIÓN ELECTRONICA" → valerogdl.facturacionestacion.com).
Ticket real usado en reconocimiento: Autoservicio Gashr Valero GDL La 60,
Referencia 6060, Folio 1929725, $399.00. Cuenta GPN ya tenía perfil
guardado (mismo RFC, datos ligeramente distintos a los de Petrofigues —
cada tenant NexusFuel guarda su propio registro de cliente).
```
</details>

## Petrofigues  `petrofigues`

- **URL:** https://facturacion.petrofigues.com
- **Tecnología:** NexusFuel — misma plataforma y mismos campos que gashr
- **CAPTCHA:** ninguno
- **Campos que pide:** folio, referencia, total
- **Bot:** ✅ petrofigues.js · en la cola
- **Errores que distingue:** datos_invalidos
- **Esperas fijas:** 7.7s (⚠️ el tope de sesión de Browserless son 60s)

> Otro tenant NexusFuel. Cada tenant guarda su propio registro de cliente aunque el RFC sea el mismo.

<details><summary>Reconocimiento real del portal</summary>

```
Petrofigues — petrofigues.facturacionestacion.com (compartido por ~19
gasolineras del grupo, identificadas por "Referencia"/número de estación).

Reconocimiento real (2026-07-27, cuenta real GPN, ticket real Gonzer 1
"Brujas I", referencia 13697, ticket 1067336, $1,000.00):
  1. https://petrofigues.facturacionestacion.com/ es la ENTRADA ÚNICA
     para todas las estaciones — no hace falta pasar por el selector de
     sucursal del sitio de marketing (petrofigues.com/facturacion.html,
     cuyos links de estación son en realidad todos el mismo href).
  2. Form inicial: #txtReferencia (número de estación), #txtFolio
     (número de ticket), #txtAmount (importe total), #txtRFC → botón
     #btnNext ("Buscar") → POST Home/FindTicketAndClientData.
  3. Si el RFC ya factura seguido con este grupo, el cliente viene
     GUARDADO server-side y el resto del form se autocompleta (nombre,
     domicilio, colonia, CP, ciudad, estado, régimen fiscal, forma de
     pago) — confirmado con la cuenta real de GPN. El único campo que
     SIEMPRE queda vacío es "Uso CFDI" (select #selVoucherUse).
  4. #selVoucherUse es un <select> nativo pero sus <option value> son
     IDs numéricos internos (ej. "3" para "Gastos en general"), no
     "G03" — hay que buscar la opción por TEXTO, no por value fijo.
  5. Botón "Facturar" dispara un window.confirm() ("¿Está seguro que
     desea generar esta factura?") — SIN page.on('dialog') el tab muere
     (mismo bug ya documentado para 7-Eleven: diálogo no manejado).
  6. Tras aceptar, la factura se genera EN EL ACTO (no hay espera ni
     correo) — la respuesta de Home/CreateInvoice trae el nombre de
     archivo con el UUID real embebido:
     "20260727_{RFCEMISOR}_{RFCRECEPTOR}_{UUID}.xml^{estacion}"
  7. Descarga directa (confirmado real, XML+PDF verificados con la
     cuenta real): DownloadInvoice.aspx?fiscalFolioId={UUID}&stationId={estacion}
     devuelve el XML real (Content-Type: application/xml). El PDF se
     obtiene del mismo Report/ReportViewer.aspx que abre el link "PDF"
     (se navega esa URL en pestaña nueva y se captura la respuesta
     application/pdf).
  8. Reintentar el mismo folio es seguro/idempotente: el portal responde
     "Este folio ya fue facturado anteriormente!" con los mismos links
     de descarga, no genera un duplicado.
```
</details>

## CAPUFE — Caminos y Puentes Federales  `capufe`

- **URL:** https://facturacioncapufe.com.mx/Capufe/facturacionrapida
- **Tecnología:** SPA React + PrimeReact, backend REST
- **CAPTCHA:** ninguno
- **Campos que pide:** codigo, total
- **Bot:** ✅ capufe.js · en la cola
- **Errores que distingue:** datos_invalidos, ya_facturado
- **Esperas fijas:** 37.3s (⚠️ el tope de sesión de Browserless son 60s)

> Consultar el código lo RESERVA: si se valida y no se llega a "Facturar conceptos", queda tomado. Régimen y Uso CFDI son p-dropdown de PrimeReact, no <select>.

<details><summary>Reconocimiento real del portal</summary>

```
CAPUFE (Caminos y Puentes Federales) — facturacioncapufe.com.mx/Capufe/facturacionrapida
SPA React + PrimeReact, backend REST en /capufe-quadrum-backend/sinregistro/*.
Reconocimiento real confirmó:
 - El dato que pide el portal es el código "FACTURACION" de 18 caracteres
   impreso en el ticket (NO el folio) — placeholder "Código de 18 caracteres".
 - RFC dispara buscar_receptor_por_rfc.json (auto-completa si ya existe) +
   regimen/usocfdi_rfc.json + usocfdi40/uso_cfdi_por_rfc.json (catálogos).
 - Régimen Fiscal y Uso CFDI son <div class="p-dropdown"> (PrimeReact), NO
   <select> nativos — hay que hacer click para abrir el panel y click en el
   <li class="p-dropdown-item"> real; asignar .value no tiene efecto.
 - "Validar Código" llama a sinregistro/ticket/validar.json. Si el código ya
   fue validado antes en OTRA sesión sin llegar a "Facturar conceptos", el
   backend lo marca "ya se encuentra capturado" y lo rechaza — por eso todo
   el flujo debe correr en una sola sesión continua, sin cortes.
 - Botón final real es "Facturar conceptos" (el link de nav "Facturar sus
   códigos" solo navega a esta misma pantalla, no es el submit).
 - Aviso del propio portal: una vez emitida la factura NO se puede remitir
   a otro RFC ni corregir datos — los datos fiscales deben ser correctos
   desde la primera vez.
```
</details>

## Dana Comida Mexicana  `dana`

- **URL:** https://autofactura.softrestaurant.com
- **Tecnología:** SoftRestaurant / AutoFactura
- **CAPTCHA:** ninguno
- **Campos que pide:** —
- **Bot:** ✅ dana.js · en la cola
- **Errores que distingue:** ya_facturado, datos_invalidos, ticket_vencido, timeout
- **Esperas fijas:** 5.5s (⚠️ el tope de sesión de Browserless son 60s)

> referencia = código de facturación, distinto del folio.

## eRFC (plataforma compartida)  `erfc`

- **URL:** https://erfc.com.mx
- **Tecnología:** PHP + Select2 con catálogos por AJAX
- **CAPTCHA:** ninguno · requiere cuenta
- **Campos que pide:** —
- **Bot:** ✅ erfc.js · en la cola
- **Errores que distingue:** datos_invalidos
- **Esperas fijas:** 11s (⚠️ el tope de sesión de Browserless son 60s)

> El checkbox de términos está DISABLED hasta pulsar "Oprima para Leer Términos y Condiciones".

<details><summary>Reconocimiento real del portal</summary>

```
eRFC (erfc.com.mx) — plataforma compartida por muchas gasolineras/comercios
chicos que reciben CFDIs vía código IDW impreso en el ticket.

Reconocimiento real (2026-07-27, cuenta real GPN, ticket real "Natalia
María del Carmen Flores Arciniega S.A. de C.V.", IDW real confirmado):
  1. Home: correo + RFC + checkbox "He leído..." (DISABLED hasta hacer
     click en "Oprima para Leer Términos y Condiciones", que expande el
     texto inline y habilita el checkbox) → botón "Ingresar".
  2. /facturacion/: RFC llega prellenado por sesión. CP (#DomicilioFiscalReceptor)
     y Razón Social (#nombre) son inputs normales. Régimen Fiscal
     (#RegimenFiscalReceptor) y Uso CFDI (#selectUsoCfdi) son Select2 con
     datos vía AJAX (select.controller.php?select=regimenfiscal/usocfdi) —
     SOLO cargan tras un click real (Puppeteer, no dispatchEvent) sobre el
     <span class="select2-selection">, no sobre el <select> oculto. Uso
     CFDI ya trae "G03" preseleccionado por default.
  3. Email (#email) — cuidado: llega PRE-LLENADO con el correo del login,
     hay que limpiarlo antes de escribir o queda duplicado/concatenado.
  4. Código IDW: 5 inputs #idw_tmp_01..05, tamaños confirmados vía
     config.controller.php (len_box1=3, resto 4, total len_idws=19) — NO
     asumir 4 parejo. CRÍTICO: el propio portal advierte "Respete tal cual
     está impreso el código IDW mayúsculas y minúsculas" — en la prueba
     real, un carácter que a simple vista parecía letra "O" mayúscula
     resultó ser dígito "0" (confirmado porque letra/dígito no se pueden
     distinguir a simple vista en la fuente del ticket; se probó contra
     revisaIDW.php hasta obtener "1-O.K." en vez de error 500).
  5. Botón "+" (#btn_idw) agrega el IDW a la lista tras validarlo
     (revisaIDW.php). Botón "Enviar" (#btn_envio) hace la petición real
     (guarda_peticion.php) — la respuesta confirma con isOK:true, pero el
     CFDI real lo genera DESPUÉS "el establecimiento comercial" (proceso
     asíncrono, no hay descarga inmediata). Estado queda "Registrado" en
     "Mis Facturas" (facturas_x_usuario.controller.php) hasta que el
     comercio lo procese — se recoge por correo (mismo mecanismo IMAP que
     el resto del proyecto).
```
</details>

## FacturaGAS / ControlGAS (ATIO Group)  `facturagas`

- **URL:** https://app.facturagas.net
- **Tecnología:** ASP.NET — "Facturación sin Usuario"
- **CAPTCHA:** ninguno · requiere cuenta
- **Campos que pide:** —
- **Bot:** ✅ facturagas.js · en la cola
- **Historial:** 0/8 intentos con éxito · 13.7s de media
- **Errores que distingue:** datos_invalidos
- **Esperas fijas:** 17.3s (⚠️ el tope de sesión de Browserless son 60s)

> El ticket imprime una URL propia del negocio (ej. sumeca.ddns.net:83) que a menudo no resuelve. El WebID es el dato clave.

<details><summary>Reconocimiento real del portal</summary>

```
FacturaGAS / ControlGAS — app.facturagas.net (plataforma de ATIO Group,
rentada por muchas gasolineras chicas). El ticket imprime una URL propia
del negocio (ej. "sumeca.ddns.net:83/ControlGASFE" o similar DDNS) pero
esa URL suele estar mal transcrita/impresa (el ticket real de esta prueba
decía "umeca.ddns.net" — SIN LA S — y no resolvía; el backend real de
app.facturagas.net devolvió "sumeca.ddns.net", con S). No usar la URL
impresa en el ticket para navegar — usar SIEMPRE app.facturagas.net.

Reconocimiento real (2026-07-27, cuenta real GPN, ticket real Suministros
Energéticos de Calidad E12183, Folio 2025730, WebID 60844255, $1,500.00):
  1. app.facturagas.net → "Facturación sin Usuario" (sin cuenta/login) →
     generar_factura.aspx.
  2. Estación: input con autocomplete (#rstation_Input, RadComboBox
     Telerik) — escribir el nombre del comercio y hacer click en el <li>
     real de la lista (no basta con seleccionar por teclado).
  3. Folio (#despacho) + WebID (#webId) → "Consultar Ticket" (#btnSerchTk)
     → si son correctos aparece "Ticket validado correctamente" con
     Monto/Fecha reales para cruzar contra el ticket.
  4. RFC (#inputRfc2) + botón "Agregar" (el que está PEGADO al campo RFC,
     no el de más abajo) — CRÍTICO: los campos Nombre/Correo/CP/Régimen/
     Uso CFDI están INERTES (no aceptan texto) hasta que este "Agregar"
     del RFC se presiona. Llenarlos antes no tiene efecto y solo dispara
     la validación "Complete los campos marcados con (*)".
  5. Tras Agregar: #inputRazon, #inputCorreo, #inputCp (sin autofill —
     cuenta nueva para este RFC en esta plataforma), #cmbRegimen y
     #cmbUsos son <select> nativos normales (a diferencia de otros
     portales de esta tanda, aquí SÍ son selects reales).
  6. "Generar Factura" — la respuesta tarda más de 5s ("Consultando,
     espere..."); NO asumir fallo solo porque no se capturó la respuesta
     de red a tiempo. La forma confiable de confirmar es re-consultar el
     mismo Folio/WebID: si ya está facturado, el propio "Consultar
     Ticket" lo dice ("Folio ... ya ha sido facturado.") de forma
     idempotente (no genera un duplicado ni truena).
  7. Entrega: por CORREO real al buzón de captura (verificado: llega
     "Ha recibido un CFDI (FACTURA) para ..." con XML+PDF adjuntos
     reales) — no hay descarga directa confiable desde la UI de
     app.facturagas.net ni desde el portal legado sumeca.ddns.net/
     controlgasfe (que además pide un "Código Cliente" propio que no es
     ninguno de los datos impresos en el ticket).

⚠️ OJO — NO todas las estaciones "ControlGasFE" están en app.facturagas.net.
Varias corren su PROPIA instancia en un DDNS del negocio y no aparecen en el
autocomplete de estaciones del portal central. Comprobado con la estación
P22904 "LA SUERTE" (Inmobiliaria Hemajo de Atlacomulco), que factura en
http://hemajolasuerte.ddns.net:8087/ControlGasFE/ — ese portal pide los
mismos tres datos (Estación / Folio / Web ID) pero es otro sitio.

Y lo más importante para el negocio: esas instancias propias avisan
"Solo se pueden facturar notas máximo 72 HORAS posteriores a haber sido
realizadas". Es una ventana mucho más corta que los 30 días habituales, así
que un ticket de este tipo hay que subirlo y facturarlo el mismo día.
```
</details>

## Casetas de Sinaloa (Orler)  `orler`

- **URL:** https://facturacion.sinaloa.gob.mx
- **Tecnología:** Portal estatal con login de cuenta
- **CAPTCHA:** ninguno · requiere cuenta
- **Campos que pide:** —
- **Bot:** ✅ orler.js · en la cola
- **Historial:** 0/17 intentos con éxito · 26.1s de media
- **Errores que distingue:** reintentar_despues, ya_facturado
- **Esperas fijas:** 17.2s (⚠️ el tope de sesión de Browserless son 60s)

> Las casetas tardan 5-6 días hábiles desde el pago en aparecer: error_code reintentar_despues, no ticket inválido.

<details><summary>Reconocimiento real del portal</summary>

```
Orler / Sinaloa — facturacion.sinaloa.gob.mx (casetas de peaje del estado)
Requiere LOGIN (cuenta ya registrada por el usuario) — credenciales SOLO
por variables de entorno, nunca hardcoded: ORLER_SINALOA_USER / ORLER_SINALOA_PASS.

Reconocimiento real (2026-07-27, cuenta real GPN, ticket real Caseta El
Pisal folio 0944056):
  1. /login → input[name="user"] + input[name="password"] → botón "INICIAR SESIÓN"
     (los id tienen sufijos generados dinámicamente — usar name, no id).
  2. Tras login, ir directo a /nuevafactura (ya autenticado por cookie de sesión).
  3. Radio name="caseta": "Sí" (índice 0) revela el campo "Número de carril"
     (name="carril") — con "No" (default) ese campo NO existe en el DOM.
  4. Folio: input[name="folio"] ("Folio / Operación de Caja").
  5. Fecha de Pago: input de solo-lectura que abre un datepicker Material
     (mes actual por default) — hay que navegar con las flechas "<"/">" si
     el mes del pago no es el mes mostrado, y hacer click en el día.
  6. Importe: input[name="amount"].
  7. Botón "BUSCAR". Si el folio no es válido TODAVÍA (timing — Orler dice
     "Casetas de peaje: 5-6 días" desde el pago), aparece un modal "Alerta:
     El folio no se encuentra con los datos proporcionados". CONFIRMADO en
     vivo con datos reales y correctos — no es un bug de datos, es tiempo.

⚠️ Lo que sigue tras un "Buscar" EXITOSO (folio ya reconocido) NO se pudo
verificar en vivo — el único ticket real disponible seguía dentro de la
ventana de espera. Se implementa según las instrucciones que el propio
portal muestra en pantalla ("Da clic en el botón facturar y después
confirma los datos... tu factura se enviará por correo electrónico"), con
selectores por texto (más tolerantes a cambios que un id). Debe
reverificarse contra un folio real ya vencido antes de confiar en esta
parte ciegamente.
```
</details>

## RAMCAL  `ramcal`

- **URL:** https://corporativoramcal.mx
- **Tecnología:** portal propio con registro de cliente
- **CAPTCHA:** ninguno
- **Campos que pide:** —
- **Bot:** ✅ ramcal.js · en la cola
- **Errores que distingue:** datos_invalidos
- **Esperas fijas:** 33.1s (⚠️ el tope de sesión de Browserless son 60s)

> GPN ya tiene perfil guardado. Ojo con el Total: el ticket muestra SubTotal y Total, y el bueno es el Total.

<details><summary>Reconocimiento real del portal</summary>

```
RAMCAL — corporativoramcal.mx (grupo de gasolineras en Manzanillo/GDL,
plataforma "Kernotek" por estación: {url-propia-por-estación}/bajatufactura/).

Reconocimiento real (2026-07-27, cuenta real GPN, ticket real estación
E07932 "Ramcal Autopista Manzanillo Colima", Transacción 0201801651,
Código impreso "01292742361", $1,330.20):
  1. La página de facturación del sitio corporativo (corporativoramcal.mx
     /facturacion/) NO tiene formulario — solo lista las estaciones y un
     botón por cada una que lleva a su propio subdominio/URL
     "{host-de-la-estación}/bajatufactura/". Ese mapeo estación→URL debe
     resolverse ahí (no está impreso en el ticket, solo la clave de
     estación tipo "E07932").
  2. En "{url-estación}/bajatufactura/": "Generación de Factura" → RFC →
     Aceptar. IMPORTANTE: contra la suposición inicial de que Ramcal
     siempre requiere alta manual por correo, la búsqueda por RFC SÍ
     encuentra clientes ya dados de alta (probado con GPN, que ya
     estaba registrado) — solo hace falta el alta manual cuando el RFC
     no aparece en "CLIENTES ENCONTRADOS".
  3. "Seleccionar" el cliente → pantalla de Facturación con los datos
     fiscales guardados. OJO: esos datos pueden estar desactualizados
     (en la prueba real, el domicilio guardado tenía un CP y estado
     totalmente distintos a la Constancia de Situación Fiscal real —
     "SONORA C.P. 85080" en vez de "SINALOA C.P. 80140" — lo cual
     hubiera causado el mismo tipo de rechazo SAT que CFDI40147/
     DomicilioFiscalReceptor). Por eso este bot SIEMPRE pasa por
     "Editar Datos" y sobreescribe calle/número/colonia/municipio/
     estado/CP con los valores reales recibidos, en vez de confiar en
     lo que el portal ya tenga guardado.
  4. El "Código" (impreso en el ticket, ej. "01292742361" — DISTINTO de
     la "Transacción") identifica el consumo — se invalida tras usarse
     una vez ("Código inválido, verifique con la estación" en un
     reintento), así que no es idempotente para reconsulta: si ya se
     facturó, hay que buscarla por "Descargar Factura" → "Por Factura"
     (con el folio real, ej. "P275856"), NO reintentando el código.
  5. "Cuenta de pago (4 últimos dígitos)" viene del comprobante bancario
     (no del ticket de la gasolinera) — en la prueba real, el vale de
     Banorte/BBVA que acompaña al ticket. Uso CFDI ya trae "GASTOS EN
     GENERAL" por default.
  6. Tras "Facturar" se genera el folio real y aparece un botón
     "Descargar" directo en esa MISMA pantalla — pero si se necesita
     recuperar después (nueva sesión), solo queda la vía "Descargar
     Factura → Por Factura → Enviar Correo" (con el correo de captura).
```
</details>
