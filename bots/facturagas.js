// FacturaGAS / ControlGAS — app.facturagas.net (plataforma de ATIO Group,
// rentada por muchas gasolineras chicas). El ticket imprime una URL propia
// del negocio (ej. "sumeca.ddns.net:83/ControlGASFE" o similar DDNS) pero
// esa URL suele estar mal transcrita/impresa (el ticket real de esta prueba
// decía "umeca.ddns.net" — SIN LA S — y no resolvía; el backend real de
// app.facturagas.net devolvió "sumeca.ddns.net", con S). No usar la URL
// impresa en el ticket para navegar — usar SIEMPRE app.facturagas.net.
//
// Reconocimiento real (2026-07-27, cuenta real GPN, ticket real Suministros
// Energéticos de Calidad E12183, Folio 2025730, WebID 60844255, $1,500.00):
//   1. app.facturagas.net → "Facturación sin Usuario" (sin cuenta/login) →
//      generar_factura.aspx.
//   2. Estación: input con autocomplete (#rstation_Input, RadComboBox
//      Telerik) — escribir el nombre del comercio y hacer click en el <li>
//      real de la lista (no basta con seleccionar por teclado).
//   3. Folio (#despacho) + WebID (#webId) → "Consultar Ticket" (#btnSerchTk)
//      → si son correctos aparece "Ticket validado correctamente" con
//      Monto/Fecha reales para cruzar contra el ticket.
//   4. RFC (#inputRfc2) + botón "Agregar" (#btnValidRfc, el que está PEGADO
//      al campo RFC, no el de más abajo) — CRÍTICO: los campos Nombre/Correo/
//      CP/Régimen/Uso CFDI están INERTES hasta que ese "Agregar" se pulsa, y
//      #cmbRegimen/#cmbUsos traen UNA sola <option> de relleno. Llenarlos
//      antes no tiene efecto y solo dispara "Complete los campos marcados
//      con (*)".
//   5. Tras Agregar: #inputRazon, #inputCorreo, #inputCp (sin autofill) y
//      #cmbRegimen / #cmbUsos, que aquí SÍ son <select> nativos.
//   6. "Generar Factura" (#btnGenFacUs) — tarda más de 5s ("Consultando,
//      espere..."); NO asumir fallo por no capturar la respuesta de red. La
//      forma fiable de confirmar es re-consultar el mismo Folio/WebID: si ya
//      está facturado, "Consultar Ticket" lo dice ("ya ha sido facturado")
//      de forma idempotente, sin duplicar ni truenar.
//   7. Entrega: por CORREO al buzón de captura (verificado: llega "Ha
//      recibido un CFDI (FACTURA) para ..." con XML+PDF reales). No hay
//      descarga fiable desde la UI.
//
// ─────────────────────────────────────────────────────────────────────────
// REVISIÓN 11-sep-2026 (ticket #360, SERVICIO PIONEROS 4 SA DE CV, E13549).
// Sondas: scripts/probe-apv-10736.js (fachada central) y
// scripts/probe-pioneros4.js (el ControlGasFE propio de la estación).
//
// ⚠️ EL PLAZO DE 72 HORAS NO LO APLICA ESTA FACHADA — decisión tomada y
//    medida, no supuesta. Los ControlGasFE auto-hospedados publican en su
//    portada "Solo se pueden facturar notas máximo 72 horas posteriores a
//    haber sido realizadas", y el ticket #360 lo repite impreso. Pero ese
//    MISMO ticket (venta 2026-09-01 08:45) validó en app.facturagas.net el
//    2026-09-11 — 10 días después — con "Ticket validado correctamente",
//    Folio 31443100, $1191.23. Manda lo medido: aquí NO se aborta por plazo
//    antes de abrir el navegador. Si algún día el portal empieza a
//    rechazarlos, lo dirá él con sus palabras y eso sí se traduce a
//    ticket_vencido (ver rechazoPorPlazo()). Cortar por las 72h "por si
//    acaso" tiraría facturas que el portal sí acepta.
//
// ── VERIFICADO EL 11-sep-2026 LEYENDO EL JS QUE SIRVE EL PROPIO PORTAL ──────
// (un GET a app.facturagas.net/generar_factura.aspx y a scripts/generar_factura.js
//  — sin navegador y sin tocar nada). Tres cosas que NO se ven en pantalla y que
//  cambian el bot:
//
// ⚠️ LA ESTACIÓN NO SE LEE DEL INPUT. consultaTicket() hace
//    getvalue() → $find('rstation').get_selectedItem().get_value() → "E13549|False".
//    Manda el ITEM SELECCIONADO del RadComboBox, no el texto tecleado. Y el
//    combo llega PRESELECCIONADO de fábrica con "A40139: EXPRESS APEGAS" (el
//    primero de las 2370 estaciones del catálogo, que viene entero en el HTML).
//    O sea que si el click en el <li> no cuaja, #rstation_Input NO queda vacío
//    —queda con esa otra gasolinera de verdad— y la consulta se iría contra
//    ella. Releer el input no demuestra nada: se relee el selectedItem con la
//    MISMA llamada que usa el portal (ver seleccionarEstacion()).
//
// ⚠️ #btnGenFacUs NACE disabled Y SIN onclick. El HTML lo sirve
//    `disabled="disabled"`, y quien lo arma es SOLO el handler
//    $("#cmbUsos").on("change") → .prop("disabled",false)
//    .attr("onclick","generarFacturaUser(this)"). Un .click() del DOM sobre un
//    botón disabled no dispara nada Y NO FALLA: el bot daba el click por bueno,
//    no veía prueba de emisión y acababa en timbrado_sin_archivos — un ticket
//    muerto, a revisión manual, sin haber pulsado nada. Ahora se exige
//    habilitado + onclick ANTES de armar timbradoDisparado.
//
// ⚠️ EL ÉXITO TRAE UN "CÓDIGO DE RASTREO" QUE HAY QUE GUARDAR.
//    generarFacturaUser() llama por fetch a generar_factura.aspx/addNewInvoiceFG
//    (es AJAX: NO navega, no hay postback) y con la respuesta:
//      · si trae urlPDF+urlXML → abre el modal y mete "Descargar PDF"/"Descargar
//        XML" en #bxBtnInvoice y el código en <strong id="codInvSearch">;
//      · si NO los trae → avisa "Se generó un código de rastreo..." con el código
//        en <strong id="codFA"> y saca #btnReSerch ("Descarga de Factura").
//    Ese código es el que pide la pestaña "Buscar Factura" (#nroCheck, 'No.
//    rastreo') para recuperar el CFDI: es el `folioGenerado` de este portal, y
//    lib/facturacion.js solo conserva en error_msg lo que llegue en
//    folioGenerado/uuid (lo demás lo sobrescribe con NULL). Ojo además con que
//    el segundo caso NO dice "factura generada" en ninguna parte: buscar frases
//    de éxito a secas se queda corto.
//
// ⚠️ EL MODAL DE ÉXITO YA ESTÁ EN EL DOM DESDE EL PRIMER RENDER, con el texto
//    "La factura se genero correctamente..." escrito en el HTML. Está oculto
//    (display:none), así que no sale en innerText — pero por eso la foto
//    `textoAntes` de antes de pulsar NO es opcional: es lo que impide que una
//    frase de la plantilla se lea luego como prueba de emisión.
//
// ⚠️ EL PLAZO, COMPROBADO OTRA VEZ Y POR OTRO CAMINO: en el HTML que sirve
//    app.facturagas.net no aparece ni "72 horas", ni "plazo", ni "vencid", ni
//    "caduc". La nota de las 72 h es de los ControlGasFE auto-hospedados (y del
//    papel). Confirma la decisión de arriba: aquí no se aborta por plazo, y
//    rechazoPorPlazo() no puede dispararse con texto de plantilla porque no lo
//    hay.
//
// ⚠️ LA ESTACIÓN SE BUSCA POR SU CLAVE NUMÉRICA, NUNCA POR EL NOMBRE LARGO.
//    Medido con dos estaciones distintas el mismo día:
//      "13549 - SERVICIO PIONEROS 4 SA DE CV" → CERO opciones
//      "13549"                                → "E13549: Servicio Pioneros"
//      "10736 - ESTACION DE SERVICIO APV"     → CERO opciones
//      "10736"                                → "E10736: APV"
//    Por eso los candidatos numéricos van PRIMERO, y para ellos se exige que
//    la clave de la opción sea IGUAL (no "parecida") a la buscada: aceptar un
//    "contiene" numérico podía elegir E13540 al buscar 1354 y consultar el
//    ticket contra otra gasolinera.
//
// ⚠️ SI EL OCR NO TRAE LA ESTACIÓN, SE DEDUCE DEL CAMPO "TICKET" DEL PAPEL.
//    En el #360 el OCR no sacó ni comercio ni estación (dijo que era G500,
//    que no lo es). Pero el ticket imprime TICKET: 135490031443100, que es
//    estación(13549) + relleno(00) + folio(31443100). Se acepta ese número
//    largo (claveTicket) y solo se usa cuando TERMINA en el folio: así la
//    deducción es comprobable, no una adivinanza.
//
// ⚠️ NO USAR EL CONTROLGASFE PROPIO DE LA ESTACIÓN SI ESTÁ EN LA FACHADA.
//    pioneros4.ddns.net:82 funciona, pero mete un RadCaptcha de imagen
//    Telerik con _persistCode:false (cada GET a la imagen genera un código
//    nuevo, así que bajarla para mandarla a un solver invalida la vigente).
//    app.facturagas.net factura la MISMA estación sin captcha. El portal
//    propio solo tiene sentido si la estación deja de estar listada.
//
// ⚠️ #cmbUsos NO SE LLENA CON "Agregar": DEPENDE DEL RÉGIMEN. Medido en la
//    corrida de ensayo del #360 — tras pulsar #btnValidRfc el régimen trae 9
//    opciones y el uso de CFDI sigue con 1 sola. Se puebla al elegir el
//    régimen. Exigir los dos catálogos llenos tras "Agregar" abortaba el bot
//    con el formulario perfectamente bien.
//
// ⚠️ AL VALIDAR, EL PORTAL VACÍA EL PANEL "Consultar Ticket". Estación,
//    Folio y WebID vuelven a su placeholder y los datos se mudan al recuadro
//    "Información de Facturación" (Folio / Monto / Forma de Pago / Fecha).
//    Releer #despacho al final y encontrarlo vacío NO es un fallo.
//
// ⚠️ LAS DOS TRAMPAS QUE DEJARON TICKETS "FACTURADOS" SIN FACTURA, y que
//    esta revisión arregla:
//      · los clicks iban dentro de page.evaluate con `if (b) b.click()` y
//        sin devolver nada: si el botón no aparecía, el bot seguía tan
//        contento y acababa reportando éxito sin haber pulsado nada. Ahora
//        cada click devuelve si encontró el botón y se comprueba.
//      · no había `timbradoDisparado`: cualquier excepción DESPUÉS de
//        "Generar Factura" devolvía {ok:false} sin error_code, o sea el
//        error genérico, que REINTENTA CADA NOCHE. Con una factura ya
//        emitida eso es un CFDI duplicado por noche.
//
// ⚠️ `ya_facturado` NO EXISTE en lib/facturacion.js (comprobado hoy: no hay
//    ninguna rama que lo mire), así que devolverlo cae en el error genérico
//    y REINTENTA. Cuando el portal dice que el folio ya está facturado se
//    devuelve {ok:true, procesandoCorreo:true}: es prueba de que el CFDI
//    existe, el IMAP lo recoge, y no se reintenta nunca.
//
// ⚠️ OJO — NO todas las estaciones "ControlGasFE" están en app.facturagas.net.
// Varias corren su PROPIA instancia en un DDNS del negocio y no aparecen en el
// autocomplete de estaciones del portal central. Comprobado con la estación
// P22904 "LA SUERTE" (Inmobiliaria Hemajo de Atlacomulco), que factura en
// http://hemajolasuerte.ddns.net:8087/ControlGasFE/ — ese portal pide los
// mismos tres datos (Estación / Folio / Web ID) pero es otro sitio.
// Grupo Pioneros tiene una instancia por estación y www.gpopioneros.com las
// lista todas (pioneros1/pioneros4/pioneros22/grupopioneros/retogto .ddns.net).
//
// ── QUÉ TIENE QUE TRAER EL OCR, CON ESTOS NOMBRES EXACTOS ───────────────────
// (son los que lee facturarFacturaGAS; bots/index.js pasa el `datos` tal cual
//  salvo folio/total/portalUrl, que normalizarDatos() ya unifica)
//   · folio        → OBLIGATORIO. El número de 8 dígitos ENTRE PARÉNTESIS
//                    detrás de la hora. NO es el de la línea "FOLIO :" (en el
//                    #360 eso es 3144310, y el bueno es 31443100) ni la
//                    "NOTA #850602".
//   · webId        → OBLIGATORIO. "WEB ID" del ticket (8 dígitos). Sin él el
//                    portal no busca nada.
//   · estacionClave→ La clave de la estación, con o sin la E: "E13549"/"13549".
//                    Es lo que se teclea en el autocomplete. Si no viene, se
//                    intenta sacar de estacionNombre/comercio y de claveTicket.
//   · claveTicket  → El número largo de la línea "TICKET:" (135490031443100 =
//                    estación 13549 + relleno 00 + folio 31443100). Es el
//                    salvavidas cuando el OCR no saca la estación, y solo se
//                    usa si TERMINA en el folio, para que sea comprobable.
//   · estacionNombre / comercio → el nombre tal cual ("SERVICIO PIONEROS 4 SA
//                    DE CV"). Sirve para sacar la clave y para los mensajes; NO
//                    sirve para buscar (el autocomplete no casa por nombre).
//   · total        → OBLIGATORIO de hecho: es el cruce de importe contra el
//                    Monto que devuelve el portal, la red que caza una estación
//                    o un folio equivocados que por casualidad existen.
//   · portalUrl    → la URL impresa (pioneros4.ddns.net:82/...). Solo como
//                    último cartucho para adivinar la estación; NO se navega.
// Los fiscales (rfc, razonSocial, codigoPostal, regimenFiscal, usoCfdi) y
// emailEntrega NO salen del ticket: los pone normalizarDatos().
//
const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");

