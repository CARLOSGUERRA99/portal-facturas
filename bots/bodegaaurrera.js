const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");

// ── Bodega Aurrera / Mi Bodega Aurrera / Walmart / Sam's Club / Superama ────
// Portal: facturacion.walmartmexico.com.mx (ASP.NET WebForms, ctl00$ContentPlaceHolder1$...)
// Flujo real verificado en vivo (2026-07-27, ticket GPN real):
//   1. Home → cerrar modal "Aceptar" → click "Obtener factura" (frmDatos.aspx)
//   2. Pestaña "Facturar" (default): Membresía o RFC / Código Postal / Número de
//      ticket (TC) / # Transacción (TR) → Continuar
//   3. Grid "Seleccione su RFC para Facturar" (perfil ya guardado en Walmart,
//      independiente de nuestra BD) → SELECCIONAR primera fila
//   4. Datos fiscales — domicilio YA viene precargado del perfil de Walmart
//      (no lo tocamos, solo Régimen Fiscal + Uso CFDI, que llegan vacíos).
//      Uso CFDI se puebla vía AJAX SOLO después de elegir Régimen — hay que
//      esperarlo, no es instantáneo.
//   5. Alert "¿Están correctos todos sus datos?" → Continuar
//   6. Forma de Pago (select) → Facturar
//   7. Pantalla final: radio PDF (visor embebido, sin XML) | Enviar a correo
//      electrónico. NO existe descarga directa de XML en esta sesión — a
//      diferencia de OXXO/Gasmaz, el portal no expone un link de archivo.
//      Se usa "Enviar a correo" al buzón de captura → IMAP recoge XML+PDF
//      reales (mismo mecanismo ya probado con Home Depot).
// Nota: el propio portal llama a esta acción "Facturar / Refacturar" — un
// ticket ya facturado se puede volver a enviar sin caso de error especial
// (a diferencia de OXXO, que sí tiene una rama "ya facturado" con reimpresión).

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

