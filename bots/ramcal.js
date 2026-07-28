// RAMCAL — corporativoramcal.mx (grupo de gasolineras en Manzanillo/GDL,
// plataforma "Kernotek" por estación: {url-propia-por-estación}/bajatufactura/).
//
// Reconocimiento real (2026-07-27, cuenta real GPN, ticket real estación
// E07932 "Ramcal Autopista Manzanillo Colima", Transacción 0201801651,
// Código impreso "01292742361", $1,330.20):
//   1. La página de facturación del sitio corporativo (corporativoramcal.mx
//      /facturacion/) NO tiene formulario — solo lista las estaciones y un
//      botón por cada una que lleva a su propio subdominio/URL
//      "{host-de-la-estación}/bajatufactura/". Ese mapeo estación→URL debe
//      resolverse ahí (no está impreso en el ticket, solo la clave de
//      estación tipo "E07932").
//   2. En "{url-estación}/bajatufactura/": "Generación de Factura" → RFC →
//      Aceptar. IMPORTANTE: contra la suposición inicial de que Ramcal
//      siempre requiere alta manual por correo, la búsqueda por RFC SÍ
//      encuentra clientes ya dados de alta (probado con GPN, que ya
//      estaba registrado) — solo hace falta el alta manual cuando el RFC
//      no aparece en "CLIENTES ENCONTRADOS".
//   3. "Seleccionar" el cliente → pantalla de Facturación con los datos
//      fiscales guardados. OJO: esos datos pueden estar desactualizados
//      (en la prueba real, el domicilio guardado tenía un CP y estado
//      totalmente distintos a la Constancia de Situación Fiscal real —
//      "SONORA C.P. 85080" en vez de "SINALOA C.P. 80140" — lo cual
//      hubiera causado el mismo tipo de rechazo SAT que CFDI40147/
//      DomicilioFiscalReceptor). Por eso este bot SIEMPRE pasa por
//      "Editar Datos" y sobreescribe calle/número/colonia/municipio/
//      estado/CP con los valores reales recibidos, en vez de confiar en
//      lo que el portal ya tenga guardado.
//   4. El "Código" (impreso en el ticket, ej. "01292742361" — DISTINTO de
//      la "Transacción") identifica el consumo — se invalida tras usarse
//      una vez ("Código inválido, verifique con la estación" en un
//      reintento), así que no es idempotente para reconsulta: si ya se
//      facturó, hay que buscarla por "Descargar Factura" → "Por Factura"
//      (con el folio real, ej. "P275856"), NO reintentando el código.
//   5. "Cuenta de pago (4 últimos dígitos)" viene del comprobante bancario
//      (no del ticket de la gasolinera) — en la prueba real, el vale de
//      Banorte/BBVA que acompaña al ticket. Uso CFDI ya trae "GASTOS EN
//      GENERAL" por default.
//   6. Tras "Facturar" se genera el folio real y aparece un botón
//      "Descargar" directo en esa MISMA pantalla — pero si se necesita
//      recuperar después (nueva sesión), solo queda la vía "Descargar
//      Factura → Por Factura → Enviar Correo" (con el correo de captura).
const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");

