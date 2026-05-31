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
      console.log(`🔓 CAPTCHA resuelto: "${sol}"`);
      return sol;
    }
    if (res.errorId) throw new Error(`CapSolver result: ${res.errorCode}`);
  }
  throw new Error("CapSolver timeout 30s");
}

// ── Bot principal ─────────────────────────────────────────────────────────────
async function facturar7Eleven({ folio, referencia, total, rfc, razonSocial,
  regimenFiscal, usoCfdi, codigoPostal, ticketId }) {

  const folioVal = String(folio || referencia || "").trim();
  console.log("🤖 7-Eleven | Folio:", folioVal, `(${folioVal.length} díg.) | RFC:`, rfc);
  if (folioVal.length !== 35)
    console.log(`⚠️  Folio tiene ${folioVal.length} dígitos — se esperan 35`);

  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error("BROWSERLESS_TOKEN no definido");

  let browser;
  try {
    browser = await puppeteer.connect({
      browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true&timeout=120000`,
    });
  } catch (e) {
    return { ok: false, msg: `7-Eleven: no se pudo conectar — ${e.message}` };
  }

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

  // Setter Angular-safe para campos que NO son el ticket
  const setField = (sel, val) => page.evaluate((s, v) => {
    const el = document.querySelector(s);
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter ? setter.call(el, v) : (el.value = v);
    ["input", "change", "blur"].forEach(ev => el.dispatchEvent(new Event(ev, { bubbles: true })));
    return true;
  }, sel, String(val)).catch(() => false);

  // Capturar CAPTCHA desde dentro del browser (misma sesión → sin CORS)
  const capturarCaptchaBase64 = async () => {
    const base64 = await page.evaluate(async () => {
      const img = document.querySelector("img#Kaptcha")
        || document.querySelector("img[src*='Kaptcha']")
        || document.querySelector("img[src*='kaptcha']")
        || Array.from(document.querySelectorAll("img")).find(i =>
            i.offsetParent && i.naturalWidth >= 80 && i.naturalWidth <= 350
            && i.naturalHeight >= 20 && i.naturalHeight <= 120
            && !/(logo|icon|reload|banner)/i.test(i.src));
      if (!img || !img.src) return null;
      try {
        const resp = await fetch(img.src, { credentials: "include" });
        if (!resp.ok) return null;
        const blob = await resp.blob();
        return await new Promise(res => {
          const r = new FileReader();
          r.onload = () => res(r.result.split(",")[1] || null);
          r.readAsDataURL(blob);
        });
      } catch { return null; }
    }).catch(() => null);
    return base64;
  };

  try {
    // ── 1. Cargar portal ────────────────────────────────────────────────────
    await page.goto("https://www.e7-eleven.com.mx/facturacion/KPortalExterno/",
      { waitUntil: "load", timeout: 40000 });
    await page.waitForTimeout(3000);

    // ── 2. Click FACTURA EXPRESS ────────────────────────────────────────────
    const okExpress = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button,a,.btn"))
        .find(e => e.offsetParent && (e.textContent || "").trim().toUpperCase() === "FACTURA EXPRESS");
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (!okExpress) {
      await snap("err_noexpress");
      await browser.close();
      return { ok: false, msg: "7-Eleven: no se encontró FACTURA EXPRESS" };
    }
    await page.waitForTimeout(4000);

    // Esperar el campo del ticket
    await page.waitForSelector('input[name="noTicket"]', { visible: true, timeout: 12000 }).catch(() => {});
    await snap("p1_form");
    console.log("✅ Formulario visible");

    // ── 3. Escribir el No. de Ticket con keyboard.type() ───────────────────
    // CRÍTICO: Angular necesita eventos de teclado reales para actualizar su
    // modelo reactivo. Con solo el setter + events la validación interna falla.
    await page.focus('input[name="noTicket"]');
    await page.waitForTimeout(300);
    // Limpiar campo primero
    await page.evaluate(() => {
      const el = document.querySelector('input[name="noTicket"]');
      if (!el) return;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      setter ? setter.call(el, "") : (el.value = "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.keyboard.type(folioVal, { delay: 30 });
    await page.waitForTimeout(1200);

    // Log estado del botón Agregar Ticket
    const btnAgregar = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button,input[type=button]"))
        .find(e => /agregar\s*ticket/i.test(e.textContent || e.value || ""));
      if (!btn) return { found: false };
      return { found: true, disabled: btn.disabled, class: btn.className.slice(0, 60) };
    }).catch(() => null);
    console.log("🔘 Botón Agregar Ticket:", JSON.stringify(btnAgregar));
    await snap("p2_ticket_escrito");

    // ── 4. Click "Agregar Ticket" + capturar posible SPA navigation ───────────
    // Angular puede hacer una SPA navigation al validar el ticket; si no
    // esperamos la navegación, el page context queda "huérfano" y da Session closed.
    console.log("🖱️  Agregar Ticket...");

    // Registrar navegación ANTES del click (si llega después del click la perdemos)
    const navPromise = page.waitForNavigation({ waitUntil: "load", timeout: 12000 })
      .then(() => "navigated").catch(() => "no-nav");

    const clickOk = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button,a,.btn,input[type=button]"))
        .find(e => e.offsetParent && /agregar\s*ticket/i.test(e.textContent || e.value || ""));
      if (!btn) return false;
      btn.click();
      return true;
    }).catch(() => false);
    console.log("   evaluate.click:", clickOk);

    const navResult = await navPromise;
    console.log("   navigation:", navResult);

    // Si hubo navegación real ya estamos en la nueva página; si no, esperamos
    // que el AJAX complete y Angular termine de re-montar el componente.
    await page.waitForTimeout(navResult === "navigated" ? 2000 : 4000);

    // ── 5. Esperar ROW con contenido real ─────────────────────────────────────
    // CRÍTICO: la tabla tiene un <tr> vacío SIEMPRE (placeholder). waitForSelector
    // resuelve en ese <tr> vacío en <500ms antes de que llegue el AJAX.
    // Usamos sondeo tolerante al re-render: si el contexto se destruye
    // brevemente lo reintentamos en el siguiente tick.
    let resultadoAgregar = "timeout";
    for (let poll = 0; poll < 28; poll++) {
      await page.waitForTimeout(500);
      try {
        const estado = await page.evaluate(() => {
          // Fila con contenido real (no el <tr> placeholder vacío)
          const rows = Array.from(document.querySelectorAll("table tbody tr"));
          const hayContenido = rows.some(r => r.textContent.replace(/\s/g, "").length > 10);
          if (hayContenido) return "agregado";
          const txt = (document.body.innerText || "").replace(/\s+/g, " ");
          if (/ya\s+(fue|ha\s+sido)\s+facturad/i.test(txt)) return "ya_facturado";
          if (/fuera de tiempo|venci/i.test(txt))            return "vencido";
          if (/no.*(encontr|existe|v[aá]lid)|inv[aá]lid|incorrect/i.test(txt)) return "invalido";
          return "esperando";
        });
        if (estado !== "esperando") { resultadoAgregar = estado; break; }
      } catch { /* contexto temporalmente destruido — reintentamos */ }
    }

    await snap("p3_tras_agregar");
    const domInfo = await page.evaluate(() => ({
      filas: document.querySelectorAll("table tbody tr").length,
      filaContenido: Array.from(document.querySelectorAll("table tbody tr"))
        .filter(r => r.textContent.replace(/\s/g,"").length > 10).length,
      captchaInput: !!document.querySelector("#captcha"),
      captchaImg: !!(document.querySelector("img#Kaptcha") || document.querySelector("img[src*='Kaptcha']")),
      snippet: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 400),
    })).catch(() => null);
    console.log("📊 Post-agregar:", JSON.stringify(domInfo));
    console.log("   Resultado:", resultadoAgregar);

    if (resultadoAgregar === "ya_facturado") {
      await browser.close();
      return { ok: false, error_code: "ya_facturado", msg: "7-Eleven: ticket ya facturado" };
    }
    if (resultadoAgregar === "invalido") {
      await browser.close();
      return { ok: false, error_code: "datos_invalidos", msg: "7-Eleven: ticket no encontrado — verifica el folio (35 dígitos)" };
    }
    if (resultadoAgregar === "vencido") {
      await browser.close();
      return { ok: false, error_code: "ticket_vencido", msg: "7-Eleven: el plazo para facturar venció" };
    }
    if (resultadoAgregar !== "agregado") {
      await snap("err_no_se_agrego");
      await browser.close();
      return { ok: false, msg: "7-Eleven: el ticket no apareció en la tabla tras Agregar Ticket. Revisa el screenshot." };
    }
    console.log("✅ Ticket en tabla");

    // Esperar a que Angular termine de re-montar el form después del AJAX.
    // Sin este wait, el evaluate del paso siguiente llega justo durante el
    // re-render y el contexto JS sigue destruido → Session closed.
    await page.waitForTimeout(3000);
    await page.waitForSelector("#rfcCliente", { visible: true, timeout: 10000 })
      .catch(() => {});
    console.log("✅ Form estabilizado");

    // ── 6. Llenar el resto del formulario (RFC, razón, CP, email, fpago, etc.)
    const llenado = await page.evaluate((d) => {
      const set = (el, val) => {
        if (!el) return false;
        const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
        s ? s.call(el, val) : (el.value = val);
        ["input", "change", "blur"].forEach(ev => el.dispatchEvent(new Event(ev, { bubbles: true })));
        return true;
      };
      const res = {};
      res.rfc   = set(document.querySelector("#rfcCliente"), d.rfc);
      res.razon = set(document.querySelector("#razon"), d.razonSocial || "");
      res.cp    = set(document.querySelector("#cp"), d.codigoPostal || "");
      res.email = set(document.querySelector("#emailInput"), "buzonfacturas@serviciosga.site");
      res.fpago = set(document.querySelector("#formaPagoAux"), "Efectivo");
      const selReg = document.querySelector("#regimenFiscalReceptor");
      if (selReg) {
        for (const o of selReg.options) {
          if (o.value === d.regimenFiscal || o.text.includes(d.regimenFiscal) || o.text.includes("General de Ley")) {
            selReg.value = o.value;
            selReg.dispatchEvent(new Event("change", { bubbles: true }));
            res.regimen = true; break;
          }
        }
      }
      const selCfdi = document.querySelector("#usoCfdi");
      if (selCfdi) {
        for (const o of selCfdi.options) {
          if (o.value.includes(d.usoCfdi) || o.text.includes("Gastos en general")) {
            selCfdi.value = o.value;
            selCfdi.dispatchEvent(new Event("change", { bubbles: true }));
            res.cfdi = true; break;
          }
        }
      }
      return res;
    }, { rfc, razonSocial, codigoPostal: codigoPostal || "", regimenFiscal: String(regimenFiscal || "601"), usoCfdi: usoCfdi || "G03" });
    console.log("📋 Campos extra:", JSON.stringify(llenado));
    await page.waitForTimeout(800);
    await snap("p4_form_completo");

    // ── 7. Loop CAPTCHA + FACTURAR (hasta 3 intentos) ──────────────────────
    for (let intento = 1; intento <= 3; intento++) {
      console.log(`🔐 CAPTCHA intento ${intento}/3...`);

      // Esperar a que la imagen del CAPTCHA esté en el DOM
      await page.waitForSelector("img#Kaptcha, img[src*='Kaptcha']", { visible: true, timeout: 8000 })
        .catch(() => {});

      // Capturar desde el browser (misma sesión, sin CORS)
      const base64 = await capturarCaptchaBase64();
      if (!base64) {
        console.log("   ⚠️  No se pudo capturar imagen del CAPTCHA");
        // Intentar reload del CAPTCHA
        await page.evaluate(() => {
          const reload = document.querySelector("img#reload, img[id*='reload']");
          if (reload) reload.click();
        }).catch(() => {});
        await page.waitForTimeout(2000);
        continue;
      }

      // Subir copia a R2 para diagnóstico
      try {
        const buf = Buffer.from(base64, "base64");
        const u = await subirArchivoR2(buf, `debug/7e_${ts}_captcha_${intento}_${Date.now()}.jpg`, "image/jpeg");
        console.log(`   CAPTCHA imagen: ${u}`);
      } catch {}

      let sol;
      try {
        sol = await resolverCaptcha(base64);
      } catch (e) {
        console.log(`   CapSolver falló: ${e.message}`);
        await page.evaluate(() => {
          document.querySelector("img#reload, img[id*='reload']")?.click();
        }).catch(() => {});
        await page.waitForTimeout(2500);
        continue;
      }

      // Escribir solución con keyboard.type() también (Angular-safe)
      await page.focus("#captcha").catch(() => {});
      await setField("#captcha", "");
      await page.keyboard.type(sol, { delay: 50 });
      await page.waitForTimeout(400);
      await snap(`p5_captcha_${intento}`);

      // Click FACTURAR
      console.log("🧾 FACTURAR...");
      const clickFact = await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll("button,a,.btn,input[type=submit],input[type=button]"))
          .find(e => e.offsetParent && /^facturar$/i.test((e.textContent || e.value || "").trim()));
        if (!btn) return false;
        btn.click();
        return true;
      }).catch(() => false);
      console.log("   click FACTURAR:", clickFact);

      // Esperar resultado (navegación o AJAX)
      await Promise.race([
        page.waitForNavigation({ waitUntil: "load", timeout: 20000 }),
        page.waitForTimeout(10000),
      ]).catch(() => {});
      await snap(`p6_resultado_${intento}`);

      const body = await page.evaluate(() => document.body.innerText || "").catch(() => "");
      console.log("   Body snippet:", body.replace(/\s+/g, " ").slice(0, 250));

      if (/captcha.*(incorrecto|inv[aá]lido)|c[oó]digo.*(incorrecto|inv[aá]lido)/i.test(body)) {
        console.log("   CAPTCHA incorrecto — recargando...");
        await page.evaluate(() => {
          document.querySelector("img#reload, img[id*='reload']")?.click();
        }).catch(() => {});
        await page.waitForTimeout(2500);
        continue;
      }
      if (/ya\s+(fue|ha\s+sido)\s+facturad/i.test(body)) {
        await browser.close();
        return { ok: false, error_code: "ya_facturado", msg: "7-Eleven: ya facturado" };
      }
      if (/no\s+(encontr[oó]|existe)|inv[aá]lido/i.test(body) && !/factura|xml|pdf/i.test(body)) {
        await browser.close();
        return { ok: false, error_code: "datos_invalidos", msg: "7-Eleven: ticket no encontrado" };
      }

      // Buscar descarga de XML/PDF
      const xmlUrl = await page.evaluate(() =>
        Array.from(document.querySelectorAll("a[href]")).find(a => /\.xml/i.test(a.href))?.href || null
      ).catch(() => null);
      const pdfUrl = await page.evaluate(() =>
        Array.from(document.querySelectorAll("a[href]")).find(a => /\.pdf/i.test(a.href))?.href || null
      ).catch(() => null);

      await browser.close();
      if (xmlUrl || pdfUrl) {
        console.log(`✅ OK — XML: ${xmlUrl} | PDF: ${pdfUrl}`);
        return { ok: true, xmlUrl, pdfUrl };
      }
      // Sin enlaces directos → esperar por correo
      console.log("✅ Factura procesada — esperando por correo");
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
