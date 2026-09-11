const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");

/**
 * AutoFacturaT / Factura-T — https://autofacturat.com.mx/Facturacion<Marca>/
 * (plataforma "DescargaT", Java + Apache Wicket, com.descargat.view.page.QuickCFDiPanel).
 *
 * Es MULTIMARCA: la misma app aloja a varios comercios, cada uno bajo su propia
 * ruta (/FacturacionChurchsChicken/, /Facturacion<otra marca>/...). La marca sale
 * SIEMPRE de la portalUrl del ticket; hardcodear Church's facturaría en el portal
 * equivocado.
 *
 * Caso que lo cerró: ticket #362 Church's Chicken (Submarinos de Vallarta SA de
 * CV), folio 271404, $330.01 del 07-sep-2026.
 *
 * ── LAS TRAMPAS DE ESTE PORTAL (reconocimiento en vivo del 11-sep-2026) ──────
 *
 * 1) LOS BOTONES NO SON <button> NI <a>: son <img class="boton-chico"> SIN texto.
 *    El que emite se identifica por su ATRIBUTO title ("Generar Factura") y el
 *    de consulta ni siquiera tiene title: se localiza por el trozo de behavior
 *    de su onclick ("queryContainer-addImage"). Un clickTexto() que busque
 *    /factur|timbr|generar/ en textContent no encuentra NADA — ahí es donde
 *    moría la versión anterior de este archivo, que se escribió a ciegas.
 *
 * 2) LOS IDs DE WICKET SE REGENERAN EN CADA CARGA (id2, id7, id8, ida, id10...).
 *    Aquí no se usa ni uno. Todo va por el atributo `name`
 *    (queryContainer:txtX), que está escrito en la plantilla y no cambia. Los
 *    únicos ids estables —porque están en la plantilla— son #form-facturacion,
 *    #usoCFDI, #factIdTicket, #factTotalTicket, #fact-productos, #fact-totales
 *    y #descarga-Docto.
 *
 * 3) EL CAMPO DEL TOTAL SE LLAMA queryContainer:txtReservationId. Parece un id
 *    de reserva y NO lo es: ahí va el importe (330.01). El folio impreso va en
 *    queryContainer:txtTrackingId. Cruzarlos es el error que emite un CFDI por
 *    el monto equivocado.
 *
 * 4) LA URL LLEVA EL jsessionid EN LA RUTA (/login;jsessionid=XXX?0) y Wicket
 *    versiona la página con ?N. No se pueden construir URLs a mano entre pasos:
 *    hay que llegar pulsando.
 *
 * 5) HAY UN PASO INTERMEDIO QUE NO EMITE: el botón '+' (addImage) es una
 *    CONSULTA. Valida folio Y total contra la BD del portal y repinta la página
 *    con los productos y los totales reales. Es lo que permite cruzar el importe
 *    ANTES de timbrar: si el OCR leyó mal el total, el portal contesta "Monto
 *    del ticket Inválido" y no se llega a la previsualización.
 *
 * 6) EL '+' Y EL 'Generar Factura' SUBEN EL FORMULARIO ENTERO
 *    (wicketSubmitFormById('form-facturacion', ...)), así que los valores viajan
 *    en el submit. Solo nombre/RFC/correo tienen además un postback AJAX propio
 *    en su onchange. Ninguno de los dos NAVEGA: contestan un <ajax-response> y
 *    repintan tres componentes. waitForNavigation no sirve de reloj aquí (se
 *    deja como red de seguridad con timeout corto, para no regalar 90 s en el
 *    camino normal); lo que marca el final es que el DOM se quede quieto.
 *
 * 7) LOS DOS <select> USAN EL ÍNDICE COMO value, NO LA CLAVE SAT. G03 es
 *    value="2" y 601 es value="0". Buscar option[value='601'] no encuentra nada:
 *    hay que casar por el TEXTO de la opción.
 *
 * 8) EL RÉGIMEN ARRANCA EN "Choose One" (value vacío). Si no se cambia, el
 *    formulario va incompleto.
 *
 * 9) SALTA UN alert() CON MENSAJE VACÍO cuando la consulta falla. Sin
 *    page.on('dialog') el hilo se cuelga y Browserless mata la pestaña — el
 *    clásico "Session closed / Target closed" de este proyecto. Confirmado en
 *    vivo.
 *
 * 10) LA COLUMNA "# Ticket" de los productos trae el id interno del portal
 *    (20260909151358876), NO el folio impreso (271404). No sirve para verificar
 *    que es nuestro ticket; el que manda es el TOTAL.
 *
 * 11) EL OVERLAY 'veil' NO SE DETECTA CON offsetParent. Es
 *    <div id="veil" style="display:none; position:fixed; width:100%; height:100%">
 *    y el algoritmo de offsetParent devuelve null SIEMPRE para position:fixed,
 *    esté visible o no: `veil.offsetParent !== null` da false hasta con el
 *    overlay puesto. Y este Wicket TAMPOCO expone Wicket.Ajax.isBusy (no
 *    aparece en el HTML servido). Hay que mirar getComputedStyle(veil).display.
 *    Importa por dos motivos: (a) sin ese reloj, el único criterio de fin era
 *    "el DOM lleva 1,8 s quieto", que es exactamente lo que hace leer la tabla
 *    de productos vacía y dar por muerta una consulta que sí funcionó; (b) el
 *    veil tapa el 100% de la pantalla, así que un elementHandle.click() (que
 *    pincha por coordenadas) se lo come el overlay y el keyboard.type siguiente
 *    se va al campo anterior.
 *
 * ── PLAZO ────────────────────────────────────────────────────────────────────
 * El portal NO publica ninguno (se buscó 'plazo', 'vigencia', 'días',
 * 'mismo mes', 'caduca' en el HTML de las tres pantallas y en la ayuda: cero
 * resultados). Por eso este bot NO inventa una ventana de caducidad: quien
 * decide si el ticket sigue vivo es el propio portal al consultarlo, y si
 * contesta "no encontrada" se devuelve datos_invalidos con el correo del
 * comercio para pedirla a mano.
 *
 * ── CAPTCHA ──────────────────────────────────────────────────────────────────
 * Ninguno, verificado en las dos pantallas.
 *
 * ── QUÉ CUENTA COMO PRUEBA DE TIMBRADO ───────────────────────────────────────
 * Tras pulsar "Generar Factura" el portal rellena dos <a> que viven ocultos en
 * <table id="descarga-Docto">. Solo se devuelve ok:true con archivos si aparece
 * un enlace con href, un UUID o un mensaje de éxito. "No vi la palabra error"
 * NO es prueba: en ese caso se devuelve ok:true + procesandoCorreo con el aviso
 * de NO RELANZAR, porque el click ya salió y reintentar duplicaría el CFDI.
 */

