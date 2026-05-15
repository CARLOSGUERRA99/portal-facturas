const puppeteer = require("puppeteer");

async function facturarOXXO({ fecha, folio, idVenta, total, rfc, razonSocial, calle, ext, int, colonia, municipio, codigoPostal, estado, regimenFiscal, usoCfdi }) {
  console.log("🤖 Iniciando bot OXXO...");

  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}`,
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");

  try {
    console.log("🌐 Abriendo portal OXXO...");
    await page.goto("https://www4.oxxo.com:9443/facturacionElectronica-web/views/layout/inicio.do", {
      waitUntil: "networkidle2",
      timeout: 30000
    });

    await page.waitForTimeout(3000);

    // ── CERRAR POPUP INICIAL ──
    console.log("❌ Cerrando popup...");
    try {
      await page.waitForSelector(".ui-dialog-titlebar-close", { timeout: 5000 });
      await page.click(".ui-dialog-titlebar-close");
      console.log("✅ Popup cerrado");
      await page.waitForTimeout(1000);
    } catch {
      console.log("ℹ️ No apareció popup");
    }

    // ── FECHA via datepicker ──
    console.log("📅 Abriendo datepicker...");
    await page.waitForSelector("#form\\:fecha_input", { timeout: 15000 });
    await page.click("#form\\:fecha_input");
    await page.waitForTimeout(1500);

    // Parsear fecha DD/MM/YYYY
    const partes = fecha.split("/");
    const dia = parseInt(partes[0]);
    const mes = parseInt(partes[1]) - 1; // 0-indexed
    const anio = parseInt(partes[2]);

    console.log(`📅 Fecha a seleccionar: día=${dia}, mes=${mes}, año=${anio}`);

    // Navegar al mes/año correcto en el datepicker
    await page.evaluate(async (dia, mes, anio) => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      
      for (let intento = 0; intento < 24; intento++) {
        const mesSpan = document.querySelector(".ui-datepicker-month");
        const anioSpan = document.querySelector(".ui-datepicker-year");
        if (!mesSpan || !anioSpan) break;

        const mesActual = parseInt(mesSpan.getAttribute("data-month") || 
          ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"]
          .indexOf(mesSpan.textContent.toLowerCase()));
        const anioActual = parseInt(anioSpan.textContent);

        // Calcular mes actual desde el texto
        const meses = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
        const mesIdx = meses.indexOf(mesSpan.textContent.toLowerCase().trim());

        if (mesIdx === mes && anioActual === anio) break;

        // Determinar si ir adelante o atrás
        const fechaActual = new Date(anioActual, mesIdx === -1 ? 0 : mesIdx, 1);
        const fechaTarget = new Date(anio, mes, 1);

        if (fechaTarget < fechaActual) {
          const prev = document.querySelector(".ui-datepicker-prev");
          if (prev) prev.click();
        } else {
          const next = document.querySelector(".ui-datepicker-next:not(.ui-state-disabled)");
          if (next) next.click();
        }
        await sleep(800);
      }

      // Hacer clic en el día correcto
      const celdas = document.querySelectorAll(".ui-datepicker-calendar td[data-handler='selectDay']");
      for (const celda of celdas) {
        const link = celda.querySelector("a");
        if (link && parseInt(link.textContent) === dia) {
          link.click();
          break;
        }
      }
    }, dia, mes, anio);

    await page.waitForTimeout(1500);

    // Verificar que la fecha se llenó
    const fechaValor = await page.$eval("#form\\:fecha_input", el => el.value);
    console.log("📅 Fecha en campo:", fechaValor);

    // ── FOLIO ──
    console.log("🔢 Llenando folio...");
    await page.click("#form\\:folio", { clickCount: 3 });
    await page.type("#form\\:folio", String(folio), { delay: 100 });
    await page.waitForTimeout(400);

    // ── ID VENTA ──
    console.log("🔑 Llenando ID venta...");
    await page.click("#form\\:venta", { clickCount: 3 });
    await page.type("#form\\:venta", String(idVenta).toUpperCase(), { delay: 100 });
    await page.waitForTimeout(400);

    // ── TOTAL ──
    console.log("💰 Llenando total...");
    await page.click("#form\\:total", { clickCount: 3 });
    const totalStr = parseFloat(total).toFixed(2);
    await page.type("#form\\:total", totalStr, { delay: 100 });
    await page.waitForTimeout(500);

    // Screenshot antes de validar
    const ss2 = await page.screenshot({ encoding: "base64" });
    console.log("📸 Screenshot antes de validar");

    // ── VALIDAR TICKET ──
    console.log("✅ Validando ticket...");
    await page.evaluate(() => {
      const spans = Array.from(document.querySelectorAll("span"));
      const validar = spans.find(s => s.textContent.trim() === "Validar Ticket");
      if (validar) validar.click();
    });

    await page.waitForTimeout(5000);

    const ss3 = await page.screenshot({ encoding: "base64" });
    console.log("📸 Screenshot después de validar");

    // Verificar si Continuar se habilitó
    const continuarHabilitado = await page.evaluate(() => {
      const btn = document.querySelector("#form\\:continuar");
      return btn && !btn.disabled;
    });

    console.log("▶️ Continuar habilitado:", continuarHabilitado);

    if (!continuarHabilitado) {
      const mensajeError = await page.evaluate(() => {
        const msgs = document.querySelectorAll(".ui-messages-error, .ui-message-error-detail, [class*='error']");
        return Array.from(msgs).map(m => m.textContent.trim()).filter(t => t).join(" | ");
      });
      console.log("⚠️ Mensaje portal:", mensajeError);
      await browser.close();
      return { ok: false, msg: `Portal no validó el ticket. ${mensajeError || "Verifica los datos del ticket"}`, screenshot: ss3 };
    }

    // ── CONTINUAR ──
    console.log("▶️ Clic Continuar...");
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
    console.log("📥 Buscando links...");
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
