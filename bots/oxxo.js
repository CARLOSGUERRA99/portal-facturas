const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");

async function fallbackReimpresionOxxo(page, { fecha, folio, idVenta, total }) {
  try {
    console.log("🔄 Fallback: reimpresión OXXO...");
    await page.waitForTimeout(4000);
    await page.goto(
      "https://www4.oxxo.com:9443/facturacionElectronica-web/views/layout/reimpresionFactura.do",
      { waitUntil: "networkidle2", timeout: 30000 }
    );
    await page.waitForTimeout(3000);

    await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll("a, button, li"));
      const tab = tabs.find(el => el.textContent.trim() === "Factura");
      if (tab) tab.click();
    });
    await page.waitForTimeout(1500);

    await page.evaluate((fecha) => {
      const input = document.querySelector("#form\\:fecha_input");
      if (input) {
        input.removeAttribute("readonly");
        input.value = fecha;
        ["change", "blur"].forEach(ev =>
          input.dispatchEvent(new Event(ev, { bubbles: true }))
        );
      }
    }, fecha);
    await page.waitForTimeout(500);

    await page.click("#form\\:folio", { clickCount: 3 });
    await page.type("#form\\:folio", String(folio), { delay: 80 });
    await page.waitForTimeout(300);
    await page.click("#form\\:venta", { clickCount: 3 });
    await page.type("#form\\:venta", String(idVenta).toUpperCase(), { delay: 80 });
    await page.waitForTimeout(300);
    await page.click("#form\\:total", { clickCount: 3 });
    await page.type("#form\\:total", parseFloat(total).toFixed(2), { delay: 80 });
    await page.waitForTimeout(500);

    await page.evaluate(() => {
      const spans = Array.from(document.querySelectorAll("span"));
      const btn = spans.find(s => s.textContent.trim() === "Validar Ticket");
      if (btn) btn.click();
    });

    await page.waitForFunction(() => {
      const btn = document.querySelector("#form\\:continuar");
      return btn && !btn.disabled;
    }, { timeout: 15000 });

    await page.click("#form\\:continuar");
    await page.waitForTimeout(3000);

    const downloadFile = async (selector) => {
      const newPageP = new Promise(resolve =>
        page.browser().once("targetcreated", t => resolve(t.page()))
      );
      await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (el) el.click();
      }, selector);
      const np = await newPageP.catch(() => null);
      if (!np) return null;
      await np.waitForTimeout(1500);
      const r = await np.waitForResponse(r => r.status() === 200, { timeout: 10000 }).catch(() => null);
      const buf = r ? await r.buffer().catch(() => null) : null;
      await np.close().catch(() => {});
      return buf;
    };

    const xmlBuffer = await downloadFile("#form\\:btnDescargarXml, [id*='Xml']");
    const pdfBuffer = await downloadFile("#form\\:btnDescargarPdf, [id*='Pdf']");

    if (!xmlBuffer && !pdfBuffer) throw new Error("Sin archivos en reimpresión");

    const ts = Date.now();
    const xmlUrl = xmlBuffer ? await subirArchivoR2(xmlBuffer, `facturas/oxxo_reimp_${ts}.xml`, "application/xml") : null;
    const pdfUrl = pdfBuffer ? await subirArchivoR2(pdfBuffer, `facturas/oxxo_reimp_${ts}.pdf`, "application/pdf") : null;

    console.log("✅ Reimpresión OXXO exitosa");
    return { ok: true, xmlUrl, pdfUrl, fuente: "reimpresion" };
  } catch (e) {
    console.log("❌ Fallback reimpresión OXXO falló:", e.message);
    return { ok: false, msg: e.message };
  }
}

