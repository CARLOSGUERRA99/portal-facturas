const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");

async function fallbackReimpresionOxxo(page, { fecha, folio, idVenta, total }) {
  try {
    console.log("🔄 Fallback: reimpresión OXXO...");

    // 1. Navegar a reimpresión
    await page.goto(
      "https://www4.oxxo.com:9443/facturacionElectronica-web/views/layout/reimpresionFactura.do",
      { waitUntil: "networkidle2", timeout: 30000 }
    );
    await page.waitForTimeout(1500);

    // 2. Fecha via datepicker
    await page.waitForSelector("#form\\:fecha_input", { timeout: 10000 });
    await page.click("#form\\:fecha_input");
    await page.waitForTimeout(500);

    const partes = fecha.split("/");
    const dia = parseInt(partes[0]);
    const mes = parseInt(partes[1]) - 1;
    const anio = parseInt(partes[2]);

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
        const fechaTarget = new Date(anio, mes, 1);
        const fechaActual = new Date(anioActual, mesIdx === -1 ? 0 : mesIdx, 1);
        if (fechaTarget < fechaActual) {
          document.querySelector(".ui-datepicker-prev")?.click();
        } else {
          document.querySelector(".ui-datepicker-next:not(.ui-state-disabled)")?.click();
        }
        await sleep(300);
      }
      const celdas = document.querySelectorAll(".ui-datepicker-calendar td[data-handler='selectDay']");
      for (const celda of celdas) {
        const link = celda.querySelector("a");
        if (link && parseInt(link.textContent) === dia) { link.click(); break; }
      }
    }, dia, mes, anio);
    await page.waitForTimeout(500);

    const fechaValor = await page.$eval('#form\\:fecha_input', el => el.value);
    if (!fechaValor || fechaValor.trim() === '') {
      await page.evaluate((f) => {
        const input = document.querySelector('#form\\:fecha_input');
        if (input) {
          input.removeAttribute('readonly');
          input.value = f;
          ['input', 'change', 'blur'].forEach(ev =>
            input.dispatchEvent(new Event(ev, { bubbles: true }))
          );
        }
      }, fecha);
      await page.waitForTimeout(500);
    }
    console.log('📅 Fecha reimpresión:', fechaValor || fecha);

    // 3. Folio
    await page.click("#form\\:folio", { clickCount: 3 });
    await page.type("#form\\:folio", String(folio), { delay: 60 });

    // 4. ID Venta
    await page.click("#form\\:venta", { clickCount: 3 });
    await page.type("#form\\:venta", String(idVenta).toUpperCase(), { delay: 60 });

    // 5. Total
    await page.click("#form\\:total", { clickCount: 3 });
    await page.type("#form\\:total", parseFloat(total).toFixed(2), { delay: 60 });

    // 6. Click Verificar
    console.log("✅ Click Verificar reimpresión...");
    await page.click("#form\\:j_idt62");
    await page.waitForTimeout(3000);

    // 8. Email IMAP
    await page.evaluate(() => {
      const el = document.querySelector("#form\\:emailEnv");
      if (el) {
        el.scrollIntoView();
        el.click();
      }
    });
    await page.click("#form\\:emailEnv", { clickCount: 3 });
    await page.type("#form\\:emailEnv", "buzonfacturas@serviciosga.site", { delay: 50 });

    // 9. Enviar correo
    await page.evaluate(() => {
      const el = document.querySelector("#form\\:j_idt66");
      if (el) { el.scrollIntoView(); el.click(); }
    });
    console.log('📧 Correo de reimpresión enviado');
    await page.waitForTimeout(2000);

    // 11. PDF
    await page.evaluate(() => {
      const el = document.querySelector("#form\\:j_idt68");
      if (el) { el.scrollIntoView(); el.click(); }
    });
    console.log('📄 PDF reimpresión click');
    await page.waitForTimeout(2000);

    // 13. XML
    await page.evaluate(() => {
      const el = document.querySelector("#form\\:j_idt70");
      if (el) { el.scrollIntoView(); el.click(); }
    });
    console.log('📄 XML reimpresión click');

    console.log("✅ Reimpresión OXXO completada — IMAP recogerá archivos");
    return { ok: true, procesandoCorreo: true };
  } catch (e) {
    console.log("❌ Fallback reimpresión OXXO falló:", e.message);
    return { ok: false, msg: e.message };
  }
}

