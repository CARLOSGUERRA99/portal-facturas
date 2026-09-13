// FIARUM — Fideicomiso Tramo Carretero Centinela–Rumorosa (Baja California)
// https://fiarumfacturas.com.mx/cfdi/autofacturas — PHP + jQuery, sin login ni CAPTCHA.
//
// ⚠️ DE DÓNDE VIENE ESTE BOT: los tickets #316, #391 y #394 llevaban semanas en
// error porque el portal no estaba dado de alta en portales.json. Sin entrada
// ahí, la Pasada 1 del OCR devuelve "desconocido" y el campo portalUrl queda
// vacío, así que el agente de altas DEDUJO un dominio a partir del nombre de la
// plaza — ficacentinela.com.mx — que no existe: probó nueve variantes y las
// nueve dieron ERR_NAME_NOT_RESOLVED. El portal real es fiarumfacturas.com.mx.
//
// Reconocimiento en vivo del 13-sep-2026 (folios 3390346 y 3390345, ambos
// encontrados). Lo que se midió de verdad:
//
//  - EL FLUJO SON DOS BLOQUES EN LA MISMA PÁGINA. Primero se busca el folio
//    (#codigo + #carril + #fechaPago → #btnSearch); si existe, aparece
//    #add-code ("Agregar folio") que lo mete en la tabla "FOLIOS PARA
//    FACTURAR". Solo después se llenan los datos fiscales y se pulsa #send.
//
//  - LA SEÑAL DE ÉXITO DE LA BÚSQUEDA ES QUE #add-code SE VUELVE VISIBLE.
//    Arranca oculto (offsetParent === null) y el portal lo muestra cuando el
//    folio existe. Es más fiable que leer el texto verde "Referencia de
//    facturación exitosa.", porque los cuatro mensajes de estado están todos
//    en el DOM desde el principio y solo cambian de visibilidad.
//
//  - ⚠️ TRAMPA DE LA FECHA: #fechaPago lleva ENGANCHADO un daterangepicker de
//    jQuery (singleDatePicker, formato DD/MM/YYYY). Escribir con page.type()
//    no dispara el change que el portal escucha, y la búsqueda contesta
//    "Referencia de facturación No encontrada" — que parece un folio malo
//    cuando en realidad es la fecha que nunca se envió. Hay que fijarla por la
//    API del picker (setStartDate/setEndDate) Y disparar el change a mano.
//
//  - ⚠️ TRAMPA DEL CARRIL: es obligatorio para que el formulario siquiera
//    busque (con el campo vacío no hace nada, ni siquiera contesta "no
//    encontrada"), PERO el valor que mandamos no es el que manda. En las dos
//    pruebas se envió carril "8" (lo que leyó el OCR del ticket) y el portal
//    encontró el folio y REESCRIBIÓ el campo a "108", que es el carril real de
//    su base. O sea: el cruce lo hace por folio + fecha y el carril solo tiene
//    que ir relleno. Por eso aquí no se aborta si el carril del OCR no coincide
//    con el del portal, y se registra el que devuelve el portal.
//
//  - Los tres desplegables (#usoCfdi, #regimenReceptor, #formaPago) son
//    <select> NATIVOS sin select2 ni envoltorio: asignar .value y disparar
//    change basta. Forma de pago: 01 Efectivo / 04 TDC / 28 TDD.
//
//  - El portal admite VARIOS folios en la misma factura (repetir "Agregar
//    folio"). Aquí se factura de uno en uno porque el sistema trabaja por
//    ticket.
//
//  - ⚠️ EL BOTÓN "SIGUIENTE" (#send) NO TIMBRA. Abre una SEGUNDA pantalla de
//    prefactura (emisor HSBC MEXICO SA F/138509 FIARUM, RFC BIF990427KU0) con
//    el desglose y dos botones nuevos: #BtnVista ("Vista Previa") y #BtnSend
//    ("Generar CFDI"). El que emite es #BtnSend. En esa pantalla aparece
//    #razonSocial (data[Receptor][Nombre]) VACÍO y obligatorio — el RFC llega
//    readOnly y el resto (correo, uso, régimen, CP) se arrastra de la primera.
//    Esto costó el primer intento del ticket #391: el bot pulsaba "Siguiente",
//    no capturaba archivos y daba el ticket por facturado sin estarlo.
//
// Paradas de seguridad para probar sin emitir (scripts/probe-fiarum.js):
//   dryRun:'siguiente'  → para antes de #send
//   dryRun:'prefactura' → atraviesa #send, deja la prefactura lista y para
//                         antes de #BtnSend. Es la parada útil: valida
//                         exactamente el estado que se va a timbrar.
const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");