async function facturarOXXO({ fecha, folio, idVenta, total, rfc, razonSocial, calle, ext, int, colonia, municipio, codigoPostal, estado, regimenFiscal, usoCfdi }) {
  console.log("🤖 Iniciando bot OXXO...");

  const token = process.env.BROWSERLESS_TOKEN || '';
  const tokenPreview = token.substring(0, 10);

  // Si hay una URL explícita configurada en Railway, usarla directamente
  const urlExplicita = process.env.BROWSERLESS_URL || process.env.BROWSERLESS_WS_ENDPOINT || '';
  const candidatas = urlExplicita
    ? [`${urlExplicita}${urlExplicita.includes('?') ? '&' : '?'}timeout=120000`]
    : [
        `wss://production-sfo.browserless.io?token=${token}&timeout=120000`,
        `wss://chrome.browserless.io?token=${token}&timeout=120000`,
        `wss://browserless.io?token=${token}&timeout=120000`,
      ];

  let browser;
  for (const wsEndpoint of candidatas) {
    const urlLog = wsEndpoint.replace(token, `${tokenPreview}...`);
    console.log(`🔌 Intentando Browserless: ${urlLog}`);
    try {
      browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });
      console.log(`✅ Conectado a Browserless: ${urlLog}`);
      break;
    } catch (connErr) {
      console.error(`❌ Falló ${urlLog}: ${connErr.message}`);
    }
  }
  if (!browser) throw new Error('No se pudo conectar a Browserless con ninguna URL');

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");

  try {
    console.log("🌐 Abriendo portal OXXO...");
    await page.goto("https://www4.oxxo.com:9443/facturacionElectronica-web/views/layout/inicio.do", {
      waitUntil: "networkidle2",
      timeout: 30000,
    });
    await page.waitForTimeout(4000);

    // ── CERRAR POPUP INICIAL ──
    console.log("❌ Cerrando popup...");
    try {
      await page.waitForSelector(".ui-dialog-titlebar-close", { timeout: 8000 });
      await page.waitForTimeout(1000);
      await page.evaluate(() => {
        const btns = document.querySelectorAll(".ui-dialog-titlebar-close, .ui-dialog-titlebar-icon");
        btns.forEach(b => b.click());
      });
      console.log("✅ Popup cerrado via JS");
      await page.waitForTimeout(2000);

      const popupVisible = await page.evaluate(() => {
        const dialog = document.querySelector(".ui-dialog");
        return dialog && dialog.style.display !== "none";
      });
      if (popupVisible) {
        await page.keyboard.press("Escape");
        console.log("✅ Popup cerrado via Escape");
        await page.waitForTimeout(1000);
      }
    } catch {
      console.log("ℹ️ No apareció popup");
    }

    const ss1 = await page.screenshot({ encoding: "base64" });
    console.log("📸 Screenshot 1 - popup cerrado");

    // ── FECHA via datepicker ──
    console.log("📅 Abriendo datepicker...");
    await page.waitForSelector("#form\\:fecha_input", { timeout: 15000 });
    await page.click("#form\\:fecha_input");
    await page.waitForTimeout(1500);

    const partes = fecha.split("/");
    const dia = parseInt(partes[0]);
    const mes = parseInt(partes[1]) - 1;
    const anio = parseInt(partes[2]);
    console.log(`📅 Fecha a seleccionar: día=${dia}, mes=${mes}, año=${anio}`);

    await page.evaluate(async (dia, mes, anio) => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      for (let intento = 0; intento < 24; intento++) {
        const mesSpan = document.querySelector(".ui-datepicker-month");
        const anioSpan = document.querySelector(".ui-datepicker-year");
        if (!mesSpan || !anioSpan) break;
        const meses = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
        const mesIdx = meses.indexOf(mesSpan.textContent.toLowerCase().trim());
        const anioActual = parseInt(anioSpan.textContent);
        if (mesIdx === mes && anioActual === anio) break;
        const fechaActual = new Date(anioActual, mesIdx === -1 ? 0 : mesIdx, 1);
        const fechaTarget = new Date(anio, mes, 1);
        if (fechaTarget < fechaActual) {
          const prev = document.querySelector(".ui-datepicker-prev");
          if (prev) prev.click();
        } else {
          const next = document.querySelector(".ui-datepicker-next:not(.ui-state-disabled)");
          if (next) next.click();
        }
        await sleep(800);
      }
      const celdas = document.querySelectorAll(".ui-datepicker-calendar td[data-handler='selectDay']");
      for (const celda of celdas) {
        const link = celda.querySelector("a");
        if (link && parseInt(link.textContent) === dia) { link.click(); break; }
      }
    }, dia, mes, anio);

    // Esperar que el calendario se cierre
    await page.waitForTimeout(1000);

    // Si el calendario sigue abierto, forzar cierre
    const calAbierto = await page.$('.ui-datepicker:not([style*="display: none"])');
    if (calAbierto) {
      await page.click('#form\\:fecha_input');
      await page.waitForTimeout(500);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
    }

    const fechaValor = await page.$eval('#form\\:fecha_input', el => el.value);
    console.log('📅 Fecha confirmada en campo:', fechaValor);

    // Fallback: escribir la fecha directamente si el datepicker no la registró
    if (!fechaValor || fechaValor.trim() === '') {
      console.log('⚠️ Datepicker falló, escribiendo fecha directo...');
      await page.evaluate((fecha) => {
        const input = document.querySelector('#form\\:fecha_input');
        if (input) {
          input.removeAttribute('readonly');
          input.value = fecha;
          ['input', 'change', 'blur'].forEach(ev =>
            input.dispatchEvent(new Event(ev, { bubbles: true }))
          );
        }
      }, fecha);
      await page.waitForTimeout(1000);
    }

    await page.waitForTimeout(3000);

    // ── FOLIO ──
    console.log("🔢 Llenando folio...", folio);
    await page.click("#form\\:folio", { clickCount: 3 });
    await page.type("#form\\:folio", String(folio), { delay: 100 });
    await page.waitForTimeout(400);
    const folioValor = await page.$eval("#form\\:folio", el => el.value);
    console.log("🔢 Folio en campo:", folioValor);

    // ── ID VENTA ──
    console.log("🔑 Llenando ID venta...");
    await page.click("#form\\:venta", { clickCount: 3 });
    await page.type("#form\\:venta", String(idVenta).toUpperCase(), { delay: 100 });
    await page.waitForTimeout(400);
    console.log("🔑 ID venta en campo:", await page.$eval("#form\\:venta", el => el.value));

    // ── TOTAL ──
    console.log("💰 Llenando total...");
    await page.click("#form\\:total", { clickCount: 3 });
    await page.type("#form\\:total", parseFloat(total).toFixed(2), { delay: 100 });
    await page.waitForTimeout(500);
    console.log("💰 Total en campo:", await page.$eval("#form\\:total", el => el.value));

    const ss2 = await page.screenshot({ encoding: "base64" });
    console.log("📸 Screenshot 2 - antes de validar");

    // ── VALIDAR TICKET ──
    console.log("✅ Validando ticket...");
    await page.evaluate(() => {
      const spans = Array.from(document.querySelectorAll("span"));
      const validar = spans.find(s => s.textContent.trim() === "Validar Ticket");
      if (validar) validar.click();
    });
    await page.waitForTimeout(5000);

    const ss3 = await page.screenshot({ encoding: "base64" });
    console.log("📸 Screenshot 3 - después de validar");

    const continuarHabilitado = await page.evaluate(() => {
      const btn = document.querySelector("#form\\:continuar");
      return btn && !btn.disabled;
    });
    console.log("▶️ Continuar habilitado:", continuarHabilitado);

    if (!continuarHabilitado) {
      const mensajeError = await page.evaluate(() => {
        const msgs = document.querySelectorAll(".ui-messages-error, .ui-message-error-detail, [class*='error']");
        return Array.from(msgs).map(m => m.textContent.trim()).filter(t => t).join(" | ");
      });
      console.log("⚠️ Mensaje portal:", mensajeError);
      await browser.close();
      return { ok: false, msg: `Portal no validó el ticket. ${mensajeError || "Verifica los datos del ticket"}`, screenshot: ss3 };
    }

    // ── CONTINUAR ──
    console.log("▶️ Clic Continuar...");
    await page.click("#form\\:continuar");
    await page.waitForTimeout(3000);

    // ── DATOS FISCALES ──
    // RFC — esperar que se habilite
    console.log('📋 Llenando RFC...');
    await page.waitForFunction(() => {
      const el = document.querySelector("#form\\:rfc");
      return el && !el.disabled;
    }, { timeout: 15000 });
    await page.click("#form\\:rfc", { clickCount: 3 });
    await page.type("#form\\:rfc", rfc, { delay: 80 });
    console.log('✅ RFC llenado, esperando razón social...');
    await page.waitForTimeout(3000);

    // Razón social — polling activo, múltiples selectores posibles
    let razonHabilitada = false;
    for (let i = 0; i < 40; i++) {
      razonHabilitada = await page.evaluate(() => {
        const selectors = [
          "#form\\:razon",
          "#form\\:razonSocial",
          "input[name*='razon']",
          "input[name*='razonSocial']",
          "input[placeholder*='az']",
          "input[placeholder*='ombre']",
        ];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el && !el.disabled) return sel;
        }
        return null;
      });
      if (razonHabilitada) break;
      await page.mouse.move(350 + (i % 5) * 30, 300 + (i % 3) * 20);
      await page.waitForTimeout(500);
    }
    if (!razonHabilitada) throw new Error('Razón social no se habilitó a tiempo');
    await page.click(razonHabilitada, { clickCount: 3 });
    await page.type(razonHabilitada, razonSocial, { delay: 50 });
    console.log('✅ Razón social llenada:', razonSocial);
    await page.waitForTimeout(500);

    // Calle, ext, int, colonia, municipio — llenar directo
    await page.click("#form\\:calle", { clickCount: 3 });
    await page.type("#form\\:calle", calle || "", { delay: 50 });
    await page.click("#form\\:ext", { clickCount: 3 });
    await page.type("#form\\:ext", ext || "S/N", { delay: 50 });
    if (int) {
      await page.click("#form\\:int", { clickCount: 3 });
      await page.type("#form\\:int", int, { delay: 50 });
    }
    await page.click("#form\\:colonia", { clickCount: 3 });
    await page.type("#form\\:colonia", colonia || "", { delay: 50 });
    await page.click("#form\\:dele", { clickCount: 3 });
    await page.type("#form\\:dele", municipio || "", { delay: 50 });

    // Código postal
    console.log('📮 Llenando código postal...');
    await page.click("#form\\:codigo", { clickCount: 3 });
    await page.type("#form\\:codigo", String(codigoPostal), { delay: 80 });
    console.log('✅ CP llenado, esperando Estado...');

    // Estado — polling activo
    let estadoHabilitado = false;
    for (let i = 0; i < 40; i++) {
      estadoHabilitado = await page.evaluate(() => {
        const el = document.querySelector("#form\\:estado_input");
        return el && !el.disabled;
      });
      if (estadoHabilitado) break;
      await page.mouse.move(350 + (i % 5) * 30, 300 + (i % 3) * 20);
      await page.waitForTimeout(500);
    }
    if (!estadoHabilitado) throw new Error('Estado no se habilitó a tiempo');
    await page.select("#form\\:estado_input", estado || "SONORA");
    console.log('✅ Estado seleccionado, esperando Régimen Fiscal...');

    // Régimen fiscal — polling activo, PrimeFaces dropdown
    let regimenListo = false;
    for (let i = 0; i < 40; i++) {
      regimenListo = await page.evaluate(() => {
        // Soporta tanto <select> nativo como PrimeFaces trigger
        const nativo = document.querySelector("#form\\:selectOneMenuRegFis_input");
        if (nativo && !nativo.disabled && nativo.options.length > 1) return true;
        const trigger = document.querySelector(
          "#form\\:selectOneMenuRegFis_label, #form\\:selectOneMenuRegFis"
        );
        return trigger && !trigger.classList.contains('ui-state-disabled');
      });
      if (regimenListo) break;
      await page.mouse.move(350 + (i % 5) * 20, 300 + (i % 3) * 15);
      await page.waitForTimeout(500);
    }
    if (!regimenListo) throw new Error('Régimen fiscal no se habilitó a tiempo');

    // Intentar page.select primero (select nativo); si falla usar clic PrimeFaces
    const regimenNativo = await page.evaluate(() => {
      const el = document.querySelector("#form\\:selectOneMenuRegFis_input");
      return el && el.tagName === 'SELECT' && el.options.length > 1;
    });
    if (regimenNativo) {
      await page.select("#form\\:selectOneMenuRegFis_input", String(regimenFiscal || "601"));
    } else {
      await page.click("#form\\:selectOneMenuRegFis_label, #form\\:selectOneMenuRegFis").catch(() => {});
      await page.waitForTimeout(800);
      const regimenSeleccionado = await page.evaluate((valor) => {
        const items = document.querySelectorAll(
          "#form\\:selectOneMenuRegFis_panel li, #form\\:selectOneMenuRegFis_items li, .ui-selectonemenu-item"
        );
        for (const item of items) {
          if (item.textContent.includes('601') || item.textContent.includes('General de Ley') ||
              item.getAttribute('data-label')?.includes('601')) {
            item.click(); return true;
          }
        }
        return false;
      }, regimenFiscal || "601");
      if (!regimenSeleccionado) throw new Error('No se encontró opción Régimen 601');
    }
    console.log('✅ Régimen fiscal seleccionado, esperando Uso CFDI...');

    // Uso CFDI — esperar que quite ui-state-disabled
    console.log('⏳ Esperando que CFDI se habilite...');
    let cfdiListo = false;
    for (let i = 0; i < 60; i++) {
      // Acción real en DOM — mantiene WebSocket vivo
      cfdiListo = await page.evaluate(() => {
        window.scrollBy(0, 1);
        window.scrollBy(0, -1);
        const div = document.querySelector("#form\\:selectOneMenuCFDI");
        return div && !div.classList.contains('ui-state-disabled');
      });
      if (cfdiListo) break;
      await page.waitForTimeout(500);
    }
    if (!cfdiListo) throw new Error('CFDI nunca se habilitó tras 30s');
    console.log('✅ CFDI habilitado, abriendo dropdown...');

    // Clic en el label para abrir el panel
    await page.click("#form\\:selectOneMenuCFDI_label");
    await page.waitForTimeout(1000);

    // Esperar que el panel sea visible
    await page.waitForFunction(() => {
      const panel = document.querySelector("#form\\:selectOneMenuCFDI_panel");
      return panel && !panel.classList.contains('ui-helper-hidden');
    }, { timeout: 5000 });

    // Seleccionar "Gastos en general"
    const seleccionado = await page.evaluate(() => {
      const items = document.querySelectorAll(
        "#form\\:selectOneMenuCFDI_panel li.ui-selectonemenu-item"
      );
      for (const item of items) {
        if (item.textContent.trim().includes('Gastos en general')) {
          item.click();
          return item.textContent.trim();
        }
      }
      return null;
    });

    if (!seleccionado) throw new Error('No se encontró opción Gastos en general en el panel');
    console.log('✅ Uso CFDI seleccionado:', seleccionado);
    await page.waitForTimeout(500);

    // ── GENERAR FACTURA ──
    console.log("🧾 Generando factura...");
    await page.click("#form\\:generarFactura");
    await page.waitForTimeout(8000);

    // Esperar pantalla de descarga
    await page.waitForFunction(() => {
      const body = document.body.innerText;
      return body.includes('Descargar PDF') ||
             body.includes('Descargar XML') ||
             body.includes('Enviar correo') ||
             body.includes('Envía o descarga');
    }, { timeout: 15000 });
    console.log('✅ Pantalla de descarga detectada');

    // Enviar al correo de captura IMAP
    const emailInput = await page.$('input[type="email"], input[placeholder*="correo"], input[placeholder*="dominio"]');
    if (emailInput) {
      await emailInput.click({ clickCount: 3 });
      await emailInput.type('buzonfacturas@serviciosga.site', { delay: 50 });
      await page.waitForTimeout(500);
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('a, button'));
        const btn = btns.find(b => b.textContent?.includes('Enviar correo'));
        if (btn) btn.click();
      });
      console.log('📧 Correo enviado a buzonfacturas@serviciosga.site');
      await page.waitForTimeout(2000);
    }

    // ── INTERCEPTAR PDF ──
    let pdfUrl = null;
    let xmlUrl = null;

    const newPagePdfPromise = new Promise(resolve =>
      browser.once('targetcreated', t => resolve(t.page()))
    );
    const pdfClicked = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('a, button'))
        .find(b => b.textContent?.includes('Descargar PDF'));
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (pdfClicked) {
      const newPage = await Promise.race([
        newPagePdfPromise,
        new Promise((_, r) => setTimeout(() => r(), 8000))
      ]).catch(() => null);
      if (newPage) {
        await newPage.waitForTimeout(2000);
        const response = await newPage.waitForResponse(
          r => r.status() === 200, { timeout: 10000 }
        ).catch(() => null);
        if (response) {
          const buf = await response.buffer().catch(() => null);
          if (buf) {
            pdfUrl = await subirArchivoR2(buf, `facturas/oxxo_${Date.now()}.pdf`, 'application/pdf');
            console.log('✅ PDF subido a R2:', pdfUrl);
          }
        }
        await newPage.close().catch(() => {});
      }
    }

    // ── INTERCEPTAR XML ──
    const newPageXmlPromise = new Promise(resolve =>
      browser.once('targetcreated', t => resolve(t.page()))
    );
    const xmlClicked = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('a, button'))
        .find(b => b.textContent?.includes('Descargar XML'));
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (xmlClicked) {
      const newPage = await Promise.race([
        newPageXmlPromise,
        new Promise((_, r) => setTimeout(() => r(), 8000))
      ]).catch(() => null);
      if (newPage) {
        await newPage.waitForTimeout(2000);
        const response = await newPage.waitForResponse(
          r => r.status() === 200, { timeout: 10000 }
        ).catch(() => null);
        if (response) {
          const buf = await response.buffer().catch(() => null);
          if (buf) {
            xmlUrl = await subirArchivoR2(buf, `facturas/oxxo_${Date.now()}.xml`, 'application/xml');
            console.log('✅ XML subido a R2:', xmlUrl);
          }
        }
        await newPage.close().catch(() => {});
      }
    }

    // Si no se capturaron archivos → IMAP los recogerá del correo
    if (!xmlUrl && !pdfUrl) {
      console.log('⚠️ Sin archivos directos, IMAP recogerá del correo');
      await browser.close();
      return { ok: true, procesandoCorreo: true };
    }

    await browser.close();
    return { ok: true, xmlUrl, pdfUrl };

  } catch (err) {
    console.error("❌ Error en bot OXXO:", err.message);
    let screenshot = null;
    try { screenshot = await page.screenshot({ encoding: "base64" }); } catch {}

    const fallback = await fallbackReimpresionOxxo(page, { fecha, folio, idVenta, total });
    if (fallback.ok) {
      await browser.close();
      return fallback;
    }

    await browser.close();
    return { ok: false, msg: err.message, screenshot };
  }
}

module.exports = { facturarOXXO };
