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
// ⚠️ LO QUE NO ESTÁ VERIFICADO: todo lo que pasa DESPUÉS de pulsar #send. El
// reconocimiento se paró justo antes a propósito, porque ese botón emite un
// CFDI real y no tiene vuelta atrás. Por eso el tramo final es defensivo:
// intenta capturar XML/PDF por blob (como carljr) y, si no los ve, devuelve
// procesandoCorreo:true para que el CFDI entre por IMAP — que llega igual
// porque en #correo se escribe el buzón de captura, no el correo del residente.
// Para probar el flujo completo SIN emitir nada: dryRun:true (o FIARUM_DRY_RUN=1).
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
  // ⚠️ Solo para scripts/probe-fiarum.js. NUNCA se activa desde la cola: su
  // error_code no es de los controlados, así que si llegara por el pipeline
  // lib/facturacion.js lo trataría como error genérico y lo reintentaría a
  // medianoche. Desde el probe se llama a esta función directamente.
  const seco = dryRun === true || process.env.FIARUM_DRY_RUN === "1";

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
    let estado = null;
    for (let i = 0; i < 20; i++) {
      await sleep(1000);
      estado = await page.evaluate(() => {
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
      if (estado.agregar || estado.noEncontrada || estado.fueraDeRango || estado.esperandoAprobacion) break;
    }
    await screenshot("p2_busqueda");

    if (estado.noEncontrada) {
      await browser.close();
      return { ok: false, error_code: "datos_invalidos", msg: `FIARUM: el portal no encontró el folio ${folioLimpio} con fecha ${fechaPortal}. Revisa folio y fecha en la foto del ticket.` };
    }
    if (estado.fueraDeRango) {
      await browser.close();
      return { ok: false, error_code: "ticket_vencido", msg: `FIARUM: el folio ${folioLimpio} está fuera del rango de facturación (plazo vencido).` };
    }
    if (estado.esperandoAprobacion) {
      await browser.close();
      return { ok: false, msg: `FIARUM: el folio ${folioLimpio} ya tiene una solicitud en curso ("esperando aprobación") — no se vuelve a mandar para no duplicar.` };
    }
    if (!estado.agregar) {
      await browser.close();
      return { ok: false, msg: `FIARUM: la búsqueda del folio ${folioLimpio} no dio respuesta reconocible en 20 s${ultimoDialog ? ` (alert: "${ultimoDialog}")` : ""}` };
    }

    // El portal reescribe #carril con el carril real de su base.
    if (estado.carrilPortal && estado.carrilPortal !== carrilLimpio) {
      console.log(`   ℹ️ Carril del ticket "${carrilLimpio}" → el portal lo corrigió a "${estado.carrilPortal}"`);
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
    if (seco) {
      await browser.close();
      console.log("🧪 DRY RUN — todo listo hasta el botón Siguiente; no se emite nada.");
      return {
        ok: false,
        error_code: "dry_run",
        msg: `FIARUM dry run OK: folio ${folioLimpio} encontrado y agregado, datos fiscales cargados. No se pulsó "Siguiente".`,
        _debug: { carrilPortal: estado.carrilPortal, llenado: llenado.leido },
      };
    }

    console.log('🧾 Pulsando "Siguiente" (EMISIÓN REAL)...');
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
    await screenshot("p5_post_emision");

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

    // Antes de soltar el browser: rescatar cualquier UUID o folio de la
    // pantalla final. lib/facturacion.js solo conserva estos dos nombres
    // (folioGenerado / uuid) y con ellos escribe el "NO RELANZAR" en error_msg,
    // que es lo único que impide volver a timbrar el mismo cruce.
    const textoFinal = await page.evaluate(() => document.body.innerText);
    const uuid = (textoFinal.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) || [])[0] || null;
    await browser.close();

    // Sin archivos capturados no damos el ticket por perdido: en #correo fue el
    // buzón de captura, así que el CFDI llega por IMAP y el job lo asocia.
    console.log(`📧 Sin captura de archivos — queda en manos del correo (IMAP)${uuid ? ` | UUID: ${uuid}` : ""}`);
    return {
      ok: true,
      procesandoCorreo: true,
      folioGenerado: folioLimpio,
      ...(uuid ? { uuid } : {}),
      _debug: { texto: textoFinal.replace(/\s+/g, " ").slice(0, 400), descargas: descargas.map((d) => d.name || "?") },
    };
  } catch (e) {
    console.error("❌ Error en bot FIARUM:", e.message);
    await screenshot("error").catch(() => {});
    await browser.close().catch(() => {});
    return { ok: false, msg: `FIARUM: ${e.message}` };
  }
}

module.exports = { facturarFiarum };
