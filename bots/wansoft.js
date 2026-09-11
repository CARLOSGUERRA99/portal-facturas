// Wansoft Autoemisión — https://www.wansoft.net (ASP.NET MVC, multi-tenant)
//
// UN SOLO BOT PARA LAS TRES SUCURSALES DE "LOS SENDEROS S.A. DE C.V.":
//   #361 SUPER VOY SALA DE ESPERA (Mazatlán) $39  → sid 7786
//   #368 SUPER VOY 1              (Durango)  $39  → sid 7780
//   #370 SUPER VOY D PICNIKS      (Torreón)  $37  → sid 7764
// Mismo formulario (action /Wansoft.Web/Public/GenerateInvoice) y mismos ids
// (BillingCode, rfc, legalName, email, CP, receiverFiscalRegime,
// ReceiverCfdiUse, formOfPayment). Lo ÚNICO que cambia entre sucursales es el
// hidden subsidiaryId — por eso no hacen falta tres bots, hace falta resolver
// bien el sid.
//
// ── RECONOCIMIENTO (11-sep-2026) ────────────────────────────────────────────
//   Landing   www.wansoft.net/<tenant>/FE.html  → botones, uno por sucursal.
//             El portalUrl del ticket NUNCA es el formulario, SIEMPRE es este
//             landing. Hay que casar el texto del botón contra el comercio.
//   Form A    /Wansoft.Web/Public/ElectronicInvoice?sid=SID
//             (302 → /AutoInvoicing?id=<cifrado>)
//   Form B    /Wansoft.Web/Public/ElectronicInvoice40?sid=SID&hasCode=false
//   Submit    POST /Wansoft.Web/Public/GenerateInvoice
//
// ── DOS FLUJOS ──────────────────────────────────────────────────────────────
//   (A) CON código de facturación (BillingCode, sólo dígitos). El portal
//       valida el código por AJAX (POST Public/GetBillingInformation) y RECIÉN
//       ENTONCES rellena los <select>.
//   (B) SIN código: Fecha del ticket (datepicker READONLY, YYYY-MM-DD) +
//       Orden (numérico) + Total del ticket + Total a facturar + Propina (0).
//
// ── TRAMPAS CONFIRMADAS EN EL RECONOCIMIENTO ────────────────────────────────
//   1. LOS SELECTS LLEGAN VACÍOS. Régimen / Uso CFDI / Forma de pago no traen
//      <option> en el HTML: los pinta el AJAX después de validar el código. Un
//      page.select() inmediato no encuentra nada. Aquí se espera a que se
//      pueblen (esperarSelectsPoblados) antes de tocarlos.
//   2. LA FECHA ES UN DATEPICKER READONLY. type() no escribe nada. Se le quita
//      el readonly, se usa el setter nativo, se avisa al datepicker de jQuery
//      si existe, y SE RELEE el valor para comprobar que quedó puesto.
//   3. CLOUDFLARE DELANTE. WebFetch recibió 403; sólo pasó curl con
//      User-Agent de navegador. Este bot NECESITA navegador real: nunca HTTP
//      plano, siempre Browserless con stealth.
//   4. PLAZO: el portal dice literalmente que sólo se factura dentro del MES
//      EN CURSO. Se comprueba ANTES de abrir el navegador cuando hay fecha.
//   5. LA URL DEL TICKET #370 ESTÁ MAL ESCRITA:
//        .../LosSenderos/Torreon/FE.html  (con barra de más)
//      devuelve la página "404 NOT FOUND" DE WANSOFT **CON HTTP 200**. O sea:
//      el status HTTP miente. Por eso aquí (a) el sid se resuelve contra la
//      tabla SUCURSALES normalizando la URL (quitando barras y mayúsculas, así
//      la URL rota sigue identificando "lossenderostorreon"), y (b) el landing
//      se valida POR CONTENIDO, no por status.
//
// ── LO QUE QUEDÓ **NO CONFIRMADO** (y cómo lo cubre este código) ────────────
//   · TURNSTILE: hay <div class="cf-turnstile"> y se carga el api.js de
//     Cloudflare, pero NO se encontró data-sitekey ni turnstile.render(): el
//     widget PARECE inerte. No está verificado. El bot lo detecta en cada
//     pantalla; si aparece de verdad con sitekey lo intenta por CapSolver
//     (AntiTurnstileTaskProxyLess, el mismo camino que homedepot.js) y, si no
//     hay CapSolver o falla, devuelve error_code 'captcha' con el dosier.
//   · FORMATO DEL CÓDIGO: el #361 trae folio 78 (encaja con el flujo B) y el
//     #368/#370 traen cadenas numéricas largas. No se sabe cuál es "el"
//     BillingCode. Regla implementada: código de >= UMBRAL_CODIGO_LARGO
//     dígitos → flujo A; si no, flujo B. Y si el flujo A rebota porque el
//     portal no reconoce el código, CAE SOLO al flujo B cuando hay fecha,
//     orden y total.
//   · IDS DEL FLUJO B: el reconocimiento sólo capturó los ids del bloque
//     fiscal. Fecha/Orden/Totales/Propina se localizan por heurística
//     (id, name, placeholder, label y texto del contenedor) y, si no
//     aparecen, el bot ABORTA con el inventario de inputs en el mensaje en
//     vez de escribir a ciegas.
//   · QUÉ DISPARA EL AJAX DE LOS CATÁLOGOS EN EL FLUJO B: sólo se vio con
//     código. Si los selects no se pueblan, el bot aborta y lo dice.
//   · PANTALLA DE ÉXITO: no se conoce su texto exacto ni si ofrece descarga
//     directa de XML/PDF. El bot intenta capturar los archivos y, si no los
//     hay, se apoya en el correo (por eso #email lleva el buzón de captura).
//
// ── DOS DECISIONES DELIBERADAS SOBRE DUPLICADOS ─────────────────────────────
//   · El click de "Generar" NAVEGA (es un POST de MVC). Va envuelto en
//     Promise.all con waitForNavigation: sin eso el page.evaluate siguiente
//     revienta con "Execution context was destroyed" DESPUÉS de haber enviado
//     el formulario — la factura queda emitida y el ticket marcado como error,
//     que es justo lo que invita a reintentar y duplicar el CFDI.
//   · Si el formulario YA SE ENVIÓ y el resultado es ambiguo (o revienta una
//     excepción), este bot devuelve {ok:true, procesandoCorreo:true} con un
//     mensaje que lo dice, NO un error reintentable. Un error reintentable
//     dispararía el reintento de medianoche y podría emitir un segundo CFDI.
//     Sólo devuelve error cuando hay PRUEBA de que no se timbró (el formulario
//     volvió con errores de validación o con un mensaje de rechazo).
//
// ── CORREO DEL COMERCIO ─────────────────────────────────────────────────────
//   NO hay correo de facturación de Los Senderos publicado: los hidden
//   AutoemissionEmail / AutoemissionPhone vienen VACÍOS. Lo único visible es
//   soporte911@wansoft.net, que es del proveedor SaaS (Wansoft) y NO del
//   comercio: reclamarle a él sería reclamarle al destinatario equivocado. Por
//   eso el ticket_vencido de este portal sale SIN email_contacto y lo dice.
const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");