// Sleep propio. page.waitForTimeout está deprecado y desaparece en Puppeteer
// 22; el resto del bot no debería romperse el día que se suba la versión.
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// Buzón de captura. Es el ÚLTIMO recurso: el correo bueno llega en
// datos.emailEntrega (lo rellena normalizarDatos en bots/index.js). Si aquí
// entrara el correo del residente, el CFDI se emitiría y el sistema nunca lo
// recibiría.
const BUZON_CAPTURA = "buzonfacturas@serviciosga.site";

const digitos = (v) => String(v == null ? "" : v).replace(/\D/g, "");

// El portal dice CON SUS PALABRAS que el ticket ya no entra en plazo. Solo
// esto se traduce a ticket_vencido; la nota de "72 horas" impresa en el papel
// NO, porque la fachada central sí factura fuera de esa ventana (ver cabecera).
function rechazoPorPlazo(texto) {
  return /fuera de (tiempo|plazo)|plazo (vencido|excedido|expirado)|excedi[oó] el (tiempo|plazo)|ya no (es posible|se puede) facturar|caduc|vencid[oa]|72\s*horas/i.test(texto);
}

// "Ese folio ya tiene CFDI", dicho por el portal. El mensaje lo escribe el
// servidor de cada gasolinera (viaja en objTk_data.error y se pinta como
// alerta), así que NO hay una redacción garantizada: se aceptan las variantes
// vistas y las razonables. Es PRUEBA de que la factura existe, no un fallo —
// por eso vale tanto antes de emitir (para no duplicar) como después (para
// confirmar).
function diceYaFacturado(texto) {
  return /ya\s+(ha\s+sido|fue|est[aá])\s+factura|ya\s+facturad[oa]|ticket\s+facturado|nota\s+facturada|cuenta\s+con\s+factura/i.test(texto || "");
}

