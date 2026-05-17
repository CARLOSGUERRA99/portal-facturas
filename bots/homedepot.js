const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");

// Llena un input Angular usando el setter nativo (evita caracteres extra o desordenados)
async function fillInput(page, selector, value) {
  await page.$eval(selector, (el, v) => {
    // Setter nativo bypasea el override de Angular y escribe el valor limpio de golpe
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(el, v); else el.value = v;
    el.dispatchEvent(new Event("input",  { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur",   { bubbles: true }));
  }, String(value));
  await page.waitForTimeout(150);
  const actual = await page.$eval(selector, el => el.value).catch(() => "?");
  console.log(`📝 ${selector}: "${actual}"`);
}

// Selecciona por value exacto en un <select> de Angular
async function selectByValue(page, selector, value) {
  const found = await page.$eval(selector, (el, v) => {
    const opt = Array.from(el.options).find(o => o.value === v || o.text.toLowerCase().includes(v.toLowerCase()));
    if (!opt) return null;
    el.value = opt.value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
    return opt.text;
  }, value);
  console.log(`📝 ${selector}: "${found || "NO ENCONTRADO"}"`);
  return !!found;
}

// ── Bot principal ─────────────────────────────────────────────────────────────

async function facturarHomeDepotMexico({
  rfc, razonSocial, regimenFiscal, usoCfdi, codigoPostal,
  barcode, folio, ticketId,
}) {
  // El OCR guarda el número de ticket en "folio" o "barcode"
  const noTicket = barcode || folio;

  console.log("🤖 Iniciando bot Home Depot Mexico...");
  console.log(`   Ticket: ${noTicket} | RFC: ${rfc} | CP: ${codigoPostal}`);

  if (!noTicket) return { ok: false, msg: "No. de Ticket no disponible en los datos del ticket" };

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
    // La URL base redirige automáticamente al puerto 2053 con Angular SPA
    await page.goto(
      "https://facturacion.homedepot.com.mx/",
      { waitUntil: "networkidle2", timeout: 40000 }
    );
    await page.waitForTimeout(3000);
    await screenshot("paso1_cargado");
    console.log(`📍 URL final: ${page.url()}`);

    // ── PASO 2 — Esperar campos y llenar RFC + Ticket ─────────────────────────
    console.log("📋 PASO 2 — Llenando RFC y No. de Ticket...");

    // Esperar que los campos del formulario Angular estén disponibles
    await page.waitForSelector("#rfc", { timeout: 20000 });
    await page.waitForSelector("#ticket", { timeout: 10000 });

    // Verificar estado del Turnstile (debería estar resuelto por stealth)
    const turnstileToken = await page.$eval(
      "input[name='cf-turnstile-response']",
      el => el.value
    ).catch(() => null);
    console.log(`🔒 Turnstile token: ${turnstileToken ? "PRESENTE (" + turnstileToken.length + " chars)" : "AUSENTE"}`);

    // Llenar RFC — id="rfc"
    await fillInput(page, "#rfc", rfc);
    await page.waitForTimeout(300);

    // Llenar No. de Ticket — id="ticket" (solo dígitos, 18-23 chars)
    await fillInput(page, "#ticket", noTicket);
    await page.waitForTimeout(500);

    await screenshot("paso2_rfc_ticket");

    // ── PASO 3 — Esperar que Continuar se habilite y hacer click ──────────────
    console.log("⏳ PASO 3 — Esperando que el botón Continuar se habilite...");

    // El botón se habilita cuando RFC + ticket son válidos Y el Turnstile está resuelto
    await page.waitForFunction(
      () => {
        const btn = document.querySelector("button.btn-primary");
        return btn && !btn.disabled;
      },
      { timeout: 20000 }
    ).catch(() => console.log("⚠️ Botón Continuar no se habilitó en 20s — intentando click de todos modos"));

    // Si el Turnstile aún no está resuelto, esperar un poco más
    const btnHabilitado = await page.$eval("button.btn-primary", el => !el.disabled).catch(() => false);
    if (!btnHabilitado) {
      console.log("⏳ Botón aún deshabilitado — esperando 5s más por Turnstile...");
      await page.waitForTimeout(5000);
    }

    await screenshot("paso3_pre_continuar");

    const estadoBtn = await page.$eval("button.btn-primary", el => ({
      texto: el.textContent.trim(),
      disabled: el.disabled,
    })).catch(() => ({ texto: "?", disabled: true }));
    console.log(`🔘 Botón Continuar: "${estadoBtn.texto}" | disabled: ${estadoBtn.disabled}`);

    await page.click("button.btn-primary");
    console.log("✅ Click en Continuar");
    await page.waitForTimeout(3000);
    await screenshot("paso3_post_continuar");

    // Detectar casos especiales
    const textoTrasValidar = await page.evaluate(() => document.body.innerText.toLowerCase());

    if (/ya\s*(fue\s*)?facturad|previously\s*invoiced/i.test(textoTrasValidar)) {
      console.log("♻️ Folio ya facturado — intentando recuperar...");
      await screenshot("ya_facturado");
      const { xmlUrl, pdfUrl } = await intentarDescarga(page, browser, ticketId);
      await browser.close();
      if (xmlUrl || pdfUrl) return { ok: true, xmlUrl, pdfUrl, yaExistia: true };
      return { ok: true, procesandoCorreo: true };
    }

    if (/folio\s*inv[aá]lido|no\s*(se\s*)?encontr|ticket\s*no\s*v[aá]lid|vencid|expirad|no\s*existe/i.test(textoTrasValidar)) {
      const msg = await page.evaluate(() => {
        const alertas = document.querySelectorAll(".alert, .error, [class*='error'], p");
        for (const a of alertas) {
          const t = a.innerText?.trim();
          if (t && t.length > 10 && t.length < 300) return t;
        }
        return "Folio o RFC inválido";
      });
      await browser.close();
      return { ok: false, msg: `Home Depot rechazó el folio: ${msg}` };
    }

    // ── PASO 4 — Llenar datos fiscales (página 2) ─────────────────────────────
    // IDs exactos del HTML: #nombre, #codigoPostal, #regimenFiscal, #usoCfdi, #correo
    console.log("📋 PASO 4 — Llenando datos fiscales...");
    await page.waitForSelector("#nombre", { timeout: 15000 });

    // Razón Social — sin régimen societario
    await fillInput(page, "#nombre", razonSocial);

    // Código Postal — máx 5 dígitos
    await fillInput(page, "#codigoPostal", String(codigoPostal || "").slice(0, 5));
    await page.waitForTimeout(500);

    // Régimen Fiscal — select con value numérico ("601", "626", etc.)
    const regimenCodigo = String(regimenFiscal || "").match(/\d{3}/)?.[0] || "601";
    await selectByValue(page, "#regimenFiscal", regimenCodigo);
    await page.waitForTimeout(300);

    // Uso CFDI — select con value tipo "G03"
    const cfdiCodigo = String(usoCfdi || "").match(/[A-Z]\d+/)?.[0] || "G03";
    await selectByValue(page, "#usoCfdi", cfdiCodigo);
    await page.waitForTimeout(300);

    // Correo electrónico
    await fillInput(page, "#correo", "buzonfacturas@serviciosga.site");

    await screenshot("paso4_datos_fiscales");
    console.log("✅ Datos fiscales completos");

    // ── PASO 5 — Click en Facturar ────────────────────────────────────────────
    console.log("🧾 PASO 5 — Haciendo click en Facturar...");

    // Esperar que el botón Facturar esté habilitado
    await page.waitForFunction(
      () => {
        const btn = document.querySelector("button.btn-primary");
        return btn && !btn.disabled;
      },
      { timeout: 10000 }
    ).catch(() => console.log("⚠️ Botón Facturar no disponible — intentando de todos modos"));

    await page.click("button.btn-primary");
    console.log("✅ Click en Facturar");
    await page.waitForTimeout(6000);
    await screenshot("paso5_post_facturar");

    const textoFinal = await page.evaluate(() => document.body.innerText.toLowerCase());
    if (/error|inv[aá]lid|rechazad/i.test(textoFinal) && !/descarg|xml|pdf/i.test(textoFinal)) {
      const msgErr = await page.evaluate(() => {
        const el = document.querySelector(".alert, .error, [class*='error'], p");
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

async function intentarDescarga(page, browser, ticketId) {
  const ts = ticketId || Date.now();
  let xmlUrl = null, pdfUrl = null;

  try {
    const links = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a, button"))
        .filter(el => /xml|pdf|descarg|factura/i.test(el.textContent || el.href || ""))
        .map(el => ({ texto: el.textContent?.trim(), href: el.href || null }))
    );
    console.log("🔗 Links de descarga encontrados:", JSON.stringify(links));

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
