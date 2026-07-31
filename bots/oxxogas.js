// OXXO GAS — facturacion.oxxogas.com
//
// ══════════════════════════════════════════════════════════════════════════
// ⚠️ ES UNA SPA: HAY QUE ENTRAR SIEMPRE POR LA HOME. Medido el 2026-07-31.
//
//   `https://facturacion.oxxogas.com/` es una single-page app: la URL NUNCA
//   cambia, ni al entrar a Facturar ni a Mis Facturas. Todas las pantallas se
//   pintan por JavaScript sobre la misma ruta.
//
//   👉 Navegar DIRECTO a /facturacion/facturar devuelve un HTML degradado, sin
//      una sola etiqueta <script src> (jQuery, Chosen y Angular ausentes).
//      Eso hace que #regimen_fiscal y #usocfdi nunca se pueblen y que el clic
//      en "Agregar Ticket" no dispare ninguna petición — el botón no tiene
//      handler porque no hay JS. Ese falso síntoma se atribuyó por error a un
//      bloqueo del WAF y a rate-limiting; no era ni lo uno ni lo otro.
//
//   Entrando por la home y pulsando el enlace "ACCEDER A FACTURAR", el portal
//   carga completo y verificado: 29 scripts, jQuery=true, Chosen=true, 5
//   contenedores .chosen-container en el DOM, #estacion con 584 opciones. Y al
//   elegir el RFC con page.select() los dependientes se pueblan solos
//   (#regimen_fiscal 0→9 opciones, #usocfdi 0→4), así que el <select> nativo
//   SÍ notifica correctamente pese a la decoración de Chosen.
//
//   Corolario para cualquier bot futuro de este portal: nunca hacer deep link,
//   siempre home + clic. Y comprobar que los selects dependientes se poblaron
//   antes de seguir (page.select() no lanza error si la opción no existe: deja
//   el campo vacío EN SILENCIO y el fallo aparece mucho después).
//
//   Presupuesto: Browserless corta la sesión a los 60 s exactos en este plan y
//   rechaza con HTTP 400 cualquier &timeout=. Por eso el flujo se parte en dos:
//   emitir dentro del navegador, y recuperar el XML/PDF después con fetch()
//   autenticado por la misma cookie (no hace falta navegador para eso).
// ══════════════════════════════════════════════════════════════════════════
//
// ⚠️ ESTE BOT NO ES AUTÓNOMO. Requiere una cookie de sesión ya
// autenticada MANUALMENTE por el usuario (ver más abajo). NO intenta
// resolver el reCAPTCHA v2 del login bajo ninguna circunstancia — esa
// regla es absoluta e innegociable en este proyecto. La única forma de
// operar este bot es:
//   1. El usuario inicia sesión a mano en facturacion.oxxogas.com en un
//      navegador real, resolviendo el reCAPTCHA él mismo.
//   2. Copia el valor de la cookie `ci_sessions` (DevTools → Application
//      → Cookies → facturacion.oxxogas.com) y, si existen, las cookies
//      `incap_ses_*_3020163` / `visid_incap_3020163` (capa Incapsula/WAF).
//   3. Esas cookies se pasan como variables de entorno
//      OXXOGAS_CI_SESSION / OXXOGAS_INCAP_SES_117 / OXXOGAS_INCAP_SES_363
//      / OXXOGAS_VISID_INCAP al invocar este bot — NUNCA hardcodeadas en
//      código ni guardadas en .env (son credenciales de sesión reales).
//   4. La sesión expira / se invalida con el tiempo (no confirmado cuánto
//      dura) — hay que repetir el proceso periódicamente.
//
// Reconocimiento y verificación real (2026-07-28, cuenta real GPN,
// ticket real Estación Galerías BJX León, Folio 7540670, $800.00):
//   - Con la cookie `ci_sessions` inyectada (CodeIgniter — el servidor
//     ya la emite incluso sin login, y el login solo la marca como
//     autenticada), el dashboard carga completo sin volver a pedir el
//     reCAPTCHA. La capa Incapsula (WAF) NO rechazó las requests desde
//     el servidor de automatización pese a venir de una IP distinta a
//     la del usuario.
//   - El formulario de Facturación (RFC → Régimen → Uso CFDI → Estación
//     → Folio → Monto → "Agregar Ticket" → Forma de Pago → "Facturar
//     Tickets") NO tiene CAPTCHA en ningún punto — solo el login lo
//     tiene.
//   - "Estación / Gasolinera" y "Seleccione los RFCs" son <select>
//     decorados con la librería "Chosen" (jQuery) — para esos SÍ hace
//     falta simular apertura+opción, pero en la práctica `page.select()`
//     nativo de Puppeteer funciona bien porque el <select> real sigue
//     presente en el DOM (solo oculto visualmente).
//   - CRÍTICO: el <select> "Forma de Pago" que aparece en cada fila de
//     "Tickets a Facturar" (tras Agregar Ticket) es un <select> nativo
//     SIN decoración Chosen, y además SIN atributo `id` (solo `name`,
//     con un sufijo numérico aleatorio por fila, ej.
//     "tipopago_996633") — hay que ubicarlo por `name`, no por `id`, y
//     usar `page.select('select[name="..."]', valor)` directo.
//   - Tras seleccionar la Forma de Pago, ese <select> puede desaparecer
//     del DOM casi de inmediato (la fila pasa a mostrar el texto fijo) —
//     no hay que volver a consultarlo para verificar, solo confirmar que
//     el placeholder "Seleccione un Tipo de Pago" ya no aparece en el
//     body.
//   - El carrito de "Tickets a Facturar" es estado del navegador
//     (Angular), NO persiste en el servidor entre sesiones/pestañas
//     nuevas — cada corrida de este bot debe re-agregar el ticket desde
//     cero, no asumir que ya está ahí.
//   - Tras "Facturar Tickets" exitoso, el formulario se resetea a vacío
//     (RFC/Régimen/Uso CFDI en blanco, carrito vacío) — esa es la señal
//     de éxito, no un mensaje de confirmación explícito en pantalla.
//   - La factura real y sus enlaces de descarga (XML/PDF directos, más
//     el link de verificación del SAT) aparecen en "Mis Facturas"
//     (ACCEDER A MIS FACTURAS), columna "Acciones" de la fila con el
//     folio recién generado — esos <a href> son URLs autenticadas por
//     la misma cookie de sesión, descargables con fetch() + header
//     Cookie manual (no requieren un segundo login).
//   - Verificado en vivo: folio real 62703067, UUID
//     d9edf987-788b-4f71-97cb-2ccc55d449af, Total $800.00 exacto, RFC
//     receptor GPR110128QD8 correcto.
const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");
const { extraerUUIDcfdi } = require("../lib/util");

