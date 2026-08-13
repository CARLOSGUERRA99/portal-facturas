const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");

// ── Helpers reutilizables ──────────────────────────────────────────────────

async function fillInput(page, selector, value) {
  await page.click(selector);
  await page.waitForTimeout(150);
  await page.keyboard.down("Control");
  await page.keyboard.press("a");
  await page.keyboard.up("Control");
  await page.keyboard.press("Delete");
  await page.waitForTimeout(80);
  await page.keyboard.type(String(value), { delay: 60 });
  await page.waitForTimeout(150);
  const actual = await page.$eval(selector, el => el.value).catch(() => "?");
  console.log(`📝 ${selector}: "${actual}"`);
}

// Selecciona la primera opción cuyo texto contiene alguna de las keywords (case-insensitive)
async function selectByText(page, selector, keywords) {
  const found = await page.$eval(selector, (el, kws) => {
    const opt = Array.from(el.options).find(o =>
      kws.some(k => o.text.toLowerCase().includes(k.toLowerCase()))
    );
    if (!opt) return null;
    el.value = opt.value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("input",  { bubbles: true }));
    return opt.text;
  }, keywords);
  console.log(`📝 ${selector}: "${found || "NO ENCONTRADO"}"`);
  return !!found;
}

// Descarga XML y PDF desde #divFiles.
// DownloadInvoice abre ../DownloadInvoice.aspx en un iframe oculto ('hiddenExportFrame').
// ShowInvoiceReport abre ../Report/ReportViewer.aspx (visor HTML).
// Construimos las URLs directamente desde los parámetros del href y fetcheamos con cookies.
async function descargarArchivos(page, browser, ticketId) {
  const ts = ticketId || Date.now();
  let xmlUrl = null, pdfUrl = null;

  const links = await page.$$eval("#divFiles a", els =>
    els.map(el => ({ text: el.textContent.trim().toUpperCase(), href: el.href }))
  );
  console.log("🔗 Links en #divFiles:", JSON.stringify(links));

  // URL base del portal (un nivel arriba de la página actual, igual que '../')
  const pageUrl = page.url();
  const baseUrl = new URL("../", pageUrl).href;
  console.log(`🌐 Base URL: ${baseUrl} (página actual: ${pageUrl})`);

  const cookies   = await page.cookies();
  const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join("; ");

  // Helper: fetch con cookies en el contexto del browser, devuelve Buffer o null
  async function fetchConCookies(url) {
    const data = await page.evaluate(async (u, ck) => {
      try {
        const r = await fetch(u, { headers: { Cookie: ck }, credentials: "include" });
        const arr = await r.arrayBuffer();
        return { ct: r.headers.get("content-type") || "", bytes: Array.from(new Uint8Array(arr)), ok: r.ok };
      } catch (e) { return { error: e.message }; }
    }, url, cookieStr).catch(() => null);
    if (!data || data.error || !data.bytes) { console.log(`⚠️ fetch error para ${url}:`, data?.error); return null; }
    const buf = Buffer.from(data.bytes);
    console.log(`📄 ${url} → ct: ${data.ct} | size: ${buf.length} | preview: ${buf.toString("latin1", 0, 5)}`);
    return buf;
  }

  // ── XML: DownloadInvoice('FILENAME.xml', stationId) ──────────────────────
  const xmlLink = links.find(l => l.text.includes("XML"));
  if (xmlLink) {
    const m = xmlLink.href.match(/DownloadInvoice\('([^']+)',\s*(\d+)\)/);
    if (m) {
      const fileName    = m[1];
      const stationId   = m[2];
      const fiscalFolioId = fileName.split("_")[3]?.replace(".xml", "");
      const xmlDlUrl = `${baseUrl}DownloadInvoice.aspx?fiscalFolioId=${fiscalFolioId}&stationId=${stationId}`;
      console.log("🔗 URL XML:", xmlDlUrl);
      const buf = await fetchConCookies(xmlDlUrl);
      if (buf && buf.length > 200) {
        const preview = buf.toString("utf8", 0, 10);
        if (preview.includes("<?") || preview.includes("<cfdi") || preview.includes("<Comprobante")) {
          xmlUrl = await subirArchivoR2(buf, `facturas/gasmaz_${ts}.xml`, "application/xml");
          console.log("✅ XML subido:", xmlUrl);
        } else {
          console.log("⚠️ Respuesta no parece XML — preview:", preview);
        }
      }
    }
  }

  // ── PDF: ShowInvoiceReport abre ReportViewer HTML que internamente carga el PDF
  //   Estrategia: abrir la URL en una nueva página, interceptar respuestas PDF.
  const pdfLink = links.find(l => l.text.includes("PDF"));
  if (pdfLink) {
    const m = pdfLink.href.match(/ShowInvoiceReport\('([^']+)',\s*(\d+),\s*(true|false)\)/);
    if (m) {
      const fileName      = m[1];
      const stationId     = m[2];
      const isStationNum  = m[3] === "true";
      const fiscalFolioId = fileName.split("_")[3]?.replace(".xml", "");
      let pdfViewUrl = `${baseUrl}Report/ReportViewer.aspx?rptId=DigitalInvoiceReport&fiscalFolioId=${fiscalFolioId}`;
      pdfViewUrl += isStationNum ? `&stationNumber=${stationId}` : `&stationId=${stationId}`;
      console.log("🔗 URL PDF (viewer):", pdfViewUrl);

      // Intentar fetch directo primero (a veces devuelve %PDF)
      const directBuf = await fetchConCookies(pdfViewUrl);
      if (directBuf && directBuf.toString("latin1", 0, 4) === "%PDF") {
        pdfUrl = await subirArchivoR2(directBuf, `facturas/gasmaz_${ts}.pdf`, "application/pdf");
        console.log("✅ PDF directo subido:", pdfUrl);
      } else {
        // Abrir en nueva página e interceptar respuestas con content-type PDF
        console.log("ℹ️ ReportViewer es HTML — abriendo nueva pestaña para interceptar PDF...");
        const pdfPage = await browser.newPage();
        let pdfBuffer = null;

        await pdfPage.setRequestInterception(true);
        pdfPage.on("request", req => req.continue());
        pdfPage.on("response", async resp => {
          try {
            const ct = resp.headers()["content-type"] || "";
            if (ct.includes("pdf") || ct.includes("octet-stream")) {
              const b = await resp.buffer().catch(() => null);
              if (b && b.length > 500 && !pdfBuffer) {
                pdfBuffer = b;
                console.log(`📄 PDF interceptado: ${b.length} bytes`);
              }
            }
          } catch {}
        });

        await pdfPage.goto(pdfViewUrl, { waitUntil: "networkidle2", timeout: 20000 }).catch(() => {});
        await pdfPage.waitForTimeout(3000);

        if (pdfBuffer) {
          pdfUrl = await subirArchivoR2(pdfBuffer, `facturas/gasmaz_${ts}.pdf`, "application/pdf");
          console.log("✅ PDF (interceptado) subido:", pdfUrl);
        } else {
          console.log("ℹ️ PDF no interceptado en ReportViewer — se procesará por IMAP");
        }
        await pdfPage.close().catch(() => {});
      }
    }
  }

  console.log(`📊 Descarga directa — XML: ${!!xmlUrl} | PDF: ${!!pdfUrl}`);
  return { xmlUrl, pdfUrl };
}

