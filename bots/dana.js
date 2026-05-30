const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");

// Bot Dana Comida Mexicana — SoftRestaurant (AutoFactura), variante con IDs propios:
//   #unicCode (Código facturación) · #folio (Folio) · #RFC · button.btn-success "Facturar"
// Misma familia que SushiO pero distintos selectores (por eso bot dedicado).

async function fillInput(page, selector, value) {
  await page.click(selector);
  await page.waitForTimeout(120);
  await page.keyboard.down("Control"); await page.keyboard.press("a"); await page.keyboard.up("Control");
  await page.keyboard.press("Delete");
  await page.waitForTimeout(60);
  await page.keyboard.type(String(value), { delay: 50 });
  await page.waitForTimeout(120);
}

// Detección de estado por el texto visible (vencido / ya facturado / inválido).
async function detectarEstado(page) {
  return await page.evaluate(() => {
    const t = document.body.innerText || "";
    if (/se\s+venci[oó]|venci[oó]\s+el|vencid[ao]|caduc(ó|o|ad[ao])|expir(ó|o|ad[ao])|fuera\s+de\s+(tiempo|plazo)|ya\s+no\s+(se\s+)?puede[ns]?\s+factur/i.test(t)) return "vencido";
    if (/ya\s+(fue|est[aá]|ha\s+sido)\s+(facturad|generad)|ya\s+facturad|cfdi\s+ya|comprobante\s+ya\s+generad|factura\s+ya\s+(generad|emitid)/i.test(t)) return "ya_facturado";
    if (/no\s+(se\s+)?(encontr[oó]|existe)|ticket\s+inv[aá]lido|datos\s+(incorrectos|no\s+v[aá]lidos)|no\s+v[aá]lido|c[oó]digo.*(incorrect|inv[aá]lid)|sin\s+resultados/i.test(t)) return "invalido";
    return null;
  }).catch(() => null);
}

async function extraerEmailContacto(page) {
  return await page.evaluate(() => {
    const link = document.querySelector('a[href^="mailto:"]');
    if (link) return link.href.replace("mailto:", "").split("?")[0].trim().toLowerCase();
    const m = (document.body.innerText || "").match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/);
    return m ? m[0].toLowerCase() : null;
  }).catch(() => null);
}