async function selectByValue(page, selector, value) {
  await page.select(selector, String(value)).catch(async () => {
    // fallback: dispatch change manualmente si page.select no encuentra la opción exacta
    await page.$eval(selector, (el, v) => {
      el.value = v;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, String(value));
  });
  const texto = await page.$eval(selector, el => el.options[el.selectedIndex]?.text || "?").catch(() => "?");
  console.log(`📝 ${selector} = "${value}" → "${texto}"`);
}

// Busca un botón/link visible por su texto exacto (mismo patrón que gasmaz.js/oxxo.js)
async function clickPorTexto(page, texto) {
  const handle = await page.evaluateHandle((t) => {
    const els = [...document.querySelectorAll("button, input[type=submit], a")];
    return els.find(e => (e.value || e.textContent || "").trim() === t && e.offsetParent !== null);
  }, texto);
  const el = handle.asElement();
  if (!el) throw new Error(`No se encontró el botón/link con texto "${texto}"`);
  await el.click();
  return true;
}

// ── Recuperación — "Consulta o reenvía tu factura" ──────────────────────────
// Se usa cuando la facturación normal responde "ya facturado" o el cooldown
// ("no puede ser procesada... 24 horas"). Flujo real verificado en vivo
// (2026-07-27, recupera folio fiscal 55ABEBA7-A586-4A15-8791-DA105BF44920):
//   Home → Obtener factura → toggle "Consulta o reenvía tu factura" →
//   Número de Ticket (TC) → Continuar → radios PDF|Enviar a correo →
//   [correo] captura email → Aceptar → "ha sido enviado al correo" (IMAP
//   recoge XML+PDF reales, verificado por monto — ver mail/imap.js)
// PRIORIDAD explícita (instrucción del usuario): SIEMPRE intentar correo
// primero — un PDF sin XML no es un CFDI completo para el SAT. El fallback
// a PDF-en-pantalla es solo si el radio de correo no está disponible.
async function recuperarFactura(page, tc, ticketId) {
  console.log("♻️ Recuperación — 'Consulta o reenvía tu factura'...");

  await page.goto("https://facturacion.walmartmexico.com.mx", { waitUntil: "networkidle2", timeout: 30000 });
  await clickPorTexto(page, "Aceptar").catch(() => {});
  await page.waitForTimeout(500);
  await page.click('a[href="frmDatos.aspx"]');
  await page.waitForSelector("#ctl00_ContentPlaceHolder1_radConsultar", { timeout: 15000 });

  await page.click("#ctl00_ContentPlaceHolder1_radConsultar");
  await page.waitForSelector('input[placeholder="Número de Ticket o factura"]', { visible: true, timeout: 10000 });
  await fillInput(page, 'input[placeholder="Número de Ticket o factura"]', tc);
  await page.click("#ctl00_ContentPlaceHolder1_btnAceptar");
  await page.waitForTimeout(1200);

  const caso = await Promise.race([
    page.waitForSelector("#ctl00_ContentPlaceHolder1_rdMail", { visible: true, timeout: 15000 }).then(() => "opciones"),
    page.waitForFunction(() => document.body.innerText.toLowerCase().includes("no se encuentra"), { timeout: 15000 }).then(() => "no_encontrado"),
  ]).catch(() => "timeout");
  console.log(`📍 Recuperación — caso: ${caso}`);

  if (caso === "no_encontrado" || caso === "timeout") {
    return { ok: false, msg: `Recuperación no encontró la factura (caso: ${caso})` };
  }

  // ── PRIORIDAD 1 — Enviar a correo (XML+PDF reales vía IMAP) ──────────────
  try {
    await page.click("#ctl00_ContentPlaceHolder1_rdMail");
    await page.waitForSelector("#ctl00_ContentPlaceHolder1_txtEmail", { visible: true, timeout: 8000 });
    await fillInput(page, "#ctl00_ContentPlaceHolder1_txtEmail", "buzonfacturas@serviciosga.site");
    await page.click("#ctl00_ContentPlaceHolder1_btnAceptar");

    const confirmado = await page.waitForFunction(
      () => document.body.innerText.toLowerCase().includes("ha sido enviado"),
      { timeout: 15000 }
    ).then(() => true).catch(() => false);

    if (confirmado) {
      console.log("✅ Recuperación por correo confirmada por el portal — IMAP recogerá XML+PDF");
      return { ok: true, procesandoCorreo: true, viaRecuperacion: true };
    }
    console.log("⚠️ El portal no confirmó el envío a correo — probando fallback PDF");
  } catch (e) {
    console.log("⚠️ Recuperación por correo falló:", e.message, "— probando fallback PDF");
  }

  // ── FALLBACK — PDF-en-pantalla (respaldo PARCIAL, sin XML) ───────────────
  // Solo si el correo no se pudo confirmar. Se marca explícito como
  // incompleto — un PDF sin XML no es un CFDI completo para el SAT.
  try {
    await page.goto("https://facturacion.walmartmexico.com.mx", { waitUntil: "networkidle2", timeout: 20000 });
    await page.click('a[href="frmDatos.aspx"]').catch(() => {});
    await page.waitForSelector("#ctl00_ContentPlaceHolder1_radConsultar", { timeout: 10000 });
    await page.click("#ctl00_ContentPlaceHolder1_radConsultar");
    await page.waitForSelector('input[placeholder="Número de Ticket o factura"]', { visible: true, timeout: 10000 });
    await fillInput(page, 'input[placeholder="Número de Ticket o factura"]', tc);
    await page.click("#ctl00_ContentPlaceHolder1_btnAceptar");
    await page.waitForSelector("#ctl00_ContentPlaceHolder1_rdDescargar", { visible: true, timeout: 15000 });

    let pdfBuffer = null;
    await page.setRequestInterception(true);
    page.on("request", req => req.continue());
    const onResp = async (resp) => {
      const ct = resp.headers()["content-type"] || "";
      if (ct.includes("pdf") && !pdfBuffer) {
        const b = await resp.buffer().catch(() => null);
        if (b && b.length > 500) pdfBuffer = b;
      }
    };
    page.on("response", onResp);
    await page.click("#ctl00_ContentPlaceHolder1_rdDescargar");
    await page.click("#ctl00_ContentPlaceHolder1_btnAceptar");
    await page.waitForTimeout(4000);
    page.off("response", onResp);
    await page.setRequestInterception(false).catch(() => {});

    if (pdfBuffer) {
      const pdfUrl = await subirArchivoR2(pdfBuffer, `facturas/bodegaaurrera_${ticketId || Date.now()}_SIN_XML.pdf`, "application/pdf");
      console.log("⚠️ Solo PDF recuperado (sin XML) — marcado incompleto:", pdfUrl);
      return { ok: true, pdfUrl, xmlUrl: null, sinXml: true, msg: "Solo se pudo recuperar el PDF — falta el XML, revisar manualmente" };
    }
    return { ok: false, msg: "Recuperación: ni correo ni PDF pudieron confirmarse" };
  } catch (e) {
    return { ok: false, msg: `Fallback PDF también falló: ${e.message}` };
  }
}

async function facturarBodegaAurrera({ rfc, codigoPostal, tc, tr, regimenFiscal, usoCfdi, ticketId }) {
  console.log("🤖 Iniciando bot Bodega Aurrera / Walmart de México...");
  console.log(`   RFC: ${rfc} | CP: ${codigoPostal} | TC: ${tc} | TR: ${tr}`);

  if (!tc || !tr) return { ok: false, msg: "Faltan TC (número de ticket) o TR (# transacción) — no se puede facturar" };
  if (!rfc) return { ok: false, msg: "Falta RFC" };

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
      const u = await subirArchivoR2(buf, `debug/bodegaaurrera_${label}_${Date.now()}.png`, "image/png");
      console.log(`📸 [${label}]: ${u}`);
    } catch {}
  }

  page.on("dialog", async dialog => {
    console.log("🔔 Dialog:", dialog.message());
    await dialog.accept().catch(() => {});
  });

  try {
    // ── PASO 1 — Home + modal + "Obtener factura" ──────────────────────────
    console.log("🌐 Cargando portal...");
    await page.goto("https://facturacion.walmartmexico.com.mx", { waitUntil: "networkidle2", timeout: 30000 });
    await clickPorTexto(page, "Aceptar").catch(() => console.log("ℹ️ Sin modal inicial (o ya cerrado)"));
    await page.waitForTimeout(500);
    await screenshot("paso1_home");

    await page.click('a[href="frmDatos.aspx"]');
    await page.waitForSelector("#ctl00_ContentPlaceHolder1_txtTC", { timeout: 15000 });
    console.log("✅ Formulario de ticket cargado");

    // ── PASO 2 — Datos del ticket ───────────────────────────────────────────
    console.log("📋 Llenando datos del ticket...");
    await fillInput(page, "#ctl00_ContentPlaceHolder1_txtMemRFC", rfc);
    await fillInput(page, "#ctl00_ContentPlaceHolder1_txtCP", codigoPostal || "");
    await fillInput(page, "#ctl00_ContentPlaceHolder1_txtTC", tc);
    await fillInput(page, "#ctl00_ContentPlaceHolder1_txtTR", tr);
    await screenshot("paso2_datos_ticket");

    await page.click("#ctl00_ContentPlaceHolder1_btnAceptar"); // "Continuar"
    await page.waitForTimeout(1000);

    // ── PASO 3 — Selección de RFC (perfil guardado en Walmart) ─────────────
    console.log("⏳ Esperando pantalla de selección de RFC / datos fiscales...");
    const paso3 = await Promise.race([
      page.waitForFunction(() => document.querySelectorAll('a[href*="lnkSeleccionar"]').length > 0, { timeout: 15000 })
        .then(() => "seleccionar_rfc"),
      page.waitForSelector("#ctl00_ContentPlaceHolder1_ddlregimenFiscal", { visible: true, timeout: 15000 })
        .then(() => "datos_fiscales_directo"),
      page.waitForFunction(() => document.body.innerText.toLowerCase().includes("no se encuentra"), { timeout: 15000 })
        .then(() => "no_encontrado"),
    ]).catch(() => "timeout");
    await screenshot("paso3_resultado");
    console.log(`📍 Caso: ${paso3}`);

    if (paso3 === "no_encontrado") {
      const msg = await page.evaluate(() => document.body.innerText.match(/[^\n]*no se encuentra[^\n]*/i)?.[0] || "Ticket no encontrado");
      await browser.close();
      return { ok: false, error_code: "datos_invalidos", msg };
    }
    if (paso3 === "timeout") throw new Error("El portal no respondió tras capturar los datos del ticket (timeout 15s)");

    if (paso3 === "seleccionar_rfc") {
      console.log("👤 Seleccionando el primer RFC del listado...");
      await page.click('a[href*="lnkSeleccionar"]');
      await page.waitForSelector("#ctl00_ContentPlaceHolder1_ddlregimenFiscal", { visible: true, timeout: 15000 });
    }

    // ── PASO 4 — Datos fiscales (domicilio ya viene precargado) ────────────
    console.log("📋 Completando Régimen Fiscal y Uso CFDI...");
    await screenshot("paso4_datos_fiscales_antes");

    const regimenValor = regimenFiscal ? String(regimenFiscal) : "601";
    await selectByValue(page, "#ctl00_ContentPlaceHolder1_ddlregimenFiscal", regimenValor);

    console.log("⏳ Esperando opciones de Uso CFDI (carga AJAX tras elegir régimen)...");
    await page.waitForFunction(
      () => { const s = document.querySelector("#ctl00_ContentPlaceHolder1_ddlusoCFDI"); return s && s.options.length > 1; },
      { timeout: 15000 }
    );
    const usoCfdiValor = usoCfdi ? String(usoCfdi).toUpperCase() : "G03";
    await selectByValue(page, "#ctl00_ContentPlaceHolder1_ddlusoCFDI", usoCfdiValor);
    await screenshot("paso4_datos_fiscales_listos");

    await page.click("#ctl00_ContentPlaceHolder1_btnAceptar"); // "Aceptar"
    await page.waitForTimeout(800);

    // ── PASO 5 — Confirmar alerta "¿Están correctos todos sus datos?" ──────
    console.log("✅ Confirmando alerta de datos...");
    await clickPorTexto(page, "Continuar").catch(() => console.log("ℹ️ Sin alerta de confirmación (portal la omitió)"));
    await page.waitForTimeout(1000);
    await screenshot("paso5_post_confirmacion");

    // El backend puede rechazar el reintento con un cooldown temporal
    // ("no puede ser procesada... 24 horas") o decir "ya facturado" — en
    // ambos casos el ticket YA tiene una factura real generada, así que en
    // vez de tronar se recupera vía "Consulta o reenvía tu factura".
    const textoActual = (await page.evaluate(() => document.body.innerText)).toLowerCase();
    const yaFacturadoOCooldown = textoActual.includes("no puede ser procesada") || textoActual.includes("ya facturado") || textoActual.includes("ya fue facturado");
    if (yaFacturadoOCooldown) {
      console.log("♻️ Ticket ya facturado o en cooldown — recuperando vía Consulta...");
      const rec = await recuperarFactura(page, tc, ticketId);
      await browser.close();
      return rec;
    }

    // ── PASO 6 — Forma de pago ──────────────────────────────────────────────
    console.log("💳 Seleccionando forma de pago...");
    await page.waitForSelector("select", { visible: true, timeout: 15000 });
    // TARJETA=04 crédito, 05 monedero, 28 débito — 04 por default (el caso más común en tickets con tarjeta)
    const formaPagoValor = "04";
    await page.$eval("select", (el, v) => {
      el.value = v;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, formaPagoValor);
    await page.waitForTimeout(800);
    await screenshot("paso6_forma_pago");

    await clickPorTexto(page, "Continuar");
    await page.waitForTimeout(1500);
    await screenshot("paso6b_post_forma_pago");

    // ── PASO 7 — Enviar a correo electrónico (no hay descarga XML directa) ─
    // Solo se maneja la variante normal con radios PDF/correo. La variante
    // "Refacturar directo a correo" (que en el portal dispara una solicitud
    // real de cancelación ante el SAT del CFDI existente) se dejó fuera a
    // propósito: no se automatiza ninguna decisión de cancelar/sustituir un
    // CFDI. Si el portal cae en esa variante, el chequeo de radios de abajo
    // simplemente falla limpio (ok:false) sin tocar nada — no hay fallback
    // automático a esa pantalla.
    console.log("📧 Variante con radios — seleccionando 'Enviar a correo electrónico'...");
    const radios = await page.$$("input[type=radio]");
    if (radios.length < 2) throw new Error(`Se esperaban 2 radios (PDF / correo), se encontraron ${radios.length}`);
    await radios[0].click(); // primer radio = "Enviar a correo electrónico" (orden verificado en vivo)
    await page.waitForTimeout(500);

    const emailInput = await page.$('input[type=text][id*="txtEmail" i], input[type=email]');
    if (emailInput) await fillInput(page, "#" + (await page.evaluate(el => el.id, emailInput)), "buzonfacturas@serviciosga.site");
    await screenshot("paso7_correo_seleccionado");

    await clickPorTexto(page, "Facturar");
    await page.waitForTimeout(2000);
    await screenshot("paso8_final");

    const textoFinal = await page.evaluate(() => document.body.innerText);
    await browser.close();

    if (/no es posible|error|no se pudo/i.test(textoFinal) && !/gracias/i.test(textoFinal)) {
      return { ok: false, msg: "El portal no confirmó el envío — revisar screenshot paso8_final" };
    }

    console.log("✅ Bodega Aurrera — factura solicitada por correo, IMAP recogerá XML+PDF");
    return { ok: true, procesandoCorreo: true };

  } catch (err) {
    console.error("❌ Error en bot Bodega Aurrera:", err.message);
    await screenshot("error").catch(() => {});
    try { await browser.close(); } catch {}
    return { ok: false, msg: err.message };
  }
}

module.exports = { facturarBodegaAurrera };
