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

  async function tomarScreenshot(label) {
    try {
      const buf = await page.screenshot({ fullPage: false });
      const url = await subirArchivoR2(buf, `debug/fg_${label}_${Date.now()}.png`, "image/png");
      console.log(`📸 Screenshot [${label}]:`, url);
    } catch (e) {
      console.log(`📸 Screenshot [${label}] falló:`, e.message);
    }
  }

  try {
    // PASO 1 — Navegar al portal
    console.log("🌐 PASO 1 — Navegando al portal de Farmacias Guadalajara...");

    // Función para validar que la página es el portal de facturación (no ecommerce)
    async function esPortalFacturacion(p) {
      return p.evaluate(() => {
        const texto = (document.body?.innerText || '').toLowerCase();
        const tieneFactura = /factura|facturaci[oó]n|folio|rfc|comprobante fiscal/i.test(texto);
        const tieneFormulario = !!document.querySelector(
          'input#folioFactura, input#folio, input[name="folioFactura"], input[name="folio"], ' +
          'input[placeholder*="folio" i], input[placeholder*="ticket" i], input[placeholder*="rfc" i], ' +
          'input[placeholder*="RFC"]'
        );
        return tieneFactura || tieneFormulario;
      });
    }

    const urls = [
      "https://www.movil.farmaciasguadalajara.com/facturacion/",
    ];

    let activePage = page;
    let paginaCargada = false;

    for (const url of urls) {
      try {
        console.log("  Intentando:", url);
        await page.goto(url, { waitUntil: "networkidle2", timeout: 25000 });
        await tomarScreenshot("paso1");

        // Verificar si la página principal es el portal
        if (await esPortalFacturacion(page)) {
          console.log("  ✅ Portal de facturación encontrado en página principal");
          paginaCargada = true;
          break;
        }

        // Buscar en iframes
        const frames = page.frames();
        console.log(`  Revisando ${frames.length} frames...`);
        for (const frame of frames) {
          try {
            const src = frame.url();
            if (!src || src === 'about:blank') continue;
            console.log("  Frame URL:", src);
            if (await esPortalFacturacion(frame)) {
              console.log("  ✅ Portal encontrado en iframe:", src);
              activePage = frame;
              paginaCargada = true;
              break;
            }
          } catch {}
        }
        if (paginaCargada) break;

        // Dump inputs for debugging
        const inputs = await page.evaluate(() => {
          return Array.from(document.querySelectorAll("input")).map(i => ({
            id: i.id, name: i.name, placeholder: i.placeholder
          })).slice(0, 8);
        });
        console.log("  Página no es portal FG. Inputs:", JSON.stringify(inputs));

      } catch (e) {
        console.log("  Falló:", e.message);
      }
    }

    if (!paginaCargada) {
      await tomarScreenshot("sin_portal");
      await browser.close();
      return { ok: false, msg: "No se encontró el portal de facturación de Farmacias Guadalajara en ninguna URL conocida." };
    }

    // Detectar selector real del campo de folio (sin input:first-of-type como fallback)
    const folioSelector = await activePage.evaluate(() => {
      const candidates = [
        'input#folioFactura', 'input#folio', 'input[name="folioFactura"]',
        'input[name="folio"]', 'input[placeholder*="folio" i]', 'input[placeholder*="Folio"]',
      ];
      for (const sel of candidates) {
        if (document.querySelector(sel)) return sel;
      }
      // Dump all inputs for debugging
      return '__inputs__' + JSON.stringify(
        Array.from(document.querySelectorAll("input")).map(i => ({
          id: i.id, name: i.name, placeholder: i.placeholder, type: i.type
        })).slice(0, 12)
      );
    });

    if (!folioSelector || folioSelector.startsWith('__inputs__')) {
      console.log("🔍 Todos los inputs en la página:", folioSelector?.replace('__inputs__', '') || 'ninguno');
      await tomarScreenshot("sin_folio_selector");
      await browser.close();
      return { ok: false, msg: "No se encontró el campo de folio. Revisa screenshot de debug." };
    }

    console.log("🔍 Selector de folio:", folioSelector);
    console.log("✅ Portal cargado correctamente");

    // PASO 2 — Llenar datos del ticket
    console.log("📋 PASO 2 — Llenando datos del ticket...");

    await activePage.click(folioSelector, { clickCount: 3 });
    await activePage.type(folioSelector, String(folioFactura), { delay: 80 });

    const cajaSelector = await activePage.evaluate(() => {
      for (const s of ['input#caja', 'input[name="caja"]', 'input[placeholder*="caja" i]']) {
        if (document.querySelector(s)) return s;
      }
      return null;
    });
    if (cajaSelector) {
      await activePage.click(cajaSelector, { clickCount: 3 });
      await activePage.type(cajaSelector, String(caja), { delay: 80 });
    }

    const fechaSelector = await activePage.evaluate(() => {
      for (const s of ['input#fechaCompra', 'input[name="fechaCompra"]', 'input[type="date"]', 'input[placeholder*="fecha" i]']) {
        if (document.querySelector(s)) return s;
      }
      return null;
    });
    if (fechaSelector) {
      await activePage.click(fechaSelector, { clickCount: 3 });
      await activePage.type(fechaSelector, fechaCompra, { delay: 80 });
    }

    const ticketSelector = await activePage.evaluate(() => {
      for (const s of ['input#ticket', 'input#noTicket', 'input[name="ticket"]', 'input[name="noTicket"]', 'input[placeholder*="ticket" i]']) {
        if (document.querySelector(s)) return s;
      }
      return null;
    });
    if (ticketSelector) {
      await activePage.click(ticketSelector, { clickCount: 3 });
      await activePage.type(ticketSelector, String(noTicket), { delay: 80 });
    }

    const checkboxSelector = await activePage.evaluate(() => {
      for (const s of ['input#politicasPr-input', 'input[name*="politica" i]', 'input[type="checkbox"]']) {
        if (document.querySelector(s)) return s;
      }
      return null;
    });
    if (checkboxSelector) {
      const checked = await activePage.$eval(checkboxSelector, el => el.checked).catch(() => false);
      if (!checked) await activePage.click(checkboxSelector);
    }

    await tomarScreenshot("paso2_filled");
    console.log(`✅ Datos del ticket: folio=${folioFactura} caja=${caja} fecha=${fechaCompra} ticket=${noTicket}`);

    // PASO 3 — Click en Validar Folio
    console.log("✅ PASO 3 — Validando folio...");
    await activePage.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button[type='submit'], button"));
      const btn = btns.find(b => /validar folio|validar|buscar/i.test(b.textContent));
      if (btn) btn.click();
    });
    await page.waitForTimeout(3000);
    await tomarScreenshot("paso3_post_validar");
    console.log("✅ Folio validado");

    // PASO 4 — Modal SweetAlert2 de confirmación de sucursal
    console.log("📍 PASO 4 — Esperando modal de sucursal...");
    const modalVisible = await page.waitForSelector(".swal2-confirm", { timeout: 8000 })
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
    await activePage.waitForFunction(() => {
      const rfcInput = document.querySelector("input#rfc, input[name='rfc'], input[placeholder*='RFC']");
      return rfcInput && !rfcInput.disabled;
    }, { timeout: 15000 });
    await tomarScreenshot("paso5_campos_habilitados");
    console.log("✅ Campos de facturación habilitados");

    const rfcSelector = await activePage.evaluate(() => {
      for (const s of ['input#rfc', 'input[name="rfc"]', 'input[placeholder*="RFC"]', 'input[placeholder*="rfc"]']) {
        if (document.querySelector(s)) return s;
      }
      return null;
    });
    if (rfcSelector) {
      await activePage.click(rfcSelector, { clickCount: 3 });
      await activePage.type(rfcSelector, rfc, { delay: 80 });
      await page.waitForTimeout(500);
    }

    const cpSelector = await activePage.evaluate(() => {
      for (const s of ['input#codigoPostal', 'input[name="codigoPostal"]', 'input[placeholder*="postal" i]', 'input[placeholder*="C.P" i]']) {
        if (document.querySelector(s)) return s;
      }
      return null;
    });
    if (cpSelector) {
      await activePage.click(cpSelector, { clickCount: 3 });
      await activePage.type(cpSelector, String(codigoPostal), { delay: 80 });
      await page.waitForTimeout(500);
    }

    const razonSelector = await activePage.evaluate(() => {
      for (const s of ['input#razonSocial', 'input[name="razonSocial"]', 'input[placeholder*="raz" i]', 'input[placeholder*="nombre" i]']) {
        if (document.querySelector(s)) return s;
      }
      return null;
    });
    if (razonSelector) {
      await activePage.click(razonSelector, { clickCount: 3 });
      await activePage.type(razonSelector, razonSocial, { delay: 80 });
      await page.waitForTimeout(500);
    }

    const regSelect = await activePage.$('select#regimenFiscal, select[name="regimenFiscal"]');
    if (regSelect) {
      await activePage.select('select#regimenFiscal, select[name="regimenFiscal"]', String(regimenFiscal || "601")).catch(() => {});
      await page.waitForTimeout(500);
    }

    const cfdiSelect = await activePage.$('select#usoCfdi, select[name="usoCfdi"]');
    if (cfdiSelect) {
      await activePage.select('select#usoCfdi, select[name="usoCfdi"]', usoCfdi || "G03").catch(() => {});
      await page.waitForTimeout(500);
    }

    // Checkbox envío por correo
    const envioCorreoEl = await activePage.$("input#envioCorreo-input, input[name*='envio' i]");
    if (envioCorreoEl) {
      await envioCorreoEl.click();
      await page.waitForTimeout(500);
      const correoInput = await activePage.$("input[type='email']");
      if (correoInput) {
        await correoInput.click({ clickCount: 3 });
        await correoInput.type("buzonfacturas@serviciosga.site", { delay: 50 });
        console.log("📧 Correo de captura ingresado");
      }
    }
    await tomarScreenshot("paso5_filled");
    console.log(`✅ Datos fiscales: RFC=${rfc} CP=${codigoPostal} Régimen=${regimenFiscal || "601"}`);

    // PASO 6 — Click en Obtener Factura
    console.log("🧾 PASO 6 — Generando factura...");
    await activePage.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button[type='submit'], button"));
      const btn = btns.find(b => /obtener factura|generar factura|facturar/i.test(b.textContent));
      if (btn) btn.click();
    });
    await page.waitForTimeout(8000);
    await tomarScreenshot("paso6_post_generar");
    console.log("✅ Factura generada");

    // Verificar error de plazo
    const errorPlazo = await activePage.evaluate(() =>
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