// Candidatos para el autocomplete de estaciones, de más fiable a menos.
// Los numéricos exigen coincidencia EXACTA de clave; los de texto se buscan
// por contenido (que es como funcionaba para las estaciones que sí casan por
// nombre). Devuelve [{ texto, esNumerico, origen }].
function candidatosEstacion({ estacionClave, estacionNombre, comercio, claveTicket, folio, portalUrl }) {
  const out = [];
  const push = (texto, esNumerico, origen) => {
    const t = String(texto || "").trim();
    if (!t) return;
    if (esNumerico && !/^\d{3,6}$/.test(t)) return;
    if (out.some((c) => c.texto.toUpperCase() === t.toUpperCase())) return;
    out.push({ texto: t, esNumerico, origen });
  };

  // 1) La clave, si el OCR la trajo suelta ("E13549" o "13549").
  push(digitos(estacionClave), true, "estacionClave");

  // 2) Los dígitos que vengan dentro del nombre: "13549 - SERVICIO PIONEROS 4"
  //    y "E10736 - APV" caen aquí. Se coge el PRIMER grupo de 4-6 dígitos,
  //    que es la clave; el "4" de "PIONEROS 4" no cuela por el mínimo de 4.
  for (const fuente of [estacionNombre, comercio]) {
    const m = String(fuente || "").match(/\b[A-Z]?(\d{4,6})\b/i);
    if (m) push(m[1], true, "clave dentro del nombre");
  }

  // 3) Deducción desde el número largo del papel (TICKET: 135490031443100 =
  //    estación + relleno + folio). Solo vale si TERMINA en el folio: así es
  //    comprobable. Sin esa comprobación sería inventarse la estación.
  const clave = estacionDesdeClaveTicket(claveTicket, folio);
  if (clave) push(clave, true, "deducida del número largo del ticket");

  // 4) Ya sin clave: el nombre tal cual y sus trozos, que es como se busca a
  //    mano. Sirve para estaciones que sí casan por nombre ("SUMINISTROS
  //    ENERGETICOS"); para las de Pioneros/APV no devuelve nada, por eso van
  //    detrás de los numéricos.
  for (const fuente of [estacionNombre, comercio]) {
    const limpio = String(fuente || "").trim();
    if (!limpio) continue;
    push(limpio, false, "nombre completo");
    const m = limpio.match(/^\s*[A-Z]?\d{3,6}\s*[-–]\s*(.+)$/i);
    if (m) push(m[1].trim(), false, "nombre sin clave");
    limpio.split(/\s*[-–]\s*/).forEach((t) => { if (t.trim().length > 3) push(t.trim(), false, "trozo del nombre"); });
    limpio.replace(/[.,]/g, " ").split(/\s+/)
      .filter((w) => w.length >= 5 && !/^(EST|ESTACION|ESTACIÓN|SERVICIO|SERVICIOS|GASOLINERA|COMBUSTIBLE)$/i.test(w))
      .forEach((w) => push(w, false, "palabra del nombre"));
  }

  // 5) Último cartucho: el subdominio del DDNS impreso ("sumeca.ddns.net" →
  //    "SUMECA"). No siempre es el nombre de la estación, pero cuesta cero.
  // ⚠️ Se descartan los subdominios que son el NOMBRE DE LA PLATAFORMA y no de
  // la gasolinera. El #360 llegó con portalUrl "g500facturagas.azurewebsites.net"
  // (el OCR se equivocó de portal y dijo G500): sin este filtro, ese trozo
  // entraba como candidato, el bot abría Browserless y gastaba una sesión para
  // teclear "g500facturagas" en un autocomplete donde no puede estar.
  const mUrl = String(portalUrl || "").match(/^(?:https?:\/\/)?([a-z0-9-]{4,})\./i);
  if (mUrl && !/^(www|app|portal|micuenta|factura|facturas|facturacion|facturagas|g500facturagas|controlgas|controlgasfe)$/i.test(mUrl[1])) {
    push(mUrl[1].replace(/[-_]/g, " "), false, "subdominio del portal");
  }

  return out;
}

// "135490031443100" con folio "31443100" → "13549". Se quitan los ceros de
// relleno que ControlGAS mete entre estación y folio. Si lo que queda no
// parece una clave (4-6 dígitos), se devuelve null: mejor sin estación que
// con una inventada.
function estacionDesdeClaveTicket(claveTicket, folio) {
  const t = digitos(claveTicket);
  const f = digitos(folio);
  if (t.length < 8 || f.length < 4 || !t.endsWith(f)) return null;
  const prefijo = t.slice(0, t.length - f.length).replace(/0+$/, "");
  return /^\d{4,6}$/.test(prefijo) ? prefijo : null;
}

// Teclear DE VERDAD y RELEER. Los inputs de este portal son normales, pero
// el patrón se respeta igual: si el valor no queda puesto (foco robado por el
// overlay "Consultando, espere...", maxlength más corto de lo esperado), el
// bot tiene que enterarse AQUÍ y no tres pantallas después.
async function tecleaYVerifica(page, selector, valor, etiqueta) {
  const texto = String(valor == null ? "" : valor);
  for (let intento = 1; intento <= 2; intento++) {
    await page.click(selector, { clickCount: 3 });
    await page.keyboard.press("Backspace");
    await page.keyboard.type(texto, { delay: 25 });
    await dormir(200);
    const leido = await page.$eval(selector, (el) => el.value).catch(() => null);
    if (leido != null && leido.trim() === texto.trim()) return leido;
    console.log(`   ⤳ ${etiqueta}: quedó "${leido}" en vez de "${texto}" (intento ${intento})`);
  }
  const leido = await page.$eval(selector, (el) => el.value).catch(() => null);
  // El portal recorta por maxlength: si lo que hay es un prefijo de lo que se
  // quiso escribir, el dato está mutilado y consultar con él daría un "no
  // encontrado" engañoso.
  throw new Error(`No se pudo escribir ${etiqueta} en ${selector}: quedó "${leido}" y se esperaba "${texto}"`);
}

// Un click que DICE si encontró el botón. El `if (b) b.click()` mudo es el bug
// que dio dos tickets por facturados sin haber pulsado nada.
//
// ⚠️ Y que además dice si el botón estaba DESHABILITADO. En este portal
// #btnGenFacUs se sirve `disabled="disabled"`; llamar a .click() sobre un botón
// disabled no dispara el handler NI lanza excepción, así que un "click
// reportado OK" sobre un botón muerto es exactamente el mismo engaño que el
// `if (b) b.click()` de antes, solo que más difícil de ver.
async function clickReportado(page, { id, textos }) {
  return page.evaluate(({ id, textos }) => {
    const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const activo = (el) => !el.disabled && el.getAttribute("aria-disabled") !== "true";
    const inventario = () => Array.from(document.querySelectorAll("button, a, input[type=button], input[type=submit]"))
      .filter(visible).map((b) => `${(b.textContent || b.value || "").trim()}${b.disabled ? " [disabled]" : ""}`).filter((t) => t.trim()).slice(0, 20);
    const porId = id ? document.getElementById(id) : null;
    if (porId && visible(porId)) {
      if (!activo(porId)) return { ok: false, via: `#${id}`, deshabilitado: true, visibles: inventario() };
      porId.click();
      return { ok: true, via: `#${id}`, etiqueta: (porId.textContent || porId.value || "").trim() };
    }
    const cands = Array.from(document.querySelectorAll("button, a, input[type=button], input[type=submit]"))
      .filter(visible)
      .filter((x) => textos.some((t) => new RegExp(`^\\s*${t}\\s*$`, "i").test((x.textContent || x.value || "").trim())));
    if (!cands.length) return { ok: false, via: null, hayId: !!porId, visibles: inventario() };
    const usable = cands.find(activo);
    if (!usable) return { ok: false, via: "texto", deshabilitado: true, visibles: inventario() };
    usable.click();
    return { ok: true, via: "texto", etiqueta: (usable.textContent || usable.value || "").trim() };
  }, { id, textos });
}

