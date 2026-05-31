const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");

// ── CapSolver ────────────────────────────────────────────────────────────────
async function resolverCaptcha(imgBase64) {
  const apiKey = process.env.CAPSOLVER_API_KEY;
  if (!apiKey) throw new Error("CAPSOLVER_API_KEY no definida");
  const c = await fetch("https://api.capsolver.com/createTask", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey: apiKey, task: { type: "ImageToTextTask", body: imgBase64 } }),
  }).then(r => r.json());
  if (c.errorId) throw new Error(`CapSolver create: ${c.errorCode}`);
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const res = await fetch("https://api.capsolver.com/getTaskResult", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: apiKey, taskId: c.taskId }),
    }).then(r => r.json());
    if (res.status === "ready") {
      const sol = (res.solution?.text || "").trim();
      if (!sol) throw new Error("CapSolver sin texto");
      console.log(`🔓 CAPTCHA: "${sol}"`); return sol;
    }
    if (res.errorId) throw new Error(`CapSolver result: ${res.errorCode}`);
  }
  throw new Error("CapSolver timeout 30s");
}

// ── Bot principal ─────────────────────────────────────────────────────────────
async function facturar7Eleven({ folio, referencia, total, rfc, razonSocial,
  regimenFiscal, usoCfdi, codigoPostal, ticketId }) {

  const folioVal = String(folio || referencia || "").trim();
  console.log("🤖 Iniciando bot 7-Eleven México...");
  console.log(`   Folio: ${folioVal} (${folioVal.length} díg.) | RFC: ${rfc}`);
  if (folioVal.length !== 35) console.log(`⚠️  Folio tiene ${folioVal.length} dígitos — se esperan 35`);

  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error("BROWSERLESS_TOKEN no definido");

  let browser;
  try {
    browser = await puppeteer.connect({
      browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true`,
    });
  } catch (e) { return { ok: false, msg: `7-Eleven: no se pudo conectar — ${e.message}` }; }

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36");
  await page.setExtraHTTPHeaders({ "Accept-Language": "es-MX,es;q=0.9" });

  const ts = ticketId || Date.now();
  const snap = async (label) => {
    try {
      const buf = await page.screenshot({ fullPage: false });
      const u = await subirArchivoR2(buf, `debug/7e_${ts}_${label}_${Date.now()}.png`, "image/png");
      console.log(`📸 [${label}]: ${u}`);
    } catch {}
  };

  // Helper: llenar campo con setter Angular-safe
  const setField = async (sel, val) => page.evaluate((s, v) => {
    const el = document.querySelector(s);
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter ? setter.call(el, v) : (el.value = v);
    ['input', 'change', 'blur'].forEach(ev => el.dispatchEvent(new Event(ev, { bubbles: true })));
    return true;
  }, sel, String(val)).catch(() => false);

  // Helper: buscar CAPTCHA por varios selectores y capturarlo como base64
  const capturarCaptcha = async () => {
    const sel = await page.evaluate(() => {
      for (const s of ["img#Kaptcha", "img.kaptcha", "img[src*='Kaptcha']", "img[src*='kaptcha']", "img[src*='captcha']"]) {
        const el = document.querySelector(s);
        if (el && el.offsetParent) return s;
      }
      // Por tamaño: el CAPTCHA es ~200x50
      const img = Array.from(document.querySelectorAll("img")).find(i =>
        i.offsetParent && i.naturalWidth >= 100 && i.naturalWidth <= 300 &&
        i.naturalHeight >= 25 && i.naturalHeight <= 100 &&
        !/(logo|icon|reload|banner)/i.test(i.src)
      );
      return img ? `img[src="${img.src}"]` : null;
    }).catch(() => null);

    if (!sel) { console.log("   ⚠️  CAPTCHA no encontrado"); return null; }

    const rect = await page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.max(0, Math.round(r.x)), y: Math.max(0, Math.round(r.y)), width: Math.round(r.width), height: Math.round(r.height) };
    }, sel).catch(() => null);

    if (!rect || rect.width < 10) { console.log("   ⚠️  CAPTCHA rect inválido"); return null; }

    // Scroll al elemento
    await page.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: "center" }), sel).catch(() => {});
    await page.waitForTimeout(400);

    const buf = await page.screenshot({ type: "jpeg", clip: rect }).catch(() => null);
    if (!buf) return null;
    console.log(`   CAPTCHA ${rect.width}×${rect.height}px (${buf.length}b)`);
    await subirArchivoR2(buf, `debug/7e_${ts}_captcha_${Date.now()}.jpg`, "image/jpeg").catch(() => {});
    return buf.toString("base64");
  };

  try {
    // ── 1. Cargar portal ────────────────────────────────────────────────────
    await page.goto("https://www.e7-eleven.com.mx/facturacion/KPortalExterno/",
      { waitUntil: "networkidle2", timeout: 40000 });
    await page.waitForTimeout(3000);
    await snap("p0");

    // ── 2. Click FACTURA EXPRESS ────────────────────────────────────────────
    const okExpress = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button,a,.btn"))
        .find(e => e.offsetParent && (e.textContent || "").trim().toUpperCase() === "FACTURA EXPRESS");
      if (btn) { btn.click(); return true; } return false;
    });
    if (!okExpress) { await snap("err_noexpress"); await browser.close(); return { ok: false, msg: "7-Eleven: no se encontró FACTURA EXPRESS" }; }
    await page.waitForTimeout(4500);
    await page.waitForSelector('input[name="noTicket"]', { timeout: 10000 }).catch(() => {});
    await snap("p1_form");
    console.log("✅ Formulario visible");

    // ── 3. Llenar TODO el formulario en un solo evaluate ────────────────────
    const llenado = await page.evaluate((d) => {
      const set = (el, val) => {
        if (!el) return false;
        const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        s ? s.call(el, val) : (el.value = val);
        ['input', 'change', 'blur'].forEach(ev => el.dispatchEvent(new Event(ev, { bubbles: true })));
        return true;
      };
      const res = {};
      res.ticket   = set(document.querySelector('input[name="noTicket"]'), d.folio);
      res.rfc      = set(document.querySelector('#rfcCliente'), d.rfc);
      res.razon    = set(document.querySelector('#razon'), d.razonSocial || '');
      res.cp       = set(document.querySelector('#cp'), d.codigoPostal || '');
      res.email    = set(document.querySelector('#emailInput'), 'buzonfacturas@serviciosga.site');
      res.fpago    = set(document.querySelector('#formaPagoAux'), 'Efectivo');
      const selReg = document.querySelector('#regimenFiscalReceptor');
      if (selReg) { for (const o of selReg.options) { if (o.value === d.regimenFiscal || o.text.includes(d.regimenFiscal) || o.text.includes('General de Ley')) { selReg.value = o.value; selReg.dispatchEvent(new Event('change', { bubbles: true })); res.regimen = true; break; } } }
      const selCfdi = document.querySelector('#usoCfdi');
      if (selCfdi) { for (const o of selCfdi.options) { if (o.value.includes(d.usoCfdi) || o.text.includes('Gastos en general')) { selCfdi.value = o.value; selCfdi.dispatchEvent(new Event('change', { bubbles: true })); res.cfdi = true; break; } } }
      return res;
    }, { folio: folioVal, rfc, razonSocial, codigoPostal: codigoPostal || '', regimenFiscal: String(regimenFiscal || '601'), usoCfdi: usoCfdi || 'G03' });

    console.log("📋 Campos:", JSON.stringify(llenado));
    await page.waitForTimeout(800);
    await snap("p2_llenado");

    // ── 4. Click Agregar Ticket + esperar la navegación (es POST, no AJAX) ──
    console.log("🖱️  Agregar Ticket...");
    const navWait = page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 }).catch(() => null);
    const r = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button,a,.btn"))
        .find(e => e.offsetParent && /agregar\s*ticket/i.test(e.textContent || e.value || ''));
      if (!btn) return null;
      const rc = btn.getBoundingClientRect();
      return { x: rc.left + rc.width / 2, y: rc.top + rc.height / 2 };
    }).catch(() => null);
    if (r) await page.mouse.click(r.x, r.y);
    await navWait;  // esperar que la página nueva cargue
    await page.waitForTimeout(2500);
    console.log("   URL:", page.url());
    await snap("p3_tras_agregar");

    // ── 5. Diagnosticar DOM de la nueva página ──────────────────────────────
    const dom = await page.evaluate(() => ({
      filas: document.querySelectorAll("table tbody tr").length,
      captchaInput: !!document.querySelector("#captcha"),
      bodySnip: (document.body.innerText || "").slice(0, 300),
      imgs: Array.from(document.querySelectorAll("img")).filter(i => i.offsetParent).map(i => ({ id: i.id, src: i.src.split('/').pop().slice(0, 40), w: i.naturalWidth, h: i.naturalHeight }))
    })).catch(() => ({}));
    console.log("🔍 DOM:", JSON.stringify(dom));

    // Si no hay campo CAPTCHA, puede que la navegación devolvió a inicio o error
    if (!dom.captchaInput) {
      console.log("⚠️  No hay #captcha en el DOM — ticket posiblemente inválido o ya usado");
      // Revisar si hay mensaje de error
      if (/no.*encontr|inv[aá]lido|error/i.test(dom.bodySnip || "")) {
        await browser.close();
        return { ok: false, error_code: "datos_invalidos", msg: "7-Eleven: ticket no encontrado — folio incorrecto o ya usado" };
      }
      // Devolver error genérico para que el usuario reintente con ticket nuevo
      await browser.close();
      return { ok: false, msg: "7-Eleven: formulario no disponible tras Agregar Ticket. Verifica que el folio sea válido y no haya sido facturado." };
    }

    // ── 6. Loop CAPTCHA + FACTURAR (hasta 3 intentos) ──────────────────────
    for (let intento = 1; intento <= 3; intento++) {
      console.log(`🔐 Intento CAPTCHA ${intento}/3...`);
      const base64 = await capturarCaptcha();
      if (!base64) {
        if (intento < 3) { await page.waitForTimeout(2000); continue; }
        break;
      }

      let sol;
      try { sol = await resolverCaptcha(base64); }
      catch (e) {
        console.log(`   CapSolver falló: ${e.message}`);
        await setField("#captcha", "").catch(() => {});
        await page.evaluate(() => { document.querySelector("img#reload,img[id*='reload']")?.click(); }).catch(() => {});
        await page.waitForTimeout(2500);
        continue;
      }

      // Escribir solución
      await setField("#captcha", sol);
      await page.waitForTimeout(300);

      // Click FACTURAR
      console.log("🧾 FACTURAR...");
      const navFact = page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 }).catch(() => null);
      const rFact = await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll("button,a,.btn"))
          .find(e => e.offsetParent && /^facturar$/i.test((e.textContent || e.value || "").trim()));
        if (!btn) return null;
        const rc = btn.getBoundingClientRect();
        return { x: rc.left + rc.width / 2, y: rc.top + rc.height / 2 };
      }).catch(() => null);
      if (rFact) await page.mouse.click(rFact.x, rFact.y);
      await navFact;
      await page.waitForTimeout(5000);
      await snap(`p4_resultado_${intento}`);

      const body = await page.evaluate(() => document.body.innerText || "").catch(() => "");

      // CAPTCHA incorrecto → recargar y reintentar
      if (/captcha.*(incorrecto|inv[aá]lido)|código.*(incorrecto|inv[aá]lido)/i.test(body)) {
        console.log("   CAPTCHA incorrecto — recargando...");
        await page.evaluate(() => { document.querySelector("img#reload,img[id*='reload']")?.click(); }).catch(() => {});
        await page.waitForTimeout(2500);
        continue;
      }
      // Ya facturado
      if (/ya\s+(fue|ha\s+sido)\s+facturad/i.test(body)) {
        await browser.close(); return { ok: false, error_code: "ya_facturado", msg: "7-Eleven: ya facturado" };
      }
      // Datos inválidos
      if (/no\s+(encontr[oó]|existe)|inv[aá]lido/i.test(body) && !/factura|xml|pdf/i.test(body)) {
        await browser.close(); return { ok: false, error_code: "datos_invalidos", msg: "7-Eleven: ticket no encontrado" };
      }
      // Éxito — buscar descarga
      const xmlUrl = await page.evaluate(() => Array.from(document.querySelectorAll("a[href]")).find(a => /\.xml/i.test(a.href))?.href || null).catch(() => null);
      const pdfUrl = await page.evaluate(() => Array.from(document.querySelectorAll("a[href]")).find(a => /\.pdf/i.test(a.href))?.href || null).catch(() => null);
      await browser.close();
      if (xmlUrl || pdfUrl) { console.log(`✅ OK — XML: ${xmlUrl} PDF: ${pdfUrl}`); return { ok: true, xmlUrl, pdfUrl }; }
      return { ok: true, procesandoCorreo: true };
    }

    await snap("err_captcha_agotado");
    await browser.close();
    return { ok: false, error_code: "captcha", msg: "7-Eleven: no se pudo resolver el CAPTCHA en 3 intentos" };

  } catch (err) {
    console.error("❌ Error en bot 7-Eleven:", err.message);
    await snap("error").catch(() => {});
    try { await browser.close(); } catch {}
    return { ok: false, msg: err.message };
  }
}

module.exports = { facturar7Eleven };