const ORIGEN = "https://www.wansoft.net";
const BUZON = process.env.IMAP_USER || "buzonfacturas@serviciosga.site";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Un código de menos de estos dígitos se considera "folio corto" (el 78 del
// #361) y manda al flujo B. NO CONFIRMADO: es la mejor regla disponible con lo
// que se vio, y por eso existe el fallback A→B.
const UMBRAL_CODIGO_LARGO = 8;
const MAX_DIF_MONTO = 1; // pesos de tolerancia al cruzar portal vs ticket

// tz por sucursal: el corte de "mes en curso" es local y Railway corre en UTC.
// El día 1 a las 00:30 UTC en Mazatlán todavía es el último día del mes pasado.
const SUCURSALES = [
  {
    sid: "7786",
    nombre: "SUPER VOY SALA DE ESPERA",
    ciudad: "Mazatlán",
    tz: "America/Mazatlan",
    landing: `${ORIGEN}/losSenderosMazatlan/Fe.html`,
    slug: "losSenderosMazatlan",
    patrones: [/SALA\s*DE\s*ESPERA/, /MAZATLAN/],
  },
  {
    sid: "7780",
    nombre: "SUPER VOY 1",
    ciudad: "Durango",
    tz: "America/Monterrey",
    landing: `${ORIGEN}/LosSenderosDurango/FE.html`,
    slug: "LosSenderosDurango",
    patrones: [/SUPER\s*VOY\s*1(?!\d)/, /DURANGO/],
  },
  {
    sid: "7764",
    nombre: "SUPER VOY D PICNIKS",
    ciudad: "Torreón",
    tz: "America/Monterrey",
    landing: `${ORIGEN}/LosSenderosTorreon/FE.html`,
    slug: "LosSenderosTorreon",
    patrones: [/PICNIK/, /SUPER\s*VOY\s*D(?!\w)/, /TORREON/],
  },
];

const FORMAS_PAGO = { tarjeta: "28", debito: "28", credito: "04", efectivo: "01", transferencia: "03" };

const URL_FORM_CODIGO = (sid) => `${ORIGEN}/Wansoft.Web/Public/ElectronicInvoice?sid=${sid}`;
const URL_FORM_SIN_CODIGO = (sid) => `${ORIGEN}/Wansoft.Web/Public/ElectronicInvoice40?sid=${sid}&hasCode=false`;

// Selectores del bloque fiscal. Se listan id Y name porque en ASP.NET MVC el id
// se genera a partir del name y basta un cambio de helper para que uno de los
// dos deje de existir; querySelector se queda con el primero que encuentre.
const SEL = {
  codigo:  "#BillingCode, [name='BillingCode']",
  rfc:     "#rfc, [name='rfc'], [name='Rfc']",
  razon:   "#legalName, [name='legalName'], [name='LegalName']",
  email:   "#email, [name='email'], [name='Email']",
  cp:      "#CP, [name='CP'], [name='cp']",
  regimen: "#receiverFiscalRegime, [name='receiverFiscalRegime'], [name='ReceiverFiscalRegime']",
  uso:     "#ReceiverCfdiUse, [name='ReceiverCfdiUse'], [name='receiverCfdiUse']",
  forma:   "#formOfPayment, [name='formOfPayment'], [name='FormOfPayment']",
  sid:     "#subsidiaryId, [name='subsidiaryId'], [name='SubsidiaryId']",
};

// ── Helpers puros (sin navegador) ───────────────────────────────────────────
const p2 = (n) => String(n).padStart(2, "0");
const normalizar = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
const soloAlfa = (s) => normalizar(s).replace(/[^A-Z0-9]/g, "");
const num = (v) => {
  if (v === undefined || v === null || v === "") return null;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
};

// OCR mexicano: DD/MM/AAAA. Si el día es <= 12 la fecha es ambigua y no hay
// forma de desempatarla desde aquí; se asume DD/MM porque es lo que imprimen
// los tickets de este país.
function aIsoFecha(v) {
  if (!v) return null;
  if (v instanceof Date && !isNaN(v)) return `${v.getFullYear()}-${p2(v.getMonth() + 1)}-${p2(v.getDate())}`;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return `${m[1]}-${p2(m[2])}-${p2(m[3])}`;
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (m) {
    let anio = m[3];
    if (anio.length === 2) anio = String(2000 + Number(anio));
    return `${anio}-${p2(m[2])}-${p2(m[1])}`;
  }
  return null;
}

function hoyEn(tz) {
  try {
    return new Date().toLocaleDateString("en-CA", { timeZone: tz }); // YYYY-MM-DD
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

// Resuelve la sucursal con tres señales, de más fiable a menos:
//   1. sid explícito en los datos
//   2. slug del portalUrl NORMALIZADO (sin barras ni mayúsculas: así la URL
//      rota del #370 ".../LosSenderos/Torreon/FE.html" sigue casando)
//   3. texto del comercio / sucursal / OCR
// Si (2) y (3) se contradicen, ABORTA: el sid decide qué sucursal emite el CFDI
// y equivocarla es emitir una factura del emisor equivocado.
function resolverSucursal(datos) {
  const sidExplicito = String(datos.sid || datos.subsidiaryId || "").replace(/\D/g, "");
  if (sidExplicito) {
    const s = SUCURSALES.find((x) => x.sid === sidExplicito);
    if (s) return { sucursal: s, via: "sid explícito" };
    return { error: `el sid ${sidExplicito} no está en la tabla de sucursales conocidas (${SUCURSALES.map((x) => x.sid).join(", ")})` };
  }

  const url = soloAlfa(datos.portalUrl || datos.portal_url || datos.urlEstacion || "");
  const porUrl = url ? SUCURSALES.find((s) => url.includes(soloAlfa(s.slug))) : null;

  const texto = normalizar(
    [datos.comercio, datos.sucursal, datos.estacion, datos.nombreComercio, datos.ocr_text].filter(Boolean).join(" | ")
  );
  const porTexto = SUCURSALES.filter((s) => s.patrones.some((p) => p.test(texto)));

  if (porUrl && porTexto.length === 1 && porTexto[0].sid !== porUrl.sid) {
    return {
      error: `la URL del ticket apunta a ${porUrl.nombre} (sid ${porUrl.sid}) pero el comercio dice ${porTexto[0].nombre} (sid ${porTexto[0].sid}). No se factura con señales contradictorias: el sid decide qué sucursal emite el CFDI.`,
    };
  }
  if (porUrl) return { sucursal: porUrl, via: "slug del portalUrl" };
  if (porTexto.length === 1) return { sucursal: porTexto[0], via: "texto del comercio" };
  if (porTexto.length > 1) {
    return { error: `el comercio casa con varias sucursales a la vez (${porTexto.map((s) => s.nombre).join(" / ")}) y no se puede decidir cuál emite` };
  }
  return {
    error: `no se pudo identificar la sucursal de Wansoft a partir de "${datos.comercio || "(sin comercio)"}" ni de la URL "${datos.portalUrl || "(sin URL)"}". Conocidas: ${SUCURSALES.map((s) => `${s.nombre} (${s.ciudad}, sid ${s.sid})`).join("; ")}`,
  };
}

function montoDeTexto(t) {
  const m = String(t || "").match(/total(?:\s*a\s*facturar)?\s*:?\s*\$?\s*([\d,]+\.\d{2})/i);
  return m ? num(m[1]) : null;
}

// Recorre el JSON del AJAX buscando el importe. Prioriza las claves más
// "total" para no quedarse con un subtotal o con el IVA por accidente.
function montoDeObjeto(obj) {
  if (!obj || typeof obj !== "object") return null;
  const candidatos = [];
  const recorrer = (o, d) => {
    if (!o || typeof o !== "object" || d > 4) return;
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === "object") { recorrer(v, d + 1); continue; }
      const n = num(v);
      if (n === null || n <= 0) continue;
      if (/^total$/i.test(k)) candidatos.push({ prioridad: 0, clave: k, valor: n });
      else if (/total/i.test(k) && !/subtotal|tax|iva|tip|propina/i.test(k)) candidatos.push({ prioridad: 1, clave: k, valor: n });
      else if (/amount|importe|monto/i.test(k)) candidatos.push({ prioridad: 2, clave: k, valor: n });
    }
  };
  recorrer(obj, 0);
  if (!candidatos.length) return null;
  candidatos.sort((a, b) => a.prioridad - b.prioridad);
  return candidatos[0];
}

// ── CapSolver: Cloudflare Turnstile ─────────────────────────────────────────
// Mismo camino que homedepot.js (AntiTurnstileTaskProxyLess). Sólo se usa si el
// widget aparece DE VERDAD con sitekey; el reconocimiento sugiere que aquí está
// inerte, pero eso NO está confirmado.
async function resolverTurnstile(websiteURL, websiteKey) {
  const apiKey = process.env.CAPSOLVER_API_KEY;
  if (!apiKey) throw new Error("CAPSOLVER_API_KEY no definida");
  const c = await fetch("https://api.capsolver.com/createTask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey: apiKey, task: { type: "AntiTurnstileTaskProxyLess", websiteURL, websiteKey } }),
  }).then((r) => r.json());
  if (c.errorId) throw new Error(`CapSolver create: ${c.errorCode || c.errorDescription}`);
  if (!c.taskId) throw new Error("CapSolver: no devolvió taskId");
  for (let i = 0; i < 30; i++) {
    await sleep(2500);
    const res = await fetch("https://api.capsolver.com/getTaskResult", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: apiKey, taskId: c.taskId }),
    }).then((r) => r.json());
    if (res.status === "ready") {
      const token = res.solution && res.solution.token;
      if (!token) throw new Error("CapSolver: ready pero sin token");
      return token;
    }
    if (res.errorId) throw new Error(`CapSolver result: ${res.errorCode || res.errorDescription}`);
  }
  throw new Error("CapSolver: timeout 75s esperando el token de Turnstile");
}

