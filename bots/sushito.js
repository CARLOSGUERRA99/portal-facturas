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

async function extraerEmailContacto(page) {
  return page.evaluate(() => {
    const link = document.querySelector('a[href^="mailto:"]');
    if (link) return link.href.replace('mailto:', '').split('?')[0].trim();
    const m = document.body.innerText.match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/);
    return m ? m[0].toLowerCase() : null;
  });
}

async function facturarSushito({ referencia, folio, total, rfc, razonSocial, regimenFiscal, usoCfdi, ticketId, portalUrl }) {
  const codigoUnico = String(referencia || folio || '').trim();

  console.log("🤖 Iniciando bot SushiO (mefacturo.mx)...");
  console.log(`   Código único: ${codigoUnico} | Folio: ${folio} | Total: ${total} | RFC: ${rfc}`);

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

    // Detectar vencido en pantalla inicial antes de llenar formulario
    const textoInicio = await page.evaluate(() => document.body.innerText.toLowerCase());
    if (/ticket\s+vencido|plazo\s+vencido/.test(textoInicio)) {
      const emailContacto = await extraerEmailContacto(page);
      console.log(`⚠️ Ticket vencido en pantalla inicial. Email: ${emailContacto}`);
      await browser.close();
      return { ok: false, error_code: "ticket_vencido", email_contacto: emailContacto, permite_solicitud_correo: true, msg: "El plazo para facturar este ticket ha vencido" };
    }

    // ── PASO 1 — Llenar datos del ticket ────────────────────────────────────
    await page.waitForSelector("#CodigoUnicoTicket", { visible: true, timeout: 15000 });
    await fillInput(page, "#CodigoUnicoTicket", codigoUnico);

    const hayFolio = await page.$("#FolioTicket").catch(() => null);
    if (hayFolio && folio) {
      await fillInput(page, "#FolioTicket", folio);
    }

    const hayTotal = await page.$("#Total, #TotalTicket, #ImporteTicket").catch(() => null);
    if (hayTotal && total) {
      await fillInput(page, "#Total, #TotalTicket, #ImporteTicket", total);
    }

    await screenshot("p1_datos_ticket");

    // Click en Consultar / Siguiente
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button, input[type='submit'], input[type='button']"))
        .find(b => /consultar|verificar|buscar|siguiente|continuar/i.test((b.textContent || b.value || "")));
      if (btn) btn.click();
    });
    await page.waitForTimeout(3000);

    // Detectar resultado
    const caso = await Promise.race([
      page.waitForFunction(
        () => /ticket\s+vencido|plazo\s+vencido/i.test(document.body.innerText),
        { timeout: 12000 }
      ).then(() => "vencido"),
      page.waitForFunction(
        () => /ya\s+fue\s+facturado|ya\s+facturado|cfdi\s+ya\s+generado/i.test(document.body.innerText),
        { timeout: 12000 }
      ).then(() => "ya_facturado"),
      page.waitForFunction(
        () => /no\s+(se\s+)?(encontr[oó]|existe)|ticket\s+inv[áa]lido|datos\s+incorrectos/i.test(document.body.innerText),
        { timeout: 12000 }
      ).then(() => "invalido"),
      page.waitForSelector("#RFC, #Rfc, #rfc", { visible: true, timeout: 12000 })
        .then(() => "paso2"),
    ]).catch(() => "timeout");

    await screenshot("p2_resultado_consulta");
    console.log(`   Resultado consulta: ${caso}`);

    if (caso === "vencido") {
      const emailContacto = await extraerEmailContacto(page);
      console.log(`⚠️ Ticket vencido. Email contacto: ${emailContacto}`);
      await browser.close();
      return { ok: false, error_code: "ticket_vencido", email_contacto: emailContacto, permite_solicitud_correo: true, msg: "El plazo para facturar este ticket ha vencido" };
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

    // ── PASO 2 — Datos fiscales ──────────────────────────────────────────────
    await page.waitForTimeout(1500);

    // RFC
    await fillInput(page, "#RFC, #Rfc, #rfc", rfc);
    await page.waitForTimeout(800);

    // Click en Buscar cliente si existe
    const btnBuscar = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button, input[type='button']"))
        .find(b => /buscar|cargar|validar\s+rfc/i.test((b.textContent || b.value || "")));
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (btnBuscar) await page.waitForTimeout(2000);

    // Correo
    await page.evaluate(() => {
      const campos = document.querySelectorAll("input[type='email'], #Correo, #Email, #CorreoElectronico, #correo");
      for (const inp of campos) {
        inp.value = "buzonfacturas@serviciosga.site";
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        inp.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    console.log("📧 Correo: buzonfacturas@serviciosga.site");
    await screenshot("p3_datos_fiscales");

    // Siguiente hacia confirmación
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button, input[type='submit']"))
        .find(b => /siguiente|continuar|facturar|generar/i.test((b.textContent || b.value || "")));
      if (btn) btn.click();
    });
    await page.waitForTimeout(3000);
    await screenshot("p4_confirmacion");

    // ── PASO 3 — Confirmar y generar ────────────────────────────────────────
    const esConfirmacion = await page.evaluate(() =>
      /confirma|verifica|datos.*factura/i.test(document.body.innerText)
    );
    if (esConfirmacion) {
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll("button, input[type='submit']"))
          .find(b => /facturar|generar|emitir|confirmar/i.test((b.textContent || b.value || "")));
        if (btn) btn.click();
      });
      await page.waitForTimeout(5000);
    }

    // Esperar confirmación de factura generada
    const generado = await page.waitForFunction(
      () => /factura\s+generada|exitosamente|descarga|xml|pdf/i.test(document.body.innerText),
      { timeout: 30000 }
    ).then(() => true).catch(() => false);

    await screenshot("p5_generado");

    if (!generado) {
      console.log("⚠️ Sin confirmación de generación — fallback IMAP");
      await browser.close();
      return { ok: true, procesandoCorreo: true };
    }

    // Intentar descargar XML y PDF directamente
    const xmlUrl = await page.evaluate(() => {
      const a = Array.from(document.querySelectorAll("a[href]"))
        .find(a => /\.xml|descargar.*xml|xml/i.test(a.href + a.textContent));
      return a ? a.href : null;
    });
    const pdfUrl = await page.evaluate(() => {
      const a = Array.from(document.querySelectorAll("a[href]"))
        .find(a => /\.pdf|descargar.*pdf|pdf/i.test(a.href + a.textContent));
      return a ? a.href : null;
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
