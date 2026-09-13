// Puente Colorado — Caseta San Luis Río Colorado (Gobierno de Sonora)
// https://www.qrplus.com.mx/SONORA_Facturacion/FormsFacturacion/FWizExprFacturacion.aspx
// ASP.NET WebForms + DevExpress, operado por AIDE Soluciones.
//
// Sustituye al formulario de WordPress puentecolorado.com/prefacturacion/, que
// era una SOLICITUD y tardaba hasta 48 h en llegar por correo. Este timbra al
// momento y ofrece descarga directa de PDF y XML.
//
// Reconocimiento en vivo del 13-sep-2026 con el ticket #396. Lo que se midió:
//
//  - ⚠️ TODO SE MANEJA POR LA API CLIENTE DE DEVEXPRESS, NO por el DOM. Cada
//    control publica un objeto global con su mismo id (window[id]) y los
//    métodos SetText/GetText/SetDate/DoClick. Escribir .value en el input que
//    termina en "_I" NO sirve: hay un hidden hermano con el valor de verdad y
//    el postback manda el campo en blanco.
//
//  - ⚠️ CADA CLICK ES UN POSTBACK COMPLETO de WebForms: la página se recarga
//    entera. Hay que esperar la navegación después de cada DoClick() o el
//    siguiente paso se ejecuta contra un DOM que está a punto de morir.
//
//  - ⚠️ EL WEB ID NO SIRVIÓ. El ticket imprime un "Web ID" de cinco grupos
//    (p.ej. 0605-4VOL2-R5NQX-CAM14-X1RC9) y el portal tiene un atajo para él,
//    pero al probarlo contestó "NO SE ENCUENTRA TICKET CON FOLIO ÚNICO". Sea
//    porque el OCR confunde caracteres (0/O, 1/I, 5/S) o porque el índice no
//    los tiene, NO es un camino fiable: por eso el bot va por el camino manual
//    y solo intenta el WebID si viene y como atajo opcional.
//
//  - EL CAMINO MANUAL SÍ FUNCIONA y pide CINCO datos: Folio, Caseta, Carril,
//    Fecha y Hora. Los cinco están impresos en el ticket. Sin hora no busca.
//
//  - El combo de Caseta ya viene con "SAN LUIS RIO COLORADO" puesto.
//
//  - Registrar un ticket es REVERSIBLE: la rejilla trae un botón Eliminar
//    (..._Grid_cell0_0_btnEliminarReg_0_I) y un popup de confirmación
//    (pop_MensajeConfirmaRow_btnAceptaTick). Útil para no dejar un cruce
//    reservado si algo falla a medias.
//
//  - Admite VARIOS tickets en la misma factura. Aquí se factura de uno en uno
//    porque el sistema trabaja por ticket.
//
// Paradas de seguridad (scripts/probe-puentecolorado.js):
//   dryRun:'registro' → registra el ticket, vuelca el Paso 2 y lo libera.
//   dryRun:'fiscales' → llega al Paso 3 con los datos puestos, sin facturar.
const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");

const URL_PORTAL = "https://www.qrplus.com.mx/SONORA_Facturacion/FormsFacturacion/FWizExprFacturacion.aspx";
const P = "MainPane_Content_MainContent_";
const FORM = P + "PageControl_Factura_exampleFormLayout_";
const DATOS = FORM + "rpnDatosTicket_ASPxFormLayout8_";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function partesFecha(fecha) {
  const s = String(fecha || "").trim();
  let d, m, a;
  const dmy = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (dmy) { [, d, m, a] = dmy; } else if (iso) { [, a, m, d] = iso; } else return null;
  return { d: +d, m: +m, a: +a, texto: `${d}/${m}/${a}` };
}

// La hora del ticket viene HH:MM:SS. El portal la acepta en 24 h aunque luego
// la muestre en 12 h (17:00:06 se ve como 05:00:06 en la rejilla).
function normalizarHora(hora) {
  const s = String(hora || "").trim();
  const m = s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return `${String(m[1]).padStart(2, "0")}:${m[2]}:${m[3] || "00"}`;
}