async function facturarDana({ referencia, folio, total, rfc, razonSocial, regimenFiscal, usoCfdi, ticketId, portalUrl }) {
  const codigoUnico = String(referencia || folio || "").trim();
  const folioStr = String(folio || referencia || "").trim();

  console.log("🤖 Iniciando bot Dana (SoftRestaurant)...");
  console.log(`   Código: ${codigoUnico} | Folio: ${folioStr} | RFC: ${rfc}`);

  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error("BROWSERLESS_TOKEN no definido");

  let browser;
  try {
    browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  } catch (e) {
    return { ok: false, msg: `Dana: no se pudo conectar al browser — ${e.message}` };
  }

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");
  await page.setExtraHTTPHeaders({ "Accept-Language": "es-MX,es;q=0.9,en;q=0.8" });

  const ts = ticketId || Date.now();
  const snap = async (label) => {
    try {
      const buf = await page.screenshot({ fullPage: false });
      const u = await subirArchivoR2(buf, `debug/dana_${ts}_${label}_${Date.now()}.png`, "image/png");
      console.log(`📸 [${label}]: ${u}`);
    } catch {}
  };

  try {
    const url = portalUrl || "https://facturacion.softrestaurant.com/DANACOMIDAMEXICANA";
    console.log(`🌐 Cargando portal Dana: ${url}`);
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    await page.waitForTimeout(2500);
    await snap("p0_inicio");

    let emailContacto = await extraerEmailContacto(page);
    console.log(`📧 Email contacto del portal: ${emailContacto}`);

    // ── Llenar formulario: Código facturación + Folio + RFC ──────────────────
    await page.waitForSelector("#unicCode", { visible: true, timeout: 15000 });
    await fillInput(page, "#unicCode", codigoUnico);
    const hayFolio = await page.$("#folio").catch(() => null);
    if (hayFolio) await fillInput(page, "#folio", folioStr);
    await fillInput(page, "#RFC", rfc);
    await snap("p1_formulario");

    // ── Click "Facturar" (button.btn-success) ────────────────────────────────
    console.log("🖱️ Click en Facturar...");
    const clicOk = await page.evaluate(() => {
      const cand = Array.from(document.querySelectorAll("button, a, input[type='submit'], .btn"));
      const btn = cand.find(b => /^facturar$/i.test((b.textContent || b.value || "").trim()))
        || cand.find(b => /facturar/i.test((b.textContent || b.value || "")) && !/consultar|regresar|buscar/i.test((b.textContent || b.value || "")));
      if (btn) { btn.click(); return true; }
      return false;
    });

    if (!clicOk) {
      await page.waitForTimeout(1200);
      const estadoSinBoton = await detectarEstado(page);
      await snap(`error_sin_boton_${estadoSinBoton || "desconocido"}`);
      emailContacto = (await extraerEmailContacto(page)) || emailContacto;
      await browser.close();
      if (estadoSinBoton === "ya_facturado") return { ok: false, error_code: "ya_facturado", msg: "Dana: el ticket ya fue facturado" };
      if (estadoSinBoton === "invalido") return { ok: false, error_code: "datos_invalidos", msg: "Dana: ticket no encontrado o datos incorrectos" };
      return { ok: false, error_code: "ticket_vencido", email_contacto: emailContacto, permite_solicitud_correo: true,
        msg: estadoSinBoton === "vencido" ? "El plazo para facturar este ticket en Dana ha vencido — solicítalo por correo" : "Dana no permitió facturar en línea — solicita la factura por correo" };
    }

    // ── Detectar resultado (polling) ─────────────────────────────────────────
    let caso = "timeout";
    for (let i = 0; i < 30; i++) {
      const estado = await detectarEstado(page);
      if (estado) { caso = estado; break; }
      const hayPaso2 = await page.evaluate(() => {
        const el = document.querySelector("input[type='email'], #Correo, #CorreoElectronico, #Email, #correo, input[name*='orreo']");
        return !!(el && el.offsetParent !== null);
      }).catch(() => false);
      if (hayPaso2) { caso = "paso2"; break; }
      await page.waitForTimeout(500);
    }
    await snap(`p2_${caso}`);
    console.log(`   Resultado: ${caso}`);

    if (caso === "vencido") {
      emailContacto = (await extraerEmailContacto(page)) || emailContacto;
      await browser.close();
      return { ok: false, error_code: "ticket_vencido", email_contacto: emailContacto, permite_solicitud_correo: true, msg: "El plazo para facturar este ticket en Dana ha vencido" };
    }
    if (caso === "ya_facturado") { await browser.close(); return { ok: false, error_code: "ya_facturado", msg: "Dana: el ticket ya fue facturado" }; }
    if (caso === "invalido")     { await browser.close(); return { ok: false, error_code: "datos_invalidos", msg: "Dana: ticket no encontrado o datos incorrectos" }; }
    if (caso === "timeout")      { await browser.close(); return { ok: false, error_code: "timeout", msg: "Dana: timeout esperando respuesta del portal" }; }

    // ── PASO 2 — Datos fiscales: correo + generar ────────────────────────────
    console.log("✅ Ticket válido — completando datos fiscales...");
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
      const campos = Array.from(document.querySelectorAll("input[type='email'], #Correo, #Email, #CorreoElectronico, #correo, input[name*='orreo']"));
      for (const inp of campos) {
        if (!inp.offsetParent) continue;
        inp.value = "buzonfacturas@serviciosga.site";
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        inp.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    if (regimenFiscal) {
      await page.evaluate((reg) => {
        const sel = document.querySelector("#RegimenFiscal, #Regimen, select[name*='regimen']");
        if (!sel) return;
        for (const opt of sel.options) { if (opt.value === reg || opt.text.includes(reg)) { sel.value = opt.value; sel.dispatchEvent(new Event("change", { bubbles: true })); return; } }
      }, String(regimenFiscal));
    }
    await snap("p3_datos_fiscales");

    console.log("🧾 Generando factura...");
    await page.evaluate(() => {
      const cand = Array.from(document.querySelectorAll("button, a, input[type='submit'], .btn"));
      const btn = cand.find(b => /facturar|generar|emitir|timbrar|continuar/i.test((b.textContent || b.value || "")) && !/consultar|regresar/i.test((b.textContent || b.value || "")));
      if (btn) btn.click();
    });

    const generado = await page.waitForFunction(
      () => /factura\s+generada|exitosamente|descarga|\.xml|\.pdf|ya ha sido generada/i.test(document.body.innerText),
      { timeout: 30000 }
    ).then(() => true).catch(() => false);
    await snap("p4_resultado_final");

    if (!generado) { await browser.close(); return { ok: true, procesandoCorreo: true }; }

    const xmlUrl = await page.evaluate(() => { const a = Array.from(document.querySelectorAll("a[href]")).find(a => /\.xml(\?|$)|descargar.*xml|xml.*descargar/i.test(a.href + " " + a.textContent)); return a?.href || null; });
    const pdfUrl = await page.evaluate(() => { const a = Array.from(document.querySelectorAll("a[href]")).find(a => /\.pdf(\?|$)|descargar.*pdf|pdf.*descargar/i.test(a.href + " " + a.textContent)); return a?.href || null; });
    await browser.close();

    if (xmlUrl || pdfUrl) { console.log(`✅ Dana OK — XML: ${xmlUrl} | PDF: ${pdfUrl}`); return { ok: true, xmlUrl, pdfUrl }; }
    console.log("📧 Sin descarga directa — fallback IMAP");
    return { ok: true, procesandoCorreo: true };

  } catch (err) {
    console.error("❌ Error en bot Dana:", err.message);
    await snap("error").catch(() => {});
    try { await browser.close(); } catch {}
    return { ok: false, msg: err.message };
  }
}

module.exports = { facturarDana };
