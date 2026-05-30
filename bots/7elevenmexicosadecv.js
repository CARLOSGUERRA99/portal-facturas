const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");

// ── CapSolver: resuelve el CAPTCHA de imagen de 7-Eleven ─────────────────────
// El captcha es una imagen 200×50 (Kaptcha.jpg) con texto distorsionado.
// Usamos ImageToTextTask de CapSolver (servicio comercial legítimo).
async function resolverCaptcha(imgBase64) {
  const apiKey = process.env.CAPSOLVER_API_KEY;
  if (!apiKey) throw new Error("CAPSOLVER_API_KEY no definida");

  // Crear tarea
  const createResp = await fetch("https://api.capsolver.com/createTask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientKey: apiKey,
      task: { type: "ImageToTextTask", body: imgBase64 },
    }),
  });
  const create = await createResp.json();
  if (create.errorId) throw new Error(`CapSolver error: ${create.errorCode} — ${create.errorDescription}`);
  const taskId = create.taskId;

  // Polling hasta obtener resultado (max 30s)
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const resResp = await fetch("https://api.capsolver.com/getTaskResult", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: apiKey, taskId }),
    });
    const res = await resResp.json();
    if (res.status === "ready") {
      const solucion = res.solution?.text?.trim();
      if (!solucion) throw new Error("CapSolver no devolvió texto");
      console.log(`🔓 CAPTCHA resuelto: "${solucion}"`);
      return solucion;
    }
    if (res.errorId) throw new Error(`CapSolver error en resultado: ${res.errorCode}`);
  }
  throw new Error("CapSolver timeout — no resolvió el CAPTCHA en 30s");
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function fillInput(page, selector, value) {
  await page.evaluate((sel, val) => {
    const el = document.querySelector(sel);
    if (!el) return;
    el.value = val;
    ["input", "change", "blur"].forEach(ev => el.dispatchEvent(new Event(ev, { bubbles: true })));
  }, selector, String(value));
  await page.waitForTimeout(100);
}

async function clickTextoExacto(page, texto) {
  return await page.evaluate((t) => {
    const el = Array.from(document.querySelectorAll("button,a,input[type=submit],input[type=button],[role=button],.btn"))
      .filter(e => e.offsetParent)
      .find(e => (e.textContent || e.value || "").trim().toUpperCase() === t.toUpperCase());
    if (el) { el.click(); return true; }
    return false;
  }, texto);
}

