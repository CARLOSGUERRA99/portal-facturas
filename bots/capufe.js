// CAPUFE (Caminos y Puentes Federales) — facturacioncapufe.com.mx/Capufe/facturacionrapida
// SPA React + PrimeReact, backend REST en /capufe-quadrum-backend/sinregistro/*.
// Reconocimiento real confirmó:
//  - El dato que pide el portal es el código "FACTURACION" de 18 caracteres
//    impreso en el ticket (NO el folio) — placeholder "Código de 18 caracteres".
//  - RFC dispara buscar_receptor_por_rfc.json (auto-completa si ya existe) +
//    regimen/usocfdi_rfc.json + usocfdi40/uso_cfdi_por_rfc.json (catálogos).
//  - Régimen Fiscal y Uso CFDI son <div class="p-dropdown"> (PrimeReact), NO
//    <select> nativos — hay que hacer click para abrir el panel y click en el
//    <li class="p-dropdown-item"> real; asignar .value no tiene efecto.
//  - "Validar Código" llama a sinregistro/ticket/validar.json. Si el código ya
//    fue validado antes en OTRA sesión sin llegar a "Facturar conceptos", el
//    backend lo marca "ya se encuentra capturado" y lo rechaza — por eso todo
//    el flujo debe correr en una sola sesión continua, sin cortes.
//  - Botón final real es "Facturar conceptos" (el link de nav "Facturar sus
//    códigos" solo navega a esta misma pantalla, no es el submit).
//  - Aviso del propio portal: una vez emitida la factura NO se puede remitir
//    a otro RFC ni corregir datos — los datos fiscales deben ser correctos
//    desde la primera vez.
const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");

async function abrirYSeleccionar(page, dropdownIndex, matchFn, label) {
  const handles = await page.$$(".p-dropdown");
  if (!handles[dropdownIndex]) throw new Error(`CAPUFE: no se encontró el dropdown "${label}"`);
  await handles[dropdownIndex].click();
  await page.waitForTimeout(1000);
  const items = await page.evaluate(() => Array.from(document.querySelectorAll("li.p-dropdown-item")).map(li => li.textContent.trim()));
  const idx = items.findIndex(matchFn);
  if (idx === -1) {
    await page.keyboard.press("Escape");
    throw new Error(`CAPUFE: no se encontró opción "${label}" entre [${items.join(" | ")}]`);
  }
  const liHandles = await page.$$("li.p-dropdown-item");
  await liHandles[idx].click();
  await page.waitForTimeout(400);
}

