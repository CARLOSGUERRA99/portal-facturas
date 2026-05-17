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
  console.log(`📝 ${selector}: "${found || 'NO ENCONTRADO'}"`);
  return !!found;
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
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true`
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
  );
  await page.setExtraHTTPHeaders({
    "Accept-Language": "es-MX,es;q=0.9,en;q=0.8",
  });

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

    // ── PASO 3 — Click en Buscar ──────────────────────────────────────────
    console.log("🔍 Haciendo click en Buscar...");
    await page.click("#btnNext");
    await page.waitForTimeout(500);

    // Esperar a que el paso 2 aparezca (display:none → visible)
    console.log("⏳ Esperando campos del paso 2...");
    await page.waitForSelector("#txtName", { visible: true, timeout: 15000 });
    await screenshot("paso3_paso2_visible");
    console.log("✅ Paso 2 visible");

    // ── PASO 4 — Llenar datos de facturación ─────────────────────────────
    console.log("📋 Llenando datos de facturación...");

    if (razonSocial) {
      await fillInput(page, "#txtName", razonSocial);
    }

    await fillInput(page, "#txtEmail", "buzonfacturas@serviciosga.site");

    // Régimen fiscal
    const regimenKeywords = regimenFiscal
      ? [String(regimenFiscal)]
      : ["601", "General de Ley Personas Morales", "General de Ley"];
    await selectByText(page, "#cmbRegimen", regimenKeywords);

    // Uso CFDI
    const cfdiKeywords = usoCfdi
      ? [String(usoCfdi)]
      : ["G03", "Gastos en general", "Gastos"];
    await selectByText(page, "#cmbUsoCFDI", cfdiKeywords);

    // Forma de pago — tarjeta de débito por defecto
    await selectByText(page, "#cmbFormaPago", ["débito", "debito", "Tarjeta de déb"]);

    await screenshot("paso4_datos_facturacion");
    console.log("✅ Datos de facturación completos");

    // ── PASO 5 — Click en Facturar ────────────────────────────────────────
    console.log("🧾 Haciendo click en Facturar...");
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button, input[type='submit']"))
        .find(b => /facturar/i.test(b.textContent || b.value));
      if (btn) btn.click();
    });
    await page.waitForTimeout(2000);

    // Esperar pantalla de descarga
    console.log("⏳ Esperando pantalla de descarga...");
    await page.waitForSelector("#divFiles", { visible: true, timeout: 20000 });
    await screenshot("paso5_descarga");
    console.log("✅ Pantalla de descarga lista");

    // ── PASO 6 — Descargar PDF y XML desde #divFiles ──────────────────────
    let pdfUrl = null, xmlUrl = null;

    async function interceptarDescarga(clickFn) {
      const newPagePromise = new Promise(resolve =>
        browser.once("targetcreated", t => resolve(t.page()))
      );
      await clickFn();
      const newPage = await Promise.race([
        newPagePromise,
        new Promise((_, r) => setTimeout(r, 10000)),
      ]).catch(() => null);
      if (!newPage) return null;
      await newPage.waitForTimeout(2000);
      const response = await newPage.waitForResponse(r => r.status() === 200, { timeout: 10000 }).catch(() => null);
      const buf = response ? await response.buffer().catch(() => null) : null;
      await newPage.close().catch(() => {});
      return buf;
    }

    const pdfBuf = await interceptarDescarga(() =>
      page.$eval("#divFiles", container => {
        const el = Array.from(container.querySelectorAll("a, button")).find(
          b => /pdf/i.test(b.textContent) || /\.pdf/i.test(b.href || "")
        );
        if (el) el.click();
      })
    ).catch(() => null);

    const xmlBuf = await interceptarDescarga(() =>
      page.$eval("#divFiles", container => {
        const el = Array.from(container.querySelectorAll("a, button")).find(
          b => /xml/i.test(b.textContent) || /\.xml/i.test(b.href || "")
        );
        if (el) el.click();
      })
    ).catch(() => null);

    await browser.close();

    if (pdfBuf && pdfBuf.length > 100) {
      pdfUrl = await subirArchivoR2(pdfBuf, `facturas/gasmaz_${ticketId || Date.now()}.pdf`, "application/pdf");
      console.log("✅ PDF subido:", pdfUrl);
    }
    if (xmlBuf && xmlBuf.length > 100) {
      xmlUrl = await subirArchivoR2(xmlBuf, `facturas/gasmaz_${ticketId || Date.now()}.xml`, "application/xml");
      console.log("✅ XML subido:", xmlUrl);
    }

    if (!pdfUrl && !xmlUrl) {
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
