// FacturaGAS / ControlGAS — app.facturagas.net (plataforma de ATIO Group,
// rentada por muchas gasolineras chicas). El ticket imprime una URL propia
// del negocio (ej. "sumeca.ddns.net:83/ControlGASFE" o similar DDNS) pero
// esa URL suele estar mal transcrita/impresa (el ticket real de esta prueba
// decía "umeca.ddns.net" — SIN LA S — y no resolvía; el backend real de
// app.facturagas.net devolvió "sumeca.ddns.net", con S). No usar la URL
// impresa en el ticket para navegar — usar SIEMPRE app.facturagas.net.
//
// Reconocimiento real (2026-07-27, cuenta real GPN, ticket real Suministros
// Energéticos de Calidad E12183, Folio 2025730, WebID 60844255, $1,500.00):
//   1. app.facturagas.net → "Facturación sin Usuario" (sin cuenta/login) →
//      generar_factura.aspx.
//   2. Estación: input con autocomplete (#rstation_Input, RadComboBox
//      Telerik) — escribir el nombre del comercio y hacer click en el <li>
//      real de la lista (no basta con seleccionar por teclado).
//   3. Folio (#despacho) + WebID (#webId) → "Consultar Ticket" (#btnSerchTk)
//      → si son correctos aparece "Ticket validado correctamente" con
//      Monto/Fecha reales para cruzar contra el ticket.
//   4. RFC (#inputRfc2) + botón "Agregar" (el que está PEGADO al campo RFC,
//      no el de más abajo) — CRÍTICO: los campos Nombre/Correo/CP/Régimen/
//      Uso CFDI están INERTES (no aceptan texto) hasta que este "Agregar"
//      del RFC se presiona. Llenarlos antes no tiene efecto y solo dispara
//      la validación "Complete los campos marcados con (*)".
//   5. Tras Agregar: #inputRazon, #inputCorreo, #inputCp (sin autofill —
//      cuenta nueva para este RFC en esta plataforma), #cmbRegimen y
//      #cmbUsos son <select> nativos normales (a diferencia de otros
//      portales de esta tanda, aquí SÍ son selects reales).
//   6. "Generar Factura" — la respuesta tarda más de 5s ("Consultando,
//      espere..."); NO asumir fallo solo porque no se capturó la respuesta
//      de red a tiempo. La forma confiable de confirmar es re-consultar el
//      mismo Folio/WebID: si ya está facturado, el propio "Consultar
//      Ticket" lo dice ("Folio ... ya ha sido facturado.") de forma
//      idempotente (no genera un duplicado ni truena).
//   7. Entrega: por CORREO real al buzón de captura (verificado: llega
//      "Ha recibido un CFDI (FACTURA) para ..." con XML+PDF adjuntos
//      reales) — no hay descarga directa confiable desde la UI de
//      app.facturagas.net ni desde el portal legado sumeca.ddns.net/
//      controlgasfe (que además pide un "Código Cliente" propio que no es
//      ninguno de los datos impresos en el ticket).
//
// ⚠️ OJO — NO todas las estaciones "ControlGasFE" están en app.facturagas.net.
// Varias corren su PROPIA instancia en un DDNS del negocio y no aparecen en el
// autocomplete de estaciones del portal central. Comprobado con la estación
// P22904 "LA SUERTE" (Inmobiliaria Hemajo de Atlacomulco), que factura en
// http://hemajolasuerte.ddns.net:8087/ControlGasFE/ — ese portal pide los
// mismos tres datos (Estación / Folio / Web ID) pero es otro sitio.
//
// Y lo más importante para el negocio: esas instancias propias avisan
// "Solo se pueden facturar notas máximo 72 HORAS posteriores a haber sido
// realizadas". Es una ventana mucho más corta que los 30 días habituales, así
// que un ticket de este tipo hay que subirlo y facturarlo el mismo día.
const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");