// ── Bot principal ─────────────────────────────────────────────────────────

async function facturarGasmaz({ referencia, folio, total, rfc, razonSocial, regimenFiscal, usoCfdi, ticketId, portalUrl }) {
  console.log("🤖 Iniciando bot Gasmaz/NexusFuel...");
  console.log(`   Referencia: ${referencia} | Folio: ${folio} | Total: ${total} | RFC: ${rfc}`);

  // NexusFuel da un subdominio por marca: gasmazfactura., redmaxfactura.,
  // petrofiguesfactura.… todo junto, sin punto entre el nombre y "factura".
  // El OCR mete un punto de más al leerlo ("gasmaz.factura.nexusfuel.mx") y ese
  // host NO existe: el ticket #243 murió con ERR_NAME_NOT_RESOLVED, que parece
  // un portal caído cuando en realidad es una letra mal leída.
  const arreglarNexus = (u) => String(u || "")
    .replace(/([a-z0-9]+)\.factura\.nexusfuel\.mx/i, "$1factura.nexusfuel.mx")
    .replace(/([a-z0-9]+)factura\.\s*nexusfuel/i, "$1factura.nexusfuel");

  let url = (portalUrl && portalUrl.startsWith("http")) ? portalUrl : "https://redmaxfactura.nexusfuel.mx/";
  const urlArreglada = arreglarNexus(url);
  if (urlArreglada !== url) console.log(`🔧 URL corregida: ${url} → ${urlArreglada}`);
  url = urlArreglada;
  console.log("🌐 URL portal:", url);

  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error("BROWSERLESS_TOKEN no definido");

  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true`,
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
  );
  await page.setExtraHTTPHeaders({ "Accept-Language": "es-MX,es;q=0.9,en;q=0.8" });

  async function screenshot(label) {
    try {
      const buf = await page.screenshot({ fullPage: false });
      const u = await subirArchivoR2(buf, `debug/gasmaz_${label}_${Date.now()}.png`, "image/png");
      console.log(`📸 [${label}]: ${u}`);
    } catch {}
  }

  try {
    // ── PASO 1 — Cargar portal ────────────────────────────────────────────
    console.log("🌐 Cargando portal...");
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    await page.waitForSelector("#txtReferencia", { timeout: 15000 });
    await screenshot("paso1_cargado");
    console.log("✅ Portal cargado");

    // ── PASO 2 — Llenar campos del paso 1 ────────────────────────────────
    console.log("📋 Llenando campos del ticket...");
    await fillInput(page, "#txtReferencia", referencia);
    await fillInput(page, "#txtFolio",      folio);
    await fillInput(page, "#txtAmount",     parseFloat(total).toFixed(2));
    await fillInput(page, "#txtRFC",        rfc);
    await screenshot("paso2_campos_ticket");

    // ── PASO 3 — Click en Buscar y detectar caso ──────────────────────────
    console.log("🔍 Haciendo click en Buscar...");
    await page.click("#btnNext");
    await page.waitForTimeout(500);

    console.log("⏳ Esperando respuesta del portal...");
    const caso = await Promise.race([
      page.waitForSelector("#txtName", { visible: true, timeout: 15000 })
        .then(() => "paso2"),
      page.waitForSelector("#divDocumentsDownload", { visible: true, timeout: 15000 })
        .then(() => "ya_facturado"),
      page.waitForFunction(
        () => document.body.innerText.toLowerCase().includes("ya fue facturado"),
        { timeout: 15000 }
      ).then(() => "ya_facturado"),
    ]).catch(() => "timeout");

    await screenshot("paso3_resultado");
    console.log(`📍 Caso detectado: ${caso}`);

    // ── Caso: folio ya facturado — recuperar archivos existentes ──────────
    if (caso === "ya_facturado") {
      console.log("♻️ Folio ya facturado — recuperando archivos existentes...");
      await page.waitForSelector("#divFiles", { visible: true, timeout: 10000 });
      const { xmlUrl, pdfUrl } = await descargarArchivos(page, browser, ticketId);
      await browser.close();

      if (!xmlUrl && !pdfUrl) {
        console.log("⚠️ Sin archivos en folio ya facturado — IMAP recogerá del correo");
        return { ok: true, procesandoCorreo: true };
      }
      console.log(`✅ Gasmaz (ya facturado) — PDF: ${pdfUrl} | XML: ${xmlUrl}`);
      return { ok: true, xmlUrl, pdfUrl, yaExistia: true };
    }

    if (caso === "timeout") {
      throw new Error("El portal no respondió tras hacer click en Buscar (timeout 15s)");
    }

    // ── PASO 4 — Llenar datos de facturación (caso normal) ────────────────
    console.log("📋 Llenando datos de facturación...");

    if (razonSocial) await fillInput(page, "#txtName", razonSocial);
    await fillInput(page, "#txtEmail", "buzonfacturas@serviciosga.site");

    // Régimen fiscal
    const regimenKeywords = regimenFiscal
      ? [String(regimenFiscal)]
      : ["601", "General de Ley Personas Morales", "General de Ley"];
    await page.waitForSelector("#selFiscalRegime", { visible: true, timeout: 10000 });
    await selectByText(page, "#selFiscalRegime", regimenKeywords);

    // Uso CFDI — esperar carga AJAX tras seleccionar régimen
    console.log("⏳ Esperando opciones de Uso CFDI (carga AJAX)...");
    await page.waitForFunction(
      () => { const s = document.querySelector("#selVoucherUse"); return s && s.options.length > 1; },
      { timeout: 15000 }
    );
    console.log(`✅ Opciones CFDI cargadas: ${await page.$eval("#selVoucherUse", el => el.options.length)}`);

    const CFDI_KEYWORDS = {
      G01: ["Adquisición de mercancias", "Adquisicion de mercancias"],
      G03: ["Gastos en general"],
      G02: ["Devoluciones, descuentos"],
      S01: ["Sin efectos fiscales"],
      CP01: ["Pagos"],
    };
    const cfdiKeywords = (usoCfdi && CFDI_KEYWORDS[String(usoCfdi).toUpperCase()])
      ? CFDI_KEYWORDS[String(usoCfdi).toUpperCase()]
      : ["Gastos en general"];
    await selectByText(page, "#selVoucherUse", cfdiKeywords);

    const cfdiVal = await page.$eval("#selVoucherUse", el => el.value);
    if (!cfdiVal || cfdiVal === "" || cfdiVal === "undefined") {
      const opciones = await page.$eval("#selVoucherUse", el =>
        Array.from(el.options).map(o => o.text).join(" | ")
      );
      throw new Error(`Uso CFDI no seleccionado — opciones: ${opciones}`);
    }
    console.log(`✅ Uso CFDI: "${cfdiVal}"`);

    await selectByText(page, "#selPaymentWay", ["débito", "debito", "Tarjeta de déb"]);
    await screenshot("paso4_datos_facturacion");
    console.log("✅ Datos de facturación completos");

    // ── PASO 5 — Click en Facturar ────────────────────────────────────────
    console.log("🧾 Haciendo click en Facturar...");

    page.on("dialog", async dialog => {
      console.log("🔔 Dialog:", dialog.message());
      await dialog.accept();
    });

    const facturarBtn = await page.evaluateHandle(() =>
      [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Facturar")
    );
    const btnEl = facturarBtn.asElement();
    if (!btnEl) throw new Error("No se encontró el botón 'Facturar'");
    await btnEl.click();
    console.log("✅ Click en Facturar");

    await Promise.race([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 20000 }),
      page.waitForSelector("#divFiles",             { visible: true, timeout: 20000 }),
      page.waitForSelector("#divDocumentsDownload", { visible: true, timeout: 20000 }),
      page.waitForSelector(".alert-success, #pConfirmationMessage", { visible: true, timeout: 20000 }),
    ]).catch(() => console.log("⚠️ Sin navegación tras Facturar, continuando..."));

    await page.waitForTimeout(3000);
    await screenshot("paso5_post_facturar");

    // ── PASO 6 — Descargar PDF y XML ──────────────────────────────────────
    console.log("⏳ Esperando pantalla de descarga...");
    await page.waitForSelector("#divFiles", { visible: true, timeout: 20000 });
    await screenshot("paso6_descarga");

    const { xmlUrl, pdfUrl } = await descargarArchivos(page, browser, ticketId);
    await browser.close();

    if (!xmlUrl && !pdfUrl) {
      console.log("⚠️ Sin archivos directos — IMAP recogerá del correo");
      return { ok: true, procesandoCorreo: true };
    }

    console.log(`✅ Gasmaz OK — PDF: ${pdfUrl} | XML: ${xmlUrl}`);
    return { ok: true, xmlUrl, pdfUrl };

  } catch (err) {
    console.error("❌ Error en bot Gasmaz:", err.message);
    await screenshot("error").catch(() => {});
    try { await browser.close(); } catch {}
    return { ok: false, msg: err.message };
  }
}

module.exports = { facturarGasmaz };
