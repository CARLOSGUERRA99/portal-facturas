// Grupo GASHR (Autoservicio Gashr / Valero GDL) — valerogdl.facturacionestacion.com
// Misma plataforma NexusFuel que Petrofigues (bots/petrofigues.js) — campos,
// flujo, confirm() al facturar y descarga directa idénticos, confirmado en
// vivo. Único cambio real: la URL base (grupogashr.com.mx → "IR A
// FACTURACIÓN ELECTRONICA" → valerogdl.facturacionestacion.com).
// Ticket real usado en reconocimiento: Autoservicio Gashr Valero GDL La 60,
// Referencia 6060, Folio 1929725, $399.00. Cuenta GPN ya tenía perfil
// guardado (mismo RFC, datos ligeramente distintos a los de Petrofigues —
// cada tenant NexusFuel guarda su propio registro de cliente).
const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");

const BASE_URL = "https://valerogdl.facturacionestacion.com";

async function facturarGASHR({ referencia, folio, importe, rfc, ticketId }) {
  console.log("🤖 Iniciando bot Grupo GASHR...");
  console.log(`   Referencia: ${referencia} | Folio: ${folio} | Importe: ${importe} | RFC: ${rfc}`);

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
      const u = await subirArchivoR2(buf, `debug/gashr_${ts}_${label}_${Date.now()}.png`, "image/png");
      console.log(`📸 [${label}]: ${u}`);
    } catch {}
  }

  try {
    console.log("🌐 Cargando portal...");
    await page.goto(BASE_URL + "/", { waitUntil: "load", timeout: 30000 });
    await page.waitForSelector("#txtReferencia", { timeout: 15000 });

    await page.click("#txtReferencia"); await page.keyboard.type(String(referencia), { delay: 15 });
    await page.click("#txtFolio"); await page.keyboard.type(String(folio), { delay: 15 });
    await page.click("#txtAmount"); await page.keyboard.type(parseFloat(importe).toFixed(2), { delay: 15 });
    await page.click("#txtRFC"); await page.keyboard.type(rfc, { delay: 15 });
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("button")).find(x => /buscar/i.test(x.textContent || ""));
      if (b) b.click();
    });
    await page.waitForTimeout(2800);
    await screenshot("p1_post_buscar");

    let textoActual = await page.evaluate(() => document.body.innerText);
    const yaFacturado = /ya fue facturado anteriormente/i.test(textoActual);

    if (!yaFacturado) {
      if (/Ticket no encontrado|no se encontr[oó]|Folio inv[aá]lido/i.test(textoActual)) {
        await browser.close();
        return { ok: false, error_code: "datos_invalidos", msg: `GASHR: ticket no reconocido (referencia ${referencia}, folio ${folio})` };
      }
      if (!/Ticket Agregado/i.test(textoActual)) {
        await screenshot("p1b_sin_ticket_agregado");
        await browser.close();
        return { ok: false, msg: `GASHR: no se agregó el ticket. Texto: ${textoActual.slice(0, 200)}` };
      }

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
        return { ok: false, msg: "GASHR: no se encontró el select de Uso CFDI" };
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
        return { ok: false, msg: `GASHR: no se confirmó la emisión. Texto: ${textoActual.slice(0, 300)}` };
      }
    } else {
      console.log("♻️ Folio ya facturado anteriormente — recuperando archivos existentes");
    }

    const enlaceXml = await page.evaluate(() => {
      const a = Array.from(document.querySelectorAll("a")).find(x => x.textContent.trim() === "XML");
      return a ? a.href : null;
    });
    const match = (enlaceXml || "").match(/DownloadInvoice\('([^']+)',\s*(\d+)\)/);
    if (!match) {
      await browser.close();
      return { ok: false, msg: "GASHR: factura generada pero no se pudo extraer el link de descarga XML" };
    }
    const nombreArchivo = match[1];
    const estacionLink = match[2];
    const uuid = nombreArchivo.split("_")[3]?.replace(".xml", "");
    if (!uuid) {
      await browser.close();
      return { ok: false, msg: `GASHR: no se pudo extraer el UUID del nombre de archivo "${nombreArchivo}"` };
    }
    console.log(`📄 UUID CFDI: ${uuid}`);

    const xmlResp = await page.evaluate(async (url) => {
      const r = await fetch(url);
      const buf = await r.arrayBuffer();
      return { status: r.status, contentType: r.headers.get("content-type"), b64: btoa(String.fromCharCode(...new Uint8Array(buf))) };
    }, `${BASE_URL}/DownloadInvoice.aspx?fiscalFolioId=${uuid}&stationId=${estacionLink}`);

    let xmlUrl = null, pdfUrl = null;
    if (xmlResp.status === 200 && xmlResp.contentType?.includes("xml")) {
      const xmlBuffer = Buffer.from(xmlResp.b64, "base64");
      xmlUrl = await subirArchivoR2(xmlBuffer, `facturas/gashr_${uuid}.xml`, "application/xml");
      console.log(`☁️ XML subido: ${xmlUrl}`);
    }

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
      pdfUrl = await subirArchivoR2(pdfBuffer, `facturas/gashr_${uuid}.pdf`, "application/pdf");
      console.log(`☁️ PDF subido: ${pdfUrl}`);
    }

    await browser.close();

    if (!xmlUrl) {
      return { ok: false, msg: "GASHR: la factura se generó pero no se pudo descargar el XML real" };
    }
    console.log("✅ GASHR — factura real generada y descargada");
    return { ok: true, xmlUrl, pdfUrl };

  } catch (err) {
    console.error("❌ Error en bot GASHR:", err.message);
    await screenshot("error").catch(() => {});
    await browser.close().catch(() => {});
    return { ok: false, msg: `GASHR: ${err.message}` };
  }
}

module.exports = { facturarGASHR };
