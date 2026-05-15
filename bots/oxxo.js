const puppeteer = require("puppeteer");

async function facturarOXXO({ fecha, folio, idVenta, total, rfc, razonSocial, calle, ext, int, colonia, municipio, codigoPostal, estado, regimenFiscal, usoCfdi }) {
  console.log("🤖 Iniciando bot OXXO...");

  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}`,
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  try {
    console.log("🌐 Abriendo portal OXXO...");
    await page.goto("https://www4.oxxo.com:9443/facturacionElectronica-web/views/layout/inicio.do", {
      waitUntil: "networkidle2",
      timeout: 30000
    });

    await page.waitForTimeout(2000);

    // ── FECHA (campo readonly, se llena via datepicker) ──
    console.log("📅 Llenando fecha...");
    await page.waitForSelector("#form\\:fecha_input", { timeout: 15000 });
    await page.evaluate((fecha) => {
      const input = document.querySelector("#form\\:fecha_input");
      input.removeAttribute("readonly");
      input.value = fecha;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("blur", { bubbles: true }));
    }, fecha);

    await page.waitForTimeout(500);

    // ── FOLIO ──
    console.log("🔢 Llenando folio...");
    await page.waitForSelector("#form\\:folio", { timeout: 10000 });
    await page.click("#form\\:folio");
    await page.type("#form\\:folio", String(folio), { delay: 50 });

    await page.waitForTimeout(300);

    // ── ID VENTA ──
    console.log("🔑 Llenando ID venta...");
    await page.waitForSelector("#form\\:venta", { timeout: 10000 });
    await page.click("#form\\:venta");
    await page.type("#form\\:venta", String(idVenta), { delay: 50 });

    await page.waitForTimeout(300);

    // ── TOTAL ──
    console.log("💰 Llenando total...");
    await page.waitForSelector("#form\\:total", { timeout: 10000 });
    await page.click("#form\\:total");
    await page.type("#form\\:total", String(total), { delay: 50 });

    await page.waitForTimeout(500);

    // ── VALIDAR TICKET ──
    console.log("✅ Validando ticket...");
    await page.evaluate(() => {
      const spans = Array.from(document.querySelectorAll("span"));
      const validar = spans.find(s => s.textContent.trim() === "Validar Ticket");
      if (validar) validar.click();
    });

    // Esperar a que se habilite el botón Continuar
    console.log("⏳ Esperando validación...");
    await page.waitForFunction(() => {
      const btn = document.querySelector("#form\\:continuar");
      return btn && !btn.disabled;
    }, { timeout: 15000 });

    await page.waitForTimeout(1000);

    // ── CONTINUAR ──
    console.log("▶️ Clic en Continuar...");
    await page.click("#form\\:continuar");
    await page.waitForTimeout(2000);

    // ── RFC ──
    console.log("📋 Llenando RFC...");
    await page.waitForFunction(() => {
      const el = document.querySelector("#form\\:rfc");
      return el && !el.disabled;
    }, { timeout: 15000 });
    await page.click("#form\\:rfc");
    await page.type("#form\\:rfc", rfc, { delay: 50 });

    await page.waitForTimeout(300);

    // ── RAZÓN SOCIAL ──
    await page.click("#form\\:razon");
    await page.type("#form\\:razon", razonSocial, { delay: 30 });

    // ── CALLE ──
    await page.click("#form\\:calle");
    await page.type("#form\\:calle", calle || "", { delay: 30 });

    // ── NUM EXT ──
    await page.click("#form\\:ext");
    await page.type("#form\\:ext", ext || "S/N", { delay: 30 });

    // ── NUM INT (opcional) ──
    if (int) {
      await page.click("#form\\:int");
      await page.type("#form\\:int", int, { delay: 30 });
    }

    // ── COLONIA ──
    await page.click("#form\\:colonia");
    await page.type("#form\\:colonia", colonia || "", { delay: 30 });

    // ── MUNICIPIO ──
    await page.click("#form\\:dele");
    await page.type("#form\\:dele", municipio || "", { delay: 30 });

    // ── CÓDIGO POSTAL ──
    await page.click("#form\\:codigo");
    await page.type("#form\\:codigo", String(codigoPostal), { delay: 30 });

    // ── ESTADO ──
    await page.waitForSelector("#form\\:estado_input", { timeout: 10000 });
    await page.select("#form\\:estado_input", estado || "SONORA");

    await page.waitForTimeout(300);

    // ── RÉGIMEN FISCAL ──
    await page.waitForSelector("#form\\:selectOneMenuRegFis_input", { timeout: 10000 });
    await page.select("#form\\:selectOneMenuRegFis_input", String(regimenFiscal || "612"));

    await page.waitForTimeout(300);

    // ── USO CFDI ──
    await page.waitForSelector("#form\\:selectOneMenuCFDI_input", { timeout: 10000 });
    await page.select("#form\\:selectOneMenuCFDI_input", usoCfdi || "G03");

    await page.waitForTimeout(500);

    // ── GENERAR FACTURA ──
    console.log("🧾 Generando factura...");
    await page.click("#form\\:generarFactura");
    await page.waitForTimeout(6000);

    // ── BUSCAR LINKS DE DESCARGA ──
    console.log("📥 Buscando links de descarga...");
    const links = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll("a"));
      const pdf = anchors.find(a => a.href.includes(".pdf") || a.textContent.includes("PDF"));
      const xml = anchors.find(a => a.href.includes(".xml") || a.textContent.includes("XML"));
      return {
        pdf: pdf ? pdf.href : null,
        xml: xml ? xml.href : null,
      };
    });

    console.log("✅ Factura generada:", links);
    await browser.close();
    return { ok: true, pdf: links.pdf, xml: links.xml };

  } catch (err) {
    console.error("❌ Error en bot OXXO:", err.message);
    try {
      const screenshot = await page.screenshot({ encoding: "base64" });
      await browser.close();
      return { ok: false, msg: err.message, screenshot };
    } catch {
      await browser.close();
      return { ok: false, msg: err.message };
    }
  }
}

module.exports = { facturarOXXO };
