// Enerfuel Tech — factura.enerfueltech.com (plataforma Blazor/MudBlazor
// compartida por varias marcas de gasolineras, ej. Grupo Inmo SA de CV).
//
// Reconocimiento real (2026-07-27, cuenta real GPN, ticket real Grupo Inmo
// SA de CV, Ticket 715245, Referencia 049847152458CE1, $1,000.00):
//   1. "Facturar sin registro" (sin cuenta) → campo único "Referencia"
//      (impreso en el ticket) → "Buscar". Si no hay consumo, el portal
//      responde literalmente "No se encontró el consumo." — NO asumir un
//      límite fijo de horas: se probó un ticket de hace 144h (vencido, "No
//      se encontró") y otro de 72h que SÍ seguía disponible, así que la
//      ventana real no es "24h" como se creía inicialmente — hay que
//      consultar siempre y confiar en la respuesta real del portal, nunca
//      en una regla de tiempo fija.
//   2. "Continuar" revela el panel "Mis datos fiscales": Nombre/RFC/Código
//      Postal son <input> normales; Régimen/Uso CFDI son MudSelect
//      (componentes Blazor) — requieren un click SINTÉTICO REAL de
//      Puppeteer (elementHandle.click(), NO el .click() de JS vía
//      evaluate) para que el popover de opciones abra correctamente.
//   3. El botón FACTURAR se habilita solo cuando los 5 campos obligatorios
//      están completos (Entidad Federativa/Ciudad/Colonia/Calle son
//      opcionales).
//   4. Tras Facturar, la propia página muestra el folio real (ej.
//      "RB-69628") y un campo de correo con botón "Enviar"/"Reenviar" —
//      esa es la única vía de entrega confirmada (no hay descarga directa
//      confiable vía Puppeteer en esta app Blazor/SignalR). Reconsultar la
//      misma Referencia después es idempotente: el portal dice "El consumo
//      ya fue facturado" y muestra el mismo folio sin generar duplicado.
const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");

async function seleccionarPorLabel(page, labelTexto, prefijoOpcion) {
  const selectHandle = await page.evaluateHandle((labelTexto) => {
    const candidatos = Array.from(document.querySelectorAll("*")).filter(el =>
      el.children.length === 0 && el.textContent.trim() === labelTexto
    );
    if (!candidatos.length) return null;
    const lbl = candidatos[candidatos.length - 1];
    const lblRect = lbl.getBoundingClientRect();
    const selects = Array.from(document.querySelectorAll(".mud-select"));
    let mejor = null, mejorDelta = Infinity;
    for (const s of selects) {
      const r = s.getBoundingClientRect();
      const delta = r.top - lblRect.bottom;
      if (delta >= -5 && delta < 40 && Math.abs(r.left - lblRect.left) < 60 && delta < mejorDelta) {
        mejor = s; mejorDelta = delta;
      }
    }
    return mejor;
  }, labelTexto);
  const selectEl = selectHandle.asElement();
  if (!selectEl) throw new Error(`Enerfuel Tech: no se encontró el select "${labelTexto}"`);
  await selectEl.click();
  await page.waitForTimeout(900);
  const optionHandle = await page.evaluateHandle((prefijoOpcion) => {
    return Array.from(document.querySelectorAll(".mud-list-item")).find(el => el.textContent.trim().startsWith(prefijoOpcion)) || null;
  }, prefijoOpcion);
  const optionEl = optionHandle.asElement();
  if (!optionEl) throw new Error(`Enerfuel Tech: no se encontró la opción "${prefijoOpcion}" para "${labelTexto}"`);
  await optionEl.click();
  await page.waitForTimeout(600);
}

