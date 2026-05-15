const puppeteer = require("puppeteer");

async function facturarOXXO({ fecha, folio, idVenta, total, rfc, razonSocial, calle, ext, int, colonia, municipio, codigoPostal, estado, regimenFiscal, usoCfdi }) {
  console.log("🤖 Iniciando bot OXXO...");

  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}`,
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  // Simular navegador real
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");

  try {
    console.log("🌐 Abriendo portal OXXO...");
    await page.goto("https://www4.oxxo.com:9443/facturacionElectronica-web/views/layout/inicio.do", {
      waitUntil: "networkidle2",
      timeout: 30000
    });

    await page.waitForTimeout(3000);

    // Screenshot para debug
    const ss1 = await page.screenshot({ encoding: "base64" });
    console.log("📸 Screenshot 1 tomado, página cargada");

    // ── FECHA via JavaScript directo ──
    console.log("📅 Llenando fecha via JS...");
    await page.waitForSelector("#form\\:fecha_input", { timeout: 15000 });

    // Convertir fecha DD/MM/YYYY a MM/DD/YYYY para el datepicker
    let fechaFormateada = fecha;
    if (fecha && fecha.includes("/")) {
      const partes = fecha.split("/");
      if (partes.length === 3) {
        fechaFormateada = `${partes[1]}/${partes[0]}/${partes[2]}`;
      }
    }

    await page.evaluate((f) => {
      const input = document.querySelector("#form\\:fecha_input");
      if (input) {
        input.removeAttribute("readonly");
        input.value = f;
        // Disparar todos los eventos necesarios
        ["focus", "input", "change", "blur", "keyup"].forEach(ev => {
          input.dispatchEvent(new Event(ev, { bubbles: true }));
        });
        // También intentar con jQuery si está disponible
        if (typeof jQuery !== "undefined") {
          jQuery(input).val(f).trigger("change");
        }
      }
    }, fechaFormateada);

    await page.waitForTimeout(1000);

    // ── FOLIO ──
    console.log("🔢 Llenando folio...");
    await page.waitForSelector("#form\\:folio", { timeout: 10000 });
    await page.click("#form\\:folio", { clickCount: 3 });
    await page.type("#form\\:folio", String(folio), { delay: 100 });
    await page.waitForTimeout(500);

    // ── ID VENTA ──
    console.log("🔑 Llenando ID venta...");
    await page.click("#form\\:venta", { clickCount: 3 });
    await page.type("#form\\:venta", String(idVenta), { delay: 100 });
    await page.waitForTimeout(500);

    // ── TOTAL ──
    console.log("💰 Llenando total...");
    await page.click("#form\\:total", { clickCount: 3 });
    // Total con 2 decimales
    const totalStr = parseFloat(total).toFixed(2);
    await page.type("#form\\:total", totalStr, { delay: 100 });
    await page.waitForTimeout(500);

    // Screenshot antes de validar
    const ss2 = await page.screenshot({ encoding: "base64" });
    console.log("📸 Screenshot 2 - antes de validar");

    // ── VALIDAR TICKET via click en span ──
    console.log("✅ Validando ticket...");
    await page.evaluate(() => {
      const spans = Array.from(document.querySelectorAll("span"));
      const validar = spans.find(s => s.textContent.trim() === "Validar Ticket");
      if (validar) {
        validar.click();
      } else {
        // Intentar con el botón directo
        const btn = document.querySelector("input[value='Validar Ticket'], button[value='Validar Ticket']");
        if (btn) btn.click();
      }
    });

    await page.waitForTimeout(5000);

    // Screenshot después de validar
    const ss3 = await page.screenshot({ encoding: "base64" });
    console.log("📸 Screenshot 3 - después de validar");

    // Verificar si el botón continuar se habilitó
    const continuarHabilitado = await page.evaluate(() => {
      const btn = document.querySelector("#form\\:continuar");
      return btn && !btn.disabled;
    });

    console.log("▶️ Continuar habilitado:", continuarHabilitado);

    if (!continuarHabilitado) {
      // Ver mensaje de error del portal
      const mensajeError = await page.evaluate(() => {
        const msgs = document.querySelectorAll(".ui-messages-error, .ui-message-error-detail, [class*='error'], [class*='mensaje']");
        return Array.from(msgs).map(m => m.textContent.trim()).join(" | ");
      });
      console.log("⚠️ Mensaje del portal:", mensajeError);
      await browser.close();
      return { ok: false, msg: `Portal no validó el ticket. ${mensajeError || "Verifica fecha, folio, ID y total"}`, screenshot: ss3 };
    }

    // ── CONTINUAR ──
    await page.click("#form\\:continuar");
    await page.waitForTimeout(3000);

    // ── DATOS FISCALES ──
    console.log("📋 Llenando datos fiscales...");
    await page.waitForFunction(() => {
      const el = document.querySelector("#form\\:rfc");
      return el && !el.disabled;
    }, { timeout: 15000 });

    await page.click("#form\\:rfc", { clickCount: 3 });
    await page.type("#form\\:rfc", rfc, { delay: 80 });
    await page.waitForTimeout(300);

    await page.click("#form\\:razon", { clickCount: 3 });
    await page.type("#form\\:razon", razonSocial, { delay: 50 });
    await page.waitForTimeout(300);

    await page.click("#form\\:calle", { clickCount: 3 });
    await page.type("#form\\:calle", calle || "", { delay: 50 });

    await page.click("#form\\:ext", { clickCount: 3 });
    await page.type("#form\\:ext", ext || "S/N", { delay: 50 });

    if (int) {
      await page.click("#form\\:int", { clickCount: 3 });
      await page.type("#form\\:int", int, { delay: 50 });
    }

    await page.click("#form\\:colonia", { clickCount: 3 });
    await page.type("#form\\:colonia", colonia || "", { delay: 50 });

    await page.click("#form\\:dele", { clickCount: 3 });
    await page.type("#form\\:dele", municipio || "", { delay: 50 });

    await page.click("#form\\:codigo", { clickCount: 3 });
    await page.type("#form\\:codigo", String(codigoPostal), { delay: 50 });

    await page.select("#form\\:estado_input", estado || "SONORA");
    await page.waitForTimeout(300);

    await page.select("#form\\:selectOneMenuRegFis_input", String(regimenFiscal || "612"));
    await page.waitForTimeout(300);

    await page.select("#form\\:selectOneMenuCFDI_input", usoCfdi || "G03");
    await page.waitForTimeout(500);

    // ── GENERAR FACTURA ──
    console.log("🧾 Generando factura...");
    await page.click("#form\\:generarFactura");
    await page.waitForTimeout(8000);

    // ── BUSCAR LINKS ──
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
