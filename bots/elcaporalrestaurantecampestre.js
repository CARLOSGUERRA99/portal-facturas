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

async function facturarElCaporalRestauranteCampestre({ rfc, razonSocial, regimenFiscal, usoCfdi, ticketId, codigoFacturacion, folio, codigoPostal, portalUrl }) {
  console.log("🤖 Iniciando bot El Caporal Restaurante Campestre...");
  console.log(`   RFC: ${rfc} | Razón Social: ${razonSocial} | Código: ${codigoFacturacion} | Folio: ${folio}`);

  const url = (portalUrl && portalUrl.startsWith("http")) ? portalUrl : "https://mefacturo.mx/elcaporalrestaurante";
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

  const ts = ticketId || Date.now();

  async function screenshot(label) {
    try {
      const buf = await page.screenshot({ fullPage: false });
      const u = await subirArchivoR2(buf, `debug/elcaporalrestaurantecampestre_${label}_${Date.now()}.png`, "image/png");
      console.log(`📸 [${label}]: ${u}`);
    } catch {}
  }

  try {
    // ── PASO 1 — Cargar portal ────────────────────────────────────────────
    console.log("🌐 Cargando portal...");
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    await page.waitForSelector("#CodigoUnicoTicket", { timeout: 15000 });
    await screenshot("paso1_cargado");
    console.log("✅ Portal cargado");

    // ── PASO 2 — Llenar campos del paso 1 ────────────────────────────────
    console.log("📋 Llenando campos del paso 1...");

    await fillInput(page, "#CodigoUnicoTicket", codigoFacturacion);
    await fillInput(page, "#FolioTicket", folio);
    await fillInput(page, "#RFC", rfc);

    await screenshot("paso2_campos_paso1");
    console.log("✅ Campos del paso 1 llenados");

    // ── PASO 3 — Click en Facturar (paso 1) ──────────────────────────────
    console.log("🔍 Haciendo click en Facturar (paso 1)...");

    // Manejar posibles diálogos/alertas
    page.on("dialog", async dialog => {
      console.log("🔔 Dialog:", dialog.message());
      await dialog.accept();
    });

    // Intentar distintos selectores para el botón de facturar en paso 1
    const btnFacturarPaso1 = await page.evaluateHandle(() => {
      // Buscar por texto
      const byText = [...document.querySelectorAll("button, input[type='button'], input[type='submit'], a.btn")]
        .find(b => /facturar/i.test(b.textContent || b.value || ""));
      if (byText) return byText;
      // Buscar btn-primary
      const byPrimary = document.querySelector("button.btn-primary, input[type='submit'].btn-primary");
      if (byPrimary) return byPrimary;
      return null;
    });

    const btnEl1 = btnFacturarPaso1.asElement();
    if (!btnEl1) throw new Error("No se encontró el botón 'Facturar' en paso 1");
    await btnEl1.click();
    console.log("✅ Click en Facturar paso 1");

    await page.waitForTimeout(500);

    // ── PASO 4 — Detectar resultado del paso 1 ────────────────────────────
    console.log("⏳ Esperando respuesta del portal tras paso 1...");

    const caso = await Promise.race([
      // Paso 2 cargado: aparece RazonSocial o RFCReceptor
      page.waitForFunction(
        () => {
          const rs = document.querySelector("input[name='RazonSocial'], #RazonSocial");
          const rfcR = document.querySelector("#RFCReceptor");
          const correo = document.querySelector("input[name='Correo'], input[type='email']");
          const cp = document.querySelector("input[name='CP'], #CP");
          if (rs && rs.offsetParent !== null) return true;
          if (rfcR && rfcR.offsetParent !== null) return true;
          if (correo && correo.offsetParent !== null) return true;
          if (cp && cp.offsetParent !== null) return true;
          return false;
        },
        { timeout: 20000 }
      ).then(() => "paso2"),

      // Ya facturado
      page.waitForFunction(
        () => {
          const body = document.body.innerText.toLowerCase();
          return body.includes("ya fue facturado") ||
                 body.includes("ya facturado") ||
                 body.includes("factura generada anteriormente") ||
                 body.includes("recuperar comprobante");
        },
        { timeout: 20000 }
      ).then(() => "ya_facturado"),

      // Error visible
      page.waitForFunction(
        () => {
          const err = document.querySelector(".alert-danger, .alert-warning");
          return err && err.offsetParent !== null && err.textContent.trim().length > 0;
        },
        { timeout: 20000 }
      ).then(() => "error_paso1"),
    ]).catch(() => "timeout");

    await screenshot("paso3_resultado_paso1");
    console.log(`📍 Caso detectado: ${caso}`);

    // ── Caso: ya facturado ────────────────────────────────────────────────
    if (caso === "ya_facturado") {
      console.log("♻️ Ticket ya facturado — buscando enlaces de descarga...");

      // Intentar hacer click en "Recuperar comprobante" si existe
      const btnRecuperar = await page.evaluateHandle(() =>
        [...document.querySelectorAll("button, a.btn")]
          .find(b => /recuperar/i.test(b.textContent || ""))
      );
      const btnRecEl = btnRecuperar.asElement();
      if (btnRecEl) {
        console.log("🔁 Haciendo click en 'Recuperar comprobante'...");
        await btnRecEl.click();
        await page.waitForTimeout(3000);
        await screenshot("paso3_recuperar_comprobante");
      }

      // Buscar enlaces de XML/PDF
      const { xmlUrl, pdfUrl } = await intentarDescargarArchivos(page, browser, ts);

      await browser.close();

      if (!xmlUrl && !pdfUrl) {
        console.log("⚠️ Sin archivos en folio ya facturado — IMAP recogerá del correo");
        return { ok: true, procesandoCorreo: true };
      }
      console.log(`✅ El Caporal (ya facturado) — PDF: ${pdfUrl} | XML: ${xmlUrl}`);
      return { ok: true, xmlUrl, pdfUrl, yaExistia: true };
    }

    // ── Caso: error en paso 1 ─────────────────────────────────────────────
    if (caso === "error_paso1") {
      const msgErr = await page.$eval(
        ".alert-danger, .alert-warning",
        el => el.textContent.trim()
      ).catch(() => "Error desconocido en paso 1");
      throw new Error(`Error en paso 1: ${msgErr}`);
    }

    if (caso === "timeout") {
      throw new Error("El portal no respondió tras hacer click en Facturar (timeout 20s)");
    }

    // ── PASO 5 — Llenar datos de facturación (paso 2) ─────────────────────
    console.log("📋 Llenando datos de facturación en paso 2...");

    // RFC Receptor (confirmación si existe y está visible)
    const rfcReceptorVisible = await page.evaluate(() => {
      const el = document.querySelector("#RFCReceptor");
      return el && el.offsetParent !== null;
    }).catch(() => false);

    if (rfcReceptorVisible) {
      console.log("📋 Campo #RFCReceptor visible — llenando...");
      await fillInput(page, "#RFCReceptor", rfc);
    }

    // Razón Social
    const razonSocialSel = await page.evaluate(() => {
      if (document.querySelector("#RazonSocial") && document.querySelector("#RazonSocial").offsetParent !== null) return "#RazonSocial";
      if (document.querySelector("input[name='RazonSocial']") && document.querySelector("input[name='RazonSocial']").offsetParent !== null) return "input[name='RazonSocial']";
      return null;
    }).catch(() => null);

    if (razonSocialSel && razonSocial) {
      await fillInput(page, razonSocialSel, razonSocial);
    } else if (razonSocialSel) {
      console.log("⚠️ razonSocial no provista — se omite");
    }

    // Código Postal
    const cpSel = await page.evaluate(() => {
      if (document.querySelector("#CP") && document.querySelector("#CP").offsetParent !== null) return "#CP";
      if (document.querySelector("input[name='CP']") && document.querySelector("input[name='CP']").offsetParent !== null) return "input[name='CP']";
      if (document.querySelector("input[placeholder='Código Postal']") && document.querySelector("input[placeholder='Código Postal']").offsetParent !== null) return "input[placeholder='Código Postal']";
      return null;
    }).catch(() => null);

    if (cpSel) {
      const cpValue = codigoPostal || "06600";
      await fillInput(page, cpSel, cpValue);
    } else {
      console.log("⚠️ Campo Código Postal no encontrado visible");
    }

    // Régimen Fiscal
    console.log("📋 Seleccionando Régimen Fiscal...");
    const regimenSel = await page.evaluate(() => {
      if (document.querySelector("#RegimenFiscal") && document.querySelector("#RegimenFiscal").offsetParent !== null) return "#RegimenFiscal";
      if (document.querySelector("select[name='RegimenFiscal']") && document.querySelector("select[name='RegimenFiscal']").offsetParent !== null) return "select[name='RegimenFiscal']";
      return null;
    }).catch(() => null);

    if (regimenSel) {
      await page.waitForFunction(
        (sel) => { const s = document.querySelector(sel); return s && s.options.length > 1; },
        { timeout: 10000 },
        regimenSel
      ).catch(() => console.log("⚠️ Opciones de RegimenFiscal no cargaron a tiempo"));

      const regimenKeywords = regimenFiscal
        ? [String(regimenFiscal)]
        : ["601", "General de Ley Personas Morales", "General de Ley"];
      await selectByText(page, regimenSel, regimenKeywords);
    } else {
      console.log("⚠️ Campo Régimen Fiscal no encontrado visible");
    }

    // Esperar posible recarga AJAX de Uso CFDI tras cambio de régimen
    await page.waitForTimeout(1500);

    // Uso de CFDI
    console.log("📋 Seleccionando Uso de CFDI...");
    const cfdiSel = await page.evaluate(() => {
      if (document.querySelector("#UsoCFDI") && document.querySelector("#UsoCFDI").offsetParent !== null) return "#UsoCFDI";
      if (document.querySelector("select[name='UsoCFDI']") && document.querySelector("select[name='UsoCFDI']").offsetParent !== null) return "select[name='UsoCFDI']";
      return null;
    }).catch(() => null);

    if (cfdiSel) {
      await page.waitForFunction(
        (sel) => { const s = document.querySelector(sel); return s && s.options.length > 1; },
        { timeout: 10000 },
        cfdiSel
      ).catch(() => console.log("⚠️ Opciones de UsoCFDI no cargaron a tiempo"));

      const CFDI_KEYWORDS = {
        G01: ["Adquisición de mercancias", "Adquisicion de mercancias", "G01"],
        G03: ["Gastos en general", "G03"],
        G02: ["Devoluciones, descuentos", "G02"],
        S01: ["Sin efectos fiscales", "S01"],
        CP01: ["Pagos", "CP01"],
        I04: ["Equipo de computo", "I04"],
      };

      const cfdiKeywords = (usoCfdi && CFDI_KEYWORDS[String(usoCfdi).toUpperCase()])
        ? CFDI_KEYWORDS[String(usoCfdi).toUpperCase()]
        : ["Gastos en general", "G03"];

      await selectByText(page, cfdiSel, cfdiKeywords);

      const cfdiVal = await page.$eval(cfdiSel, el => el.value).catch(() => "");
      if (!cfdiVal || cfdiVal === "" || cfdiVal === "undefined") {
        const opciones = await page.$eval(cfdiSel, el =>
          Array.from(el.options).map(o => o.text).join(" | ")
        ).catch(() => "no disponibles");
        throw new Error(`Uso CFDI no seleccionado — opciones: ${opciones}`);
      }
      console.log(`✅ Uso CFDI seleccionado: "${cfdiVal}"`);
    } else {
      console.log("⚠️ Campo Uso CFDI no encontrado visible");
    }

    // Correo electrónico
    console.log("📋 Ingresando correo electrónico...");
    const correoSel = await page.evaluate(() => {
      if (document.querySelector("#Correo") && document.querySelector("#Correo").offsetParent !== null) return "#Correo";
      if (document.querySelector("input[name='Correo']") && document.querySelector("input[name='Correo']").offsetParent !== null) return "input[name='Correo']";
      if (document.querySelector("input[type='email']") && document.querySelector("input[type='email']").offsetParent !== null) return "input[type='email']";
      return null;
    }).catch(() => null);

    if (correoSel) {
      await fillInput(page, correoSel, "buzonfacturas@serviciosga.site");
    } else {
      console.log("⚠️ Campo Correo no encontrado visible");
    }

    await screenshot("paso5_datos_facturacion");
    console.log("✅ Datos de facturación del paso 2 completos");

    // ── PASO 6 — Click en Generar Factura (paso 2) ────────────────────────
    console.log("🧾 Haciendo click en botón de generación de factura (paso 2)...");

    const btnFacturarPaso2 = await page.evaluateHandle(() => {
      // Buscar botón de confirmación/generar en paso 2
      const candidates = [...document.querySelectorAll("button, input[type='button'], input[type='submit'], a.btn")];
      // Prioridad: texto "Generar", "Facturar", "Confirmar", "Enviar", "Timbrar"
      const byText = candidates.find(b => {
        const txt = (b.textContent || b.value || "").toLowerCase();
        return /generar|facturar|confirmar|enviar|timbrar|emitir/i.test(txt) && b.offsetParent !== null;
      });
      if (byText) return byText;
      // Fallback: btn-primary visible
      const byPrimary = candidates.find(b =>
        b.classList.contains("btn-primary") && b.offsetParent !== null
      );
      return byPrimary || null;
    });

    const btnEl2 = btnFacturarPaso2.asElement();
    if (!btnEl2) throw new Error("No se encontró el botón