// ── Bot principal ─────────────────────────────────────────────────────────────
async function facturar7Eleven({ folio, referencia, fecha, total, rfc, razonSocial, regimenFiscal, usoCfdi, codigoPostal, ticketId }) {
  const folioVal = String(folio || referencia || "").trim();

  console.log("🤖 Iniciando bot 7-Eleven México...");
  console.log(`   Folio: ${folioVal} (${folioVal.length} dígitos) | RFC: ${rfc}`);

  if (folioVal.length !== 35) {
    console.log(`⚠️ Folio tiene ${folioVal.length} dígitos — se esperan 35. El portal puede rechazarlo.`);
  }

  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error("BROWSERLESS_TOKEN no definido");

  let browser;
  try {
    browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  } catch (e) {
    return { ok: false, msg: `7-Eleven: no se pudo conectar al browser — ${e.message}` };
  }

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");
  await page.setExtraHTTPHeaders({ "Accept-Language": "es-MX,es;q=0.9,en;q=0.8" });

  const ts = ticketId || Date.now();
  const snap = async (label) => {
    try {
      const buf = await page.screenshot({ fullPage: false });
      const u = await subirArchivoR2(buf, `debug/7e_${ts}_${label}_${Date.now()}.png`, "image/png");
      console.log(`📸 [${label}]: ${u}`);
    } catch {}
  };

  try {
    console.log("🌐 Cargando portal 7-Eleven...");
    await page.goto("https://www.e7-eleven.com.mx/facturacion/KPortalExterno/", { waitUntil: "networkidle2", timeout: 40000 });
    await page.waitForTimeout(3000);
    await snap("p0_inicio");

    // ── Click FACTURA EXPRESS ────────────────────────────────────────────────
    console.log("🖱️ Click en FACTURA EXPRESS...");
    const clickedExpress = await clickTextoExacto(page, "FACTURA EXPRESS");
    if (!clickedExpress) {
      await snap("error_sin_express");
      await browser.close();
      return { ok: false, msg: "7-Eleven: no se encontró el botón FACTURA EXPRESS" };
    }
    await page.waitForTimeout(4500);
    await snap("p1_express_form");

    // ── Esperar campo de No. Ticket ─────────────────────────────────────────
    const hayForm = await page.waitForSelector('input[name="noTicket"]', { timeout: 10000 }).catch(() => null);
    if (!hayForm) {
      await snap("error_sin_form_ticket");
      await browser.close();
      return { ok: false, msg: "7-Eleven: no apareció el formulario de Facturación Express" };
    }

    // ── PASO 1: Ingresar No. Ticket y Agregar ───────────────────────────────
    // Usar page.click() + page.type() en vez de evaluate para mayor robustez en SPAs.
    // El campo noTicket puede tener validación jQuery que no dispara con .value=
    const ticketInput = await page.$('input[name="noTicket"]');
    if (!ticketInput) {
      await snap("error_sin_campo_ticket");
      await browser.close();
      return { ok: false, msg: "7-Eleven: no se encontró el campo No. Ticket en el formulario" };
    }
    await ticketInput.click({ clickCount: 3 });
    await ticketInput.type(folioVal, { delay: 30 });
    console.log(`📝 No. Ticket: ${folioVal}`);
    await page.waitForTimeout(800);

    // Click "Agregar Ticket" — dispara AJAX (no navega).
    // Capturamos la excepción de "session closed" si el portal restablece el DOM.
    try {
      await clickTextoExacto(page, "Agregar Ticket");
    } catch (e) {
      // Si la sesión se cerró justo al click, esperamos y verificamos si la página sigue viva
      console.log("⚠️ Excepción al Agregar Ticket:", e.message.slice(0, 80));
      await new Promise(r => setTimeout(r, 3000));
    }
    await page.waitForTimeout(4000);
    await snap("p2_ticket_agregado");

    // Verificar que el ticket se agregó a la tabla
    const tablaOk = await page.evaluate(() => {
      const tabla = document.querySelector("table tbody tr td");
      return !!(tabla && tabla.textContent && tabla.textContent.trim().length > 0);
    }).catch(() => false);
    console.log("📋 Ticket en tabla:", tablaOk);

    // ── PASO 2: Datos fiscales ──────────────────────────────────────────────
    await fillInput(page, "#rfcCliente", rfc);
    await fillInput(page, "#razon", razonSocial || "");
    await page.waitForTimeout(200);

    // Régimen Fiscal
    await page.evaluate((reg) => {
      const sel = document.querySelector("#regimenFiscalReceptor");
      if (!sel) return;
      for (const opt of sel.options) {
        if (opt.value === reg || opt.text.includes(reg)) { sel.value = opt.value; sel.dispatchEvent(new Event("change", { bubbles: true })); return; }
      }
    }, String(regimenFiscal || "601"));

    // Uso CFDI
    await page.evaluate((uc) => {
      const sel = document.querySelector("#usoCfdi");
      if (!sel) return;
      for (const opt of sel.options) {
        if (opt.value.includes(uc) || opt.text.includes("Gastos en general") || opt.text.includes(uc)) { sel.value = opt.value; sel.dispatchEvent(new Event("change", { bubbles: true })); return; }
      }
    }, usoCfdi || "G03");

    // Forma de pago (texto libre — "Efectivo" por defecto)
    await fillInput(page, "#formaPagoAux", "Efectivo");

    // Código postal (obligatorio)
    if (codigoPostal) await fillInput(page, "#cp", String(codigoPostal));

    // Email de captura
    await fillInput(page, "#emailInput", "buzonfacturas@serviciosga.site");

    await snap("p3_datos_fiscales");
    console.log("📋 Datos fiscales llenados");

    // ── PASO 3: Resolver CAPTCHA con CapSolver ──────────────────────────────
    // Esperar a que la imagen del CAPTCHA cargue
    await page.waitForSelector("img#Kaptcha", { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1500);

    // Intentar hasta 3 veces (el CAPTCHA puede fallar y se recarga)
    let captchaResuelto = false;
    for (let intento = 1; intento <= 3; intento++) {
      console.log(`🔐 Resolviendo CAPTCHA (intento ${intento}/3) con CapSolver...`);

      // Capturar el CAPTCHA como base64 via fetch con las mismas cookies de sesión
      const captchaBase64 = await page.evaluate(async () => {
        const img = document.querySelector("img#Kaptcha");
        if (!img) return null;
        try {
          const resp = await fetch(img.src, { credentials: "include" });
          if (!resp.ok) return null;
          const buf = await resp.arrayBuffer();
          return btoa(String.fromCharCode(...new Uint8Array(buf)));
        } catch {
          // Fallback: canvas (puede fallar por CORS)
          try {
            const canvas = document.createElement("canvas");
            canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
            canvas.getContext("2d").drawImage(img, 0, 0);
            return canvas.toDataURL("image/jpeg").split(",")[1];
          } catch { return null; }
        }
      });

      if (!captchaBase64) {
        console.log("⚠️ No se pudo capturar la imagen del CAPTCHA");
        break;
      }

      let solucion;
      try {
        solucion = await resolverCaptcha(captchaBase64);
      } catch (e) {
        console.log(`⚠️ CapSolver falló en intento ${intento}: ${e.message}`);
        if (intento < 3) {
          // Recargar el CAPTCHA y reintentar
          await page.evaluate(() => { const r = document.querySelector("img#reload"); if (r) r.click(); });
          await page.waitForTimeout(2000);
        }
        continue;
      }

      // Escribir la solución
      await fillInput(page, "#captcha", solucion);
      await page.waitForTimeout(300);

      // ── PASO 4: Click FACTURAR ────────────────────────────────────────────
      console.log("🧾 Enviando factura...");
      await clickTextoExacto(page, "FACTURAR");
      await page.waitForTimeout(6000);
      await snap(`p4_resultado_intento${intento}`);

      const body = await page.evaluate(() => document.body.innerText);

      // ¿CAPTCHA incorrecto?
      if (/captcha\s*(incorrecto|inválido|inv[aá]lido|error|no.*correct)/i.test(body)) {
        console.log(`⚠️ CAPTCHA incorrecto — reintentando (${intento}/3)`);
        // Recargar CAPTCHA para el siguiente intento
        await page.evaluate(() => { const r = document.querySelector("img#reload"); if (r) r.click(); });
        await page.waitForTimeout(2500);
        continue;
      }

      captchaResuelto = true;

      // ¿Ya facturado?
      if (/ya\s+(fue|est[aá]|ha\s+sido)\s+facturad|ya\s+facturad/i.test(body)) {
        console.log("ℹ️ Ticket ya facturado — intentando consultar factura existente");
        await browser.close();
        return { ok: false, error_code: "ya_facturado", msg: "7-Eleven: este ticket ya fue facturado" };
      }

      // ¿Ticket inválido?
      if (/no\s+(se\s+)?(encontr[oó]|existe)|inv[aá]lido|incorrect|no\s+v[aá]lid/i.test(body) && !/factura|exitoso|generada/i.test(body)) {
        await browser.close();
        return { ok: false, error_code: "datos_invalidos", msg: "7-Eleven: ticket no encontrado — verifica el folio (debe ser exactamente 35 dígitos)" };
      }

      // Éxito — intentar descargar XML y PDF directamente
      if (/factura|xml|pdf|generada|exitoso|descarga/i.test(body)) {
        const xmlUrl = await page.evaluate(() => {
          const a = Array.from(document.querySelectorAll("a[href]")).find(a =>
            /\.xml|xml/i.test(a.href + " " + a.textContent)
          );
          return a?.href || null;
        });
        const pdfUrl = await page.evaluate(() => {
          const a = Array.from(document.querySelectorAll("a[href]")).find(a =>
            /\.pdf|pdf/i.test(a.href + " " + a.textContent)
          );
          return a?.href || null;
        });

        await browser.close();
        if (xmlUrl || pdfUrl) {
          console.log(`✅ 7-Eleven OK — XML: ${xmlUrl} | PDF: ${pdfUrl}`);
          return { ok: true, xmlUrl, pdfUrl };
        }
        console.log("📧 Factura generada — sin descarga directa, capturando por IMAP");
        return { ok: true, procesandoCorreo: true };
      }

      // Sin confirmación clara
      await browser.close();
      return { ok: true, procesandoCorreo: true };
    }

    await snap("error_captcha_agotado");
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
