// eRFC (erfc.com.mx) — plataforma compartida por muchas gasolineras/comercios
// chicos que reciben CFDIs vía código IDW impreso en el ticket.
//
// Reconocimiento real (2026-07-27, cuenta real GPN, ticket real "Natalia
// María del Carmen Flores Arciniega S.A. de C.V.", IDW real confirmado):
//   1. Home: correo + RFC + checkbox "He leído..." (DISABLED hasta hacer
//      click en "Oprima para Leer Términos y Condiciones", que expande el
//      texto inline y habilita el checkbox) → botón "Ingresar".
//   2. /facturacion/: RFC llega prellenado por sesión. CP (#DomicilioFiscalReceptor)
//      y Razón Social (#nombre) son inputs normales. Régimen Fiscal
//      (#RegimenFiscalReceptor) y Uso CFDI (#selectUsoCfdi) son Select2 con
//      datos vía AJAX (select.controller.php?select=regimenfiscal/usocfdi) —
//      SOLO cargan tras un click real (Puppeteer, no dispatchEvent) sobre el
//      <span class="select2-selection">, no sobre el <select> oculto. Uso
//      CFDI ya trae "G03" preseleccionado por default.
//   3. Email (#email) — cuidado: llega PRE-LLENADO con el correo del login,
//      hay que limpiarlo antes de escribir o queda duplicado/concatenado.
//   4. Código IDW: 5 inputs #idw_tmp_01..05, tamaños confirmados vía
//      config.controller.php (len_box1=3, resto 4, total len_idws=19) — NO
//      asumir 4 parejo. CRÍTICO: el propio portal advierte "Respete tal cual
//      está impreso el código IDW mayúsculas y minúsculas" — en la prueba
//      real, un carácter que a simple vista parecía letra "O" mayúscula
//      resultó ser dígito "0" (confirmado porque letra/dígito no se pueden
//      distinguir a simple vista en la fuente del ticket; se probó contra
//      revisaIDW.php hasta obtener "1-O.K." en vez de error 500).
//   5. Botón "+" (#btn_idw) agrega el IDW a la lista tras validarlo
//      (revisaIDW.php). Botón "Enviar" (#btn_envio) hace la petición real
//      (guarda_peticion.php) — la respuesta confirma con isOK:true, pero el
//      CFDI real lo genera DESPUÉS "el establecimiento comercial" (proceso
//      asíncrono, no hay descarga inmediata). Estado queda "Registrado" en
//      "Mis Facturas" (facturas_x_usuario.controller.php) hasta que el
//      comercio lo procese — se recoge por correo (mismo mecanismo IMAP que
//      el resto del proyecto).
const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");

async function seleccionarSelect2(page, index, matchStr, label) {
  const sels = await page.$$(".select2-selection");
  if (!sels[index]) throw new Error(`eRFC: no se encontró el select2 #${index} (${label})`);
  await sels[index].click();
  await page.waitForTimeout(1200);
  const texts = await page.$$eval(".select2-results__option", els => els.map(e => e.textContent.trim()));
  const idx = texts.findIndex(t => t.startsWith(matchStr));
  if (idx === -1) throw new Error(`eRFC: no se encontró opción "${matchStr}" en ${label}: [${texts.join(" | ")}]`);
  const items = await page.$$(".select2-results__option");
  await items[idx].click();
  await page.waitForTimeout(500);
}

