// Petrofigues — petrofigues.facturacionestacion.com (compartido por ~19
// gasolineras del grupo, identificadas por "Referencia"/número de estación).
//
// Reconocimiento real (2026-07-27, cuenta real GPN, ticket real Gonzer 1
// "Brujas I", referencia 13697, ticket 1067336, $1,000.00):
//   1. https://petrofigues.facturacionestacion.com/ es la ENTRADA ÚNICA
//      para todas las estaciones — no hace falta pasar por el selector de
//      sucursal del sitio de marketing (petrofigues.com/facturacion.html,
//      cuyos links de estación son en realidad todos el mismo href).
//   2. Form inicial: #txtReferencia (número de estación), #txtFolio
//      (número de ticket), #txtAmount (importe total), #txtRFC → botón
//      #btnNext ("Buscar") → POST Home/FindTicketAndClientData.
//   3. Si el RFC ya factura seguido con este grupo, el cliente viene
//      GUARDADO server-side y el resto del form se autocompleta (nombre,
//      domicilio, colonia, CP, ciudad, estado, régimen fiscal, forma de
//      pago) — confirmado con la cuenta real de GPN. El único campo que
//      SIEMPRE queda vacío es "Uso CFDI" (select #selVoucherUse).
//   4. #selVoucherUse es un <select> nativo pero sus <option value> son
//      IDs numéricos internos (ej. "3" para "Gastos en general"), no
//      "G03" — hay que buscar la opción por TEXTO, no por value fijo.
//   5. Botón "Facturar" dispara un window.confirm() ("¿Está seguro que
//      desea generar esta factura?") — SIN page.on('dialog') el tab muere
//      (mismo bug ya documentado para 7-Eleven: diálogo no manejado).
//   6. Tras aceptar, la factura se genera EN EL ACTO (no hay espera ni
//      correo) — la respuesta de Home/CreateInvoice trae el nombre de
//      archivo con el UUID real embebido:
//      "20260727_{RFCEMISOR}_{RFCRECEPTOR}_{UUID}.xml^{estacion}"
//   7. Descarga directa (confirmado real, XML+PDF verificados con la
//      cuenta real): DownloadInvoice.aspx?fiscalFolioId={UUID}&stationId={estacion}
//      devuelve el XML real (Content-Type: application/xml). El PDF se
//      obtiene del mismo Report/ReportViewer.aspx que abre el link "PDF"
//      (se navega esa URL en pestaña nueva y se captura la respuesta
//      application/pdf).
//   8. Reintentar el mismo folio es seguro/idempotente: el portal responde
//      "Este folio ya fue facturado anteriormente!" con los mismos links
//      de descarga, no genera un duplicado.
const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");

