const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");

// ── Helpers reutilizables (copiados de gasmaz.js) ─────────────────────────────

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

// ── Bot principal ─────────────────────────────────────────────────────────────

async function facturarHomeDepotMexico({
  rfc, razonSocial, regimenFiscal, usoCfdi, codigoPostal,
  barcode, ticketId,
}) {
  console.log("🤖 Iniciando bot Home Depot Mexico...");
  console.log(`   Barcode: ${barcode} | RFC: ${rfc} | CP: ${codigoPostal}`);

  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error("BROWSERLESS_TOKEN no definido");

  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true`,
    ignoreHTTPSErrors: true,
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
      const u = await subirArchivoR2(buf, `debug/homedepot_${label}_${Date.now()}.png`, "image/png");
      console.log(`📸 [${label}]: ${u}`);
    } catch {}
  }

  try {
    // ── PASO 1 — Cargar portal ────────────────────────────────────────────────
    console.log("🌐 PASO 1 — Cargando portal...");
    await page.goto(
      "https://facturacion.homedepot.com.mx:2053/FacturacionWeb/#/portalweb",
      { waitUntil: "networkidle2", timeout: 30000 }
    );
    await page.waitForTimeout(2000);
    await screenshot("paso1_cargado");
    console.log("✅ Portal cargado");

    // ── PASO 2 — Llenar folio y RFC ───────────────────────────────────────────
    console.log("📋 PASO 2 — Llenando folio y RFC...");

    // Angular SPA: esperar que los campos estén disponibles
    await page.waitForSelector("input", { timeout: 15000 });

    // El portal usa campos sin IDs fijos — buscamos por placeholder o posición
    const inputs = await page.$$("input:not([type='hidden'])");
    console.log(`📊 Inputs encontrados: ${inputs.length}`);

    // Folio / barcode — primer input visible
    await fillInput(page, "input:nth-of-type(1)", barcode);
    await page.waitForTimeout(300);

    // RFC — segundo input visible
    await fillInput(page, "input:nth-of-type(2)", rfc);
    await page.waitForTimeout(300);

    await screenshot("paso2_folio_rfc");

    // ── PASO 3 — Click en Facturar (primer paso) ──────────────────────────────
    console.log("🔍 PASO 3 — Validando folio...");

    const clickedFacturar1 = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button, input[type='submit'], a"))
        .find(el => /facturar|buscar|validar|siguiente|continuar/i.test(el.textContent || el.value || ""));
      if (btn) { btn.scrollIntoView(); btn.click(); return btn.textContent?.trim() || "btn"; }
      return null;
    });
    console.log(`✅ Click en: "${clickedFacturar1}"`);
    await page.waitForTimeout(2000);
    await screenshot("paso3_post_validar");

    // Detectar casos: ya facturado, error, o continúa al paso 2
    const textoActual = await page.evaluate(() => document.body.innerText.toLowerCase());

    if (/ya\s*(fue\s*)?facturad|previously\s*invoiced/i.test(textoActual)) {
      console.log("♻️ Folio ya facturado — intentando recuperar...");
      await screenshot("ya_facturado");
      // Buscar links de descarga
      const { xmlUrl, pdfUrl } = await intentarDescarga(page, browser, ticketId);
      await browser.close();
      if (xmlUrl || pdfUrl) return { ok: true, xmlUrl, pdfUrl, yaExistia: true };
      return { ok: true, procesandoCorreo: true };
    }

    if (/folio\s*inv[aá]lido|no\s*(se\s*)?encontr|ticket\s*no\s*v[aá]lid|vencid|expirad/i.test(textoActual)) {
      const msg = await page.evaluate(() => {
        const alertas = document.querySelectorAll(".alert, .error, [class*='error'], [class*='alert']");
        return alertas.length ? alertas[0].innerText.trim() : "Folio o RFC inválido";
      });
      await browser.close();
      return { ok: false, msg: `Home Depot rechazó el folio: ${msg}` };
    }

    // ── PASO 4 — Llenar datos fiscales ────────────────────────────────────────
    console.log("📋 PASO 4 — Llenando datos fiscales...");
    await page.waitForTimeout(1500);

    // Razón social
    const rsSelector = await encontrarInputPorLabel(page, ["razón social", "razon social", "nombre", "empresa"]);
    if (rsSelector) await fillInput(page, rsSelector, razonSocial);

    // Código postal
    const cpSelector = await encontrarInputPorLabel(page, ["código postal", "codigo postal", "c.p.", "cp"]);
    if (cpSelector) {
      await fillInput(page, cpSelector, String(codigoPostal || ""));
      await page.waitForTimeout(800);
    }

    // Uso CFDI — select
    const cfdiOk = await selectByText(page, "select", ["gastos en general", "G03"]).catch(() => false);
    if (!cfdiOk) {
      // Intentar con ng-select o mat-select de Angular
      await page.evaluate((uso) => {
        const selects = document.querySelectorAll("select, ng-select, mat-select");
        selects.forEach(s => {
          const opt = Array.from(s.options || []).find(o =>
            o.text.toLowerCase().includes("gastos en general")
          );
          if (opt) { s.value = opt.value; s.dispatchEvent(new Event("change", { bubbles: true })); }
        });
      }, usoCfdi);
    }
    await page.waitForTimeout(300);

    // Correo de captura
    const emailSelector = await encontrarInputPorLabel(page, ["correo", "email", "e-mail"]);
    if (emailSelector) await fillInput(page, emailSelector, "buzonfacturas@serviciosga.site");

    await screenshot("paso4_datos_fiscales");
    console.log("✅ Datos fiscales completos");

    // ── PASO 5 — Click en Facturar (segundo paso) ─────────────────────────────
    console.log("🧾 PASO 5 — Generando factura...");
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button, input[type='submit']"))
        .find(el => /facturar|generar|emitir/i.test(el.textContent || el.value || ""));
      if (btn) { btn.scrollIntoView(); btn.click(); }
    });

    await page.waitForTimeout(5000);
    await screenshot("paso5_post_facturar");

    const textoFinal = await page.evaluate(() => document.body.innerText.toLowerCase());
    if (/error|inv[aá]lid|rechazad/i.test(textoFinal) && !/descarg|xml|pdf/i.test(textoFinal)) {
      const msgErr = await page.evaluate(() => {
        const el = document.querySelector(".alert, .error, [class*='error']");
        return el ? el.innerText.trim() : "Error al generar factura";
      });
      await browser.close();
      return { ok: false, msg: msgErr };
    }

    // ── PASO 6 — Descargar XML y PDF ──────────────────────────────────────────
    console.log("📥 PASO 6 — Descargando archivos...");
    const { xmlUrl, pdfUrl } = await intentarDescarga(page, browser, ticketId);
    await browser.close();

    if (!xmlUrl && !pdfUrl) {
      console.log("⚠️ Sin descarga directa — IMAP recogerá del correo");
      return { ok: true, procesandoCorreo: true };
    }

    console.log(`✅ Home Depot OK — XML: ${xmlUrl} | PDF: ${pdfUrl}`);
    return { ok: true, xmlUrl, pdfUrl };

  } catch (err) {
    console.error("❌ Error en bot Home Depot Mexico:", err.message);
    await screenshot("error").catch(() => {});
    try { await browser.close(); } catch {}
    return { ok: false, msg: err.message };
  }
}

// ── Helpers internos ──────────────────────────────────────────────────────────

async function encontrarInputPorLabel(page, keywords) {
  return await page.evaluate((kws) => {
    // Buscar label que contenga la keyword y obtener el input asociado
    const labels = Array.from(document.querySelectorAll("label, .label, mat-label, [class*='label']"));
    for (const label of labels) {
      const texto = label.innerText?.toLowerCase() || "";
      if (kws.some(k => texto.includes(k))) {
        const forAttr = label.getAttribute("for");
        if (forAttr) {
          const input = document.getElementById(forAttr);
          if (input) return `#${forAttr}`;
        }
        // Buscar input hermano o dentro del mismo contenedor
        const parent = label.closest(".form-group, .field, mat-form-field, [class*='form']");
        if (parent) {
          const input = parent.querySelector("input, textarea");
          if (input) {
            if (input.id) return `#${input.id}`;
            if (input.name) return `input[name="${input.name}"]`;
          }
        }
      }
    }
    return null;
  }, keywords);
}

