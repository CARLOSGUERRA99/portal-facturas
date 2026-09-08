/**
 * Gasolineros.mx (Grupo Timex) — plataforma compartida de facturación para
 * varias gasolineras. Un solo portal, se elige la ESTACIÓN por número.
 *
 * Tickets que la usan (sep-2026): La Cuesta / Grupo Hispánica (estación 13236)
 * y MABA San Francisco / Mobil (estación 2380).
 *
 * MAPA DEL PORTAL (verificado en vivo el 2026-09-08 con el ticket #348)
 *   URL: https://www.gasolineros.mx/facturacion/facturacion.aspx
 *   Wizard ASP.NET + DevExpress de 3 pestañas. Los ids llevan sufijo "_I"
 *   (convención DevExpress para el input real dentro del control).
 *
 *   Paso 1 · INDICA ESTACIÓN
 *     #MainContent_tabFacturacion_speNumeroEstacion_I  → número de estación
 *     #MainContent_tabFacturacion_btnBuscarEstacion_I  → "Buscar estación"
 *     Al encontrarla pinta "Estación seleccionada / Estación: N - Nombre".
 *     #MainContent_tabFacturacion_btnSeleccionaEstacion_I → "Siguiente"
 *
 *   Paso 2 · INGRESA RFC
 *     Se teclea el RFC y se pulsa "Buscar". Si el RFC ya está registrado en el
 *     portal (caso de GPN), AUTOCOMPLETA todo el domicilio fiscal — calle,
 *     número, colonia, CP, estado, municipio y correo — y no hay que llenar
 *     nada más.
 *     #MainContent_tabFacturacion_btnIngresaRFC_I → "Siguiente"
 *
 *   Paso 3 · INGRESA CONSUMO
 *     #MainContent_tabFacturacion_txtNumeroTicket_I → "Número de secuencia"
 *     #MainContent_tabFacturacion_speImporte_I      → "Importe"
 *     #MainContent_tabFacturacion_btnAgregarTicket_I → "Agregar consumo"
 *       (el consumo aparece en la tabla; mientras no se agregue dice
 *        "Sin consumos disponibles $0.00")
 *     #MainContent_tabFacturacion_cmbUsoCFDI_I → combo DevExpress de Uso CFDI
 *     #MainContent_tabFacturacion_btnFacturar_I → "Facturar"
 *
 * ⚠️ PLAZO: el ticket impreso avisa "conserve y facture este ticket ANTES DEL
 *    DÍA ÚLTIMO DEL MES" — no hay ventana de 30 días, se corta a fin de mes.
 */

const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");

const PORTAL_URL = "https://www.gasolineros.mx/facturacion/facturacion.aspx";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// El portal es ASP.NET con postbacks: tras cada botón hay que esperar a que el
// texto de la página cambie, no un tiempo fijo.
async function esperarTexto(page, regex, timeoutMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const txt = await page.evaluate(() => document.body.innerText || "").catch(() => "");
    if (regex.test(txt)) return txt;
    await sleep(1500);
  }
  return null;
}

