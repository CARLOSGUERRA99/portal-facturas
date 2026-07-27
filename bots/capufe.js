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

    console.log(`📋 Código: ${codigoLimpio}...`);
    await page.click("#codigo");
    await page.keyboard.type(codigoLimpio, { delay: 25 });
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("button")).find(x => /validar c[oó]digo/i.test(x.textContent || ""));
      if (b) b.click();
    });
    await page.waitForTimeout(3500);
    await screenshot("p4_post_validar");

    const textoTrasValidar = await page.evaluate(() => document.body.innerText);
    if (/ya se encuentra capturado/i.test(textoTrasValidar)) {
      await browser.close();
      return { ok: false, error_code: "ya_facturado", msg: `CAPUFE: el código ${codigoLimpio} ya está capturado en el sistema de CAPUFE (validación previa no completada, o ya facturado por otra vía) — usa "Recuperar factura por código" para confirmar` };
    }
    if (/no existe|c[oó]digo inv[aá]lido|no se encontr/i.test(textoTrasValidar) && !/verificado/i.test(textoTrasValidar)) {
      await browser.close();
      return { ok: false, error_code: "datos_invalidos", msg: `CAPUFE: código no reconocido por el portal (${codigoLimpio})` };
    }
    if (!/verificado y guardado/i.test(textoTrasValidar)) {
      await browser.close();
      return { ok: false, msg: `CAPUFE: respuesta inesperada tras validar código: ${textoTrasValidar.slice(0, 200)}` };
    }
    console.log("✅ Código verificado por el portal");

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
