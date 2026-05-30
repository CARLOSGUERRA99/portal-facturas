const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");

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
}

// ── Detección robusta del estado del portal por el texto visible ─────────────
// Cubre variantes con acento ("se venció la factura"), sin acento ("vencido"),
// y sinónimos (caducó, expiró, fuera de plazo, ya no se puede facturar).
// Devuelve "vencido" | "ya_facturado" | "invalido" | null.
async function detectarEstado(page) {
  return await page.evaluate(() => {
    const t = document.body.innerText || "";
    if (/se\s+venci[oó]|venci[oó]\s+el|vencid[ao]|caduc(ó|o|ad[ao])|expir(ó|o|ad[ao])|fuera\s+de\s+(tiempo|plazo)|ya\s+no\s+(se\s+)?puede[ns]?\s+factur/i.test(t))
      return "vencido";
    if (/ya\s+(fue|est[aá])\s+facturad|ya\s+facturad|cfdi\s+ya|comprobante\s+ya\s+generad|factura\s+ya\s+(generad|emitid)/i.test(t))
      return "ya_facturado";
    if (/no\s+(se\s+)?(encontr[oó]|existe)|ticket\s+inv[aá]lido|datos\s+incorrectos|no\s+v[aá]lido|c[oó]digo.*(incorrect|inv[aá]lid)/i.test(t))
      return "invalido";
    return null;
  }).catch(() => null);
}

// ── Extraer el correo de facturación del comercio del header del portal ──────
async function extraerEmailContacto(page) {
  return await page.evaluate(() => {
    const link = document.querySelector('a[href^="mailto:"]');
    if (link) return link.href.replace("mailto:", "").split("?")[0].trim().toLowerCase();
    const m = (document.body.innerText || "").match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/);
    return m ? m[0].toLowerCase() : null;
  }).catch(() => null);
}