async function facturarFacturaGAS(datos = {}) {
  const {
    estacionNombre, estacionClave, comercio, claveTicket, folio, webId,
    rfc, razonSocial, codigoPostal, regimenFiscal, usoCfdi,
    emailEntrega, ticketId, total, portalUrl,
  } = datos;

  // ⚠️ Comprobar ANTES de abrir el navegador. Sin esto, un estacionNombre
  // undefined llegaba hasta page.keyboard.type() y reventaba con
  // "text is not iterable" — un mensaje que no dice nada, tras gastar una
  // sesión de Browserless. Pasó con los tickets #241 y #257: facturagas tenía
  // bot pero NO prompt de OCR, así que caían en el genérico y llegaban sin
  // estación ni webId.
  const candidatos = candidatosEstacion({ estacionClave, estacionNombre, comercio, claveTicket, folio, portalUrl });
  const faltan = [];
  if (!candidatos.length) faltan.push("estación (clave numérica de 4-6 dígitos, ej. 13549: el portal la busca por autocompletado y NO acepta el nombre largo)");
  if (!digitos(folio)) faltan.push("folio/despacho");
  if (!digitos(webId)) faltan.push("WebID");
  if (!String(rfc || "").trim()) faltan.push("RFC del receptor");
  if (faltan.length) {
    return { ok: false, error_code: "datos_invalidos", msg: `FacturaGAS: faltan datos del ticket — ${faltan.join(", ")}` };
  }

  const correoEntrega = String(emailEntrega || "").trim() || BUZON_CAPTURA;

  console.log("🤖 Iniciando bot FacturaGAS/ControlGAS...");
  console.log(`   Folio: ${folio} | WebID: ${webId} | RFC: ${rfc} | Correo: ${correoEntrega}`);
  console.log(`   Candidatos de estación: ${candidatos.map((c) => `"${c.texto}" (${c.origen})`).join(", ")}`);

  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error("BROWSERLESS_TOKEN no definido");
  // El connect se deja FUERA del try a propósito: un 429 de Browserless lo
  // reconoce ejecutarFacturacion() y reprograma en minutos, no a medianoche.
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true`,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1000 });
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");
  // Desde el primer instante: un alert() sin manejar cuelga el hilo y
  // Browserless mata la pestaña ("Session closed"/"Target closed").
  page.on("dialog", async (d) => { console.log("🔔 Dialog:", d.message()); await d.accept().catch(() => {}); });

  // Se pone en true en la línea anterior al click que EMITE. A partir de ahí
  // ningún camino puede devolver un error reintentable: el reintento de
  // medianoche emitiría un segundo CFDI contra el mismo ticket.
  let timbradoDisparado = false;
  let estacionElegida = null;

  const ts = ticketId || Date.now();
  async function screenshot(label) {
    try {
      const buf = await page.screenshot({ fullPage: true });
      const u = await subirArchivoR2(buf, `debug/facturagas_${ts}_${label}_${Date.now()}.png`, "image/png");
      console.log(`📸 [${label}]: ${u}`);
    } catch {}
  }

  // Espera a que se vaya el overlay "Consultando, espere...". Con un sleep
  // fijo de 3s el bot leía la pantalla TODAVÍA bloqueada y reportaba "no se
  // validó el ticket" con los datos correctos ya escritos (caso #319).
  async function esperarFinConsulta(maxVueltas = 20) {
    for (let i = 0; i < maxVueltas; i++) {
      await dormir(1500);
      const ocupado = await page.evaluate(() => /Consultando,\s*espere/i.test(document.body.innerText || "")).catch(() => false);
      if (!ocupado) return true;
    }
    return false;
  }

  async function seleccionarEstacion() {
    let vistas = [];
    for (const cand of candidatos) {
      await page.click("#rstation_Input", { clickCount: 3 });
      await page.keyboard.press("Backspace");
      await page.keyboard.type(cand.texto, { delay: 30 });
      await dormir(2500);
      const r = await page.evaluate(({ texto, esNumerico }) => {
        const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
        const items = Array.from(document.querySelectorAll("li, [role=option], .dx-item"))
          .filter((i) => visible(i) && (i.textContent || "").trim());
        const opciones = items.map((i) => i.textContent.trim().slice(0, 45)).slice(0, 12);
        let el = null;
        if (esNumerico) {
          // "E13549: Servicio Pioneros" → clave 13549. Se exige IGUALDAD:
          // un "contiene" elegiría E13540 al buscar 1354 y el bot acabaría
          // consultando el ticket contra OTRA gasolinera.
          const objetivo = texto.replace(/^0+/, "");
          const iguales = items.filter((i) => {
            const m = (i.textContent || "").match(/^\s*[A-Z]?0*(\d{3,8})\b/i);
            return m && m[1].replace(/^0+/, "") === objetivo;
          });
          if (iguales.length > 1) return { ok: false, ambiguo: true, opciones };
          el = iguales[0] || null;
        } else {
          const norm = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
          const buscado = norm(texto);
          el = items.find((i) => {
            const o = norm(i.textContent);
            return o.includes(buscado) || (o.length >= 6 && buscado.includes(o));
          }) || null;
        }
        if (!el) return { ok: false, opciones };
        el.click();
        return { ok: true, texto: el.textContent.trim(), opciones };
      }, { texto: cand.texto, esNumerico: cand.esNumerico });

      if (r.ok) {
        await dormir(1000);
        // ⚠️ AQUÍ NO VALE RELEER EL INPUT. consultaTicket() no mira el texto:
        // llama a getvalue() → $find('rstation').get_selectedItem().get_value().
        // Y el combo viene PRESELECCIONADO con "A40139: EXPRESS APEGAS", así que
        // un click que no cuaje deja el input NO vacío y la consulta se iría
        // contra esa otra gasolinera. Se relee el selectedItem con la MISMA
        // llamada del portal y se exige que sea el <li> que acabamos de pulsar.
        const sel = await page.evaluate(() => {
          try {
            const c = window.$find ? window.$find("rstation") : null;
            const it = c && c.get_selectedItem ? c.get_selectedItem() : null;
            return { valor: it ? String(it.get_value() || "") : null, texto: it && it.get_text ? String(it.get_text() || "") : null };
          } catch (e) { return { error: e.message }; }
        });
        const valor = await page.$eval("#rstation_Input", (el) => el.value).catch(() => "");
        // "E13549: Servicio Pioneros" → "E13549"; el value del combo es
        // "E13549|False", de ahí el split por "|".
        const clavePulsada = (String(r.texto || "").match(/^\s*([A-Za-z]?\d{3,8})\s*[:\-]/) || [])[1] || "";
        const claveSeleccionada = String(sel && sel.valor || "").split("|")[0].trim();
        console.log(`   ✅ estación: "${cand.texto}" (${cand.origen}) → "${r.texto}" | selectedItem="${sel && sel.valor}" | input="${valor}"`);

        if (claveSeleccionada) {
          // Se compara por clave ("E13549"); si la opción no la lleva delante,
          // se compara el TEXTO del item seleccionado con el que se pulsó. Lo
          // que no se hace nunca es dar por buena una selección sin cotejarla:
          // la que trae el combo de fábrica también es una estación real.
          const coincide = clavePulsada
            ? claveSeleccionada.toUpperCase() === clavePulsada.toUpperCase()
            : String(sel.texto || "").trim().toUpperCase() === String(r.texto).trim().toUpperCase();
          if (!coincide) {
            throw new Error(`Se pulsó "${r.texto}" pero el RadComboBox quedó con "${sel.valor}" ("${sel.texto}"): el portal consultaría OTRA estación. No se sigue.`);
          }
          return { texto: r.texto, clave: claveSeleccionada, valor };
        }
        // Sin API de Telerik (o sin item seleccionado) el respaldo es exigir que
        // el input haya quedado con el TEXTO EXACTO de la opción pulsada — que
        // es lo que escribe el propio combo al seleccionar. "No vacío" no basta:
        // el valor de fábrica ya es una estación real.
        if (String(valor).trim().toUpperCase() !== String(r.texto).trim().toUpperCase()) {
          throw new Error(`La estación "${r.texto}" se pulsó pero no quedó seleccionada (selectedItem=${sel && sel.valor === null ? "null" : JSON.stringify(sel)}, input="${valor}")`);
        }
        return { texto: r.texto, clave: clavePulsada, valor };
      }
      vistas = r.opciones || [];
      console.log(`   ⤳ "${cand.texto}" ${r.ambiguo ? "es AMBIGUO (varias estaciones con esa clave)" : "no casó"} (${vistas.length} opciones)`);
    }
    // Si falla, se dice QUÉ ofrecía el portal: sin eso el siguiente intento es
    // otra adivinanza.
    throw new Error(`FacturaGAS: la estación no aparece en el autocomplete. Se probó con "${candidatos.map((c) => c.texto).join('", "')}". Lo que ofrecía el portal: ${vistas.length ? vistas.join(" | ") : "(ninguna opción)"}`);
  }

  // Deja la pantalla en el estado "ticket consultado" y devuelve lo que dice.
  // Es idempotente: si el folio ya está facturado, el portal lo dice sin
  // emitir nada. Por eso sirve tanto de paso previo como de confirmación.
  async function consultarTicket() {
    await page.goto("https://app.facturagas.net/generar_factura.aspx", { waitUntil: "load", timeout: 40000 });
    await page.waitForSelector("#rstation_Input", { timeout: 20000 });
    await dormir(1200);
    estacionElegida = await seleccionarEstacion();
    await tecleaYVerifica(page, "#despacho", digitos(folio), "folio/despacho");
    await tecleaYVerifica(page, "#webId", digitos(webId), "WebID");
    await clickOblig(page, { id: "btnSerchTk", textos: ["consultar ticket", "consultar"] }, "Consultar Ticket");
    await esperarFinConsulta();
    await dormir(1200);
    return page.evaluate(() => document.body.innerText || "");
  }

  // Click que TIENE que existir. Si no está el botón, se para: seguir como si
  // se hubiera pulsado es exactamente lo que dejó tickets falsos.
  async function clickOblig(pag, sel, etiqueta) {
    const r = await clickReportado(pag, sel);
    if (!r.ok) throw new Error(`${r.deshabilitado ? `El botón "${etiqueta}" estaba DESHABILITADO (no se pulsó nada)` : `No se encontró el botón "${etiqueta}"`} (${sel.id ? "#" + sel.id : "por texto"}). Botones visibles: ${(r.visibles || []).join(" | ") || "(ninguno)"}`);
    console.log(`   🖱️ "${etiqueta}" pulsado (${r.via}${r.etiqueta ? `: "${r.etiqueta}"` : ""})`);
    return r;
  }

  try {
    console.log("🌐 Consultando ticket...");
    let texto = await consultarTicket();
    await screenshot("p1_post_consultar");

    if (diceYaFacturado(texto)) {
      // PRUEBA de que el CFDI existe, dicha por el portal. No se devuelve
      // 'ya_facturado' porque lib/facturacion.js NO tiene esa rama (comprobado
      // otra vez hoy: no hay ningún `error_code === 'ya_facturado'` en todo
      // lib/) y caería en el error genérico, que reintenta cada noche. Con
      // procesandoCorreo el ticket espera al IMAP y, si el correo no llega, a
      // los 60 min lib/imap-job.js lo pasa a 'error' con reintento_programado
      // NULL y el aviso de "NO reintentar" — nunca se reintenta solo.
      console.log("♻️ El portal dice que el folio YA está facturado — el CFDI se envió por correo (IMAP lo recogerá)");
      await browser.close().catch(() => {});
      return {
        ok: true,
        procesandoCorreo: true,
        // El rastro tiene que ir en folioGenerado: es lo único que
        // lib/facturacion.js conserva en error_msg (lo demás lo pisa con NULL).
        folioGenerado: `folio ${folio} · est. ${estacionElegida?.clave || estacionElegida?.texto || "?"} (YA facturado, recuperar en "Buscar Factura")`,
        msg: `FacturaGAS: el portal reporta el folio ${folio} como YA FACTURADO (estación ${estacionElegida?.texto || "?"}). NO RELANZAR: el CFDI existe; si el correo no llega, recupérese desde la pestaña "Buscar Factura" del portal.`,
      };
    }
    // app.facturagas.net NO guarda los consumos: es una fachada que consulta
    // en vivo el servidor de cada gasolinera. Cuando ese servidor está caído
    // devuelve "Error en el servicio, intente más tarde." — el ticket y los
    // datos están BIEN, no hay nada que corregir, solo hay que reintentar.
    // Le pasa hoy mismo a la E10736 (APV, ticket #351).
    if (/Error en el servicio, intente m[aá]s tarde/i.test(texto)) {
      await browser.close().catch(() => {});
      return {
        ok: false,
        error_code: "reintentar_despues",
        msg: `FacturaGAS: el servidor de la estación ${estacionElegida?.texto || estacionNombre || ""} no responde ("Error en el servicio, intente más tarde"). Los datos del ticket son correctos; hay que reintentar.`,
      };
    }
    // ⚠️ EL ORDEN IMPORTA: primero "¿validó?", y solo si NO validó se miran los
    // motivos. Los ControlGasFE auto-hospedados de esta familia llevan impresa
    // en su propia portada la advertencia "Solo se pueden facturar notas máximo
    // 72 horas posteriores...", así que buscar "72 horas" en todo el body
    // mataría como ticket_vencido hasta tickets recién dados por buenos. En
    // app.facturagas.net ese texto NO existe (comprobado leyendo el HTML que
    // sirve: ni "72 horas", ni "plazo", ni "vencid", ni "caduc"), pero el orden
    // se respeta igual porque el bot también vale para los portales propios.
    // El plazo solo cuenta cuando el portal RECHAZA.
    if (!/Ticket validado correctamente/i.test(texto)) {
      const plano = texto.replace(/\s+/g, " ");
      await browser.close().catch(() => {});
      if (rechazoPorPlazo(texto)) {
        return { ok: false, error_code: "ticket_vencido", msg: `FacturaGAS: el portal rechaza el ticket por plazo (estación ${estacionElegida?.texto || "?"}, folio ${folio}). Texto: ${plano.slice(0, 220)}` };
      }
      if (/no se encontr[oó]|folio inv[aá]lido|datos incorrectos|no existe/i.test(texto)) {
        return { ok: false, error_code: "datos_invalidos", msg: `FacturaGAS: ticket no reconocido en la estación ${estacionElegida?.texto || "?"} (folio ${folio}, webId ${webId}). Ojo: el folio bueno de ControlGAS es el número de 8 dígitos entre paréntesis detrás de la hora, NO el de la línea "FOLIO :".` };
      }
      return { ok: false, error_code: "reintentar_despues", msg: `FacturaGAS: no se validó el ticket (estación ${estacionElegida?.texto || "?"}, folio ${folio}, webId ${webId}). Texto: ${plano.slice(0, 250)}` };
    }
    console.log("✅ Ticket validado correctamente");

    // Cruzar el importe ANTES de emitir. Es la red que caza una estación o un
    // folio equivocados que, por casualidad, existen: un CFDI por el importe
    // de otra venta no se corrige, se cancela ante el SAT.
    const montoPortal = (texto.match(/monto[^0-9$]{0,20}\$?\s*([\d,]+\.\d{2})/i) || [])[1];
    const totalTicket = Number(total) || 0;
    if (montoPortal && totalTicket > 0) {
      const dif = Math.abs(Number(montoPortal.replace(/,/g, "")) - totalTicket);
      console.log(`   💲 Monto portal: $${montoPortal} | ticket: $${totalTicket.toFixed(2)} | dif: ${dif.toFixed(2)}`);
      if (dif > 1) {
        await screenshot("importe_no_cuadra");
        await browser.close().catch(() => {});
        return { ok: false, error_code: "datos_invalidos", msg: `FacturaGAS: el portal dice $${montoPortal} y el ticket $${totalTicket.toFixed(2)}. No se emite nada: puede ser otra estación u otro folio.` };
      }
    } else if (!montoPortal) {
      console.log("   ⚠️ no se pudo leer el monto en la pantalla de validación (no bloquea, pero no hubo cruce de importe)");
    }

    console.log("📋 RFC + Agregar...");
    await tecleaYVerifica(page, "#inputRfc2", String(rfc).trim().toUpperCase(), "RFC");
    await dormir(400);
    await clickOblig(page, { id: "btnValidRfc", textos: ["agregar"] }, "Agregar (RFC)");
    await dormir(2500);
    await screenshot("p2_post_agregar_rfc");

    // Prueba REAL de que "Agregar" hizo efecto: hasta pulsarlo, #cmbRegimen
    // trae una sola <option> de relleno y los campos de abajo están inertes.
    // Si sigue con una sola opción, el click no sirvió y llenar el formulario
    // solo dispararía "Complete los campos marcados con (*)".
    //
    // ⚠️ MEDIDO EN VIVO (11-sep-2026, E13549): "Agregar" llena SOLO el
    // régimen (9 opciones); #cmbUsos SIGUE con 1 sola opción y no se puebla
    // hasta que se elige el régimen. Exigir aquí que los dos estuvieran
    // llenos abortaba el bot con el formulario perfectamente bien.
    const catalogos = await page.evaluate(() => {
      const n = (id) => { const s = document.getElementById(id); return s ? s.options.length : -1; };
      return { regimen: n("cmbRegimen"), usos: n("cmbUsos") };
    });
    console.log(`   catálogos tras Agregar → régimen: ${catalogos.regimen} opciones | usos: ${catalogos.usos} (el de usos se llena al elegir régimen)`);
    if (catalogos.regimen <= 1) {
      throw new Error(`El botón "Agregar" del RFC no surtió efecto: el catálogo de regímenes sigue vacío (${catalogos.regimen} opciones)`);
    }

    console.log("📋 Datos fiscales...");
    await tecleaYVerifica(page, "#inputRazon", String(razonSocial || "").trim(), "razón social");
    // SIEMPRE el buzón de captura, nunca el correo del residente: si va el del
    // residente, el CFDI se emite y el sistema no lo recibe nunca.
    await tecleaYVerifica(page, "#inputCorreo", correoEntrega, "correo de entrega");
    await tecleaYVerifica(page, "#inputCp", digitos(codigoPostal).slice(0, 5), "código postal");

    const regimenCodigo = (String(regimenFiscal || "601").match(/\d{3}/) || [])[0] || "601";
    const regimenOk = await page.evaluate((cod) => {
      const sel = document.getElementById("cmbRegimen");
      if (!sel) return { ok: false, motivo: "no existe #cmbRegimen" };
      const opt = Array.from(sel.options).find((o) => new RegExp(`^\\s*0*${cod}\\b`).test(o.text) || o.value === cod);
      if (!opt) return { ok: false, motivo: "sin opción", opciones: Array.from(sel.options).map((o) => o.text.slice(0, 30)).slice(0, 10) };
      sel.value = opt.value;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: sel.value === opt.value, elegido: sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text : null };
    }, regimenCodigo);
    if (!regimenOk.ok) throw new Error(`No se pudo elegir el régimen fiscal ${regimenCodigo} (${regimenOk.motivo || "no quedó seleccionado"}${regimenOk.opciones ? ": " + regimenOk.opciones.join(" | ") : ""})`);
    console.log(`   régimen: ${regimenOk.elegido}`);

    // El catálogo de usos depende del régimen y lo carga el portal DESPUÉS de
    // elegirlo. Se espera a que aparezca en vez de dormir un rato fijo: con un
    // sleep corto se elegiría sobre la <option> de relleno y el CFDI saldría
    // con el uso equivocado (o el portal se quejaría de campos incompletos).
    const usosListos = await page.waitForFunction(() => {
      const s = document.getElementById("cmbUsos");
      return !!s && s.options.length > 1;
    }, { timeout: 20000 }).then(() => true).catch(() => false);
    if (!usosListos) {
      const unica = await page.evaluate(() => {
        const s = document.getElementById("cmbUsos");
        return s ? Array.from(s.options).map((o) => o.text).join(" | ") : "(no existe #cmbUsos)";
      });
      throw new Error(`El catálogo de Uso de CFDI no se pobló tras elegir el régimen ${regimenCodigo}. Opciones: ${unica}`);
    }
    await dormir(600);

    const usoCodigo = String(usoCfdi || "G03").toUpperCase().trim();
    const usoOk = await page.evaluate((cod) => {
      const sel = document.getElementById("cmbUsos");
      if (!sel) return { ok: false, motivo: "no existe #cmbUsos" };
      const opt = Array.from(sel.options).find((o) => o.text.toUpperCase().trim().startsWith(cod) || o.value.toUpperCase() === cod);
      if (!opt) return { ok: false, motivo: "sin opción", opciones: Array.from(sel.options).map((o) => o.text.slice(0, 30)).slice(0, 10) };
      sel.value = opt.value;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: sel.value === opt.value, elegido: sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text : null };
    }, usoCodigo);
    if (!usoOk.ok) throw new Error(`No se pudo elegir el uso de CFDI ${usoCodigo} (${usoOk.motivo || "no quedó seleccionado"}${usoOk.opciones ? ": " + usoOk.opciones.join(" | ") : ""})`);
    console.log(`   uso CFDI: ${usoOk.elegido}`);
    await dormir(600);
    await screenshot("p3_form_listo");

    // Última relectura antes de emitir: lo que se vaya a timbrar es lo que
    // esté AHORA en la pantalla, no lo que se escribió hace tres pasos.
    // ⚠️ folio y webId salen VACÍOS aquí y es NORMAL: al validar, el portal
    // limpia el panel "Consultar Ticket" y se lleva los datos al recuadro
    // "Información de Facturación" (Folio/Monto/Fecha). No son prueba de
    // nada; el que importa es el correo.
    const antesDeEmitir = await page.evaluate(() => {
      const v = (id) => { const el = document.getElementById(id); return el ? el.value : null; };
      return { rfc: v("inputRfc2"), razon: v("inputRazon"), correo: v("inputCorreo"), cp: v("inputCp"), folio: v("despacho"), webId: v("webId") };
    });
    console.log(`   📝 a timbrar: ${JSON.stringify(antesDeEmitir)}`);
    if (String(antesDeEmitir.correo || "").trim().toLowerCase() !== correoEntrega.toLowerCase()) {
      throw new Error(`El correo de entrega no quedó puesto: "${antesDeEmitir.correo}" en vez de "${correoEntrega}"`);
    }

    // ── EL CLICK QUE EMITE ──────────────────────────────────────────────────
    // Primero se comprueba que el botón está ARMADO, sin pulsarlo. Aquí todavía
    // se puede devolver un error reintentable sin peligro: no se ha emitido nada.
    //
    // ⚠️ NO BASTA CON QUE SE VEA. #btnGenFacUs se sirve `disabled="disabled"` y
    // sin onclick; quien lo arma es el handler de $("#cmbUsos").on("change"),
    // que le pone .prop("disabled",false) y onclick="generarFacturaUser(this)".
    // Un .click() sobre el botón deshabilitado NO dispara nada y NO falla: el
    // bot creía haber emitido, no encontraba prueba y devolvía
    // timbrado_sin_archivos — o sea, ticket muerto a revisión manual sin que
    // nadie hubiera pulsado nada. Si el botón no está armado, el formulario está
    // incompleto: se para ANTES de tocar timbradoDisparado.
    const hayBoton = await page.evaluate(() => {
      const visible = (el) => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      const b = document.getElementById("btnGenFacUs");
      const otro = b ? null : Array.from(document.querySelectorAll("button, a, input[type=button], input[type=submit]"))
        .filter(visible).find((x) => /^\s*generar\s+factura\s*$/i.test((x.textContent || x.value || "").trim())) || null;
      const el = b || otro;
      if (!el) return { ok: false, motivo: "no está en la página" };
      const onclick = el.getAttribute("onclick") || "";
      const usos = document.getElementById("cmbUsos");
      const detalle = {
        etiqueta: (el.textContent || el.value || "").trim(),
        visible: visible(el), deshabilitado: !!el.disabled, onclick,
        usoElegido: usos ? String(usos.value || "") : null,
        aviso: ((document.getElementById("msjGenInvoice") || {}).innerText || "").replace(/\s+/g, " ").trim().slice(0, 200),
      };
      if (!detalle.visible) return { ok: false, motivo: "está oculto", ...detalle };
      if (detalle.deshabilitado) return { ok: false, motivo: "sigue DESHABILITADO", ...detalle };
      // El botón solo se arma con el onclick puesto por el handler de #cmbUsos.
      // Sin él, pulsarlo no llama a generarFacturaUser() y no pasa nada.
      if (b && !/generarFacturaUser/.test(onclick)) return { ok: false, motivo: "no tiene onclick=generarFacturaUser", ...detalle };
      return { ok: true, ...detalle };
    });
    if (!hayBoton.ok) {
      await screenshot("boton_generar_sin_armar");
      await browser.close().catch(() => {});
      return {
        ok: false,
        error_code: "reintentar_despues",
        msg: `FacturaGAS: el botón "Generar Factura" (#btnGenFacUs) ${hayBoton.motivo}. NO SE EMITIÓ NADA (un click sobre él no habría hecho nada). Uso de CFDI elegido: "${hayBoton.usoElegido || "(vacío)"}"${hayBoton.aviso ? ` · aviso del portal: ${hayBoton.aviso}` : ""}`,
      };
    }

    // ENSAYO SIN TIMBRAR. Con FACTURAGAS_DRY_RUN=1 el bot recorre TODO el
    // flujo real (estación, folio/WebID, validación, RFC, catálogos, datos
    // fiscales) y se para en la pantalla ANTERIOR al botón que emite, con el
    // botón ya localizado. Emitir un CFDI es irreversible y cancelarlo es un
    // trámite ante el SAT: cualquier prueba de este bot se hace así.
    // Devuelve datos_invalidos a propósito — es el único código que NO
    // reintenta y deja el ticket a la vista de una persona, por si la variable
    // se queda puesta por error en producción.
    if (process.env.FACTURAGAS_DRY_RUN === "1") {
      await screenshot("dry_run_antes_de_emitir");
      await browser.close().catch(() => {});
      console.log("🛑 DRY RUN: todo listo, NO se pulsa \"Generar Factura\"");
      return { ok: false, error_code: "datos_invalidos", msg: `FacturaGAS DRY RUN: llegué a la pantalla anterior a "${hayBoton.etiqueta}" sin emitir. Estación ${estacionElegida?.texto}, folio ${folio}, WebID ${webId}, datos ${JSON.stringify(antesDeEmitir)}` };
    }

    // Foto del texto ANTES de emitir. Sin esto, una frase de la plantilla
    // ("la factura se enviará al correo...") podría leerse después como
    // prueba de emisión: un ok:true regalado. Solo cuenta lo que APARECE.
    const textoAntes = await page.evaluate(() => document.body.innerText || "");

    console.log(`🧾 Click "Generar Factura" — EMISIÓN REAL (${hayBoton.etiqueta})...`);
    // A partir de la línea siguiente la factura puede existir: ningún camino
    // puede devolver ya un error reintentable.
    timbradoDisparado = true;
    // El patrón Promise.all+waitForNavigation se mantiene por si el portal
    // cambiara a un postback, pero el timeout es CORTO a propósito: hoy
    // generarFacturaUser() es AJAX puro (fetch a
    // generar_factura.aspx/addNewInvoiceFG) y NO navega, así que la promesa
    // nunca resuelve y con los 90s de antes el bot se quedaba parado minuto y
    // medio, con la sesión de Browserless ocupada, antes de mirar la pantalla.
    // Lo que de verdad espera al timbrado es esperarFinConsulta() de abajo.
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 20000 }).catch(() => {}),
      clickOblig(page, { id: "btnGenFacUs", textos: ["generar factura"] }, "Generar Factura"),
    ]);

    await esperarFinConsulta(30);
    await dormir(2500);
    await screenshot("p4_post_generar");

    // Prueba en la propia pantalla (regla: ok:true solo con prueba). Se guarda
    // el UUID si aparece, porque es lo único con lo que se recupera el CFDI a
    // mano si el correo nunca llega.
    //
    // Las pruebas que deja este portal, por orden de dureza (todas medidas en
    // su propio JS, no supuestas):
    //   · #codInvSearch / #codFA → el "Código de Rastreo". Nacen VACÍOS y solo
    //     los escribe la respuesta OK de addNewInvoiceFG. Es el identificador
    //     con el que la pestaña "Buscar Factura" (#nroCheck) recupera el CFDI.
    //   · #bxBtnInvoice → nace vacío y recibe los <a> "Descargar PDF"/"XML".
    //   · #btnReSerch → nace con class="d-none" y solo se destapa en el camino
    //     "se generó un código de rastreo" (factura hecha, archivos aún no).
    //   · #btnGenFacUs pasa a d-none / sin onclick tras emitir. Se REGISTRA pero
    //     NO cuenta como prueba por sí solo: blockInput(false,true) —el camino
    //     de "Limpiar"— lo desarma igual sin haber facturado nada.
    const pantalla = await page.evaluate((antes) => {
      const t = document.body.innerText || "";
      const visible = (el) => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      const txt = (id) => { const el = document.getElementById(id); return el ? (el.textContent || "").trim() : ""; };
      const RX_EXITO = /factura\s+(se\s+)?gener[oó]|generada (correctamente|con [eé]xito)|timbrad|se envi[oó] (al|a su) correo|c[oó]digo de rastreo|ya ha sido facturado/i;
      const RX_UUID = /[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/i;
      const uuid = (t.match(RX_UUID) || [])[0] || null;
      const caja = document.getElementById("bxBtnInvoice");
      const enlaces = Array.from((caja || document).querySelectorAll("a[href]"))
        .map((a) => ({ href: a.href || "", texto: (a.textContent || "").trim() }))
        .filter((a) => /^https?:/i.test(a.href) && /\.(xml|pdf)(\?|$)|descargar\s+(pdf|xml)/i.test(a.href + " " + a.texto));
      const boton = document.getElementById("btnGenFacUs");
      return {
        texto: t.replace(/\s+/g, " ").slice(0, 400),
        aviso: ((document.getElementById("msjGenInvoice") || {}).innerText || "").replace(/\s+/g, " ").trim().slice(0, 250),
        // El UUID solo es prueba si NO estaba ya en la pantalla anterior.
        uuid: uuid && !(antes || "").includes(uuid) ? uuid : null,
        codigoRastreo: (txt("codInvSearch") || txt("codFA")).slice(0, 40) || null,
        xml: (enlaces.find((a) => /xml/i.test(a.href + a.texto)) || {}).href || null,
        pdf: (enlaces.find((a) => /pdf/i.test(a.href + a.texto)) || {}).href || null,
        reSerch: visible(document.getElementById("btnReSerch")),
        botonDesarmado: !!boton && (!visible(boton) || !/generarFacturaUser/.test(boton.getAttribute("onclick") || "")),
        exito: RX_EXITO.test(t) && !RX_EXITO.test(antes || ""),
        camposIncompletos: /complete los campos marcados/i.test(t),
      };
    }, textoAntes);
    console.log(`   pantalla tras emitir → éxito:${pantalla.exito} rastreo:${pantalla.codigoRastreo || "-"} uuid:${pantalla.uuid || "-"} pdf:${pantalla.pdf ? "sí" : "no"} xml:${pantalla.xml ? "sí" : "no"} btnReSerch:${pantalla.reSerch} botónDesarmado:${pantalla.botonDesarmado} camposIncompletos:${pantalla.camposIncompletos}`);
    if (pantalla.aviso) console.log(`   aviso del portal: ${pantalla.aviso}`);

    // Si el portal dejó los enlaces, se bajan AHORA (con las cookies de la
    // sesión) y el ticket se cierra con archivos en vez de quedarse esperando
    // un correo. Va todo en try: pasado el click que emite, nada de aquí abajo
    // puede tumbar el resultado.
    let xmlUrl = null, pdfUrl = null;
    const bajar = async (u) => {
      if (!u) return null;
      const d = await page.evaluate(async (x) => {
        try {
          const r = await fetch(x, { credentials: "include" });
          const b = await r.arrayBuffer();
          return { ok: r.ok, bytes: Array.from(new Uint8Array(b)) };
        } catch (e) { return { error: e.message }; }
      }, u).catch(() => null);
      return d && d.ok && d.bytes && d.bytes.length ? Buffer.from(d.bytes) : null;
    };
    try {
      const base = pantalla.uuid || pantalla.codigoRastreo || `facturagas_${ts}`;
      const bufXml = await bajar(pantalla.xml);
      const bufPdf = await bajar(pantalla.pdf);
      if (bufXml) xmlUrl = await subirArchivoR2(bufXml, `facturas/${base}.xml`, "application/xml");
      if (bufPdf) pdfUrl = await subirArchivoR2(bufPdf, `facturas/${base}.pdf`, "application/pdf");
    } catch (e) {
      console.log(`   ⚠️ no se pudieron bajar los archivos del portal (${e.message}) — los trae el correo`);
    }

    // Rastro con el que una persona recupera el CFDI si el correo no llega:
    // lib/facturacion.js SOLO conserva en error_msg lo que venga en
    // folioGenerado/uuid — cualquier otro texto de `msg` lo sobrescribe con
    // NULL. Sin esto, el aviso "NO RELANZAR" se pierde.
    const rastro = pantalla.codigoRastreo
      ? `rastreo ${pantalla.codigoRastreo} (pestaña "Buscar Factura")`
      : `folio ${folio} · est. ${estacionElegida?.clave || estacionElegida?.texto || "?"}`;

    // Prueba dura y en la mano: los archivos que sirvió el propio portal.
    if (xmlUrl || pdfUrl) {
      await browser.close().catch(() => {});
      console.log(`✅ FacturaGAS — CFDI emitido y descargado (${xmlUrl || pdfUrl})`);
      return { ok: true, xmlUrl, pdfUrl, uuid: pantalla.uuid || undefined, folioGenerado: pantalla.codigoRastreo || undefined };
    }

    // Prueba en la pantalla. El código de rastreo y #btnReSerch solo los escribe
    // la respuesta OK del servicio; la frase de éxito solo cuenta si NO estaba
    // ya antes de pulsar (por eso se comparó con textoAntes).
    const pruebaEnPantalla = !!(pantalla.codigoRastreo || pantalla.reSerch || pantalla.uuid || (pantalla.exito && !pantalla.camposIncompletos));

    // Si la pantalla no demostró nada, la palabra final la tiene el portal: se
    // re-consulta el MISMO folio (es idempotente, no duplica) y si dice que ya
    // está facturado es que el CFDI existe. Con prueba en pantalla esta vuelta
    // se salta: son ~20 s y otra sesión de Browserless ocupada para confirmar
    // algo que el portal ya dijo.
    let yaFacturado = false;
    let textoConfirm = "";
    if (!pruebaEnPantalla) {
      console.log("🔁 Re-consultando el folio para confirmar...");
      textoConfirm = await consultarTicket();
      await screenshot("p5_confirmacion");
      yaFacturado = diceYaFacturado(textoConfirm);
    }
    await browser.close().catch(() => {});

    if (pruebaEnPantalla || yaFacturado) {
      const comoSeSupo = pantalla.codigoRastreo ? `código de rastreo ${pantalla.codigoRastreo}`
        : pantalla.uuid ? `UUID ${pantalla.uuid}`
        : pantalla.reSerch ? 'apareció "Descarga de Factura"'
        : yaFacturado ? "el portal lo da por facturado al re-consultar el folio"
        : "la pantalla de resultado";
      console.log(`✅ FacturaGAS — emisión confirmada (${comoSeSupo}); el CFDI llega por correo (IMAP lo recogerá)`);
      return {
        ok: true,
        procesandoCorreo: true,
        uuid: pantalla.uuid || undefined,
        folioGenerado: rastro,
        msg: `FacturaGAS: CFDI emitido en ${estacionElegida?.texto || ""} folio ${folio} — confirmado por ${comoSeSupo}. Entrega por correo a ${correoEntrega}. NO RELANZAR.`,
      };
    }

    // Pulsado el botón, sin prueba de emisión y sin prueba de lo contrario.
    // NO se devuelve un código reintentable aunque el portal siga ofreciendo
    // el ticket: si esa consulta va con retraso, el reintento de medianoche
    // emitiría un duplicado. Queda a la vista de una persona, que en un
    // minuto lo comprueba en la pestaña "Buscar Factura" del portal.
    if (pantalla.camposIncompletos) {
      return {
        ok: false,
        error_code: "timbrado_sin_archivos",
        msg: `FacturaGAS: se pulsó "Generar Factura" y el portal respondió "Complete los campos marcados con (*)" — probablemente NO se emitió nada, pero hay que COMPROBARLO A MANO en app.facturagas.net (estación ${estacionElegida?.texto || "?"}, folio ${folio}, WebID ${webId}) antes de relanzar. NO RELANZAR a ciegas.`,
      };
    }
    return {
      ok: false,
      error_code: "timbrado_sin_archivos",
      msg: `FacturaGAS: se pulsó "Generar Factura" pero no hubo prueba de emisión ni de fallo. COMPROBAR A MANO en app.facturagas.net (estación ${estacionElegida?.texto || "?"}, folio ${folio}, WebID ${webId}) si el CFDI existe antes de relanzar.${pantalla.aviso ? ` Aviso del portal: ${pantalla.aviso}` : ""} Pantalla: ${pantalla.texto.slice(0, 160)} | re-consulta: ${String(textoConfirm || "(no se hizo)").replace(/\s+/g, " ").slice(0, 160)}`,
    };

  } catch (err) {
    console.error("❌ Error en bot FacturaGAS:", err.message);
    await screenshot("error").catch(() => {});
    await browser.close().catch(() => {});

    // El click de emitir ya salió: la factura PUEDE existir. Un error
    // reintentable aquí significa un CFDI nuevo cada noche.
    if (timbradoDisparado) {
      return {
        ok: true,
        procesandoCorreo: true,
        // Sin folioGenerado este aviso se pierde: lib/facturacion.js guarda en
        // error_msg SOLO el rastro que arma con folioGenerado/uuid y escribe
        // NULL si no llega ninguno. Es decir, el "NO RELANZAR" de aquí abajo no
        // lo leería nadie.
        folioGenerado: `folio ${folio} · est. ${estacionElegida?.clave || estacionElegida?.texto || "?"} (comprobar en "Buscar Factura")`,
        msg: `FacturaGAS: se pulsó "Generar Factura" y después falló el bot (${err.message}). NO RELANZAR: comprobar antes en app.facturagas.net si el CFDI ya existe (estación ${estacionElegida?.texto || "?"}, folio ${folio}, WebID ${webId}; pestaña "Buscar Factura"). El CFDI, si se emitió, llega por correo a ${correoEntrega}.`,
      };
    }
    // Que la estación no salga en el autocomplete NO se arregla esperando: o
    // el OCR no trajo la clave, o esa gasolinera no está en la fachada central
    // y hay que ir a su ControlGasFE propio. Reintentarlo cada noche para
    // siempre solo gasta sesiones de Browserless; que lo vea una persona.
    if (/no aparece en el autocomplete/i.test(err.message)) {
      return { ok: false, error_code: "datos_invalidos", msg: `FacturaGAS: ${err.message}` };
    }
    return { ok: false, error_code: "reintentar_despues", msg: `FacturaGAS: ${err.message}` };
  }
}

module.exports = { facturarFacturaGAS };
