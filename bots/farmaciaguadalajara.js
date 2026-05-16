const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");

async function facturarFarmaciasGuadalajara({ rfc, codigoPostal, razonSocial, regimenFiscal, usoCfdi, folioFactura, caja, fechaCompra, noTicket, ticketId, email }) {
  console.log("🤖 Iniciando bot Farmacias Guadalajara...");
  console.log(`   RFC: ${rfc} | Folio: ${folioFactura} | Caja: ${caja}`);

  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error("BROWSERLESS_TOKEN no definido");
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}`
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");

  async function screenshot(label) {
    try {
      const buf = await page.screenshot({ fullPage: false });
      const url = await subirArchivoR2(buf, `debug/fg_${label}_${Date.now()}.png`, "image/png");
      console.log(`📸 [${label}]:`, url);
    } catch {}
  }

  // Llena un input Angular usando typing + eventos para que reactive forms detecte el cambio
  async function llenar(selector, valor) {
    await page.click(selector, { clickCount: 3 });
    await page.keyboard.press("Delete");
    await page.type(selector, String(valor), { delay: 60 });
    await page.$eval(selector, el => {
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur", { bubbles: true }));
    });
  }

  try {
    // PASO 1 — Navegar
    console.log("🌐 PASO 1 — Navegando al portal...");
    await page.goto("https://www.movil.farmaciasguadalajara.com/facturacion/", {
      waitUntil: "networkidle2", timeout: 30000
    });
    await page.waitForSelector("input#folioFactura", { timeout: 15000 });
    await screenshot("paso1_cargado");
    console.log("✅ Portal cargado");

    // PASO 2 — Llenar datos del ticket
    console.log("📋 PASO 2 — Llenando datos del ticket...");

    // folioFactura tiene mask="AAAAAA-AAAAAA-A*" — Angular ng-mask auto-inserta guiones,
    // así que escribimos sin guiones para que el mask los posicione correctamente
    const folioSinGuiones = String(folioFactura).replace(/-/g, "");
    await llenar("input#folioFactura", folioSinGuiones);
    await page.waitForTimeout(300);

    await llenar("input#caja", String(caja));
    await page.waitForTimeout(300);

    // fechaCompra tiene bsdatepicker — escribir directo en formato YYYY-MM-DD
    await llenar("input#fechaCompra", fechaCompra);
    await page.waitForTimeout(300);

    // ticket tiene mask="0*0000*0"
    await llenar("input#ticket", String(noTicket));
    await page.waitForTimeout(300);

    // Checkbox políticas
    const politicasChecked = await page.$eval("input#politicasPr-input", el => el.checked).catch(() => false);
    if (!politicasChecked) {
      await page.click("input#politicasPr-input");
      await page.waitForTimeout(300);
    }

    await screenshot("paso2_llenado");
    console.log(`✅ Ticket: folio=${folioFactura} caja=${caja} fecha=${fechaCompra} ticket=${noTicket}`);

    // PASO 3 — Click en Validar Folio
    console.log("🔍 PASO 3 — Validando folio...");
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find(b =>
        b.textContent.includes("Validar Folio")
      );
      if (btn) btn.click();
    });
    await page.waitForTimeout(4000);
    await screenshot("paso3_post_validar");
    console.log("✅ Folio enviado a validar");

    // PASO 4 — Modal de confirmación de sucursal
    console.log("📍 PASO 4 — Esperando modal de sucursal...");
    const modal = await page.waitForSelector(".swal2-popup", { timeout: 10000 }).catch(() => null);
    if (modal) {
      const textoModal = await page.$eval(".swal2-popup", el => el.innerText.toLowerCase());
      console.log("📍 Modal:", textoModal.substring(0, 100));

      if (/no disponible|fuera de servicio|mantenimiento|servicio no disponible/i.test(textoModal)) {
        console.log("⚠️ Sistema de facturación no disponible");
        await screenshot("sistema_no_disponible");
        await browser.close();
        return { ok: false, msg: "El sistema de facturación de Farmacias Guadalajara no está disponible en este momento. Intenta más tarde." };
      }

      // Hacer click en botón SI (.swal2-confirm o botón con texto "SI"/"Sí")
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll(".swal2-popup button"));
        const si = btns.find(b =>
          b.classList.contains("swal2-confirm") ||
          /^s[ií]$/i.test(b.textContent.trim())
        );
        if (si) si.click();
      });
      await page.waitForTimeout(3000);
      await screenshot("paso4_post_si");
      console.log("✅ Sucursal confirmada");
    } else {
      await screenshot("paso4_sin_modal");
      console.log("ℹ️ Sin modal de sucursal");
    }

    // PASO 5 — Esperar que input#rfc quede habilitado y llenar datos fiscales
    console.log("📋 PASO 5 — Esperando campos de facturación habilitados...");
    await page.waitForSelector("input#rfc:not([disabled])", { timeout: 15000 });
    await screenshot("paso5_habilitado");
    console.log("✅ Sección de facturación activa");

    await llenar("input#rfc", rfc);
    await page.waitForTimeout(400);

    await llenar("input#codigoPostal", String(codigoPostal));
    await page.waitForTimeout(400);

    await llenar("input#razonSocial", razonSocial);
    await page.waitForTimeout(400);

    await page.select("select#regimenFiscal", String(regimenFiscal || "601"));
    await page.waitForTimeout(400);

    await page.select("select#usoCfdi", usoCfdi || "G03");
    await page.waitForTimeout(400);

    // Checkbox "Quiero recibir la factura por correo"
    const envioChecked = await page.$eval("input#envioCorreo-input", el => el.checked).catch(() => false);
    if (!envioChecked) {
      await page.click("input#envioCorreo-input");
      await page.waitForTimeout(600);
    }
    // Esperar campo de correo y llenarlo
    const emailInput = await page.waitForSelector("input[type='email']", { timeout: 4000 }).catch(() => null);
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
    await page.waitForTimeout(10000);
    await screenshot("paso6_post_generar");
    console.log("✅ Factura enviada a generar");

    // Verificar errores de plazo / ticket ya facturado
    const textoPost = await page.evaluate(() => document.body.innerText.toLowerCase());
    if (/excede.*30 d[ií]as|plazo.*vencido|no.*puede.*facturar|fecha.*excede/i.test(textoPost)) {
      console.log("❌ Ticket fuera del plazo de 30 días");
      await browser.close();
      return { ok: false, msg: "El ticket excede el plazo de 30 días permitido para facturar en Farmacias Guadalajara." };
    }
    if (/ya.*facturad|ya.*fue.*procesad|previously invoiced/i.test(textoPost)) {
      console.log("⚠️ Ticket ya fue facturado previamente");
      await browser.close();
      return { ok: true, procesandoCorreo: true };
    }

    // PASO 7 — Interceptar PDF y XML
    console.log("📥 PASO 7 — Intentando descarga de archivos...");
    let pdfUrl = null, xmlUrl = null;

    async function interceptarDescarga(clickFn) {
      const newPagePromise = new Promise(resolve =>
        browser.once("targetcreated", t => resolve(t.page()))
      );
      await clickFn();
      const newPage = await Promise.race([
        newPagePromise,
        new Promise((_, r) => setTimeout(r, 10000))
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

    console.log("✅ Farmacias Guadalajara completado — XML:", xmlUrl, "| PDF:", pdfUrl);
    return { ok: true, xmlUrl, pdfUrl };

  } catch (err) {
    console.error("❌ Error en bot Farmacias Guadalajara:", err.message);
    await screenshot("error").catch(() => {});
    try { await browser.close(); } catch {}
    return { ok: false, msg: err.message };
  }
}

module.exports = { facturarFarmaciasGuadalajara };
