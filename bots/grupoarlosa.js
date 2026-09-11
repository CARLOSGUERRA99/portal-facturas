// ═══════════════════════════════════════════════════════════════════════════
// Grupo Arlosa — https://facturacion.grupoarlosa.mx/   (Carl's Jr franquicia)
// ═══════════════════════════════════════════════════════════════════════════
// Emisor fiscal REAL del ticket #367: STAR LAGUNA S.A. DE C.V. (SLA101203DX4),
// "CARL'S JR INDEPENDENCIA", Torreón. NO es ICR: aunque la marca del ticket sea
// Carl's Jr, el portal de ICR es otro por completo (egridhub.com:6027/icr/
// autofactura, Next.js + shadcn) y no comparte ni un selector. Enrutar un
// ticket de Arlosa a bots/carljr.js es tiempo perdido, y al revés también.
//
// El OCR lee el dominio impreso en la tira térmica como "grupoa-losa.mx": ese
// dominio NO EXISTE (NET::ERR_NAME_NOT_RESOLVED). El guion es ruido de OCR
// sobre "grupoarlosa". Por eso PORTAL_URL es fija y se ignora portalUrl.
//
// Stack: CodeIgniter/PHP + jQuery 1.x + jQuery.steps + jquery.validate +
// jquery.mask + bootstrap-datepicker + iziToast/toastr + pdf.js.
// Timbrador TimbraXML/Verifact. SIN login y SIN captcha (cero referencias a
// recaptcha/hcaptcha/turnstile en los 21 <script> de la página).
//
// ── LO QUE ESTE ARCHIVO TENÍA MAL (se escribió a ciegas; corregido el
//    11-sep-2026 con el reconocimiento en vivo de scripts/probe-grupoarlosa.js)
//
//  1) EL WIZARD TIENE 4 PASOS, NO 3:
//        0 Datos del Ticket · 1 Datos Personales · 2 Vista Previa · 3 Facturar
//     #chk_confirmar vive en el 2 y las descargas (#documentos) en el 3.
//
//  2) EL BOTÓN DE TIMBRAR NO ES UN BOTÓN. Es el MISMO enlace de avance,
//     `div.actions a[href="#next"]`, cuyo hijo <span id="boton_siguiente">
//     cambia de "Siguiente" a "Facturar" en onStepChanged al llegar al paso 2.
//     Buscarlo por el texto "Facturar" (lo que hacía este bot) es jugar a la
//     ruleta: el MISMO nodo que en el paso 0 solo valida el ticket, en el paso
//     2 emite. Por eso aquí NUNCA se pulsa #next sin comprobar antes en qué
//     índice está el wizard (.steps li.current) y qué dice #boton_siguiente.
//
//  3) NUNCA HAY NAVEGACIÓN. Todo el flujo vive en una sola URL (SPA de un solo
//     GET). El bot viejo pulsaba "Facturar" con {navega:true, timeout:60000}:
//     60 s tirados esperando un evento que no ocurre jamás.
//
//  4) TRAS "FACTURAR" SALE UN iziToast SI/NO. "Esta a punto de facturar el
//     ticket ¿desea continuar?". EL CLICK EN #next NO TIMBRA: el portal enseña
//     el toast y devuelve false. QUIEN TIMBRA ES EL BOTÓN "SI" DEL TOAST, que
//     pone confirmarFacturar=true y relanza steps("next") → POST
//     /facturacion/verificaFactura. El bot viejo no contemplaba el toast: se
//     quedaba 90 s esperando un "CFDI generado" que no llegaba y devolvía
//     reintentar_despues — reintento nocturno eterno sobre un portal que, si
//     alguna vez llega a timbrar, NO PERMITE RE FACTURAR.
//
//  5) EL CRUCE DE IMPORTE POR TEXTO NO PUEDE FUNCIONAR: la Vista Previa es un
//     PDF pintado por pdf.js en un <canvas>, su texto no está en el DOM y
//     document.body.innerText nunca trae "$241.00". Se sustituye por el cruce
//     BUENO, que es del servidor: /facturacion/verificaParametros valida serie
//     + folio + importe + fecha contra el registro de la tienda y responde
//     {"success":"Datos del ticket correctos"}. Si el importe no cuadra, el
//     wizard no pasa del paso 0.
//
//  6) LOS SELECTS TIENEN ID PROPIO: #regimen y #uso_cfdi. La heurística
//     buscarSelect() que recorría labels y contenedores sobraba.
//
//  7) FALTABA timbradoDisparado. Ahora se pone a true (a) en la línea anterior
//     al click del "SI", y (b) desde page.on('request') en cuanto sale
//     cualquier POST a verificaFactura, venga del camino que venga.
//
// ── TRAMPAS DEL PORTAL (todas comprobadas en vivo) ────────────────────────
//
//  ! MODAL DE BIENVENIDA "CFDI Versión 4.0" con backdrop de Bootstrap. El
//    backdrop intercepta los clicks por coordenadas de Puppeteer: hasta que no
//    se cierra (button.btn-default "Aceptar"), elementHandle.click() no llega a
//    ningún campo.
//
//  ! LOS DOS <select> SE BORRAN SOLOS. Cualquier evento 'change' sobre
//    #register-rfc ejecuta obtieneRegimenEnSelect(), que hace
//    _regimen.innerHTML="" y _usoCFDI.innerHTML="" y vuelve a pedir el catálogo
//    por fetch. El change NATIVO del navegador salta tarde —cuando el RFC
//    pierde el foco— y en la corrida de reconocimiento borró un 601 y un G03 ya
//    elegidos. Por eso aquí: se teclea el RFC, se le fuerza el blur para que el
//    change nativo salte YA, se espera a que el catálogo vuelva, y solo
//    entonces se eligen los selects — y aun así se releen antes de avanzar.
//
//  ! "BUSCAR RFC" HACE form.reset() SI EL RFC NO ESTÁ EN EL PADRÓN. getData(),
//    en la rama de error, ejecuta $("#register-form")[0].reset() y borra razón
//    social, email, CP y los dos selects (solo repone el RFC). Rellenar antes
//    de pulsarlo es tirar el trabajo: se pulsa PRIMERO y se rellena DESPUÉS.
//
//  ! EL CORREO QUE IMPORTA ES #email. En el JS del portal la llamada a
//    verificaFactura manda `correo: $("#correo_promo").val()`, pero
//    #correo_promo NO EXISTE en esta plantilla (va vacío): el CFDI sale a la
//    cuenta que quedó dada de alta con users/guardarCuenta, es decir al #email
//    del paso 1. Ahí va SIEMPRE emailEntrega (el buzón de captura), nunca el
//    correo del residente.
//
//  ! RAZÓN SOCIAL SIN LA SOCIEDAD. El propio portal avisa: "Si eres persona
//    moral debes omitir la sociedad". Se recorta "S.A. DE C.V." y familia.
//
//  ! FECHA SOLO AAAA-MM-DD (mask '0000-00-00' + datepicker yyyy-mm-dd). Con
//    03/09/2026 el servidor responde "Los datos del ticket no son validos".
//
//  ! EL ERROR DEL PASO 0 ES ÚNICO Y AMBIGUO: "Los datos del ticket no son
//    validos" sale igual para folio inexistente, importe distinto, serie
//    distinta y fecha mal formada — se comprobó con 4 variantes contra el
//    endpoint. NO se puede distinguir ticket_vencido de datos_invalidos, así
//    que se devuelve datos_invalidos (va a revisión humana y NO reintenta);
//    ticket_vencido solo si el portal llega a decir "vencido/fuera de plazo"
//    con todas las letras. El plazo no está publicado en ninguna parte; dato
//    empírico: un ticket del 2026-09-03 fue aceptado el 2026-09-11.
//
//  ! TICKET YA FACTURADO: verificaParametros devuelve facturado:true y sale un
//    iziToast "¿Desea recuperar su factura?". El SI abre #modal-facturado,
//    donde con el RFC se recupera el ZIP (XML+PDF) del CFDI ya emitido. Ese
//    camino es de SOLO LECTURA y aquí se aprovecha: si el ticket ya estaba
//    facturado con nuestro RFC, se baja el CFDI y se devuelve ok:true con
//    archivos, que es lo que el sistema necesita. Si no se puede recuperar,
//    entonces sí ya_facturado.
//
//  ! FORMA DE PAGO: si verificaParametros devuelve pago_app:true, el portal
//    levanta un iziToast con overlay y un <select> 01-Efectivo / 04-Tarjeta
//    Crédito / 28-Tarjeta Débito que BLOQUEA la pantalla hasta pulsar
//    "Confirmar". Para el ticket #367 no salió (bandera_pago_app quedó false).
//    Si sale y no nos han pasado formaPago, se aborta con datos_invalidos:
//    inventar la forma de pago sale en el CFDI y obliga a cancelarlo ante el
//    SAT.
//
//  ! EL PORTAL LLEVA DE FÁBRICA LA PALABRA "facturar" EN UN AVISO: "acepto que
//    una vez emitida la factura, NO se podrá re facturar". Un regex ingenuo de
//    "no se podrá facturar" daría ya_facturado / ticket_vencido nada más abrir
//    la página. Por eso NADA se decide leyendo document.body.innerText: se
//    decide con el JSON de la API (page.on('response')) y con las banderas
//    globales del propio portal (rfc_validado, bandera_pdf, bandera_fact…),
//    que son `var` de nivel superior y se leen desde window.
//
// ── PRUEBA DE EMISIÓN (regla 1: nunca ok:true sin prueba) ─────────────────
//    Solo se da por timbrado si se ve AL MENOS UNA de estas tres:
//      a) la respuesta JSON de /facturacion/verificaFactura con `success` y
//         SIN `error`  ← la prueba fuerte, viene del servidor;
//      b) window.bandera_fact === true (el portal solo la pone dentro del
//         success de /facturacion/documentos, que solo corre si a) ocurrió);
//      c) el wizard en el paso 3 con #documentos ya relleno.
//    "No vi la palabra error" NO es prueba y aquí no se usa.
//
// ── HASTA DÓNDE LLEGÓ DE VERDAD EL RECONOCIMIENTO (11-sep-2026, #367) ────
//    ⚠️ LEE ESTO ANTES DE FIARTE DE NADA DE AQUÍ ARRIBA. Este archivo llegó a
//    tener un bloque que decía "COMPROBADO EN VIVO ... wizard en paso 2,
//    bandera_pdf=true, guardarCuenta devolvió éxito, la vista previa es
//    CJRINDAF-2842 de CAR LAGUNA con subtotal 207.76". NADA DE ESO SE
//    EJECUTÓ: scripts/probe-grupoarlosa.js para adrede en "Datos Personales"
//    (su [STOP] está en la línea 221) y tmp/arlosa/run2.log, el único log de
//    la corrida, termina ahí con rfc_validado:false y bandera_pdf:false. El
//    propio tmp/mapeo.txt marca los pasos 5 a 8 como "[NO EJECUTADO]". Se
//    borra porque un dato inventado con pinta de verificado es peor que no
//    tener dato: el siguiente que lo lea dejará de comprobar lo que hace falta.
//
//    LO QUE SÍ SE VIO CONTRA EL PORTAL REAL (tmp/arlosa/run2.log + los JSON
//    a1..a5 + el HTML y el JS del portal en tmp/arlosa/):
//      · verificaParametros → {"success":"Datos del ticket correctos"} con
//        tienda=CJRIND, ticket=1310093, importe=241.00, fecha=2026-09-03: el
//        ticket está dentro de plazo y sus cuatro datos son correctos.
//      · El truco del blur funciona: #regimen y #uso_cfdi quedaron en 601/G03
//        y jQuery.validate sobre #register-form devolvió {"valid":true}.
//      · El catálogo de #regimen trae los 8 regímenes (601 incluido) y el de
//        #uso_cfdi los 13 (G03 incluido).
//      · Rareza inofensiva: #regimen acaba con el catálogo duplicado porque
//        get_regimen se pide dos veces, una por el change que dispara
//        teclear() y otra por el change nativo del blur. Son idénticos y
//        page.select('601') acierta igual.
//      · Todo lo demás de esta cabecera (los 4 pasos, el enlace #next que se
//        renombra, el toast SI/NO, guardarCuenta/actualizarCuenta, el reset al
//        buscar un RFC nuevo, el borrado de los selects) sale de LEER el
//        código del portal —tmp/arlosa/autofacturacion.js— y el HTML ya
//        renderizado —tmp/arlosa/p1_inicio.html—, no de haberlo ejecutado.
//        Es fiable como mapa, no como prueba de que el bot lo recorra bien.
//
// ── PENDIENTE DE VER EN VIVO (nadie ha pasado de "Datos Personales") ──────
//    · guardarCuenta / actualizarCuenta. El RFC GPR110128QD8 NO consta dado de
//      alta en el padrón de Arlosa: en la primera corrida de verdad traerDatos
//      devolverá error y el portal irá por users/guardarCuenta. Los dos
//      caminos están escritos, solo que ninguno se ha ejecutado.
//    · generarVistaPrevia y bandera_pdf, el renombrado de #boton_siguiente a
//      "Facturar" y el propio #chk_confirmar. El candado de este bot
//      (paso===2 && el botón dice "Facturar") está tomado de onStepChanged
//      (autofacturacion.js:635-641), pero NO se ha visto disparar.
//    · El DOM del iziToast de confirmación. El texto de los botones ("SI"/"NO")
//      y el del mensaje ("Esta a punto de facturar el ticket ¿desea
//      continuar?") salen LITERALES del código del portal
//      (tmp/arlosa/autofacturacion.js:471-505), pero el contenedor .iziToast es
//      el estándar de la librería y no se ha visto pintado. Si el "SI" no
//      apareciera, el bot NO timbra y devuelve reintentar_despues explicando
//      que el POST verificaFactura no llegó a salir: reintentar es seguro.
//    · El camino de recuperación de un ticket ya facturado (#modal-facturado →
//      /facturacion/validar_ticket_facturado → zip_factura/{id}) se ha leído en
//      el código del portal, no se ha ejecutado: el #367 no estaba facturado.
//    · El HTML exacto que devuelve /facturacion/documentos y cómo son sus
//      enlaces. Se bajan todos los <a href> de #documentos y se acepta lo que
//      sean: XML suelto, PDF suelto o ZIP (unzipper). Si no se puede bajar
//      nada, se devuelve timbrado_sin_archivos (NO reintenta) con la ruta de
//      recuperación manual, porque el CFDI ya existe.
//    · Si además manda el CFDI por correo. No está confirmado, así que no se
//      devuelve procesandoCorreo alegremente: solo en el catch posterior al
//      click que emite, donde es obligatorio por contrato.
//    · Este bot NO puede correr todavía con el ticket #367 tal cual: el OCR
//      genérico entrega referencia:null y este portal exige SERIE (6 letras) +
//      FOLIO, que van impresos al pie bajo "PARA FACTURAR EN LINEA"
//      (#367 → SERIE CJRIND · FOLIO 1310093 · $241.00 · 2026-09-03). Hace
//      falta un prompt de OCR propio; mientras no exista, el bot aborta antes
//      de abrir el navegador diciendo exactamente qué falta.
// ═══════════════════════════════════════════════════════════════════════════
const puppeteer = require("puppeteer");
const unzipper = require("unzipper");
const { subirArchivoR2 } = require("../storage/r2");