// Un DoClick de DevExpress dispara un postback de WebForms: hay que esperar a
// que la página se recargue antes de tocar nada más.
async function clickYEsperar(page, idControl) {
  const existe = await page.evaluate((id) => {
    const c = window[id];
    if (!c || !c.DoClick) return false;
    c.DoClick();
    return true;
  }, idControl);
  if (!existe) return false;
  await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 45000 }).catch(() => {});
  await sleep(1200);
  return true;
}

async function textoPagina(page) {
  return page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
}

async function facturarPuenteColorado({
  folio, carril, caseta, fecha, fechaPago, hora, webId,
  total, importe,
  rfc, razonSocial, codigoPostal, regimenFiscal, usoCfdi,
  calle, ext, int: numInt, colonia, municipio, estado,
  emailEntrega, ticketId, dryRun,
}) {
  console.log("🤖 Iniciando bot Puente Colorado (qrplus)...");

  const folioLimpio = String(folio || "").replace(/\D/g, "");
  const carrilLimpio = String(carril || "").replace(/\D/g, "");
  const f = partesFecha(fecha || fechaPago);
  const horaLimpia = normalizarHora(hora);
  const montoTicket = total != null ? total : importe;
  const seco = dryRun || process.env.PUENTECOLORADO_DRY_RUN || null;

  console.log(`   Folio: ${folioLimpio} | Carril: ${carrilLimpio} | ${f ? f.texto : "?"} ${horaLimpia || "?"} | Total: ${montoTicket}${seco ? ` | 🧪 DRY RUN (${seco})` : ""}`);

  // El portal necesita los CINCO. Faltar uno no da error claro: simplemente no
  // encuentra el cruce, y eso parece un folio malo cuando es una hora ausente.
  const faltan = [];
  if (!folioLimpio) faltan.push("folio");
  if (!carrilLimpio) faltan.push("carril");
  if (!f) faltan.push("fecha");
  if (!horaLimpia) faltan.push("hora");
  if (faltan.length) {
    return {
      ok: false,
      error_code: "datos_invalidos",
      msg: `Puente Colorado: el portal pide folio, carril, fecha y hora, y falta(n): ${faltan.join(", ")}. Están impresos en el ticket; hay que releer la foto.`,
    };
  }
  if (!rfc) return { ok: false, error_code: "datos_invalidos", msg: "Puente Colorado: falta el RFC del receptor" };

  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error("BROWSERLESS_TOKEN no definido");
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true`,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 900 });

  let ultimoDialog = null;
  page.on("dialog", async (d) => {
    ultimoDialog = d.message();
    console.log(`💬 ALERT: "${d.message()}"`);
    try { await d.accept(); } catch {}
  });

  // Intento de capturar los archivos del popup final. ⚠️ MEDIDO: NO funciona.
  // Los botones PDF/XML son postbacks de WebForms que Chrome trata como
  // descarga de fichero, y una descarga no pasa por page.on('response') de
  // forma utilizable (resp.buffer() falla en ese flujo). Se deja porque no
  // estorba y el día que el portal sirva el archivo inline lo cogerá.
  // La vía buena aquí es el correo: el propio portal dice "SU FACTURA HA SIDO
  // ENVIADA A SU EMAIL" y en el Paso 2 le damos el buzón de captura, así que el
  // CFDI entra por IMAP y el job lo asocia al ticket.
  const archivos = [];
  page.on("response", async (resp) => {
    try {
      const h = resp.headers();
      const ct = (h["content-type"] || "").toLowerCase();
      const cd = (h["content-disposition"] || "").toLowerCase();
      if (!/pdf|xml|octet-stream/.test(ct) && !/attachment/.test(cd)) return;
      const buf = await resp.buffer();
      if (!buf || buf.length < 100) return;
      const cab = buf.slice(0, 8).toString("latin1");
      const tipo = cab.startsWith("%PDF") || /pdf/.test(ct + cd) ? "pdf"
        : (cab.includes("<?xml") || /xml/.test(ct + cd) ? "xml" : null);
      if (tipo) { archivos.push({ tipo, buf }); console.log(`   📎 capturado ${tipo} (${buf.length} bytes)`); }
    } catch {}
  });

  const ts = ticketId || Date.now();
  async function screenshot(label) {
    try {
      const buf = await page.screenshot({ fullPage: true });
      const u = await subirArchivoR2(buf, `debug/puentecolorado_${ts}_${label}_${Date.now()}.png`, "image/png");
      console.log(`📸 [${label}]: ${u}`);
    } catch {}
  }

  // Suelta el ticket de la rejilla para no dejar el cruce reservado.
  async function liberarTicket() {
    try {
      const hay = await page.evaluate((id) => !!document.getElementById(id), `${FORM}Grid_cell0_0_btnEliminarReg_0_I`);
      if (!hay) return;
      await page.evaluate((id) => document.getElementById(id).click(), `${FORM}Grid_cell0_0_btnEliminarReg_0_I`);
      await sleep(2500);
      await page.evaluate((id) => { const b = document.getElementById(id); if (b) b.click(); }, `${P}pop_MensajeConfirmaRow_btnAceptaTick_I`);
      await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});
      console.log("   ↩️ Ticket liberado de la rejilla");
    } catch (e) { console.log(`   ⚠️ No se pudo liberar el ticket: ${e.message}`); }
  }

  try {
    console.log("🌐 Cargando portal qrplus...");
    await page.goto(URL_PORTAL, { waitUntil: "networkidle2", timeout: 60000 });
    await page.waitForSelector(`#${DATOS}txtFolio_I`, { timeout: 25000 });
    await sleep(1500); // DevExpress engancha sus objetos cliente tras el ready
    await screenshot("p1_cargado");

    // ── PASO 1 — Registrar el ticket ─────────────────────────────────────
    console.log(`🔎 Registrando ticket (folio ${folioLimpio}, carril ${carrilLimpio}, ${f.texto} ${horaLimpia})...`);
    const puesto = await page.evaluate((d) => {
      const g = (id) => window[id];
      const faltan = [];
      const set = (id, val) => { const c = g(id); if (!c || !c.SetText) { faltan.push(id.split("_").pop()); return; } c.SetText(val); };
      set(d.DATOS + "txtFolio", d.folio);
      set(d.DATOS + "txtCarril", d.carril);
      set(d.DATOS + "txtHora", d.hora);
      const fe = g(d.DATOS + "date_fecha");
      if (fe && fe.SetDate) fe.SetDate(new Date(d.a, d.m - 1, d.dia)); else faltan.push("date_fecha");
      const cb = g(d.DATOS + "cmbCaseta");
      if (cb && d.caseta && cb.SetText) cb.SetText(d.caseta);
      return {
        faltan,
        leido: {
          folio: g(d.DATOS + "txtFolio") ? g(d.DATOS + "txtFolio").GetText() : null,
          carril: g(d.DATOS + "txtCarril") ? g(d.DATOS + "txtCarril").GetText() : null,
          hora: g(d.DATOS + "txtHora") ? g(d.DATOS + "txtHora").GetText() : null,
          fecha: fe ? fe.GetText() : null,
          caseta: cb ? cb.GetText() : null,
        },
      };
    }, { DATOS, folio: folioLimpio, carril: carrilLimpio, hora: horaLimpia, a: f.a, m: f.m, dia: f.d, caseta: caseta || null });

    if (puesto.faltan.length) {
      await screenshot("error_controles");
      await browser.close();
      return { ok: false, msg: `Puente Colorado: no aparecieron los controles DevExpress: ${puesto.faltan.join(", ")}` };
    }
    console.log(`   En pantalla: ${JSON.stringify(puesto.leido)}`);

    await clickYEsperar(page, `${DATOS}btnRegistrar`);
    await screenshot("p2_registrado");

    const txt1 = await textoPagina(page);
    if (/NO SE ENCUENTRA TICKET/i.test(txt1)) {
      await browser.close();
      return { ok: false, error_code: "datos_invalidos", msg: `Puente Colorado: el portal no encontró el ticket (folio ${folioLimpio}, carril ${carrilLimpio}, ${f.texto} ${horaLimpia}). Revisa esos cuatro datos en la foto.` };
    }

    // La rejilla "Ticket(s) a Facturar" tiene que traer la fila con el folio.
    const enRejilla = await page.evaluate((fol) => {
      const t = document.body.innerText || "";
      const sinCeros = String(fol).replace(/^0+/, "");
      return t.includes(fol) || t.includes(sinCeros);
    }, folioLimpio);
    if (!enRejilla) {
      await screenshot("error_no_en_rejilla");
      await browser.close();
      return { ok: false, msg: `Puente Colorado: el ticket ${folioLimpio} no apareció en "Ticket(s) a Facturar"${ultimoDialog ? ` (alert: "${ultimoDialog}")` : ""}. Texto: ${txt1.slice(0, 250)}` };
    }
    console.log("✅ Ticket en la rejilla");

    if (seco === "registro") {
      const paso2 = await page.evaluate(() => ({
        botones: Array.from(document.querySelectorAll("input[type=submit],button,a"))
          .filter((e) => e.offsetParent)
          .map((e) => ({ id: (e.id || "").replace("MainPane_Content_MainContent_", ""), txt: (e.value || e.innerText || "").trim().slice(0, 28) }))
          .filter((e) => e.txt),
      }));
      await liberarTicket();
      await browser.close();
      console.log("🧪 DRY RUN registro — ticket encontrado y liberado; no se facturó nada.");
      return { ok: false, error_code: "dry_run", msg: `Puente Colorado dry run: ticket ${folioLimpio} encontrado en la rejilla.`, _paso2: paso2, _leido: puesto.leido };
    }

    // ── PASO 2 — Siguiente → Datos Fiscales ──────────────────────────────
    console.log('➡️  "Siguiente" → Paso 2 (Datos Fiscales)...');
    const idSiguiente = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("input[type=submit],button,a"))
        .find((e) => e.offsetParent && /siguiente/i.test(e.value || e.innerText || ""));
      return b ? b.id : null;
    });
    if (!idSiguiente) {
      await screenshot("error_sin_siguiente");
      await liberarTicket();
      await browser.close();
      return { ok: false, msg: `Puente Colorado: el ticket ${folioLimpio} quedó en la rejilla pero no apareció el botón "Siguiente"` };
    }
    await page.evaluate((id) => document.getElementById(id).click(), idSiguiente);
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 45000 }).catch(() => {});
    await sleep(1500);
    await screenshot("p3_datos_fiscales");

    // ── PASO 2 — Datos fiscales ──────────────────────────────────────────
    // Los tres combos ya vienen con lo que necesitamos (601, G03, 01 Efectivo),
    // así que solo se tocan si el perfil del cliente pide otra cosa: un
    // SetText mal puesto en un ComboBox de DevExpress deja el valor real vacío.
    const correo = emailEntrega || process.env.IMAP_USER || "buzonfacturas@serviciosga.site";
    const cp = String(codigoPostal || "").replace(/\D/g, "").slice(0, 5);
    const regimen = String(regimenFiscal || "601").match(/\d{3}/)?.[0] || "601";
    const uso = String(usoCfdi || "G03").toUpperCase().match(/[A-Z]\d{2}/)?.[0] || "G03";

    console.log(`📋 Paso 2 — RFC ${rfc} | CP ${cp} | Régimen ${regimen} | Uso ${uso} | Entrega ${correo}`);

    const FL1 = `${P}PageControl_Factura_ASPxFormLayout1_`;
    await page.evaluate((d) => {
      const c = window[d.FL1 + "txtRFCExpr"];
      if (c && c.SetText) c.SetText(d.rfc);
    }, { FL1, rfc });

    // "Buscar" valida el RFC contra el SAT y autocompleta si ya lo conoce.
    await clickYEsperar(page, `${FL1}btn_Validar`);
    await sleep(1200);

    const fiscales = await page.evaluate((d) => {
      const g = (n) => window[d.FL1 + n];
      const set = (n, v) => { const c = g(n); if (c && c.SetText && v) c.SetText(v); };
      // Solo escribir la razón social si el portal no la trajo ya del SAT.
      const razon = g("txtRazon");
      if (razon && razon.GetText && !razon.GetText().trim() && d.razonSocial) razon.SetText(d.razonSocial);
      set("txtCP", d.cp);
      set("txtCorreo", d.correo);
      const combo = (n, clave) => {
        const c = g(n);
        if (!c) return;
        const actual = c.GetText ? c.GetText() : "";
        if (actual && actual.toUpperCase().startsWith(String(clave).toUpperCase())) return; // ya está
        if (c.SetValue) { try { c.SetValue(clave); return; } catch {} }
        if (c.SetText) c.SetText(clave);
      };
      combo("CM_RegimenFiscal", d.regimen);
      combo("cmbCFDI", d.uso);
      combo("cmbFormaPago", "01");
      return {
        rfc: g("txtRFCExpr") ? g("txtRFCExpr").GetText() : null,
        razon: g("txtRazon") ? g("txtRazon").GetText() : null,
        cp: g("txtCP") ? g("txtCP").GetText() : null,
        correo: g("txtCorreo") ? g("txtCorreo").GetText() : null,
        regimen: g("CM_RegimenFiscal") ? g("CM_RegimenFiscal").GetText() : null,
        uso: g("cmbCFDI") ? g("cmbCFDI").GetText() : null,
        formaPago: g("cmbFormaPago") ? g("cmbFormaPago").GetText() : null,
      };
    }, { FL1, razonSocial, cp, correo, regimen, uso });

    console.log(`   Confirmado en pantalla: ${JSON.stringify(fiscales)}`);
    await screenshot("p4_fiscales_listos");

    if (!fiscales.rfc || !fiscales.cp || !fiscales.correo) {
      await liberarTicket();
      await browser.close();
      return { ok: false, error_code: "datos_invalidos", msg: `Puente Colorado: el Paso 2 quedó incompleto (rfc=${fiscales.rfc}, cp=${fiscales.cp}, correo=${fiscales.correo}) — no se avanza para no facturar mal.` };
    }

    if (seco === "fiscales") {
      await liberarTicket();
      await browser.close();
      console.log("🧪 DRY RUN fiscales — Paso 2 completo; no se avanzó al Paso 3.");
      return { ok: false, error_code: "dry_run", msg: `Puente Colorado dry run: ticket ${folioLimpio} registrado y datos fiscales puestos.`, _fiscales: fiscales };
    }

    // ── PASO 3 — Facturar ────────────────────────────────────────────────
    // ⚠️ Los CAMPOS del Paso 2 viven en ASPxFormLayout1 pero los BOTONES están
    // en ASPxFormLayout5. Apuntar al prefijo equivocado no da error: el
    // control simplemente no existe, el click no ocurre y el bot sigue como si
    // hubiera avanzado. Por eso clickYEsperar avisa cuando no encuentra nada.
    console.log('➡️  "Siguiente" → Paso 3 (Facturar)...');
    const BOT = `${P}PageControl_Factura_ASPxFormLayout5_`;
    const avanzo = await clickYEsperar(page, `${BOT}btnConfirmar`);
    if (!avanzo) {
      await screenshot("error_sin_confirmar");
      await liberarTicket();
      await browser.close();
      return { ok: false, msg: `Puente Colorado: no encontré el botón "Siguiente >>" del Paso 2 (${BOT}btnConfirmar)` };
    }
    await screenshot("p5_paso3");

    const paso3 = await page.evaluate(() => ({
      texto: document.body.innerText.replace(/\s+/g, " ").slice(0, 700),
      botones: Array.from(document.querySelectorAll("input[type=submit],button,a"))
        .filter((e) => e.offsetParent)
        .map((e) => ({ id: (e.id || "").replace("MainPane_Content_MainContent_", ""), txt: (e.value || e.innerText || "").trim().slice(0, 28) }))
        .filter((e) => e.txt),
    }));
    console.log(`   Paso 3 — botones: ${paso3.botones.map((b) => b.txt).join(" | ")}`);

    if (seco === "paso3") {
      await liberarTicket();
      await browser.close();
      return { ok: false, error_code: "dry_run", msg: `Puente Colorado dry run: llegué al Paso 3 del ticket ${folioLimpio} sin facturar.`, _paso3: paso3 };
    }

    // El botón que EMITE. ⚠️ Se busca con TEXTO EXACTO "Facturar" y solo entre
    // input/button: la pestaña del asistente se llama "Paso 3: Facturar" y es
    // un <a>, así que un match laxo la cogería a ella y el bot se quedaría
    // navegando en círculos creyendo que timbró.
    const idFacturar = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("input[type=submit],button"))
        .filter((e) => e.offsetParent && /^\s*facturar\s*$/i.test(e.value || e.innerText || ""))[0];
      return b ? b.id : null;
    });
    if (!idFacturar) {
      await screenshot("error_sin_boton_facturar");
      await liberarTicket();
      await browser.close();
      return { ok: false, msg: `Puente Colorado: llegué al Paso 3 del ticket ${folioLimpio} pero no encontré el botón de facturar. Botones: ${paso3.botones.map((b) => b.txt).join(" | ")}` };
    }

    console.log(`🧾 Pulsando "${paso3.botones.find((b) => b.id && idFacturar.endsWith(b.id))?.txt || idFacturar}" (EMISIÓN REAL)...`);
    await page.evaluate((id) => document.getElementById(id).click(), idFacturar);
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }).catch(() => {});
    await sleep(6000);
    await screenshot("p6_post_emision");

    const txtFinal = await textoPagina(page);
    const uuid = (txtFinal.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) || [])[0] || null;

    // El popup de resultado trae descarga directa: son postbacks de WebForms
    // que devuelven el archivo, así que page.on('response') SÍ los ve (a
    // diferencia de los blobs de FIARUM).
    // Que el popup de descarga exista y esté VISIBLE ya es acuse por sí solo:
    // el portal solo lo saca cuando ha timbrado.
    let vioPopupDescarga = false;
    for (const idBtn of [`${P}pop_Mensaje_btnDescargaXML_I`, `${P}pop_Mensaje_btnDescargaPDF_I`]) {
      const hay = await page.evaluate((id) => {
        const b = document.getElementById(id);
        if (!b || !b.offsetParent) return false;
        b.click();
        return true;
      }, idBtn);
      if (hay) { vioPopupDescarga = true; console.log(`   ⬇️ ${idBtn.split("_").slice(-2)[0]}`); await sleep(4000); }
    }

    let xmlBuf = archivos.find((a) => a.tipo === "xml")?.buf || null;
    let pdfBuf = archivos.find((a) => a.tipo === "pdf")?.buf || null;
    await browser.close();

    if (xmlBuf || pdfBuf) {
      const marca = `${ts}_${Date.now()}`;
      const xmlUrl = xmlBuf ? await subirArchivoR2(xmlBuf, `facturas/puentecolorado_${marca}.xml`, "application/xml") : null;
      const pdfUrl = pdfBuf ? await subirArchivoR2(pdfBuf, `facturas/puentecolorado_${marca}.pdf`, "application/pdf") : null;
      console.log(`✅ Puente Colorado OK — XML: ${xmlUrl} | PDF: ${pdfUrl}`);
      return { ok: true, xmlUrl, pdfUrl };
    }

    // ⚠️ CUIDADO CON EL ACUSE. El Paso 3 lleva SIEMPRE impreso el aviso "UNA VEZ
    // GENERADA LA FACTURA, NO SE REALIZARÁN CORRECIONES", también ANTES de
    // pulsar nada. Un regex laxo del tipo /factura.*generad/ hace match con ese
    // aviso y da el ticket por facturado sin estarlo — el mismo falso positivo
    // que costó el primer intento del #391 en FIARUM.
    // El acuse de verdad es literal: "SU FACTURA HA SIDO ENVIADA A SU EMAIL"
    // junto a "(Tickets: facturados N)", y aparece en un popup que además
    // ofrece la descarga de PDF y XML.
    const exito = !!uuid
      || /su\s+factura\s+ha\s+sido\s+enviada/i.test(txtFinal)
      || /tickets?\s*:\s*facturados?\s*[1-9]/i.test(txtFinal)
      || vioPopupDescarga;
    if (!exito) {
      return { ok: false, msg: `Puente Colorado: tras pulsar "Facturar" el ticket ${folioLimpio} no dio acuse ("SU FACTURA HA SIDO ENVIADA"). NO se da por facturado. Texto: ${txtFinal.slice(0, 250)}` };
    }
    console.log(`📧 Emitida sin captura de archivos — queda en manos del correo (IMAP)${uuid ? ` | UUID: ${uuid}` : ""}`);
    return { ok: true, procesandoCorreo: true, folioGenerado: folioLimpio, ...(uuid ? { uuid } : {}) };
  } catch (e) {
    console.error("❌ Error en bot Puente Colorado:", e.message);
    await screenshot("error").catch(() => {});
    await liberarTicket().catch(() => {});
    await browser.close().catch(() => {});
    return { ok: false, msg: `Puente Colorado: ${e.message}` };
  }
}

module.exports = { facturarPuenteColorado };
