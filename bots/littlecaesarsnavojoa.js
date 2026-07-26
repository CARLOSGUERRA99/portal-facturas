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

async function facturarLittleCaesarsNavojoa({ rfc, razonSocial, regimenFiscal, usoCfdi, ticketId, folio, fecha, total, barcode, cp, portalUrl }) {
  console.log("🤖 Iniciando bot Little Caesars Navojoa (Analytix360/Cafrena)...");
  console.log(`   Folio: ${folio} | Fecha: ${fecha} | Total: ${total} | RFC: ${rfc}`);

  const url = (portalUrl && portalUrl.startsWith("http"))
    ? portalUrl
    : "https://cfdi.analytix360.cloud/cafrena/lc/crear-cvo/";
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

  async function screenshot(label) {
    try {
      const buf = await page.screenshot({ fullPage: false });
      const u = await subirArchivoR2(buf, `debug/littlecaesarsnavojoa_${label}_${Date.now()}.png`, "image/png");
      console.log(`📸 [${label}]: ${u}`);
    } catch {}
  }

  // Helper para detectar selector que exista entre múltiples opciones
  async function resolveSelector(selectors, timeout = 8000) {
    const list = selectors.split(",").map(s => s.trim());
    for (const sel of list) {
      try {
        await page.waitForSelector(sel, { visible: true, timeout });
        const exists = await page.$(sel);
        if (exists) return sel;
      } catch {}
    }
    return null;
  }

  // Helper para llenar fecha en datepicker jQuery UI o input normal
  async function fillFecha(selector, fechaValue) {
    // Intentar setear con jQuery primero (si está disponible)
    const setByJQuery = await page.evaluate((sel, val) => {
      try {
        if (window.$ && $(sel).length) {
          $(sel).val(val).trigger("change").trigger("input").trigger("blur");
          return true;
        }
      } catch {}
      return false;
    }, selector, fechaValue).catch(() => false);

    if (setByJQuery) {
      console.log(`📅 Fecha seteada vía jQuery en ${selector}: "${fechaValue}"`);
    } else {
      await fillInput(page, selector, fechaValue);
    }

    // Verificar valor
    const actual = await page.$eval(selector, el => el.value).catch(() => "?");
    console.log(`📅 ${selector} valor actual: "${actual}"`);
  }

  // Helper fetch con cookies
  async function fetchConCookies(url) {
    const cookies = await page.cookies();
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join("; ");
    const data = await page.evaluate(async (u, ck) => {
      try {
        const r = await fetch(u, { headers: { Cookie: ck }, credentials: "include" });
        const arr = await r.arrayBuffer();
        return { ct: r.headers.get("content-type") || "", bytes: Array.from(new Uint8Array(arr)), ok: r.ok };
      } catch (e) { return { error: e.message }; }
    }, url, cookieStr).catch(() => null);
    if (!data || data.error || !data.bytes) {
      console.log(`⚠️ fetch error para ${url}:`, data?.error);
      return null;
    }
    const buf = Buffer.from(data.bytes);
    console.log(`📄 ${url} → ct: ${data.ct} | size: ${buf.length}`);
    return buf;
  }

  try {
    // ── PASO 1 — Cargar portal ────────────────────────────────────────────
    console.log("🌐 Cargando portal...");
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    await page.waitForTimeout(2000);
    await screenshot("paso1_cargado");

    // Verificar si el portal cargó correctamente o devolvió 404/error
    const pageTitle = await page.title().catch(() => "");
    const bodyText = await page.$eval("body", el => el.innerText).catch(() => "");
    console.log(`📄 Título de página: "${pageTitle}"`);

    if (bodyText.toLowerCase().includes("404") || bodyText.toLowerCase().includes("not found")) {
      // Intentar URL alternativa sin trailing slash o variante
      console.log("⚠️ Posible 404 detectado, intentando URL alternativa...");
      const altUrls = [
        "https://cfdi.analytix360.cloud/cafrena/lc/crear-cvo",
        "https://cfdi.analytix360.cloud/cafrena/",
        "https://cfdi.analytix360.cloud/cafrena/lc/",
      ];
      let cargado = false;
      for (const alt of altUrls) {
        console.log(`🔄 Probando: ${alt}`);
        await page.goto(alt, { waitUntil: "networkidle2", timeout: 15000 }).catch(() => {});
        const bt = await page.$eval("body", el => el.innerText).catch(() => "");
        if (!bt.toLowerCase().includes("404") && !bt.toLowerCase().includes("not found")) {
          console.log(`✅ URL alternativa funcional: ${alt}`);
          cargado = true;
          break;
        }
      }
      if (!cargado) {
        await screenshot("error_404");
        throw new Error("Portal devuelve 404 en todas las URLs conocidas. Verificar URL.");
      }
    }

    await screenshot("paso1_verificado");

    // ── PASO 2 — Detectar campos del formulario ───────────────────────────
    console.log("🔍 Detectando campos del formulario...");

    // Esperar el primer campo visible del formulario
    const primerCampoSel = await Promise.race([
      page.waitForSelector("input[name='folio']", { visible: true, timeout: 15000 }).then(() => "input[name='folio']"),
      page.waitForSelector("#folio",              { visible: true, timeout: 15000 }).then(() => "#folio"),
      page.waitForSelector("input[name='ticket']", { visible: true, timeout: 15000 }).then(() => "input[name='ticket']"),
      page.waitForSelector("form input",           { visible: true, timeout: 15000 }).then(() => "form input"),
    ]).catch(() => null);

    if (!primerCampoSel) {
      await screenshot("error_sin_formulario");
      throw new Error("No se encontró formulario en el portal");
    }
    console.log(`✅ Formulario detectado con selector: ${primerCampoSel}`);
    await screenshot("paso2_formulario");

    // Verificar si ya hay mensaje de folio ya facturado antes de llenar
    const textoInicial = await page.$eval("body", el => el.innerText.toLowerCase()).catch(() => "");
    if (
      textoInicial.includes("ya fue facturado") ||
      textoInicial.includes("ya facturado") ||
      textoInicial.includes("factura ya generada")
    ) {
      console.log("♻️ Ya facturado detectado en pantalla inicial");
      await screenshot("ya_facturado_inicial");
      await browser.close();
      return { ok: true, procesandoCorreo: true };
    }

    // ── PASO 3 — Llenar Folio ─────────────────────────────────────────────
    console.log("📋 Llenando folio del ticket...");
    const folioSel = await resolveSelector("input[name='folio'], #folio, input[name='ticket'], #ticket");
    if (folioSel) {
      await fillInput(page, folioSel, folio || ticketId || "");
    } else {
      console.log("⚠️ No se encontró campo de folio");
    }
    await screenshot("paso3_folio");

    // ── PASO 4 — Llenar Fecha ─────────────────────────────────────────────
    console.log("📋 Llenando fecha del ticket...");
    const fechaSel = await resolveSelector("input[name='fecha'], #fecha, input[name='date'], #date, input[type='date']");
    if (fechaSel && fecha) {
      // Detectar formato esperado por el campo
      const fieldType = await page.$eval(fechaSel, el => el.type).catch(() => "text");
      let fechaFormateada = fecha;

      if (fieldType === "date") {
        // HTML5 date input espera YYYY-MM-DD
        if (fecha.includes("/")) {
          const parts = fecha.split("/");
          if (parts[0].length === 4) {
            fechaFormateada = fecha; // ya es YYYY/MM/DD
          } else {
            // DD/MM/YYYY → YYYY-MM-DD
            fechaFormateada = `${parts[2]}-${parts[1].padStart(2,"0")}-${parts[0].padStart(2,"0")}`;
          }
        }
        await fillFecha(fechaSel, fechaFormateada);
      } else {
        // Texto: intentar DD/MM/YYYY
        if (fecha.includes("-") && fecha.indexOf("-") === 4) {
          // YYYY-MM-DD → DD/MM/YYYY
          const parts = fecha.split("-");
          fechaFormateada = `${parts[2]}/${parts[1]}/${parts[0]}`;
        }
        await fillFecha(fechaSel, fechaFormateada);
      }
    } else if (!fecha) {
      console.log("⚠️ No se proporcionó fecha");
    } else {
      console.log("⚠️ No se encontró campo de fecha");
    }
    await screenshot("paso4_fecha");

    // ── PASO 5 — Llenar Total ─────────────────────────────────────────────
    console.log("📋 Llenando total del ticket...");
    const totalSel = await resolveSelector("input[name='total'], #total, input[name='importe'], #importe, input[name='monto'], #monto");
    if (totalSel && total) {
      await fillInput(page, totalSel, parseFloat(total).toFixed(2));
    } else {
      console.log("⚠️ No se encontró campo de total o no se proporcionó");
    }
    await screenshot("paso5_total");

    // ── PASO 6 — Llenar Código de Barras ──────────────────────────────────
    console.log("📋 Llenando código de barras...");
    const barcodeSel = await resolveSelector("input[name='barcode'], #barcode, input[name='codigo'], #codigo, input[name='codigoBarras'], #codigoBarras");
    if (barcodeSel && barcode) {
      await fillInput(page, barcodeSel, barcode);
    } else {
      console.log("⚠️ No se encontró campo de barcode o no se proporcionó");
    }
    await screenshot("paso6_barcode");

    // ── PASO 7 — Llenar RFC y esperar AJAX ────────────────────────────────
    console.log("📋 Llenando RFC...");
    const rfcSel = await resolveSelector("input[name='rfc'], #rfc, input[name='RFC'], #RFC");
    if (!rfcSel) throw new Error("No se encontró campo RFC");

    await fillInput(page, rfcSel, rfc);

    // Disparar blur para validación AJAX
    await page.$eval(rfcSel, el => {
      el.dispatchEvent(new Event("blur",   { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    console.log("⏳ Esperando respuesta AJAX de validación RFC...");
    await page.waitForTimeout(2500);
    await screenshot("paso7_rfc_validado");

    // ── PASO 8 — Verificar/llenar Razón Social ────────────────────────────
    console.log("📋 Verificando razón social...");
    const rsSel = await resolveSelector("input[name='razonSocial'], #razonSocial, input[name='nombre'], #nombre, input[name='razon_social'], #razon_social");
    if (rsSel) {
      const rsActual = await page.$eval(rsSel, el => el.value).catch(() => "");
      if (!rsActual && razonSocial) {
        console.log("📝 Razón social no se autocompletó, llenando manualmente...");
        await fillInput(page, rsSel, razonSocial);
      } else {
        console.log(`📝 Razón social: "${rsActual || "(no encontrada)"}"`);
      }
    } else {
      console.log("⚠️ No se encontró campo de razón social");
    }
    await screenshot("paso8_razon_social");

    // ── PASO 9 — Llenar Código Postal y esperar AJAX ──────────────────────
    console.log("📋 Llenando código postal...");
    const cpSel = await resolveSelector("input[name='cp'], #cp, input[name='codigoPostal'], #codigoPostal, input[name='codigo_postal'], #codigo_postal");
    if (cpSel && cp) {
      await fillInput(page, cpSel, cp);
      await page.$eval(cpSel, el => {
        el.dispatchEvent(new Event("blur",   { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      });
      console.log("⏳ Esperando AJAX de CP...");
      await page.waitForTimeout(2000);
    } else {
      console.log("⚠️ No se encontró campo de CP o no se proporcionó");
    }
    await screenshot("paso9_cp");

    // ── PASO 10 — Llenar correo electrónico ───────────────────────────────
    console.log("📋 Llenando correo electrónico...");
    const correoSel = await resolveSelector("input[name='correo'], #correo, input[name='email'], #email, input[type='email']");
    if (correoSel) {
      await fillInput(page, correoSel, "buzonfacturas@serviciosga.site");
    } else {
      console.log("⚠️ No se encontró campo de correo");
    }
    await screenshot("paso10_correo");

    // ── PASO 11 — Campos dinámicos: Régimen Fiscal y Uso CFDI ─────────────
    console.log("🔍 Verificando campos dinámicos (régimen fiscal, uso CFDI)...");
    await page.waitForTimeout(1000);

    // Régimen fiscal
    const regimenSel = await resolveSelector(
      "select[name='regimenFiscal'], #regimenFiscal, select[name='regimen'], #regimen, select[name='regime'], #regime, select[name='regimenFiscalReceptor'], #regimenFiscalReceptor",
      5000
    );
    if (regimenSel) {
      console.log(`✅ Select régimen fiscal encontrado: ${regimenSel}`);
      const regimenKeywords = regimenFiscal
        ? [String(regimenFiscal)]
        : ["601", "General de Ley Personas Morales", "General de Ley"];
      await selectByText(page, regimenSel, regimenKeywords);
      await page.waitForTimeout(1500);
    } else {
      console.log("ℹ️ No se encontró select de régimen fiscal");
    }
    await screenshot("paso11_regimen");

    // Uso CFDI — puede aparecer dinámicamente tras régimen
    const cfdiSel = await resolveSelector(
      "select[name='usoCfdi'], #usoCfdi, select[name='usoCFDI'], #usoCFDI, select[name='uso'], #uso, select[name='usocfdi'], #usocfdi",
      5000
    );
    if (cfdiSel) {
      console.log(`✅ Select uso CFDI encontrado: ${cfdiSel}`);

      // Esperar que carguen opciones
      try {
        await page.waitForFunction