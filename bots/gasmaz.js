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
// Los links usan javascript:DownloadInvoice/ShowInvoiceReport — se intercepta
// directamente en el contexto del browser sobreescribiendo fetch y XHR.
async function descargarArchivos(page, browser, ticketId) {
  const ts = ticketId || Date.now();
  let xmlUrl = null, pdfUrl = null;

  const links = await page.$$eval("#divFiles a", els =>
    els.map(el => ({ text: el.textContent.trim().toUpperCase(), href: el.href }))
  );
  console.log("🔗 Links en #divFiles:", JSON.stringify(links));

  // Loggear el código fuente de las funciones JS para entender qué endpoint usan
  const fnSources = await page.evaluate(() => {
    const fns = ["DownloadInvoice", "ShowInvoiceReport"];
    return Object.fromEntries(fns.map(n => [n, window[n]?.toString().substring(0, 400) || null]));
  });
  console.log("🔍 Funciones JS:", JSON.stringify(fnSources));

  // Inyectar interceptor en el contexto del browser ANTES de hacer click:
  // sobreescribe fetch y XMLHttpRequest para capturar respuestas binarias.
  await page.evaluate(() => {
    window.__gmCaptures = [];

    const origFetch = window.fetch;
    window.fetch = async function(...args) {
      const resp = await origFetch.apply(this, args);
      try {
        const clone = resp.clone();
        const buf = await clone.arrayBuffer();
        if (buf.byteLength > 200) {
          window.__gmCaptures.push({
            url: resp.url,
            ct: resp.headers.get("content-type") || "",
            bytes: Array.from(new Uint8Array(buf)),
          });
        }
      } catch {}
      return resp;
    };

    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
      this._gmUrl = url;
      this.responseType = "arraybuffer"; // forzar binario para capturar
      return origOpen.apply(this, arguments);
    };
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function(body) {
      this.addEventListener("load", function() {
        try {
          const resp = this.response;
          if (resp instanceof ArrayBuffer && resp.byteLength > 200) {
            window.__gmCaptures.push({
              url: this._gmUrl || this.responseURL || "",
              ct: this.getResponseHeader("content-type") || "",
              bytes: Array.from(new Uint8Array(resp)),
            });
          }
        } catch {}
      });
      return origSend.apply(this, arguments);
    };
  });

  // Click XML
  await page.evaluate(() => {
    const link = [...document.querySelectorAll("#divFiles a")]
      .find(l => l.textContent.trim().toUpperCase().includes("XML"));
    if (link) link.click();
  });
  await page.waitForTimeout(6000);

  // Click PDF
  await page.evaluate(() => {
    const link = [...document.querySelectorAll("#divFiles a")]
      .find(l => l.textContent.trim().toUpperCase().includes("PDF"));
    if (link) link.click();
  });
  await page.waitForTimeout(6000);

  // Recuperar capturas del contexto del browser
  const captures = await page.evaluate(() => window.__gmCaptures || []);
  console.log(`📥 Capturas en browser context: ${captures.length}`);

  for (const c of captures) {
    const buf = Buffer.from(c.bytes);
    const preview = buf.toString("utf8", 0, 10);
    const isXml = c.ct.includes("xml") || c.url.includes(".xml") || preview.startsWith("<?xml") || preview.startsWith("<cfdi");
    const isPdf = c.ct.includes("pdf") || c.url.includes(".pdf") || buf.slice(0, 4).toString() === "%PDF";
    console.log(`   url: ${c.url} | ct: ${c.ct} | size: ${buf.length} | isXml: ${isXml} | isPdf: ${isPdf}`);

    if (isXml && !xmlUrl) {
      xmlUrl = await subirArchivoR2(buf, `facturas/gasmaz_${ts}.xml`, "application/xml");
      console.log("✅ XML subido:", xmlUrl);
    } else if (isPdf && !pdfUrl) {
      pdfUrl = await subirArchivoR2(buf, `facturas/gasmaz_${ts}.pdf`, "application/pdf");
      console.log("✅ PDF subido:", pdfUrl);
    }
  }

  // Fallback: Puppeteer targetcreated (si el portal abrió nueva pestaña)
  if (!xmlUrl && !pdfUrl) {
    console.log("⚠️ Sin capturas — sin archivos disponibles en este intento");
  }

  // Fallback: fetch con cookies para links con URL directa (no javascript:)
  if (!xmlUrl || !pdfUrl) {
    console.log("⚠️ Intentando fallback fetch con cookies...");
    const cookies   = await page.cookies();
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join("; ");
    for (const { text, href } of links) {
      if (!href || href.startsWith("javascript:")) continue;
      const bytes = await page.evaluate(async (url, cookie) => {
        const r   = await fetch(url, { headers: { Cookie: cookie } });
        const arr = await r.arrayBuffer();
        return Array.from(new Uint8Array(arr));
      }, href, cookieStr).catch(() => null);
      if (!bytes || bytes.length < 100) continue;
      const buf = Buffer.from(bytes);
      if (text.includes("XML") && !xmlUrl) {
        xmlUrl = await subirArchivoR2(buf, `facturas/gasmaz_${ts}.xml`, "application/xml");
        console.log("✅ XML subido (fetch):", xmlUrl);
      } else if (text.includes("PDF") && !pdfUrl) {
        pdfUrl = await subirArchivoR2(buf, `facturas/gasmaz_${ts}.pdf`, "application/pdf");
        console.log("✅ PDF subido (fetch):", pdfUrl);
      }
    }
  }

  return { xmlUrl, pdfUrl };
}

// ── Bot principal ─────────────────────────────────────────────────────────

async function facturarGasmaz({ referencia, folio, total, rfc, razonSocial, regimenFiscal, usoCfdi, ticketId, portalUrl }) {
  console.log("🤖 Iniciando bot Gasmaz/NexusFuel...");
  console.log(`   Referencia: ${referencia} | Folio: ${folio} | Total: ${total} | RFC: ${rfc}`);

  const url = (portalUrl && portalUrl.startsWith("http")) ? portalUrl : "https://redmaxfactura.nexusfuel.mx/";
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
