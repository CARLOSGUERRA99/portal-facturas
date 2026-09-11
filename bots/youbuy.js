// Youbuy — plataforma de autofacturación MULTI-TENANT por subdominio
// (*.youbuy.mx). Laravel + Vue 2 (SPA parcial montada sobre blades), Tailwind,
// axios, vue-toast-notification, vue-loading-overlay y vue-confirm-dialog.
//
// ── ESTE ARCHIVO SE REESCRIBIÓ CONTRA UNA CORRIDA EN VIVO (11-sep-2026) ────
// La versión anterior se escribió a ciegas y NUNCA se probó. El reconocimiento
// (tmp/mapeo.txt, bloque "YouBuy" + scripts/probe-youbuy.js + los volcados de
// tmp/youbuy/) demostró que tenía CUATRO bugs que la habrían hecho fallar
// siempre, y uno de ellos habría dado el ticket por facturado sin factura:
//   1. Detectaba el atajo buscando un campo cuyo id/name/placeholder/label
//      casara con /folio/. Los inputs del paso 2 NO tienen name ni placeholder
//      ni label asociado y su id es "inline-full-name" → nunca casaba: el atajo
//      se daba por fallido y se iba al captcha para nada.
//   2. Leía "no se encontró" del cuerpo de findTicket para decidir que el folio
//      era malo. Pero findTicket responde SIEMPRE message:"No se encontró
//      ningún ticket.", TAMBIÉN cuando sí lo encuentra (ver más abajo).
//      Con esa regex, todo ticket bueno salía como datos_invalidos.
//   3. Envolvía "Guardar y Facturar" en waitForNavigation y luego esperaba 90 s
//      la respuesta de /facturacion/create. Ese botón NO timbra ni navega: abre
//      un modal vue-confirm. Los 90 s expiraban y el bot caía por su rama
//      "ambiguo" → ok:true procesandoCorreo SIN QUE EXISTIERA NINGÚN CFDI.
//      Es exactamente el falso positivo que este proyecto no tolera.
//   4. Buscaba el <select> de Régimen en el paso 2 (ahí no existe) y un campo
//      "Código" en el paso 1 (tampoco existe).
//
// ── EL CAMINO BUENO ES EL ATAJO ───────────────────────────────────────────
//   GET https://<tenant>.youbuy.mx/facturacion/{RFC}/{folio}/{codigo}
// Laravel renderiza <crear-factura :client="{json del cliente}" folioinicial
// codigoinicial> y el mounted() lanza findTicket él solo. NO lleva reCAPTCHA:
// el captcha vive ÚNICAMENTE en la portada (datos fiscales). Verificado en los
// dos inquilinos con el RFC GPR110128QD8 (client id 4499; la tabla de clientes
// es COMPARTIDA entre inquilinos: mismo id en valencia, hepa y yoko).
//   ⚠️ Si el RFC NO está dado de alta, esa MISMA URL responde 200 igual y pinta
//   <datos-fiscales>. Probado con XAXX010101000. Detectar el paso 2 por el DOM,
//   JAMÁS por el código de respuesta.
//   ⚠️ Y por los DOS inputs #inline-full-name, NO por #uso_cfdi como sugiere el
//   reconocimiento: en el render de <crear-factura> el select de Uso CFDI vive
//   dentro de `v-if="hasTicket"`, así que NO EXISTE hasta que findTicket ha
//   contestado. Usarlo como sonda daría "el RFC no está de alta" en cada
//   arranque y mandaría al bot al paso 1 (y al captcha) para nada. Los inputs
//   de folio/código, en cambio, se pintan siempre que el componente esté
//   montado. La portada tiene CERO #inline-full-name (comprobado en los
//   volcados de tmp/youbuy/), así que no hay falso positivo posible.
//
// ── TRAMPAS DEL PORTAL, TODAS COMPROBADAS EN VIVO ─────────────────────────
//  · `Event` GLOBAL PISADO: app.js define un bus de eventos de Vue llamado
//    `Event` que TAPA el constructor nativo del navegador. Dentro de la página,
//    `new Event('change')` lanza "Event is not a constructor" y el evaluate
//    entero se va al catch. Hay que usar document.createEvent('HTMLEvents').
//    Aquí no queda ni un `new Event(...)`: es lo que rompía el fallback de
//    escritura de la versión anterior.
//  · ID DUPLICADO: los inputs de Folio y de Código comparten id
//    "inline-full-name". document.querySelector('#inline-full-name') devuelve
//    SIEMPRE el del folio. Hay que indexar querySelectorAll: [0]=folio,
//    [1]=código (entre los dos hay un <input type=hidden> con el RFC).
//  · EL MENSAJE DE findTicket MIENTE. Respuesta real del ticket #365, que SÍ
//    existe: {"ticket":{...},"bill_limit_date":"30/09/2026","bill_limit":false,
//    "code":200,"message":"No se encontró ningún ticket."}. El discriminante es
//    `data.ticket !== undefined`, que es justo lo que mira el propio Vue.
//  · TICKET YA FACTURADO: findTicket no devuelve `ticket`, devuelve
//    success:true + linkPdf/linkXml/linkOther. O sea, el portal REGALA el CFDI
//    ya emitido. Por eso aquí ya_facturado casi nunca se usa: se descarga la
//    factura que ya existe y se devuelve ok:true con los archivos. (Además,
//    lib/facturacion.js NO tiene rama para 'ya_facturado': caería en el error
//    genérico, que REINTENTA cada noche. Devolverlo sería pedir un bucle.)
//  · "Guardar y Facturar" NO TIMBRA: es el submit del form (handleClick) y lo
//    único que hace es abrir un <vue-confirm-dialog> "Generar Factura / ¿Está
//    seguro que desea facturar el ticket?". EL CLICK QUE EMITE es el OK de ese
//    modal: button.vc-btn SIN la clase .left (el de la izquierda es Cancelar).
//    Es una SPA: no hay navegación en ningún punto del paso 2, así que
//    waitForNavigation solo sirve para perder 60 s.
//  · #uso_cfdi ARRANCA VACÍO aunque la pantalla pinte "G03 - Gastos en
//    general.": selectedIndex=-1 y form.uso_cfdi===''. Si no se elige de
//    verdad, onSubmit aborta con un toast y no se factura nada. Solo ofrece
//    G03 y S01.
//  · Forma de Pago es un <select disabled> sin id ni name: lo fija el servidor
//    con setFormaPago() según ticket.payment (cash→01, check→02, transf→03,
//    cardc→04, cardd→28, resto→99). NO SE TOCA. Pero handleClick aborta si
//    llega vacío, así que se comprueba antes de pulsar nada.
//  · form.total SE MANDA SIEMPRE EN 0: el componente nunca copia ticket.total
//    al form, el importe lo pone el servidor. El bot solo VERIFICA el total del
//    portal contra el del ticket; no lo escribe.
//  · CSRF: /facturacion/* y /clients/* devuelven 419 "CSRF token mismatch" si
//    se llaman desde Node. Dentro de la página axios lo resuelve solo con la
//    cookie XSRF-TOKEN. Por eso TODO va dentro de page.evaluate o de clicks
//    reales, incluida la descarga del XML/PDF.
//
// ── EL CAPTCHA (solo paso 1) Y POR QUÉ CASI NUNCA SE PAGA ─────────────────
// reCAPTCHA v2 INVISIBLE, sitekey 6LdC2f4cAAAAACCE9J4ZYNpIwFh04Yyxg2fzF41v
// (la MISMA en valencia, hepa y yoko), data-callback "callbackRecaptch" (sin la
// "a" final, así está escrito). Y el callback del portal es, literalmente:
//       function callbackRecaptch(token){ document.getElementById('submit').click(); }
// El token NO viaja a ningún sitio: onSubmit hace form.post('/clients/update')
// con axios y solo manda los campos del formulario. O sea, el captcha es una
// puerta de CLIENTE. Por eso el paso 1 primero pulsa #submit directamente (que
// dispara el mismo POST sin gastar CapSolver) y solo si el portal no responde
// se cae al camino caro: CapSolver (ReCaptchaV2TaskProxyLess + isInvisible) +
// inyectar el token + llamar a window.callbackRecaptch(). Pulsar
// #submit_validate a secas relanzaría grecaptcha.execute() y pisaría el token.
//
// ── PLAZO ─────────────────────────────────────────────────────────────────
// El portal NO publica ningún texto de plazo: sale del JSON de findTicket.
//   #365 valencia: created_on 2026-09-05, bill_limit 30 → date_limit 2026-10-05
//   #358 hepa:     created_on 2026-09-08, bill_limit 35 → date_limit 2026-10-13
// y en LOS DOS bill_limit_date = "30/09/2026" (fin de mes). Como las dos fechas
// no coinciden, aquí manda LA MÁS TEMPRANA: si el portal se rige por el fin de
// mes, esperar al date_limit sería llegar tarde. El `bill_limit` de primer
// nivel es un booleano (solo pinta la etiqueta "Fecha de Facturación") y no se
// usa para decidir; se registra en el log.
//
// ── EL CORREO DEL CLIENTE NO ES EL NUESTRO (y por qué no se pisa) ─────────
// /clients/rfc devuelve correo_electronico "mazatlan@grupogpn.com" para
// GPR110128QD8 (alta de 2023). El atajo NO permite cambiarlo: el correo solo se
// toca en el paso 1, que además REESCRIBE la ficha fiscal del RFC para TODA la
// plataforma (tabla compartida). Como el camino normal baja el CFDI de los
// linkPdf/linkXml que devuelve /facturacion/create, el correo es solo una red
// de seguridad, así que NO se sobrescribe la ficha por defecto: hacerlo con un
// razonSocial vacío del ticket corrompería un registro bueno. Se avisa en el
// log y en el mensaje de salida. Para arreglarlo a propósito: YOUBUY_ACTUALIZAR_CLIENTE=1.
//
// ── PRUEBAS SIN TIMBRAR ───────────────────────────────────────────────────
// YOUBUY_DRY_RUN=1 llega hasta el modal de confirmación (la pantalla anterior
// al click que emite), comprueba que el botón OK existe, pulsa CANCELAR y sale
// con datos_invalidos (código sin reintento, por si alguien deja la variable
// puesta en producción). Es el modo con el que se verificó este bot.
const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");

