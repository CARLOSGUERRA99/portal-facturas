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

// ── Helpers de descarga ────────────────────────────────────────────────────

async function descargarArchivos(page, browser, ticketId) {
  const ts = ticketId || Date.now();
  let xmlUrl = null, pdfUrl = null;

  const cookies   = await page.cookies();
  const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join("; ");

  async function fetchConCookies(url) {
    const data = await page.evaluate(async (u, ck) => {
      try {
        const r = await fetch(u, { headers: { Cookie: ck }, credentials: "include" });
        const arr = await r.arrayBuffer();
        return { ct: r.headers.get("content-type") || "", bytes: Array.from(new Uint8Array(arr)), ok: r.ok };
      } catch (e) { return { error: e.message }; }
    }, url, cookieStr).catch(() => null);
    if (!data || data.error || !data.bytes) {
      console.log(`⚠️ fetch error para ${url}:`, data?.error);
      return null;
    }
    const buf = Buffer.from(data.bytes);
    console.log(`📄 ${url} → ct: ${data.ct} | size: ${buf.length} | preview: ${buf.toString("latin1", 0, 5)}`);
    return buf;
  }

  // Intentar obtener links de descarga visibles en la página
  const links = await page.$$eval("a", els =>
    els.map(el => ({
      text: el.textContent.trim().toUpperCase(),
      href: el.href,
      download: el.getAttribute("download") || ""
    }))
  ).catch(() => []);

  console.log("🔗 Links de descarga encontrados:", JSON.stringify(links.filter(l =>
    l.href && (l.href.includes("xml") || l.href.includes("pdf") ||
               l.text.includes("XML") || l.text.includes("PDF"))
  )));

  // Buscar link XML
  const xmlLink = links.find(l =>
    l.text.includes("XML") ||
    l.href.toLowerCase().includes(".xml") ||
    l.download.toLowerCase().includes(".xml")
  );

  // Buscar link PDF
  const pdfLink = links.find(l =>
    l.text.includes("PDF") ||
    l.href.toLowerCase().includes(".pdf") ||
    l.download.toLowerCase().includes(".pdf")
  );

  if (xmlLink && xmlLink.href) {
    console.log("🔗 URL XML:", xmlLink.href);
    const buf = await fetchConCookies(xmlLink.href);
    if (buf && buf.length > 200) {
      const preview = buf.toString("utf8", 0, 10);
      if (preview.includes("<?") || preview.includes("<cfdi") || preview.includes("<Comprobante")) {
        xmlUrl = await subirArchivoR2(buf, `facturas/autozonedemexico_${ts}.xml`, "application/xml");
        console.log("✅ XML subido:", xmlUrl);
      } else {
        console.log("⚠️ Respuesta no parece XML — preview:", preview);
      }
    }
  }

  if (pdfLink && pdfLink.href) {
    console.log("🔗 URL PDF:", pdfLink.href);
    const directBuf = await fetchConCookies(pdfLink.href);
    if (directBuf && directBuf.toString("latin1", 0, 4) === "%PDF") {
      pdfUrl = await subirArchivoR2(directBuf, `facturas/autozonedemexico_${ts}.pdf`, "application/pdf");
      console.log("✅ PDF directo subido:", pdfUrl);
    } else {
      // Intentar interceptar abriendo en nueva pestaña
      console.log("ℹ️ Intentando interceptar PDF en nueva pestaña...");
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

      await pdfPage.goto(pdfLink.href, { waitUntil: "networkidle2", timeout: 20000 }).catch(() => {});
      await pdfPage.waitForTimeout(3000);

      if (pdfBuffer) {
        pdfUrl = await subirArchivoR2(pdfBuffer, `facturas/autozonedemexico_${ts}.pdf`, "application/pdf");
        console.log("✅ PDF (interceptado) subido:", pdfUrl);
      } else {
        console.log("ℹ️ PDF no interceptado — se procesará por IMAP");
      }
      await pdfPage.close().catch(() => {});
    }
  }

  // Intentar interceptar via respuestas AJAX/fetch si no hay links directos
  if (!xmlUrl && !pdfUrl) {
    console.log("ℹ️ No se encontraron links directos — buscando en el DOM alternativo...");

    // Buscar botones o iframes con PDF/XML embebido
    const iframeSrc = await page.$eval("iframe", el => el.src).catch(() => null);
    if (iframeSrc) {
      console.log("🔗 iframe src:", iframeSrc);
      if (iframeSrc.toLowerCase().includes("pdf")) {
        const buf = await fetchConCookies(iframeSrc);
        if (buf && buf.toString("latin1", 0, 4) === "%PDF") {
          pdfUrl = await subirArchivoR2(buf, `facturas/autozonedemexico_${ts}.pdf`, "application/pdf");
          console.log("✅ PDF (iframe) subido:", pdfUrl);
        }
      }
    }
  }

  console.log(`📊 Descarga directa — XML: ${!!xmlUrl} | PDF: ${!!pdfUrl}`);
  return { xmlUrl, pdfUrl };
}