// Selecciona en un <select> por valor exacto y, si ese valor no existe entre
// las opciones, por texto. Verifica después: page.select() con un valor que no
// existe NO lanza — deja el campo vacío y el fallo aparece mucho más tarde.
async function seleccionarPorTexto(page, selector, valorPreferido, regex) {
  const elegido = await page.evaluate((sel, val, re) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const opts = Array.from(el.options).filter(o => o.value);
    const rx = new RegExp(re.source, re.flags);
    const o = opts.find(x => x.value === String(val))
           || opts.find(x => rx.test(x.text))
           || opts.find(x => rx.test(x.value));
    return o ? o.value : null;
  }, selector, valorPreferido, { source: regex.source, flags: regex.flags });
  if (!elegido) throw new Error(`${selector}: no hay opción que case con "${valorPreferido}" ni con ${regex}`);
  await page.select(selector, elegido);

  // ⚠️ Estos <select> están decorados con jQuery Chosen. page.select() cambia
  // el value del <select> real, pero la UI de Chosen se queda mostrando
  // "Seleccione ..." y la app valida contra ESA capa: el ticket nunca entra al
  // carrito aunque el DOM parezca correcto. Hay que avisarle a Chosen con
  // 'chosen:updated' y volver a emitir 'change' para los handlers de la app.
  await page.evaluate((sel, val) => {
    const el = document.querySelector(sel);
    if (!el) return;
    el.value = val;
    const $ = window.jQuery || window.$;
    if ($) $(el).val(val).trigger("chosen:updated").trigger("change");
    else el.dispatchEvent(new Event("change", { bubbles: true }));
  }, selector, elegido);
  await page.waitForTimeout(600);

  const estado = await page.evaluate((s) => {
    const el = document.querySelector(s);
    const cont = document.querySelector(`#${el.id}_chosen`) || el.closest(".form-group")?.querySelector(".chosen-container");
    return { value: el.value, visible: cont ? cont.innerText.replace(/\s+/g, " ").trim().slice(0, 60) : null };
  }, selector);
  if (!estado.value) throw new Error(`${selector}: se eligió "${elegido}" pero el campo quedó vacío`);
  if (estado.visible && /^seleccione/i.test(estado.visible)) {
    throw new Error(`${selector}: el <select> vale "${estado.value}" pero el widget Chosen sigue mostrando "${estado.visible}"`);
  }
  return estado.value;
}

