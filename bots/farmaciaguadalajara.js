const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");

async function facturarFarmaciasGuadalajara({ rfc, codigoPostal, razonSocial, regimenFiscal, usoCfdi, folioFactura, caja, fechaCompra, noTicket, ticketId, email }) {
  console.log("🤖 Iniciando bot Farmacias Guadalajara...");
  console.log(`   RFC: ${rfc} | Folio: ${folioFactura} | Caja: ${caja} | Fecha: ${fechaCompra} | Ticket: ${noTicket}`);

  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error("BROWSERLESS_TOKEN no definido");

  // stealth=true hace que Browserless active puppeteer-extra-plugin-stealth
  // para que el portal no detecte que es un bot automatizado
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true`
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
  );
  await page.setExtraHTTPHeaders({
    "Accept-Language": "es-MX,es;q=0.9,en;q=0.8",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  });

  async function screenshot(label) {
    try {
      const buf = await page.screenshot({ fullPage: false });
      const url = await subirArchivoR2(buf, `debug/fg_${label}_${Date.now()}.png`, "image/png");
      console.log(`📸 [${label}]: ${url}`);
    } catch {}
  }

  // Limpia un input y escribe el valor — compatible con Angular reactive forms + ng-mask
  async function llenar(selector, valor) {
    await page.click(selector);
    await page.waitForTimeout(200);
    await page.keyboard.down("Control");
    await page.keyboard.press("a");
    await page.keyboard.up("Control");
    await page.waitForTimeout(100);
    await page.keyboard.press("Delete");
    await page.waitForTimeout(100);
    await page.keyboard.type(String(valor), { delay: 70 });
    await page.waitForTimeout(200);
  }

  // Llena el campo de folio con mask AAAAAA-AAAAAA-A* — carácter a carácter con pausa
  async function llenarFolio(valor) {
    await page.click("input#folioFactura");
    await page.waitForTimeout(300);
    await page.keyboard.down("Control");
    await page.keyboard.press("a");
    await page.keyboard.up("Control");
    await page.waitForTimeout(100);
    await page.keyboard.press("Delete");
    await page.waitForTimeout(200);

    for (const char of String(valor)) {
      await page.keyboard.type(char, { delay: 90 });
      await page.waitForTimeout(40);
    }
    await page.waitForTimeout(300);

    const valActual = await page.$eval("input#folioFactura", el => el.value).catch(() => "?");
    console.log(`📝 folioFactura en campo: "${valActual}" (esperado: "${valor}")`);
  }

  // Llena el campo de fecha — maneja datepicker de Bootstrap
  async function llenarFecha(valor) {
    // Formato esperado por el portal: YYYY-MM-DD desde la OCR
    // Intentamos escribirlo directamente; el datepicker acepta texto
    await page.click("input#fechaCompra");
    await page.waitForTimeout(300);
    // Cerrar cualquier calendario que haya abierto
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    await page.click("input#fechaCompra");
    await page.waitForTimeout(200);
    await page.keyboard.down("Control");
    await page.keyboard.press("a");
    await page.keyboard.up("Control");
    await page.keyboard.press("Delete");
    await page.waitForTimeout(100);
    await page.keyboard.type(String(valor), { delay: 70 });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    const valActual = await page.$eval("input#fechaCompra", el => el.value).catch(() => "?");
    console.log(`📝 fechaCompra en campo: "${valActual}" (esperado: "${valor}")`);
  }

  // Clasifica el texto de un modal de SweetAlert2
  function clasificarModal(texto) {
    const t = texto.toLowerCase();

    // Sistema realmente caído — requiere palabras de contexto de sistema/servicio global
    if (
      /sistema\s+de\s+facturaci[oó]n.{0,30}no\s+(est[aá]|se\s+encuentra).{0,20}disponible/i.test(texto) ||
      /el\s+servicio\s+(de\s+facturaci[oó]n\s+)?no\s+est[aá]\s+disponible/i.test(texto) ||
      /fuera\s+de\s+servicio/i.test(texto) ||
      /mantenimiento\s+programado/i.test(texto) ||
      /temporalmente\s+fuera\s+de\s+l[ií]nea/i.test(texto)
    ) {
      return "sistema_caido";
    }

    // Datos del ticket inválidos / no encontrados
    if (
      /no\s+(se\s+)?encontr[oó]/i.test(t) ||
      /no\s+v[aá]lid[ao]/i.test(t) ||
      /datos\s+incorrectos/i.test(t) ||
      /folio\s+inv[aá]lido/i.test(t) ||
      /ticket\s+no\s+encontrad/i.test(t) ||
      /no\s+existe\s+(el\s+)?(folio|ticket)/i.test(t) ||
      /no\s+corresponde/i.test(t)
    ) {
      return "datos_invalidos";
    }

    // Ticket ya facturado
    if (/ya\s+(fue\s+)?facturad|ya\s+procesad|previously\s+invoiced/i.test(t)) {
      return "ya_facturado";
    }

    // Por defecto: modal de confirmación de sucursal
    return "confirmacion";
  }

  try {
    // PASO 1 — Navegar al portal
    console.log("🌐 PASO 1 — Navegando...");
    await page.goto("https://www.movil.farmaciasguadalajara.com/facturacion/", {
      waitUntil: "networkidle2",
      timeout: 30000,
    });
    await page.waitForSelector("input#folioFactura", { timeout: 15000 });
    await screenshot("paso1_cargado");
    console.log("✅ Portal cargado");

    // PASO 2 — Llenar datos del ticket
    console.log("📋 PASO 2 — Llenando datos del ticket...");

    await llenarFolio(String(folioFactura));
    await page.waitForTimeout(200);

    await llenar("input#caja", String(caja));
    await page.waitForTimeout(200);

    await llenarFecha(fechaCompra);
    await page.waitForTimeout(200);

    await llenar("input#ticket", String(noTicket));
    await page.waitForTimeout(200);

    const politicasChecked = await page.$eval("input#politicasPr-input", el => el.checked).catch(() => false);
    if (!politicasChecked) {
      await page.click("input#politicasPr-input");
      await page.waitForTimeout(300);
    }

    await screenshot("paso2_llenado");
    console.log(`✅ Ticket llenado`);

    // PASO 3 — Click en Validar Folio
    console.log("🔍 PASO 3 — Validando folio...");
    const validarClicked = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find(b =>
        b.textContent.includes("Validar Folio")
      );
      if (btn) { btn.scrollIntoView(); btn.click(); return true; }
      return false;
    });
    if (!validarClicked) {
      await screenshot("error_sin_btn_validar");
      throw new Error("No se encontró el botón 'Validar Folio'");
    }
    console.log("✅ Clic en Validar Folio — esperando respuesta...");

    // PASO 4 — Esperar y manejar el modal de respuesta
    const modal = await page.waitForSelector(".swal2-popup", { timeout: 15000 }).catch(() => null);
    await screenshot("paso4_modal");

    if (!modal) {
      console.log("ℹ️ Sin modal tras validar — verificando si los campos ya están activos...");
      const rfcHabilitado = await page.$("input#rfc:not([disabled])");
      if (!rfcHabilitado) {
        await screenshot("paso4_sin_modal_sin_campos");
        throw new Error("No apareció modal y los campos fiscales no se habilitaron");
      }
      console.log("✅ Campos habilitados directamente (sin modal de sucursal)");
    } else {
      const textoModal = await page.$eval(".swal2-popup", el => el.innerText);
      console.log("📍 Texto completo del modal:\n---\n" + textoModal + "\n---");

      const tipo = clasificarModal(textoModal);
      console.log(`📍 Tipo de modal detectado: ${tipo}`);

      if (tipo === "sistema_caido") {
        await screenshot("sistema_caido");
        await browser.close();
        return {
          ok: false,
          msg: `Sistema de facturación no disponible. Portal dice: ${textoModal.substring(0, 120)}`,
        };
      }

      if (tipo === "datos_invalidos") {
        await screenshot("datos_invalidos");
        await browser.close();
        return {
          ok: false,
          msg: `Datos del ticket no válidos. Verifica folio, caja, fecha y número de ticket. Portal dice: ${textoModal.substring(0, 120)}`,
        };
      }

      if (tipo === "ya_facturado") {
        await browser.close();
        return { ok: true, procesandoCorreo: true };
      }

      // tipo === "confirmacion" — click en Sí / botón de confirmar
      const siClicked = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll(".swal2-popup button"));
        const si = btns.find(b =>
          b.classList.contains("swal2-confirm") ||
          /^s[ií]$/i.test(b.textContent.trim())
        );
        if (si) { si.click(); return si.textContent.trim(); }
        // Fallback: primer botón visible no-cancel
        const primero = btns.find(b => !b.classList.contains("swal2-deny") && !b.classList.contains("swal2-cancel") && b.offsetParent);
        if (primero) { primero.click(); return primero.textContent.trim(); }
        return null;
      });
      console.log(`✅ Sucursal confirmada — botón: "${siClicked}"`);

      // Esperar que el modal se cierre
      await page.waitForFunction(() => !document.querySelector(".swal2-popup"), { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(1000);
      await screenshot("paso4_post_confirmacion");
    }

    // PASO 5 — Llenar datos fiscales
    console.log("📋 PASO 5 — Esperando campos fiscales...");
    await page.waitForSelector("input#rfc:not([disabled])", { timeout: 20000 });
    await screenshot("paso5_campos_activos");
    console.log("✅ Campos fiscales habilitados");

    await llenar("input#rfc", rfc);
    await llenar("input#codigoPostal", String(codigoPostal));
    await llenar("input#razonSocial", razonSocial);

    await page.select("select#regimenFiscal", String(regimenFiscal || "601"));
    await page.waitForTimeout(300);
    await page.select("select#usoCfdi", usoCfdi || "G03");
    await page.waitForTimeout(300);

    const envioChecked = await page.$eval("input#envioCorreo-input", el => el.checked).catch(() => false);
    if (!envioChecked) {
      await page.click("input#envioCorreo-input");
      await page.waitForTimeout(800);
    }
    const emailInput = await page.waitForSelector("input[type='email']", { timeout: 5000 }).catch(() => null);
    if (emailInput) {
      await emailInput.click({ clickCount: 3 });
      await emailInput.type("buzonfacturas@serviciosga.site", { delay: 50 });
      await page.$eval("input[type='email']", el => {
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("blur", { bubbles: true }));
      });
      console.log("📧 Correo de captura ingresado");
    }

    await screenshot("paso5_datos_fiscales");
    console.log(`✅ Datos fiscales: RFC=${rfc} CP=${codigoPostal} Régimen=${regimenFiscal || "601"}`);

    // PASO 6 — Click en Obtener Factura
    console.log("🧾 PASO 6 — Generando factura...");
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find(b =>
        b.textContent.includes("Obtener Factura")
      );
      if (btn) { btn.scrollIntoView(); btn.click(); }
    });
    await page.waitForTimeout(12000);
    await screenshot("paso6_post_generar");
    console.log("✅ Factura solicitada");

    const textoPost = await page.evaluate(() => document.body.innerText.toLowerCase());
    if (/excede.*30 d[ií]as|plazo.*vencido|no.*puede.*facturar|fecha.*excede/i.test(textoPost)) {
      await browser.close();
      return { ok: false, msg: "El ticket excede el plazo de 30 días para facturar en Farmacias Guadalajara." };
    }
    if (/ya.*facturad|ya.*fue.*procesad|previously invoiced/i.test(textoPost)) {
      await browser.close();
      return { ok: true, procesandoCorreo: true };
    }

    // PASO 7 — Interceptar PDF y XML
    console.log("📥 PASO 7 — Descargando archivos...");
    let pdfUrl = null, xmlUrl = null;

    async function interceptarDescarga(clickFn) {
      const newPagePromise = new Promise(resolve =>
        browser.once("targetcreated", t => resolve(t.page()))
      );
      await clickFn();
      const newPage = await Promise.race([
        newPagePromise,
        new Promise((_, r) => setTimeout(r, 10000)),
      ]).catch(() => null);
      if (!newPage) return null;
      await newPage.waitForTimeout(3000);
      const response = await newPage.waitForResponse(r => r.status() === 200, { timeout: 10000 }).catch(() => null);
      const buf = response ? await response.buffer().catch(() => null) : null;
      await newPage.close().catch(() => {});
      return buf;
    }

    const pdfBuf = await interceptarDescarga(() =>
      page.evaluate(() => {
        const el = Array.from(document.querySelectorAll("a, button, input[type='submit']")).find(b =>
          b.textContent?.toLowerCase().includes("pdf") || b.href?.includes(".pdf") || b.value?.toLowerCase().includes("pdf")
        );
        if (el) { el.scrollIntoView(); el.click(); }
      })
    ).catch(() => null);

    const xmlBuf = await interceptarDescarga(() =>
      page.evaluate(() => {
        const el = Array.from(document.querySelectorAll("a, button, input[type='submit']")).find(b =>
          b.textContent?.toLowerCase().includes("xml") || b.href?.includes(".xml") || b.value?.toLowerCase().includes("xml")
        );
        if (el) { el.scrollIntoView(); el.click(); }
      })
    ).catch(() => null);

    await browser.close();

    if (pdfBuf && pdfBuf.length > 100) {
      pdfUrl = await subirArchivoR2(pdfBuf, `facturas/fg_${ticketId || Date.now()}.pdf`, "application/pdf");
      console.log("✅ PDF subido:", pdfUrl);
    }
    if (xmlBuf && xmlBuf.length > 100) {
      xmlUrl = await subirArchivoR2(xmlBuf, `facturas/fg_${ticketId || Date.now()}.xml`, "application/xml");
      console.log("✅ XML subido:", xmlUrl);
    }

    if (!pdfUrl && !xmlUrl) {
      console.log("⚠️ Sin archivos directos — IMAP recogerá del correo");
      return { ok: true, procesandoCorreo: true };
    }

    console.log(`✅ Farmacias Guadalajara OK — PDF: ${pdfUrl} | XML: ${xmlUrl}`);
    return { ok: true, xmlUrl, pdfUrl };

  } catch (err) {
    console.error("❌ Error en bot Farmacias Guadalajara:", err.message);
    await screenshot("error").catch(() => {});
    try { await browser.close(); } catch {}
    return { ok: false, msg: err.message };
  }
}

module.exports = { facturarFarmaciasGuadalajara };