const HOST_OK = /(^|\.)autofacturat\.com\.mx$/i;
const PANEL_QUICK = "wicket/bookmarkable/com.descargat.view.page.QuickCFDiPanel";

// Correos de facturación confirmados por marca (clave = ruta en minúsculas sin
// el prefijo "Facturacion"). Si la marca no está aquí, se lee el del pie de la
// propia página, que es donde el portal lo publica.
const EMAILS_CONTACTO = {
  churchschicken: "churchschickensucmazatlan@gmail.com",
};

// Selectores por `name`: los ids de Wicket cambian en cada carga (trampa 2).
const SEL = {
  form: "#form-facturacion",
  nombre: '[name="queryContainer:txtTargetName"]',
  rfc: '[name="queryContainer:txtTargetRFC"]',
  email: '[name="queryContainer:txtTargetEmail"]',
  cp: '[name="queryContainer:zipcodeReceptor"]',
  uso: '[name="queryContainer:cfdiusage"]',
  regimen: '[name="queryContainer:regimenDropDown"]',
  folio: '[name="queryContainer:txtTrackingId"]',
  total: '[name="queryContainer:txtReservationId"]', // TRAMPA: es el TOTAL (trampa 3)
};

// El <select> de régimen no trae la clave SAT por ningún lado (ni en el value,
// que es un índice, ni en el texto): hay que casar clave -> descripción. La
// lista es la que sirve el portal, sin acentos y en ese orden raro (607, 615,
// 625, 628, 629 y 630 van al final, detrás de 624).
const REGIMENES = {
  "601": /general de ley personas morales/,
  "603": /fines no lucrativos/,
  "605": /sueldos y salarios/,
  "606": /^arrendamiento/,
  "607": /enajenacion o adquisicion de bienes/,
  "608": /demas ingresos/,
  "609": /^consolidacion/,
  "610": /residentes en el extranjero/,
  "611": /dividendos/,
  "612": /personas fisicas con actividades empresariales/,
  "614": /ingresos por intereses/,
  "615": /obtencion de premios/,
  "616": /sin obligaciones fiscales/,
  "620": /sociedades cooperativas/,
  "621": /incorporacion fiscal/,
  "622": /agricolas/,
  "623": /opcional para grupos de sociedades/,
  "624": /^coordinados/,
  "625": /plataformas tecnologicas/,
  "626": /simplificado de confianza/,
  "628": /^hidrocarburos/,
  "629": /regimenes fiscales preferentes/,
  "630": /enajenacion de acciones en bolsa/,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
// Comparar sin acentos: el portal escribe "Adquisición" con acento y los
// regímenes sin él, y el OCR/los catálogos no siempre coinciden.
const plano = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").toLowerCase().trim();

async function facturarFacturaT(datos) {
  const {
    folio, referencia, total, importe, monto, fecha,
    rfc, razonSocial, regimenFiscal, usoCfdi, codigoPostal,
    emailEntrega, portalUrl, urlEstacion, ocr_text, ticketId,
  } = datos || {};

  // ── VALIDACIÓN ANTES DE ABRIR EL NAVEGADOR ──────────────────────────────────
  // Abrir Browserless cuesta y el límite de sesiones simultáneas es bajo: lo que
  // se puede descartar sin navegador se descarta aquí.
  const folioTicket = String(folio || referencia || "").trim();
  const totalCrudo = total ?? importe ?? monto;
  const totalNum = num(totalCrudo);
  const faltan = [];
  if (!folioTicket) faltan.push("el folio del ticket (campo 'Número Ticket' del portal)");
  if (!rfc) faltan.push("el RFC del receptor");
  if (!isFinite(totalNum) || totalNum <= 0) faltan.push("el total del ticket (el portal lo valida contra su BD junto con el folio)");
  if (faltan.length) {
    return { ok: false, error_code: "datos_invalidos", msg: `AutoFacturaT: faltan datos del ticket — ${faltan.join(", ")}.` };
  }

  // La ruta de la marca sale de la URL del ticket y se respeta TAL CUAL: Wicket
  // distingue mayúsculas en la ruta (/FacturacionChurchsChicken/ != /facturacion.../).
  const cruda = String(portalUrl || urlEstacion || "").trim();
  let ruta = null;
  if (cruda) {
    let u = null;
    try { u = new URL(/^https?:\/\//i.test(cruda) ? cruda : `https://${cruda}`); } catch { u = null; }
    if (!u || !HOST_OK.test(u.hostname)) {
      return { ok: false, error_code: "datos_invalidos", msg: `AutoFacturaT: la URL del ticket (${cruda}) no es de autofacturat.com.mx — este bot no la puede atender.` };
    }
    const m = u.pathname.match(/^\/(Facturacion[^/]*)/i);
    if (m) ruta = `/${m[1]}/`;
  }
  if (!ruta) {
    // Último recurso: la ruta impresa en el propio ticket. NUNCA se asume una
    // marca por defecto: en una plataforma multimarca eso es ir a facturar al
    // portal de otro comercio.
    const m = String(ocr_text || "").match(/autofacturat\.com\.mx\/(Facturacion[^/\s"']*)/i);
    if (m) ruta = `/${m[1]}/`;
  }
  if (!ruta) {
    return {
      ok: false, error_code: "datos_invalidos",
      msg: `AutoFacturaT: no se pudo determinar la marca del portal. La plataforma aloja a varios comercios bajo /Facturacion<Marca>/ y la ruta tiene que salir de la URL impresa en el ticket (portalUrl llegó como "${cruda || "(vacío)"}").`,
    };
  }

  const BASE = `https://autofacturat.com.mx${ruta}`;
  const marca = ruta.replace(/\//g, "").replace(/^facturacion/i, "").toLowerCase();
  let emailContacto = EMAILS_CONTACTO[marca] || null;

  // ⚠️ El correo del portal es SIEMPRE el buzón de captura. Con el correo del
  // residente el CFDI se emite y el sistema no lo recibe nunca (pasó con Casa
  // Ley y La Parisina).
  const correo = emailEntrega || process.env.IMAP_USER || "buzonfacturas@serviciosga.site";
  const nombreReceptor = razonSocial || "GPN PINTURAS Y RECUBRIMIENTOS";
  // El CP del receptor va en el CFDI (DomicilioFiscalReceptor) y el PAC lo
  // rechaza si no cuadra con la lista del SAT. Los datos fiscales llegan en
  // `datos`; el 80140 de la Constancia de GPN es solo el último recurso, para
  // que un OCR sin CP no tire una emisión que por lo demás está completa.
  const cp = String(codigoPostal || "80140").trim();
  const claveRegimen = String(regimenFiscal || "601").trim();
  const claveUso = String(usoCfdi || "G03").trim().toUpperCase();
  // El portal espera el importe con punto y dos decimales, sin separador de
  // miles y sin $ (el campo es class="numeric").
  const totalTexto = totalNum.toFixed(2);

  console.log("🤖 AutoFacturaT (Factura-T / Wicket)...");
  console.log(`   Marca: ${marca || "?"} (${BASE})`);
  console.log(`   Folio: ${folioTicket} | Total: $${totalTexto} | RFC: ${rfc} | Correo: ${correo}${fecha ? ` | Ticket del ${fecha}` : ""}`);

  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error("BROWSERLESS_TOKEN no definido");
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true`,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1100 });

  // OBLIGATORIO Y DESDE EL PRIMER INSTANTE (trampa 9): el portal lanza un
  // alert() con mensaje VACÍO cuando la consulta falla.
  let ultimoDialog = "";
  page.on("dialog", async (d) => {
    ultimoDialog = d.message() || "(mensaje vacío)";
    console.log(`💬 ALERT: "${ultimoDialog}"`);
    try { await d.accept(); } catch {}
  });

  // El feedback de Wicket viaja dentro del <ajax-response>. Leerlo aquí es la
  // red de seguridad para cuando el repintado aún no ha llegado al DOM: en el
  // reconocimiento se dio por muerta una consulta que sí había funcionado, solo
  // porque se miró el innerText demasiado pronto.
  const feedbackAjax = [];
  page.on("response", async (res) => {
    if (!/IBehaviorListener|IFormSubmitListener/.test(res.url())) return;
    let body = "";
    try { body = await res.text(); } catch { return; }
    const re = /<li class="feedbackPanel(\w+)">\s*<span[^>]*>([^<]*)</g;
    let m;
    while ((m = re.exec(body))) {
      const item = { nivel: m[1], msg: (m[2] || "").replace(/\s+/g, " ").trim() };
      if (item.msg) { feedbackAjax.push(item); console.log(`   📡 feedback ${item.nivel}: ${item.msg}`); }
    }
  });

  const ts = ticketId || Date.now();
  const shot = async (etiqueta) => {
    try {
      const buf = await page.screenshot({ fullPage: true });
      const url = await subirArchivoR2(buf, `debug/facturat_${ts}_${etiqueta}_${Date.now()}.png`, "image/png");
      console.log(`📸 ${etiqueta}: ${url}`);
      return url;
    } catch { return null; }
  };

  const fallo = async (etiqueta, error_code, msg, extra = {}) => {
    const cap = await shot(etiqueta);
    try { await browser.close(); } catch {}
    return {
      ok: false, error_code,
      msg: cap ? `${msg} [captura: ${cap}]` : msg,
      ...(emailContacto ? { email_contacto: emailContacto } : {}),
      ...extra,
    };
  };

  // Wicket trabaja por postbacks AJAX y tapa la pantalla con el overlay 'veil'
  // mientras tanto: en vez de dormir a ciegas se espera a que el indicador se
  // apague y a que el DOM deje de cambiar dos vueltas seguidas.
  // ⚠️ EL 'veil' NO SE PUEDE MIRAR CON offsetParent. Es
  //    <div id="veil" style="position:fixed;width:100%;height:100%"> y el
  //    algoritmo de offsetParent devuelve null SIEMPRE para un elemento
  //    position:fixed — esté visible o no. Con `veil.offsetParent !== null` el
  //    bot creía que nunca había nada en vuelo, y como este Wicket TAMPOCO trae
  //    Wicket.Ajax.isBusy (comprobado en el HTML servido), el único reloj que
  //    quedaba era "que el DOM esté quieto 1,8 s": justo lo que hace leer la
  //    tabla de productos vacía y dar por muerta una consulta que sí funcionó.
  //    Hay que mirar el display CALCULADO.
  const ocupadoAhora = () => page.evaluate(() => {
    const tapa = (el) => {
      if (!el) return false;
      const cs = getComputedStyle(el);
      return cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0";
    };
    try {
      if (window.Wicket && window.Wicket.Ajax && typeof window.Wicket.Ajax.isBusy === "function") return !!window.Wicket.Ajax.isBusy();
    } catch {}
    if (tapa(document.getElementById("veil"))) return true;
    return tapa(document.querySelector(".wicket-ajax-indicator, .wicket-ajax-indicator-visible, #ajax-indicator"));
  }).catch(() => false);

  // El veil ocupa el 100% de la pantalla: mientras está arriba, un
  // elementHandle.click() (que pincha por coordenadas) se lo come el overlay y
  // el keyboard.type siguiente se va al campo anterior. Nombre/RFC/correo lo
  // levantan al perder el foco, así que hay que esperar a que baje ANTES de
  // pinchar el campo siguiente.
  async function esperarVeil(maxMs = 12000) {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      if (!(await ocupadoAhora())) return true;
      await sleep(400);
    }
    console.log("   ⚠️  El overlay 'veil' sigue arriba tras esperarlo: se teclea igual");
    return false;
  }

  async function esperarAjax(maxMs = 25000) {
    const t0 = Date.now();
    let previo = null, estables = 0;
    while (Date.now() - t0 < maxMs) {
      await sleep(600);
      const ocupado = await ocupadoAhora();
      if (ocupado) { estables = 0; continue; }
      const firma = await page.evaluate(() => (document.body ? `${document.body.innerHTML.length}|${document.body.innerText.replace(/\s+/g, " ").slice(0, 2500)}` : "")).catch(() => "");
      if (firma && firma === previo) { estables++; if (estables >= 2) return; } else { previo = firma; estables = 0; }
    }
  }

  // ⚠️ Poner .value dejaría el campo VISIBLEMENTE lleno; aquí además el
  // formulario entero se serializa en el submit del '+', así que un valor a
  // medias viaja igual. Se teclea de verdad y se RELEE.
  async function teclear(sel, valor, etiqueta) {
    await esperarVeil(); // el overlay se come el click por coordenadas
    const h = await page.$(sel);
    if (!h) { console.log(`   ⚠️  No existe el campo ${etiqueta} (${sel})`); return null; }
    try {
      await h.click({ clickCount: 3 });
      await page.keyboard.press("Backspace").catch(() => {});
      await page.keyboard.type(String(valor), { delay: 45 });
    } catch (e) {
      console.log(`   ⚠️  No se pudo teclear ${etiqueta}: ${e.message}`);
      return null;
    }
    const puesto = await page.$eval(sel, (e) => e.value).catch(() => null);
    console.log(`   ✍️  ${etiqueta} = "${valor}"${puesto === String(valor) ? "" : ` → el portal dejó "${puesto}"`}`);
    return puesto;
  }

  // Los <select> van por TEXTO de la opción: el value es un índice (trampa 7).
  async function elegirPorTexto(sel, patron, etiqueta) {
    const opciones = await page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return null;
      return Array.from(el.options).map((o) => ({ value: o.value, text: (o.text || "").replace(/\s+/g, " ").trim() }));
    }, sel).catch(() => null);
    if (!opciones) { console.log(`   ⚠️  No existe el <select> ${etiqueta} (${sel})`); return { ok: false, opciones: [] }; }
    const op = opciones.find((o) => o.value !== "" && patron.test(plano(o.text)));
    if (!op) return { ok: false, opciones };
    await page.select(sel, op.value).catch(() => {});
    await page.evaluate((s) => {
      const el = document.querySelector(s);
      if (el) el.dispatchEvent(new Event("change", { bubbles: true }));
    }, sel).catch(() => {});
    await esperarAjax(8000);
    const elegido = await page.evaluate((s) => {
      const el = document.querySelector(s);
      return el && el.options[el.selectedIndex] ? el.options[el.selectedIndex].text.replace(/\s+/g, " ").trim() : null;
    }, sel).catch(() => null);
    console.log(`   ▾ ${etiqueta} = "${elegido}" (value ${op.value})`);
    return { ok: !!elegido && patron.test(plano(elegido)), texto: elegido, opciones };
  }

  // Lee de golpe lo que el portal tiene en pantalla: feedback, productos,
  // totales y los enlaces de descarga.
  const leerPantalla = () => page.evaluate((sel) => {
    const lim = (s) => (s || "").replace(/\s+/g, " ").trim();
    const valor = (s) => { const e = document.querySelector(s); return e ? e.value : null; };
    const totales = {};
    Array.from(document.querySelectorAll("#fact-totales tr")).forEach((tr) => {
      const c = tr.querySelectorAll("td");
      if (c.length >= 2) totales[lim(c[0].innerText)] = lim(c[1].innerText);
    });
    return {
      url: location.href,
      feedback: Array.from(document.querySelectorAll(".feedbackPanel li")).map((li) => ({
        nivel: (String(li.className || "").match(/feedbackPanel(\w+)/) || ["", ""])[1],
        msg: lim(li.innerText),
      })).filter((f) => f.msg),
      productos: Array.from(document.querySelectorAll("#fact-productos tbody tr")).map((tr) => lim(tr.innerText)).filter(Boolean),
      totales,
      campos: {
        nombre: valor(sel.nombre), rfc: valor(sel.rfc), email: valor(sel.email),
        cp: valor(sel.cp), folio: valor(sel.folio), total: valor(sel.total),
      },
      // Los <a> de descarga nacen vacíos y ocultos dentro de #descarga-Docto:
      // el portal los rellena DESPUÉS de timbrar.
      // Antes de timbrar son dos <a> vacíos, sin href y con display:none. Que
      // aparezcan con href, con texto o visibles ya es señal de que el portal
      // pintó la descarga; el href es lo único que además se puede bajar.
      descargas: Array.from(document.querySelectorAll("#descarga-Docto a"))
        .map((a) => ({
          id: a.id || null,
          href: a.getAttribute("href") ? a.href : null,
          texto: lim(a.textContent),
          visible: !!(a.offsetParent !== null || a.getClientRects().length),
        }))
        .filter((a) => a.href || a.texto || a.visible),
      uuid: ((document.body.innerHTML || "").match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) || [])[0] || null,
      contacto: ((document.body.innerText || "").match(/correo:\s*([\w.+-]+@[\w.-]+)/i) || [])[1] || null,
      texto: lim(document.body.innerText).slice(0, 600),
    };
  }, SEL).catch(() => ({}));

// El panel del DOM siempre muestra la respuesta ACTUAL (Wicket lo reemplaza
// entero en cada postback); `feedbackAjax` en cambio se acumula toda la sesión,
// así que se pasa desde qué punto mirar para no clasificar un paso con el
// mensaje del anterior.
  const textoFeedback = (p, desde = 0) => plano([
    ...(p.feedback || []).map((f) => f.msg),
    ...feedbackAjax.slice(desde).map((f) => f.msg),
  ].join(" | "));

  let timbradoDisparado = false;
  try {
    // ── PASO 1 — abrir el portal de la marca ────────────────────────────────
    // /login?0 redirige a /login;jsessionid=XXX?0: es Wicket metiendo la sesión
    // en la ruta, no un error. No se puede saltar este paso yendo directo al
    // panel público: la sesión se crea aquí (trampa 4).
    console.log(`🌐 ${BASE}login?0`);
    await page.goto(`${BASE}login?0`, { waitUntil: "networkidle2", timeout: 60000 });
    await esperarAjax(10000);

    // ── PASO 2 — salir por "Factura al Instante (sin registro)" ─────────────
    // Hay login de usuario/contraseña, pero la cuenta NO hace falta. El <a>
    // tiene id generado: se localiza por texto o por el behavior lblQuickInvoice.
    let hayForm = await page.$(SEL.rfc).then((h) => !!h).catch(() => false);
    if (!hayForm) {
      const invitado = await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {}),
        page.evaluate(() => {
          const a = Array.from(document.querySelectorAll("a, button, input[type=submit], input[type=button]"))
            .find((e) => /factura\s*al\s*instante|sin\s*registro/i.test(e.textContent || e.value || "")
              || /lblQuickInvoice/.test(e.getAttribute("onclick") || ""));
          if (!a) return false; // ⚠️ un click dentro de evaluate SIEMPRE reporta si encontró el elemento
          a.click();
          return true;
        }),
      ]).then((r) => r[1]);
      console.log(`   🔓 Enlace de invitado: ${invitado ? "pulsado" : "NO ENCONTRADO"}`);
      await esperarAjax(20000);
      hayForm = await page.$(SEL.rfc).then((h) => !!h).catch(() => false);
    }

    if (!hayForm) {
      // Plan B: el panel público es bookmarkable. No se construye la URL con
      // jsessionid ni versión, se pide la ruta limpia y Wicket resuelve.
      console.log("   ↪️  Sin formulario tras el enlace — probando el panel público directo...");
      await page.goto(`${BASE}${PANEL_QUICK}`, { waitUntil: "networkidle2", timeout: 60000 });
      await esperarAjax(15000);
      hayForm = await page.$(SEL.rfc).then((h) => !!h).catch(() => false);
    }

    const p0 = await leerPantalla();
    if (p0.contacto) emailContacto = p0.contacto; // el pie publica el correo de la marca
    if (!hayForm) {
      const esLogin = /usuario|contrase|iniciar\s*sesi/i.test(p0.texto || "");
      return await fallo("p1_sin_formulario", "reintentar_despues",
        `AutoFacturaT: no se llegó al formulario público de ${marca} (${BASE}${PANEL_QUICK}). ${esLogin ? 'La página sigue pidiendo usuario/contraseña: el enlace "Factura al Instante (sin registro)" pudo cambiar de rótulo.' : `Pantalla: ${(p0.texto || "").slice(0, 200)}`} No se emitió nada.`);
    }
    console.log("   ✅ Formulario público abierto (sin captcha, sin cuenta)");
    await shot("p1_formulario");

    // ── PASO 3 — capturar los datos ────────────────────────────────────────
    // Nombre/RFC/correo disparan un postback AJAX propio al perder el foco; los
    // demás viajan con el submit del '+'. Se espera al AJAX tras los tres
    // primeros para no teclear encima del repintado.
    await teclear(SEL.nombre, nombreReceptor, "Nombre / razón social");
    await teclear(SEL.rfc, rfc, "RFC");
    await teclear(SEL.email, correo, "Correo (buzón de captura)");
    await page.evaluate(() => document.activeElement && document.activeElement.blur()).catch(() => {});
    await esperarAjax(10000);

    await teclear(SEL.cp, cp, "Código Postal");
    await teclear(SEL.folio, folioTicket, "Número Ticket");
    await teclear(SEL.total, totalTexto, "Total (ojo: name=txtReservationId)");
    await page.evaluate(() => document.activeElement && document.activeElement.blur()).catch(() => {});
    await esperarAjax(8000);

    // Uso de CFDI: el texto de la opción empieza por la clave ("G03.Gastos en
    // general"), así que se casa por el prefijo.
    const uso = await elegirPorTexto(SEL.uso, new RegExp(`^${claveUso.toLowerCase().replace(/[^a-z0-9]/g, "")}[.\\s]`), `Uso de CFDI ${claveUso}`);
    if (!uso.ok) {
      return await fallo("p2_sin_uso_cfdi", "datos_invalidos",
        `AutoFacturaT: el uso de CFDI ${claveUso} no está en el catálogo del portal (el <select> usa índices, no claves SAT, y se busca por el texto de la opción). Opciones: ${(uso.opciones || []).map((o) => o.text).join(" | ").slice(0, 400)}. No se emitió nada.`);
    }

    // Régimen: arranca en "Choose One" (value vacío). Si no se cambia, el
    // formulario va incompleto (trampa 8).
    const patronRegimen = REGIMENES[claveRegimen];
    if (!patronRegimen) {
      return await fallo("p2_regimen_desconocido", "datos_invalidos",
        `AutoFacturaT: no sé a qué texto del catálogo corresponde el régimen fiscal ${claveRegimen} (el portal no publica la clave SAT en ninguna parte: hay que casar por descripción). No se emitió nada.`);
    }
    const regimen = await elegirPorTexto(SEL.regimen, patronRegimen, `Régimen Fiscal ${claveRegimen}`);
    if (!regimen.ok) {
      return await fallo("p2_sin_regimen", "datos_invalidos",
        `AutoFacturaT: el régimen ${claveRegimen} no se pudo elegir en el portal. Opciones: ${(regimen.opciones || []).map((o) => o.text).join(" | ").slice(0, 400)}. No se emitió nada.`);
    }

    // RELEER TODO antes de consultar: si un postback hubiera borrado algo, el
    // '+' subiría el formulario a medias y el portal contestaría un error que
    // parecería del ticket.
    const antes = await leerPantalla();
    const mal = [];
    if (plano(antes.campos.rfc) !== plano(rfc)) mal.push(`RFC quedó "${antes.campos.rfc}"`);
    if (String(antes.campos.folio || "") !== folioTicket) mal.push(`folio quedó "${antes.campos.folio}"`);
    if (num(antes.campos.total) !== totalNum) mal.push(`total quedó "${antes.campos.total}"`);
    if (plano(antes.campos.email) !== plano(correo)) mal.push(`correo quedó "${antes.campos.email}"`);
    if (mal.length) {
      // Segundo intento de teclear los que se perdieron: Wicket a veces repinta
      // el fieldset del receptor tras el postback del correo.
      console.log(`   ⚠️  Campos a medias tras el postback (${mal.join("; ")}) — reintentando`);
      await teclear(SEL.rfc, rfc, "RFC (2º intento)");
      await teclear(SEL.email, correo, "Correo (2º intento)");
      await teclear(SEL.folio, folioTicket, "Número Ticket (2º intento)");
      await teclear(SEL.total, totalTexto, "Total (2º intento)");
      await page.evaluate(() => document.activeElement && document.activeElement.blur()).catch(() => {});
      await esperarAjax(8000);
      const otra = await leerPantalla();
      if (String(otra.campos.folio || "") !== folioTicket || num(otra.campos.total) !== totalNum || plano(otra.campos.rfc) !== plano(rfc)) {
        return await fallo("p2_campos_incompletos", "reintentar_despues",
          `AutoFacturaT: el formulario no conservó los datos capturados (${JSON.stringify(otra.campos)}). No se pulsó nada: NO se emitió nada.`);
      }
    }
    await shot("p2_capturado");

    // ── PASO 4 — el '+': CONSULTA, NO EMITE ────────────────────────────────
    // Sube el formulario entero y valida folio Y total contra la BD del portal.
    // Es la red que hace imposible timbrar por un monto equivocado (trampa 5).
    const marcaAjax = feedbackAjax.length; // solo cuenta lo que conteste el '+'
    // Cuántos mensajes había ANTES de pulsar: el '+' ha contestado cuando ese
    // número crece (o cuando aparece la primera fila de productos).
    const nFeedback0 = await page.evaluate(() => document.querySelectorAll(".feedbackPanel li").length).catch(() => 0);
    const consulta = await page.evaluate(() => {
      const img = Array.from(document.querySelectorAll("img.boton-chico"))
        .find((i) => /queryContainer-addImage/.test(i.getAttribute("onclick") || ""));
      if (!img) return { pulsado: false, motivo: "no se encontró el botón '+' (img.boton-chico con behavior queryContainer-addImage)" };
      // Cinturón: si por lo que sea el que se localizó fuera el de emitir, no
      // se pulsa. Los dos son <img class="boton-chico"> y solo los separa esto.
      if (/generar\s*factura/i.test(img.title || "") || /btnExecute/.test(img.getAttribute("onclick") || "")) {
        return { pulsado: false, motivo: "el botón localizado como '+' resultó ser el de Generar Factura — abortado sin pulsar" };
      }
      img.click();
      return { pulsado: true, id: img.id || null };
    });
    if (!consulta.pulsado) {
      return await fallo("p3_sin_boton_mas", "reintentar_despues", `AutoFacturaT: ${consulta.motivo}. NO se emitió nada.`);
    }
    console.log("   ➕ Consulta del ticket enviada (esto NO emite)");
    // El reloj NO es el tiempo: es que aparezca UNA de las dos cosas que el
    // portal pinta al contestar el <ajax-response> — la fila de productos o un
    // mensaje en el feedbackPanel. En el formulario limpio NO existe ningún
    // .feedbackPanel (comprobado en el HTML servido), así que cualquiera de los
    // dos sirve de señal de que la respuesta ya aterrizó. Esperar solo "a que
    // el DOM se quede quieto" es lo que da por muerta una consulta que sí
    // funcionó: es la trampa que el propio reconocimiento se comió en su
    // primera pasada (la tabla salía vacía por mirarla demasiado pronto).
    await page.waitForFunction(
      (fbAntes) => document.querySelectorAll("#fact-productos tbody tr").length > 0
        || document.querySelectorAll(".feedbackPanel li").length > fbAntes,
      { timeout: 45000, polling: 500 },
      nFeedback0,
    ).catch(() => {});
    await esperarAjax(30000);
    await sleep(1500); // el repintado del fieldset de productos llega un pelín después
    const previa = await leerPantalla();
    await shot("p3_previsualizacion");

    const msgs = textoFeedback(previa, marcaAjax);
    console.log(`   💬 Portal: ${msgs.slice(0, 200) || "(sin mensaje)"}`);

    if (/page expired|pagina expirada|sesion (ha )?(expirad|caducad)|internal server error|error interno/.test(msgs + " " + plano(previa.texto))) {
      return await fallo("p3_portal_caido", "reintentar_despues",
        `AutoFacturaT: el portal contestó sesión expirada / error interno al consultar el ticket (no es un problema del ticket). NO se emitió nada. Portal: ${msgs.slice(0, 200)}`);
    }
    if (/ya (fue|ha sido|esta) facturad|ya (existe|se genero|se emitio)|factura ya (generad|emitid)/.test(msgs)) {
      return await fallo("p3_ya_facturado", "ya_facturado",
        `AutoFacturaT: el portal dice que el ticket ${folioTicket} ya tiene factura. Portal: ${msgs.slice(0, 200)}`);
    }
    if (/monto del ticket invalid|monto invalid|importe invalid/.test(msgs)) {
      return await fallo("p3_monto_invalido", "datos_invalidos",
        `AutoFacturaT: el portal rechazó el importe — encontró el ticket ${folioTicket} pero NO por $${totalTexto} ("Monto del ticket Inválido"). Hay que revisar el total en la foto del ticket antes de volver a intentarlo. No se emitió nada.`);
    }
    if (/no encontrad|no existe|no se encontro/.test(msgs)) {
      return await fallo("p3_no_encontrado", "datos_invalidos",
        `AutoFacturaT: el portal no encontró el ticket ${folioTicket} por $${totalTexto} ("Ticket o Remisión no encontrada"). El portal valida folio Y total a la vez, así que el error puede venir de cualquiera de los dos; ${fecha ? `el ticket es del ${fecha} y ` : ""}también cabe que ya no esté disponible (el portal no publica plazo). Si los datos de la foto son correctos, toca pedirla por correo${emailContacto ? ` a ${emailContacto}` : ""}. No se emitió nada.`,
        { permite_solicitud_correo: true });
    }

    // ── LA COMPROBACIÓN DEL DINERO ─────────────────────────────────────────
    // El desglose lo pinta el PORTAL (no son nuestros inputs): si el total que
    // él calcula no es el del ticket, no se timbra.
    const claveTotal = Object.keys(previa.totales || {}).find((k) => plano(k) === "total");
    const totalPortal = claveTotal ? num(previa.totales[claveTotal]) : NaN;
    console.log(`   🧾 Productos: ${(previa.productos || []).length} | Totales del portal: ${JSON.stringify(previa.totales || {})}`);

    if (!(previa.productos || []).length || !isFinite(totalPortal)) {
      const hayError = (previa.feedback || []).some((f) => /ERROR/i.test(f.nivel));
      return await fallo("p3_sin_previsualizacion", hayError ? "datos_invalidos" : "reintentar_despues",
        `AutoFacturaT: tras la consulta el portal no mostró productos ni totales para el ticket ${folioTicket} / $${totalTexto}. Portal: ${msgs.slice(0, 200) || ultimoDialog || "(sin mensaje)"}. NO se emitió nada.`);
    }
    if (Math.abs(totalPortal - totalNum) > 0.02) {
      return await fallo("p3_total_no_cuadra", "datos_invalidos",
        `AutoFacturaT: el total del portal ($${totalPortal}) no coincide con el del ticket ($${totalTexto}). NO se emite: una diferencia aquí significa que el ticket leído no es el que el portal encontró.`);
    }
    console.log(`   ✅ El portal confirma el ticket por $${totalPortal} — coincide con el ticket`);

    // ── PASO 5 — EL CLICK QUE EMITE ────────────────────────────────────────
    // A partir de aquí NO puede devolverse un error reintentable: un reintento
    // emitiría un segundo CFDI que habría que cancelar ante el SAT.
    //
    // Se comprueba PRIMERO que el botón existe (sin pulsarlo) para poder abortar
    // de forma segura, y solo entonces se arma la bandera.
    const hayBoton = await page.evaluate(() => !!Array.from(document.querySelectorAll("img.boton-chico"))
      .find((i) => /generar\s*factura/i.test(i.title || "") || /form-btnExecute/.test(i.getAttribute("onclick") || "")));
    if (!hayBoton) {
      return await fallo("p4_sin_boton_generar", "reintentar_despues",
        "AutoFacturaT: no apareció el botón 'Generar Factura' (img.boton-chico[title='Generar Factura']) en la pantalla de previsualización. NO se emitió nada.");
    }

    console.log("🧾 Pulsando 'Generar Factura' — A PARTIR DE AQUÍ EL CFDI PUEDE EXISTIR");
    const marcaFinal = feedbackAjax.length; // a partir de aquí, solo la respuesta al timbrado
    timbradoDisparado = true;
    // El botón hace wicketSubmitFormById (AJAX), NO navega: el waitForNavigation
    // es solo red de seguridad por si el portal redirige, y por eso lleva un
    // timeout corto — con 90 s regalaría minuto y medio en el camino normal.
    const emitido = await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 20000 }).catch(() => {}),
      page.evaluate(() => {
        const img = Array.from(document.querySelectorAll("img.boton-chico"))
          .find((i) => /generar\s*factura/i.test(i.title || "") || /form-btnExecute/.test(i.getAttribute("onclick") || ""));
        if (!img) return false; // reporta SIEMPRE si encontró el botón
        img.click();
        return true;
      }),
    ]).then((r) => r[1]);

    if (emitido === false) {
      // El evaluate devolvió false: el click NO llegó a salir (el botón
      // desapareció entre la comprobación y el click). Nada emitido.
      timbradoDisparado = false;
      return await fallo("p4_click_no_salio", "reintentar_despues",
        "AutoFacturaT: el botón 'Generar Factura' desapareció justo antes de pulsarlo; el click no llegó a salir y NO se emitió nada.");
    }

    // Prueba de emisión: los <a> de #descarga-Docto con href, un UUID, o un
    // feedback nuevo del servidor. Se compara contra el feedback ANTERIOR para
    // no confundir el "Ticket encontrado" del '+' con una respuesta al timbrado.
    await page.waitForFunction((prev) => {
      const enlaces = Array.from(document.querySelectorAll("#descarga-Docto a"))
        .filter((a) => a.getAttribute("href") || (a.textContent || "").trim() || a.offsetParent !== null);
      if (enlaces.length) return true;
      if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(document.body.innerHTML || "")) return true;
      const fb = Array.from(document.querySelectorAll(".feedbackPanel li")).map((li) => (li.innerText || "").replace(/\s+/g, " ").trim()).join(" | ");
      return !!fb && fb !== prev;
    }, { timeout: 120000 }, (previa.feedback || []).map((f) => f.msg).join(" | ")).catch(() => {});
    await esperarAjax(30000);
    await sleep(2000);

    const res = await leerPantalla();
    await shot("p4_resultado");
    const msgsFinal = textoFeedback(res, marcaFinal);
    console.log(`   📄 Tras emitir — enlaces: ${(res.descargas || []).length} | uuid: ${res.uuid || "(ninguno)"} | portal: ${msgsFinal.slice(0, 200) || "(sin mensaje)"}`);

    const hayPrueba = (res.descargas || []).length > 0 || !!res.uuid
      || /factura (generada|emitida|timbrada)|se genero (la )?factura|timbrado (exitoso|correcto)|exitosamente/.test(msgsFinal);

    if (!hayPrueba) {
      // NO se vio nada que demuestre la emisión — pero el click YA salió, así
      // que NO se devuelve un error reintentable: eso duplicaría el CFDI.
      try { await browser.close(); } catch {}
      return {
        ok: true, procesandoCorreo: true,
        msg: `AutoFacturaT: se pulsó 'Generar Factura' para el ticket ${folioTicket} ($${totalTexto}) pero la pantalla no mostró ni enlaces de descarga ni UUID. NO RELANZAR: comprobar antes en ${BASE} si el CFDI ya existe (el portal también lo manda a ${correo}, así que puede llegar por IMAP). Portal: ${msgsFinal.slice(0, 200) || ultimoDialog || "(sin mensaje)"}`,
      };
    }

    // Los enlaces salen de la sesión de Wicket: hay que bajarlos DENTRO del
    // navegador (un fetch desde Node no lleva la cookie y devuelve 0 bytes).
    const bajar = async (href) => {
      const d = await page.evaluate(async (u) => {
        try {
          const r = await fetch(u, { credentials: "include" });
          if (!r.ok) return null;
          const b = await r.arrayBuffer();
          return Array.from(new Uint8Array(b));
        } catch { return null; }
      }, href).catch(() => null);
      if (!d || d.length < 200) return null;
      return Buffer.from(d);
    };

    // Los dos <a> no dicen cuál es cuál (nacen vacíos y sin texto fijo): se baja
    // lo que haya y se distingue por el contenido, no por el rótulo.
    let bufXml = null, bufPdf = null;
    for (const a of res.descargas || []) {
      if (!a.href) continue; // hay <a> que aparecen sin href: sirven de prueba, no de descarga
      const buf = await bajar(a.href);
      if (!buf) continue;
      const cabecera = buf.slice(0, 200).toString("latin1");
      if (/^%PDF/.test(cabecera) || /\.pdf/i.test(a.href)) { if (!bufPdf) bufPdf = buf; continue; }
      if (/<\?xml|<cfdi:/i.test(cabecera) || /\.xml/i.test(a.href)) { if (!bufXml) bufXml = buf; continue; }
    }
    try { await browser.close(); } catch {}

    const base = res.uuid || `facturat_${ts}`;
    let xmlUrl = null, pdfUrl = null;
    try { if (bufXml) xmlUrl = await subirArchivoR2(bufXml, `facturas/${base}.xml`, "application/xml"); } catch {}
    try { if (bufPdf) pdfUrl = await subirArchivoR2(bufPdf, `facturas/${base}.pdf`, "application/pdf"); } catch {}

    if (xmlUrl || pdfUrl) {
      console.log(`✅ AutoFacturaT OK — XML: ${xmlUrl} | PDF: ${pdfUrl}`);
      return { ok: true, xmlUrl, pdfUrl, uuid: res.uuid || null };
    }

    // Timbrado con prueba, pero sin archivos en la mano: el portal manda el CFDI
    // al correo capturado (el buzón de captura), así que IMAP lo recoge.
    console.log("📧 Timbrado sin descarga directa — se espera por correo");
    return {
      ok: true, procesandoCorreo: true, uuid: res.uuid || null,
      msg: `AutoFacturaT: CFDI emitido${res.uuid ? ` (UUID ${res.uuid})` : ""} para el ticket ${folioTicket}; la descarga directa no dio archivo y se espera por correo en ${correo}. NO RELANZAR: comprobar antes en ${BASE} si el CFDI ya existe.`,
    };
  } catch (err) {
    console.error(`❌ AutoFacturaT: ${err.message}`);
    await shot("error").catch(() => {});
    try { await browser.close(); } catch {}
    if (timbradoDisparado) {
      // El click que emite YA salió. Devolver un error aquí mandaría el ticket a
      // la cola de reintentos y emitiría un segundo CFDI que habría que cancelar
      // ante el SAT. "Execution context was destroyed" es justo este caso.
      return {
        ok: true, procesandoCorreo: true,
        msg: `AutoFacturaT: el bot falló (${err.message}${ultimoDialog ? ` | alert: "${ultimoDialog}"` : ""}) DESPUÉS de pulsar 'Generar Factura' para el ticket ${folioTicket}. NO RELANZAR: comprobar antes en el portal (${BASE}) si el CFDI ya existe; también puede llegar por correo a ${correo}.`,
      };
    }
    return {
      ok: false, error_code: "reintentar_despues",
      msg: `AutoFacturaT: ${err.message}${ultimoDialog ? ` (alert: "${ultimoDialog}")` : ""} — no se emitió nada.`,
      ...(emailContacto ? { email_contacto: emailContacto } : {}),
    };
  }
}

module.exports = { facturarFacturaT };