const PORTAL_URL = "https://facturacion.grupoarlosa.mx/";
const BUZON = process.env.IMAP_USER || "buzonfacturas@serviciosga.site";
// Grupo Arlosa no publica correo de facturación (solo el formulario de contacto
// del pie). No se inventa uno: mandar la reclamación a un buzón inexistente
// bloquea el cobro igual pero sin que nadie se entere.
const EMAIL_FACTURACION = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dosDig = (n) => String(n).padStart(2, "0");

// El portal solo traga AAAA-MM-DD. Los tickets mexicanos vienen DD/MM/AAAA y el
// OCR a veces ya entrega ISO: se aceptan las dos y se rechaza lo que no sea una
// fecha real. Mandar una fecha inventada a un portal que no deja re facturar es
// justo lo que no se debe hacer.
function aFechaISO(valor) {
  if (!valor) return null;
  const s = String(valor).trim();
  let d, m, a;
  let g = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (g) {
    a = +g[1]; m = +g[2]; d = +g[3];
  } else {
    g = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
    if (!g) return null;
    d = +g[1]; m = +g[2]; a = +g[3];
    if (a < 100) a += 2000;
  }
  if (!(a >= 2000 && a <= 2100) || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const probe = new Date(Date.UTC(a, m - 1, d));
  if (probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
  return `${a}-${dosDig(m)}-${dosDig(d)}`;
}

// "GPN PINTURAS Y RECUBRIMIENTOS SA DE CV" → "GPN PINTURAS Y RECUBRIMIENTOS".
// El portal lo pide con todas las letras en el paso 1: "Si eres persona moral
// debes omitir la sociedad". Con la sociedad puesta, la validación contra el
// SAT del timbrador rebota la factura DESPUÉS de haberla pedido.
function sinSociedad(rs) {
  return String(rs || "")
    .replace(/[,.]?\s*(S\.?\s*A\.?\s*P\.?\s*I\.?|S\.?\s*A\.?|S\.?\s*DE\s*R\.?\s*L\.?|S\.?\s*C\.?|S\.?\s*A\.?\s*S\.?)(\s*DE\s*C\.?\s*V\.?)?\s*$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .toUpperCase();
}

async function facturarGrupoArlosa({
  serie, tienda, sucursal, folio, ticket, referencia,
  importe, total, monto, fecha, fechaTicket,
  rfc, razonSocial, regimenFiscal, usoCfdi, codigoPostal, cp,
  formaPago, emailEntrega, ticketId, portalUrl,
} = {}) {
  // ── VALIDACIÓN ANTES DE ABRIR EL NAVEGADOR ────────────────────────────────
  // Abrir Browserless cuesta y el límite de sesiones simultáneas es bajo: lo
  // que se puede saber sin navegador se sabe aquí.
  //
  // El identificador del ticket llega de tres formas según cómo lo haya leído
  // el OCR: serie y folio separados, solo uno, o los dos pegados en
  // `referencia` ("CJRIND-1310093"). Se intenta reconstruir antes de rendirse.
  let serieRaw = String(serie ?? tienda ?? sucursal ?? "").toUpperCase().replace(/[^A-Z]/g, "");
  let folioRaw = String(folio ?? ticket ?? "").trim().toUpperCase();
  const refRaw = String(referencia ?? "").trim().toUpperCase();
  const partir = (s) => s.match(/^([A-Z]{6})[\s\-_/]*([0-9]{1,12})$/);
  const pegados = partir(refRaw);
  if (pegados) {
    if (!serieRaw) serieRaw = pegados[1];
    // normalizarDatos() de bots/index.js copia `referencia` dentro de `folio`
    // cuando no hay folio propio, así que folioRaw puede ser la referencia
    // entera: en ese caso vale la parte numérica, no el pegote.
    if (!folioRaw || folioRaw === refRaw) folioRaw = pegados[2];
  }
  // Y el pegote puede llegar directamente en `folio` sin que haya `referencia`
  // ninguna (es lo que hace normalizarDatos cuando el OCR solo trajo un campo).
  // Sin esto se mandaría "CJRIND1310093" al #ticket del portal y la respuesta
  // sería el mismo "Los datos del ticket no son validos" de siempre, que no
  // distingue causas: se quemaría una sesión de Browserless para no enterarse.
  const pegadoEnFolio = partir(folioRaw);
  if (pegadoEnFolio) {
    if (!serieRaw) serieRaw = pegadoEnFolio[1];
    folioRaw = pegadoEnFolio[2];
  }
  folioRaw = folioRaw.replace(/[^0-9A-Z]/g, "");

  const importeNum = parseFloat(String(importe ?? total ?? monto ?? "").replace(/[^0-9.]/g, ""));
  const fechaISO = aFechaISO(fechaTicket ?? fecha);
  const cpFinal = String(codigoPostal ?? cp ?? "").replace(/\D/g, "");
  const correoEntrega = String(emailEntrega || BUZON).trim();
  const rfcFinal = String(rfc || "").toUpperCase().replace(/[^A-Z0-9&Ñ]/g, "");
  const razonFinal = sinSociedad(razonSocial);
  const regimenFinal = String(regimenFiscal || "601").trim();
  const usoFinal = String(usoCfdi || "G03").trim().toUpperCase();
  const pagoFinal = String(formaPago || "").replace(/\D/g, "");

  const faltan = [];
  if (!/^[A-Z]{6}$/.test(serieRaw)) {
    faltan.push(`serie de 6 letras (campo "Tienda" del portal; en el #367 es CJRIND)${serieRaw ? ` — llegó "${serieRaw}", que no son 6 letras` : " — no llegó"}`);
  }
  if (!folioRaw) faltan.push('folio del ticket (campo "Ticket" del portal)');
  if (!importeNum || !(importeNum > 0)) faltan.push("importe total del ticket");
  if (!fechaISO) {
    faltan.push(`fecha del ticket en AAAA-MM-DD${(fechaTicket ?? fecha) ? ` — llegó "${fechaTicket ?? fecha}" y no se pudo interpretar` : " — no llegó"}`);
  }
  if (!/^[A-Z&Ñ]{3,4}\d{6}[A-Z0-9]{3}$/.test(rfcFinal)) faltan.push(`RFC del receptor${rfcFinal ? ` — "${rfcFinal}" no tiene forma de RFC` : " — no llegó"}`);
  if (!cpFinal) faltan.push("código postal fiscal del receptor");
  if (faltan.length) {
    // La coletilla del OCR solo se pone cuando lo que falta es de verdad la
    // serie o el folio: si lo que falta es el RFC o el importe, mandar a nadie a
    // tocar el prompt de OCR es hacerle perder el rato.
    const esOcr = /serie|folio/i.test(faltan.join(" "));
    return {
      ok: false,
      error_code: "datos_invalidos",
      msg: `Grupo Arlosa: faltan datos que el portal exige — ${faltan.join("; ")}.${esOcr ? ' Este portal no factura sin serie y folio, y el OCR genérico no los separa (van impresos al pie del ticket, bajo "PARA FACTURAR EN LINEA"): hace falta un prompt propio para Arlosa (ver cabecera de bots/grupoarlosa.js).' : ""}`,
    };
  }
  // Una fecha posterior a hoy no es un ticket: es un OCR mal leído (día y mes
  // cambiados, típico con los tickets que imprimen M/D/AAAA). Se margen de 2
  // días por husos horarios del servidor.
  const dias = (Date.now() - Date.parse(`${fechaISO}T12:00:00Z`)) / 86400000;
  if (dias < -2) {
    return {
      ok: false,
      error_code: "datos_invalidos",
      msg: `Grupo Arlosa: la fecha del ticket (${fechaISO}) está en el futuro. Lo más probable es que el OCR haya cambiado día y mes (el ticket de Carl's Jr imprime M/D/AAAA). Revisar antes de mandarla al portal.`,
    };
  }

  const importeTexto = importeNum.toFixed(2);
  console.log("🤖 Iniciando bot Grupo Arlosa (Carl's Jr — franquicia, portal propio)...");
  console.log(`   Serie: ${serieRaw} | Folio: ${folioRaw} | Importe: $${importeTexto} | Fecha: ${fechaISO}`);
  console.log(`   RFC: ${rfcFinal} | Régimen: ${regimenFinal} | Uso: ${usoFinal} | CP: ${cpFinal}`);
  console.log(`   CFDI a: ${correoEntrega}`);
  if (portalUrl && !/grupoarlosa\.mx/i.test(String(portalUrl))) {
    console.log(`   ⚠️ La URL leída del ticket ("${portalUrl}") no resuelve; se usa ${PORTAL_URL}`);
  }

  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error("BROWSERLESS_TOKEN no definido");
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true`,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1200 });
  // Desde el primer instante: un alert() sin manejar cuelga el hilo y
  // Browserless mata la pestaña ("Session closed" / "Target closed").
  page.on("dialog", async (d) => { await d.accept().catch(() => {}); });

  const ts = ticketId || Date.now();
  async function shot(label) {
    try {
      const buf = await page.screenshot({ fullPage: true });
      const u = await subirArchivoR2(buf, `debug/grupoarlosa_${ts}_${label}_${Date.now()}.png`, "image/png");
      console.log(`📸 [${label}]: ${u}`);
    } catch {}
  }

  // Se pone a true en cuanto sale el click que EMITE. A partir de ese instante
  // NINGÚN camino puede devolver un error reintentable: el reintento nocturno
  // volvería a este portal, que además no permite re facturar.
  let timbradoDisparado = false;

  // ── ESPÍA DE LA API ──────────────────────────────────────────────────────
  // Aquí es donde el portal dice de verdad lo que pasa. Las decisiones se toman
  // con estos JSON, no con el texto de la pantalla (que lleva de fábrica la
  // palabra "facturar" en el aviso del checkbox).
  const api = {};
  const anota = (clave, cuerpo) => {
    let json = null;
    try { json = JSON.parse(cuerpo); } catch { json = null; }
    api[clave] = { texto: String(cuerpo || "").slice(0, 600), json };
    console.log(`   <- ${clave}: ${String(cuerpo || "").replace(/\s+/g, " ").slice(0, 200)}`);
  };
  // Red de seguridad definitiva: en cuanto el POST que timbra SALE del
  // navegador, el bot ya no puede devolver un error reintentable, venga ese
  // POST del click del "SI" o de cualquier otro camino que no hayamos previsto.
  let postTimbradoEnVuelo = false;
  page.on("request", (req) => {
    if (/\/facturacion\/verificaFactura/i.test(req.url())) {
      postTimbradoEnVuelo = true;
      timbradoDisparado = true;
      console.log("   🚨 POST verificaFactura EN VUELO — a partir de aquí no hay marcha atrás");
    }
  });
  page.on("response", async (res) => {
    const u = res.url();
    let clave = null;
    if (/\/facturacion\/verificaParametros/i.test(u)) clave = "verificaParametros";
    else if (/\/facturacion\/traerDatos/i.test(u)) clave = "traerDatos";
    else if (/\/users\/guardarCuenta/i.test(u)) clave = "guardarCuenta";
    else if (/\/users\/actualizarCuenta/i.test(u)) clave = "actualizarCuenta";
    else if (/\/facturacion\/generarVistaPrevia/i.test(u)) clave = "generarVistaPrevia";
    else if (/\/facturacion\/verificaFactura/i.test(u)) clave = "verificaFactura";
    else if (/\/facturacion\/documentos/i.test(u)) clave = "documentos";
    else if (/\/facturacion\/validar_ticket_facturado/i.test(u)) clave = "validarFacturado";
    if (!clave) return;
    try {
      const cuerpo = await res.text();
      // generarVistaPrevia devuelve el PDF preliminar en base64: no se vuelca
      // al log porque son cientos de KB de ruido.
      anota(clave, clave === "generarVistaPrevia" ? cuerpo.slice(0, 300) : cuerpo);
    } catch { /* respuesta ya consumida o sin cuerpo */ }
  });

  // ── LECTORES DE ESTADO ───────────────────────────────────────────────────
  // El estado real del wizard: el índice del paso (no su nombre), la etiqueta
  // del enlace de avance y las banderas globales del portal, que son `var` de
  // nivel superior en autofacturacion.js y por tanto viven en window.
  const estado = () =>
    page.evaluate(() => {
      const lis = Array.from(document.querySelectorAll("#div-factura-web .steps li"));
      const notif = document.querySelector("#validation-notification");
      const doc = document.querySelector("#documentos");
      return {
        paso: lis.findIndex((li) => li.classList.contains("current")),
        botonSiguiente: (document.querySelector("#boton_siguiente") || {}).textContent || null,
        notifTipo: notif ? notif.getAttribute("data-notify-type") : null,
        notifMsg: notif ? notif.getAttribute("data-notify-msg") : null,
        rfcValidado: typeof rfc_validado !== "undefined" ? rfc_validado : null,
        banderaPdf: typeof bandera_pdf !== "undefined" ? bandera_pdf : null,
        banderaFact: typeof bandera_fact !== "undefined" ? bandera_fact : null,
        banderaPagoApp: typeof bandera_pago_app !== "undefined" ? bandera_pago_app : null,
        documentos: doc ? (doc.innerHTML || "").trim().length : 0,
        toasts: Array.from(document.querySelectorAll(".iziToast, #toast-container .toast-message"))
          .map((e) => (e.textContent || "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 4),
      };
    }).catch(() => ({}));

  const valor = (sel) =>
    page.evaluate((s) => { const e = document.querySelector(s); return e ? String(e.value ?? "") : null; }, sel).catch(() => null);

  // ⚠️ PONER .value NO BASTA: #tienda, #fecha_ticket y #register-rfc llevan
  // jquery.mask, y jquery.validate mira lo que la máscara haya dejado. Se
  // teclea de verdad y se RELEE el campo; si no quedó, el bot lo dice en vez de
  // seguir a ciegas hacia un portal que no deja re facturar.
  async function teclear(sel, v) {
    const el = await page.$(sel);
    if (!el) return { ok: false, motivo: "el campo no existe" };
    await page.evaluate((s) => {
      const e = document.querySelector(s);
      if (!e) return;
      e.removeAttribute("readonly");
      e.disabled = false;
      e.value = "";
    }, sel);
    await el.click({ clickCount: 3 }).catch(() => {});
    await page.keyboard.type(String(v), { delay: 70 });
    await page.evaluate((s) => {
      const e = document.querySelector(s);
      if (!e) return;
      ["input", "keyup", "change"].forEach((ev) => e.dispatchEvent(new Event(ev, { bubbles: true })));
    }, sel);
    await sleep(350);
    const quedo = await valor(sel);
    if (!quedo || !quedo.trim()) return { ok: false, motivo: "el campo quedó vacío tras teclearlo" };
    return { ok: true, valor: quedo };
  }

  // Los catálogos de #regimen y #uso_cfdi llegan por fetch y arrancan VACÍOS
  // (options.length === 1, solo el "Selecciona…"). No es que tarden en pintarse:
  // es que hasta que el portal no llama a get_regimen / get_uso_CFDI no existen.
  async function esperarOpciones(sel, segundos = 25) {
    for (let i = 0; i < segundos * 2; i++) {
      const n = await page.evaluate((s) => { const e = document.querySelector(s); return e && e.options ? e.options.length : 0; }, sel).catch(() => 0);
      if (n > 1) return n;
      await sleep(500);
    }
    return 0;
  }

  // Un click dentro de page.evaluate SIEMPRE devuelve si encontró el nodo: un
  // `if (b) b.click();` mudo es lo que dejó dos tickets falsamente facturados.
  const clickSel = (sel) =>
    page.evaluate((s) => {
      const e = document.querySelector(s);
      if (!e) return false;
      e.click();
      return true;
    }, sel).catch(() => false);

  // El enlace de avance. NUNCA se llama sin haber comprobado antes el paso.
  // Se envuelve en waitForNavigation porque verificaParametros puede responder
  // {url: ...} y el portal hace window.location.href = data.url: si eso pasa, el
  // evaluate siguiente moriría con "Execution context was destroyed" DESPUÉS de
  // haber mandado el click.
  async function clickNext() {
    const [, hecho] = await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 8000 }).catch(() => {}),
      page.evaluate(() => {
        const a = document.querySelector('div.actions a[href="#next"]');
        if (!a) return false;
        a.click();
        return true;
      }).catch(() => false),
    ]);
    return hecho;
  }

  async function esperarPaso(idx, segundos = 45) {
    for (let i = 0; i < segundos * 2; i++) {
      const e = await estado();
      if (e.paso === idx) return e;
      await sleep(500);
    }
    return await estado();
  }

  const cerrar = async () => { await browser.close().catch(() => {}); };

  try {
    // ── PASO 0 — cargar y quitar el modal de bienvenida ───────────────────
    await page.goto(PORTAL_URL, { waitUntil: "networkidle2", timeout: 60000 });
    await sleep(2500);

    // El modal "CFDI Versión 4.0" trae backdrop de Bootstrap: mientras esté, el
    // backdrop se come los clicks por coordenadas y ningún campo recibe texto.
    const modalCerrado = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("button")).find((x) => /aceptar/i.test(x.textContent || ""));
      if (!b) return false;
      b.click();
      return true;
    }).catch(() => false);
    await sleep(1200);
    await page.evaluate(() => {
      // Cinturón y tirantes: si el botón no estaba, se quita el modal a mano.
      if (window.jQuery) window.jQuery(".modal").modal("hide");
      document.querySelectorAll(".modal-backdrop").forEach((e) => e.remove());
      document.body.classList.remove("modal-open");
    }).catch(() => {});
    await sleep(500);
    const backdrops = await page.evaluate(() => document.querySelectorAll(".modal-backdrop").length).catch(() => -1);
    console.log(`   Modal "CFDI Versión 4.0": botón Aceptar ${modalCerrado ? "pulsado" : "NO encontrado"} | backdrops que quedan: ${backdrops}`);

    if (!(await page.$("#tienda"))) {
      await shot("p0_sin_formulario");
      await cerrar();
      return {
        ok: false,
        error_code: "reintentar_despues",
        msg: `Grupo Arlosa: no apareció el formulario (#tienda) en ${PORTAL_URL}. El portal puede estar caído o rediseñado; los datos del ticket son correctos.`,
      };
    }

    // Este portal no tiene captcha (comprobado: cero sitekeys en los 21
    // <script>). Si algún día lo ponen, se para y lo hace una persona en vez de
    // pelearse a ciegas: integrarlo sería como en bots/littlecaesars.js.
    const html0 = await page.content().catch(() => "");
    if (/recaptcha|hcaptcha|turnstile|g-recaptcha/i.test(html0)) {
      await shot("p0_captcha_inesperado");
      await cerrar();
      return { ok: false, error_code: "captcha", msg: "Grupo Arlosa: el portal ahora muestra un captcha que antes no tenía — facturar a mano y revisar el bot" };
    }

    // ── PASO 0 — Datos del Ticket ─────────────────────────────────────────
    console.log("🎫 Paso 0 — Datos del Ticket...");
    for (const [sel, val, nombre] of [
      ["#tienda", serieRaw, "Tienda (serie)"],
      ["#ticket", folioRaw, "Ticket (folio)"],
      ["#importe", importeTexto, "Importe"],
      ["#fecha_ticket", fechaISO, "Fecha"],
    ]) {
      const r = await teclear(sel, val);
      if (!r.ok) {
        await shot("p0_campo_rebelde");
        await cerrar();
        return { ok: false, error_code: "reintentar_despues", msg: `Grupo Arlosa: no se pudo capturar "${nombre}" (${sel}): ${r.motivo}. El portal cambió o el campo tiene una máscara nueva.` };
      }
    }
    // El bootstrap-datepicker se queda abierto tapando el enlace "Siguiente".
    // Se cierra moviendo el foco a otro campo del MISMO formulario (tocar los
    // <h3> del wizard sería pedirle a jQuery.steps que salte de paso, y el
    // <body> puede tener encima el backdrop del modal).
    await page.evaluate(() => {
      const e = document.querySelector("#ticket");
      if (e) e.focus();
      if (window.jQuery && window.jQuery.fn.datepicker) window.jQuery("#fecha_ticket").datepicker("hide");
    }).catch(() => {});
    await page.keyboard.press("Escape").catch(() => {});
    await sleep(600);

    const fechaPuesta = await valor("#fecha_ticket");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaPuesta || "")) {
      await shot("p0_fecha_rebelde");
      await cerrar();
      return { ok: false, error_code: "reintentar_despues", msg: `Grupo Arlosa: #fecha_ticket quedó en "${fechaPuesta}" y el portal solo acepta AAAA-MM-DD (mask 0000-00-00). Hay captura en R2.` };
    }
    await shot("p0_lleno");

    // Este click NO timbra: dispara /facturacion/verificaParametros, que es la
    // validación del ticket contra el registro de la tienda (y de paso el ÚNICO
    // cruce de importe fiable que hay en todo el flujo).
    console.log("   → Siguiente (valida el ticket contra el portal)...");
    if (!(await clickNext())) {
      await shot("p0_sin_boton_next");
      await cerrar();
      return { ok: false, error_code: "reintentar_despues", msg: 'Grupo Arlosa: no se encontró el enlace de avance (div.actions a[href="#next"]) en el paso 0 — el portal cambió de plantilla' };
    }

    let est = await esperarPaso(1, 40);

    // Forma de pago obligatoria: iziToast con overlay que BLOQUEA la pantalla.
    if (est.banderaPagoApp === true || /forma de pago/i.test((est.toasts || []).join(" "))) {
      if (!/^(01|04|28)$/.test(pagoFinal)) {
        await shot("p0_pide_forma_pago");
        await cerrar();
        return {
          ok: false,
          error_code: "datos_invalidos",
          msg: `Grupo Arlosa: el portal exige la forma de pago del ticket ${serieRaw}-${folioRaw} (01 Efectivo / 04 Tarjeta Crédito / 28 Tarjeta Débito) y el ticket no la trae. No se elige al azar: la forma de pago sale impresa en el CFDI y equivocarla obliga a cancelarlo ante el SAT.`,
        };
      }
      const elegido = await page.evaluate((fp) => {
        const sel = document.querySelector(".iziToast select");
        if (!sel) return false;
        sel.value = fp;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        const b = Array.from(document.querySelectorAll(".iziToast button")).find((x) => /confirmar/i.test(x.textContent || ""));
        if (!b) return false;
        b.click();
        return true;
      }, pagoFinal).catch(() => false);
      console.log(`   Forma de pago ${pagoFinal} → ${elegido ? "confirmada" : "NO se pudo confirmar"}`);
      if (!elegido) {
        await shot("p0_forma_pago_rebelde");
        await cerrar();
        return { ok: false, error_code: "reintentar_despues", msg: "Grupo Arlosa: salió el toast de forma de pago y no se pudo pulsar Confirmar; con el overlay puesto no se puede seguir" };
      }
      await sleep(1500);
      est = await esperarPaso(1, 20);
    }

    const vp = api.verificaParametros && api.verificaParametros.json;

    // Ticket YA FACTURADO. El portal ofrece RECUPERAR el CFDI y ese camino es de
    // solo lectura: si sale bien, el sistema se queda con su factura (que es lo
    // que necesita) en vez de con un error.
    if (vp && vp.facturado) {
      console.log("   ⚠️ El portal dice que este ticket YA está facturado — intentando recuperar el CFDI...");
      await shot("p0_ya_facturado");
      const rec = await recuperarFacturaExistente(page, rfcFinal);
      if (rec.enlaces.length) {
        // ok:true aquí NO es "no vi errores": es que se bajó y se subió el XML
        // del CFDI, que es la prueba más dura que hay. La factura no la emite
        // esta corrida, ya existía.
        const archivos = await bajarYSubirCFDI(page, rec.enlaces, ts);
        if (archivos.xmlUrl) {
          await cerrar();
          console.log(`✅ CFDI ya existente recuperado — XML: ${archivos.xmlUrl}`);
          return { ok: true, xmlUrl: archivos.xmlUrl, pdfUrl: archivos.pdfUrl };
        }
      }
      await cerrar();
      return {
        ok: false,
        error_code: "ya_facturado",
        msg: `Grupo Arlosa: el ticket ${serieRaw}-${folioRaw} ya tiene CFDI emitido y no se pudo recuperar automáticamente${rec.error ? ` (${rec.error})` : ""}. Se baja a mano en ${PORTAL_URL}: mismos datos del ticket → "¿Desea recuperar su factura?" SÍ → RFC ${rfcFinal} → Enviar → Descargar Comprobante, y se asocia con scripts/asociar-cfdi.js.`,
      };
    }

    if (est.paso !== 1) {
      const msgPortal = (vp && (vp.error || vp.success)) || est.notifMsg || "";
      await shot("p0_no_avanza");
      await cerrar();
      // "Los datos del ticket no son validos" es el ÚNICO mensaje de error del
      // paso 0 y sale igual para folio inexistente, importe distinto, serie
      // distinta y fecha mal formada: no se puede distinguir un vencimiento de
      // un dato mal leído. Va a revisión humana (datos_invalidos, sin
      // reintento) y solo se declara ticket_vencido si el portal lo dice con
      // todas las letras.
      if (/venci|fuera de(l)? (plazo|periodo|mes)|caduc|expir/i.test(msgPortal)) {
        return {
          ok: false,
          error_code: "ticket_vencido",
          msg: `Grupo Arlosa: el portal rechazó el ticket ${serieRaw}-${folioRaw} por plazo — "${msgPortal}". ⚠️ Grupo Arlosa NO publica correo de facturación (solo el formulario de contacto del pie de ${PORTAL_URL}): la reclamación hay que hacerla a mano.`,
          ...(EMAIL_FACTURACION ? { email_contacto: EMAIL_FACTURACION } : {}),
        };
      }
      if (msgPortal) {
        return {
          ok: false,
          error_code: "datos_invalidos",
          msg: `Grupo Arlosa: el portal no acepta el ticket — "${msgPortal}". Se mandó tienda=${serieRaw}, ticket=${folioRaw}, importe=${importeTexto}, fecha=${fechaISO}. Ese mensaje es el mismo para folio inexistente, importe distinto, serie distinta o fecha fuera de plazo: hay que comprobarlos contra el pie del ticket ("PARA FACTURAR EN LINEA").`,
        };
      }
      return { ok: false, error_code: "reintentar_despues", msg: `Grupo Arlosa: el wizard no pasó de "Datos del Ticket" y el portal no dijo por qué (paso=${est.paso}). Puede ser un fallo pasajero del servidor.` };
    }
    console.log(`   ✔ Ticket validado por el portal: "${(vp && vp.success) || est.notifMsg}" — el importe $${importeTexto} lo cruzó el servidor contra el registro de la tienda`);

    // ── PASO 1 — Datos Personales ─────────────────────────────────────────
    console.log(`👤 Paso 1 — Datos Personales (RFC ${rfcFinal})...`);
    const rRfc = await teclear("#register-rfc", rfcFinal);
    if (!rRfc.ok) {
      await shot("p1_rfc_rebelde");
      await cerrar();
      return { ok: false, error_code: "reintentar_despues", msg: `Grupo Arlosa: no se pudo capturar el RFC (#register-rfc): ${rRfc.motivo}` };
    }

    // Se le fuerza el blur AHORA para que el 'change' NATIVO salte ya y
    // obtieneRegimenEnSelect() haga su innerHTML="" mientras no estorba. Si se
    // deja para luego, salta cuando el RFC pierde el foco solo —después de
    // haber elegido 601 y G03— y los borra los dos. Pasó en el reconocimiento.
    await page.evaluate(() => {
      const e = document.querySelector("#register-rfc");
      if (e) e.blur();
    }).catch(() => {});
    await esperarOpciones("#regimen", 25);

    // "Buscar RFC" va ANTES de rellenar nada: si el RFC no está en el padrón de
    // Arlosa, getData() hace $("#register-form")[0].reset() y borra razón
    // social, email, CP y los dos selects.
    console.log("   → Buscar RFC (#verificarRFC)...");
    if (!(await clickSel("#verificarRFC"))) {
      await shot("p1_sin_boton_rfc");
      await cerrar();
      return { ok: false, error_code: "reintentar_despues", msg: "Grupo Arlosa: no se encontró el botón Buscar RFC (#verificarRFC)" };
    }
    for (let i = 0; i < 20 && !api.traerDatos; i++) await sleep(500);
    await sleep(1500);
    const td = api.traerDatos && api.traerDatos.json;
    const rfcEnPadron = !!(td && td.success);
    console.log(`   traerDatos → ${rfcEnPadron ? "el RFC YA está en el padrón de Arlosa (autocompleta)" : "RFC nuevo: se da de alta al pulsar Siguiente"}`);
    await shot("p1_tras_buscar_rfc");

    // Razón social: el portal la exige y la valida contra el SAT. Si traerDatos
    // la trajo, se respeta la del padrón (es la que el portal dará por buena);
    // si no, va la nuestra ya sin la sociedad.
    let razonEnPantalla = (await valor("#razon_social")) || "";
    if (!razonEnPantalla.trim()) {
      if (!razonFinal) {
        await shot("p1_sin_razon_social");
        await cerrar();
        return { ok: false, error_code: "datos_invalidos", msg: `Grupo Arlosa: el RFC ${rfcFinal} no está en el padrón del portal y no se recibió razonSocial para darlo de alta. El portal la exige tal cual aparece en la constancia del SAT, SIN la sociedad ("... S.A. DE C.V.").` };
      }
      const rRs = await teclear("#razon_social", razonFinal);
      if (!rRs.ok) {
        await shot("p1_razon_rebelde");
        await cerrar();
        return { ok: false, error_code: "reintentar_despues", msg: `Grupo Arlosa: no se pudo capturar la razón social: ${rRs.motivo}` };
      }
      razonEnPantalla = rRs.valor;
    }
    console.log(`   Receptor: ${razonEnPantalla}`);

    // ⚠️ AQUÍ VA EL BUZÓN DE CAPTURA, NUNCA EL CORREO DEL RESIDENTE, y se
    // sobreescribe aunque traerDatos haya traído otro: el CFDI sale a la cuenta
    // que quede guardada, y si se va a un buzón que el sistema no lee, la
    // factura se emite, IMAP no la ve y el ticket espera para siempre — sin re
    // facturación posible que lo arregle.
    const rMail = await teclear("#email", correoEntrega);
    if (!rMail.ok || (rMail.valor || "").toLowerCase() !== correoEntrega.toLowerCase()) {
      await shot("p1_email_rebelde");
      await cerrar();
      return { ok: false, error_code: "reintentar_despues", msg: `Grupo Arlosa: el correo de entrega quedó en "${rMail.valor}" en vez de ${correoEntrega}. No se sigue: el CFDI se emitiría hacia un buzón que el sistema no lee.` };
    }

    const rCp = await teclear("#codigo_postal", cpFinal);
    if (!rCp.ok) {
      await shot("p1_cp_rebelde");
      await cerrar();
      return { ok: false, error_code: "reintentar_despues", msg: `Grupo Arlosa: no se pudo capturar el código postal (#codigo_postal): ${rCp.motivo}` };
    }

    // Los selects van AL FINAL y por id (#regimen / #uso_cfdi). Elegir #regimen
    // dispara get_uso_CFDI, que repuebla #uso_cfdi: elegir el uso antes es
    // tirarlo. Y se reintenta porque una respuesta tardía de get_regimen puede
    // haber vaciado los dos entre medias.
    let regOk = "", usoOk = "";
    for (let intento = 1; intento <= 3; intento++) {
      if (!(await esperarOpciones("#regimen", 20))) break;
      await page.select("#regimen", regimenFinal).catch(() => {});
      await sleep(1200);
      if (!(await esperarOpciones("#uso_cfdi", 20))) break;
      await page.select("#uso_cfdi", usoFinal).catch(() => {});
      await sleep(1500);
      regOk = (await valor("#regimen")) || "";
      usoOk = (await valor("#uso_cfdi")) || "";
      if (regOk === regimenFinal && usoOk === usoFinal) break;
      console.log(`   ⏳ los selects se vaciaron (#regimen="${regOk}" #uso_cfdi="${usoOk}") — reintento ${intento}/3`);
    }
    if (regOk !== regimenFinal || usoOk !== usoFinal) {
      const cat = await page.evaluate(() => ({
        reg: Array.from(document.querySelectorAll("#regimen option")).map((o) => o.value).filter(Boolean),
        uso: Array.from(document.querySelectorAll("#uso_cfdi option")).map((o) => o.value).filter(Boolean),
      })).catch(() => ({ reg: [], uso: [] }));
      await shot("p1_selects_rebeldes");
      await cerrar();
      // Si el catálogo llegó pero no trae nuestro valor, es un problema de
      // datos (el régimen no le corresponde a ese RFC); si ni llegó, es del
      // portal y reintentar de noche tiene sentido.
      if (cat.reg.length && !cat.reg.includes(regimenFinal)) {
        return { ok: false, error_code: "datos_invalidos", msg: `Grupo Arlosa: el régimen ${regimenFinal} no está en el catálogo que el portal ofrece para el RFC ${rfcFinal} (${cat.reg.join(", ")}). Revisar el régimen fiscal del cliente.` };
      }
      if (cat.uso.length && !cat.uso.includes(usoFinal)) {
        return { ok: false, error_code: "datos_invalidos", msg: `Grupo Arlosa: el uso de CFDI ${usoFinal} no está permitido para el régimen ${regimenFinal} (el portal ofrece ${cat.uso.join(", ")}).` };
      }
      return { ok: false, error_code: "reintentar_despues", msg: `Grupo Arlosa: no se pudieron fijar los selects fiscales (#regimen="${regOk}", #uso_cfdi="${usoOk}"): los catálogos llegan por fetch y una respuesta tardía los vacía. No se timbra a medias.` };
    }
    console.log(`   ✔ Régimen ${regOk} · Uso CFDI ${usoOk}`);
    await shot("p1_lleno");

    // Relectura FINAL de los cinco campos justo antes del click. Es el último
    // punto en el que todavía se puede parar sin haber dado de alta nada.
    // ⚠️ Y NO BASTA CON EL VALOR: los dos <select> nacen con disabled="true" en
    // el HTML y solo los habilita el callback del fetch del catálogo
    // (_regimen.disabled=false tras get_regimen, _usoCFDI.disabled=false tras
    // get_uso_CFDI). Un <select> deshabilitado NO entra en
    // $("#register-form").serialize(), que es exactamente lo que se manda a
    // users/guardarCuenta: la cuenta quedaría dada de alta SIN régimen ni uso de
    // CFDI y el CFDI saldría con lo que el portal decidiera por su cuenta.
    // jquery.validate tampoco avisa, porque su ignore es ":disabled,:hidden".
    const finalP1 = await page.evaluate(() => ({
      rfc: (document.querySelector("#register-rfc") || {}).value || "",
      razon: (document.querySelector("#razon_social") || {}).value || "",
      email: (document.querySelector("#email") || {}).value || "",
      cp: (document.querySelector("#codigo_postal") || {}).value || "",
      regimen: (document.querySelector("#regimen") || {}).value || "",
      uso: (document.querySelector("#uso_cfdi") || {}).value || "",
      regimenOff: !!(document.querySelector("#regimen") || {}).disabled,
      usoOff: !!(document.querySelector("#uso_cfdi") || {}).disabled,
    })).catch(() => ({}));
    if (
      finalP1.rfc !== rfcFinal || !finalP1.razon.trim() ||
      finalP1.email.toLowerCase() !== correoEntrega.toLowerCase() ||
      finalP1.cp !== cpFinal || finalP1.regimen !== regimenFinal || finalP1.uso !== usoFinal ||
      finalP1.regimenOff || finalP1.usoOff
    ) {
      await shot("p1_descuadrado");
      await cerrar();
      return { ok: false, error_code: "reintentar_despues", msg: `Grupo Arlosa: los datos fiscales no quedaron como se pidieron antes de avanzar (${JSON.stringify(finalP1)}). No se sigue: el siguiente click da de alta la cuenta y genera la vista previa.` };
    }

    // Validación de cliente SIN avanzar de paso: jQuery.validate es local y no
    // manda nada al servidor. Dice si "Siguiente" pasaría el filtro, y evita
    // pulsar a ciegas un enlace que ya no se puede deshacer del todo.
    const val = await page.evaluate(() => {
      const f = window.jQuery("#register-form");
      f.validate().settings.ignore = ":disabled,:hidden";
      return {
        valido: f.valid(),
        errores: Array.from(document.querySelectorAll("#register-form .validation-message"))
          .map((e) => (e.textContent || "").trim()).filter(Boolean).slice(0, 6),
      };
    }).catch(() => null);
    if (val && val.valido === false) {
      await shot("p1_invalido");
      await cerrar();
      return { ok: false, error_code: "datos_invalidos", msg: `Grupo Arlosa: el formulario fiscal no pasa la validación del portal — ${val.errores.join(" · ") || "sin detalle"}` };
    }

    // ⚠️ EL CFDI SALE A LA CUENTA GUARDADA, NO AL #email DE LA PANTALLA. Si el
    // RFC ya estaba en el padrón, el portal solo reescribe la cuenta cuando su
    // bandera_update está en true (la pone el keydown sobre .personaldata y el
    // change de los selects). Si por lo que sea quedara en false, el portal se
    // saltaría users/actualizarCuenta y mandaría el CFDI al correo que tuviera
    // guardado de antes —el de quien diera de alta ese RFC—, aunque en pantalla
    // se lea el nuestro. Se fuerza para que la cuenta quede con emailEntrega.
    if (rfcEnPadron) {
      await page.evaluate(() => { window.bandera_update = true; }).catch(() => {});
    }

    // Este click hace TRES cosas de golpe: users/guardarCuenta (o
    // users/actualizarCuenta si el RFC ya existía; ambos XHR síncronos),
    // facturacion/generarVistaPrevia y el salto a "Vista Previa". NO timbra.
    console.log("   → Siguiente (guarda la cuenta y genera la vista previa)...");
    if (!(await clickNext())) {
      await shot("p1_sin_boton_next");
      await cerrar();
      return { ok: false, error_code: "reintentar_despues", msg: "Grupo Arlosa: no se encontró el enlace de avance en el paso 1" };
    }

    est = await esperarPaso(2, 45);
    if (est.paso !== 2) {
      const gc = (api.guardarCuenta && api.guardarCuenta.json) || (api.actualizarCuenta && api.actualizarCuenta.json) || {};
      const msgPortal = gc.error || est.notifMsg || "";
      await shot("p1_no_avanza");
      await cerrar();
      if (msgPortal) {
        return { ok: false, error_code: "datos_invalidos", msg: `Grupo Arlosa: el portal rechazó los datos fiscales al dar de alta la cuenta — "${msgPortal}" (RFC ${rfcFinal}, CP ${cpFinal}, régimen ${regimenFinal}). No se timbró nada.` };
      }
      return { ok: false, error_code: "reintentar_despues", msg: `Grupo Arlosa: el wizard no llegó a "Vista Previa" y el portal no dijo por qué (paso=${est.paso}). No se timbró nada.` };
    }

    // ── PASO 2 — Vista Previa ─────────────────────────────────────────────
    // generarVistaPrevia es asíncrono y el wizard salta ANTES de que llegue:
    // hay que esperar a bandera_pdf. Si se pulsa "Facturar" sin vista previa, el
    // portal timbra igual (no la comprueba) y nos quedamos sin ver qué se emitió.
    console.log("👁 Paso 2 — Vista Previa: esperando el PDF preliminar...");
    for (let i = 0; i < 120 && est.banderaPdf !== true; i++) {
      await sleep(500);
      est = await estado();
      const gv = api.generarVistaPrevia && api.generarVistaPrevia.json;
      if (gv && gv.codigo === 400) break;
    }
    const gv = api.generarVistaPrevia && api.generarVistaPrevia.json;
    if (gv && gv.codigo === 400) {
      await shot("p2_vista_previa_error");
      await cerrar();
      return { ok: false, error_code: "datos_invalidos", msg: `Grupo Arlosa: el portal no pudo generar la vista previa — "${gv.error || "sin detalle"}". No se timbró nada.` };
    }
    if (est.banderaPdf !== true) {
      await shot("p2_sin_vista_previa");
      await cerrar();
      return { ok: false, error_code: "reintentar_despues", msg: "Grupo Arlosa: la vista previa (facturacion/generarVistaPrevia) no llegó a tiempo. No se timbró nada; reintentar es seguro." };
    }
    await shot("p2_vista_previa");

    // ── EL CANDADO ANTES DE EMITIR ────────────────────────────────────────
    // El enlace que se va a pulsar es el MISMO que en los pasos anteriores solo
    // validaba. Solo es el de facturar si el wizard está EXACTAMENTE en el paso
    // 2 y #boton_siguiente ya dice "Facturar" (lo renombra onStepChanged).
    est = await estado();
    if (est.paso !== 2 || !/facturar/i.test(String(est.botonSiguiente || ""))) {
      await shot("p2_estado_raro");
      await cerrar();
      return {
        ok: false,
        error_code: "reintentar_despues",
        msg: `Grupo Arlosa: no se pulsa el enlace de avance porque el wizard no está donde debería (paso=${est.paso}, botón="${est.botonSiguiente}"). Ese mismo enlace es el que emite: no se toca a ciegas. No se timbró nada.`,
      };
    }

    // Checkbox obligatorio: sin él, onStepChanging devuelve false con el aviso
    // "Por favor confirme que ha validado los datos de su factura".
    const marcado = await page.evaluate(() => {
      const c = document.querySelector("#chk_confirmar");
      if (!c) return null;
      if (!c.checked) c.click();
      if (!c.checked) {
        c.checked = true;
        c.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return c.checked === true;
    }).catch(() => null);
    if (marcado !== true) {
      await shot("p2_sin_checkbox");
      await cerrar();
      return { ok: false, error_code: "reintentar_despues", msg: "Grupo Arlosa: no se pudo marcar #chk_confirmar y el portal no factura sin él. No se timbró nada." };
    }
    await sleep(600);

    // Este click AÚN NO TIMBRA: con confirmarFacturar en false, el portal se
    // limita a enseñar el iziToast "Esta a punto de facturar el ticket ¿desea
    // continuar?" y devolver false. El que timbra es el "SI" del toast.
    console.log("🧾 Pulsando Facturar (esto solo abre la confirmación SI/NO)...");
    if (!(await clickNext())) {
      await shot("p2_sin_boton_facturar");
      await cerrar();
      return { ok: false, error_code: "reintentar_despues", msg: "Grupo Arlosa: no se encontró el enlace Facturar en la Vista Previa. No se timbró nada." };
    }

    // Se busca el "SI" SIN pulsarlo todavía, para poder distinguir "no salió el
    // toast" (nada emitido) de "salió y lo pulsé" (emitido).
    let hayToast = false;
    for (let i = 0; i < 40 && !hayToast; i++) {
      await sleep(500);
      hayToast = await page.evaluate(() => {
        const t = Array.from(document.querySelectorAll(".iziToast"))
          .find((x) => /a punto de facturar/i.test(x.textContent || ""));
        if (!t) return false;
        return !!Array.from(t.querySelectorAll("button")).find((b) => /^\s*s[ií]\s*$/i.test(b.textContent || ""));
      }).catch(() => false);
      // Si el POST que timbra ya salió por un camino que no previmos, se corta
      // la espera: a partir de ahí manda timbradoDisparado.
      if (timbradoDisparado) break;
    }
    if (!hayToast && !timbradoDisparado) {
      est = await estado();
      await shot("p2_sin_confirmacion");
      await cerrar();
      return {
        ok: false,
        error_code: "reintentar_despues",
        msg: `Grupo Arlosa: se pulsó Facturar y no apareció la confirmación SI/NO (paso=${est.paso}, aviso="${est.notifMsg}"). Ese click por sí solo NO timbra —el POST verificaFactura no salió—, así que reintentar es seguro.`,
      };
    }

    await shot("p2_confirmacion_si_no");

    // ⚠️⚠️ LÍNEA INMEDIATAMENTE ANTERIOR AL CLICK QUE EMITE. El "SI" pone
    // confirmarFacturar=true y relanza steps("next"), que dispara
    // POST /facturacion/verificaFactura = TIMBRADO IRREVERSIBLE.
    timbradoDisparado = true;
    // El resultado tiene TRES estados, no dos, y confundirlos es justo el fallo
    // que este bot no se puede permitir:
    //   true            → se pulsó el SI (el POST ya salió: b.click() ejecuta el
    //                     handler del toast, steps("next") y XHR.send() de forma
    //                     SÍNCRONA, así que cuando el evaluate devuelve, salió);
    //   false           → el botón no estaba en el DOM: nadie pulsó nada;
    //   {excepcion:...} → el evaluate MURIÓ (contexto destruido, pestaña caída…)
    //                     y NO se puede saber si el click llegó a ejecutarse.
    // Un `.catch(() => false)` mezclaría el tercero con el segundo y desarmaría
    // el seguro tras un posible timbrado → reintento nocturno = segundo CFDI
    // sobre un ticket que este portal no deja re facturar.
    const pulsadoSi = await page.evaluate(() => {
      const t = Array.from(document.querySelectorAll(".iziToast"))
        .find((x) => /a punto de facturar/i.test(x.textContent || ""));
      if (!t) return false;
      const b = Array.from(t.querySelectorAll("button")).find((x) => /^\s*s[ií]\s*$/i.test(x.textContent || ""));
      if (!b) return false;
      b.click();
      return true;
    }).catch((e) => ({ excepcion: e.message }));

    if (pulsadoSi === false && !postTimbradoEnVuelo && !api.verificaFactura) {
      // Solo aquí se desarma el seguro: el evaluate TERMINÓ y dice con todas las
      // letras que el botón no estaba, y por la red no ha salido ningún POST a
      // verificaFactura. No hay riesgo de duplicar.
      timbradoDisparado = false;
      await shot("p2_si_no_encontrado");
      await cerrar();
      return { ok: false, error_code: "reintentar_despues", msg: "Grupo Arlosa: apareció la confirmación pero no se pudo pulsar SI. No se timbró nada (no salió el POST verificaFactura)." };
    }
    if (pulsadoSi && pulsadoSi.excepcion) {
      // No se desarma nada: a partir de aquí manda timbradoDisparado y la prueba
      // de emisión decide. Se deja dicho en el log para quien lea la corrida.
      console.log(`   🚨 El click del SI murió a medias (${pulsadoSi.excepcion}) — se da por disparado y se comprueba con la respuesta del servidor`);
    }
    console.log("   🚨 SI pulsado — CFDI en emisión, ya no hay vuelta atrás");

    // ── PRUEBA DE EMISIÓN ─────────────────────────────────────────────────
    // Se espera a la respuesta del servidor, no a un texto de la pantalla.
    let vf = null;
    for (let i = 0; i < 240; i++) {
      await sleep(500);
      est = await estado();
      vf = api.verificaFactura && api.verificaFactura.json;
      // Timbrado Y descargas ya inyectadas: no hay nada más que esperar.
      if (est.banderaFact === true || est.paso === 3 || est.documentos > 0) break;
      // El portal dice que no timbró: tampoco hay nada que esperar.
      if (vf && (vf.error || vf.codigo === 400)) break;
      // ⚠️ Ver la RESPUESTA de verificaFactura no basta para salir corriendo: el
      // listener de red se entera ANTES de que el portal ejecute su callback, y
      // el callback es quien pide /facturacion/documentos y rellena #documentos.
      // Salir aquí dejaría la pantalla de descargas a medio pintar y el bot
      // devolvería timbrado_sin_archivos por pura prisa. 30 s de gracia.
      if (vf && vf.success && i > 60) break;
    }
    await shot("p3_resultado");

    const emitido =
      (vf && vf.success && !vf.error && vf.codigo !== 400) ||
      est.banderaFact === true ||
      (est.paso === 3 && est.documentos > 0);

    if (!emitido) {
      const errPortal = (vf && (vf.error || (vf.codigo === 400 && vf.error))) || est.notifMsg || (est.toasts || []).join(" · ") || "";
      await cerrar();
      // El propio servidor dice que NO timbró (data.error → toastr, y el portal
      // ni llama a documentos ni pone bandera_fact). Aun así NO se devuelve un
      // código reintentable: el POST ya salió y solo una persona mirando el
      // portal puede afirmar que no quedó CFDI.
      if (/ya (fue|ha sido|se encuentra|est[aá])\s*factur/i.test(errPortal)) {
        return { ok: false, error_code: "ya_facturado", msg: `Grupo Arlosa: al timbrar, el portal respondió que el ticket ${serieRaw}-${folioRaw} ya estaba facturado — "${errPortal}"` };
      }
      return {
        ok: false,
        error_code: "datos_invalidos",
        msg: `Grupo Arlosa: se pulsó SI y el portal respondió con error: "${errPortal || "sin mensaje"}". Lo más probable es que NO haya CFDI, pero el POST verificaFactura del ticket ${serieRaw}-${folioRaw} YA SALIÓ: antes de relanzar nada hay que comprobarlo en ${PORTAL_URL} (mismos datos → "¿Desea recuperar su factura?" → RFC ${rfcFinal}). Este portal no permite re facturar.`,
      };
    }
    console.log(`✅ El portal confirma la emisión: ${(vf && vf.success) || `bandera_fact=${est.banderaFact}, paso=${est.paso}`}`);

    // ── BAJAR EL CFDI ─────────────────────────────────────────────────────
    // /facturacion/documentos devuelve el HTML de descargas que el portal
    // inyecta en #documentos. No se sabe de antemano si son XML y PDF sueltos o
    // el ZIP de /facturacion/zip_factura/{id}: se baja lo que haya y se mira el
    // contenido, no la extensión.
    const enlaces = await page.evaluate(() =>
      Array.from(document.querySelectorAll("#documentos a[href], #acciones_facturado a[href]"))
        .map((a) => a.href).filter(Boolean).slice(0, 10)
    ).catch(() => []);
    console.log(`   Enlaces de descarga: ${enlaces.length ? enlaces.join(" | ") : "ninguno"}`);

    const archivos = await bajarYSubirCFDI(page, enlaces, ts);
    await cerrar();

    if (archivos.xmlUrl) {
      console.log(`✅ Grupo Arlosa OK — XML: ${archivos.xmlUrl} | PDF: ${archivos.pdfUrl}`);
      return { ok: true, xmlUrl: archivos.xmlUrl, pdfUrl: archivos.pdfUrl };
    }

    // El CFDI EXISTE pero no se pudo bajar. NO se devuelve nada reintentable ni
    // se finge un procesandoCorreo: no está confirmado que este portal mande el
    // CFDI por correo, y dejar el ticket esperando un correo que quizá no llegue
    // lo esconde. timbrado_sin_archivos lo deja a la vista de una persona con la
    // ruta exacta para recuperarlo, y no reintenta nunca.
    return {
      ok: false,
      error_code: "timbrado_sin_archivos",
      msg: `Grupo Arlosa: el CFDI del ticket ${serieRaw}-${folioRaw} (${serieRaw} ${folioRaw}, $${importeTexto}, ${fechaISO}) SÍ se timbró${archivos.pdfUrl ? ` (PDF recuperado: ${archivos.pdfUrl})` : ""}, pero no se pudo bajar el XML. NO RELANZAR EL BOT: este portal no permite re facturar. Se baja a mano en ${PORTAL_URL} con los mismos datos del ticket → "¿Desea recuperar su factura?" SÍ → RFC ${rfcFinal} → Enviar → "Descargar Comprobante" (ZIP con XML+PDF), y se asocia con scripts/asociar-cfdi.js.`,
    };
  } catch (e) {
    console.error("❌ Grupo Arlosa:", e.message);
    await shot("excepcion").catch(() => {});
    await cerrar();
    if (timbradoDisparado) {
      // El POST que timbra ya había salido: un reintento nocturno emitiría un
      // SEGUNDO CFDI sobre el mismo ticket y este portal no deja cancelar ni re
      // facturar. Se cierra en positivo y que lo compruebe una persona.
      return {
        ok: true,
        procesandoCorreo: true,
        msg: `Grupo Arlosa: el bot falló (${e.message}) DESPUÉS de mandar el timbrado del ticket ${serieRaw}-${folioRaw}. NO RELANZAR: comprobar antes en ${PORTAL_URL} si el CFDI ya existe (mismos datos del ticket → "¿Desea recuperar su factura?" SÍ → RFC ${rfcFinal} → Enviar → Descargar Comprobante) y asociarlo con scripts/asociar-cfdi.js.`,
      };
    }
    return { ok: false, error_code: "reintentar_despues", msg: `Grupo Arlosa: ${e.message} (no se timbró nada)` };
  }
}

