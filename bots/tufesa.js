const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");

// Bot TUFESA — el formulario real vive en ventas.tufesa.com.mx (ASP.NET/jQuery),
// embebido vía iframe en tufesa.com.mx/facturacion. Flujo (Boletos de viaje):
//   CboTipoFact=Pasaje → #txtCod (folio) + #cboOrigen (ciudad) + #TxtFch (fecha)
//   + #txtRfc + #TxtCorreo/#txtCorroborarCorreo → #btnEnviar "SOLICITAR" → factura por correo.

async function fillInput(page, selector, value) {
  await page.click(selector).catch(() => {});
  await page.waitForTimeout(100);
  await page.evaluate((sel) => { const e = document.querySelector(sel); if (e) e.value = ""; }, selector);
  await page.type(selector, String(value), { delay: 50 }).catch(() => {});
  await page.waitForTimeout(100);
}

async function facturarTufesa({ folio, referencia, fecha, origen, rfc, ticketId }) {
  const folioVal = String(folio || referencia || "").trim();

  console.log("🤖 Iniciando bot TUFESA...");
  console.log(`   Folio: ${folioVal} | Origen: ${origen || "?"} | Fecha: ${fecha || "?"} | RFC: ${rfc}`);

  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error("BROWSERLESS_TOKEN no definido");

  let browser;
  try {
    browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  } catch (e) {
    return { ok: false, msg: `TUFESA: no se pudo conectar al browser — ${e.message}` };
  }

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");
  await page.setExtraHTTPHeaders({ "Accept-Language": "es-MX,es;q=0.9,en;q=0.8" });

  const ts = ticketId || Date.now();
  const snap = async (label) => {
    try {
      const buf = await page.screenshot({ fullPage: false });
      const u = await subirArchivoR2(buf, `debug/tufesa_${ts}_${label}_${Date.now()}.png`, "image/png");
      console.log(`📸 [${label}]: ${u}`);
    } catch {}
  };

  try {
    console.log("🌐 Cargando portal TUFESA (SolicitarFactura.aspx)...");
    await page.goto("https://ventas.tufesa.com.mx/apw3/tufesa_es/SolicitarFactura.aspx", { waitUntil: "networkidle2", timeout: 35000 });
    await page.waitForTimeout(2500);
    await snap("p0_inicio");

    // ── Seleccionar "Boletos de viaje" (postback ASP.NET revela los campos) ──
    await page.waitForSelector("#CboTipoFact", { visible: true, timeout: 15000 });
    await page.select("#CboTipoFact", "Pasaje");
    await page.waitForTimeout(4500);
    await snap("p1_pasaje");

    const hayFolio = await page.waitForSelector("#txtCod", { visible: true, timeout: 10000 }).catch(() => null);
    if (!hayFolio) {
      await snap("error_sin_form");
      await browser.close();
      return { ok: false, msg: "TUFESA: no aparecieron los campos de facturación tras elegir el tipo" };
    }

    // ── Llenar campos ────────────────────────────────────────────────────────
    await fillInput(page, "#txtCod", folioVal);

    // Ciudad de origen (select) — fuzzy match contra el origen del ticket
    if (origen) {
      await page.evaluate((origenStr) => {
        const sel = document.querySelector("#cboOrigen");
        if (!sel) return;
        const norm = s => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
        const o = Array.from(sel.options).find(opt => norm(opt.text).includes(norm(origenStr)) || (norm(origenStr).length > 3 && norm(origenStr).includes(norm(opt.text))));
        if (o) { sel.value = o.value; sel.dispatchEvent(new Event("change", { bubbles: true })); }
      }, String(origen));
    }

    // Fecha (formato del ticket; ASP.NET suele aceptar DD/MM/YYYY)
    if (fecha) {
      await page.evaluate((f) => {
        const el = document.querySelector("#TxtFch");
        if (el) { el.removeAttribute("readonly"); el.value = f; ["input", "change", "blur"].forEach(ev => el.dispatchEvent(new Event(ev, { bubbles: true }))); }
      }, String(fecha));
    }

    await fillInput(page, "#txtRfc", rfc);
    await page.evaluate(() => {
      for (const id of ["#TxtCorreo", "#txtCorroborarCorreo"]) {
        const el = document.querySelector(id);
        if (el) { el.value = "buzonfacturas@serviciosga.site"; ["input", "change", "blur"].forEach(ev => el.dispatchEvent(new Event(ev, { bubbles: true }))); }
      }
    });
    await snap("p2_llenado");

    // ── Click SOLICITAR ──────────────────────────────────────────────────────
    console.log("🖱️ Click en SOLICITAR...");
    await page.evaluate(() => { const b = document.querySelector("#btnEnviar"); if (b) b.click(); });
    await page.waitForTimeout(6000);
    await snap("p3_resultado");

    const body = await page.evaluate(() => (document.body.innerText || ""));
    if (/ya\s+(fue|est[aá]|ha\s+sido)\s+facturad|ya\s+facturad/i.test(body)) {
      await browser.close();
      return { ok: false, error_code: "ya_facturado", msg: "TUFESA: el boleto ya fue facturado" };
    }
    if (/no\s+(se\s+)?(encontr[oó]|existe)|no\s+v[aá]lid|incorrect|verifi|sin\s+resultado/i.test(body) &&
        !/enviad|correo electr|exitos|solicitud.*recib/i.test(body)) {
      await browser.close();
      return { ok: false, error_code: "datos_invalidos", msg: "TUFESA: boleto no encontrado — verifica folio, origen, fecha y RFC" };
    }

    // Éxito típico: la factura se envía al correo → IMAP la captura
    console.log("✅ TUFESA: solicitud enviada — factura por correo (IMAP)");
    await browser.close();
    return { ok: true, procesandoCorreo: true };

  } catch (err) {
    console.error("❌ Error en bot TUFESA:", err.message);
    await snap("error").catch(() => {});
    try { await browser.close(); } catch {}
    return { ok: false, msg: err.message };
  }
}

module.exports = { facturarTufesa };