const URL_PORTAL = "https://fiarumfacturas.com.mx/cfdi/autofacturas";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// El portal espera DD/MM/YYYY. El OCR suele dar ya ese formato, pero
// lib/facturacion.js puede haber pasado la fecha a ISO por el camino.
function aDdMmYyyy(fecha) {
  const s = String(fecha || "").trim();
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return s;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  return s;
}

// 01 Efectivo / 04 Tarjeta de crédito / 28 Tarjeta de débito. Los tickets de
// caseta casi siempre son efectivo y el OCR no lee la forma de pago, así que
// ese es el valor por defecto.
function claveFormaPago(formaPago) {
  const f = String(formaPago || "").toLowerCase();
  if (/cr[ée]dito/.test(f)) return "04";
  if (/d[ée]bito/.test(f)) return "28";
  if (/^(01|04|28)$/.test(f)) return f;
  return "01";
}

async function facturarFiarum({
  folio,
  carril,
  // El router rellena los dos alias de cada par (bots/index.js → normalizarDatos),
  // así que da igual cuál venga; se leen ambos por si acaso.
  fecha, fechaPago,
  total, importe,
  rfc,
  razonSocial,
  codigoPostal,
  regimenFiscal,
  usoCfdi,
  // Domicilio del receptor: opcional en la prefactura, pero si el perfil del
  // cliente lo tiene se llena. `int` se renombra porque es palabra reservada.
  calle, ext, int: numInt, colonia, municipio, estado,
  formaPago,
  emailEntrega,
  ticketId,
  dryRun,
}) {
  console.log("🤖 Iniciando bot FIARUM...");

  const folioLimpio = String(folio || "").replace(/\s+/g, "");
  // El carril solo tiene que ir relleno (ver cabecera): si el OCR no lo leyó,
  // mandamos "1" en vez de abortar, porque el cruce real es folio + fecha.
  const carrilLimpio = String(carril || "").replace(/\D/g, "") || "1";
  const fechaPortal = aDdMmYyyy(fecha || fechaPago);
  const montoTicket = total != null ? total : importe;
  // Paradas de seguridad, solo para scripts/probe-fiarum.js. NUNCA se activan
  // desde la cola: su error_code no es de los controlados, así que si llegara
  // por el pipeline lib/facturacion.js lo trataría como error genérico.
  //   "siguiente"  → para ANTES de pulsar Siguiente (ni siquiera ve la prefactura)
  //   "prefactura" → atraviesa Siguiente y para ANTES de "Generar CFDI"
  const crudo = dryRun === true ? "siguiente" : (dryRun || process.env.FIARUM_DRY_RUN || null);
  const seco = crudo === "1" ? "siguiente" : crudo;

  console.log(`   Folio: ${folioLimpio} | Carril: ${carrilLimpio} | Fecha: ${fechaPortal} | Total: ${montoTicket} | RFC: ${rfc}${seco ? " | 🧪 DRY RUN" : ""}`);

  if (!folioLimpio || !/^\d{2}\/\d{2}\/\d{4}$/.test(fechaPortal)) {
    return {
      ok: false,
      error_code: "datos_invalidos",
      msg: `FIARUM: hacen falta folio y fecha DD/MM/YYYY para buscar el cruce (folio="${folioLimpio}", fecha="${fechaPortal}")`,
    };
  }
  if (!rfc) {
    return { ok: false, error_code: "datos_invalidos", msg: "FIARUM: falta el RFC del receptor" };
  }

  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error("BROWSERLESS_TOKEN no definido");
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true`,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  // Obligatorio: un alert() sin handler cuelga el hilo y Browserless mata la
  // pestaña ("Session closed" / "Target closed" son siempre este mismo bug).
  let ultimoDialog = null;
  page.on("dialog", async (d) => {
    ultimoDialog = d.message();
    console.log(`💬 ALERT: "${d.message()}"`);
    try { await d.accept(); } catch {}
  });

  // Captura de descargas por blob, por si el portal entrega el CFDI con un
  // <a download> (mismo patrón que carljr: page.on('response') no ve los blobs).
  await page.evaluateOnNewDocument(() => {
    window.__descargas = [];
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      try {
        if (this.href && this.href.startsWith("blob:")) {
          const name = this.download || "";
          fetch(this.href)
            .then((r) => r.blob())
            .then((b) => new Promise((res) => {
              const fr = new FileReader();
              fr.onload = () => res(fr.result);
              fr.readAsDataURL(b);
            }))
            .then((dataUrl) => window.__descargas.push({ name, dataUrl }))
            .catch((e) => window.__descargas.push({ name, error: String(e) }));
          return;
        }
      } catch {}
      return origClick.apply(this, arguments);
    };
  });

  const ts = ticketId || Date.now();
  async function screenshot(label) {
    try {
      const buf = await page.screenshot({ fullPage: true });
      const u = await subirArchivoR2(buf, `debug/fiarum_${ts}_${label}_${Date.now()}.png`, "image/png");
      console.log(`📸 [${label}]: ${u}`);
    } catch {}
  }

  try {
    console.log("🌐 Cargando portal FIARUM...");
    await page.goto(URL_PORTAL, { waitUntil: "networkidle2", timeout: 45000 });
    await page.waitForSelector("#codigo", { timeout: 20000 });
    await sleep(1200); // el daterangepicker se engancha después del ready
    await screenshot("p1_cargado");

    // ── PASO 1 — Buscar el folio ─────────────────────────────────────────
    console.log(`🔎 Buscando folio ${folioLimpio} (carril ${carrilLimpio}, ${fechaPortal})...`);
    const preparado = await page.evaluate((f, c, fe) => {
      const $ = window.jQuery;
      if (!$) return { ok: false, motivo: "jQuery no cargó" };
      document.getElementById("codigo").value = f;
      document.getElementById("carril").value = c;
      const drp = $("#fechaPago").data("daterangepicker");
      if (!drp) return { ok: false, motivo: "el daterangepicker no está enganchado a #fechaPago" };
      drp.setStartDate(fe);
      drp.setEndDate(fe);
      $("#fechaPago").val(fe).trigger("change");
      return { ok: true, fechaEnInput: document.getElementById("fechaPago").value };
    }, folioLimpio, carrilLimpio, fechaPortal);

    if (!preparado.ok) {
      await screenshot("error_form_no_listo");
      await browser.close();
      return { ok: false, msg: `FIARUM: no se pudo preparar la búsqueda — ${preparado.motivo}` };
    }
    console.log(`   Fecha fijada en el input: ${preparado.fechaEnInput}`);

    await page.evaluate(() => document.getElementById("btnSearch").click());

    // El portal deja los cuatro mensajes de estado en el DOM y solo cambia su
    // visibilidad, así que se sondea la VISIBILIDAD, no el texto suelto.
    let busqueda = null;
    for (let i = 0; i < 20; i++) {
      await sleep(1000);
      busqueda = await page.evaluate(() => {
        const visible = (el) => !!(el && el.offsetParent);
        const txt = (re) => Array.from(document.querySelectorAll("div,span,p"))
          .some((e) => visible(e) && re.test(e.textContent || "") && (e.textContent || "").length < 200);
        return {
          agregar: visible(document.getElementById("add-code")),
          noEncontrada: txt(/No encontrada/i),
          fueraDeRango: txt(/fuera de rango/i),
          esperandoAprobacion: txt(/esperando aprobaci/i),
          carrilPortal: document.getElementById("carril").value,
        };
      });
      if (busqueda.agregar || busqueda.noEncontrada || busqueda.fueraDeRango || busqueda.esperandoAprobacion) break;
    }
    await screenshot("p2_busqueda");

    if (busqueda.noEncontrada) {
      await browser.close();
      return { ok: false, error_code: "datos_invalidos", msg: `FIARUM: el portal no encontró el folio ${folioLimpio} con fecha ${fechaPortal}. Revisa folio y fecha en la foto del ticket.` };
    }
    if (busqueda.fueraDeRango) {
      await browser.close();
      return { ok: false, error_code: "ticket_vencido", msg: `FIARUM: el folio ${folioLimpio} está fuera del rango de facturación (plazo vencido).` };
    }
    if (busqueda.esperandoAprobacion) {
      await browser.close();
      return { ok: false, msg: `FIARUM: el folio ${folioLimpio} ya tiene una solicitud en curso ("esperando aprobación") — no se vuelve a mandar para no duplicar.` };
    }
    if (!busqueda.agregar) {
      await browser.close();
      return { ok: false, msg: `FIARUM: la búsqueda del folio ${folioLimpio} no dio respuesta reconocible en 20 s${ultimoDialog ? ` (alert: "${ultimoDialog}")` : ""}` };
    }

    // El portal reescribe #carril con el carril real de su base.
    if (busqueda.carrilPortal && busqueda.carrilPortal !== carrilLimpio) {
      console.log(`   ℹ️ Carril del ticket "${carrilLimpio}" → el portal lo corrigió a "${busqueda.carrilPortal}"`);
    }
    console.log("✅ Folio encontrado");

    // ── PASO 2 — Agregar el folio a la tabla ─────────────────────────────
    await page.evaluate(() => document.getElementById("add-code").click());
    await sleep(2500);
    await screenshot("p3_folio_agregado");

    // ── PASO 3 — Datos fiscales ──────────────────────────────────────────
    // ⚠️ En #correo va el BUZÓN DE CAPTURA, no el correo del residente: es lo
    // que permite que el CFDI entre por IMAP y se asocie al ticket. Escribir el
    // del residente rompe el ciclo (ya pasó con Casa Ley y La Parisina).
    const correo = emailEntrega || process.env.IMAP_USER || "buzonfacturas@serviciosga.site";
    const regimen = String(regimenFiscal || "601").match(/\d{3}/)?.[0] || "601";
    const uso = String(usoCfdi || "G03").toUpperCase().match(/[A-Z]\d{2}/)?.[0] || "G03";
    const cp = String(codigoPostal || "").replace(/\D/g, "").slice(0, 5);
    const fp = claveFormaPago(formaPago);

    console.log(`📋 Datos fiscales — RFC ${rfc} | CP ${cp} | Régimen ${regimen} | Uso ${uso} | Forma pago ${fp} | Entrega ${correo}`);

    const llenado = await page.evaluate((d) => {
      const faltan = [];
      const set = (id, val) => {
        const el = document.getElementById(id);
        if (!el) { faltan.push(id); return; }
        el.value = val;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      };
      const setSelect = (id, val) => {
        const el = document.getElementById(id);
        if (!el) { faltan.push(id); return; }
        const op = Array.from(el.options).find((o) => o.value === val);
        if (!op) { faltan.push(`${id}[valor ${val} no existe]`); return; }
        el.value = val;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      };
      set("rfc", d.rfc);
      set("DomicilioFiscalReceptor", d.cp);
      set("correo", d.correo);
      setSelect("usoCfdi", d.uso);
      setSelect("regimenReceptor", d.regimen);
      setSelect("formaPago", d.fp);
      return {
        faltan,
        leido: {
          rfc: (document.getElementById("rfc") || {}).value,
          cp: (document.getElementById("DomicilioFiscalReceptor") || {}).value,
          correo: (document.getElementById("correo") || {}).value,
          uso: (document.getElementById("usoCfdi") || {}).value,
          regimen: (document.getElementById("regimenReceptor") || {}).value,
          formaPago: (document.getElementById("formaPago") || {}).value,
        },
      };
    }, { rfc, cp, correo, uso, regimen, fp });

    if (llenado.faltan.length) {
      await screenshot("error_campos_fiscales");
      await browser.close();
      return { ok: false, msg: `FIARUM: no se pudieron llenar los campos fiscales: ${llenado.faltan.join(", ")}` };
    }
    console.log(`   Confirmado en pantalla: ${JSON.stringify(llenado.leido)}`);
    await screenshot("p4_datos_fiscales");

    // ── PASO 4 — Emitir ──────────────────────────────────────────────────
    // A partir de aquí NO hay vuelta atrás: #send emite un CFDI real.
    if (seco === "siguiente") {
      await browser.close();
      console.log("🧪 DRY RUN — todo listo hasta el botón Siguiente; no se emite nada.");
      return {
        ok: false,
        error_code: "dry_run",
        msg: `FIARUM dry run OK: folio ${folioLimpio} encontrado y agregado, datos fiscales cargados. No se pulsó "Siguiente".`,
        _debug: { carrilPortal: busqueda.carrilPortal, llenado: llenado.leido },
      };
    }

    console.log('➡️  Pulsando "Siguiente" (aún NO emite: lleva a la prefactura)...');
    const pulso = await page.evaluate(() => {
      const b = document.getElementById("send");
      if (!b || !b.offsetParent) return false;
      b.click();
      return true;
    });
    if (!pulso) {
      await screenshot("error_sin_boton_send");
      await browser.close();
      return { ok: false, msg: `FIARUM: el folio ${folioLimpio} quedó cargado pero el botón "Siguiente" no estaba disponible` };
    }
    await sleep(9000);
    await screenshot("p5_prefactura");

    // ── PASO 5 — PREFACTURA ──────────────────────────────────────────────
    // "Siguiente" NO timbra: abre una segunda pantalla con el desglose (emisor
    // HSBC MEXICO SA F/138509 FIARUM, RFC BIF990427KU0) y DOS botones nuevos,
    // "Vista Previa" y "Generar CFDI". El que emite es "Generar CFDI".
    // ⚠️ Y aquí aparece un campo que en la primera pantalla no existía:
    // Nombre/Razón Social, vacío y OBLIGATORIO (asterisco rojo). Sin llenarlo
    // el portal no timbra.
    const pre = await page.evaluate(() => {
      const vis = (e) => !!(e && e.offsetParent);
      return {
        campos: Array.from(document.querySelectorAll("input,select,textarea"))
          .filter((e) => vis(e) && e.type !== "hidden")
          .map((e) => ({ id: e.id, name: e.name, ph: e.placeholder, val: e.value, req: e.required, ro: e.readOnly })),
        botones: Array.from(document.querySelectorAll("button,a.btn,input[type=submit]"))
          .filter(vis)
          .map((e) => ({ id: e.id, cls: (e.className || "").slice(0, 50), txt: (e.innerText || e.value || "").trim().slice(0, 40) })),
      };
    });
    console.log(`   Prefactura — ${pre.campos.length} campos, ${pre.botones.length} botones`);

    // #razonSocial (data[Receptor][Nombre]) llega VACÍO y es el único dato que
    // falta: el RFC viene readOnly y el resto (correo, uso, régimen, CP) se
    // arrastra de la pantalla anterior. Los de domicilio son opcionales
    // ("Extras") pero se llenan si el perfil del cliente los tiene.
    const relleno = await page.evaluate((d) => {
      const puestos = [];
      const set = (id, val) => {
        const e = document.getElementById(id);
        if (!e || !val || e.readOnly) return;
        e.value = val;
        e.dispatchEvent(new Event("input", { bubbles: true }));
        e.dispatchEvent(new Event("change", { bubbles: true }));
        puestos.push(id);
      };
      set("razonSocial", d.razonSocial);
      set("calle", d.calle);
      set("noExterior", d.ext);
      set("noInterior", d.int);
      set("colonia", d.colonia);
      set("municipio", d.municipio);
      set("estado", d.estado);
      return { puestos, razonSocial: (document.getElementById("razonSocial") || {}).value };
    }, { razonSocial, calle, ext, int: numInt, colonia, municipio, estado });

    if (!relleno.razonSocial) {
      await screenshot("error_sin_razon_social");
      await browser.close();
      return { ok: false, error_code: "datos_invalidos", msg: `FIARUM: la prefactura del folio ${folioLimpio} exige Nombre/Razón Social y quedó vacío — no se pulsa "Generar CFDI" para no emitir un CFDI incompleto.` };
    }
    console.log(`   Prefactura rellenada: ${relleno.puestos.join(", ")}`);
    await screenshot("p5b_prefactura_lista");

    // Parada de seguridad con la pantalla YA LISTA: es el estado exacto que
    // vería el botón verde, así que lo que se valida aquí es lo que se emitirá.
    if (seco === "prefactura") {
      await browser.close();
      console.log('🧪 DRY RUN prefactura — todo listo; parado ANTES de "Generar CFDI". No se emitió nada.');
      return {
        ok: false,
        error_code: "dry_run",
        msg: `FIARUM dry run: prefactura del folio ${folioLimpio} lista y sin timbrar.`,
        _prefactura: { rellenados: relleno.puestos, razonSocial: relleno.razonSocial, botones: pre.botones },
      };
    }

    console.log('🧾 Pulsando "Generar CFDI" (EMISIÓN REAL)...');
    const genero = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("button,a,input[type=submit]"))
        .find((e) => e.offsetParent && /generar\s*cfdi/i.test(e.innerText || e.value || ""));
      if (!b) return false;
      b.click();
      return true;
    });
    if (!genero) {
      await screenshot("error_sin_generar_cfdi");
      await browser.close();
      return { ok: false, msg: `FIARUM: llegué a la prefactura del folio ${folioLimpio} pero no apareció el botón "Generar CFDI" — no se emitió nada.` };
    }
    await sleep(12000);
    await screenshot("p6_post_emision");

    // Intento de capturar XML/PDF: primero pulsando cualquier enlace/botón de
    // descarga que haya aparecido, luego leyendo los blobs interceptados.
    await page.evaluate(() => {
      Array.from(document.querySelectorAll("a,button"))
        .filter((e) => e.offsetParent && /descargar|xml|pdf/i.test(e.textContent || e.getAttribute("title") || ""))
        .forEach((e, i) => setTimeout(() => { try { e.click(); } catch {} }, i * 1200));
    });

    let descargas = [];
    for (let i = 0; i < 15; i++) {
      await sleep(1000);
      descargas = await page.evaluate(() => window.__descargas || []);
      if (descargas.filter((d) => d.dataUrl).length >= 2) break;
    }

    let xmlBuf = null, pdfBuf = null;
    for (const d of descargas) {
      if (!d.dataUrl) continue;
      const buf = Buffer.from(d.dataUrl.split(",")[1] || "", "base64");
      if (buf.length < 100) continue;
      const cabecera = buf.slice(0, 8).toString("latin1");
      if (cabecera.startsWith("%PDF") || /\.pdf$/i.test(d.name)) pdfBuf = buf;
      else if (cabecera.includes("<?xml") || /\.xml$/i.test(d.name)) xmlBuf = buf;
    }

    if (xmlBuf || pdfBuf) {
      const marca = `${ts}_${Date.now()}`;
      const xmlUrl = xmlBuf ? await subirArchivoR2(xmlBuf, `facturas/fiarum_${marca}.xml`, "application/xml") : null;
      const pdfUrl = pdfBuf ? await subirArchivoR2(pdfBuf, `facturas/fiarum_${marca}.pdf`, "application/pdf") : null;
      await browser.close();
      console.log(`✅ FIARUM OK — XML: ${xmlUrl} | PDF: ${pdfUrl}`);
      return { ok: true, xmlUrl, pdfUrl };
    }

    // ⚠️ AQUÍ ESTUVO EL BUG QUE COSTÓ EL PRIMER INTENTO DEL #391: la versión
    // anterior devolvía ok:true / procesandoCorreo:true en cuanto no capturaba
    // archivos, SIN comprobar nada. Como "Siguiente" solo abre la prefactura y
    // no timbra, el ticket quedó marcado "FACTURA GENERADA … NO RELANZAR"
    // cuando en realidad no se había emitido nada — el peor error posible aquí,
    // porque un falso "no relanzar" congela el ticket para siempre.
    // Ahora hace falta PRUEBA de que se timbró: un UUID, un texto de éxito, o
    // que el botón "Generar CFDI" haya desaparecido de la pantalla.
    const cierre = await page.evaluate(() => ({
      texto: document.body.innerText,
      sigueElBoton: Array.from(document.querySelectorAll("button,a,input[type=submit]"))
        .some((e) => e.offsetParent && /generar\s*cfdi/i.test(e.innerText || e.value || "")),
    }));
    const uuid = (cierre.texto.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) || [])[0] || null;
    const textoExito = /(cfdi|factura)\s*(generad|timbrad|emitid)|se\s*(ha\s*)?envi|descarga\s*tu\s*factura|exitosa/i.test(cierre.texto);
    await browser.close();

    if (!uuid && !textoExito && cierre.sigueElBoton) {
      console.log('❌ Tras "Generar CFDI" la pantalla sigue mostrando el botón y no hay UUID ni acuse: NO se emitió.');
      return {
        ok: false,
        msg: `FIARUM: se pulsó "Generar CFDI" para el folio ${folioLimpio} pero el portal no dio acuse (ni UUID, ni mensaje de éxito, y el botón sigue ahí). NO se da por facturado. Texto: ${cierre.texto.replace(/\s+/g, " ").slice(0, 250)}`,
        _debug: { descargas: descargas.map((d) => d.name || "?") },
      };
    }

    // Hay prueba de emisión pero no pudimos bajar los archivos: en #correo fue
    // el buzón de captura, así que el CFDI llega por IMAP y el job lo asocia.
    // folioGenerado/uuid son los dos únicos nombres que lib/facturacion.js
    // conserva, y con ellos escribe el "NO RELANZAR" en error_msg.
    console.log(`📧 Emitida sin captura de archivos — queda en manos del correo (IMAP)${uuid ? ` | UUID: ${uuid}` : ""}`);
    return {
      ok: true,
      procesandoCorreo: true,
      folioGenerado: folioLimpio,
      ...(uuid ? { uuid } : {}),
      _debug: { texto: cierre.texto.replace(/\s+/g, " ").slice(0, 400), descargas: descargas.map((d) => d.name || "?") },
    };
  } catch (e) {
    console.error("❌ Error en bot FIARUM:", e.message);
    await screenshot("error").catch(() => {});
    await browser.close().catch(() => {});
    return { ok: false, msg: `FIARUM: ${e.message}` };
  }
}

module.exports = { facturarFiarum };
