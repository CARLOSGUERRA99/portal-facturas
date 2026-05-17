const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");

// ── CapSolver: resuelve Cloudflare Turnstile vía API ─────────────────────────
async function resolverTurnstile(page, apiKey, capturedSitekey) {
  // Sitekey conocido de facturacion.homedepot.com.mx (respaldo por si los métodos dinámicos fallan)
  const SITEKEY_KNOWN = "0x4AAAAAAB6nsteTRVZ39dGq";
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
    if (sitekey) console.log(`🔑 Sitekey extraído de script: ${sitekey}`);
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

  // Método 3: iframe URL — regex directa sobre la URL completa del frame
  if (!sitekey) {
    for (const f of page.frames()) {
      if (!f.url().includes("challenges.cloudflare.com")) continue;
      const m = f.url().match(/0x[0-9a-zA-Z]{8,}/);
      if (m) { sitekey = m[0]; break; }
    }
  }

  // Método 4: fetch de chunks lazy de Angular (el sitekey vive en el chunk de PortalwebComponent)
  if (!sitekey) {
    sitekey = await page.evaluate(async () => {
      try {
        const scripts = Array.from(document.querySelectorAll("script[src]"))
          .filter(s => /\/\d+\.[^/]+\.js/.test(s.src) || (s.src.includes(".js") && !s.src.includes("main.")));
        for (const script of scripts) {
          const text = await fetch(script.src).then(r => r.text()).catch(() => "");
          const m = text.match(/["'`](0x[0-9a-zA-Z]{8,})["'`]/);
          if (m) return m[1]; // grupo sin comillas
        }
      } catch {}
      return null;
    }).catch(() => null);
    if (sitekey) console.log(`🔑 Sitekey extraído de chunk lazy: ${sitekey}`);
  }

  if (!sitekey) {
    sitekey = SITEKEY_KNOWN;
    console.log(`🔑 Usando sitekey hardcodeado como respaldo: ${sitekey}`);
  }
  console.log(`🔑 Sitekey: ${sitekey}`);

  // CapSolver solo acepta hostname sin puerto no-estándar ni hash
  const rawUrl = new URL(page.url().split("#")[0]);
  const pageUrl = `${rawUrl.protocol}//${rawUrl.hostname}/`;

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

  await page.evaluateOnNewDocument(() => {
    window.__turnstileCallbacks = [];
    window.__turnstileLastParams = null;
    window.__cfMsgHandlers   = [];   // handlers 'message' registrados en window
    window.__cfIncomingMsgs  = [];   // mensajes que lleguen del iframe de CF

    // ── Interceptar window.addEventListener para capturar handlers de 'message' ──
    // Cloudflare's api.js registra un handler para recibir el token del iframe via postMessage.
    // Capturamos ese handler para poder llamarlo con el token de CapSolver.
    const _origAEL = window.addEventListener.bind(window);
    window.addEventListener = function(type, fn, opts) {
      if (type === "message" && typeof fn === "function") {
        window.__cfMsgHandlers.push(fn);
      }
      return _origAEL(type, fn, opts);
    };

    // Listener de captura (true) para ver los mensajes que manda el iframe ANTES de que
    // los procese Cloudflare, y guardar su formato para usarlo luego.
    _origAEL("message", function(e) {
      try {
        if (e.origin && e.origin.includes("cloudflare")) {
          window.__cfIncomingMsgs.push(JSON.stringify({ o: e.origin, d: e.data }).slice(0, 300));
        }
      } catch {}
    }, true);

    // ── Wrap rAF de render() para capturar callbacks de Angular ──
    function wrapTurnstileRender() {
      const ts = window.turnstile;
      if (!ts || typeof ts.render !== "function" || ts.__hd_wrapped) return false;
      const orig = ts.render.bind(ts);
      ts.render = function(container, params) {
        try {
          window.__turnstileLastParams = JSON.stringify({
            sitekey: params?.sitekey, callbackType: typeof params?.callback,
            paramsKeys: params ? Object.keys(params) : [],
          });
          if (params?.sitekey) window.__turnstileSitekey = params.sitekey;
          const cb = params?.callback;
          if (typeof cb === "function") window.__turnstileCallbacks.push(cb);
          else if (typeof cb === "string" && typeof window[cb] === "function")
            window.__turnstileCallbacks.push(window[cb]);
        } catch {}
        return orig(container, params);
      };
      ts.__hd_wrapped = true;
      return true;
    }
    function rafWrap() { if (!wrapTurnstileRender()) requestAnimationFrame(rafWrap); }
    requestAnimationFrame(rafWrap);

    // ── Función de inyección: prueba todos los mecanismos ──
    window.__injectTurnstileToken = function(token) {
      // 1. callbacks capturados por render()
      for (const cb of window.__turnstileCallbacks) { try { cb(token); } catch {} }

      // 2. simular postMessage del iframe hacia los handlers de api.js
      const iframe = document.querySelector('iframe[src*="challenges.cloudflare.com"]');
      const iframeSrc = iframe?.src || "";
      const widgetIdMatch = iframeSrc.match(/cf-chl-widget-([a-z0-9]+)/);
      const widgetId = widgetIdMatch ? widgetIdMatch[1] : undefined;

      // Varios formatos que Cloudflare usa en distintas versiones del widget
      const formats = [
        { source: "cloudflare-challenge-platform", token, widgetId },
        { token, widgetId, event: "token", msgType: "token" },
        { token, widgetId },
        { token },
      ];
      const fakeOrigin = "https://challenges.cloudflare.com";
      for (const data of formats) {
        for (const handler of window.__cfMsgHandlers) {
          try {
            handler.call(window, {
              data, origin: fakeOrigin,
              source: iframe?.contentWindow || null,
            });
          } catch {}
        }
        // También vía dispatchEvent por si Cloudflare usa addEventListener global
        try {
          window.dispatchEvent(new MessageEvent("message", { data, origin: fakeOrigin }));
        } catch {}
      }
    };

    // MutationObserver para sitekey desde iframe src
    const obs = new MutationObserver(() => {
      if (window.__turnstileSitekey) return;
      const iframes = document.querySelectorAll('iframe[src*="challenges.cloudflare.com"]');
      for (const f of iframes) {
        const m = (f.src || "").match(/0x[0-9a-zA-Z]{8,}/);
        if (m) { window.__turnstileSitekey = m[0]; break; }
      }
    });
    obs.observe(document.documentElement, {
      childList: true, subtree: true,
      attributes: true, attributeFilter: ["src"],
    });
  });

  // Capturar sitekey vía respuestas HTTP: chunks Angular + URLs de Cloudflare
  let capturedSitekey = null;
  page.on("response", async (resp) => {
    if (capturedSitekey) return;
    const u = resp.url();

    // Sitekey en URL de Cloudflare (path o query param)
    if (u.includes("challenges.cloudflare.com")) {
      const m = u.match(/0x[0-9a-zA-Z]{8,}/);
      if (m) {
        capturedSitekey = m[0];
        console.log(`🔑 Sitekey en URL Cloudflare: ${capturedSitekey}`);
        return;
      }
    }

    // Sitekey dentro del contenido de un chunk JS de Angular (chunk 1600 = PortalwebComponent)
    if (/\/\d+\.[^/]+\.js(\?|$)/.test(u) || /chunk/.test(u)) {
      try {
        const text = await resp.text().catch(() => "");
        const m = text.match(/["'`](0x[0-9a-zA-Z]{8,})["'`]/);
        if (m) {
          capturedSitekey = m[1]; // m[1] = grupo de captura sin comillas
          console.log(`🔑 Sitekey en chunk JS (${u.split("/").pop().split("?")[0]}): ${capturedSitekey}`);
        }
      } catch {}
    }
  });

  try {
    // ── PASO 1 — Cargar portal ────────────────────────────────────────────────
    console.log("🌐 PASO 1 — Cargando portal...");
    await page.goto(
      "https://facturacion.homedepot.com.mx/",
      { waitUntil: "networkidle0", timeout: 40000 }
    );
    console.log(`📍 URL final: ${page.url()}`);
    await screenshot("paso1_cargado");

    // Diagnóstico: listar frames y scripts cargados
    const frameUrls = page.frames().map(f => f.url()).filter(Boolean);
    console.log(`🔍 Frames (${frameUrls.length}):`, frameUrls.join(" | "));
    const scriptUrls = await page.evaluate(() =>
      Array.from(document.querySelectorAll("script[src]")).map(s => s.src)
    ).catch(() => []);
    console.log(`🔍 Scripts cargados (${scriptUrls.length}):`, scriptUrls.join(" | "));

    // Esperar hasta 15 s a que el componente Angular cargue y Turnstile se renderice
    console.log("⏳ Esperando que Turnstile inicialice...");
    for (let i = 0; i < 30 && !capturedSitekey; i++) {
      await page.waitForTimeout(500);
      if (!capturedSitekey) {
        capturedSitekey = await page.evaluate(() => window.__turnstileSitekey || null).catch(() => null);
      }
      // También revisar frames activos
      if (!capturedSitekey) {
        for (const f of page.frames()) {
          if (!f.url().includes("challenges.cloudflare.com")) continue;
          const m = f.url().match(/0x[0-9a-zA-Z]{8,}/);
          if (m) { capturedSitekey = m[0]; break; }
        }
      }
      if (capturedSitekey) break;
    }
    console.log(`🔑 Sitekey interceptado: ${capturedSitekey || "NO CAPTURADO"}`);
    // Diagnóstico: params exactos que Angular pasó a turnstile.render()
    const renderParams = await page.evaluate(() => window.__turnstileLastParams || "render() nunca llamado").catch(() => "error");
    console.log(`🔍 Turnstile render params: ${renderParams}`);

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

    // Revisar si el Turnstile invisible ya se resolvió solo en background
    const tokenExistente = await page.$eval(
      "input[name='cf-turnstile-response']", el => el.value
    ).catch(() => "");

    if (tokenExistente && tokenExistente.length > 50) {
      console.log(`✅ Turnstile invisible ya resuelto en background (${tokenExistente.length} chars) — sin necesidad de CapSolver`);
    } else if (capsolverKey) {
      const capToken = await resolverTurnstile(page, capsolverKey, capturedSitekey) || "";
      if (capToken) {
        // Diagnóstico: mensajes reales que llegaron del iframe CF y handlers capturados
        const cfDiag = await page.evaluate(() => ({
          incomingMsgs: window.__cfIncomingMsgs || [],
          handlers: window.__cfMsgHandlers?.length || 0,
          renderParams: window.__turnstileLastParams || "render() nunca llamado",
          angularEls: Array.from(document.querySelectorAll("*")).filter(e => !!e.__ngContext__).map(e => e.tagName).slice(0, 15).join(","),
        })).catch(() => ({}));
        console.log(`🔍 CF msgs recibidos: ${JSON.stringify(cfDiag.incomingMsgs)} | handlers: ${cfDiag.handlers}`);
        console.log(`🔍 render params: ${cfDiag.renderParams}`);
        console.log(`🔍 Angular elements: ${cfDiag.angularEls || "ninguno"}`);

        // Inyectar token por todos los mecanismos: render() callbacks + postMessage handlers + __ngContext__
        const injResult = await page.evaluate((token) => {
          const log = [];

          // Mecanismo A: render() callbacks + postMessage handlers (via __injectTurnstileToken)
          if (typeof window.__injectTurnstileToken === "function") {
            window.__injectTurnstileToken(token);
            log.push(`A:cbs=${window.__turnstileCallbacks?.length || 0},handlers=${window.__cfMsgHandlers?.length || 0}`);
          }

          // Mecanismo B: __ngContext__ onChange (ControlValueAccessor de ngx-turnstile)
          const elems = Array.from(document.querySelectorAll("*")).filter(e => !!e.__ngContext__);
          for (const el of elems) {
            const ctx = el.__ngContext__;
            const arr = Array.isArray(ctx) ? ctx : [];
            for (let i = 0; i < arr.length; i++) {
              const item = arr[i];
              if (!item || typeof item !== "object") continue;
              if (typeof item.onChange === "function") {
                try { item.onChange(token); log.push("B:onChange@" + el.tagName + "[" + i + "]"); } catch(e) { log.push("B:ERR:" + e.message); }
              }
              if (item.resolved?.emit) {
                try { item.resolved.emit(token); log.push("B:emit@" + el.tagName + "[" + i + "]"); } catch {}
              }
            }
          }

          // Mecanismo C: input hidden
          const inp = document.querySelector("input[name='cf-turnstile-response']");
          if (inp) {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
            if (setter) setter.call(inp, token); else inp.value = token;
            inp.dispatchEvent(new Event("input",  { bubbles: true }));
            inp.dispatchEvent(new Event("change", { bubbles: true }));
            log.push("C:input");
          }

          return log.join(" | ") || "ningún mecanismo actuó";
        }, capToken);
        console.log(`🔑 Inyección: ${injResult}`);
        await page.waitForTimeout(800);
      }
    } else {
      console.log("⚠️ CAPSOLVER_API_KEY no configurada — intentando sin resolver captcha");
    }

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