async function facturarGasolineros({
  estacion, folio, referencia, total, importe,
  rfc, usoCfdi, ticketId,
}) {
  const numEstacion = String(estacion || "").trim();
  const numTicket = String(folio || referencia || "").trim();
  const monto = Number(importe || total || 0).toFixed(2);
  const uso = String(usoCfdi || "G03").toUpperCase();

  console.log("🤖 Iniciando bot Gasolineros.mx (Grupo Timex)...");
  console.log(`   Estación: ${numEstacion} | Ticket: ${numTicket} | Importe: ${monto} | RFC: ${rfc}`);

  if (!numEstacion) {
    return {
      ok: false, error_code: "datos_invalidos",
      msg: "Gasolineros.mx: falta el NÚMERO DE ESTACIÓN — viene impreso en el ticket como \"ESTACION: NNNNN\" y sin él el portal no deja avanzar.",
    };
  }
  if (!numTicket) {
    return { ok: false, error_code: "datos_invalidos", msg: "Gasolineros.mx: falta el número de ticket/secuencia" };
  }

  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error("BROWSERLESS_TOKEN no definido");

  let browser;
  try {
    browser = await puppeteer.connect({
      browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true`,
    });
  } catch (e) {
    return { ok: false, msg: `Gasolineros.mx: no se pudo conectar al browser — ${e.message}` };
  }

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  // La pantalla de éxito ofrece "DESCARGAR XML"/"DESCARGAR PDF" como blobs de
  // JavaScript (<a download>), que page.on('response') no ve. Se hookea el
  // click del anchor ANTES de cargar nada — mismo truco que en bots/carljr.js.
  await page.evaluateOnNewDocument(() => {
    window.__descargas = [];
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      try {
        if (this.href && this.href.startsWith("blob:")) {
          const name = this.download || "";
          fetch(this.href).then((r) => r.blob()).then((b) => new Promise((res) => {
            const fr = new FileReader();
            fr.onload = () => res(fr.result);
            fr.readAsDataURL(b);
          })).then((dataUrl) => window.__descargas.push({ name, dataUrl }))
            .catch((e) => window.__descargas.push({ name, error: String(e) }));
          return;
        }
      } catch {}
      return origClick.apply(this, arguments);
    };
  });

  let ultimoDialog = null;
  page.on("dialog", async (d) => {
    ultimoDialog = d.message();
    console.log(`💬 ALERT: "${d.message()}"`);
    try { await d.accept(); } catch {}
  });

  const ts = ticketId || Date.now();
  async function screenshot(label) {
    try {
      const buf = await page.screenshot({ fullPage: false });
      const u = await subirArchivoR2(buf, `debug/gasolineros_${ts}_${label}_${Date.now()}.png`, "image/png");
      console.log(`📸 [${label}]: ${u}`);
    } catch {}
  }
  const fallo = async (label, error_code, msg) => {
    await screenshot(label).catch(() => {});
    try { await browser.close(); } catch {}
    return { ok: false, error_code, msg };
  };

  try {
    // ── PASO 1 — Estación ─────────────────────────────────────────────────
    console.log("🌐 Cargando portal...");
    await page.goto(PORTAL_URL, { waitUntil: "domcontentloaded", timeout: 40000 });
    await sleep(3500);

    await page.waitForSelector("#MainContent_tabFacturacion_speNumeroEstacion_I", { visible: true, timeout: 20000 });
    await page.click("#MainContent_tabFacturacion_speNumeroEstacion_I");
    await page.keyboard.type(numEstacion, { delay: 70 });
    await sleep(400);
    await page.evaluate(() => document.querySelector("#MainContent_tabFacturacion_btnBuscarEstacion_I").click());

    const trasEstacion = await esperarTexto(page, /Estación seleccionada|no.*(existe|encontr)/i, 25000);
    if (!trasEstacion) {
      return await fallo("p1_sin_respuesta", "reintentar_despues", "Gasolineros.mx: el portal no respondió al buscar la estación");
    }
    if (!/Estación seleccionada/i.test(trasEstacion)) {
      return await fallo("p1_estacion_invalida", "datos_invalidos",
        `Gasolineros.mx: el portal no reconoció la estación ${numEstacion}`);
    }
    const nombreEstacion = (trasEstacion.match(/Estación:\s*([^\n]{0,60})/i) || [])[1] || "";
    console.log(`   ✔️ Estación encontrada: ${nombreEstacion.trim()}`);

    await page.evaluate(() => document.querySelector("#MainContent_tabFacturacion_btnSeleccionaEstacion_I").click());
    await sleep(4000);

    // ── PASO 2 — RFC (el portal autocompleta el domicilio si ya lo conoce) ─
    console.log("🧾 Paso 2 — RFC...");
    const idRfc = await page.evaluate(() => {
      const cand = Array.from(document.querySelectorAll("input[type=text]"))
        .filter((e) => e.offsetParent && !e.id.includes("NumeroEstacion"));
      return cand.length ? cand[0].id : null;
    });
    if (!idRfc) return await fallo("p2_sin_campo_rfc", "reintentar_despues", "Gasolineros.mx: no apareció el campo de RFC");

    await page.click("#" + idRfc);
    await page.keyboard.type(String(rfc), { delay: 60 });
    await sleep(600);
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("input[type=button],button"))
        .find((x) => /^buscar$/i.test((x.value || x.textContent || "").trim()) && x.offsetParent);
      if (b) b.click();
    });
    await sleep(5000);

    const cp = await page.evaluate(() =>
      document.querySelector("#MainContent_tabFacturacion_pnlDatosContribuyente_pnlDatosDomicilio_txtCodigoPostal_I")?.value || "");
    console.log(`   ✔️ Perfil fiscal ${cp ? `autocompletado (CP ${cp})` : "SIN autocompletar"}`);

    const btnSigRfc = await page.$("#MainContent_tabFacturacion_btnIngresaRFC_I");
    if (!btnSigRfc) return await fallo("p2_sin_siguiente", "reintentar_despues", "Gasolineros.mx: no apareció el botón Siguiente tras el RFC");
    await page.evaluate(() => document.querySelector("#MainContent_tabFacturacion_btnIngresaRFC_I").click());
    await sleep(5000);

    // ── PASO 3 — Consumo ──────────────────────────────────────────────────
    console.log("🧾 Paso 3 — consumo...");
    await page.waitForSelector("#MainContent_tabFacturacion_txtNumeroTicket_I", { visible: true, timeout: 20000 });
    await page.click("#MainContent_tabFacturacion_txtNumeroTicket_I");
    await page.keyboard.type(numTicket, { delay: 60 });
    await sleep(300);
    await page.click("#MainContent_tabFacturacion_speImporte_I");
    await page.keyboard.type(monto, { delay: 60 });
    await sleep(300);
    await screenshot("p3_consumo_capturado");

    await page.evaluate(() => document.querySelector("#MainContent_tabFacturacion_btnAgregarTicket_I").click());
    await sleep(1000);

    // El consumo entra como fila en la tabla. OJO: "Sin consumos disponibles"
    // es el estado INICIAL de la tabla, no una señal de error — hay que esperar
    // a que DESAPAREZCA. Antes se esperaba "cualquiera de las dos" y la función
    // devolvía el texto viejo en el primer sondeo, dando por fallido un alta
    // que sí se completaba un segundo después.
    let agregado = false;
    for (let i = 0; i < 12; i++) {
      await sleep(1800);
      const txt = await page.evaluate(() => document.body.innerText || "").catch(() => "");
      if (!/Sin consumos disponibles/i.test(txt)) { agregado = true; break; }
      if (ultimoDialog) break;   // el portal se quejó con un alert
    }
    const trasAgregar = await page.evaluate(() => document.body.innerText || "").catch(() => "");
    if (!agregado) {
      const aviso = ultimoDialog || (trasAgregar.match(/[^\n]*(no se encontr|inv[aá]lid|incorrect|no existe|ya (fue|est[aá]) facturad)[^\n]*/i) || [""])[0];
      return await fallo(
        "p3_consumo_no_agregado",
        /ya (fue|est[aá]) facturad/i.test(aviso) ? "ya_facturado" : "datos_invalidos",
        `Gasolineros.mx: el portal no agregó el consumo ${numTicket} por $${monto}${aviso ? ` — "${aviso.trim().slice(0, 140)}"` : ". Revisa número de secuencia e importe contra la foto del ticket."}`
      );
    }
    console.log("   ✔️ Consumo agregado");

    // Uso CFDI — se elige por la API de cliente de DevExpress, no por clicks:
    // el desplegable no se abre con un .click() sintético y las clases de los
    // items llevan sufijo de tema, así que buscarlos por CSS es frágil. El
    // control expone GetItem(i).value con el código CFDI exacto ("G03", "S01"…).
    const usoElegido = await page.evaluate((codigo) => {
      const col = window.ASPxClientControl && window.ASPxClientControl.GetControlCollection
        ? window.ASPxClientControl.GetControlCollection() : null;
      if (!col) return null;
      const c = col.GetByName("ctl00$MainContent$tabFacturacion$cmbUsoCFDI")
             || col.Get("MainContent_tabFacturacion_cmbUsoCFDI");
      if (!c || !c.GetItemCount) return null;
      const n = c.GetItemCount();
      for (let i = 0; i < n; i++) {
        const it = c.GetItem(i);
        if (it && String(it.value).toUpperCase() === String(codigo).toUpperCase()) {
          c.SetSelectedIndex(i);
          return String(it.text || "").slice(0, 50);
        }
      }
      return null;
    }, uso);
    await sleep(1200);
    console.log(`   ✔️ Uso CFDI: ${usoElegido || "(no se pudo elegir)"}`);
    if (!usoElegido) {
      return await fallo("p3_sin_uso_cfdi", "reintentar_despues",
        `Gasolineros.mx: no se pudo seleccionar el Uso de CFDI ${uso} en el combo`);
    }

    await screenshot("p3_antes_facturar");
    console.log("🧾 Facturando...");
    await page.evaluate(() => document.querySelector("#MainContent_tabFacturacion_btnFacturar_I").click());

    const exito = await esperarTexto(page, /factura.*(generad|emitid|exitos)|descargar|enviad[oa] al correo|xml/i, 60000);
    await screenshot("p4_resultado");

    // "Recibo ya facturado" llega como alert() — y la pantalla de fondo sigue
    // mostrando los botones de descarga, así que la detección de éxito por
    // texto da un falso positivo. Hay que mirar el alert ANTES (visto en el
    // ticket #345, que ya estaba facturado de antes).
    if (/ya\s+facturad|previamente\s+facturad/i.test(ultimoDialog || "")) {
      return await fallo("p4_ya_facturado", "ya_facturado",
        `Gasolineros.mx: el portal dice "${ultimoDialog}" — el CFDI de la secuencia ${numTicket} YA EXISTE pero no lo tenemos. Se puede recuperar con "Reimprimir factura" en el portal, o pidiéndolo a la estación.`);
    }

    if (!exito) {
      return await fallo("p4_sin_confirmacion", "reintentar_despues",
        `Gasolineros.mx: no se confirmó la emisión tras pulsar Facturar${ultimoDialog ? ` — alert: "${ultimoDialog}"` : ""}. Puede haberse generado igual: revisar "Historial de facturas" antes de reintentar.`);
    }

    console.log("✅ Factura generada en el portal");

    // El modal de éxito trae "DESCARGAR XML" y "DESCARGAR PDF". Se pulsan y se
    // recogen los blobs capturados por el hook. Si algo falla, queda el camino
    // por correo (el propio modal dice "tu factura será enviada por correo").
    console.log("📥 Descargando XML y PDF...");
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, a, input[type=button]"))
        .filter((b) => /descargar\s+(xml|pdf)/i.test((b.textContent || b.value || "")) && b.offsetParent !== null);
      btns.forEach((b, i) => setTimeout(() => b.click(), i * 1500));
      return btns.length;
    });

    let descargas = [];
    for (let i = 0; i < 15; i++) {
      await sleep(1200);
      descargas = await page.evaluate(() => window.__descargas || []).catch(() => []);
      if (descargas.filter((d) => d.dataUrl).length >= 2) break;
    }

    let xmlBuf = null, pdfBuf = null;
    for (const d of descargas) {
      if (!d.dataUrl) continue;
      const buf = Buffer.from(d.dataUrl.split(",")[1] || "", "base64");
      if (buf.length < 100) continue;
      const cab = buf.slice(0, 8).toString("latin1");
      if (cab.startsWith("%PDF") || /\.pdf$/i.test(d.name)) pdfBuf = buf;
      else if (cab.includes("<?xml") || /\.xml$/i.test(d.name)) xmlBuf = buf;
    }

    if (xmlBuf || pdfBuf) {
      const marca = `${ts}_${Date.now()}`;
      const xmlUrl = xmlBuf ? await subirArchivoR2(xmlBuf, `facturas/gasolineros_${marca}.xml`, "application/xml") : null;
      const pdfUrl = pdfBuf ? await subirArchivoR2(pdfBuf, `facturas/gasolineros_${marca}.pdf`, "application/pdf") : null;
      await browser.close();
      console.log(`✅ Gasolineros.mx OK — XML: ${xmlUrl} | PDF: ${pdfUrl}`);
      return { ok: true, xmlUrl, pdfUrl };
    }

    console.log("📧 Sin captura directa — queda en manos del correo (IMAP)");
    await browser.close();
    return { ok: true, procesandoCorreo: true };

  } catch (err) {
    console.error("❌ Error en bot Gasolineros.mx:", err.message);
    await screenshot("error").catch(() => {});
    try { await browser.close(); } catch {}
    return { ok: false, msg: `Gasolineros.mx: ${err.message}${ultimoDialog ? ` (alert: "${ultimoDialog}")` : ""}` };
  }
}

module.exports = { facturarGasolineros };