async function facturarPetrofigues({ referencia, folio, importe, rfc, ticketId }) {
  console.log("🤖 Iniciando bot Petrofigues...");
  console.log(`   Referencia (estación): ${referencia} | Folio: ${folio} | Importe: ${importe} | RFC: ${rfc}`);

  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error("BROWSERLESS_TOKEN no definido");
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true`,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");
  page.on("dialog", async d => { console.log("🔔 Dialog:", d.message()); await d.accept().catch(() => {}); });

  const ts = ticketId || Date.now();
  async function screenshot(label) {
    try {
      const buf = await page.screenshot({ fullPage: true });
      const u = await subirArchivoR2(buf, `debug/petrofigues_${ts}_${label}_${Date.now()}.png`, "image/png");
      console.log(`📸 [${label}]: ${u}`);
    } catch {}
  }

  try {
    console.log("🌐 Cargando portal...");
    await page.goto("https://petrofigues.facturacionestacion.com/", { waitUntil: "load", timeout: 30000 });
    await page.waitForSelector("#txtReferencia", { timeout: 15000 });

    await page.click("#txtReferencia"); await page.keyboard.type(String(referencia), { delay: 15 });
    await page.click("#txtFolio"); await page.keyboard.type(String(folio), { delay: 15 });
    await page.click("#txtAmount"); await page.keyboard.type(parseFloat(importe).toFixed(2), { delay: 15 });
    await page.click("#txtRFC"); await page.keyboard.type(rfc, { delay: 15 });

    let findResp = null;
    page.once("response", async (resp) => {
      if (/FindTicketAndClientData/i.test(resp.url())) findResp = await resp.text().catch(() => null);
    });
    await page.click("#btnNext");
    await page.waitForTimeout(2800);
    await screenshot("p1_post_buscar");

    let textoActual = await page.evaluate(() => document.body.innerText);

    // Ya facturado previamente (reintento idempotente) — ir directo a extraer los links
    const yaFacturado = /ya fue facturado anteriormente/i.test(textoActual);

    if (!yaFacturado) {
      if (/Ticket no encontrado|no se encontr[oó]|Folio inv[aá]lido/i.test(textoActual)) {
        await browser.close();
        return { ok: false, error_code: "datos_invalidos", msg: `Petrofigues: ticket no reconocido (referencia ${referencia}, folio ${folio})` };
      }
      if (!/Ticket Agregado/i.test(textoActual)) {
        await screenshot("p1b_sin_ticket_agregado");
        await browser.close();
        return { ok: false, msg: `Petrofigues: no se agregó el ticket. Texto: ${textoActual.slice(0, 200)}` };
      }

      // Uso CFDI — buscar por texto "Gastos en general", el <option value> es un ID interno, no "G03"
      const usoOk = await page.evaluate(() => {
        const sels = Array.from(document.querySelectorAll("select"));
        const sel = sels.find(s => Array.from(s.options).some(o => /gastos en general/i.test(o.text)));
        if (!sel) return false;
        const opt = Array.from(sel.options).find(o => /gastos en general/i.test(o.text));
        sel.value = opt.value;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      });
      if (!usoOk) {
        await screenshot("p2_sin_select_uso_cfdi");
        await browser.close();
        return { ok: false, msg: "Petrofigues: no se encontró el select de Uso CFDI" };
      }
      await page.waitForTimeout(400);
      await screenshot("p2_antes_facturar");

      console.log("🧾 Click Facturar (emisión real)...");
      let createResp = null;
      page.once("response", async (resp) => {
        if (/CreateInvoice/i.test(resp.url())) createResp = await resp.text().catch(() => null);
      });
      await page.evaluate(() => {
        const b = Array.from(document.querySelectorAll("button")).find(x => /^facturar$/i.test((x.textContent || "").trim()));
        if (b) b.click();
      });
      await page.waitForTimeout(4500);
      await screenshot("p3_post_facturar");

      textoActual = await page.evaluate(() => document.body.innerText);
      console.log(`📋 CreateInvoice → ${createResp ? createResp.slice(0, 300) : "(sin respuesta capturada)"}`);

      if (!/enviada al correo|ya fue facturado/i.test(textoActual)) {
        await browser.close();
        return { ok: false, msg: `Petrofigues: no se confirmó la emisión. Texto: ${textoActual.slice(0, 300)}` };
      }
    } else {
      console.log("♻️ Folio ya facturado anteriormente — recuperando archivos existentes");
    }

    // Extraer fiscalFolioId (UUID) + estación del link "XML" ya renderizado
    const enlaceXml = await page.evaluate(() => {
      const a = Array.from(document.querySelectorAll("a")).find(x => x.textContent.trim() === "XML");
      return a ? a.href : null;
    });
    const match = (enlaceXml || "").match(/DownloadInvoice\('([^']+)',\s*(\d+)\)/);
    if (!match) {
      await browser.close();
      return { ok: false, msg: "Petrofigues: factura generada pero no se pudo extraer el link de descarga XML" };
    }
    const nombreArchivo = match[1];
    const estacionLink = match[2];
    const uuid = nombreArchivo.split("_")[3]?.replace(".xml", "");
    if (!uuid) {
      await browser.close();
      return { ok: false, msg: `Petrofigues: no se pudo extraer el UUID del nombre de archivo "${nombreArchivo}"` };
    }
    console.log(`📄 UUID CFDI: ${uuid}`);

    const base = "https://petrofigues.facturacionestacion.com";
    const xmlResp = await page.evaluate(async (url) => {
      const r = await fetch(url);
      const buf = await r.arrayBuffer();
      return { status: r.status, contentType: r.headers.get("content-type"), b64: btoa(String.fromCharCode(...new Uint8Array(buf))) };
    }, `${base}/DownloadInvoice.aspx?fiscalFolioId=${uuid}&stationId=${estacionLink}`);

    let xmlUrl = null, pdfUrl = null;
    if (xmlResp.status === 200 && xmlResp.contentType?.includes("xml")) {
      const xmlBuffer = Buffer.from(xmlResp.b64, "base64");
      xmlUrl = await subirArchivoR2(xmlBuffer, `facturas/petrofigues_${uuid}.xml`, "application/xml");
      console.log(`☁️ XML subido: ${xmlUrl}`);
    }

    // PDF: el link "PDF" abre Report/ReportViewer.aspx en pestaña nueva (se resuelve vía visor de Chrome, no fetch directo)
    let pdfBuffer = null;
    const targetPromise = new Promise((resolve) => {
      browser.once("targetcreated", async (target) => {
        try {
          const newPage = await target.page();
          if (!newPage) return resolve(null);
          newPage.on("response", async (resp) => {
            const ct = resp.headers()["content-type"] || "";
            if (ct.includes("pdf") && !pdfBuffer) {
              const b = await resp.buffer().catch(() => null);
              if (b && b.length > 500) { pdfBuffer = b; resolve(b); }
            }
          });
        } catch { resolve(null); }
      });
    });
    await page.evaluate(() => {
      const a = Array.from(document.querySelectorAll("a")).find(x => x.textContent.trim() === "PDF");
      if (a) a.click();
    });
    await Promise.race([targetPromise, new Promise(r => setTimeout(r, 8000))]);

    if (pdfBuffer) {
      pdfUrl = await subirArchivoR2(pdfBuffer, `facturas/petrofigues_${uuid}.pdf`, "application/pdf");
      console.log(`☁️ PDF subido: ${pdfUrl}`);
    }

    await browser.close();

    if (!xmlUrl) {
      return { ok: false, msg: "Petrofigues: la factura se generó pero no se pudo descargar el XML real" };
    }
    console.log("✅ Petrofigues — factura real generada y descargada");
    return { ok: true, xmlUrl, pdfUrl };

  } catch (err) {
    console.error("❌ Error en bot Petrofigues:", err.message);
    await screenshot("error").catch(() => {});
    await browser.close().catch(() => {});
    return { ok: false, msg: `Petrofigues: ${err.message}` };
  }
}

module.exports = { facturarPetrofigues };