async function facturarRAMCAL({
  urlEstacion, rfc, razonSocial, codigo, cuentaPagoUlt4,
  calle, noExterior, noInterior, colonia, municipio, estado, codigoPostal,
  ticketId,
}) {
  console.log("🤖 Iniciando bot RAMCAL...");
  console.log(`   Estación: ${urlEstacion} | Código: ${codigo} | RFC: ${rfc}`);

  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error("BROWSERLESS_TOKEN no definido");
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true`,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1000 });
  page.on("dialog", async d => { console.log("🔔 Dialog:", d.message()); await d.accept().catch(() => {}); });

  const ts = ticketId || Date.now();
  async function screenshot(label) {
    try {
      const buf = await page.screenshot({ fullPage: true });
      const u = await subirArchivoR2(buf, `debug/ramcal_${ts}_${label}_${Date.now()}.png`, "image/png");
      console.log(`📸 [${label}]: ${u}`);
    } catch {}
  }

  try {
    await page.goto(`${urlEstacion.replace(/\/$/, "")}/bajatufactura/`, { waitUntil: "networkidle2", timeout: 25000 });
    await page.waitForTimeout(1500);
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("input,button")).find(x => /generaci[oó]n de factura$/i.test((x.value || x.textContent || "").trim()));
      if (b) b.click();
    });
    await page.waitForTimeout(1200);
    await page.click("#rfc");
    await page.keyboard.type(rfc, { delay: 25 });
    await page.waitForTimeout(300);
    await page.click('input[name="btn_submit_codigo"]');
    await page.waitForTimeout(2000);

    let texto = await page.evaluate(() => document.body.innerText);
    if (!/clientes encontrados/i.test(texto)) {
      await browser.close();
      return { ok: false, error_code: "datos_invalidos", msg: `RAMCAL: RFC ${rfc} no está dado de alta en esta estación — requiere registro manual (foto de ticket + CSF a facturacion@corporativoramcal.mx)` };
    }
    console.log("✅ Cliente encontrado — RFC ya dado de alta");

    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("input,button,a")).find(x => /seleccionar/i.test((x.value || x.textContent || "").trim()));
      if (b) b.click();
    });
    await page.waitForTimeout(2000);

    console.log("📋 Corrigiendo domicilio fiscal (siempre, para no confiar en datos guardados desactualizados)...");
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("input,button,a")).find(x => /editar datos/i.test((x.value || x.textContent || "").trim()));
      if (b) b.click();
    });
    await page.waitForTimeout(2000);

    async function setVal(name, valor) {
      if (!valor) return;
      const el = await page.$(`input[name="${name}"]`);
      if (!el) return;
      await el.click({ clickCount: 3 });
      await page.keyboard.type(String(valor), { delay: 12 });
    }
    await setVal("calle", calle);
    await setVal("noexterior", noExterior);
    await setVal("nointerior", noInterior);
    await setVal("colonia", colonia);
    await setVal("municipio", municipio);
    await setVal("estado", estado);
    await setVal("cp", codigoPostal);
    await page.waitForTimeout(300);
    await screenshot("p1_datos_editados");
    await page.click("#btn_cli_actualizar");
    await page.waitForTimeout(2500);

    console.log(`🔢 Código del ticket: ${codigo}...`);
    const codigoInput = await page.$('input[name="codigo[]"]');
    await codigoInput.click();
    await page.keyboard.type(String(codigo), { delay: 25 });
    await page.waitForTimeout(300);
    await page.click('input[name="btn_submit_nf"]');
    await page.waitForTimeout(2500);
    await screenshot("p2_consumo");

    texto = await page.evaluate(() => document.body.innerText);
    if (/c[oó]digo inv[aá]lido/i.test(texto)) {
      await browser.close();
      return { ok: false, error_code: "datos_invalidos", msg: `RAMCAL: código "${codigo}" inválido (ya usado o incorrecto) — verificar con la estación` };
    }
    if (!/cuenta de pago/i.test(texto)) {
      await browser.close();
      return { ok: false, msg: `RAMCAL: no se llegó a la pantalla de facturación. Texto: ${texto.slice(0, 300)}` };
    }

    console.log(`💳 Cuenta de pago (últimos 4 dígitos): ${cuentaPagoUlt4}...`);
    await page.click('input[name="cuentapago"]');
    await page.keyboard.type(String(cuentaPagoUlt4), { delay: 25 });
    await page.waitForTimeout(300);
    await screenshot("p3_listo_para_facturar");

    console.log("🧾 Click Facturar (emisión real)...");
    await page.click("#btn_facturar");
    await page.waitForTimeout(5000);
    await screenshot("p4_post_facturar");

    texto = await page.evaluate(() => document.body.innerText);
    const folioMatch = texto.match(/Factura:\s*\n?\s*([A-Z]?\d+)/i);
    if (!folioMatch) {
      await browser.close();
      return { ok: false, msg: `RAMCAL: no se confirmó folio de factura tras Facturar. Texto: ${texto.slice(0, 300)}` };
    }
    const folio = folioMatch[1];
    console.log(`✅ Factura generada: ${folio}`);

    // El botón "Descargar" en esta misma pantalla no entrega un archivo
    // confiable vía Puppeteer (probado: solo navega a una URL con hash JWT
    // sin content-type de archivo). La vía confirmada es recargar el menú
    // principal → "Descargar Factura" → "Por Factura" (con el folio recién
    // generado) → "Enviar Correo" al buzón de captura — el mismo camino que
    // usa cualquier factura ya existente, así que también sirve como
    // recuperación idempotente si este bot se reintenta.
    console.log("📧 Recuperando y enviando por correo al buzón de captura...");
    await page.goto(`${urlEstacion.replace(/\/$/, "")}/bajatufactura/`, { waitUntil: "networkidle2", timeout: 25000 });
    await page.waitForTimeout(1500);
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("input,button")).find(x => /^descargar factura$/i.test((x.value || x.textContent || "").trim()));
      if (b) b.click();
    });
    await page.waitForTimeout(1200);
    await page.click("#btn_nf");
    await page.waitForTimeout(1200);
    await page.click('input[name="factura"]');
    await page.keyboard.type(folio, { delay: 25 });
    await page.waitForTimeout(300);
    await page.click('input[name="btn_submit_nf"]');
    await page.waitForTimeout(2000);
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("input,button,a")).find(x => /enviar correo/i.test((x.value || x.textContent || "").trim()));
      if (b) b.click();
    });
    await page.waitForTimeout(1500);

    const emailInput = await page.$("#email");
    if (!emailInput) throw new Error("RAMCAL: no se encontró el campo de correo tras Facturar");
    await emailInput.click({ clickCount: 3 });
    await page.keyboard.type("buzonfacturas@serviciosga.site", { delay: 20 });
    await page.waitForTimeout(300);
    await page.click("#ev_cr");
    await page.waitForTimeout(3000);
    await screenshot("p5_correo_enviado");

    await browser.close();
    return { ok: true, procesandoCorreo: true };

  } catch (err) {
    console.error("❌ Error en bot RAMCAL:", err.message);
    await screenshot("error").catch(() => {});
    await browser.close().catch(() => {});
    return { ok: false, msg: `RAMCAL: ${err.message}` };
  }
}

module.exports = { facturarRAMCAL };