// ── Recuperación de un CFDI YA emitido ──────────────────────────────────────
// Camino de SOLO LECTURA del portal para los tickets que ya tienen factura:
// iziToast "¿Desea recuperar su factura?" → SI → #modal-facturado → se teclea el
// RFC en #rfc_ticket_facturado → #validar_facturado → POST
// /facturacion/validar_ticket_facturado → <a href=".../facturacion/zip_factura/
// {id}">. Nada de esto emite; el RFC tiene que ser el mismo con el que se
// facturó o el portal responde error.
async function recuperarFacturaExistente(page, rfcFinal) {
  try {
    const abierto = await page.evaluate(() => {
      const t = Array.from(document.querySelectorAll(".iziToast"))
        .find((x) => /recuperar su factura/i.test(x.textContent || ""));
      if (!t) return false;
      const b = Array.from(t.querySelectorAll("button")).find((x) => /^\s*s[ií]\s*$/i.test(x.textContent || ""));
      if (!b) return false;
      b.click();
      return true;
    }).catch(() => false);
    if (!abierto) {
      // El toast puede haberse cerrado solo: se abre el modal a mano.
      await page.evaluate(() => { if (window.jQuery) window.jQuery("#modal-facturado").modal(); }).catch(() => {});
    }
    await sleep(1500);

    const puesto = await page.evaluate((r) => {
      const e = document.querySelector("#rfc_ticket_facturado");
      if (!e) return false;
      e.value = r;
      e.dispatchEvent(new Event("input", { bubbles: true }));
      e.dispatchEvent(new Event("change", { bubbles: true }));
      return e.value === r;
    }, rfcFinal).catch(() => false);
    if (!puesto) return { enlaces: [], error: "no salió el modal de recuperación (#rfc_ticket_facturado)" };

    const pulsado = await page.evaluate(() => {
      const b = document.querySelector("#validar_facturado");
      if (!b) return false;
      b.click();
      return true;
    }).catch(() => false);
    if (!pulsado) return { enlaces: [], error: "no se encontró el botón Enviar (#validar_facturado)" };

    for (let i = 0; i < 30; i++) {
      await sleep(500);
      const enlaces = await page.evaluate(() =>
        Array.from(document.querySelectorAll("#acciones_facturado a[href]")).map((a) => a.href)
      ).catch(() => []);
      if (enlaces.length) return { enlaces, error: null };
    }
    const aviso = await page.evaluate(() => {
      const n = document.querySelector("#validation-notification");
      return n ? n.getAttribute("data-notify-msg") : null;
    }).catch(() => null);
    return { enlaces: [], error: aviso || "el portal no devolvió enlace de descarga" };
  } catch (e) {
    return { enlaces: [], error: e.message };
  }
}