// Usa la opción "Recuperar una factura, por código alfanumérico" del propio
// portal para rescatar un código que quedó capturado sin completar el flujo.
//
// Es la salida que el portal ofrece para exactamente este caso, y hace falta
// porque validar un código LO RESERVA: si el proceso se corta antes de
// "Facturar conceptos", "Validar Código" ya solo responde "ya se encuentra
// capturado" y `buscar_tickets.json` devuelve lista vacía en sesión nueva. Sin
// esta vía el consumo quedaba inalcanzable para siempre.
//
// ⚠️ El panel de recuperación mete un SEGUNDO input con id="codigo" en la misma
// página (el portal duplica el id). Hay que quedarse con el del panel de
// recuperación, no con el de 18 caracteres del formulario normal.
async function recuperarFacturaPorCodigo(page, codigoLimpio, screenshot, apiCalls, fiscales = {}) {
  console.log(`♻️ Intentando "Recuperar factura por código" para ${codigoLimpio}...`);
  const abierto = await page.evaluate(() => {
    const a = Array.from(document.querySelectorAll("a, button, li"))
      .find(e => /recuperar una factura/i.test(e.textContent || "") && e.offsetParent);
    if (!a) return false;
    a.click();
    return true;
  });
  if (!abierto) return { ok: false, msg: "CAPUFE: no se encontró la opción de recuperar factura" };
  await page.waitForTimeout(2500);

  const escrito = await page.evaluate((cod) => {
    // El input de recuperación es el que NO pide 18 caracteres.
    const campos = Array.from(document.querySelectorAll('input[id="codigo"]')).filter(i => i.offsetParent);
    const inp = campos.find(i => !/18/.test(i.placeholder || "")) || campos[0];
    if (!inp) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(inp, cod);
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    inp.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, codigoLimpio);
  if (!escrito) return { ok: false, msg: "CAPUFE: no apareció el campo de recuperación" };

  await page.waitForTimeout(600);
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll("button"))
      .find(x => /recuperar|buscar|consultar|aceptar/i.test(x.textContent || "") && x.offsetParent);
    if (b) b.click();
  });
  await page.waitForTimeout(5000);
  await screenshot("p6_recuperacion");

  let texto = await page.evaluate(() => document.body.innerText);
  if (/no se encontr|no existe|sin resultados/i.test(texto)) {
    return { ok: false, msg: `CAPUFE: la recuperación no encontró el código ${codigoLimpio}` };
  }

  // ⚠️ La recuperación NO es solo "descargar una factura ya hecha": el panel
  // pide otra vez los datos fiscales ("Capturar datos fiscales: RFC, Nombre,
  // Domicilio Fiscal, Régimen"). Es decir, es la vía para COMPLETAR la emisión
  // de un código que quedó capturado a medias — justo nuestro caso.
  //
  // (Descargar el documento directo con
  //  documentos/descargar_codigo_alfanumerico.json responde 403: hay que pasar
  //  por este formulario, no hay atajo.)
  if (/capturar datos fiscales/i.test(texto)) {
    console.log("   el panel pide datos fiscales — rellenando para completar la emisión");
    await page.evaluate((f) => {
      const set = (el, v) => {
        if (!el || v == null) return;
        const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        s.call(el, String(v));
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new Event("blur", { bubbles: true }));
      };
      // Los inputs del panel de recuperación son los VISIBLES en este momento:
      // el formulario normal queda oculto detrás.
      const visibles = Array.from(document.querySelectorAll("input")).filter(i => i.offsetParent);
      const porId = (id) => visibles.filter(i => i.id === id).pop();
      set(porId("rfc"), f.rfc);
      set(porId("nombre"), f.razonSocial);
      set(porId("domicilioFiscalReceptor"), String(f.codigoPostal || "").slice(0, 5));
      set(porId("correo"), "buzonfacturas@serviciosga.site");
    }, fiscales);
    await page.waitForTimeout(1500);

    // Régimen y Uso CFDI vuelven a ser p-dropdown de PrimeReact.
    const regimen = String(fiscales.regimenFiscal || "601").match(/\d{3}/)?.[0] || "601";
    const uso = String(fiscales.usoCfdi || "G03").toUpperCase();
    for (const [idx, buscado, etiqueta] of [[0, regimen, "Régimen"], [1, uso, "Uso CFDI"]]) {
      try { await abrirYSeleccionar(page, idx, t => t.toUpperCase().startsWith(buscado), etiqueta); }
      catch (e) { console.log(`   ⚠️ ${etiqueta}: ${e.message}`); }
    }
    await screenshot("p7_recuperacion_fiscales");

    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("button"))
        .find(x => /facturar|emitir|generar|aceptar|continuar/i.test(x.textContent || "") && x.offsetParent);
      if (b) b.click();
    });
    await page.waitForTimeout(8000);
    await screenshot("p8_recuperacion_final");
    texto = await page.evaluate(() => document.body.innerText);
  }

  const respuesta = apiCalls.filter(c => /recuperar|factura|cfdi|descarg|documento/i.test(c.url)).slice(-4);
  for (const r of respuesta) console.log(`   ${r.url.split("/").slice(-1)[0]} → ${(r.body || "(vacío)").slice(0, 200)}`);

  const exito = /[eé]xito|factura.*(generad|emitid)|se ha enviado|correo/i.test(texto);
  return { ok: exito ? true : null, texto: texto.replace(/\s+/g, " ").slice(0, 400), api: respuesta };
}

