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

  try {
    // PASO 1 — Navegar al portal
    console.log("🌐 PASO 1 — Navegando al portal de Farmacias Guadalajara...");
    await page.goto(
      "https://www.farmaciasguadalajara.com/ayuda/facturaci%C3%B3n-electr%C3%B3nica",
      { waitUntil: "networkidle2", timeout: 30000 }
    );
    await page.waitForSelector("input#folioFactura", { timeout: 15000 });
    console.log("✅ Portal cargado");

    // PASO 2 — Llenar datos del ticket
    console.log("📋 PASO 2 — Llenando datos del ticket...");

    await page.click("input#folioFactura", { clickCount: 3 });
    await page.type("input#folioFactura", String(folioFactura), { delay: 80 });

    await page.click("input#caja", { clickCount: 3 });
    await page.type("input#caja", String(caja), { delay: 80 });

    await page.click("input#fechaCompra", { clickCount: 3 });
    await page.type("input#fechaCompra", fechaCompra, { delay: 80 });

    await page.click("input#ticket", { clickCount: 3 });
    await page.type("input#ticket", String(noTicket), { delay: 80 });

    // Checkbox políticas
    const checkboxChecked = await page.$eval(
      "input#politicasPr-input", el => el.checked
    ).catch(() => false);
    if (!checkboxChecked) {
      await page.click("input#politicasPr-input");
    }
    console.log(`✅ Datos del ticket: folio=${folioFactura} caja=${caja} fecha=${fechaCompra} ticket=${noTicket}`);

    // PASO 3 — Click en Validar Folio
    console.log("✅ PASO 3 — Validando folio...");
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button[type='submit']"));
      const btn = btns.find(b => b.textContent?.includes("Validar Folio"));
      if (btn) btn.click();
    });
    await page.waitForTimeout(3000);
    console.log("✅ Folio validado");

    // PASO 4 — Modal SweetAlert2 de confirmación de sucursal
    console.log("📍 PASO 4 — Esperando modal de sucursal...");
    const modalVisible = await page.waitForSelector(".swal2-confirm", { timeout: 10000 })
      .catch(() => null);
    if (modalVisible) {
      console.log("📍 Modal de sucursal detectado, confirmando...");
      await page.click(".swal2-confirm");
      await page.waitForTimeout(2000);
      console.log("✅ Sucursal confirmada");
    } else {
      console.log("ℹ️ Modal de sucursal no apareció, continuando...");
    }

    // PASO 5 — Esperar campos de facturación y llenarlos
    console.log("📋 PASO 5 — Esperando campos de facturación...");
    await page.waitForFunction(() => {
      const rfc = document.querySelector("input#rfc");
      return rfc && !rfc.disabled;
    }, { timeout: 15000 });
    console.log("✅ Campos de facturación habilitados");

    await page.click("input#rfc", { clickCount: 3 });
    await page.type("input#rfc", rfc, { delay: 80 });
    await page.waitForTimeout(500);

    await page.click("input#codigoPostal", { clickCount: 3 });
    await page.type("input#codigoPostal", String(codigoPostal), { delay: 80 });
    await page.waitForTimeout(500);

    await page.click("input#razonSocial", { clickCount: 3 });
    await page.type("input#razonSocial", razonSocial, { delay: 80 });
    await page.waitForTimeout(500);

    await page.select("select#regimenFiscal", String(regimenFiscal || "601"));
    await page.waitForTimeout(500);

    await page.select("select#usoCfdi", usoCfdi || "G03");
    await page.waitForTimeout(500);

    // Checkbox envío por correo
    const envioCorreo = await page.$("input#envioCorreo-input");
    if (envioCorreo) {
      await page.click("input#envioCorreo-input");
      await page.waitForTimeout(500);
      const correoInput = await page.$("input[type='email']");
      if (correoInput) {
        await correoInput.click({ clickCount: 3 });
        await correoInput.type("buzonfacturas@serviciosga.site", { delay: 50 });
        console.log("📧 Correo de captura ingresado");
      }
    }
    console.log(`✅ Datos fiscales: RFC=${rfc} CP=${codigoPostal} Régimen=${regimenFiscal || "601"}`);

    // PASO 6 — Click en Obtener Factura
    console.log("🧾 PASO 6 — Generando factura...");
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button[type='submit']"));
      const btn = btns.find(b => b.textContent?.includes("Obtener Factura"));
      if (btn) btn.click();
    });
    await page.waitForTimeout(8000);
    console.log("✅ Factura generada");

    // Verificar error de plazo
    const errorPlazo = await page.evaluate(() =>
      document.body.innerText.match(/plazo|excede|vencido|expirad/i) !== null &&
      document.body.innerText.match(/error|no se puede|inválid/i) !== null
    );
    if (errorPlazo) {
      console.log("❌ Error de plazo detectado");
      await browser.close();
      return { ok: false, msg: "El ticket excede el plazo permitido para facturar en Farmacias Guadalajara." };
    }

    // PASO 7 — Interceptar descarga PDF y XML
    console.log("📥 PASO 7 — Intentando descarga de archivos...");
    let pdfUrl = null, xmlUrl = null;

    const pdfPagePromise = new Promise(resolve =>
      browser.once("targetcreated", t => resolve(t.page()))
    );
    const pdfClicked = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll("a, button, input[type='submit']"));
      const btn = links.find(b =>
        b.textContent?.toLowerCase().includes("pdf") ||
        b.href?.includes(".pdf") ||
        b.value?.toLowerCase().includes("pdf")
      );
      if (btn) { btn.scrollIntoView(); btn.click(); return true; }
      return false;
    });
    if (pdfClicked) {
      const newPage = await Promise.race([
        pdfPagePromise,
        new Promise((_, r) => setTimeout(() => r(), 10000))
      ]).catch(() => null);
      if (newPage) {
        await newPage.waitForTimeout(3000);
        const response = await newPage.waitForResponse(
          r => r.status() === 200, { timeout: 10000 }
        ).catch(() => null);
        if (response) {
          const buf = await response.buffer().catch(() => null);
          if (buf && buf.length > 100) {
            pdfUrl = await subirArchivoR2(buf, `facturas/fg_${Date.now()}.pdf`, "application/pdf");
            console.log("✅ PDF subido a R2:", pdfUrl);
          }
        }
        await newPage.close().catch(() => {});
      }
    }

    const xmlPagePromise = new Promise(resolve =>
      browser.once("targetcreated", t => resolve(t.page()))
    );
    const xmlClicked = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll("a, button, input[type='submit']"));
      const btn = links.find(b =>
        b.textContent?.toLowerCase().includes("xml") ||
        b.href?.includes(".xml") ||
        b.value?.toLowerCase().includes("xml")
      );
      if (btn) { btn.scrollIntoView(); btn.click(); return true; }
      return false;
    });
    if (xmlClicked) {
      const newPage = await Promise.race([
        xmlPagePromise,
        new Promise((_, r) => setTimeout(() => r(), 10000))
      ]).catch(() => null);
      if (newPage) {
        await newPage.waitForTimeout(3000);
        const response = await newPage.waitForResponse(
          r => r.status() === 200, { timeout: 10000 }
        ).catch(() => null);
        if (response) {
          const buf = await response.buffer().catch(() => null);
          if (buf && buf.length > 100) {
            xmlUrl = await subirArchivoR2(buf, `facturas/fg_${Date.now()}.xml`, "application/xml");
            console.log("✅ XML subido a R2:", xmlUrl);
          }
        }
        await newPage.close().catch(() => {});
      }
    }

    await browser.close();

    if (!xmlUrl && !pdfUrl) {
      console.log("⚠️ No se capturaron archivos directos — IMAP recogerá del correo");
      return { ok: true, procesandoCorreo: true };
    }

    console.log("✅ Farmacias Guadalajara completado — XML:", xmlUrl, "| PDF:", pdfUrl);
    return { ok: true, xmlUrl, pdfUrl };

  } catch (err) {
    console.error("❌ Error en bot Farmacias Guadalajara:", err.message);
    try { await browser.close(); } catch {}
    return { ok: false, msg: err.message };
  }
}

module.exports = { facturarFarmaciasGuadalajara };