async function facturarSushito({ referencia, folio, total, rfc, razonSocial, regimenFiscal, usoCfdi, ticketId, portalUrl }) {
  // codigoUnico: el ID único del ticket que imprime el restaurante en la nota
  const codigoUnico = String(referencia || folio || "").trim();
  const folioStr   = String(folio || referencia || "").trim();

  console.log("🤖 Iniciando bot SushiO (mefacturo.mx/sushio)...");
  console.log(`   CodigoUnico: ${codigoUnico} | Folio: ${folioStr} | RFC: ${rfc}`);

  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error("BROWSERLESS_TOKEN no definido");

  let browser;
  try {
    browser = await puppeteer.connect({
      browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true`,
    });
  } catch (e) {
    return { ok: false, msg: `SushiO: no se pudo conectar al browser — ${e.message}` };
  }

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
      const u = await subirArchivoR2(buf, `debug/sushito_${ts}_${label}_${Date.now()}.png`, "image/png");
      console.log(`📸 [${label}]: ${u}`);
    } catch {}
  }

  try {
    const url = portalUrl || "https://mefacturo.mx/sushio";
    console.log(`🌐 Cargando portal SushiO: ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2000);
    await screenshot("p0_inicio");

    // ── Extraer email de contacto del header del portal (visible antes de cualquier acción) ──
    // El portal muestra "SushiO / Teléfono XXXX / caja@sushio.mx" en el encabezado
    let emailContacto = await extraerEmailContacto(page);
    console.log(`📧 Email contacto del portal: ${emailContacto}`);

    // ── PASO 1 — Formulario único: CodigoUnicoTicket + FolioTicket + RFC ────
    // El portal SoftRestaurant tiene los 3 campos en una sola pantalla junto al
    // botón "Facturar". No es multi-step antes de ingresar datos fiscales.
    await page.waitForSelector("#CodigoUnicoTicket", { visible: true, timeout: 15000 });
    console.log("📝 Llenando formulario...");

    await fillInput(page, "#CodigoUnicoTicket", codigoUnico);

    const hayFolio = await page.$("#FolioTicket").catch(() => null);
    if (hayFolio) {
      await fillInput(page, "#FolioTicket", folioStr);
    }

    await fillInput(page, "#RFC", rfc);
    console.log(`   ✔ CodigoUnico: ${codigoUnico} | Folio: ${folioStr} | RFC: ${rfc}`);
    await screenshot("p1_formulario_llenado");

    // ── Click en "Facturar" ──────────────────────────────────────────────────
    console.log("🖱️ Click en Facturar...");
    const clicOk = await page.evaluate(() => {
      // El botón "Facturar" del portal SoftRestaurant es un <a id="btn_facturar">
      // (clase "btn btn-primary btn-icon-split"), NO un <button>. Por eso la
      // búsqueda anterior (solo button/input) nunca lo encontraba → fallaba con
      // "no se encontró el botón Facturar" en TODOS los tickets (válidos y vencidos).
      const directo = document.querySelector("#btn_facturar");
      if (directo) { directo.click(); return true; }
      const cand = Array.from(document.querySelectorAll("a, button, input[type='submit'], input[type='button'], .btn"));
      const btn = cand.find(b => /^facturar$/i.test((b.textContent || b.value || "").trim()));
      if (btn) { btn.click(); return true; }
      // Fallback: cualquier elemento con "facturar" (evitando "Recuperar comprobante")
      const btn2 = cand.find(b => /facturar/i.test((b.textContent || b.value || "")) && !/recuperar/i.test((b.textContent || b.value || "")));
      if (btn2) { btn2.click(); return true; }
      return false;
    });
    if (!clicOk) {
      // El botón "Facturar" no aparece cuando el portal bloquea el ticket
      // (típicamente porque la factura se venció / está fuera de plazo). Antes de
      // reportar un error genérico, detectar el estado real para enrutar a la
      // ventana de "solicitud por correo" en vez de quedarse reintentando en vano.
      await page.waitForTimeout(1500);
      const estadoSinBoton = await detectarEstado(page);
      await screenshot(`error_sin_boton_${estadoSinBoton || "desconocido"}`);
      emailContacto = (await extraerEmailContacto(page)) || emailContacto;
      await browser.close();
      console.log(`⚠️ Sin botón Facturar — estado detectado: ${estadoSinBoton || "indeterminado"}`);
      if (estadoSinBoton === "ya_facturado")
        return { ok: false, error_code: "ya_facturado", msg: "SushiO: el ticket ya fue facturado" };
      if (estadoSinBoton === "invalido")
        return { ok: false, error_code: "datos_invalidos", msg: "SushiO: ticket no encontrado o datos incorrectos" };
      // vencido o estado indeterminado → habilitar la solicitud manual por correo
      return {
        ok: false,
        error_code: "ticket_vencido",
        email_contacto: emailContacto,
        permite_solicitud_correo: true,
        msg: estadoSinBoton === "vencido"
          ? "El plazo para facturar este ticket en SushiO ha vencido — solicítalo por correo"
          : "SushiO no permitió facturar en línea — solicita la factura por correo",
      };
    }

    // ── Detectar resultado tras hacer click ──────────────────────────────────
    // El portal puede mostrar: (a) ticket vencido / "se venció", (b) ya facturado,
    // (c) datos incorrectos, o (d) paso 2 (campo de correo) para factura normal.
    // Polling cada 500ms (~15s): revisamos el estado real con detectarEstado() y,
    // si no hay estado de error, si ya apareció el campo de correo del paso 2.
    let caso = "timeout";
    for (let i = 0; i < 30; i++) {
      const estado = await detectarEstado(page);
      if (estado) { caso = estado; break; }
      const hayPaso2 = await page.evaluate(() => {
        const el = document.querySelector("input[type='email'], #Correo, #CorreoElectronico, #Email");
        return !!(el && el.offsetParent !== null);
      }).catch(() => false);
      if (hayPaso2) { caso = "paso2"; break; }
      await page.waitForTimeout(500);
    }

    await screenshot(`p2_${caso}`);
    console.log(`   Resultado: ${caso}`);

    // ── Ticket vencido ──────────────────────────────────────────────────────
    if (caso === "vencido") {
      emailContacto = (await extraerEmailContacto(page)) || emailContacto;
      console.log(`⚠️ Ticket vencido. Email contacto: ${emailContacto}`);
      await browser.close();
      return {
        ok: false,
        error_code: "ticket_vencido",
        email_contacto: emailContacto,
        permite_solicitud_correo: true,
        msg: "El plazo para facturar este ticket en SushiO ha vencido",
      };
    }

    if (caso === "ya_facturado") {
      await browser.close();
      return { ok: false, error_code: "ya_facturado", msg: "SushiO: el ticket ya fue facturado" };
    }
    if (caso === "invalido") {
      await browser.close();
      return { ok: false, error_code: "datos_invalidos", msg: "SushiO: ticket no encontrado o datos incorrectos" };
    }
    if (caso === "timeout") {
      await browser.close();
      return { ok: false, error_code: "timeout", msg: "SushiO: timeout esperando respuesta del portal" };
    }

    // ── PASO 2 — Completar datos fiscales y generar factura ─────────────────
    console.log("✅ Ticket válido — completando datos fiscales...");
    await page.waitForTimeout(1000);

    // Correo electrónico (campo obligatorio para recibir el CFDI)
    await page.evaluate(() => {
      const campos = "input[type='email'], #Correo, #Email, #CorreoElectronico, #correo"
        .split(", ").flatMap(s => Array.from(document.querySelectorAll(s)));
      for (const inp of campos) {
        if (!inp.offsetParent) continue;
        inp.value = "buzonfacturas@serviciosga.site";
        inp.dispatchEvent(new Event("input",  { bubbles: true }));
        inp.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    console.log("📧 Correo: buzonfacturas@serviciosga.site");

    // Régimen fiscal si existe select
    if (regimenFiscal) {
      await page.evaluate((reg) => {
        const sel = document.querySelector("#RegimenFiscal, #Regimen, select[name*='regimen']");
        if (!sel) return;
        for (const opt of sel.options) {
          if (opt.value === reg || opt.text.includes(reg)) {
            sel.value = opt.value;
            sel.dispatchEvent(new Event("change", { bubbles: true }));
            return;
          }
        }
      }, String(regimenFiscal));
    }

    await screenshot("p3_datos_fiscales");

    // Click en "Facturar" (segundo paso) o "Generar" — también puede ser un <a.btn>
    console.log("🧾 Generando factura...");
    await page.evaluate(() => {
      const cand = Array.from(document.querySelectorAll("a, button, input[type='submit'], input[type='button'], .btn"));
      const btn = cand.find(b =>
        /facturar|generar|emitir|timbrar|continuar/i.test((b.textContent || b.value || "")) &&
        !/recuperar/i.test((b.textContent || b.value || ""))
      );
      if (btn) btn.click();
    });

    // Esperar confirmación de factura generada
    const generado = await page.waitForFunction(
      () => /factura\s+generada|exitosamente|descarga|xml|pdf/i.test(document.body.innerText),
      { timeout: 30000 }
    ).then(() => true).catch(() => false);

    await screenshot("p4_resultado_final");

    if (!generado) {
      console.log("⚠️ Sin confirmación de generación — fallback IMAP");
      await browser.close();
      return { ok: true, procesandoCorreo: true };
    }

    // Intentar extraer links de descarga directa
    const xmlUrl = await page.evaluate(() => {
      const a = Array.from(document.querySelectorAll("a[href]"))
        .find(a => /\.xml(\?|$)|descargar.*xml|xml.*descargar/i.test(a.href + " " + a.textContent));
      return a?.href || null;
    });
    const pdfUrl = await page.evaluate(() => {
      const a = Array.from(document.querySelectorAll("a[href]"))
        .find(a => /\.pdf(\?|$)|descargar.*pdf|pdf.*descargar/i.test(a.href + " " + a.textContent));
      return a?.href || null;
    });

    await browser.close();

    if (xmlUrl || pdfUrl) {
      console.log(`✅ SushiO OK — XML: ${xmlUrl} | PDF: ${pdfUrl}`);
      return { ok: true, xmlUrl, pdfUrl };
    }

    console.log("📧 Sin descarga directa — fallback IMAP");
    return { ok: true, procesandoCorreo: true };

  } catch (err) {
    console.error("❌ Error en bot SushiO:", err.message);
    await screenshot("error").catch(() => {});
    try { await browser.close(); } catch {}
    return { ok: false, msg: err.message };
  }
}

module.exports = { facturarSushito };