async function facturarWansoft(datos = {}) {
  // ── 0. Validación ANTES de abrir el navegador ─────────────────────────────
  const rfc = String(datos.rfc || "").trim().toUpperCase();
  const razonSocial = String(datos.razonSocial || datos.nombreFiscal || datos.legalName || "").trim();
  const codigoPostal = String(datos.codigoPostal || datos.cp || "").replace(/\D/g, "").slice(0, 5);
  const regimenFiscal = String(datos.regimenFiscal || "601").replace(/\D/g, "");
  const usoCfdi = String(datos.usoCfdi || "G03").trim().toUpperCase();
  const formaPago = FORMAS_PAGO[String(datos.formaPago || "tarjeta").toLowerCase()] || "28";
  // ⚠️ SIEMPRE el buzón de captura, NUNCA el correo del residente: si el CFDI
  // va a otro lado, la factura se emite y el ticket se queda esperando para
  // siempre (pasó con Casa Ley y La Parisina).
  const emailEntrega = String(datos.emailEntrega || BUZON).trim();
  const total = num(datos.total !== undefined && datos.total !== null ? datos.total : (datos.importe !== undefined && datos.importe !== null ? datos.importe : datos.monto));
  const propina = num(datos.propina) === null ? 0 : num(datos.propina);
  const ticketId = datos.ticketId;

  const codigo = String(
    datos.billingCode || datos.codigo || datos.codigoTicket || datos.referencia || datos.folio || ""
  ).replace(/\D/g, "");
  const orden = String(
    datos.orden || datos.numeroOrden || datos.folio || datos.numeroTicket || datos.codigoTicket || ""
  ).replace(/\D/g, "");
  const fechaIso = aIsoFecha(datos.fecha || datos.fechaPago || datos.fechaCompra);

  const resuelta = resolverSucursal(datos);
  if (resuelta.error) {
    return { ok: false, error_code: "datos_invalidos", msg: `Wansoft: ${resuelta.error}` };
  }
  const sucursal = resuelta.sucursal;

  const faltan = [];
  if (!rfc) faltan.push("RFC del receptor");
  if (!razonSocial) faltan.push("razón social del receptor (el portal la pide aparte, no la deduce del RFC)");
  if (!codigoPostal) faltan.push("código postal fiscal del receptor (obligatorio en CFDI 4.0)");
  if (total === null) faltan.push("total del ticket (sin él no se puede cruzar el monto contra el portal)");
  if (faltan.length) {
    return { ok: false, error_code: "datos_invalidos", msg: `Wansoft (${sucursal.nombre}): faltan datos — ${faltan.join(", ")}` };
  }

  // Flujo A si el código es "largo"; si no, flujo B (que necesita fecha+orden).
  const flujoBCompleto = !!(fechaIso && orden && total !== null);
  let modo = codigo.length >= UMBRAL_CODIGO_LARGO ? "A" : "B";
  if (modo === "B" && !flujoBCompleto) {
    if (codigo) {
      // Código corto pero sin datos para el flujo sin código: se intenta A de
      // todos modos antes de rendirse. Peor es no intentarlo.
      modo = "A";
    } else {
      const quefalta = [!fechaIso && "fecha del ticket", !orden && "número de orden", total === null && "total"].filter(Boolean).join(", ");
      return {
        ok: false,
        error_code: "datos_invalidos",
        msg: `Wansoft (${sucursal.nombre}): sin código de facturación y sin los datos del flujo sin código — faltan ${quefalta}`,
      };
    }
  }

  // PLAZO: sólo dentro del mes en curso (texto literal del portal).
  if (fechaIso) {
    const mesTicket = fechaIso.slice(0, 7);
    const hoy = hoyEn(sucursal.tz);
    const mesHoy = hoy.slice(0, 7);
    if (mesTicket < mesHoy) {
      return {
        ok: false,
        error_code: "ticket_vencido",
        // Sin email_contacto A PROPÓSITO: ver cabecera. El único correo público
        // es el del proveedor SaaS (Wansoft), no el del emisor (Los Senderos).
        msg: `Wansoft (${sucursal.nombre}): el ticket es del ${fechaIso} y el portal sólo factura dentro del MES EN CURSO (hoy ${hoy}). No hay correo de facturación publicado de Los Senderos S.A. de C.V. — los campos AutoemissionEmail/Phone del portal vienen vacíos — así que la factura hay que pedirla en la tienda; soporte911@wansoft.net es del proveedor del software, NO del emisor, y escribirle sería reclamarle al destinatario equivocado.`,
      };
    }
    if (mesTicket > mesHoy) {
      return { ok: false, error_code: "datos_invalidos", msg: `Wansoft (${sucursal.nombre}): la fecha leída del ticket (${fechaIso}) está en el futuro — casi seguro es un error de OCR` };
    }
  }

  console.log("🤖 Iniciando bot Wansoft...");
  console.log(`   Sucursal: ${sucursal.nombre} (${sucursal.ciudad}) sid ${sucursal.sid} — resuelta por ${resuelta.via}`);
  console.log(`   Flujo ${modo} | código: ${codigo || "(ninguno)"} | orden: ${orden || "-"} | fecha: ${fechaIso || "-"} | total: $${total}`);
  console.log(`   RFC ${rfc} | CP ${codigoPostal} | régimen ${regimenFiscal} | uso ${usoCfdi} | forma de pago ${formaPago}`);
  console.log(`   CFDI al buzón de captura: ${emailEntrega}`);

  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error("BROWSERLESS_TOKEN no definido");
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true`,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 1100 });
  await page.setDefaultNavigationTimeout(60000);
  await page.setExtraHTTPHeaders({ "Accept-Language": "es-MX,es;q=0.9,en;q=0.8" });
  // Obligatorio: un alert() sin manejar hace que Browserless mate la pestaña.
  page.on("dialog", async (d) => { await d.accept().catch(() => {}); });

  // Escuchas de red: el JSON del AJAX sirve para cruzar el monto, y si el
  // portal llega a servir el XML/PDF como respuesta HTTP normal, se captura.
  let billingInfo = null;
  let xmlBuf = null;
  let pdfBuf = null;
  page.on("response", async (resp) => {
    try {
      const u = resp.url();
      const ct = (resp.headers()["content-type"] || "").toLowerCase();
      const cd = (resp.headers()["content-disposition"] || "").toLowerCase();
      if (/GetBillingInformation/i.test(u)) {
        const txt = await resp.text();
        try { billingInfo = JSON.parse(txt); } catch { billingInfo = { _texto: txt.slice(0, 4000) }; }
        return;
      }
      if (/xml/.test(ct) || /\.xml/.test(cd)) {
        const b = await resp.buffer();
        if (b && /<cfdi:Comprobante|<Comprobante/i.test(b.toString("utf8").slice(0, 3000))) xmlBuf = b;
        return;
      }
      if (/pdf/.test(ct) || /\.pdf/.test(cd)) {
        const b = await resp.buffer();
        if (b && b.length > 800) pdfBuf = b;
      }
    } catch {}
  });

  const ts = ticketId || Date.now();
  async function screenshot(label) {
    try {
      const buf = await page.screenshot({ fullPage: true });
      const u = await subirArchivoR2(buf, `debug/wansoft_${ts}_${label}_${Date.now()}.png`, "image/png");
      console.log(`📸 [${label}]: ${u}`);
      return u;
    } catch { return null; }
  }
  // Devuelve "" si la página está navegando justo en ese instante, en vez de
  // tirar el bot entero con "Execution context was destroyed".
  const texto = () => page.evaluate(() => document.body.innerText.replace(/\s+/g, " ")).catch(() => "");
  const existe = (sel) => page.evaluate((s) => !!document.querySelector(s), sel).catch(() => false);
  const valor = (sel) => page.evaluate((s) => { const e = document.querySelector(s); return e ? e.value : null; }, sel).catch(() => null);

  // Escribe TECLEANDO DE VERDAD (click + keyboard.type). Poner .value a pelo no
  // basta en muchos frameworks: el valor SE VE en pantalla pero el framework
  // cree que el campo está vacío. Si el tecleo no cuaja (campo readonly o
  // enmascarado), cae al setter nativo + eventos y vuelve a releer.
  async function escribir(sel, v, opciones) {
    const quitarReadonly = !!(opciones && opciones.quitarReadonly);
    const valorStr = String(v);
    const handle = await page.$(sel);
    if (!handle) return { ok: false, motivo: "no existe el campo", leido: null };
    if (quitarReadonly) {
      await page.evaluate((s) => {
        const e = document.querySelector(s);
        if (e) { e.removeAttribute("readonly"); e.readOnly = false; e.removeAttribute("disabled"); e.disabled = false; }
      }, sel).catch(() => {});
    }
    try {
      await handle.click({ clickCount: 3 });
      await page.keyboard.type(valorStr, { delay: 35 });
    } catch {}
    let leido = await valor(sel);
    if (String(leido || "").trim() !== valorStr.trim()) {
      await page.evaluate((s, val) => {
        const e = document.querySelector(s);
        if (!e) return;
        try {
          const proto = e.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
          setter.call(e, val);
        } catch (x) { e.value = val; }
        e.dispatchEvent(new Event("input", { bubbles: true }));
        e.dispatchEvent(new Event("change", { bubbles: true }));
        try {
          if (window.jQuery) {
            const $e = window.jQuery(e);
            if ($e.datepicker) { try { $e.datepicker("setDate", val); } catch (x) {} }
            $e.trigger("input").trigger("change");
          }
        } catch (x) {}
        e.dispatchEvent(new Event("blur", { bubbles: true }));
      }, sel, valorStr).catch(() => {});
      leido = await valor(sel);
    }
    return { ok: String(leido || "").trim() !== "", leido };
  }

  // Elige por VALUE exacto y, si no, por texto. Devuelve el inventario cuando
  // no encuentra nada, para que el mensaje de error sirva de algo.
  async function elegirOpcion(sel, valorSat, patronTexto) {
    return page.evaluate((s, v, p) => {
      const el = document.querySelector(s);
      if (!el) return { ok: false, motivo: "no existe el select" };
      const opciones = Array.from(el.options || []);
      if (opciones.length <= 1) return { ok: false, motivo: "el select sigue vacío" };
      let o = opciones.find((x) => String(x.value).trim() === String(v));
      if (!o) o = opciones.find((x) => new RegExp("^\\s*" + v + "\\b").test(x.text));
      if (!o && p) o = opciones.find((x) => new RegExp(p, "i").test(x.text));
      if (!o) return { ok: false, motivo: "sin opción que case", inventario: opciones.slice(0, 30).map((x) => (x.value + "=" + x.text).slice(0, 60)) };
      el.value = o.value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      try { if (window.jQuery) window.jQuery(el).trigger("change"); } catch (x) {}
      return { ok: true, texto: o.text, value: o.value };
    }, sel, valorSat, patronTexto || null).catch((e) => ({ ok: false, motivo: e.message }));
  }

  // Trampa 1: los <select> llegan vacíos y los puebla el AJAX. Hay que esperar.
  async function esperarSelectsPoblados(maxMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      const n = await page.evaluate((s) => {
        const el = document.querySelector(s);
        return el && el.options ? el.options.length : 0;
      }, SEL.regimen).catch(() => 0);
      if (n > 1) return true;
      await sleep(1500);
    }
    return false;
  }

  // Trampa "no confirmada": Turnstile. Devuelve null si el widget está inerte
  // (que es lo que sugiere el reconocimiento) y los datos del reto si aparece.
  async function detectarTurnstile() {
    return page.evaluate(() => {
      const div = document.querySelector(".cf-turnstile, [data-sitekey][class*='turnstile']");
      const iframe = document.querySelector("iframe[src*='challenges.cloudflare.com']");
      const campo = document.querySelector("input[name='cf-turnstile-response']");
      let sitekey = (div && (div.getAttribute("data-sitekey") || div.dataset.sitekey)) || null;
      if (!sitekey && iframe) {
        try { sitekey = new URL(iframe.src, location.href).searchParams.get("sitekey"); } catch (e) {}
      }
      const interstitial = /just a moment|verifying you are human|attention required|checking your browser/i.test(document.body.innerText || "");
      if (!iframe && !sitekey && !interstitial) return null;
      return { sitekey: sitekey || null, tieneIframe: !!iframe, tieneCampo: !!campo, interstitial };
    }).catch(() => null);
  }

  // Devuelve null si se pudo seguir; si no, el resultado de error ya armado.
  async function atenderTurnstile(etapa) {
    const reto = await detectarTurnstile();
    if (!reto) return null;
    console.log(`🛡️ Turnstile ACTIVO en ${etapa}: ${JSON.stringify(reto)}`);
    const shot = await screenshot(`turnstile_${etapa}`);
    if (reto.sitekey && process.env.CAPSOLVER_API_KEY) {
      try {
        const t = await resolverTurnstile(`${ORIGEN}/`, reto.sitekey);
        await page.evaluate((tok) => {
          document
            .querySelectorAll("input[name='cf-turnstile-response'], #cf-turnstile-response, textarea[name='g-recaptcha-response']")
            .forEach((el) => { el.value = tok; });
        }, t);
        console.log("🔓 Turnstile resuelto por CapSolver e inyectado");
        return null;
      } catch (e) {
        console.log(`   ⚠️ CapSolver no pudo con el Turnstile: ${e.message}`);
      }
    }
    return {
      ok: false,
      error_code: "captcha",
      msg: `Wansoft (${sucursal.nombre}): apareció un reto de Cloudflare Turnstile en ${etapa}${reto.sitekey ? ` (sitekey ${reto.sitekey})` : " sin sitekey legible"} y no se pudo resolver. El reconocimiento lo daba por inerte, así que esto es nuevo: hay que facturar a mano en ${URL_FORM_CODIGO(sucursal.sid)}${shot ? ` — captura: ${shot}` : ""}`,
    };
  }

  // Localiza un campo del flujo B por heurística y lo deja marcado con
  // data-wansoft-campo para poder referenciarlo después. Primero busca por
  // señales fuertes (id/name/placeholder/aria-label) y sólo después mira el
  // label y el texto del contenedor, que es donde "Total del ticket" y "Total a
  // facturar" se pisan entre sí.
  async function descubrirCampo(marca, patrones) {
    const res = await page.evaluate((cfg) => {
      const visibles = Array.from(document.querySelectorAll("input, textarea")).filter((el) => {
        const t = (el.type || "").toLowerCase();
        if (["hidden", "submit", "button", "checkbox", "radio", "file"].indexOf(t) !== -1) return false;
        if (el.getAttribute("data-wansoft-campo")) return false;
        return el.offsetParent !== null || el.readOnly;
      });
      const fuerte = (el) => [el.id, el.name, el.placeholder, el.getAttribute("aria-label") || ""].join(" | ");
      const debil = (el) => {
        const partes = [];
        if (el.id) {
          try { const l = document.querySelector("label[for='" + CSS.escape(el.id) + "']"); if (l) partes.push(l.innerText); } catch (e) {}
        }
        const cont = el.closest(".form-group, .form-floating, .mb-3, td, .col, .row");
        if (cont) partes.push((cont.innerText || "").slice(0, 140));
        return partes.join(" | ");
      };
      for (const estricto of [true, false]) {
        for (const patron of cfg.patrones) {
          const re = new RegExp(patron, "i");
          for (const el of visibles) {
            if (el.getAttribute("data-wansoft-campo")) continue;
            const heno = estricto ? fuerte(el) : fuerte(el) + " | " + debil(el);
            if (re.test(heno)) {
              el.setAttribute("data-wansoft-campo", cfg.marca);
              return { ok: true, id: el.id || null, name: el.name || null, readOnly: !!el.readOnly, patron, estricto };
            }
          }
        }
      }
      return {
        ok: false,
        inventario: visibles.slice(0, 25).map((e) => (e.id || e.name || "?") + (e.placeholder ? ` ph:"${e.placeholder}"` : "") + (e.readOnly ? " [readonly]" : "")),
      };
    }, { marca, patrones: patrones.map((p) => p.source) }).catch((e) => ({ ok: false, inventario: [`(error leyendo el DOM: ${e.message})`] }));
    if (res.ok) console.log(`   ↳ campo "${marca}" = ${res.id || res.name} (${res.estricto ? "id/name" : "label"}, patrón ${res.patron})`);
    return res;
  }
  const selCampo = (marca) => `[data-wansoft-campo="${marca}"]`;

  let enviado = false; // ⚠️ true en cuanto sale el click de "Generar"
  let dosier = "";

  try {
    // ── 1. Landing FE.html → botón de la sucursal ───────────────────────────
    // El portalUrl del ticket nunca es el formulario. Se abre el landing
    // CANÓNICO de la tabla (no el del ticket: el del #370 está mal escrito) y se
    // casa el texto del botón contra el nombre de la sucursal.
    console.log(`🌐 Abriendo landing ${sucursal.landing}...`);
    await page.goto(sucursal.landing, { waitUntil: "networkidle2", timeout: 60000 });
    await sleep(1500);
    const retoLanding = await atenderTurnstile("landing");
    if (retoLanding) { await browser.close(); return retoLanding; }

    const textoLanding = await texto();
    // ⚠️ El "404 NOT FOUND" de Wansoft VIENE CON HTTP 200: hay que mirar el
    // contenido, no el status.
    const landing404 = /404|not\s*found|p[aá]gina no encontrada/i.test(textoLanding) && textoLanding.length < 1200;
    if (landing404) console.log("   ⚠️ El landing devolvió la página 404 de Wansoft (con HTTP 200) — se irá directo al formulario por sid");

    let urlFormulario = null;
    if (!landing404) {
      const boton = await page.evaluate((cfg) => {
        const candidatos = Array.from(document.querySelectorAll("a, button, input[type=button], input[type=submit], [onclick]"));
        const rx = cfg.patrones.map((p) => new RegExp(p, "i"));
        for (const el of candidatos) {
          const crudo = el.innerText || el.value || el.getAttribute("alt") || el.getAttribute("title") || "";
          const t = crudo.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
          if (!t.trim()) continue;
          if (!rx.some((r) => r.test(t))) continue;
          el.removeAttribute("target"); // que no se abra en pestaña nueva
          el.setAttribute("data-wansoft-sucursal", "1");
          const href = el.getAttribute("href") || "";
          const onclick = el.getAttribute("onclick") || "";
          const mSid = (href + " " + onclick).match(/sid=(\d+)/i);
          let abs = null;
          if (href && !/^#|^javascript:/i.test(href)) { try { abs = new URL(href, location.href).href; } catch (e) {} }
          return { texto: t.trim().slice(0, 80), href: abs, sid: mSid ? mSid[1] : null };
        }
        return null;
      }, { patrones: sucursal.patrones.map((p) => p.source) }).catch(() => null);

      if (!boton) {
        console.log("   ⚠️ No se encontró el botón de la sucursal en el landing — se irá directo al formulario por sid");
        await screenshot("landing_sin_boton");
      } else {
        console.log(`   Botón: "${boton.texto}"${boton.sid ? ` (sid ${boton.sid})` : ""}`);
        // Si el landing declara un sid distinto al de la tabla, NO se adivina:
        // el sid decide qué sucursal emite el CFDI.
        if (boton.sid && boton.sid !== sucursal.sid) {
          await screenshot("sid_discrepante");
          await browser.close();
          return {
            ok: false,
            error_code: "datos_invalidos",
            msg: `Wansoft: el landing de ${sucursal.nombre} ofrece el sid ${boton.sid} pero la tabla del bot dice ${sucursal.sid}. Wansoft pudo renumerar las sucursales; hay que verificarlo en vivo antes de timbrar, porque el sid determina el emisor del CFDI.`,
          };
        }
        urlFormulario = boton.href;
      }
      await screenshot("p1_landing");
    }

    // ── 2. Formulario ───────────────────────────────────────────────────────
    // Se navega SIEMPRE a la URL del modo elegido: el botón del landing lleva al
    // flujo con código y el flujo sin código vive en otra ruta.
    async function abrirFormulario(m) {
      const url = m === "A" ? (urlFormulario || URL_FORM_CODIGO(sucursal.sid)) : URL_FORM_SIN_CODIGO(sucursal.sid);
      console.log(`📄 Formulario (flujo ${m}): ${url}`);
      await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
      await sleep(2000);
      if (!(await existe(SEL.rfc))) return { ok: false, motivo: `el formulario de ${url} no trae el campo RFC` };
      // Cruce de identidad: el hidden subsidiaryId debe ser el de la sucursal, y
      // en la pantalla no debe aparecer el nombre de OTRA sucursal conocida.
      const sidEnForm = String((await valor(SEL.sid)) || "").replace(/\D/g, "");
      if (sidEnForm && sidEnForm !== sucursal.sid) {
        return { ok: false, motivo: `el formulario cargó con subsidiaryId ${sidEnForm} y se esperaba ${sucursal.sid}` };
      }
      const t = normalizar(await texto());
      const otra = SUCURSALES.find((s) => s.sid !== sucursal.sid && s.patrones.some((p) => p.test(t)));
      if (otra) return { ok: false, motivo: `el formulario muestra la sucursal ${otra.nombre} y se esperaba ${sucursal.nombre}` };
      return { ok: true };
    }

    let abierto = await abrirFormulario(modo);
    if (!abierto.ok) {
      await screenshot("formulario_no_cargo");
      await browser.close();
      return { ok: false, error_code: "reintentar_despues", msg: `Wansoft (${sucursal.nombre}): ${abierto.motivo}. No se escribe nada a ciegas cuando no se puede confirmar la sucursal.` };
    }
    const retoForm = await atenderTurnstile("formulario");
    if (retoForm) { await browser.close(); return retoForm; }
    await screenshot("p2_formulario");

    // ── 3. Identificar el ticket (flujo A o flujo B) ────────────────────────
    // Devuelve {ok} | {error_code, msg} | {caerAFlujoB:true, motivo}
    async function cargarTicketFlujoA() {
      if (!(await existe(SEL.codigo))) {
        return { caerAFlujoB: true, motivo: "el formulario no trae el campo BillingCode" };
      }
      console.log(`🎫 Flujo A — validando código ${codigo}...`);
      const esc = await escribir(SEL.codigo, codigo);
      if (!esc.ok) return { error_code: "reintentar_despues", msg: "no se pudo escribir el código de facturación en el formulario" };
      await page.keyboard.press("Tab").catch(() => {}); // el blur suele disparar el AJAX
      await sleep(2500);

      // Si el blur no disparó nada, se busca un botón de VALIDAR/BUSCAR. A
      // propósito NO se pulsan "Continuar"/"Siguiente"/"Facturar": ésos podrían
      // enviar el formulario entero antes de tiempo, y un submit prematuro en
      // este portal es justo lo que no se quiere.
      if (!billingInfo && !(await esperarSelectsPoblados(4000))) {
        const pulsado = await page.evaluate(() => {
          const cand = Array.from(document.querySelectorAll("button, input[type=button], a[onclick], span[onclick]"));
          const b = cand.find((x) => /^(buscar|validar|consultar|verificar)\b/i.test((x.innerText || x.value || "").trim()));
          if (!b) return null;
          if ((b.type || "").toLowerCase() === "submit") return "submit_evitado";
          b.click();
          return (b.innerText || b.value || "").trim();
        }).catch(() => null);
        if (pulsado === "submit_evitado") console.log("   ⚠️ El botón de validación era type=submit — no se pulsa para no enviar el formulario antes de tiempo");
        else if (pulsado) console.log(`   Botón de validación: "${pulsado}"`);
      }

      const poblados = await esperarSelectsPoblados(35000);
      const t = await texto();
      await screenshot("p3a_post_codigo");

      if (/ya (fue |ha sido |se )?factur|previamente factur|cuenta con factura|existe una factura/i.test(t)) {
        return { error_code: "ya_facturado", msg: `el portal dice que el ticket (código ${codigo}) ya fue facturado` };
      }
      if (/mes en curso|fuera de(l)? (plazo|mes)|vencid|caduc|fecha l[ií]mite|ya no (es posible|se puede) facturar/i.test(t)) {
        return { error_code: "ticket_vencido", msg: "el portal rechaza el ticket por plazo (sólo se factura dentro del mes en curso)" };
      }
      if (!poblados) {
        if (/no (se )?(encontr|existe)|inv[aá]lid|incorrect|no coincide|sin resultados/i.test(t)) {
          return { caerAFlujoB: true, motivo: `el portal no reconoció el código ${codigo}` };
        }
        if (/error|intente (m[aá]s tarde|de nuevo)|no disponible|mantenimiento/i.test(t)) {
          return { error_code: "reintentar_despues", msg: `el portal respondió con un error propio al validar el código ${codigo}. Pantalla: ${t.slice(0, 200)}` };
        }
        return { caerAFlujoB: true, motivo: `los catálogos (régimen/uso/forma de pago) nunca se poblaron tras enviar el código ${codigo}` };
      }
      console.log("   ✔ Código aceptado (los catálogos se poblaron)");
      return { ok: true };
    }

    async function cargarTicketFlujoB() {
      console.log(`🎫 Flujo B — fecha ${fechaIso}, orden ${orden}, total $${total}, propina $${propina}...`);
      const cFecha = await descubrirCampo("fecha", [/fecha|fchticket|ticketdate|^date/, /datepicker/]);
      const cTotalFact = await descubrirCampo("totalFacturar", [/(total).*(factur|invoice)|(factur|invoice).*(total)|amounttoinvoice/]);
      const cTotalTicket = await descubrirCampo("totalTicket", [/(total).*(ticket|check|cuenta)|(ticket|check).*(total)|checktotal|^total$/]);
      const cPropina = await descubrirCampo("propina", [/propina|tip\b|gratuity/]);
      const cOrden = await descubrirCampo("orden", [/orden|order|folio|cuenta|check(?!total)|ticketnumber/]);

      const faltantes = [];
      if (!cFecha.ok) faltantes.push("fecha");
      if (!cOrden.ok) faltantes.push("orden");
      if (!cTotalTicket.ok) faltantes.push("total del ticket");
      if (faltantes.length) {
        const inv = (cFecha.inventario || cOrden.inventario || cTotalTicket.inventario || []).join(" · ");
        await screenshot("flujo_b_sin_campos");
        return {
          error_code: "reintentar_despues",
          msg: `no se localizaron los campos del flujo sin código (${faltantes.join(", ")}) — los ids de este flujo NO estaban confirmados en el reconocimiento y hay que verificarlos en vivo antes de volver a intentarlo. Inputs vistos: ${inv}`,
        };
      }

      // Trampa 2: el datepicker es READONLY. Se le quita el readonly, se escribe
      // con el setter nativo, se avisa a jQuery UI si está, y SE RELEE.
      const escFecha = await escribir(selCampo("fecha"), fechaIso, { quitarReadonly: true });
      if (!escFecha.ok) {
        await screenshot("fecha_no_entro");
        return { error_code: "reintentar_despues", msg: `el datepicker readonly no aceptó la fecha ${fechaIso} (quedó "${escFecha.leido}")` };
      }
      const leida = String(escFecha.leido || "");
      const dia = fechaIso.slice(8, 10);
      const anio = fechaIso.slice(0, 4);
      if (leida !== fechaIso && !(leida.includes(dia) && leida.includes(anio))) {
        await screenshot("fecha_reformateada");
        return { error_code: "reintentar_despues", msg: `el datepicker dejó la fecha como "${leida}" y se pidió ${fechaIso}: no coinciden ni el día ni el año, así que no se sigue — facturar con otra fecha buscaría otro ticket` };
      }
      if (leida !== fechaIso) console.log(`   ⚠️ El datepicker reformateó la fecha a "${leida}" (se pidió ${fechaIso}) — día y año cuadran, se continúa`);

      await escribir(selCampo("orden"), orden);
      const totalFacturar = Math.round((total - propina) * 100) / 100;
      await escribir(selCampo("totalTicket"), total.toFixed(2));
      // "Total a facturar" va sin propina: la propina no se factura. Con
      // propina 0 (el caso normal) los dos importes son el mismo.
      if (cTotalFact.ok) await escribir(selCampo("totalFacturar"), totalFacturar.toFixed(2));
      if (cPropina.ok) await escribir(selCampo("propina"), propina.toFixed(2));
      await page.keyboard.press("Tab").catch(() => {});
      await sleep(2500);

      const poblados = await esperarSelectsPoblados(35000);
      const t = await texto();
      await screenshot("p3b_ticket_lleno");

      if (/ya (fue |ha sido |se )?factur|previamente factur|cuenta con factura/i.test(t)) {
        return { error_code: "ya_facturado", msg: `el portal dice que la orden ${orden} del ${fechaIso} ya fue facturada` };
      }
      if (/mes en curso|fuera de(l)? (plazo|mes)|vencid|caduc|fecha l[ií]mite/i.test(t)) {
        return { error_code: "ticket_vencido", msg: "el portal rechaza el ticket por plazo (sólo se factura dentro del mes en curso)" };
      }
      if (/no (se )?(encontr|existe)|inv[aá]lid|incorrect|no coincide|sin resultados|no hay (ticket|orden)/i.test(t)) {
        return { error_code: "datos_invalidos", msg: `el portal no encontró la orden ${orden} del ${fechaIso} por $${total}. Pantalla: ${t.slice(0, 200)}` };
      }
      if (!poblados) {
        // NO CONFIRMADO: el reconocimiento sólo vio poblarse los catálogos tras
        // validar un CÓDIGO. En el flujo sin código no se sabe qué los dispara.
        return {
          error_code: "reintentar_despues",
          msg: `los catálogos (régimen/uso/forma de pago) siguen vacíos tras llenar el ticket. En el flujo sin código NO está verificado en vivo qué dispara ese AJAX; hay que mirarlo en el portal antes de volver a intentarlo. Pantalla: ${t.slice(0, 200)}`,
        };
      }
      console.log("   ✔ Ticket aceptado (los catálogos se poblaron)");
      return { ok: true };
    }

    let carga = modo === "A" ? await cargarTicketFlujoA() : await cargarTicketFlujoB();
    if (carga.caerAFlujoB) {
      if (!flujoBCompleto) {
        await browser.close();
        return { ok: false, error_code: "datos_invalidos", msg: `Wansoft (${sucursal.nombre}): ${carga.motivo}, y no hay fecha/orden/total para intentar el flujo sin código.` };
      }
      console.log(`   ↩️ ${carga.motivo} — cayendo al flujo sin código`);
      modo = "B";
      abierto = await abrirFormulario("B");
      if (!abierto.ok) {
        await screenshot("formulario_b_no_cargo");
        await browser.close();
        return { ok: false, error_code: "reintentar_despues", msg: `Wansoft (${sucursal.nombre}): ${abierto.motivo} al caer al flujo sin código` };
      }
      const retoB = await atenderTurnstile("formulario_sin_codigo");
      if (retoB) { await browser.close(); return retoB; }
      // Se tira la respuesta del AJAX del intento fallido: si no, el cruce de
      // monto compararía el ticket contra un JSON viejo que ya no describe nada.
      billingInfo = null;
      carga = await cargarTicketFlujoB();
    }
    if (!carga.ok) {
      await browser.close();
      return { ok: false, error_code: carga.error_code || "reintentar_despues", msg: `Wansoft (${sucursal.nombre}): ${carga.msg}` };
    }

    // ── 4. Datos fiscales del receptor ──────────────────────────────────────
    console.log("📋 Llenando datos fiscales...");
    const camposFiscales = [
      [SEL.rfc, rfc, "RFC"],
      [SEL.razon, razonSocial, "razón social"],
      [SEL.cp, codigoPostal, "CP"],
      [SEL.email, emailEntrega, "correo de entrega"],
    ];
    for (const [sel, v, etiqueta] of camposFiscales) {
      const r = await escribir(sel, v);
      if (!r.ok) {
        await screenshot("campo_fiscal_no_entro");
        await browser.close();
        return { ok: false, error_code: "reintentar_despues", msg: `Wansoft (${sucursal.nombre}): no se pudo escribir la ${etiqueta} en el formulario (selector ${sel})` };
      }
    }
    // Comprobación explícita: el CFDI DEBE ir al buzón de captura, no a otro
    // lado. Si se escribiera el correo del residente, la factura se emite y el
    // ticket se queda esperando para siempre.
    const correoEscrito = String((await valor(SEL.email)) || "").trim().toLowerCase();
    if (correoEscrito !== emailEntrega.toLowerCase()) {
      await browser.close();
      return { ok: false, error_code: "reintentar_despues", msg: `Wansoft (${sucursal.nombre}): el campo de correo quedó como "${correoEscrito}" y debía ser el buzón de captura ${emailEntrega}. No se timbra: el CFDI acabaría en un buzón que el sistema no lee.` };
    }

    const selecciones = [
      ["régimen fiscal", SEL.regimen, regimenFiscal, null],
      ["uso de CFDI", SEL.uso, usoCfdi, "gastos en general"],
      ["forma de pago", SEL.forma, formaPago, formaPago === "01" ? "efectivo" : formaPago === "04" ? "cr[eé]dito" : formaPago === "03" ? "transferencia" : "d[eé]bito"],
    ];
    for (const [etiqueta, sel, v, patron] of selecciones) {
      const r = await elegirOpcion(sel, v, patron);
      if (!r.ok) {
        await screenshot("select_sin_opcion");
        await browser.close();
        return {
          ok: false,
          error_code: "datos_invalidos",
          msg: `Wansoft (${sucursal.nombre}): no se pudo elegir ${etiqueta} "${v}" (${r.motivo})${r.inventario ? `. Opciones del portal: ${r.inventario.join(" · ")}` : ""}`,
        };
      }
      console.log(`   ${etiqueta}: ${r.value} — ${r.texto}`);
      await sleep(600);
    }

    // ── 5. CRUCE DEL MONTO antes de timbrar ─────────────────────────────────
    // Emitir un CFDI que no corresponde es peor que no emitirlo.
    const tPrevio = await texto();
    const delAjax = montoDeObjeto(billingInfo);
    const delTexto = montoDeTexto(tPrevio);
    const delCampoFact = num(await valor(selCampo("totalFacturar")));
    const delCampoTicket = num(await valor(selCampo("totalTicket")));
    const delCampo = delCampoFact === null ? delCampoTicket : delCampoFact;
    // Fuentes FUERTES: el JSON del AJAX y el campo del formulario, que hablan
    // de ESTE ticket. La fuente débil es el texto de la pantalla, que puede
    // pescar cualquier "Total 100.00" suelto de un pie de página — por eso sólo
    // decide cuando no hay ninguna fuerte: un falso positivo suyo bloquearía
    // una factura legítima.
    const fuertes = [];
    if (delAjax) fuertes.push({ origen: `AJAX (${delAjax.clave})`, valor: delAjax.valor });
    if (delCampo !== null) fuertes.push({ origen: "campo del formulario", valor: delCampo });
    const debiles = delTexto !== null ? [{ origen: "texto de la pantalla", valor: delTexto }] : [];
    const candidatos = fuertes.length ? fuertes : debiles;
    if (fuertes.length && debiles.length) {
      console.log(`   (informativo) el texto de la pantalla decía $${delTexto}; se decide con las fuentes fuertes`);
    }

    if (!candidatos.length) {
      // No se pudo leer ningún importe del portal. En el flujo B el importe lo
      // escribe el bot (y es el del ticket), así que el riesgo está acotado; aun
      // así queda constancia ruidosa porque este punto NO está verificado.
      console.log(`   ⚠️ No se pudo leer NINGÚN monto del portal para cruzarlo contra los $${total} del ticket (flujo ${modo})`);
      await screenshot("sin_monto_para_cruzar");
      dosier += " | ⚠️ el monto del portal no se pudo leer para cruzarlo";
    } else {
      for (const c of candidatos) {
        if (Math.abs(c.valor - total) > MAX_DIF_MONTO) {
          await screenshot("monto_no_cuadra");
          await browser.close();
          return {
            ok: false,
            error_code: "datos_invalidos",
            msg: `Wansoft (${sucursal.nombre}): el monto del portal ($${c.valor}, leído del ${c.origen}) no coincide con el del ticket ($${total}). No se timbra: sería un CFDI que no corresponde a esta compra.`,
          };
        }
      }
      console.log(`   ✔ Monto verificado: ${candidatos.map((c) => `$${c.valor} (${c.origen})`).join(", ")} ≈ $${total} del ticket`);
    }

    const retoPrevio = await atenderTurnstile("previo_a_generar");
    if (retoPrevio) { await browser.close(); return retoPrevio; }
    await screenshot("p4_previo_generar");

    // ── 6. Generar la factura ───────────────────────────────────────────────
    console.log("🧾 Enviando el formulario (POST GenerateInvoice)...");
    const urlAntes = page.url();
    const marcado = await page.evaluate(() => {
      const form = document.querySelector("form[action*='GenerateInvoice' i]") || document.querySelector("form");
      const dentro = form ? Array.from(form.querySelectorAll("button, input[type=submit], a[onclick]")) : [];
      const todos = dentro.length ? dentro : Array.from(document.querySelectorAll("button, input[type=submit]"));
      const etiqueta = (x) => (x.innerText || x.value || "").trim();
      const esCancelar = (t) => /cancel|regres|volver|limpiar|salir|nueva/i.test(t);
      // Se prefiere el botón que DICE facturar; el submit genérico es el último
      // recurso, para no pulsar un "Continuar" de otro paso por accidente.
      const pasadas = [
        (x) => /factur|generar|emitir|timbrar/i.test(etiqueta(x)),
        (x) => /continuar|siguiente|enviar|aceptar/i.test(etiqueta(x)),
        (x) => (x.type || "").toLowerCase() === "submit",
      ];
      for (const casa of pasadas) {
        const b = todos.find((x) => !esCancelar(etiqueta(x)) && casa(x));
        if (b) {
          b.setAttribute("data-wansoft-submit", "1");
          return etiqueta(b).slice(0, 40) || "(submit sin texto)";
        }
      }
      return null;
    }).catch(() => null);

    if (!marcado) {
      await screenshot("sin_boton_generar");
      await browser.close();
      return { ok: false, error_code: "reintentar_despues", msg: `Wansoft (${sucursal.nombre}): no se encontró el botón de generar la factura en el formulario` };
    }
    console.log(`   Botón: "${marcado}"`);

    // ⚠️ ESTE CLICK NAVEGA (POST de ASP.NET MVC). Sin envolverlo, el
    // page.evaluate siguiente revienta con "Execution context was destroyed"
    // DESPUÉS de que el POST ya salió: la factura queda emitida y el ticket
    // marcado como error, que es lo que invita a reintentar y duplicar el CFDI.
    enviado = true;
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 90000 }).catch(() => {}),
      page.click('[data-wansoft-submit="1"]').catch(() => {}),
    ]);
    await sleep(4000);

    // ── 7. Resultado ────────────────────────────────────────────────────────
    const t = await texto();
    const urlDespues = page.url();
    await screenshot("p5_post_generar");
    console.log(`   URL: ${urlAntes} → ${urlDespues}`);

    const exito = /factura.*(generad|emitid|timbrad|creada)|(generad|emitid|timbrad).*factura|exitos|correctamente|se envi[oó].*correo|descargar (xml|pdf)|comprobante.*(generad|emitid)/i.test(t);
    const uuid = (t.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) || [])[0] || null;

    // ¿Rebotó el formulario? En MVC eso significa que NO se timbró nada, y sólo
    // ahí se puede devolver un error sin miedo a provocar un duplicado.
    const validacion = await page.evaluate(() => {
      const nodos = Array.from(document.querySelectorAll(".field-validation-error, .validation-summary-errors, [data-valmsg-summary='true'], .alert-danger, .text-danger, .invalid-feedback"));
      return nodos.map((n) => (n.innerText || "").trim()).filter(Boolean).join(" | ").slice(0, 400);
    }).catch(() => "");
    const formularioSigueAhi = await existe(SEL.rfc);

    if (!exito && (validacion || formularioSigueAhi)) {
      const detalle = validacion || t.slice(0, 240);
      if (/ya (fue |ha sido |se )?factur|previamente factur|cuenta con factura/i.test(detalle)) {
        await browser.close();
        return { ok: false, error_code: "ya_facturado", msg: `Wansoft (${sucursal.nombre}): el portal rechazó el envío porque el ticket ya está facturado. ${detalle}` };
      }
      if (/mes en curso|fuera de(l)? (plazo|mes)|vencid|caduc|fecha l[ií]mite/i.test(detalle)) {
        await browser.close();
        return { ok: false, error_code: "ticket_vencido", msg: `Wansoft (${sucursal.nombre}): el portal rechazó el envío por plazo (sólo dentro del mes en curso). No hay correo de facturación publicado de Los Senderos, así que la reclamación por correo no se puede automatizar: hay que pedirla en la tienda. ${detalle}` };
      }
      const retoPost = await detectarTurnstile();
      if (retoPost) {
        await browser.close();
        return { ok: false, error_code: "captcha", msg: `Wansoft (${sucursal.nombre}): el envío rebotó con un reto de Cloudflare Turnstile (${JSON.stringify(retoPost)}). Hay que facturar a mano.` };
      }
      await browser.close();
      // El formulario volvió = NO se emitió CFDI. Error del dato → el usuario
      // puede corregirlo; error del portal → reintentable.
      const esDato = /requerid|obligatorio|inv[aá]lid|incorrect|no coincide|no se encontr|formato/i.test(detalle);
      return {
        ok: false,
        error_code: esDato ? "datos_invalidos" : "reintentar_despues",
        msg: `Wansoft (${sucursal.nombre}): el formulario volvió con errores y NO se timbró nada. ${detalle}${dosier}`,
      };
    }

    // Intento de capturar XML/PDF: primero lo que ya pescó page.on('response'),
    // y si no, los enlaces de descarga (fetch dentro de la página, con cookies).
    if (!xmlBuf || !pdfBuf) {
      const enlaces = await page.evaluate(() => {
        return Array.from(document.querySelectorAll("a[href]"))
          .filter((a) => /\.xml|\.pdf|download|descargar|getfile|invoicefile/i.test((a.getAttribute("href") || "") + " " + (a.innerText || "")))
          .slice(0, 6)
          .map((a) => {
            let href = null;
            try { href = new URL(a.getAttribute("href"), location.href).href; } catch (e) {}
            return { href, texto: (a.innerText || "").trim().slice(0, 40) };
          })
          .filter((x) => x.href);
      }).catch(() => []);
      for (const e of enlaces) {
        const esXml = /xml/i.test(e.href + " " + e.texto);
        if (esXml && xmlBuf) continue;
        if (!esXml && pdfBuf) continue;
        const bajado = await page.evaluate(async (href) => {
          try {
            const r = await fetch(href, { credentials: "include" });
            if (!r.ok) return null;
            const u8 = new Uint8Array(await r.arrayBuffer());
            let s = "";
            for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
            return { b64: btoa(s) };
          } catch (x) { return null; }
        }, e.href).catch(() => null);
        if (!bajado || !bajado.b64) continue;
        const buf = Buffer.from(bajado.b64, "base64");
        if (buf.length < 300) continue;
        if (/<cfdi:Comprobante|<Comprobante/i.test(buf.toString("utf8").slice(0, 3000))) xmlBuf = xmlBuf || buf;
        else if (buf.slice(0, 4).toString() === "%PDF") pdfBuf = pdfBuf || buf;
      }
    }

    let xmlUrl = null;
    let pdfUrl = null;
    const nombre = `${sucursal.sid}_${codigo || orden || ts}`;
    if (xmlBuf) xmlUrl = await subirArchivoR2(xmlBuf, `facturas/wansoft_${ts}_${nombre}.xml`, "application/xml").catch(() => null);
    if (pdfBuf) pdfUrl = await subirArchivoR2(pdfBuf, `facturas/wansoft_${ts}_${nombre}.pdf`, "application/pdf").catch(() => null);
    await browser.close();

    if (xmlUrl) {
      console.log(`✅ Factura emitida${uuid ? ` — UUID ${uuid}` : ""}`);
      console.log(`☁️ XML: ${xmlUrl}`);
      return { ok: true, xmlUrl, pdfUrl };
    }

    if (exito) {
      console.log(`✅ Factura emitida${uuid ? ` — UUID ${uuid}` : ""} — sin descarga directa, llega por correo`);
      return {
        ok: true,
        procesandoCorreo: true,
        msg: `Wansoft (${sucursal.nombre}): CFDI timbrado${uuid ? ` (UUID ${uuid})` : ""} y enviado a ${emailEntrega}. NO reintentar: duplicaría el CFDI.`,
      };
    }

    // Ambiguo: el POST salió, el formulario ya no está y no hay ni éxito ni
    // error reconocibles. Se devuelve procesandoCorreo A PROPÓSITO (ver
    // cabecera): un error reintentable dispararía el reintento de medianoche y
    // podría emitir un segundo CFDI.
    console.log("⚠️ Resultado ambiguo tras enviar el formulario");
    return {
      ok: true,
      procesandoCorreo: true,
      msg: `Wansoft (${sucursal.nombre}): el formulario se envió pero el portal no mostró un mensaje reconocible de éxito ni de error. La factura PUEDE estar emitida y en camino a ${emailEntrega}. NO relanzar el bot sin comprobarlo antes en el portal: duplicaría el CFDI. Pantalla: ${t.slice(0, 220)}${dosier}`,
    };
  } catch (e) {
    await screenshot("excepcion");
    await browser.close().catch(() => {});
    if (enviado) {
      // La excepción ocurrió DESPUÉS de enviar el formulario. Devolver un error
      // aquí es exactamente lo que duplica CFDIs.
      return {
        ok: true,
        procesandoCorreo: true,
        msg: `Wansoft (${sucursal.nombre}): excepción DESPUÉS de enviar el formulario (${e.message}). La factura puede estar emitida y en camino a ${emailEntrega}. NO relanzar el bot sin comprobarlo antes en el portal.`,
      };
    }
    return { ok: false, error_code: "reintentar_despues", msg: `Wansoft (${sucursal.nombre}): ${e.message}` };
  }
}

module.exports = { facturarWansoft };
