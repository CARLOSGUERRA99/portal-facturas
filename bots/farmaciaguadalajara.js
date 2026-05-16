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

    // PASO 4 — Modal de confirmación de sucursal
    console.log("📍 PASO 4 — Esperando modal de sucursal...");
    const modal = await page.waitForSelector(".swal2-popup", { timeout: 8000 }).catch(() => null);
    if (modal) {
      const modalTexto = await page.evaluate(() =>
        document.querySelector(".swal2-popup")?.innerText?.toLowerCase() || ""
      );
      console.log("📍 Texto del modal:", modalTexto.substring(0, 120));

      if (/no disponible|fuera de servicio|mantenimiento|servicio no/i.test(modalTexto)) {
        console.log("⚠️ Sistema de facturación no disponible");
        await tomarScreenshot("sistema_no_disponible");
        await browser.close();
        return { ok: false, msg: "El sistema de facturación de Farmacias Guadalajara no está disponible en este momento. Intenta más tarde." };
      }

      // Buscar botón SI (texto) o .swal2-confirm
      const clicConfirmar = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll(".swal2-popup button, .swal2-actions button"));
        const si = btns.find(b => /^s[ií]$/i.test(b.textContent.trim()) || b.classList.contains("swal2-confirm"));
        if (si) { si.click(); return true; }
        return false;
      });
      if (clicConfirmar) {
        await page.waitForTimeout(2500);
        console.log("✅ Sucursal confirmada");
      } else {
        console.log("⚠️ No se encontró botón SI en modal");
      }
    } else {
      console.log("ℹ️ Sin modal de sucursal, continuando...");
    }

    // Scroll para revelar la sección 2
    await activePage.evaluate(() => window.scrollTo(0, 600));
    await page.waitForTimeout(1000);
    await tomarScreenshot("paso4_post_modal");

    // PASO 5 — Esperar y llenar datos de facturación
    console.log("📋 PASO 5 — Esperando campos de facturación...");

    // Esperar que aparezca al menos 1 input habilitado visible (no es el folio ya completado)
    await activePage.waitForFunction(() => {
      const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'));
      return inputs.some(i => !i.disabled && !i.readOnly && i.offsetParent !== null && i.value === '');
    }, { timeout: 15000 });

    // Dump de inputs para debug
    const todosInputs = await activePage.evaluate(() =>
      Array.from(document.querySelectorAll('input, select')).map(el => ({
        tag: el.tagName, id: el.id, name: el.name, placeholder: el.placeholder,
        type: el.type, disabled: el.disabled, value: el.value?.substring(0, 20)
      }))
    );
    console.log("🔍 Inputs en página:", JSON.stringify(todosInputs));
    await tomarScreenshot("paso5_campos_habilitados");
    console.log("✅ Sección de facturación activa");

    // Función para llenar por label (busca label con texto, luego su input asociado)
    async function llenarPorLabel(labelTexto, valor) {
      const selector = await activePage.evaluate((txt) => {
        const labels = Array.from(document.querySelectorAll('label'));
        const label = labels.find(l => l.textContent.trim().toLowerCase().includes(txt.toLowerCase()));
        if (!label) return null;
        if (label.htmlFor) return '#' + label.htmlFor;
        const inp = label.nextElementSibling?.tagName === 'INPUT'
          ? label.nextElementSibling
          : label.closest('div,p,li')?.querySelector('input');
        if (inp) {
          if (inp.id) return '#' + inp.id;
          if (inp.name) return `input[name="${inp.name}"]`;
        }
        return null;
      }, labelTexto);
      if (!selector) { console.log(`⚠️ Label no encontrado: "${labelTexto}"`); return; }
      await activePage.click(selector, { clickCount: 3 }).catch(() => {});
      await activePage.type(selector, String(valor), { delay: 60 });
      console.log(`✅ "${labelTexto}" → ${String(valor).substring(0, 20)}`);
    }

    // Función para seleccionar por label
    async function seleccionarPorLabel(labelTexto, valor) {
      const selector = await activePage.evaluate((txt) => {
        const labels = Array.from(document.querySelectorAll('label'));
        const label = labels.find(l => l.textContent.trim().toLowerCase().includes(txt.toLowerCase()));
        if (!label) return null;
        if (label.htmlFor) return '#' + label.htmlFor;
        const sel = label.nextElementSibling?.tagName === 'SELECT'
          ? label.nextElementSibling
          : label.closest('div,p,li')?.querySelector('select');
        if (sel) {
          if (sel.id) return '#' + sel.id;
          if (sel.name) return `select[name="${sel.name}"]`;
        }
        return null;
      }, labelTexto);
      if (!selector) { console.log(`⚠️ Select label no encontrado: "${labelTexto}"`); return; }
      await activePage.select(selector, String(valor)).catch(e => console.log(`⚠️ select "${labelTexto}":`, e.message));
      console.log(`✅ "${labelTexto}" → ${valor}`);
    }

    await llenarPorLabel("RFC", rfc);
    await page.waitForTimeout(400);
    await llenarPorLabel("Código Postal", String(codigoPostal));
    await page.waitForTimeout(400);
    await llenarPorLabel("Nombre", razonSocial);
    await page.waitForTimeout(400);

    await seleccionarPorLabel("Régimen", String(regimenFiscal || "601"));
    await page.waitForTimeout(400);
    await seleccionarPorLabel("Uso CFDI", usoCfdi || "G03");
    await page.waitForTimeout(400);

    // Correo electrónico — llenar por label o input[type=email]
    const emailField = await activePage.$('input[type="email"]');
    if (emailField) {
      await emailField.click({ clickCount: 3 });
      await emailField.type("buzonfacturas@serviciosga.site", { delay: 50 });
      console.log("📧 Correo ingresado por input[type=email]");
    } else {
      await llenarPorLabel("correo", "buzonfacturas@serviciosga.site");
      await llenarPorLabel("email", "buzonfacturas@serviciosga.site");
    }

    await tomarScreenshot("paso5_filled");
    console.log(`✅ Datos fiscales llenados: RFC=${rfc} CP=${codigoPostal}`);

    // PASO 6 — Click en Obtener Factura / Generar / Continuar
    console.log("🧾 PASO 6 — Generando factura...");
    await activePage.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button[type='submit'], button, input[type='submit']"));
      const btn = btns.find(b => /obtener factura|generar factura|facturar|continuar|siguiente/i.test(
        b.textContent || b.value || ""
      ));
      if (btn) { btn.scrollIntoView(); btn.click(); }
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