const SITEKEY = "6LdC2f4cAAAAACCE9J4ZYNpIwFh04Yyxg2fzF41v";
const DRY_RUN = process.env.YOUBUY_DRY_RUN === "1";
const ACTUALIZAR_CLIENTE = process.env.YOUBUY_ACTUALIZAR_CLIENTE === "1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── El tenant vive en el subdominio ────────────────────────────────────────
// "https://facturasvalencia.youbuy.mx/algo" → "https://facturasvalencia.youbuy.mx"
// Se acepta también el texto OCR del ticket, que casi siempre imprime la URL.
// El subdominio NO se puede adivinar a partir del nombre del comercio: es el
// inquilino. Sin él se aborta antes de gastar navegador.
function baseYoubuy(...candidatos) {
  for (const c of candidatos) {
    const m = String(c || "").match(/([a-z0-9][a-z0-9-]*)\.youbuy\.mx/i);
    // "www" no es un inquilino: si alguien guarda www.youbuy.mx como portal, el
    // tenant sigue sin saberse y es mejor abortar que facturar en la casa
    // equivocada.
    if (m && m[1].toLowerCase() !== "www") {
      const sub = m[1].toLowerCase();
      return { base: `https://${sub}.youbuy.mx`, sub };
    }
  }
  return null;
}

// La MISMA respuesta de findTicket trae los dos formatos:
//   ticket.date_limit  → "2026-10-05 15:08:16"
//   bill_limit_date    → "30/09/2026"  (día/mes/año)
// Nada de new Date(s) genérico: "05/09/2026" lo leería como 9 de mayo.
function aFecha(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  return null;
}

function hoySinHora() {
  const h = new Date();
  return new Date(h.getFullYear(), h.getMonth(), h.getDate());
}

function aNumero(v) {
  if (typeof v === "number") return isFinite(v) ? v : null;
  const s = String(v == null ? "" : v).replace(/[^0-9.-]/g, "");
  if (!s || s === "-" || s === ".") return null;
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
}

// ── CapSolver: reCAPTCHA v2 INVISIBLE ─────────────────────────────────────
// Asíncrono (createTask + polling), igual que en littlecaesars.js. La
// diferencia es isInvisible:true — sin esa bandera CapSolver resuelve el widget
// equivocado. Solo se llama en el paso 1 y solo si pulsar #submit no bastó.
async function resolverRecaptchaInvisible(websiteURL, websiteKey) {
  const apiKey = process.env.CAPSOLVER_API_KEY;
  if (!apiKey) throw new Error("CAPSOLVER_API_KEY no definida");

  const c = await fetch("https://api.capsolver.com/createTask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientKey: apiKey,
      task: { type: "ReCaptchaV2TaskProxyLess", websiteURL, websiteKey, isInvisible: true },
    }),
  }).then((r) => r.json());
  if (c.errorId) throw new Error(`CapSolver create: ${c.errorCode || c.errorDescription}`);
  if (!c.taskId) throw new Error("CapSolver: no devolvió taskId");

  for (let i = 0; i < 40; i++) {
    await sleep(3000);
    const res = await fetch("https://api.capsolver.com/getTaskResult", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: apiKey, taskId: c.taskId }),
    }).then((r) => r.json());
    if (res.status === "ready") {
      const token = res.solution && res.solution.gRecaptchaResponse;
      if (!token) throw new Error("CapSolver: ready pero sin gRecaptchaResponse");
      console.log(`🔓 reCAPTCHA invisible resuelto por CapSolver (${(i + 1) * 3}s)`);
      return token;
    }
    if (res.errorId) throw new Error(`CapSolver result: ${res.errorCode || res.errorDescription}`);
  }
  throw new Error("CapSolver: timeout de 120 s esperando el token");
}

