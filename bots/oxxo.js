const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");

async function fallbackReimpresionOxxo(page, { fecha, folio, idVenta, total }) {
  try {
    console.log("🔄 Fallback: reimpresión OXXO...");
    await page.waitForTimeout(2000);
    await page.goto(
      "https://www4.oxxo.com:9443/facturacionElectronica-web/views/layout/reimpresionFactura.do",
      { waitUntil: "networkidle2", timeout: 30000 }
    );
    await page.waitForTimeout(2000);

    await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll("a, button, li"));
      const tab = tabs.find(el => el.textContent.trim() === "Factura");
      if (tab) tab.click();
    });
    await page.waitForTimeout(1500);

    await page.evaluate((fecha) => {
      const input = document.querySelector("#form\\:fecha_input");
      if (input) {
        input.removeAttribute("readonly");
        input.value = fecha;
        ["change", "blur"].forEach(ev =>
          input.dispatchEvent(new Event(ev, { bubbles: true }))
        );
      }
    }, fecha);
    await page.waitForTimeout(500);

    await page.click("#form\\:folio", { clickCount: 3 });
    await page.type("#form\\:folio", String(folio), { delay: 80 });
    await page.waitForTimeout(300);
    await page.click("#form\\:venta", { clickCount: 3 });
    await page.type("#form\\:venta", String(idVenta).toUpperCase(), { delay: 80 });
    await page.waitForTimeout(300);
    await page.click("#form\\:total", { clickCount: 3 });
    await page.type("#form\\:total", parseFloat(total).toFixed(2), { delay: 80 });
    await page.waitForTimeout(500);

    await page.evaluate(() => {
      const spans = Array.from(document.querySelectorAll("span"));
      const btn = spans.find(s => s.textContent.trim() === "Validar Ticket");
      if (btn) btn.click();
    });

    await page.waitForFunction(() => {
      const btn = document.querySelector("#form\\:continuar");
      return btn && !btn.disabled;
    }, { timeout: 15000 });

    await page.click("#form\\:continuar");
    await page.waitForTimeout(3000);

    const downloadFile = async (selector) => {
      const newPageP = new Promise(resolve =>
        page.browser().once("targetcreated", t => resolve(t.page()))
      );
      await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (el) el.click();
      }, selector);
      const np = await newPageP.catch(() => null);
      if (!np) return null;
      await np.waitForTimeout(1500);
      const r = await np.waitForResponse(r => r.status() === 200, { timeout: 10000 }).catch(() => null);
      const buf = r ? await r.buffer().catch(() => null) : null;
      await np.close().catch(() => {});
      return buf;
    };

    const xmlBuffer = await downloadFile("#form\\:btnDescargarXml, [id*='Xml']");
    const pdfBuffer = await downloadFile("#form\\:btnDescargarPdf, [id*='Pdf']");

    if (!xmlBuffer && !pdfBuffer) throw new Error("Sin archivos en reimpresión");

    const ts = Date.now();
    const xmlUrl = xmlBuffer ? await subirArchivoR2(xmlBuffer, `facturas/oxxo_reimp_${ts}.xml`, "application/xml") : null;
    const pdfUrl = pdfBuffer ? await subirArchivoR2(pdfBuffer, `facturas/oxxo_reimp_${ts}.pdf`, "application/pdf") : null;

    console.log("✅ Reimpresión OXXO exitosa");
    return { ok: true, xmlUrl, pdfUrl, fuente: "reimpresion" };
  } catch (e) {
    console.log("❌ Fallback reimpresión OXXO falló:", e.message);
    return { ok: false, msg: e.message };
  }
}

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
      timeout: 30000,
    });
    await page.waitForTimeout(4000);

    // ── CERRAR POPUP INICIAL ──
    console.log("❌ Cerrando popup...");
    try {
      await page.waitForSelector(".ui-dialog-titlebar-close", { timeout: 8000 });
      await page.waitForTimeout(1000);
      await page.evaluate(() => {
        const btns = document.querySelectorAll(".ui-dialog-titlebar-close, .ui-dialog-titlebar-icon");
        btns.forEach(b => b.click());
      });
      console.log("✅ Popup cerrado via JS");
      await page.waitForTimeout(2000);

      const popupVisible = await page.evaluate(() => {
        const dialog = document.querySelector(".ui-dialog");
        return dialog && dialog.style.display !== "none";
      });
      if (popupVisible) {
        await page.keyboard.press("Escape");
        console.log("✅ Popup cerrado via Escape");
        await page.waitForTimeout(1000);
      }
    } catch {
      console.log("ℹ️ No apareció popup");
    }

    const ss1 = await page.screenshot({ encoding: "base64" });
    console.log("📸 Screenshot 1 - popup cerrado");

    // ── FECHA via datepicker ──
    console.log("📅 Abriendo datepicker...");
    await page.waitForSelector("#form\\:fecha_input", { timeout: 15000 });
    await page.click("#form\\:fecha_input");
    await page.waitForTimeout(1500);

    const partes = fecha.split("/");
    const dia = parseInt(partes[0]);
    const mes = parseInt(partes[1]) - 1;
    const anio = parseInt(partes[2]);
    console.log(`📅 Fecha a seleccionar: día=${dia}, mes=${mes}, año=${anio}`);

    await page.evaluate(async (dia, mes, anio) => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      for (let intento = 0; intento < 24; intento++) {
        const mesSpan = document.querySelector(".ui-datepicker-month");
        const anioSpan = document.querySelector(".ui-datepicker-year");
        if (!mesSpan || !anioSpan) break;
        const meses = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
        const mesIdx = meses.indexOf(mesSpan.textContent.toLowerCase().trim());
        const anioActual = parseInt(anioSpan.textContent);
        if (mesIdx === mes && anioActual === anio) break;
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
      const celdas = document.querySelectorAll(".ui-datepicker-calendar td[data-handler='selectDay']");
      for (const celda of celdas) {
        const link = celda.querySelector("a");
        if (link && parseInt(link.textContent) === dia) { link.click(); break; }
      }
    }, dia, mes, anio);

    // Esperar que el calendario se cierre
    await page.waitForTimeout(1000);

    // Si el calendario sigue abierto, forzar cierre
    const calAbierto = await page.$('.ui-datepicker:not([style*="display: none"])');
    if (calAbierto) {
      await page.click('#form\\:fecha_input');
      await page.waitForTimeout(500);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
    }

    const fechaValor = await page.$eval('#form\\:fecha_input', el => el.value);
    console.log('📅 Fecha confirmada en campo:', fechaValor);

    // Fallback: escribir la fecha directamente si el datepicker no la registró
    if (!fechaValor || fechaValor.trim() === '') {
      console.log('⚠️ Datepicker falló, escribiendo fecha directo...');
      await page.evaluate((fecha) => {
        const input = document.querySelector('#form\\:fecha_input');
        if (input) {
          input.removeAttribute('readonly');
          input.value = fecha;
          ['input', 'change', 'blur'].forEach(ev =>
            input.dispatchEvent(new Event(ev, { bubbles: true }))
          );
        }
      }, fecha);
      await page.waitForTimeout(1000);
    }

    await page.waitForTimeout(3000);

    // ── FOLIO ──
    console.log("🔢 Llenando folio...", folio);
    await page.click("#form\\:folio", { clickCount: 3 });
    await page.type("#form\\:folio", String(folio), { delay: 100 });
    await page.waitForTimeout(400);
    const folioValor = await page.$eval("#form\\:folio", el => el.value);
    console.log("🔢 Folio en campo:", folioValor);

    // ── ID VENTA ──
    console.log("🔑 Llenando ID venta...");
    await page.click("#form\\:venta", { clickCount: 3 });
    await page.type("#form\\:venta", String(idVenta).toUpperCase(), { delay: 100 });
    await page.waitForTimeout(400);
    console.log("🔑 ID venta en campo:", await page.$eval("#form\\:venta", el => el.value));

    // ── TOTAL ──
    console.log("💰 Llenando total...");
    await page.click("#form\\:total", { clickCount: 3 });
    await page.type("#form\\:total", parseFloat(total).toFixed(2), { delay: 100 });
    await page.waitForTimeout(500);
    console.log("💰 Total en campo:", await page.$eval("#form\\:total", el => el.value));

    const ss2 = await page.screenshot({ encoding: "base64" });
    console.log("📸 Screenshot 2 - antes de validar");

    // ── VALIDAR TICKET ──
    console.log("✅ Validando ticket...");
    await page.evaluate(() => {
      const spans = Array.from(document.querySelectorAll("span"));
      const validar = spans.find(s => s.textContent.trim() === "Validar Ticket");
      if (validar) validar.click();
    });
    await page.waitForTimeout(5000);

    const ss3 = await page.screenshot({ encoding: "base64" });
    console.log("📸 Screenshot 3 - después de validar");

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
      return { pdf: pdf ? pdf.href : null, xml: xml ? xml.href : null };
    });
    console.log("✅ Links obtenidos:", links);

    // ── SUBIR A R2 ──
    const ts = Date.now();
    let xmlUrl = links.xml;
    let pdfUrl = links.pdf;

    if (links.xml) {
      try {
        const https = require("https");
        const http = require("http");
        const buf = await new Promise((res, rej) => {
          const proto = links.xml.startsWith("https") ? https : http;
          const chunks = [];
          proto.get(links.xml, { headers: { "User-Agent": "Mozilla/5.0" } }, (r) => {
            r.on("data", c => chunks.push(c));
            r.on("end", () => res(Buffer.concat(chunks)));
          }).on("error", rej);
        });
        xmlUrl = await subirArchivoR2(buf, `facturas/oxxo_${ts}.xml`, "application/xml") || links.xml;
      } catch (e) { console.log("⚠️ R2 XML upload falló:", e.message); }
    }
    if (links.pdf) {
      try {
        const https = require("https");
        const http = require("http");
        const buf = await new Promise((res, rej) => {
          const proto = links.pdf.startsWith("https") ? https : http;
          const chunks = [];
          proto.get(links.pdf, { headers: { "User-Agent": "Mozilla/5.0" } }, (r) => {
            r.on("data", c => chunks.push(c));
            r.on("end", () => res(Buffer.concat(chunks)));
          }).on("error", rej);
        });
        pdfUrl = await subirArchivoR2(buf, `facturas/oxxo_${ts}.pdf`, "application/pdf") || links.pdf;
      } catch (e) { console.log("⚠️ R2 PDF upload falló:", e.message); }
    }

    await browser.close();
    return { ok: true, xmlUrl, pdfUrl };

  } catch (err) {
    console.error("❌ Error en bot OXXO:", err.message);
    let screenshot = null;
    try { screenshot = await page.screenshot({ encoding: "base64" }); } catch {}

    const fallback = await fallbackReimpresionOxxo(page, { fecha, folio, idVenta, total });
    if (fallback.ok) {
      await browser.close();
      return fallback;
    }

    await browser.close();
    return { ok: false, msg: err.message, screenshot };
  }
}

module.exports = { facturarOXXO };