async function facturarERFC({ rfc, razonSocial, codigoPostal, regimenFiscal, usoCfdi, idw, ticketId }) {
  console.log("🤖 Iniciando bot eRFC...");
  const idwLimpio = String(idw || "").trim();
  console.log(`   RFC: ${rfc} | IDW: ${idwLimpio}`);

  const bloques = idwLimpio.split(/\s+/);
  if (bloques.length !== 5) {
    return { ok: false, error_code: "datos_invalidos", msg: `eRFC: el código IDW debe tener 5 bloques separados por espacio (tiene ${bloques.length}): "${idwLimpio}"` };
  }

  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error("BROWSERLESS_TOKEN no definido");
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true`,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1000 });
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");

  const ts = ticketId || Date.now();
  async function screenshot(label) {
    try {
      const buf = await page.screenshot({ fullPage: true });
      const u = await subirArchivoR2(buf, `debug/erfc_${ts}_${label}_${Date.now()}.png`, "image/png");
      console.log(`📸 [${label}]: ${u}`);
    } catch {}
  }

  try {
    console.log("🌐 Cargando erfc.com.mx...");
    await page.goto("https://www.erfc.com.mx", { waitUntil: "load", timeout: 30000 });
    await page.waitForSelector("#rfc", { timeout: 15000 });

    await page.click("#correo"); await page.keyboard.type("buzonfacturas@serviciosga.site", { delay: 15 });
    await page.click("#rfc"); await page.keyboard.type(rfc, { delay: 15 });
    await page.click("#link_terminos_condiciones");
    await page.waitForTimeout(600);
    await page.click("#accept_terminos_condiciones");
    await page.click("#btn-access");
    await page.waitForTimeout(2500);

    const enFacturacion = await page.evaluate(() => location.href.includes("/facturacion/"));
    if (!enFacturacion) {
      await screenshot("login_fallido");
      await browser.close();
      return { ok: false, msg: "eRFC: no se pudo acceder a /facturacion/ tras Ingresar (revisar RFC/términos)" };
    }
    console.log("✅ Acceso concedido");
    await screenshot("p1_facturacion");

    console.log("📋 Llenando datos fiscales...");
    await page.click("#DomicilioFiscalReceptor");
    await page.keyboard.type(String(codigoPostal || "").slice(0, 5), { delay: 15 });
    await page.click("#nombre");
    await page.keyboard.type(razonSocial, { delay: 12 });

    const regimenCodigo = String(regimenFiscal || "601").match(/\d{3}/)?.[0] || "601";
    await seleccionarSelect2(page, 0, regimenCodigo, "Régimen Fiscal");

    const usoCodigo = String(usoCfdi || "G03").toUpperCase();
    const usoActual = await page.$eval("#selectUsoCfdi", el => el.value).catch(() => null);
    if (usoActual !== usoCodigo) {
      await seleccionarSelect2(page, 1, usoCodigo, "Uso CFDI");
    }

    // El email llega pre-llenado desde el login — limpiar antes de escribir
    await page.evaluate(() => { const el = document.getElementById("email"); if (el) el.value = ""; });
    await page.click("#email");
    await page.keyboard.type("buzonfacturas@serviciosga.site", { delay: 12 });
    await screenshot("p2_fiscales_completos");

    console.log(`📋 Código IDW: ${bloques.join(" ")}`);
    const idsIdw = ["idw_tmp_01", "idw_tmp_02", "idw_tmp_03", "idw_tmp_04", "idw_tmp_05"];
    for (let i = 0; i < 5; i++) {
      await page.click(`#${idsIdw[i]}`);
      await page.keyboard.type(bloques[i], { delay: 20 });
    }

    let idwRespuesta = null;
    page.once("response", async (resp) => {
      if (/revisaIDW\.php/i.test(resp.url())) {
        idwRespuesta = { status: resp.status(), body: await resp.text().catch(() => null) };
      }
    });
    await page.click("#btn_idw");
    await page.waitForTimeout(2200);
    console.log(`📋 revisaIDW.php → ${JSON.stringify(idwRespuesta)}`);
    await screenshot("p3_post_idw");

    const totalTexto = await page.evaluate(() => document.body.innerText);
    const totalMatch = totalTexto.match(/Tickets Totales:\s*(\d+)/);
    const totalTickets = totalMatch ? parseInt(totalMatch[1], 10) : 0;

    if (totalTickets < 1) {
      await browser.close();
      const msgError = idwRespuesta?.status === 500
        ? "el código IDW no fue reconocido (revisar transcripción — cuidado con O/0, I/1, mayúsc/minúsc)"
        : `no se agregó el ticket (revisaIDW respondió ${idwRespuesta?.status})`;
      return { ok: false, error_code: "datos_invalidos", msg: `eRFC: ${msgError}` };
    }

    console.log("🧾 Click Enviar (petición real)...");
    let envioRespuesta = null;
    page.once("response", async (resp) => {
      if (/guarda_peticion\.php/i.test(resp.url())) {
        envioRespuesta = { status: resp.status(), body: await resp.text().catch(() => null) };
      }
    });
    await page.click("#btn_envio");
    await page.waitForTimeout(4000);
    await screenshot("p4_post_enviar");

    const textoFinal = await page.evaluate(() => document.body.innerText);
    await browser.close();

    console.log(`📋 guarda_peticion.php → ${JSON.stringify(envioRespuesta)}`);

    if (/ha sido aceptada satisfactoriamente/i.test(textoFinal)) {
      console.log("✅ eRFC — petición aceptada. El establecimiento genera el CFDI después (asíncrono) — IMAP lo recogerá cuando llegue.");
      return { ok: true, procesandoCorreo: true };
    }

    return { ok: false, msg: `eRFC: no se confirmó la aceptación tras Enviar. Texto: ${textoFinal.slice(0, 300)}` };

  } catch (err) {
    console.error("❌ Error en bot eRFC:", err.message);
    await screenshot("error").catch(() => {});
    await browser.close().catch(() => {});
    return { ok: false, msg: `eRFC: ${err.message}` };
  }
}

module.exports = { facturarERFC };