async function facturarFacturaGAS({ estacionNombre, folio, webId, rfc, razonSocial, codigoPostal, regimenFiscal, usoCfdi, ticketId }) {
  // ⚠️ Comprobar ANTES de abrir el navegador. Sin esto, un estacionNombre
  // undefined llegaba hasta page.keyboard.type() y reventaba con
  // "text is not iterable" — un mensaje que no dice nada, tras gastar una
  // sesión de Browserless. Pasó con los tickets #241 y #257: facturagas tenía
  // bot pero NO prompt de OCR, así que caían en el genérico y llegaban sin
  // estación ni webId.
  const faltan = [];
  if (!String(estacionNombre || "").trim()) faltan.push("nombre de la estación (el portal la busca por autocompletado)");
  if (!String(folio || "").trim()) faltan.push("folio/despacho");
  if (!String(webId || "").trim()) faltan.push("WebID");
  if (faltan.length) {
    return { ok: false, error_code: "datos_invalidos", msg: `FacturaGAS: faltan datos del ticket — ${faltan.join(", ")}` };
  }

  console.log("🤖 Iniciando bot FacturaGAS...");
  console.log(`   Estación: ${estacionNombre} | Folio: ${folio} | WebID: ${webId} | RFC: ${rfc}`);

  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error("BROWSERLESS_TOKEN no definido");
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true`,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1000 });
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");
  page.on("dialog", async d => { console.log("🔔 Dialog:", d.message()); await d.accept().catch(() => {}); });

  const ts = ticketId || Date.now();
  async function screenshot(label) {
    try {
      const buf = await page.screenshot({ fullPage: true });
      const u = await subirArchivoR2(buf, `debug/facturagas_${ts}_${label}_${Date.now()}.png`, "image/png");
      console.log(`📸 [${label}]: ${u}`);
    } catch {}
  }

  async function consultarTicket() {
    await page.goto("https://app.facturagas.net/generar_factura.aspx", { waitUntil: "load", timeout: 30000 });
    await page.waitForSelector("#rstation_Input", { timeout: 15000 });
    // El autocompletado no lista la estación con el mismo texto que la imprime
    // el ticket. Buscando "E12430 - FRESNO" entero no encontraba nada, aunque
    // la estación exista (tickets #241 y #257). Se prueba de más específico a
    // menos: la cadena completa, luego solo la clave (E12430) y luego solo el
    // nombre (FRESNO). El primero que devuelva opciones, gana.
    const partes = [];
    const limpio = String(estacionNombre).trim();
    partes.push(limpio);
    const m = limpio.match(/^\s*([A-Z]?\d{3,6})\s*[-–]\s*(.+)$/i);
    if (m) { partes.push(m[1].trim()); partes.push(m[2].trim()); }

    let seleccionado = false, vistas = [];
    for (const intento of [...new Set(partes)].filter(Boolean)) {
      await page.click("#rstation_Input", { clickCount: 3 });
      await page.keyboard.press("Backspace");
      await page.keyboard.type(intento, { delay: 25 });
      await page.waitForTimeout(2000);
      const r = await page.evaluate((nombre) => {
        const items = Array.from(document.querySelectorAll("li, .dx-item, [role=\"option\"]"))
          .filter(i => i.offsetParent !== null && (i.textContent || "").trim());
        const norm = (s) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
        const buscado = norm(nombre);
        const el = items.find(i => norm(i.textContent).includes(buscado) || buscado.includes(norm(i.textContent)));
        if (el) { el.click(); return { ok: true, texto: el.textContent.trim() }; }
        return { ok: false, opciones: items.map(i => i.textContent.trim().slice(0, 40)).slice(0, 12) };
      }, intento);
      if (r.ok) { console.log(`   estación: "${intento}" → ${r.texto}`); seleccionado = true; break; }
      vistas = r.opciones;
      console.log(`   ⤳ "${intento}" no casó (${vistas.length} opciones en pantalla)`);
    }
    // Si falla, se dice QUÉ ofrecía el portal: sin eso el siguiente intento es
    // otra adivinanza.
    if (!seleccionado) throw new Error(`FacturaGAS: la estación "${estacionNombre}" no aparece en el autocomplete. Se probó con "${[...new Set(partes)].join('", "')}". Lo que ofrecía el portal: ${vistas.length ? vistas.join(" | ") : "(ninguna opción)"}`);
    await page.waitForTimeout(1000);

    await page.click("#despacho"); await page.keyboard.type(String(folio), { delay: 20 });
    await page.click("#webId"); await page.keyboard.type(String(webId), { delay: 20 });
    await page.click("#btnSerchTk");
    await page.waitForTimeout(3000);
    return page.evaluate(() => document.body.innerText);
  }

  try {
    console.log("🌐 Consultando ticket...");
    let texto = await consultarTicket();
    await screenshot("p1_post_consultar");

    if (/ya ha sido facturado/i.test(texto)) {
      console.log("♻️ Folio ya facturado anteriormente — la factura real ya se envió por correo (IMAP la recogerá)");
      await browser.close();
      return { ok: true, procesandoCorreo: true };
    }
    if (/no se encontr[oó]|folio inv[aá]lido|datos incorrectos/i.test(texto)) {
      await browser.close();
      return { ok: false, error_code: "datos_invalidos", msg: `FacturaGAS: ticket no reconocido (folio ${folio}, webId ${webId})` };
    }
    if (!/Ticket validado correctamente/i.test(texto)) {
      await browser.close();
      return { ok: false, msg: `FacturaGAS: no se validó el ticket. Texto: ${texto.slice(0, 200)}` };
    }
    console.log("✅ Ticket validado correctamente");

    console.log("📋 RFC + Agregar...");
    await page.click("#inputRfc2");
    await page.keyboard.type(rfc, { delay: 25 });
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("button, a, input[type=button]")).find(x => /^agregar$/i.test((x.textContent || x.value || "").trim()));
      if (b) b.click();
    });
    await page.waitForTimeout(2000);
    await screenshot("p2_post_agregar_rfc");

    console.log("📋 Datos fiscales...");
    await page.click("#inputRazon"); await page.keyboard.type(razonSocial, { delay: 12 });
    await page.click("#inputCorreo"); await page.keyboard.type("buzonfacturas@serviciosga.site", { delay: 12 });
    await page.click("#inputCp"); await page.keyboard.type(String(codigoPostal || "").slice(0, 5), { delay: 15 });

    const regimenCodigo = String(regimenFiscal || "601").match(/\d{3}/)?.[0] || "601";
    const regimenOk = await page.evaluate((cod) => {
      const sel = document.getElementById("cmbRegimen");
      if (!sel) return false;
      const opt = Array.from(sel.options).find(o => o.text.startsWith(cod));
      if (!opt) return false;
      sel.value = opt.value;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }, regimenCodigo);
    if (!regimenOk) throw new Error(`FacturaGAS: no se encontró el régimen fiscal ${regimenCodigo}`);
    await page.waitForTimeout(500);

    const usoCodigo = String(usoCfdi || "G03").toUpperCase();
    const usoOk = await page.evaluate((cod) => {
      const sel = document.getElementById("cmbUsos");
      if (!sel) return false;
      const opt = Array.from(sel.options).find(o => o.text.toUpperCase().startsWith(cod));
      if (!opt) return false;
      sel.value = opt.value;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }, usoCodigo);
    if (!usoOk) throw new Error(`FacturaGAS: no se encontró el uso CFDI ${usoCodigo}`);
    await page.waitForTimeout(500);
    await screenshot("p3_form_listo");

    console.log("🧾 Click Generar Factura (emisión real)...");
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("button, a")).find(x => /^generar factura$/i.test((x.textContent || "").trim()));
      if (b) b.click();
    });
    // La confirmación server-side puede tardar más que un timeout corto —
    // en vez de esperar la respuesta de red, se re-consulta el mismo folio
    // (idempotente: si ya quedó facturado, "Consultar Ticket" lo confirma
    // sin generar un duplicado).
    await page.waitForTimeout(8000);
    await screenshot("p4_post_generar");

    console.log("🔁 Re-consultando para confirmar...");
    const textoConfirm = await consultarTicket();
    await screenshot("p5_confirmacion");

    await browser.close();

    if (/ya ha sido facturado/i.test(textoConfirm)) {
      console.log("✅ FacturaGAS — factura real confirmada, se envía por correo (IMAP la recogerá)");
      return { ok: true, procesandoCorreo: true };
    }
    return { ok: false, msg: `FacturaGAS: no se pudo confirmar la emisión tras Generar Factura. Texto: ${textoConfirm.slice(0, 300)}` };

  } catch (err) {
    console.error("❌ Error en bot FacturaGAS:", err.message);
    await screenshot("error").catch(() => {});
    await browser.close().catch(() => {});
    return { ok: false, msg: `FacturaGAS: ${err.message}` };
  }
}

module.exports = { facturarFacturaGAS };