// ── Bot principal ─────────────────────────────────────────────────────────

async function facturarAutozoneDeMexico({
  rfc,
  razonSocial,
  regimenFiscal,
  usoCfdi,
  ticketId,
  folio,
  fecha,
  total,
  codigoPostal,
  barcode,
  portalUrl
}) {
  console.log("🤖 Iniciando bot AutoZone de México...");
  console.log(`   Folio: ${folio} | Fecha: ${fecha} | Total: ${total} | RFC: ${rfc}`);

  const url = (portalUrl && portalUrl.startsWith("http"))
    ? portalUrl
    : "https://autozone.cdc.origon.cloud/facturacion/autozone";
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

  // Acumular respuestas de red para PDF/XML interceptados antes de que aparezcan links
  let interceptedPdfBuffer = null;
  let interceptedXmlBuffer = null;

  await page.setRequestInterception(true);
  page.on("request", req => req.continue());
  page.on("response", async resp => {
    try {
      const ct = resp.headers()["content-type"] || "";
      const respUrl = resp.url();
      if (ct.includes("pdf") || (ct.includes("octet-stream") && respUrl.toLowerCase().includes("pdf"))) {
        const b = await resp.buffer().catch(() => null);
        if (b && b.length > 500 && !interceptedPdfBuffer) {
          interceptedPdfBuffer = b;
          console.log(`📄 PDF interceptado en red: ${b.length} bytes`);
        }
      }
      if (ct.includes("xml") || (ct.includes("octet-stream") && respUrl.toLowerCase().includes("xml"))) {
        const b = await resp.buffer().catch(() => null);
        if (b && b.length > 200 && !interceptedXmlBuffer) {
          const preview = b.toString("utf8", 0, 10);
          if (preview.includes("<?") || preview.includes("<cfdi") || preview.includes("<Comprobante")) {
            interceptedXmlBuffer = b;
            console.log(`📄 XML interceptado en red: ${b.length} bytes`);
          }
        }
      }
    } catch {}
  });

  async function screenshot(label) {
    try {
      const buf = await page.screenshot({ fullPage: false });
      const u = await subirArchivoR2(buf, `debug/autozonedemexico_${label}_${Date.now()}.png`, "image/png");
      console.log(`📸 [${label}]: ${u}`);
    } catch {}
  }

  // Helper para esperar selectores alternativos (lista de opciones CSS)
  async function waitForAny(selectors, timeout = 15000) {
    return Promise.race(
      selectors.map(sel =>
        page.waitForSelector(sel, { visible: true, timeout }).then(() => sel).catch(() => null)
      )
    ).then(found => found || null);
  }

  try {
    // ── PASO 1 — Cargar portal ─────────────────────────────────────────────
    console.log("🌐 Cargando portal AutoZone...");
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    await page.waitForTimeout(2000);
    await screenshot("paso1_cargado");
    console.log("✅ Portal cargado");

    // ── PASO 2 — Manejar splash/welcome screen con botón Iniciar ──────────
    console.log("🔍 Buscando pantalla de bienvenida...");

    const splashSelector = await waitForAny([
      "button.btn-iniciar",
      ".btn-iniciar",
      "a.btn-iniciar",
      "button[data-action='iniciar']",
      ".inicio-btn",
      ".welcome-btn",
      ".hero-btn",
      "a.arrow-down",
      ".arrow-down",
      ".scroll-down",
    ], 5000);

    if (splashSelector) {
      console.log(`✅ Pantalla splash detectada con: ${splashSelector}`);
      await page.click(splashSelector);
      await page.waitForTimeout(1500);
      await screenshot("paso2_post_iniciar");
    } else {
      // Buscar por texto del botón "Iniciar"
      const iniciarByText = await page.evaluateHandle(() => {
        const btns = [...document.querySelectorAll("button, a, input[type='submit'], input[type='button']")];
        return btns.find(b =>
          b.textContent.trim().toLowerCase().includes("iniciar") ||
          b.value?.toLowerCase().includes("iniciar")
        ) || null;
      });
      const iniciarEl = iniciarByText.asElement ? iniciarByText.asElement() : null;
      if (iniciarEl) {
        console.log("✅ Botón Iniciar encontrado por texto");
        await iniciarEl.click();
        await page.waitForTimeout(1500);
        await screenshot("paso2_post_iniciar_texto");
      } else {
        console.log("ℹ️ No hay splash visible — continuando directamente al formulario");
      }
    }

    // ── PASO 3 — Esperar formulario paso 1 (datos del ticket) ─────────────
    console.log("⏳ Esperando formulario del ticket...");

    const formSelector = await waitForAny([
      "input[name='folio']",
      "#folio",
      "input[name='ticket']",
      "#ticket",
      "input[name='barcode']",
      "#barcode",
      "input[placeholder*='folio' i]",
      "input[placeholder*='ticket' i]",
      "input[placeholder*='código' i]",
      "form input[type='text']",
    ], 15000);

    if (!formSelector) {
      throw new Error("No se encontró el formulario de datos del ticket en el paso 1");
    }
    console.log(`✅ Formulario paso 1 detectado con: ${formSelector}`);
    await screenshot("paso3_formulario_ticket");

    // ── PASO 4 — Llenar datos del ticket ──────────────────────────────────
    console.log("📋 Llenando datos del ticket...");

    // Folio
    const folioSelectors = [
      "input[name='folio']", "#folio",
      "input[name='ticket']", "#ticket",
      "input[placeholder*='folio' i]", "input[placeholder*='ticket' i]"
    ];
    let folioFilled = false;
    for (const sel of folioSelectors) {
      const exists = await page.$(sel).catch(() => null);
      if (exists) {
        await fillInput(page, sel, folio || "");
        folioFilled = true;
        break;
      }
    }
    if (!folioFilled) console.log("⚠️ Campo folio no encontrado con selectores conocidos");

    // Fecha
    const fechaSelectors = [
      "input[name='fecha']", "#fecha",
      "input[type='date']",
      "input[placeholder*='fecha' i]",
      "input[placeholder*='DD' i]",
      "input[name='date']", "#date"
    ];
    let fechaFilled = false;
    for (const sel of fechaSelectors) {
      const exists = await page.$(sel).catch(() => null);
      if (exists) {
        // Detectar si es datepicker jQuery UI
        const isDatepicker = await page.$eval(sel, el =>
          el.classList.contains("datepicker") ||
          el.getAttribute("data-toggle") === "datepicker" ||
          el.getAttribute("autocomplete") === "off"
        ).catch(() => false);

        if (isDatepicker) {
          console.log(`📅 Datepicker detectado en ${sel}`);
          // Intentar establecer valor directamente
          await page.$eval(sel, (el, val) => {
            el.value = val;
            el.dispatchEvent(new Event("change", { bubbles: true }));
            el.dispatchEvent(new Event("input",  { bubbles: true }));
            // Trigger jQuery si está disponible
            if (window.jQuery) {
              try { window.jQuery(el).trigger("change"); } catch {}
            }
          }, fecha || "");
          await page.waitForTimeout(500);
        } else {
          await fillInput(page, sel, fecha || "");
        }
        fechaFilled = true;
        break;
      }
    }
    if (!fechaFilled) console.log("⚠️ Campo fecha no encontrado con selectores conocidos");

    // Total
    const totalSelectors = [
      "input[name='total']", "#total",
      "input[name='monto']", "#monto",
      "input[name='importe']", "#importe",
      "input[placeholder*='total' i]", "input[placeholder*='monto' i]"
    ];
    let totalFilled = false;
    for (const sel of totalSelectors) {
      const exists = await page.$(sel).catch(() => null);
      if (exists) {
        await fillInput(page, sel, parseFloat(total || 0).toFixed(2));
        totalFilled = true;
        break;
      }
    }
    if (!totalFilled) console.log("⚠️ Campo total no encontrado con selectores conocidos");

    // Código de barras (opcional/alternativo)
    const barcodeSelectors = [
      "input[name='barcode']", "#barcode",
      "input[name='codigoBarras']", "#codigoBarras",
      "input[placeholder*='barras' i]", "input[placeholder*='código' i]"
    ];
    for (const sel of barcodeSelectors) {
      const exists = await page.$(sel).catch(() => null);
      if (exists) {
        const val = barcode || folio || "";
        if (val) {
          await fillInput(page, sel,