async function facturarOXXO({ fecha, folio, idVenta, total, rfc, razonSocial, calle, ext, int, colonia, municipio, codigoPostal, estado, regimenFiscal, usoCfdi }) {
  console.log("🤖 Iniciando bot OXXO...");

  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error('BROWSERLESS_TOKEN no definido');
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}`
  });
  console.log('✅ Conectado a Browserless');

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");

  try {
    console.log("🌐 Abriendo portal OXXO...");
    await page.goto("https://www4.oxxo.com:9443/facturacionElectronica-web/views/layout/inicio.do", {
      waitUntil: "networkidle2",
      timeout: 30000,
    });
    await page.waitForTimeout(1500);

    // ── CERRAR POPUP INICIAL ──
    try {
      await page.waitForSelector(".ui-dialog-titlebar-close", { timeout: 6000 });
      await page.evaluate(() => {
        document.querySelectorAll(".ui-dialog-titlebar-close, .ui-dialog-titlebar-icon").forEach(b => b.click());
      });
      await page.waitForTimeout(500);
      const popupVisible = await page.evaluate(() => {
        const d = document.querySelector(".ui-dialog");
        return d && d.style.display !== "none";
      });
      if (popupVisible) {
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);
      }
      console.log("✅ Popup cerrado");
    } catch {
      console.log("ℹ️ No apareció popup");
    }

    // ── FECHA via datepicker ──
    console.log("📅 Abriendo datepicker...");
    await page.waitForSelector("#form\\:fecha_input", { timeout: 15000 });
    await page.click("#form\\:fecha_input");
    await page.waitForTimeout(500);

    const partes = fecha.split("/");
    const dia = parseInt(partes[0]);
    const mes = parseInt(partes[1]) - 1;
    const anio = parseInt(partes[2]);
    console.log(`📅 Fecha: día=${dia}, mes=${mes}, año=${anio}`);

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
        const fechaTarget = new Date(anio, mes, 1);
        const fechaActual = new Date(anioActual, mesIdx === -1 ? 0 : mesIdx, 1);
        if (fechaTarget < fechaActual) {
          document.querySelector(".ui-datepicker-prev")?.click();
        } else {
          document.querySelector(".ui-datepicker-next:not(.ui-state-disabled)")?.click();
        }
        await sleep(300);
      }
      const celdas = document.querySelectorAll(".ui-datepicker-calendar td[data-handler='selectDay']");
      for (const celda of celdas) {
        const link = celda.querySelector("a");
        if (link && parseInt(link.textContent) === dia) { link.click(); break; }
      }
    }, dia, mes, anio);

    await page.waitForTimeout(800);

    const calAbierto = await page.$('.ui-datepicker:not([style*="display: none"])');
    if (calAbierto) {
      await page.click('#form\\:fecha_input');
      await page.waitForTimeout(300);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }

    const fechaValor = await page.$eval('#form\\:fecha_input', el => el.value);
    console.log('📅 Fecha confirmada:', fechaValor);

    if (!fechaValor || fechaValor.trim() === '') {
      console.log('⚠️ Datepicker falló, escribiendo fecha directo...');
      await page.evaluate((f) => {
        const input = document.querySelector('#form\\:fecha_input');
        if (input) {
          input.removeAttribute('readonly');
          input.value = f;
          ['input', 'change', 'blur'].forEach(ev =>
            input.dispatchEvent(new Event(ev, { bubbles: true }))
          );
        }
      }, fecha);
      await page.waitForTimeout(500);
    }

    await page.waitForTimeout(500);

    // ── FOLIO ──
    console.log("🔢 Llenando folio...", folio);
    await page.click("#form\\:folio", { clickCount: 3 });
    await page.type("#form\\:folio", String(folio), { delay: 60 });
    await page.waitForTimeout(150);
    console.log("🔢 Folio:", await page.$eval("#form\\:folio", el => el.value));

    // ── ID VENTA ──
    console.log("🔑 Llenando ID venta...");
    await page.click("#form\\:venta", { clickCount: 3 });
    await page.type("#form\\:venta", String(idVenta).toUpperCase(), { delay: 60 });
    await page.waitForTimeout(150);
    console.log("🔑 ID venta:", await page.$eval("#form\\:venta", el => el.value));

    // ── TOTAL ──
    console.log("💰 Llenando total...");
    await page.click("#form\\:total", { clickCount: 3 });
    await page.type("#form\\:total", parseFloat(total).toFixed(2), { delay: 60 });
    await page.waitForTimeout(150);
    console.log("💰 Total:", await page.$eval("#form\\:total", el => el.value));

    // ── VALIDAR TICKET — reactivo ──
    console.log("✅ Validando ticket...");
    // El botón real es el commandLink <a id="form:validarTicket"> (no el <span> decorativo).
    await page.evaluate(() => {
      const link = document.querySelector("#form\\:validarTicket");
      if (link) { link.click(); return; }
      const a = Array.from(document.querySelectorAll("a"))
        .find(x => /^validar ticket$/i.test((x.textContent || "").trim()));
      if (a) a.click();
    });

    // Esperar: continuar habilitado O modal de error (folio no encontrado)
    const resultadoValidacion = await Promise.race([
      page.waitForFunction(() => {
        const btn = document.querySelector("#form\\:continuar");
        return btn && !btn.disabled;
      }, { timeout: 15000 }).then(() => 'continuar'),
      page.waitForFunction(() => {
        const body = document.body.innerText || '';
        return /no tuvo éxito|no encontr|folio.*no.*valid|favor de volver/i.test(body);
      }, { timeout: 15000 }).then(() => 'folio_no_disponible'),
    ]).catch(() => 'timeout');

    console.log("▶️ Resultado validación:", resultadoValidacion);

    if (resultadoValidacion === 'folio_no_disponible') {
      const msgPortal = await page.evaluate(() => {
        const el = document.querySelector('.ui-messages-error, [class*="error"], .ui-dialog-content');
        return el ? el.textContent.trim().substring(0, 200) : 'Folio no encontrado en el sistema OXXO';
      });
      await browser.close();
      return { ok: false, tipo: 'folio_no_disponible', msg: `El folio no está disponible en OXXO. ${msgPortal}` };
    }

    if (resultadoValidacion === 'timeout' || resultadoValidacion !== 'continuar') {
      const mensajeError = await page.evaluate(() => {
        const msgs = document.querySelectorAll(".ui-messages-error, .ui-message-error-detail, [class*='error']");
        return Array.from(msgs).map(m => m.textContent.trim()).filter(t => t).join(" | ");
      });
      await browser.close();
      return { ok: false, msg: `Portal no validó el ticket. ${mensajeError || "Verifica los datos del ticket"}` };
    }

    // ── CONTINUAR ──
    console.log("▶️ Clic Continuar...");
    await page.click("#form\\:continuar");
    await page.waitForTimeout(1000);

    // ── RFC ──
    console.log('📋 Llenando RFC...');
    await page.waitForFunction(() => {
      const el = document.querySelector("#form\\:rfc");
      return el && !el.disabled;
    }, { timeout: 15000 });
    await page.click("#form\\:rfc", { clickCount: 3 });
    await page.keyboard.type(rfc, { delay: 100 });
    await page.evaluate(() => {
      const el = document.querySelector("#form\\:rfc");
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    });
    await page.waitForTimeout(2000);
    console.log('✅ RFC llenado y blur disparado');

    const regimenOpciones = await page.evaluate(() => {
      const ul = document.querySelector("#form\\:selectOneMenuRegFis_panel ul");
      return ul ? ul.querySelectorAll('li').length : 0;
    });
    console.log('📋 Opciones de Régimen Fiscal tras RFC blur:', regimenOpciones);

    // ── RAZÓN SOCIAL — polling activo con DOM keepalive ──
    let razonHabilitada = false;
    for (let i = 0; i < 40; i++) {
      razonHabilitada = await page.evaluate(() => {
        window.scrollBy(0, 1);
        window.scrollBy(0, -1);
        for (const sel of ["#form\\:razon","#form\\:razonSocial","input[name*='razon']","input[name*='razonSocial']","input[placeholder*='az']","input[placeholder*='ombre']"]) {
          const el = document.querySelector(sel);
          if (el && !el.disabled) return sel;
        }
        return null;
      });
      if (razonHabilitada) break;
      await page.waitForTimeout(300);
    }
    if (!razonHabilitada) throw new Error('Razón social no se habilitó a tiempo');
    await page.click(razonHabilitada, { clickCount: 3 });
    await page.type(razonHabilitada, razonSocial, { delay: 40 });
    console.log('✅ Razón social llenada:', razonSocial);
    await page.waitForTimeout(200);

    // ── DIRECCIÓN ──
    await page.click("#form\\:calle", { clickCount: 3 });
    await page.type("#form\\:calle", calle || "", { delay: 40 });
    await page.click("#form\\:ext", { clickCount: 3 });
    await page.type("#form\\:ext", ext || "S/N", { delay: 40 });
    if (int) {
      await page.click("#form\\:int", { clickCount: 3 });
      await page.type("#form\\:int", int, { delay: 40 });
    }
    await page.click("#form\\:colonia", { clickCount: 3 });
    await page.type("#form\\:colonia", colonia || "", { delay: 40 });
    await page.click("#form\\:dele", { clickCount: 3 });
    await page.type("#form\\:dele", municipio || "", { delay: 40 });

    // ── CÓDIGO POSTAL ──
    console.log('📮 Llenando código postal...');
    await page.click("#form\\:codigo", { clickCount: 3 });
    await page.keyboard.type(String(codigoPostal), { delay: 100 });
    await page.evaluate(() => {
      const el = document.querySelector("#form\\:codigo");
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    });
    await page.waitForTimeout(1500);
    console.log('✅ CP llenado y blur disparado');

    // ── ESTADO — clic visual PrimeFaces (opciones cargadas tras CP blur) ──
    await page.waitForTimeout(1500);
    await page.click("#form\\:estado_label");
    await page.waitForTimeout(500);
    const estadoOk = await page.evaluate((val) => {
      const items = document.querySelectorAll(
        "#form\\:estado_panel li.ui-selectonemenu-item"
      );
      for (const item of items) {
        if (item.textContent.trim().toUpperCase() === val.toUpperCase()) {
          item.click();
          return true;
        }
      }
      return false;
    }, estado || "SONORA");
    console.log('✅ Estado seleccionado:', estadoOk);
    await page.waitForTimeout(1500);

    // ── RÉGIMEN FISCAL — clic visual PrimeFaces (9 opciones ya disponibles) ──
    await page.click("#form\\:selectOneMenuRegFis_label");
    await page.waitForTimeout(500);
    const regimenOk = await page.evaluate(() => {
      const items = document.querySelectorAll(
        "#form\\:selectOneMenuRegFis_panel li.ui-selectonemenu-item"
      );
      for (const item of items) {
        if (item.textContent.includes('601') ||
            item.textContent.includes('General de Ley')) {
          item.click();
          return item.textContent.trim();
        }
      }
      return null;
    });
    console.log('✅ Régimen fiscal:', regimenOk);
    await page.waitForTimeout(2000);

    // ── USO CFDI — clic visual PrimeFaces (opciones cargadas tras Régimen) ──
    const cfdiOpciones = await page.evaluate(() => {
      const ul = document.querySelector(
        "#form\\:selectOneMenuCFDI_panel ul"
      );
      return ul ? ul.querySelectorAll('li').length : 0;
    });
    console.log('📋 Opciones CFDI:', cfdiOpciones);

    await page.click("#form\\:selectOneMenuCFDI_label");
    await page.waitForTimeout(500);
    const cfdiOk = await page.evaluate(() => {
      const items = document.querySelectorAll(
        "#form\\:selectOneMenuCFDI_panel li.ui-selectonemenu-item"
      );
      for (const item of items) {
        if (item.textContent.includes('Gastos en general')) {
          item.click();
          return item.textContent.trim();
        }
      }
      return null;
    });
    console.log('✅ CFDI:', cfdiOk);

    // ── GENERAR FACTURA ──
    console.log("🧾 Generando factura...");
    await page.click("#form\\:generarFactura");
    await page.waitForTimeout(5000);

    await page.waitForFunction(() => {
      const body = document.body.innerText;
      return body.includes('Descargar PDF') ||
             body.includes('Descargar XML') ||
             body.includes('Enviar correo') ||
             body.includes('Envía o descarga');
    }, { timeout: 20000 });
    console.log('✅ Pantalla de descarga detectada');

    // Esperar que la pantalla cargue completamente
    await page.waitForTimeout(2000);

    // Primero enviar al correo IMAP como respaldo
    console.log('📧 Enviando por correo...');
    const emailInput = await page.$(
      'input[type="email"], input[placeholder*="correo"], input[placeholder*="dominio"], input[placeholder*="CORREO"]'
    );
    if (emailInput) {
      await emailInput.click({ clickCount: 3 });
      await emailInput.type('buzonfacturas@serviciosga.site', { delay: 50 });
      await page.waitForTimeout(500);
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('a, button, input[type="submit"]'));
        const btn = btns.find(b =>
          b.textContent?.toLowerCase().includes('enviar') ||
          b.value?.toLowerCase().includes('enviar')
        );
        if (btn) btn.click();
      });
      console.log('📧 Correo enviado a buzonfacturas@serviciosga.site');
      await page.waitForTimeout(3000);
    }

    // Intentar descargar PDF scrollando al elemento primero
    const pdfDescargado = await page.evaluate(async () => {
      const links = Array.from(document.querySelectorAll('a, button'));
      const pdfBtn = links.find(l =>
        l.textContent?.includes('Descargar PDF') ||
        l.textContent?.includes('PDF') ||
        l.href?.includes('.pdf')
      );
      if (pdfBtn) {
        pdfBtn.scrollIntoView();
        pdfBtn.click();
        return true;
      }
      return false;
    });
    console.log('📄 PDF click:', pdfDescargado);
    await page.waitForTimeout(3000);

    // Intentar descargar XML
    const xmlDescargado = await page.evaluate(async () => {
      const links = Array.from(document.querySelectorAll('a, button'));
      const xmlBtn = links.find(l =>
        l.textContent?.includes('Descargar XML') ||
        l.textContent?.includes('XML') ||
        l.href?.includes('.xml')
      );
      if (xmlBtn) {
        xmlBtn.scrollIntoView();
        xmlBtn.click();
        return true;
      }
      return false;
    });
    console.log('📄 XML click:', xmlDescargado);

    // Si no se capturaron archivos directos, IMAP los recogerá
    console.log('⚠️ IMAP recogerá archivos del correo enviado');
    await browser.close();
    return { ok: true, procesandoCorreo: true };

  } catch (err) {
    console.error("❌ Error en bot OXXO:", err.message);
    const fallback = await fallbackReimpresionOxxo(page, { fecha, folio, idVenta, total });
    if (fallback.ok) {
      await browser.close();
      return fallback;
    }
    await browser.close();
    return { ok: false, msg: err.message };
  }
}

module.exports = { facturarOXXO };