async function facturarEnerfuelTech({ referencia, razonSocial, rfc, codigoPostal, regimenFiscal, usoCfdi, ticketId }) {
  console.log("🤖 Iniciando bot Enerfuel Tech...");
  console.log(`   Referencia: ${referencia} | RFC: ${rfc}`);

  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error("BROWSERLESS_TOKEN no definido");
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true`,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on("dialog", async d => { console.log("🔔 Dialog:", d.message()); await d.accept().catch(() => {}); });

  const ts = ticketId || Date.now();
  async function screenshot(label) {
    try {
      const buf = await page.screenshot({ fullPage: true });
      const u = await subirArchivoR2(buf, `debug/enerfueltech_${ts}_${label}_${Date.now()}.png`, "image/png");
      console.log(`📸 [${label}]: ${u}`);
    } catch {}
  }

  try {
    // Se entra DIRECTO al flujo de invitado (/NoUserInvoice) en vez de cargar
    // la portada y buscar el botón "Facturar sin registro": ese click a veces no
    // encontraba el botón y el portal terminaba mandando a la pantalla de login
    // justo al pulsar FACTURAR, tirando el intento a la basura (ticket #336).
    await page.goto("https://factura.enerfueltech.com/NoUserInvoice", { waitUntil: "networkidle2", timeout: 30000 });
    await page.waitForTimeout(2500);
    // Por si la ruta directa redirige a la portada, se conserva el camino viejo.
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("button, a")).find(x => /facturar sin registro/i.test(x.textContent || ""));
      if (b) b.click();
    });
    await page.waitForTimeout(2000);

    const inputsVisibles = await page.$$('input[type="text"]');
    const refField = inputsVisibles[inputsVisibles.length - 1];
    await refField.click({ clickCount: 3 });
    await page.keyboard.type(String(referencia), { delay: 30 });
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("button")).find(x => x.textContent.trim() === "Buscar");
      if (b) b.click();
    });
    await page.waitForTimeout(2500);
    await screenshot("p1_post_buscar");

    let texto = await page.evaluate(() => document.body.innerText);
    if (/no se encontr[oó] el consumo/i.test(texto)) {
      await browser.close();
      return { ok: false, error_code: "datos_invalidos", msg: `Enerfuel Tech: no se encontró el consumo para la referencia ${referencia} (ticket vencido o ya facturado a público en general)` };
    }
    // "El consumo no es facturable" — mensaje DISTINTO al de arriba, visto en
    // vivo en el ticket #324. El portal deja el panel "Mis datos fiscales" con
    // los campos deshabilitados (ni siquiera son <input> reales mientras tanto),
    // así que sin este chequeo el bot seguía adelante y moría con "Cannot read
    // properties of null (reading 'click')" al buscar esos campos.
    if (/consumo no es facturable/i.test(texto)) {
      await browser.close();
      return { ok: false, error_code: "datos_invalidos", msg: `Enerfuel Tech: el portal dice que el consumo de la referencia ${referencia} NO es facturable (fuera de plazo, ya facturado a público en general, o dato incorrecto).` };
    }

    const yaFacturado = /facturado/i.test(texto) && /100 ?%/i.test(texto);
    if (!yaFacturado) {
      await page.evaluate(() => {
        const b = Array.from(document.querySelectorAll("button")).find(x => x.textContent.trim() === "Continuar");
        if (b) b.click();
      });
      await page.waitForTimeout(1500);

      const panelHandle = await page.evaluateHandle(() => {
        const heading = Array.from(document.querySelectorAll("*")).find(el => el.children.length === 0 && el.textContent.trim() === "Mis datos fiscales");
        return heading ? heading.closest(".mud-paper") || heading.parentElement.parentElement : null;
      });
      const panelEl = panelHandle.asElement();
      if (!panelEl) {
        await screenshot("sin_panel_datos_fiscales");
        throw new Error('Enerfuel Tech: no se encontró el panel "Mis datos fiscales" tras Continuar');
      }
      const nombreInput = (await panelHandle.evaluateHandle(panel => panel.querySelectorAll('input[type="text"]')[0])).asElement();
      const rfcInput = (await panelHandle.evaluateHandle(panel => panel.querySelectorAll('input[type="text"]')[1])).asElement();
      const cpInput = (await panelHandle.evaluateHandle(panel => panel.querySelectorAll('input[type="text"]')[2])).asElement();
      if (!nombreInput || !rfcInput || !cpInput) {
        await screenshot("faltan_inputs_datos_fiscales");
        const nInputs = await panelHandle.evaluate(panel => panel.querySelectorAll('input[type="text"]').length).catch(() => -1);
        throw new Error(`Enerfuel Tech: el panel "Mis datos fiscales" solo trae ${nInputs} input(s) de texto visibles — se esperaban 3 (nombre, RFC, CP). El portal pudo haber cambiado el formulario, o ya traía algún dato prellenado.`);
      }

      await nombreInput.click({ clickCount: 3 });
      await page.keyboard.type(razonSocial, { delay: 20 });
      await page.waitForTimeout(200);
      await rfcInput.click({ clickCount: 3 });
      await page.keyboard.type(rfc, { delay: 20 });
      await page.waitForTimeout(600);
      await cpInput.click({ clickCount: 3 });
      await page.keyboard.type(String(codigoPostal || "").slice(0, 5), { delay: 20 });
      await page.waitForTimeout(400);

      const regimenCodigo = String(regimenFiscal || "601").match(/\d{3}/)?.[0] || "601";
      const usoCodigo = String(usoCfdi || "G03").toUpperCase();
      await seleccionarPorLabel(page, "Régimen", regimenCodigo);
      await seleccionarPorLabel(page, "Uso CFDI", usoCodigo);
      await screenshot("p2_form_listo");

      // ⚠️ La comparación exacta `textContent.trim() === "FACTURAR"` fallaba con
      // el botón A LA VISTA y habilitado (capturas de #262 y #265 del
      // 15/08/2026): es un botón de Angular Material y su textContent trae el
      // rótulo dentro de un <span> junto a nodos de ripple, con espacios duros.
      // Se normaliza el texto y se espera un poco, que el panel fiscal termina
      // de montarse después de elegir el Uso CFDI.
      let facturarEl = null;
      for (let i = 0; i < 10 && !facturarEl; i++) {
        const h = await page.evaluateHandle(() => {
          const norm = (s) => (s || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim().toUpperCase();
          return Array.from(document.querySelectorAll("button, a[role=button]"))
            .find((x) => norm(x.textContent) === "FACTURAR" && x.offsetParent !== null && !x.disabled) || null;
        });
        facturarEl = h.asElement();
        if (!facturarEl) await page.waitForTimeout(1000);
      }
      if (!facturarEl) {
        const botones = await page.evaluate(() =>
          Array.from(document.querySelectorAll("button"))
            .filter((b) => b.offsetParent !== null)
            .map((b) => `"${b.textContent.replace(/\s+/g, " ").trim()}"${b.disabled ? " (deshabilitado)" : ""}`));
        throw new Error(`Enerfuel Tech: botón FACTURAR no disponible. Botones visibles: ${botones.join(", ")}`);
      }

      console.log("🧾 Click FACTURAR (emisión real)...");
      await facturarEl.click();
      await page.waitForTimeout(5000);
      await screenshot("p3_post_facturar");

      texto = await page.evaluate(() => document.body.innerText);
      if (!/factura generada/i.test(texto)) {
        await browser.close();
        return { ok: false, msg: `Enerfuel Tech: no se confirmó "Factura generada" tras Facturar. Texto: ${texto.slice(0, 300)}` };
      }
    } else {
      console.log("♻️ El consumo ya aparece facturado — reenviando por correo (idempotente)");
    }

    console.log("📧 Enviando por correo al buzón de captura...");
    const inputsFinal = await page.$$('input[type="text"]');
    const correoEl = inputsFinal[inputsFinal.length - 1];
    if (!correoEl) throw new Error("Enerfuel Tech: no se encontró el campo de correo tras facturar");
    await correoEl.click({ clickCount: 3 });
    await page.keyboard.type("buzonfacturas@serviciosga.site", { delay: 20 });
    await page.waitForTimeout(400);

    const enviarHandle = await page.evaluateHandle(() =>
      Array.from(document.querySelectorAll("button")).find(x => /^(enviar|reenviar)$/i.test(x.textContent.trim())) || null
    );
    const enviarEl = enviarHandle.asElement();
    if (!enviarEl) throw new Error("Enerfuel Tech: no se encontró el botón Enviar/Reenviar");
    await enviarEl.click();
    await page.waitForTimeout(3000);
    await screenshot("p4_post_enviar");

    await browser.close();
    return { ok: true, procesandoCorreo: true };

  } catch (err) {
    console.error("❌ Error en bot Enerfuel Tech:", err.message);
    await screenshot("error").catch(() => {});
    await browser.close().catch(() => {});
    return { ok: false, msg: `Enerfuel Tech: ${err.message}` };
  }
}

module.exports = { facturarEnerfuelTech };