async function facturarYoubuy(datos = {}) {
  const {
    folio, codigo, total, rfc, razonSocial, regimenFiscal, codigoPostal,
    usoCfdi, emailEntrega, portalUrl, comercio, ocr_text, fecha, ticketId,
  } = datos;

  // ══ VALIDACIÓN ANTES DE ABRIR EL NAVEGADOR ═══════════════════════════════
  // Una sesión de Browserless cuesta tiempo y dinero y el límite de sesiones
  // simultáneas es bajo: lo que se puede rechazar aquí no se abre allí.
  const destino = baseYoubuy(portalUrl, datos.urlEstacion, ocr_text);
  const FOLIO = String(folio == null ? "" : folio).trim();
  const CODIGO = String(codigo == null ? "" : codigo).trim();
  const TOTAL = aNumero(total);
  const RFC = String(rfc == null ? "" : rfc).trim().toUpperCase();

  const faltan = [];
  if (!destino) faltan.push("la URL del portal con su subdominio (*.youbuy.mx) — es el inquilino y no se deduce del nombre del comercio");
  if (!FOLIO) faltan.push("folio del ticket");
  if (!CODIGO) faltan.push("código de facturación del ticket");
  // normalizarDatos() rellena `codigo` con el `folio` cuando el OCR no leyó
  // ninguna referencia. Aquí eso NO es un código válido: el portal pide los dos
  // datos y los valida juntos, así que mandar folio==codigo es tirar el intento.
  if (FOLIO && CODIGO && FOLIO === CODIGO) {
    faltan.push('el CÓDIGO de facturación (llegó el mismo valor que el folio: el OCR no leyó la "referencia" del ticket, que es el código alfanumérico tipo B7LAPE4ISNI)');
  }
  if (!RFC) faltan.push("RFC del receptor");
  // Sin total no hay con qué cruzar el importe del portal, y emitir un CFDI sin
  // ese cruce es justo lo que este proyecto no permite.
  if (TOTAL === null) faltan.push("total del ticket (sin él no se puede verificar el importe antes de timbrar)");
  if (faltan.length) {
    return { ok: false, error_code: "datos_invalidos", msg: `Youbuy: faltan datos — ${faltan.join("; ")}` };
  }

  // El portal valida el RFC en cliente con esta misma regex del SAT. Si no
  // pasa, el paso 1 nunca avanzaría y el atajo daría "RFC no dado de alta".
  if (!/^[A-ZÑ&]{3,4}[0-9]{2}(0[1-9]|1[012])(0[1-9]|[12][0-9]|3[01])[A-Z0-9]{2}[0-9A]$/.test(RFC)) {
    return { ok: false, error_code: "datos_invalidos", msg: `Youbuy: el RFC "${RFC}" no tiene forma de RFC válido (el portal usa la regex del SAT y lo rechazaría en cliente).` };
  }

  // Plazo: el bueno sale del JSON del portal, pero un ticket de hace medio año
  // no merece una sesión de navegador. 60 días es muy por encima de las dos
  // ventanas vistas (30 y 35 días) y del fin de mes.
  const fechaTicket = aFecha(fecha);
  if (fechaTicket) {
    const dias = Math.floor((hoySinHora() - fechaTicket) / 86400000);
    if (dias > 60) {
      return {
        ok: false, error_code: "ticket_vencido", permite_solicitud_correo: true, email_contacto: null,
        msg: `Youbuy (${destino.sub}): el ticket es del ${fecha} (${dias} días). Las ventanas de este portal son de 30-35 días y como mucho hasta fin de mes, así que el plazo ya pasó con seguridad. El portal NO publica correo de facturación: hay que sacarlo del ticket o pedírselo al comercio.`,
      };
    }
  }

  const BASE = destino.base;
  // ⚠️ El "enviar factura a" SIEMPRE es el buzón de captura. El correo del
  // residente aquí dejaría el CFDI en un buzón que el sistema no lee y el
  // ticket esperando para siempre (ver normalizarDatos en bots/index.js).
  const CORREO = String(emailEntrega || process.env.IMAP_USER || "buzonfacturas@serviciosga.site").trim();
  // El select de Uso CFDI de este portal SOLO ofrece G03 y S01.
  const USO = /^S01$/i.test(String(usoCfdi || "")) ? "S01" : "G03";
  const REGIMEN = String(regimenFiscal || "").replace(/[^0-9]/g, "");
  const CP = String(codigoPostal || "").replace(/[^0-9]/g, "");
  const RAZON = String(razonSocial || "").trim().toUpperCase();
  const URL_FACTURA = `${BASE}/facturacion/${encodeURIComponent(RFC)}/${encodeURIComponent(FOLIO)}/${encodeURIComponent(CODIGO)}`;

  console.log("🤖 Iniciando bot Youbuy...");
  console.log(`   Inquilino: ${destino.sub}.youbuy.mx${comercio ? ` (${comercio})` : ""}`);
  console.log(`   Folio: ${FOLIO} | Código: ${CODIGO} | Total esperado: $${TOTAL} | RFC: ${RFC} | Uso: ${USO}`);
  if (DRY_RUN) console.log("   🧪 YOUBUY_DRY_RUN=1 — se parará en el modal de confirmación SIN timbrar");

  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) {
    return { ok: false, error_code: "reintentar_despues", msg: "Youbuy: BROWSERLESS_TOKEN no definido. No se emitió nada." };
  }

  let browser;
  try {
    browser = await puppeteer.connect({
      browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true`,
    });
  } catch (e) {
    // Browserless rechaza con un ErrorEvent pelado cuando la cuenta ya tiene
    // sesiones abiertas: sin este catch el fallo sale como
    // "UnhandledPromiseRejection: #<ErrorEvent>", que no dice nada.
    const m = (e && (e.message || e.reason || e.type)) || "conexión rechazada";
    return { ok: false, error_code: "reintentar_despues", msg: `Youbuy: no se pudo abrir Browserless (${m}). No se emitió nada.` };
  }

  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1050 });
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");
  // OBLIGATORIO y desde el primer instante: un alert() sin manejar cuelga el
  // hilo y Browserless mata la pestaña ("Session closed"/"Target closed", que
  // parecen otra cosa). Es la causa clásica de este proyecto.
  page.on("dialog", async (d) => { console.log(`🔔 Dialog (${d.type()}): ${d.message()}`); await d.accept().catch(() => {}); });
  page.on("pageerror", (e) => console.log(`   [pageerror] ${String(e.message).slice(0, 160)}`));

  const ts = ticketId || Date.now();
  const cerrar = async () => { try { await browser.close(); } catch {} };
  async function captura(label) {
    try {
      const buf = await page.screenshot({ fullPage: true });
      const u = await subirArchivoR2(buf, `debug/youbuy_${ts}_${label}_${Date.now()}.png`, "image/png");
      console.log(`📸 [${label}]: ${u}`);
      return u;
    } catch { return null; }
  }

  // ── Escucha de la API ────────────────────────────────────────────────────
  // La verdad de este portal (importe, plazo, links del CFDI, "ya facturado")
  // viaja en el JSON, no en el DOM: el DOM ni siquiera pinta el mensaje. Leer
  // la respuesta es más fiable que raspar la pantalla y además deja prueba
  // forense en el log si algo sale torcido.
  const api = { rfc: null, update: null, findTicket: null, create: null };
  // ⚠️ Una clave por cada respuesta que se espera con esperarApi(): el contador
  // es lo ÚNICO que distingue "llegó una respuesta nueva" de "estaba la de
  // antes". Si falta la clave, veces[clave] es undefined, `undefined > 0` es
  // false y esperarApi() se queda dando vueltas el timeout entero para devolver
  // null. Pasó con `rfc`: costaba 20 s muertos en cada alta de RFC.
  const veces = { rfc: 0, findTicket: 0, create: 0, update: 0 };
  page.on("response", async (res) => {
    const u = res.url();
    if (!/\/(clients\/rfc|clients\/update|facturacion\/findTicket|facturacion\/create)(\?|$)/i.test(u)) return;
    let texto = "";
    try { texto = await res.text(); } catch { texto = ""; }
    let json = null;
    try { json = JSON.parse(texto); } catch { json = null; }
    const reg = { url: u, status: res.status(), json, texto: String(texto).slice(0, 3000) };
    if (/clients\/rfc/i.test(u)) { api.rfc = reg; veces.rfc++; }
    else if (/clients\/update/i.test(u)) { api.update = reg; veces.update++; }
    else if (/findTicket/i.test(u)) { api.findTicket = reg; veces.findTicket++; }
    else { api.create = reg; veces.create++; }
    console.log(`   ↩ ${u.replace(BASE, "")} → HTTP ${reg.status} · ${reg.texto.replace(/\s+/g, " ").slice(0, 220)}`);
  });

  // Espera a una respuesta NUEVA (no a la que ya estaba guardada de antes).
  async function esperarApi(clave, ms, desde = -1) {
    const base = desde < 0 ? veces[clave] : desde;
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (veces[clave] > base && api[clave]) return api[clave];
      await sleep(400);
    }
    return null;
  }

  // ── Radiografía de la pantalla (DOM + estado de Vue) ─────────────────────
  // Vue 2 deja la instancia en el.__vue__; el componente montado es el primer
  // hijo de #app. De ahí salen form/hasTicket/ticket/facturado/links, que es la
  // única prueba fiable de en qué punto está el portal.
  const mirar = () => page.evaluate(() => {
    const limpio = (s) => (s || "").replace(/\s+/g, " ").trim();
    const out = {
      url: location.href,
      formFiscal: !!document.querySelector("#form_fiscal_data"),
      inputsTicket: document.querySelectorAll("#inline-full-name").length,
      usoCfdi: document.querySelector("#uso_cfdi") ? document.querySelector("#uso_cfdi").value : null,
      texto: limpio(document.body.innerText).slice(0, 700),
      toasts: Array.from(document.querySelectorAll('[class*="toast"]')).map((e) => limpio(e.textContent)).filter(Boolean).slice(0, 6),
      enlaces: Array.from(document.querySelectorAll("a[href]"))
        .filter((a) => /descargar|\.xml|\.pdf/i.test(`${a.getAttribute("href")} ${a.textContent}`))
        .map((a) => ({ t: limpio(a.textContent), href: a.href })).slice(0, 8),
      modal: null,
      vue: null,
    };
    const ov = document.querySelector("#vueConfirm");
    if (ov) {
      const visible = ov.offsetParent !== null || ov.getClientRects().length > 0;
      const btns = Array.from(ov.querySelectorAll("button.vc-btn"));
      out.modal = { visible, texto: limpio(ov.textContent).slice(0, 200), botones: btns.map((b) => ({ t: limpio(b.textContent), left: b.classList.contains("left") })) };
    }
    try {
      const app = document.querySelector("#app");
      const vm = app && app.__vue__ ? (app.__vue__.$children || [])[0] : null;
      if (vm) {
        const copia = (x) => { try { return JSON.parse(JSON.stringify(x)); } catch { return null; } };
        out.vue = {
          form: copia(vm.form), client: copia(vm.client), ticket: copia(vm.ticket),
          hasTicket: vm.hasTicket, hasLinks: vm.hasLinks, facturado: vm.facturado, disable: vm.disable,
          bill_limit: vm.bill_limit, bill_limit_date: vm.bill_limit_date,
          linkPdf: vm.linkPdf, linkXml: vm.linkXml, linkOther: vm.linkOther,
        };
      }
    } catch (e) { out.vueError = String(e && e.message); }
    return out;
  }).catch((e) => ({ error: String(e && e.message) }));

  // ⚠️ REGLA DURA DEL PROYECTO: en Vue poner .value NO BASTA — el valor SE VE
  // en pantalla pero el framework cree que el campo está vacío. Aquí se teclea
  // de verdad y SIEMPRE se relee. El fallback usa document.createEvent porque
  // `new Event(...)` revienta en esta página (el bus `Event` de app.js tapa el
  // constructor nativo).
  async function teclear(selector, valor, nombre) {
    const el = await page.$(selector);
    if (!el) { console.log(`   ✗ ${nombre}: no existe ${selector}`); return false; }
    const v = String(valor == null ? "" : valor);
    await el.click({ clickCount: 3 }).catch(() => {});
    await page.keyboard.type(v, { delay: 35 }).catch(() => {});
    let leido = await page.evaluate((s) => { const e = document.querySelector(s); return e ? e.value : null; }, selector).catch(() => null);
    if (String(leido || "").trim().toUpperCase() !== v.trim().toUpperCase()) {
      await page.evaluate((s, val) => {
        const e = document.querySelector(s);
        if (!e) return;
        const proto = e.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value").set.call(e, val);
        for (const t of ["input", "change", "blur"]) {
          const ev = document.createEvent("HTMLEvents");
          ev.initEvent(t, true, false);
          e.dispatchEvent(ev);
        }
      }, selector, v).catch(() => {});
      leido = await page.evaluate((s) => { const e = document.querySelector(s); return e ? e.value : null; }, selector).catch(() => null);
    }
    const ok = String(leido || "").trim().toUpperCase() === v.trim().toUpperCase();
    console.log(`   ${ok ? "·" : "⚠️"} ${nombre} = "${leido}"${ok ? "" : " (NO coincide con lo que se quería escribir)"}`);
    return ok;
  }

  // Los dos inputs del paso 2 comparten id="inline-full-name": hay que indexar.
  // Se comprueba además que Vue se haya enterado (form.folio / form.codigo),
  // que es lo que de verdad se manda a findTicket.
  async function tecleaTicket(indice, valor, campoVue, nombre) {
    const els = await page.$$("#inline-full-name");
    const el = els[indice];
    if (!el) { console.log(`   ✗ ${nombre}: no existe #inline-full-name[${indice}]`); return false; }
    await el.click({ clickCount: 3 }).catch(() => {});
    await page.keyboard.press("Backspace").catch(() => {});
    await page.keyboard.type(String(valor), { delay: 35 }).catch(() => {});
    const st = await page.evaluate((i) => {
      const e = document.querySelectorAll("#inline-full-name")[i];
      const app = document.querySelector("#app");
      const vm = app && app.__vue__ ? (app.__vue__.$children || [])[0] : null;
      return { dom: e ? e.value : null, folio: vm && vm.form ? vm.form.folio : null, codigo: vm && vm.form ? vm.form.codigo : null };
    }, indice).catch(() => ({}));
    const enVue = String((campoVue === "folio" ? st.folio : st.codigo) || "").trim();
    const ok = String(st.dom || "").trim() === String(valor).trim() && enVue === String(valor).trim();
    console.log(`   ${ok ? "·" : "⚠️"} ${nombre} dom="${st.dom}" vue.${campoVue}="${enVue}"`);
    return ok;
  }

  async function elegirSelect(selector, valor, nombre) {
    const r = await page.evaluate((s, v) => {
      const e = document.querySelector(s);
      if (!e) return { ok: false, motivo: `no existe ${s}` };
      const o = Array.from(e.options).find((x) => String(x.value).trim().toUpperCase() === String(v).trim().toUpperCase());
      if (!o) return { ok: false, motivo: "no está esa opción", opciones: Array.from(e.options).map((x) => `${x.value}|${x.textContent.trim()}`).slice(0, 30) };
      e.value = o.value;
      // ⚠️ NADA de `new Event('change')`: `Event` es el bus de Vue de app.js y
      // el constructor nativo no existe en esta página.
      for (const t of ["input", "change"]) {
        const ev = document.createEvent("HTMLEvents");
        ev.initEvent(t, true, false);
        e.dispatchEvent(ev);
      }
      return { ok: true, elegida: `${o.value} - ${o.textContent.trim()}` };
    }, selector, valor).catch((e) => ({ ok: false, motivo: String(e && e.message) }));
    console.log(`   ${r.ok ? "·" : "⚠️"} ${nombre}: ${r.ok ? r.elegida : `${r.motivo}${r.opciones ? ` (opciones: ${r.opciones.join(" / ")})` : ""}`}`);
    return r;
  }

  // ⚠️ Un click dentro de page.evaluate TIENE que decir si encontró el botón.
  // `const b = ...find(...); if (b) b.click();` sin devolver nada es el bug que
  // dejó dos tickets falsamente facturados en este proyecto.
  async function clickTexto(patron, descripcion) {
    const r = await page.evaluate((p) => {
      const re = new RegExp(p, "i");
      const limpio = (e) => (e.textContent || e.value || "").replace(/\s+/g, " ").trim();
      const cand = Array.from(document.querySelectorAll("button, a, input[type=submit], input[type=button]"))
        .filter((e) => !e.disabled && (e.offsetParent !== null || e.getClientRects().length > 0));
      const b = cand.find((e) => re.test(limpio(e)));
      if (!b) return { encontrado: false, candidatos: cand.map(limpio).filter(Boolean).slice(0, 12) };
      b.click();
      return { encontrado: true, texto: limpio(b) };
    }, patron).catch((e) => ({ encontrado: false, error: String(e && e.message) }));
    console.log(`   ${r.encontrado ? "·" : "✗"} click "${descripcion}": ${r.encontrado ? `"${r.texto}"` : `NO ENCONTRADO${r.candidatos ? ` — botones visibles: ${r.candidatos.join(" | ")}` : ""}${r.error ? ` (${r.error})` : ""}`}`);
    return r;
  }

  // Descarga DENTRO de la sesión del navegador: linkPdf/linkXml pueden ir
  // detrás de la sesión de Laravel y un fetch desde Node no lleva sus cookies.
  // Si el enlace es de otro dominio (un timbrador externo), el fetch de la
  // página puede morir por CORS: entonces se prueba desde Node, que no tiene
  // esa restricción.
  async function descargar(url) {
    if (!url || url === "#") return null;
    let absoluta;
    try { absoluta = new URL(url, BASE).href; } catch { return null; }
    const b64 = await page.evaluate(async (u) => {
      try {
        const r = await fetch(u, { credentials: "include" });
        if (!r.ok) return null;
        const bytes = new Uint8Array(await r.arrayBuffer());
        let bin = "";
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return btoa(bin);
      } catch { return null; }
    }, absoluta).catch(() => null);
    if (b64) return Buffer.from(b64, "base64");
    try {
      const r = await fetch(absoluta);
      if (!r.ok) return null;
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      console.log(`   ⚠️ no se pudo descargar ${absoluta}: ${e.message}`);
      return null;
    }
  }

  // Sube a R2 lo que haya y devuelve las URLs. Comprueba el CONTENIDO: un HTML
  // de login guardado como .xml es peor que no tener archivo, porque el ticket
  // quedaría "procesado" con basura dentro.
  async function guardarArchivos(linkXml, linkPdf) {
    let xmlUrl = null, pdfUrl = null, rfcReceptor = null;
    if (linkXml) {
      const buf = await descargar(linkXml);
      const cabeza = buf ? buf.toString("utf8", 0, 600) : "";
      if (buf && buf.length > 200 && /<\?xml|<cfdi:|<Comprobante/i.test(cabeza)) {
        const m = buf.toString("utf8").match(/Receptor[^>]*?Rfc="([^"]+)"/i);
        rfcReceptor = m ? m[1].toUpperCase() : null;
        xmlUrl = await subirArchivoR2(buf, `facturas/youbuy_${ts}_${FOLIO}.xml`, "application/xml");
        console.log(`☁️ XML: ${xmlUrl}${rfcReceptor ? ` (receptor ${rfcReceptor})` : ""}`);
      } else {
        console.log(`   ⚠️ linkXml no devolvió un CFDI legible (${buf ? `${buf.length} bytes` : "sin respuesta"})`);
      }
    }
    if (linkPdf) {
      const buf = await descargar(linkPdf);
      if (buf && buf.toString("latin1", 0, 4) === "%PDF") {
        pdfUrl = await subirArchivoR2(buf, `facturas/youbuy_${ts}_${FOLIO}.pdf`, "application/pdf");
        console.log(`☁️ PDF: ${pdfUrl}`);
      } else {
        console.log(`   ⚠️ linkPdf no devolvió un PDF legible (${buf ? `${buf.length} bytes` : "sin respuesta"})`);
      }
    }
    return { xmlUrl, pdfUrl, rfcReceptor };
  }

  // Rasca un correo de contacto para el caso de ticket vencido. El portal NO
  // publica ninguno, así que casi siempre saldrá null y así se reporta.
  const correoContacto = () => page.evaluate(() => {
    const m = document.body.innerHTML.match(/mailto:([^"'>\s]+@[^"'>\s]+)/i)
      || document.body.innerText.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i);
    return m ? (m[1] || m[0]) : null;
  }).catch(() => null);

  let timbradoDisparado = false;

  try {
    // ══ PASO 0 — EL ATAJO ══════════════════════════════════════════════════
    console.log(`🔗 Atajo directo: ${URL_FACTURA}`);
    await page.goto(URL_FACTURA, { waitUntil: "networkidle2", timeout: 60000 })
      .catch((e) => console.log(`   (goto: ${e.message} — se sigue y se mira el DOM)`));
    await sleep(2500);
    let st = await mirar();
    // El atajo se detecta por el DOM, NUNCA por el status: con un RFC no dado
    // de alta esta misma URL responde 200 y pinta <datos-fiscales>.
    let enPaso2 = st.inputsTicket >= 2;
    console.log(enPaso2
      ? "   ✔ <crear-factura> montado: el RFC ya está dado de alta y el captcha se salta entero"
      : `   ℹ️ No hay formulario de ticket (formFiscal=${st.formFiscal}): el RFC no está dado de alta en este inquilino`);

    // ══ PASO 1 — DATOS FISCALES (solo si hace falta) ═══════════════════════
    if (!enPaso2 || ACTUALIZAR_CLIENTE) {
      if (ACTUALIZAR_CLIENTE && enPaso2) {
        console.log("🛠️ YOUBUY_ACTUALIZAR_CLIENTE=1 — se va a la portada a reescribir la ficha fiscal del RFC");
        await page.goto(BASE, { waitUntil: "networkidle2", timeout: 60000 }).catch(() => {});
        await sleep(2500);
        st = await mirar();
        enPaso2 = false;
      }
      if (!st.formFiscal) {
        // Ni ticket ni datos fiscales: el portal no montó nada de lo suyo.
        await captura("p0_sin_componente");
        await cerrar();
        return { ok: false, error_code: "reintentar_despues", msg: `Youbuy (${destino.sub}): la página no montó ni <crear-factura> ni <datos-fiscales> en ${page.url()}. O el portal está caído o cambió. Pantalla: ${String(st.texto || "").slice(0, 200)}` };
      }

      // Estos datos solo hacen falta AQUÍ. Se comprueban ahora y no en la
      // validación de arriba a propósito: con el atajo el bot factura sin
      // ellos, y abortar antes habría bloqueado tickets perfectamente buenos.
      const sinDatos = [];
      if (!RAZON) sinDatos.push("razón social");
      if (!REGIMEN) sinDatos.push("régimen fiscal");
      if (!CP) sinDatos.push("código postal fiscal");
      if (sinDatos.length) {
        await cerrar();
        return { ok: false, error_code: "datos_invalidos", msg: `Youbuy (${destino.sub}): el RFC ${RFC} no está dado de alta en este inquilino y hay que crearlo, pero faltan del perfil fiscal: ${sinDatos.join(", ")}.` };
      }

      console.log("📋 Paso 1 — datos fiscales");
      await teclear("#nu_rfc", RFC, "RFC");
      // "Buscar" trae la ficha existente y REEMPLAZA el objeto form entero
      // (this.form = new Form(response.data)), así que cualquier cosa escrita
      // antes se pierde: por eso va aquí, ANTES de rellenar lo demás. A cambio
      // conserva domicilio/teléfono del registro, que si no irían vacíos.
      const buscado = await clickTexto("^\\s*buscar\\s*$", "Buscar RFC");
      if (buscado.encontrado) { await esperarApi("rfc", 20000, 0); await sleep(2000); }

      await teclear("#nb_razonsocial", RAZON, "Razón Social");
      await teclear('input[name="codigo_postal"]', CP, "C.P.");
      // El correo del portal SIEMPRE es el buzón de captura, nunca el residente.
      await teclear("#nb_correo", CORREO, "Correo (buzón de captura)");
      const reg = await elegirSelect("#nb_regimenfiscal", REGIMEN, "Régimen Fiscal");
      if (!reg.ok) {
        await captura("p1_regimen_no_esta");
        await cerrar();
        return { ok: false, error_code: "datos_invalidos", msg: `Youbuy (${destino.sub}): el régimen fiscal ${REGIMEN} no está entre las opciones del portal. ${reg.opciones ? `Opciones: ${reg.opciones.join(" / ")}` : reg.motivo}` };
      }

      // Se comprueba el estado de VUE, no el DOM: es lo que se manda en el POST.
      const antes = await mirar();
      const f = (antes.vue && antes.vue.form) || {};
      console.log(`   estado Vue del paso 1: rfc="${f.rfc}" razon="${f.razon_social}" regimen="${f.regimen_fiscal}" cp="${f.codigo_postal}" correo="${f.correo_electronico}"`);
      const vacios = ["rfc", "razon_social", "regimen_fiscal", "correo_electronico", "codigo_postal"].filter((k) => !String(f[k] || "").trim());
      if (antes.vue && vacios.length) {
        await captura("p1_vue_no_se_entero");
        await cerrar();
        return { ok: false, error_code: "reintentar_despues", msg: `Youbuy (${destino.sub}): Vue no registró estos campos del paso 1 pese a teclearlos: ${vacios.join(", ")}. No se envió nada.` };
      }
      await captura("p1_datos_listos");

      // ── El envío ─────────────────────────────────────────────────────────
      // callbackRecaptch(token) del portal es literalmente
      // document.getElementById('submit').click() y el token NO viaja en el POST
      // (form.post() solo manda los campos). Así que primero se pulsa #submit
      // directamente: mismo efecto, cero CapSolver. Si el portal no contesta, se
      // paga el captcha.
      const desdeUpdate = veces.update;
      // ⚠️ ESTE CLICK PUEDE NAVEGAR: si /clients/update responde bien, Form.js
      // hace Event.$emit('formSuccess') y el created() de <datos-fiscales>
      // ejecuta window.location.href = origin+'/facturacion/'+rfc+'/'+folio+'/'+codigo.
      // Sin vigilar la navegación, el siguiente page.evaluate() se come un
      // "Execution context was destroyed". La espera se ARRANCA antes del click
      // y solo se AGUARDA si el POST salió bien: así no se pagan 30 s de
      // timeout en el caso normal (que es que el POST falle y no navegue nada).
      const navegando = page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => null);
      const directo = await page.evaluate(() => {
        const b = document.getElementById("submit");
        if (!b) return { encontrado: false };
        b.click();
        return { encontrado: true };
      }).catch((e) => ({ encontrado: false, error: String(e && e.message) }));
      console.log(`   · #submit (envío directo, sin captcha): ${directo.encontrado ? "pulsado" : "NO EXISTE"}`);
      let up = directo.encontrado ? await esperarApi("update", 25000, desdeUpdate) : null;
      if (up && up.status < 400) await navegando;

      if (!up || up.status >= 400) {
        console.log(`   ↪ el envío directo no valió (${up ? `HTTP ${up.status}` : "sin respuesta"}): se paga el reCAPTCHA invisible`);
        const dosier = { rfc: RFC, razonSocial: RAZON, regimenFiscal: REGIMEN, codigoPostal: CP, correo: CORREO, folio: FOLIO, codigo: CODIGO, usoCfdi: USO };
        if (!process.env.CAPSOLVER_API_KEY) {
          const cap = await captura("p1_captcha_sin_capsolver");
          await cerrar();
          return {
            ok: false, error_code: "captcha", portal_url: BASE, captura: cap, datos_para_capturar: dosier,
            msg: `Youbuy (${destino.sub}): hay que dar de alta el RFC ${RFC} y el paso de datos fiscales lleva reCAPTCHA invisible; no hay CAPSOLVER_API_KEY. Datos listos para capturar a mano en ${BASE}.`,
          };
        }
        try {
          const tk = await resolverRecaptchaInvisible(`${BASE}/`, SITEKEY);
          const inj = await page.evaluate((t) => {
            const areas = document.querySelectorAll("textarea[name='g-recaptcha-response'], #g-recaptcha-response");
            areas.forEach((a) => { a.value = t; a.innerHTML = t; });
            return { areas: areas.length, hayCallback: typeof window.callbackRecaptch === "function" };
          }, tk);
          console.log(`   token inyectado en ${inj.areas} textarea(s); callbackRecaptch=${inj.hayCallback}`);
          if (!inj.hayCallback) throw new Error("window.callbackRecaptch no existe en la página");
          const desde2 = veces.update;
          // Este disparo SÍ puede navegar: al terminar el POST, el portal hace
          // window.location.href = origin + '/facturacion/' + rfc + '/...'.
          await Promise.all([
            page.waitForNavigation({ waitUntil: "networkidle2", timeout: 45000 }).catch(() => {}),
            page.evaluate((t) => { try { window.callbackRecaptch(t); } catch (e) { console.log(e.message); } }, tk),
          ]);
          up = await esperarApi("update", 25000, desde2);
        } catch (e) {
          const cap = await captura("p1_capsolver_fallo");
          await cerrar();
          return {
            ok: false, error_code: "captcha", portal_url: BASE, captura: cap, datos_para_capturar: dosier,
            msg: `Youbuy (${destino.sub}): no se pudo pasar el reCAPTCHA invisible del alta de RFC (${e.message}). No se emitió nada; se puede terminar a mano en ${BASE}.`,
          };
        }
      }

      await sleep(2500);
      await captura("p1_post_envio");
      if (!up || up.status >= 400) {
        await cerrar();
        return { ok: false, error_code: "reintentar_despues", msg: `Youbuy (${destino.sub}): /clients/update no aceptó el alta del RFC ${RFC} (${up ? `HTTP ${up.status}: ${String(up.texto).slice(0, 160)}` : "sin respuesta"}). No se emitió nada.` };
      }
      console.log("   ✔ ficha fiscal guardada");

      // El redirect del portal usa las props folio/codigo del blade, que en la
      // portada llegan VACÍAS: acaba en /facturacion/{rfc}// y no sirve. Se va a
      // la URL canónica a mano siempre que no estemos ya en el paso 2.
      st = await mirar();
      if (st.inputsTicket < 2) {
        console.log(`   ↪ el portal quedó en ${st.url} — navegando a la URL canónica del paso 2`);
        await page.goto(URL_FACTURA, { waitUntil: "networkidle2", timeout: 60000 }).catch(() => {});
        await sleep(2500);
        st = await mirar();
      }
      if (st.inputsTicket < 2) {
        await captura("p1_sin_paso2");
        await cerrar();
        return { ok: false, error_code: "reintentar_despues", msg: `Youbuy (${destino.sub}): tras dar de alta el RFC, ${URL_FACTURA} sigue sin montar <crear-factura>. Pantalla: ${String(st.texto || "").slice(0, 200)}` };
      }
    }

    // ══ PASO 2 — BUSCAR EL TICKET ══════════════════════════════════════════
    // El mounted() de <crear-factura> ya lanza findTicket solo con lo que viene
    // en la URL, así que lo normal es que la respuesta esté ya capturada.
    console.log("🎫 Paso 2 — ticket");
    let hallazgo = api.findTicket || await esperarApi("findTicket", 20000, 0);

    // Si no salió sola (o los valores de la URL no cuajaron), se teclean folio y
    // código y se pulsa "Buscar Ticket".
    if (!hallazgo || !(hallazgo.json && (hallazgo.json.ticket !== undefined || hallazgo.json.success))) {
      await tecleaTicket(0, FOLIO, "folio", "Folio del Ticket");
      await tecleaTicket(1, CODIGO, "codigo", "Código de Facturación");
      const desde = veces.findTicket;
      const b = await clickTexto("buscar\\s*ticket", "Buscar Ticket");
      if (!b.encontrado) {
        await captura("p2_sin_boton_buscar");
        await cerrar();
        return { ok: false, error_code: "reintentar_despues", msg: `Youbuy (${destino.sub}): no apareció el botón "Buscar Ticket" en ${page.url()}.` };
      }
      hallazgo = await esperarApi("findTicket", 45000, desde) || api.findTicket;
      await sleep(1500);
    }
    await captura("p2_ticket");
    st = await mirar();

    if (!hallazgo) {
      await cerrar();
      return { ok: false, error_code: "reintentar_despues", msg: `Youbuy (${destino.sub}): el portal no respondió a /facturacion/findTicket para el folio ${FOLIO}. Pantalla: ${String(st.texto || "").slice(0, 200)}` };
    }
    // ⚠️ CUALQUIER código que no sea 2xx es fallo del PORTAL, no del ticket:
    // el "no lo encuentro" del portal viaja en un HTTP 200 con JSON (el .then()
    // de Vue es quien decide, no el .catch()). Así que un 419 de CSRF, un 429 o
    // un 503 tienen que reintentarse; si se dejaran caer más abajo saldrían como
    // datos_invalidos ("el portal no reconoce el folio"), que NO reintenta y
    // manda a confirmación humana un ticket que estaba perfectamente bien.
    if (hallazgo.status >= 400) {
      await captura("p2_findticket_http");
      await cerrar();
      return { ok: false, error_code: "reintentar_despues", msg: `Youbuy (${destino.sub}): findTicket devolvió HTTP ${hallazgo.status} — fallo del portal, no del ticket (${hallazgo.status === 419 ? "419 = CSRF: la sesión de Laravel caducó" : String(hallazgo.texto).slice(0, 160)}). No se timbró.` };
    }
    // Mismo motivo: un 200 que NO es JSON (portada de login, página de
    // mantenimiento, HTML de error) no dice nada del folio. Sin este guardia
    // acabaría también en datos_invalidos.
    if (!hallazgo.json) {
      await captura("p2_findticket_no_json");
      await cerrar();
      return { ok: false, error_code: "reintentar_despues", msg: `Youbuy (${destino.sub}): findTicket contestó HTTP ${hallazgo.status} pero con algo que no es JSON (${String(hallazgo.texto).replace(/\s+/g, " ").slice(0, 160)}). No se timbró.` };
    }
    const J = hallazgo.json || {};

    // ── EL TICKET YA ESTABA FACTURADO ─────────────────────────────────────
    // El portal no devuelve `ticket`: devuelve success + los enlaces del CFDI
    // que ya existe. Es un regalo — se baja la factura y se cierra el ticket
    // sin timbrar nada.
    if (J.ticket === undefined && J.success) {
      console.log(`⚠️ El ticket ${FOLIO} YA estaba facturado; el portal devuelve el CFDI existente`);
      const arch = await guardarArchivos(J.linkXml, J.linkPdf);
      await cerrar();
      if (arch.rfcReceptor && arch.rfcReceptor !== RFC) {
        return { ok: false, error_code: "datos_invalidos", msg: `Youbuy (${destino.sub}): el ticket ${FOLIO} ya estaba facturado, pero a NOMBRE DE OTRO RFC (${arch.rfcReceptor}, no ${RFC}). No se puede refacturar: hay que reclamarlo en el comercio.` };
      }
      if (arch.xmlUrl) {
        return { ok: true, xmlUrl: arch.xmlUrl, pdfUrl: arch.pdfUrl, msg: `Youbuy (${destino.sub}): el ticket ${FOLIO} ya estaba facturado y se recuperó el CFDI del portal (no se emitió nada nuevo).` };
      }
      // El CFDI existe pero no se pudo bajar: NO se reintenta (volvería a
      // intentar timbrar un ticket ya facturado, noche tras noche).
      return {
        ok: false, error_code: "timbrado_sin_archivos", pdfUrl: arch.pdfUrl || null,
        msg: `Youbuy (${destino.sub}): el ticket ${FOLIO} YA está facturado y el portal ofrece los enlaces, pero no se pudieron descargar. Bájalos a mano: XML ${J.linkXml || "—"} | PDF ${J.linkPdf || "—"} (o vuelve a abrir ${URL_FACTURA}).`,
      };
    }

    // ── NO HAY TICKET ─────────────────────────────────────────────────────
    // ⚠️ AQUÍ NO SE MIRA EL `message`: findTicket contesta SIEMPRE "No se
    // encontró ningún ticket.", también cuando lo encuentra. El discriminante
    // es la clave `ticket`, igual que en el propio Vue.
    if (J.ticket === undefined) {
      const contacto = await correoContacto();
      await cerrar();
      const dias = fechaTicket ? Math.floor((hoySinHora() - fechaTicket) / 86400000) : null;
      // El portal responde lo mismo para un folio inexistente, un código malo y
      // (según su ventana) un ticket fuera de plazo. Con la fecha del ticket se
      // puede separar: pasados los 30 días conocidos, lo probable es el plazo.
      if (dias !== null && dias > 30) {
        return {
          ok: false, error_code: "ticket_vencido", permite_solicitud_correo: true, email_contacto: contacto || null,
          msg: `Youbuy (${destino.sub}): el portal ya no encuentra el ticket ${FOLIO} y la compra es del ${fecha} (${dias} días). Las ventanas de este portal son de 30-35 días / fin de mes, así que lo más probable es que el plazo haya pasado. ${contacto ? `Contacto en el portal: ${contacto}` : "El portal NO publica correo de facturación: hay que sacarlo del ticket o pedírselo al comercio."}`,
        };
      }
      return {
        ok: false, error_code: "datos_invalidos",
        msg: `Youbuy (${destino.sub}): el portal no reconoce el folio ${FOLIO} con el código ${CODIGO}. Valida los DOS a la vez, así que basta con que uno esté mal leído (el código es el alfanumérico de 11 caracteres del ticket, tipo B7LAPE4ISNI).`,
      };
    }

    // ── PLAZO ──────────────────────────────────────────────────────────────
    const T = J.ticket || {};
    const limites = [aFecha(T.date_limit), aFecha(J.bill_limit_date)].filter(Boolean);
    // Manda la MÁS TEMPRANA: date_limit (created_on + bill_limit días) y
    // bill_limit_date (fin de mes) no coinciden, y llegar tarde no tiene arreglo.
    const limite = limites.length ? new Date(Math.min(...limites.map((d) => d.getTime()))) : null;
    console.log(`   plazo: date_limit=${T.date_limit || "—"} · bill_limit_date=${J.bill_limit_date || "—"} · bandera bill_limit=${J.bill_limit} → se usa ${limite ? limite.toLocaleDateString("es-MX") : "ninguno"}`);
    if (limite && limite < hoySinHora()) {
      const contacto = await correoContacto();
      await captura("p2_vencido");
      await cerrar();
      return {
        ok: false, error_code: "ticket_vencido", permite_solicitud_correo: true, email_contacto: contacto || null,
        msg: `Youbuy (${destino.sub}): el plazo para facturar el ticket ${FOLIO} venció el ${limite.toLocaleDateString("es-MX")} (date_limit ${T.date_limit || "—"}, bill_limit_date ${J.bill_limit_date || "—"}). ${contacto ? `Contacto en el portal: ${contacto}` : "El portal NO publica correo de facturación: hay que sacarlo del ticket o pedírselo al comercio."}`,
      };
    }

    // ── CRUCE DEL IMPORTE, ANTES DE TIMBRAR ───────────────────────────────
    // El del JSON es el del backend; el de la pantalla es el mismo pintado.
    // Si no cuadra, no se timbra: un CFDI por un importe que no corresponde no
    // se corrige, se cancela.
    const montoPortal = aNumero(T.total);
    if (montoPortal === null) {
      await captura("p2_sin_monto");
      await cerrar();
      return { ok: false, error_code: "reintentar_despues", msg: `Youbuy (${destino.sub}): findTicket no trajo el total del ticket ${FOLIO} (${String(hallazgo.texto).slice(0, 200)}), así que no había con qué cruzar los $${TOTAL} del ticket. No se timbró.` };
    }
    if (Math.abs(montoPortal - TOTAL) > 1) {
      await captura("p2_monto_no_cuadra");
      await cerrar();
      return { ok: false, error_code: "datos_invalidos", msg: `Youbuy (${destino.sub}): el importe del portal para el folio ${FOLIO} es $${montoPortal} y el del ticket $${TOTAL}. No se timbró: o el OCR leyó mal el total, o el folio es de otra compra.` };
    }
    console.log(`   ✔ Importe verificado contra el portal: $${montoPortal} (ticket $${TOTAL})`);

    // ── FORMA DE PAGO ─────────────────────────────────────────────────────
    // La pone el servidor (setFormaPago desde ticket.payment) en un <select
    // disabled>. NO se toca, pero handleClick aborta con un toast si llega
    // vacía, y ese aborto silencioso dejaría el bot esperando un modal que no
    // sale. Se comprueba antes de pulsar nada.
    const formaPago = st.vue && st.vue.form ? String(st.vue.form.forma_pago || "") : "";
    console.log(`   forma de pago fijada por el portal: "${formaPago}" (ticket.payment="${T.payment}")`);
    if (st.vue && !formaPago) {
      await captura("p2_sin_forma_pago");
      await cerrar();
      return { ok: false, error_code: "reintentar_despues", msg: `Youbuy (${destino.sub}): el portal no fijó la forma de pago del ticket ${FOLIO} (ticket.payment="${T.payment}"), y sin ella el propio formulario aborta. No se timbró.` };
    }

    // ── USO CFDI ──────────────────────────────────────────────────────────
    // ⚠️ Arranca VACÍO aunque la pantalla pinte "G03 - Gastos en general.":
    // selectedIndex=-1 y form.uso_cfdi===''. Si no se elige de verdad, onSubmit
    // aborta con un toast DESPUÉS de haber abierto el modal.
    let uso = await elegirSelect("#uso_cfdi", USO, "Uso CFDI");
    if (!uso.ok && USO !== "G03") {
      console.log("   ↪ ese uso no está (este portal solo ofrece G03 y S01): se cae a G03");
      uso = await elegirSelect("#uso_cfdi", "G03", "Uso CFDI (fallback)");
    }
    st = await mirar();
    const usoVue = st.vue && st.vue.form ? String(st.vue.form.uso_cfdi || "") : "";
    console.log(`   uso_cfdi en Vue: "${usoVue}"`);
    if (!usoVue) {
      await captura("p2_uso_cfdi_vacio");
      await cerrar();
      return { ok: false, error_code: "reintentar_despues", msg: `Youbuy (${destino.sub}): no se pudo fijar el Uso CFDI (${uso.motivo || "el select no aceptó el cambio"}); el formulario lo exige y habría abortado solo. No se timbró.` };
    }

    await captura("p3_previo_facturar");

    // ══ CONFIRMACIÓN ═══════════════════════════════════════════════════════
    // "Guardar y Facturar" es el submit del form → handleClick → abre el modal
    // vue-confirm. NO timbra y NO navega (SPA): nada de waitForNavigation aquí,
    // que es lo que dejaba al bot esperando 60 s a una navegación imposible.
    console.log("🧾 Guardar y Facturar (abre el modal de confirmación, todavía NO timbra)...");
    const gyf = await clickTexto("guardar\\s*y\\s*facturar", "Guardar y Facturar");
    if (!gyf.encontrado) {
      await captura("p3_sin_boton");
      await cerrar();
      return { ok: false, error_code: "reintentar_despues", msg: `Youbuy (${destino.sub}): no apareció el botón "Guardar y Facturar" con el ticket cargado. No se timbró.` };
    }

    // El modal tarda un parpadeo en montarse.
    let modal = null;
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      const s = await mirar();
      if (s.modal && s.modal.visible && s.modal.botones && s.modal.botones.length) { modal = s.modal; st = s; break; }
    }
    if (!modal) {
      st = await mirar();
      await captura("p3_sin_modal");
      await cerrar();
      // handleClick solo aborta antes del modal por forma de pago vacía; si eso
      // pasa, el toast lo dice. Nada emitido en ningún caso.
      return { ok: false, error_code: "reintentar_despues", msg: `Youbuy (${destino.sub}): se pulsó "Guardar y Facturar" pero no salió el modal de confirmación, así que NO se timbró nada. Toasts: ${(st.toasts || []).join(" | ") || "ninguno"}. Pantalla: ${String(st.texto || "").slice(0, 160)}` };
    }
    console.log(`   modal: "${modal.texto}" · botones: ${modal.botones.map((b) => `${b.t}${b.left ? " (izq/Cancelar)" : ""}`).join(", ")}`);
    await captura("p3_modal_confirmacion");

    if (DRY_RUN) {
      // Pantalla anterior al click que emite. Se cancela y se sale.
      const cancel = await page.evaluate(() => {
        const b = document.querySelector("#vueConfirm button.vc-btn.left");
        if (!b) return { encontrado: false };
        b.click();
        return { encontrado: true, texto: (b.textContent || "").trim() };
      }).catch(() => ({ encontrado: false }));
      console.log(`   🧪 DRY RUN — cancelando (${cancel.encontrado ? cancel.texto : "no se encontró Cancelar"})`);
      await sleep(1500);
      await captura("p3_dry_run_cancelado");
      await cerrar();
      return {
        ok: false, error_code: "datos_invalidos",
        msg: `Youbuy (${destino.sub}): DRY RUN (YOUBUY_DRY_RUN=1). Se llegó al modal de confirmación del folio ${FOLIO} con importe verificado ($${montoPortal}), uso ${usoVue} y forma de pago ${formaPago}, y se canceló SIN timbrar. Botones del modal: ${modal.botones.map((b) => b.t).join(" / ")}.`,
      };
    }

    // ══ EL CLICK QUE EMITE ═════════════════════════════════════════════════
    // El OK del modal llama a onSubmit() → POST /facturacion/create. A partir
    // de la línea siguiente, NINGÚN camino puede devolver un error reintentable.
    timbradoDisparado = true;
    const desdeCreate = veces.create;
    const ok = await page.evaluate(() => {
      const ov = document.querySelector("#vueConfirm");
      if (!ov) return { encontrado: false, motivo: "no existe #vueConfirm" };
      const btns = Array.from(ov.querySelectorAll("button.vc-btn"));
      if (!btns.length) return { encontrado: false, motivo: "el modal no tiene botones .vc-btn" };
      // El de Cancelar lleva ADEMÁS la clase .left; el de OK es el otro.
      const si = btns.find((b) => !b.classList.contains("left"));
      if (!si) return { encontrado: false, motivo: "solo está el botón izquierdo (Cancelar)" };
      // vue-confirm-dialog pinta el OK con disabled="isLoading || isConfirmLoading".
      // Un .click() sobre un botón deshabilitado NO dispara nada, pero el bot ya
      // tendría la bandera levantada y acabaría cerrando el ticket como
      // "timbrado_sin_archivos" sin que se hubiera emitido NADA. Mejor decir que
      // no se pudo pulsar: eso baja la bandera y deja un error reintentable
      // honesto.
      if (si.disabled) return { encontrado: false, motivo: "el OK del modal está deshabilitado (el portal seguía cargando)" };
      const t = (si.textContent || "").trim();
      si.click();
      return { encontrado: true, texto: t };
    }).catch((e) => ({ encontrado: false, motivo: String(e && e.message) }));

    if (!ok.encontrado) {
      // Evidencia POSITIVA de que no salió ningún click: el evaluate devolvió
      // que no encontró el botón. Por eso, y solo por eso, se puede volver a
      // bajar la bandera y devolver un error reintentable sin riesgo.
      timbradoDisparado = false;
      await captura("p4_sin_boton_ok");
      await cerrar();
      return { ok: false, error_code: "reintentar_despues", msg: `Youbuy (${destino.sub}): el modal de confirmación salió pero no se pudo pulsar su OK (${ok.motivo}). NO se timbró.` };
    }
    console.log(`   ✔ OK del modal pulsado ("${ok.texto}") — el CFDI puede estar emitiéndose`);

    // El timbrado tarda: se espera la respuesta de create, y en paralelo se
    // vigila el estado de Vue (facturado/hasLinks) por si la respuesta se
    // pierde por lo que sea.
    let creado = await esperarApi("create", 120000, desdeCreate);
    for (let i = 0; i < 10 && !creado; i++) {
      const s = await mirar();
      if (s.vue && (s.vue.facturado || s.vue.hasLinks)) break;
      await sleep(3000);
    }
    await sleep(2000);
    st = await mirar();
    await captura("p4_post_facturar");

    // ── ¿HAY PRUEBA DE EMISIÓN? ────────────────────────────────────────────
    // Solo vale: enlaces del CFDI en la respuesta de create, o el estado
    // facturado/hasLinks de Vue, o la pantalla de "Gracias por facturar" con
    // sus <a> de descarga. No haber visto la palabra "error" NO es prueba.
    const cj = (creado && creado.json) || {};
    const v = st.vue || {};
    const limpiaLink = (x) => (x && x !== "#" ? String(x) : null);
    let linkXml = limpiaLink(cj.linkXml) || limpiaLink(v.linkXml);
    let linkPdf = limpiaLink(cj.linkPdf) || limpiaLink(v.linkPdf);
    if (!linkXml || !linkPdf) {
      for (const a of st.enlaces || []) {
        if (!linkXml && /xml/i.test(`${a.t} ${a.href}`)) linkXml = a.href;
        if (!linkPdf && /pdf/i.test(`${a.t} ${a.href}`)) linkPdf = a.href;
      }
    }
    const pantallaExito = !!(v.facturado || v.hasLinks) || /gracias por facturar/i.test(st.texto || "");
    console.log(`   create: ${creado ? `HTTP ${creado.status}` : "sin respuesta"} · facturado=${v.facturado} hasLinks=${v.hasLinks} · XML=${linkXml || "—"} PDF=${linkPdf || "—"}`);

    if (linkXml || linkPdf) {
      const arch = await guardarArchivos(linkXml, linkPdf);
      await cerrar();
      if (arch.xmlUrl) {
        console.log(`✅ Youbuy OK — folio ${FOLIO}`);
        return { ok: true, xmlUrl: arch.xmlUrl, pdfUrl: arch.pdfUrl };
      }
      // El CFDI EXISTE (el portal dio los enlaces) pero no se pudo bajar.
      // timbrado_sin_archivos NO reintenta, que es justo lo que hace falta.
      return {
        ok: false, error_code: "timbrado_sin_archivos", pdfUrl: arch.pdfUrl || null,
        msg: `Youbuy (${destino.sub}): el CFDI del folio ${FOLIO} SÍ se emitió (el portal devolvió los enlaces) pero no se pudo descargar. NO RELANZAR: se duplicaría. Bájalo a mano — XML ${linkXml || "—"} | PDF ${linkPdf || "—"}, o vuelve a abrir ${URL_FACTURA}, que si el ticket ya está facturado el portal muestra los enlaces solo.`,
      };
    }

    // Sin enlaces. Antes de rendirse: findTicket sobre un ticket YA facturado
    // devuelve success + los links, así que sirve de comprobante independiente
    // de si el CFDI existe. Es de solo lectura: preguntarlo no emite nada.
    console.log("   ⚠️ create no dejó enlaces: se vuelve a consultar findTicket para ver si el CFDI existe");
    // Esta consulta es la ÚLTIMA prueba posible antes de tener que mandar a una
    // persona a mirar el portal, así que no puede depender de que exista el
    // global `axios`: si no está, se hace a mano con fetch poniendo la cabecera
    // X-XSRF-TOKEN a partir de la cookie (es lo que hace axios por dentro en
    // Laravel; sin ella el POST vuelve 419 CSRF).
    const rev = await page.evaluate(async (f, c, r) => {
      const cuerpo = { folio: f, codigo: c, rfc: r };
      if (typeof window.axios !== "undefined") {
        try {
          const res = await window.axios.post("/facturacion/findTicket", cuerpo);
          return { ok: true, data: res.data };
        } catch (e) { return { ok: false, error: `axios: ${String(e && e.message)}` }; }
      }
      try {
        const m = document.cookie.match(/XSRF-TOKEN=([^;]+)/);
        const res = await fetch("/facturacion/findTicket", {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            "X-Requested-With": "XMLHttpRequest",
            ...(m ? { "X-XSRF-TOKEN": decodeURIComponent(m[1]) } : {}),
          },
          body: JSON.stringify(cuerpo),
        });
        return { ok: res.ok, status: res.status, data: await res.json().catch(() => null) };
      } catch (e) { return { ok: false, error: `fetch: ${String(e && e.message)}` }; }
    }, FOLIO, CODIGO, RFC).catch((e) => ({ ok: false, error: String(e && e.message) }));
    const rd = (rev && rev.data) || {};
    console.log(`   findTicket de comprobación: ${JSON.stringify(rd).slice(0, 240)}`);

    if (rd.ticket === undefined && rd.success) {
      // Prueba: el portal ya considera facturado el ticket y entrega el CFDI.
      const arch = await guardarArchivos(rd.linkXml, rd.linkPdf);
      await cerrar();
      if (arch.xmlUrl) {
        console.log(`✅ Youbuy OK (confirmado por findTicket) — folio ${FOLIO}`);
        return { ok: true, xmlUrl: arch.xmlUrl, pdfUrl: arch.pdfUrl };
      }
      return {
        ok: false, error_code: "timbrado_sin_archivos", pdfUrl: arch.pdfUrl || null,
        msg: `Youbuy (${destino.sub}): el CFDI del folio ${FOLIO} EXISTE (findTicket ya lo da por facturado) pero no se pudo descargar. NO RELANZAR. Enlaces: XML ${rd.linkXml || "—"} | PDF ${rd.linkPdf || "—"}.`,
      };
    }

    await cerrar();
    // Aquí no hay prueba de nada: ni enlaces, ni pantalla de éxito, y findTicket
    // sigue ofreciendo el ticket (lo que APUNTA a que no se emitió, pero no lo
    // demuestra: el click de OK ya salió). Nunca un código reintentable después
    // de ese click — duplicar un CFDI es peor que esperar a que lo mire alguien.
    return {
      ok: false, error_code: "timbrado_sin_archivos",
      msg: `Youbuy (${destino.sub}): se pulsó el OK que emite el folio ${FOLIO} y el portal NO confirmó nada (create: ${creado ? `HTTP ${creado.status} ${String(creado.texto).slice(0, 160)}` : "sin respuesta"}; pantalla de éxito: ${pantallaExito}; toasts: ${(st.toasts || []).join(" | ") || "ninguno"}). Al reconsultar, el portal ${rd.ticket !== undefined ? "TODAVÍA ofrece el ticket como facturable, así que probablemente NO se emitió" : "no devolvió nada concluyente"}. NO RELANZAR el bot a ciegas: abre ${URL_FACTURA} y comprueba si el CFDI existe antes de nada.`,
    };
  } catch (e) {
    console.error(`❌ Youbuy: ${e.message}`);
    await captura("excepcion").catch(() => {});
    await cerrar();
    if (timbradoDisparado) {
      // La excepción llegó DESPUÉS del click que emite: el CFDI puede estar
      // emitido. Jamás un error que invite a reintentar.
      return {
        ok: true, procesandoCorreo: true,
        msg: `Youbuy (${destino.sub}): excepción DESPUÉS de pulsar el OK que emite el folio ${FOLIO} (${e.message}). La factura pudo quedar emitida. NO RELANZAR: comprobar antes en ${URL_FACTURA} si el CFDI ya existe (si está facturado, el portal muestra los enlaces de descarga solo). OJO: el correo del RFC en este portal puede no ser el buzón de captura, así que quizá el CFDI no llegue por IMAP.`,
      };
    }
    return { ok: false, error_code: "reintentar_despues", msg: `Youbuy (${destino.sub}): ${e.message} (no se emitió nada)` };
  }
}

module.exports = { facturarYoubuy };