async function facturarCapufe({
  codigo, // código FACTURACION de 18 caracteres (sin espacios)
  rfc, razonSocial, codigoPostal, regimenFiscal, usoCfdi,
  ticketId,
}) {
  console.log("🤖 Iniciando bot CAPUFE...");
  const codigoLimpio = String(codigo || "").replace(/\s+/g, "").toUpperCase();
  console.log(`   Código: ${codigoLimpio} (${codigoLimpio.length} chars) | RFC: ${rfc}`);
  if (codigoLimpio.length !== 18) {
    return { ok: false, error_code: "datos_invalidos", msg: `CAPUFE: el código FACTURACION debe tener 18 caracteres (tiene ${codigoLimpio.length}): ${codigoLimpio}` };
  }

  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error("BROWSERLESS_TOKEN no definido");
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true`,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");

  const apiCalls = [];
  page.on("response", async (resp) => {
    const url = resp.url();
    if (!/capufe-quadrum-backend/i.test(url)) return;
    let body = null;
    try { body = await resp.text(); } catch {}
    apiCalls.push({ url, status: resp.status(), body });
  });

  const ts = ticketId || Date.now();
  async function screenshot(label) {
    try {
      const buf = await page.screenshot({ fullPage: true });
      const u = await subirArchivoR2(buf, `debug/capufe_${ts}_${label}_${Date.now()}.png`, "image/png");
      console.log(`📸 [${label}]: ${u}`);
    } catch {}
  }

  try {
    console.log("🌐 Cargando portal CAPUFE...");
    await page.goto("https://facturacioncapufe.com.mx/Capufe/facturacionrapida", { waitUntil: "load", timeout: 30000 });
    await page.waitForSelector("#rfc", { timeout: 15000 });
    await screenshot("p1_cargado");

    console.log("📋 RFC...");
    await page.click("#rfc");
    await page.keyboard.type(rfc, { delay: 25 });
    await page.click("#nombre"); // dispara blur → buscar_receptor_por_rfc + catálogos
    await page.waitForTimeout(2500);

    // Si el RFC ya tiene perfil guardado en CAPUFE puede autocompletar nombre —
    // se limpia y se vuelve a escribir con el dato real del ticket para no
    // depender de qué quedó cacheado en su backend.
    await page.evaluate(() => { const el = document.getElementById("nombre"); if (el) el.value = ""; });
    await page.click("#nombre");
    await page.keyboard.type(razonSocial, { delay: 15 });

    await page.click("#domicilioFiscalReceptor");
    await page.keyboard.type(String(codigoPostal || "").slice(0, 5), { delay: 20 });
    await page.click("#correo"); // blur CP
    await page.waitForTimeout(800);
    await screenshot("p2_antes_dropdowns");

    console.log("📋 Régimen Fiscal...");
    const regimenCodigo = String(regimenFiscal || "601").match(/\d{3}/)?.[0] || "601";
    await abrirYSeleccionar(page, 0, t => t.startsWith(regimenCodigo), `Régimen Fiscal ${regimenCodigo}`);

    console.log("📋 Uso CFDI...");
    const usoCodigo = String(usoCfdi || "G03").toUpperCase();
    await abrirYSeleccionar(page, 1, t => t.toUpperCase().startsWith(usoCodigo), `Uso CFDI ${usoCodigo}`);

    console.log("📧 Correo (buzón de captura)...");
    await page.click("#correo");
    await page.keyboard.type("buzonfacturas@serviciosga.site", { delay: 15 });
    await screenshot("p3_fiscales_completos");

    // ⚠️ ANTES DE VALIDAR: mirar si el código YA ESTÁ EN LA LISTA de este RFC.
    //
    // Validar un código lo RESERVA en el backend de CAPUFE. Si un intento
    // anterior validó pero no llegó a "Facturar conceptos", el código queda
    // guardado contra ese RFC y un segundo "Validar" responde "ya se encuentra
    // capturado" — que el bot interpretaba como "ya facturado" y se rendía,
    // dejando el ticket muerto para siempre.
    //
    // Pero NO está perdido: `buscar_tickets.json` lo devuelve en la lista del
    // RFC en cuanto se teclea el RFC. Medido con el ticket #199 de DGA, tras un
    // intento cortado a medias:
    //   [246248584,"GUAYMAS","K8KPKTZBHKSF7WMVHQ",1785594713000,48.00,0,null]
    // O sea: el consumo sigue ahí, pendiente de facturar. Lo único que hay que
    // hacer es NO revalidarlo y saltar directo a emitir.
    const yaEnLista = apiCalls.some(c => /buscar_tickets/i.test(c.url) && (c.body || "").includes(codigoLimpio));

    if (yaEnLista) {
      console.log(`♻️ El código ${codigoLimpio} ya estaba guardado en este RFC — se salta la validación y se factura directo`);
      await screenshot("p4_recuperado_de_lista");
    } else {
      console.log(`📋 Código: ${codigoLimpio}...`);
      await page.click("#codigo");
      await page.keyboard.type(codigoLimpio, { delay: 25 });
      await page.evaluate(() => {
        const b = Array.from(document.querySelectorAll("button")).find(x => /validar c[oó]digo/i.test(x.textContent || ""));
        if (b) b.click();
      });
      await page.waitForTimeout(3500);
      await screenshot("p4_post_validar");
    }

    const textoTrasValidar = await page.evaluate(() => document.body.innerText);

    // Si dice "ya capturado" pero el código NO aparece en la lista de este RFC,
    // es que lo reservó OTRO RFC (o se facturó por otra vía): eso sí es
    // irrecuperable desde aquí.
    if (!yaEnLista && /ya se encuentra capturado/i.test(textoTrasValidar)) {
      // No se da por perdido: el portal tiene una vía propia para estos casos.
      const rescate = await recuperarFacturaPorCodigo(page, codigoLimpio, screenshot, apiCalls, { rfc, razonSocial, codigoPostal, regimenFiscal, usoCfdi });
      await browser.close();
      if (rescate.ok === true) {
        console.log("♻️ Recuperación completada — el CFDI llega por correo (IMAP)");
        return { ok: true, procesandoCorreo: true, _recuperado: true };
      }
      if (rescate.ok === false) {
        return { ok: false, error_code: "ya_facturado", msg: `${rescate.msg} (el código quedó capturado sin completar la emisión)` };
      }
      // La recuperación devolvió algo: se reporta tal cual para decidir a mano.
      // No se inventa un "ok": si hubiera CFDI, llega al buzón y lo recoge IMAP.
      return {
        ok: false,
        error_code: "ya_facturado",
        msg: `CAPUFE: código ${codigoLimpio} capturado; la recuperación respondió: ${(rescate.texto || "").replace(/\s+/g, " ").slice(0, 220)}`,
        _recuperacion: rescate,
      };
    }
    if (/no existe|c[oó]digo inv[aá]lido|no se encontr/i.test(textoTrasValidar) && !/verificado/i.test(textoTrasValidar)) {
      await browser.close();
      return { ok: false, error_code: "datos_invalidos", msg: `CAPUFE: código no reconocido por el portal (${codigoLimpio})` };
    }
    // Si se recuperó de la lista no hay mensaje de "verificado": ese texto solo
    // aparece cuando se acaba de validar. Exigirlo abortaría el rescate.
    if (!yaEnLista && !/verificado y guardado/i.test(textoTrasValidar)) {
      await browser.close();
      return { ok: false, msg: `CAPUFE: respuesta inesperada tras validar código: ${textoTrasValidar.slice(0, 200)}` };
    }
    console.log(yaEnLista ? "✅ Código recuperado de la lista del RFC" : "✅ Código verificado por el portal");

    console.log("🧾 Facturar conceptos (EMISIÓN REAL)...");
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("button")).find(x => /facturar conceptos/i.test(x.textContent || ""));
      if (b) b.click();
    });
    await page.waitForTimeout(6000);
    await screenshot("p5_post_facturar");

    // Buscar en las respuestas de API algo que traiga el CFDI (XML/PDF en base64 o URL)
    const facturarResp = apiCalls.find(c => /facturar|emitir|generar/i.test(c.url) && c.body);
    console.log(`📋 Respuesta facturar: ${facturarResp ? facturarResp.url : "(no capturada)"}`);
    if (facturarResp) console.log(`   Body: ${(facturarResp.body || "").slice(0, 500)}`);

    const textoFinal = await page.evaluate(() => document.body.innerText);
    await browser.close();

    if (/[eé]xito|factura.*(generad|emitid)|se ha enviado/i.test(textoFinal)) {
      console.log("♻️ Factura emitida — se enviará por correo (buzonfacturas) — usando IMAP");
      return { ok: true, procesandoCorreo: true, _debug_api: facturarResp || null };
    }

    return { ok: false, msg: `CAPUFE: no se confirmó éxito tras Facturar conceptos. Texto: ${textoFinal.slice(0, 300)}`, _debug_api: apiCalls };
  } catch (e) {
    console.error("❌ Error en bot CAPUFE:", e.message);
    await screenshot("error").catch(() => {});
    await browser.close().catch(() => {});
    return { ok: false, msg: `CAPUFE: ${e.message}` };
  }
}

module.exports = { facturarCapufe };