// ── Descarga y subida a R2 ──────────────────────────────────────────────────
// Se mira el CONTENIDO, no la extensión: los enlaces de este portal (zip_factura)
// no la llevan. Y para el XML se exige que sea un CFDI de verdad: subir
// cualquier XML como si fuera la factura es peor que no subir nada, porque el
// ticket queda cerrado con un archivo inservible.
async function bajarYSubirCFDI(page, enlaces, ts) {
  const out = { xmlUrl: null, pdfUrl: null };
  const esCFDI = (buf) => /<cfdi:Comprobante|<Comprobante/i.test(buf.slice(0, 4000).toString("utf8"));

  const bajar = async (url) => {
    const d = await page.evaluate(async (u) => {
      try {
        const r = await fetch(u, { credentials: "include" });
        if (!r.ok) return null;
        const arr = new Uint8Array(await r.arrayBuffer());
        let s = "";
        for (let i = 0; i < arr.length; i += 8192) s += String.fromCharCode.apply(null, arr.subarray(i, i + 8192));
        return btoa(s);
      } catch { return null; }
    }, url).catch(() => null);
    return d ? Buffer.from(d, "base64") : null;
  };

  for (const url of (enlaces || []).filter(Boolean)) {
    if (out.xmlUrl && out.pdfUrl) break;
    const buf = await bajar(url);
    if (!buf || buf.length < 300) continue;
    const cabecera = buf.slice(0, 4).toString("latin1");
    try {
      if (cabecera === "PK") {
        const dir = await unzipper.Open.buffer(buf);
        for (const entry of dir.files) {
          const nombre = String(entry.path || "").toLowerCase();
          if (!/\.(xml|pdf)$/.test(nombre)) continue;
          const b = await entry.buffer();
          if (nombre.endsWith(".xml") && !out.xmlUrl && esCFDI(b)) {
            out.xmlUrl = await subirArchivoR2(b, `facturas/grupoarlosa_${ts}_${Date.now()}.xml`, "application/xml");
          } else if (nombre.endsWith(".pdf") && !out.pdfUrl) {
            out.pdfUrl = await subirArchivoR2(b, `facturas/grupoarlosa_${ts}_${Date.now()}.pdf`, "application/pdf");
          }
        }
      } else if (cabecera === "%PDF") {
        if (!out.pdfUrl) out.pdfUrl = await subirArchivoR2(buf, `facturas/grupoarlosa_${ts}_${Date.now()}.pdf`, "application/pdf");
      } else if (esCFDI(buf)) {
        if (!out.xmlUrl) out.xmlUrl = await subirArchivoR2(buf, `facturas/grupoarlosa_${ts}_${Date.now()}.xml`, "application/xml");
      }
    } catch (e) {
      console.log(`   ⚠️ No se pudo procesar la descarga ${url}: ${e.message}`);
    }
  }
  return out;
}

module.exports = { facturarGrupoArlosa };
