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

// ── Bot principal ─────────────────────────────────────────────────────────

async function facturarAllegroCaffeZonaDoradaTxutxuFood({ rfc, razonSocial, regimenFiscal, usoCfdi, ticketId, folio, fecha, total, barcode, cp, portalUrl }) {
  console.log("🤖 Iniciando bot Allegro Caffe Zona Dorada / Txutxu Food (mefacturo.mx)...");
  console.log(`   RFC: ${rfc} | Razón Social: ${razonSocial} | Folio: ${folio} | Total: ${total}`);

  const url = (portalUrl && portalUrl.startsWith("http")) ? portalUrl : "https://mefacturo.mx/allegrezonadorada";
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
      const u = await subirArchivoR2(buf, `debug/allegrocaffezonadoradatxutxufo_${label}_${Date.now()}.png`, "image/png");
      console.log(`📸 [${label}]: ${u}`);
    } catch {}
  }

  // Helper para intentar múltiples selectores y devolver el que existe
  async function resolveSelector(candidates, timeout = 5000) {
    for (const sel of candidates) {
      try {
        await page.waitForSelector(sel, { visible: true, timeout });
        const el = await page.$(sel);
        if (el) {
          console.log(`✅ Selector resuelto: ${sel}`);
          return sel;
        }
      } catch {}
    }
    return null;
  }

  // Helper para llenar input intentando varios selectores
  async function fillInputMulti(candidates, value) {
    for (const sel of candidates) {
      try {
        const el = await page.$(sel);
        if (el) {
          await fillInput(page, sel, value);
          return sel;
        }
      } catch {}
    }
    console.log(`⚠️ No se encontró ningún selector para valor: ${value}`);
    return null;
  }

  // Helper: fetch con cookies en el contexto del browser, devuelve Buffer o null
  async function fetchConCookies(url) {
    const cookies = await page.cookies();
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join("; ");
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

  // Helper: intentar descargar archivos PDF/XML desde links presentes en la página
  async function descargarArchivos() {
    const ts = ticketId || Date.now();
    let xmlUrl = null;
    let pdfUrl = null;

    // Buscar todos los links en la página
    const links = await page.$$eval("a", els =>
      els.map(el => ({ text: el.textContent.trim().toUpperCase(), href: el.href || "" }))
        .filter(l => l.href && l.href !== "#" && l.href !== "javascript:void(0)")
    ).catch(() => []);

    console.log("🔗 Links encontrados:", JSON.stringify(links));

    // Buscar link XML
    const xmlLink = links.find(l =>
      l.text.includes("XML") ||
      l.href.toLowerCase().includes(".xml") ||
      l.href.toLowerCase().includes("xml")
    );

    // Buscar link PDF
    const pdfLink = links.find(l =>
      l.text.includes("PDF") ||
      l.href.toLowerCase().includes(".pdf") ||
      l.href.toLowerCase().includes("pdf")
    );

    // Descargar XML
    if (xmlLink && xmlLink.href) {
      console.log("🔗 URL XML:", xmlLink.href);
      const buf = await fetchConCookies(xmlLink.href);
      if (buf && buf.length > 200) {
        const preview = buf.toString("utf8", 0, 20);
        if (preview.includes("<?") || preview.includes("<cfdi") || preview.includes("<Comprobante")) {
          xmlUrl = await subirArchivoR2(buf, `facturas/allegrocaffezonadoradatxutxufo_${ts}.xml`, "application/xml");
          console.log("✅ XML subido:", xmlUrl);
        } else {
          console.log("⚠️ Respuesta no parece XML — preview:", preview);
        }
      }
    }

    // Descargar PDF
    if (pdfLink && pdfLink.href) {
      console.log("🔗 URL PDF:", pdfLink.href);
      const directBuf = await fetchConCookies(pdfLink.href);
      if (directBuf && directBuf.toString("latin1", 0, 4) === "%PDF") {
        pdfUrl = await subirArchivoR2(directBuf, `facturas/allegrocaffezonadoradatxutxufo_${ts}.pdf`, "application/pdf");
        console.log("✅ PDF directo subido:", pdfUrl);
      } else {
        // Intentar abrir en nueva pestaña e interceptar
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
          pdfUrl = await subirArchivoR2(pdfBuffer, `facturas/allegrocaffezonadoradatxutxufo_${ts}.pdf`, "application/pdf");
          console.log("✅ PDF (interceptado) subido:", pdfUrl);
        } else {
          console.log("ℹ️ PDF no interceptado — se procesará por IMAP");
        }
        await pdfPage.close().catch(() => {});
      }
    }

    // Si no hay links directos, buscar botones de descarga
    if (!xmlUrl && !pdfUrl) {
      console.log("ℹ️ No se encontraron links directos — buscando botones de descarga...");
      const downloadBtns = await page.$$eval("a, button", els =>
        els.map(el => ({ text: el.textContent.trim().toUpperCase(), href: el.getAttribute("href") || "", onclick: el.getAttribute("onclick") || "" }))
          .filter(l => l.text.includes("DESCARGAR") || l.text.includes("DOWNLOAD") || l.text.includes("XML") || l.text.includes("PDF"))
      ).catch(() => []);
      console.log("🔘 Botones de descarga:", JSON.stringify(downloadBtns));
    }

    console.log(`📊 Descarga directa — XML: ${!!xmlUrl} | PDF: ${!!pdfUrl}`);
    return { xmlUrl, pdfUrl };
  }

  try {
    // ── PASO 1 — Cargar portal ────────────────────────────────────────────
    console.log("🌐 Cargando portal...");
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    await page.waitForTimeout(2000);
    await screenshot("paso1_cargado");

    // Verificar si la URL es incorrecta o el portal está inactivo
    const bodyText = await page.evaluate(() => document.body.innerText.toLowerCase()).catch(() => "");
    if (bodyText.includes("url proporcionada es incorrecta") || bodyText.includes("no encontrada") || bodyText.includes("página no existe")) {
      throw new Error("El portal indica que la URL es incorrecta o la empresa no está configurada");
    }

    // Verificar si hay un formulario visible
    console.log("⏳ Esperando formulario principal...");
    const formSel = await resolveSelector(["form", ".form-facturacion", "#form-facturacion", ".container form"], 15000);
    if (!formSel) {
      // Intentar de todas formas, puede estar sin etiqueta form explícita
      console.log("⚠️ No se detectó form explícito — continuando con detección de campos...");
    }
    await screenshot("paso1_formulario");
    console.log("✅ Portal cargado y formulario detectado");

    // ── PASO 2 — Detectar y llenar campo Folio ───────────────────────────
    console.log("📋 PASO 2: Llenando campo Folio...");
    const folioSel = await resolveSelector([
      "input[name='folio']",
      "#folio",
      "input[id*='folio']",
      "input[placeholder*='folio' i]",
      "input[placeholder*='ticket' i]",
    ], 10000);

    if (folioSel && folio) {
      await fillInput(page, folioSel, folio);
    } else if (folio) {
      console.log("⚠️ Selector de folio no encontrado — intentando fillInputMulti...");
      await fillInputMulti([
        "input[name='folio']", "#folio", "input[id*='folio']", "input[placeholder*='folio' i]"
      ], folio);
    }
    await screenshot("paso2_folio");

    // ── PASO 3 — Fecha de compra ──────────────────────────────────────────
    console.log("📋 PASO 3: Llenando campo Fecha...");
    const fechaSel = await resolveSelector([
      "input[name='fecha']",
      "#fecha",
      "input[id*='fecha']",
      "input[type='date']",
      "input[placeholder*='fecha' i]",
      "input[placeholder*='dd/mm' i]",
    ], 8000);

    if (fechaSel && fecha) {
      // Detectar formato del datepicker
      const inputType = await page.$eval(fechaSel, el => el.type).catch(() => "text");
      let fechaFormateada = fecha;

      if (inputType === "date") {
        // Formato YYYY-MM-DD
        if (/^\d{2}\/\d{2}\/\d{4}$/.test(fecha)) {
          const [d, m, y] = fecha.split("/");
          fechaFormateada = `${y}-${m}-${d}`;
        }
      } else {
        // Formato DD/MM/YYYY para datepicker jQuery UI
        if (/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
          const [y, m, d] = fecha.split("-");
          fechaFormateada = `${d}/${m}/${y}`;
        }
      }

      await fillInput(page, fechaSel, fechaFormateada);

      // Cerrar posible datepicker haciendo click fuera
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
    } else if (fecha) {
      console.log("⚠️ Campo de fecha no encontrado o fecha no proporcionada");
    }
    await screenshot("paso3_fecha");

    // ── PASO 4 — Total ────────────────────────────────────────────────────
    console.log("📋 PASO 4: Llenando campo Total...");
    const totalSel = await resolveSelector([
      "input[name='total']",
      "#total",
      "input[id*='total']",
      "input[placeholder*='total' i]",
      "input[placeholder*='monto' i]",
      "input[placeholder*='importe' i]",
    ], 8000);

    if (totalSel && total) {
      await fillInput(page, totalSel, parseFloat(total).toFixed(2));
    } else if (total) {
      await fillInputMulti([
        "input[name='total']", "#total", "input[id*='total']"
      ], parseFloat(total).toFixed(2));
    }
    await screenshot("paso4_total");

    // ── PASO 5 — Código de barras ─────────────────────────────────────────
    console.log("📋 PASO 5: Llenando campo Código de barras...");
    const barcodeSel = await resolveSelector([
      "input[name='barcode']",
      "#barcode",
      "input[id*='barcode']",
      "input[id*='codigo']",
      "input[id*='barra']",
      "input[placeholder*='barras' i]",
      "input[placeholder*='código' i]",
      "input[placeholder*='codigo' i]",
    ], 8000);

    if (barcodeSel && barcode) {
      await fillInput(page, barcodeSel, barcode);
    } else if (barcode) {
      await fillInputMulti([
        "input[name='barcode']", "#barcode", "input[id*='barcode']", "input[id*='codigo']"
      ], barcode);
    } else {
      console.log("ℹ️ Código de barras no proporcionado — omitiendo campo");
    }
    await screenshot("paso5_barcode");

    // ── PASO 6 — RFC ──────────────────────────────────────────────────────
    console.log("📋 PASO 6: Llenando RFC...");
    const rfcSel = await resolveSelector([
      "input[name='rfc']",
      "#rfc",
      "input[id*='rfc']",
      "input[placeholder*='rfc' i]",
      "input[placeholder*='RFC' i]",
    ], 8000);

    if (rfcSel) {
      await fillInput(page, rfcSel, rfc);
    } else {
      await fillInputMulti([
        "input[name='rfc']", "#rfc", "input[id*='rfc']"
      ], rfc);
    }
    await page.waitForTimeout(1000); // Esperar posible validación AJAX del RFC
    await screenshot("paso6_rfc");

    // ── PASO 7 — Razón Social ─────────────────────────────────────────────
    console.log("📋 PASO 7: Llenando Razón Social...");
    const razonSel = await resolveSelector([
      "input[name='razonSocial']",
      "#razonSocial",
      "input[id*='razon']",
      "input[id*='razonSocial']",
      "input[id*='nombre']",
      "input[id*='empresa']",
      "input[placeholder*='razón social' i]",
      "input[placeholder*='razon social' i]",
      "input[placeholder*='nombre' i]",
    ], 8000);

    if (razonSel && razonSocial) {
      await fillInput(page, razonSel, razonSocial);
    } else if (razonSocial) {
      await fillInputMulti([
        "input[name='ra