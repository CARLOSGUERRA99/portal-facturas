const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");

// ── CapSolver: resuelve Cloudflare Turnstile vía API ─────────────────────────
async function resolverTurnstile(page, apiKey, capturedSitekey) {
  let sitekey = capturedSitekey || null;

  // Método 1: leer main.js (mismo origen) y buscar el sitekey compilado
  if (!sitekey) {
    sitekey = await page.evaluate(async () => {
      try {
        const scripts = Array.from(document.querySelectorAll("script[src]"));
        const mainScript = scripts.find(s => s.src.includes("main."));
        if (!mainScript) return null;
        const text = await fetch(mainScript.src).then(r => r.text());
        // Sitekey Turnstile: empieza con 0x seguido de 8+ chars hex/alfanum
        const m = text.match(/["'`](0x[0-9a-zA-Z]{8,})["'`]/);
        return m ? m[1] : null;
      } catch { return null; }
    }).catch(() => null);
    if (sitekey) console.log(`🔑 Sitekey extraído de main.js: ${sitekey}`);
  }

  // Método 2: window.turnstile widgets activos
  if (!sitekey) {
    sitekey = await page.evaluate(() => {
      try {
        const w = window.turnstile;
        if (!w) return null;
        for (const key of Object.keys(w)) {
          const val = w[key];
          if (val && typeof val === "object") {
            const sk = val.sitekey || val.params?.sitekey;
            if (sk) return sk;
          }
        }
      } catch {}
      return null;
    }).catch(() => null);
  }

  // Método 3: iframe URL
  if (!sitekey) {
    for (const f of page.frames()) {
      if (!f.url().includes("challenges.cloudflare.com")) continue;
      try {
        const u = new URL(f.url());
        const k = u.searchParams.get("k") || u.searchParams.get("sitekey");
        if (k) { sitekey = k; break; }
        // Buscar en path segments (formato /h/b/turnstile/f/{version}/{sitekey})
        const parts = u.pathname.split("/").filter(Boolean);
        const idx = parts.indexOf("f");
        if (idx >= 0 && parts[idx + 2] && /^0x/.test(parts[idx + 2])) {
          sitekey = parts[idx + 2]; break;
        }
      } catch {}
    }
  }

  if (!sitekey) {
    console.log("❌ CapSolver: sitekey no encontrado en main.js, turnstile ni iframe");
    return null;
  }
  console.log(`🔑 Sitekey: ${sitekey}`);

  const pageUrl = page.url();

  // Crear tarea en CapSolver
  const createRes = await fetch("https://api.capsolver.com/createTask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientKey: apiKey,
      task: {
        type: "AntiTurnstileTaskProxyLess",
        websiteURL: pageUrl,
        websiteKey: sitekey,
      },
    }),
  }).then(r => r.json()).catch(e => ({ errorId: 1, errorDescription: e.message }));

  if (createRes.errorId > 0) {
    console.log("❌ CapSolver createTask error:", createRes.errorDescription);
    return null;
  }

  const taskId = createRes.taskId;
  console.log(`🔑 CapSolver taskId: ${taskId} — esperando solución...`);

  // Polling hasta 60s
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const result = await fetch("https://api.capsolver.com/getTaskResult", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: apiKey, taskId }),
    }).then(r => r.json()).catch(() => ({}));

    if (result.status === "ready") {
      const token = result.solution?.token;
      console.log(`✅ CapSolver resolvió Turnstile (${token?.length} chars)`);
      return token;
    }
    if (result.errorId > 0) {
      console.log("❌ CapSolver polling error:", result.errorDescription);
      return null;
    }
  }

  console.log("❌ CapSolver: timeout 60s sin solución");
  return null;
}

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

  // Interceptar window.turnstile.render() ANTES de que Angular lo llame
  // Es la única forma confiable de capturar el sitekey
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(window, "turnstile", {
      configurable: true,
      get() { return this._turnstileReal; },
      set(val) {
        if (val && typeof val.render === "function") {
          const orig = val.render.bind(val);
          val.render = function(container, params) {
            if (params && params.sitekey) {
              window.__turnstileSitekey = params.sitekey;
            }
            return orig(container, params);
          };
        }
        this._turnstileReal = val;
      },
    });
  });

  let capturedSitekey = null;

  try {
    // ── PASO 1 — Cargar portal ────────────────────────────────────────────────
    console.log("🌐 PASO 1 — Cargando portal...");
    await page.goto(
      "https://facturacion.homedepot.com.mx/",
      { waitUntil: "networkidle0", timeout: 40000 }
    );
    console.log(`📍 URL final: ${page.url()}`);
    // Leer sitekey capturado por el interceptor
    capturedSitekey = await page.evaluate(() => window.__turnstileSitekey || null).catch(() => null);
    console.log(`🔑 Sitekey interceptado: ${capturedSitekey || "NO CAPTURADO"}`);
    await screenshot("paso1_cargado");

    // ── PASO 2 — Llenar RFC + Ticket ─────────────────────────────────────────
    console.log("📋 PASO 2 — Llenando RFC y No. de Ticket...");
    await page.waitForSelector("#rfc",    { timeout: 15000 });
    await page.waitForSelector("#ticket", { timeout: 10000 });
    await fillInput(page, "#rfc",    rfc);
    await fillInput(page, "#ticket", noTicket);
    await screenshot("paso2_rfc_ticket");

    // ── PASO 3 — Resolver Turnstile con CapSolver ────────────────────────────
    console.log("🔒 PASO 3 — Resolviendo Cloudflare Turnstile...");

    const capsolverKey = process.env.CAPSOLVER_API_KEY;
    let token = "";

    if (capsolverKey) {
      token = await resolverTurnstile(page, capsolverKey, capturedSitekey) || "";
      if (token) {
        // Inyectar token en el hidden input de Turnstile
        await page.$eval("input[name='cf-turnstile-response']", (el, t) => {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
          if (setter) setter.call(el, t); else el.value = t;
          el.dispatchEvent(new Event("input",  { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }, token);
        console.log("✅ Token Turnstile inyectado en el formulario");
      }
    } else {
      console.log("⚠️ CAPSOLVER_API_KEY no configurada — intentando sin resolver captcha");
    }

    console.log(`🔒 Turnstile: ${token.length > 50 ? "RESUELTO (" + token.length + " chars)" : "NO RESUELTO"}`);

    // Esperar que Angular habilite el botón (campos válidos)
    await page.waitForFunction(
      () => { const btn = document.querySelector("button.btn-primary"); return btn && !btn.disabled; },
      { timeout: 10000 }
    ).catch(() => {});

    await screenshot("paso3_pre_continuar");
    const estadoBtn = await page.$eval("button.btn-primary", el => ({
      texto: el.textContent.trim(), disabled: el.disabled,
    })).catch(() => ({ texto: "?", disabled: true }));
    console.log(`🔘 Botón Continuar: "${estadoBtn.texto}" | disabled: ${estadoBtn.disabled}`);

    await page.click("button.btn-primary");
    console.log("✅ Click en Continuar");
    await page.waitForTimeout(3000);
    await screenshot("paso3_post_continuar");

    // Si sigue el error de captcha, registrar y salir
    const textoError = await page.evaluate(() => document.body.innerText).catch(() => "");
    if (/verificaci|seguridad/i.test(textoError)) {
      await browser.close();
      return { ok: false, msg: "Cloudflare Turnstile no resuelto — se requiere servicio de CAPTCHA" };
    }

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