async function intentarDescarga(page, browser, ticketId) {
  const ts = ticketId || Date.now();
  let xmlUrl = null, pdfUrl = null;

  try {
    // Buscar links/botones de descarga en la página actual
    const links = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a, button"))
        .filter(el => /xml|pdf|descarg|factura/i.test(el.textContent || el.href || ""))
        .map(el => ({ texto: el.textContent?.trim(), href: el.href || null }))
    );
    console.log("🔗 Links de descarga encontrados:", JSON.stringify(links));

    // Interceptar nueva pestaña al hacer click en XML/PDF
    async function interceptarClick(keyword) {
      const newPagePromise = new Promise(resolve =>
        browser.once("targetcreated", t => resolve(t.page()))
      );
      await page.evaluate((kw) => {
        const el = Array.from(document.querySelectorAll("a, button"))
          .find(e => (e.textContent || e.href || "").toLowerCase().includes(kw));
        if (el) { el.scrollIntoView(); el.click(); }
      }, keyword);

      const newPage = await Promise.race([
        newPagePromise,
        new Promise((_, r) => setTimeout(() => r(null), 8000)),
      ]).catch(() => null);

      if (!newPage) return null;
      await newPage.waitForTimeout(2000);
      const resp = await newPage.waitForResponse(r => r.status() === 200, { timeout: 8000 }).catch(() => null);
      const buf = resp ? await resp.buffer().catch(() => null) : null;
      await newPage.close().catch(() => {});
      return buf;
    }

    const xmlBuf = await interceptarClick("xml").catch(() => null);
    if (xmlBuf && xmlBuf.length > 200) {
      const preview = xmlBuf.toString("utf8", 0, 10);
      if (preview.includes("<?") || preview.includes("<cfdi") || preview.includes("<Comprobante")) {
        xmlUrl = await subirArchivoR2(xmlBuf, `facturas/homedepot_${ts}.xml`, "application/xml");
        console.log("✅ XML subido:", xmlUrl);
      }
    }

    const pdfBuf = await interceptarClick("pdf").catch(() => null);
    if (pdfBuf && pdfBuf.length > 200 && pdfBuf.toString("latin1", 0, 4) === "%PDF") {
      pdfUrl = await subirArchivoR2(pdfBuf, `facturas/homedepot_${ts}.pdf`, "application/pdf");
      console.log("✅ PDF subido:", pdfUrl);
    }
  } catch (e) {
    console.log("⚠️ Error en descarga:", e.message);
  }

  return { xmlUrl, pdfUrl };
}

module.exports = { facturarHomeDepotMexico };