async function seleccionarPagoEnFila(page, folio, regexTexto) {
  const info = await page.evaluate((folio) => {
    const row = Array.from(document.querySelectorAll("tr")).find(tr => tr.textContent.includes(folio));
    if (!row) return { error: "fila no encontrada" };
    const sel = row.querySelector("select");
    if (!sel) return { error: "select no encontrado en la fila" };
    const opt = Array.from(sel.options).find(o => new RegExp("tarjeta de d[eé]bito", "i").test(o.text));
    return { name: sel.name, value: opt ? opt.value : null };
  }, folio);
  if (info.error || !info.name || info.value === null) return { ok: false, motivo: "no se pudo ubicar el select o la opción", info };

  await page.select(`select[name="${info.name}"]`, info.value);
  await page.waitForTimeout(800);
  const siguePlaceholder = await page.evaluate(() => document.body.innerText.includes("Seleccione un Tipo de Pago"));
  return { ok: !siguePlaceholder };
}

async function facturarOxxoGas({ rfcId, regimenFiscal, usoCfdi, estacionId, folio, monto, ticketId }) {
  console.log("🤖 Iniciando bot OXXO GAS (requiere sesión manual inyectada)...");

  const ciSession = process.env.OXXOGAS_CI_SESSION;
  const incapSes117 = process.env.OXXOGAS_INCAP_SES_117;
  const incapSes363 = process.env.OXXOGAS_INCAP_SES_363;
  const visidIncap = process.env.OXXOGAS_VISID_INCAP;
  if (!ciSession) {
    return { ok: false, error_code: "captcha", msg: "OXXO GAS: no hay sesión manual inyectada (falta OXXO_GAS_CI_SESSION). Requiere que el usuario inicie sesión a mano y proporcione cookies frescas — no se puede automatizar el login por el reCAPTCHA." };
  }

  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1100 });
  page.on("dialog", async d => { await d.accept().catch(() => {}); });

  // Las cookies incap_ses_* de Incapsula cambian de sufijo numérico según el
  // nodo del WAF que atienda; se aceptan todas las que haya en el entorno.
  const cookies = [{ name: "ci_sessions", value: ciSession, domain: "facturacion.oxxogas.com", path: "/" }];
  for (const [nombre, valor] of [
    ["incap_ses_117_3020163", incapSes117],
    ["incap_ses_363_3020163", incapSes363],
    ["incap_ses_396_3020163", process.env.OXXOGAS_INCAP_396],
    ["incap_ses_397_3020163", process.env.OXXOGAS_INCAP_397],
    ["incap_ses_92_3020163", process.env.OXXOGAS_INCAP_92],
    ["visid_incap_3020163", visidIncap],
  ]) if (valor) cookies.push({ name: nombre, value: valor, domain: ".oxxogas.com", path: "/" });
  await page.setCookie(...cookies);

  const ts = ticketId || Date.now();
  async function screenshot(label) {
    try {
      const buf = await page.screenshot({ fullPage: true });
      const u = await subirArchivoR2(buf, `debug/oxxogas_${ts}_${label}_${Date.now()}.png`, "image/png");
      console.log(`📸 [${label}]: ${u}`);
    } catch {}
  }

  try {
    const resp = await page.goto("https://facturacion.oxxogas.com/", { waitUntil: "networkidle2", timeout: 30000 });
    await page.waitForTimeout(3500);
    const bodyInicial = await page.evaluate(() => document.body.innerText.slice(0, 200));
    if (!/Hola/i.test(bodyInicial)) {
      await browser.close();
      return { ok: false, error_code: "captcha", msg: "OXXO GAS: la sesión manual ya no es válida (expiró o fue invalidada) — se necesita que el usuario inicie sesión de nuevo y proporcione cookies frescas." };
    }

    let facturarHandle = await page.evaluateHandle(() =>
      Array.from(document.querySelectorAll("a")).find(a => a.textContent.trim() === "ACCEDER A FACTURAR") || null
    );
    let facturarEl = facturarHandle.asElement();
    if (!facturarEl) {
      await page.waitForTimeout(2500);
      facturarHandle = await page.evaluateHandle(() =>
        Array.from(document.querySelectorAll("a")).find(a => a.textContent.trim() === "ACCEDER A FACTURAR") || null
      );
      facturarEl = facturarHandle.asElement();
    }
    if (!facturarEl) throw new Error("no se encontró el enlace Facturar en el dashboard");
    await facturarEl.click();
    await page.waitForTimeout(2500);

    // Guarda de sanidad: si por lo que sea llegó una página sin JavaScript, los
    // selects dependientes no se poblarán nunca y el botón no tendrá handler.
    // Mejor abortar aquí que gastar la sesión entera (ver cabecera).
    const js = await page.evaluate(() => ({
      scripts: document.querySelectorAll("script[src]").length,
      jquery: !!window.jQuery,
    }));
    if (js.scripts === 0 || !js.jquery) {
      await browser.close();
      return {
        ok: false,
        msg: `OXXO GAS: la página llegó sin JavaScript (${js.scripts} scripts, jQuery=${js.jquery}). Normalmente pasa por entrar con deep link en vez de por la home — este bot ya entra por la home, así que revisar la sesión.`,
      };
    }

    // El RFC se resuelve por TEXTO, no por un id interno hardcodeado: ese id
    // cambia entre cuentas y un valor inexistente deja el <select> vacío sin
    // error.
    const rfcValue = await page.evaluate((buscado) => {
      const sel = document.querySelector("#rfc");
      if (!sel) return null;
      const o = Array.from(sel.options).find(x => x.text.toUpperCase().includes(String(buscado).toUpperCase()));
      return o ? o.value : null;
    }, rfcId);
    if (!rfcValue) throw new Error(`el RFC ${rfcId} no aparece en el selector de RFCs de la cuenta`);

    await page.select("#rfc", rfcValue);
    await page.evaluate((val) => {
      const el = document.querySelector("#rfc");
      el.value = val;
      const $ = window.jQuery || window.$;
      if ($) $(el).val(val).trigger("chosen:updated").trigger("change");
      else el.dispatchEvent(new Event("change", { bubbles: true }));
    }, rfcValue);

    // ⚠️ #regimen_fiscal y #usocfdi se pueblan por AJAX DESPUÉS de elegir el
    // RFC. Hay que esperarlos: page.select() sobre un <select> todavía vacío no
    // falla, simplemente no selecciona nada, y el error aparece mucho más tarde
    // como "el botón no hace nada".
    await page.waitForFunction(
      () => (document.querySelector("#regimen_fiscal")?.options.length || 0) > 0
         && (document.querySelector("#usocfdi")?.options.length || 0) > 0,
      { timeout: 15000 }
    ).catch(() => { throw new Error("los selects de Régimen/Uso CFDI no se poblaron tras elegir el RFC"); });

    await seleccionarPorTexto(page, "#regimen_fiscal", regimenFiscal || "601", /601|general de ley/i);
    await seleccionarPorTexto(page, "#usocfdi", usoCfdi || "G03", /^G03|gastos en general/i);
    await seleccionarPorTexto(page, "#estacion", estacionId, new RegExp(String(estacionId), "i"));

    const ticketInput = await page.$("#ticket");
    await ticketInput.click({ clickCount: 3 });
    await page.keyboard.type(String(folio), { delay: 30 });
    const montoInput = await page.$("#monto");
    await montoInput.click({ clickCount: 3 });
    await page.keyboard.type(Number(monto).toFixed(2), { delay: 30 });
    await page.waitForTimeout(300);

    // Comprobación explícita ANTES de pulsar: si algún campo requerido quedó
    // vacío, Angular aborta el submit en silencio.
    const form = await page.evaluate(() => ({
      rfc: document.querySelector("#rfc")?.value,
      regimen: document.querySelector("#regimen_fiscal")?.value,
      uso: document.querySelector("#usocfdi")?.value,
      estacion: document.querySelector("#estacion")?.value,
      ticket: document.querySelector("#ticket")?.value,
      monto: document.querySelector("#monto")?.value,
    }));
    const vacios = Object.entries(form).filter(([, v]) => !v).map(([k]) => k);
    if (vacios.length) throw new Error(`campos sin valor antes de Agregar Ticket: ${vacios.join(", ")} (form=${JSON.stringify(form)})`);
    console.log(`   formulario listo: ${JSON.stringify(form)}`);

    await page.click("#agregar_tickets");
    // Espera condicional en vez de sleep fijo: cada segundo cuenta contra el
    // límite de 60 s de la sesión.
    let enCarrito = false;
    for (let i = 0; i < 15 && !enCarrito; i++) {
      await page.waitForTimeout(1000);
      enCarrito = await page.evaluate((f) => document.body.innerText.includes(String(f)), folio).catch(() => false);
    }
    if (!enCarrito) {
      const visible = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 400)).catch(() => "");
      throw new Error(`el folio ${folio} no entró al carrito. Pantalla: ${visible}`);
    }

    const pago = await seleccionarPagoEnFila(page, String(folio), "tarjeta de d[eé]bito");
    if (!pago.ok) throw new Error(`no se pudo seleccionar la forma de pago: ${JSON.stringify(pago)}`);

    await screenshot("antes_facturar");

    const facturarTicketsHandle = await page.evaluateHandle(() =>
      Array.from(document.querySelectorAll("button")).find(x => /facturar tickets/i.test(x.textContent || "")) || null
    );
    const facturarTicketsEl = facturarTicketsHandle.asElement();
    if (!facturarTicketsEl) throw new Error("no se encontró el botón Facturar Tickets");
    await facturarTicketsEl.click();
    await page.waitForTimeout(7000);
    await screenshot("post_facturar");

    const carritoVacio = await page.evaluate(() => document.body.innerText.includes("No tiene agregado ningún Ticket"));
    if (!carritoVacio) throw new Error("el carrito no se vació tras Facturar Tickets — no se pudo confirmar el éxito");

    // Recuperar el UUID real desde "Mis Facturas" (la fila más reciente para este folio)
    const misFacturasHandle = await page.evaluateHandle(() =>
      Array.from(document.querySelectorAll("a")).find(a => a.textContent.trim() === "ACCEDER A MIS FACTURAS") || null
    );
    await misFacturasHandle.asElement().click();
    await page.waitForTimeout(3000);

    const enlaces = await page.evaluate((folioMonto) => {
      const rows = Array.from(document.querySelectorAll("tr"));
      const row = rows.find(tr => tr.textContent.includes(String(folioMonto)));
      if (!row) return null;
      const xmlA = Array.from(row.querySelectorAll("a")).find(a => /\/xml\//.test(a.href));
      return xmlA ? xmlA.href : null;
    }, Number(monto).toFixed(2).replace(/\.00$/, ""));

    if (!enlaces) throw new Error("no se pudo ubicar la factura recién generada en Mis Facturas para descargar el XML");

    const uuid = enlaces.split("/").pop();
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join("; ");
    const xmlResp = await fetch(`https://facturacion.oxxogas.com/facturacion/facturas/xml/${uuid}`, { headers: { Cookie: cookieHeader } });
    const pdfResp = await fetch(`https://facturacion.oxxogas.com/facturacion/facturas/pdf/${uuid}`, { headers: { Cookie: cookieHeader } });
    const xmlBuffer = xmlResp.ok ? Buffer.from(await xmlResp.arrayBuffer()) : null;
    const pdfBuffer = pdfResp.ok ? Buffer.from(await pdfResp.arrayBuffer()) : null;

    if (!xmlBuffer) throw new Error("no se pudo descargar el XML real de la factura");
    const uuidReal = extraerUUIDcfdi(xmlBuffer) || uuid;
    const xmlUrl = await subirArchivoR2(xmlBuffer, `facturas/oxxogas_${uuidReal}.xml`, "application/xml");
    const pdfUrl = pdfBuffer ? await subirArchivoR2(pdfBuffer, `facturas/oxxogas_${uuidReal}.pdf`, "application/pdf") : null;

    await browser.close();
    return { ok: true, xmlUrl, pdfUrl };

  } catch (err) {
    console.error("❌ Error en bot OXXO GAS:", err.message);
    await screenshot("error").catch(() => {});
    await browser.close().catch(() => {});
    return { ok: false, msg: `OXXO GAS: ${err.message}` };
  }
}

module.exports = { facturarOxxoGas };
