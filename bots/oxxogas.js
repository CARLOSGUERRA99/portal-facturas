// OXXO GAS — facturacion.oxxogas.com
//
// ══════════════════════════════════════════════════════════════════════════
// ⛔ BLOQUEADO A NIVEL WAF. Medido el 2026-07-31, no supuesto:
//
//   El portal sirve a la IP de Browserless un HTML PELADO: la página trae
//   CERO etiquetas <script src> (comprobado con page.evaluate sobre
//   document.querySelectorAll('script[src]') → 0, y ninguna respuesta .js en
//   el listener de red). En consecuencia jQuery, Chosen y Angular valen
//   `false` en window: el JavaScript del portal NUNCA se ejecuta.
//
//   Consecuencias observadas, todas explicadas por lo mismo:
//     · #rfc sí tiene opciones (vienen renderizadas del servidor), pero
//       #regimen_fiscal y #usocfdi quedan con 0 opciones para siempre —
//       los puebla un AJAX que no corre.
//     · page.select() no lanza error al no encontrar la opción: deja el
//       <select> vacío EN SILENCIO.
//     · El clic en "Agregar Ticket" no dispara ninguna petición a
//       /facturacion/facturar/tickets porque no hay handler JS que la haga.
//       Ese era el síntoma que durante 4 intentos se atribuyó a
//       rate-limiting: NO era rate-limiting.
//
//   Se descartaron una por una las otras hipótesis:
//     · Rate-limiting → probado con 35 s entre acciones: mismo resultado.
//     · Sesión expirada → el dashboard saluda "Hola CARLOS DANIEL", la
//       sesión es válida.
//     · Widget Chosen sin inicializar por page.select() → no existe ni un
//       solo .chosen-container en el DOM; la librería no está cargada.
//     · Timeout de Browserless (60 s exactos, medido) → se rediseñó el flujo
//       para caber en 45 s y el fallo se produce igual a los 25 s.
//
//   La única facturación que sí cerró (ticket 02, folio 62703067, UUID
//   d9edf987-788b-4f71-97cb-2ccc55d449af) ocurrió en una ventana en la que
//   el WAF sí entregó la página completa. No es reproducible a voluntad.
//
//   👉 Este bot NO debe entrar al gate de la cola (ver lib/util.js). Se
//      conserva porque el flujo documentado abajo es correcto y sirve el día
//      que el WAF deje de degradar la página; ahora detecta el shell sin JS
//      y aborta de inmediato en vez de quemar sesiones de Browserless.
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

  const cookies = [{ name: "ci_sessions", value: ciSession, domain: "facturacion.oxxogas.com", path: "/" }];
  if (incapSes117) cookies.push({ name: "incap_ses_117_3020163", value: incapSes117, domain: ".oxxogas.com", path: "/" });
  if (incapSes363) cookies.push({ name: "incap_ses_363_3020163", value: incapSes363, domain: ".oxxogas.com", path: "/" });
  if (visidIncap) cookies.push({ name: "visid_incap_3020163", value: visidIncap, domain: ".oxxogas.com", path: "/" });
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

    // Detección temprana del shell sin JavaScript (ver cabecera). Si el portal
    // degradó la página, seguir adelante solo desperdicia la sesión: los
    // selects dependientes jamás se poblarán y el botón no tendrá handler.
    const sinJs = await page.evaluate(() => ({
      scripts: document.querySelectorAll("script[src]").length,
      jquery: !!window.jQuery,
    }));
    if (sinJs.scripts === 0 || !sinJs.jquery) {
      await browser.close();
      return {
        ok: false,
        error_code: "captcha",
        msg: `OXXO GAS: el portal entregó la página SIN JavaScript (${sinJs.scripts} scripts, jQuery=${sinJs.jquery}) — su WAF degrada la respuesta para tráfico automatizado. El formulario es inoperable así. Hay que facturar manualmente.`,
      };
    }

    let enCarrito = false;
    for (let intento = 1; intento <= 2 && !enCarrito; intento++) {
      await page.select("#rfc", String(rfcId));
      await page.waitForTimeout(1200);
      await page.select("#regimen_fiscal", String(regimenFiscal || "601"));
      await page.waitForTimeout(500);
      await page.select("#usocfdi", String(usoCfdi || "G03"));
      await page.waitForTimeout(500);
      await page.select("#estacion", String(estacionId));
      await page.waitForTimeout(500);
      const ticketInput = await page.$("#ticket");
      await ticketInput.click({ clickCount: 3 });
      await page.keyboard.type(String(folio), { delay: 30 });
      const montoInput = await page.$("#monto");
      await montoInput.click({ clickCount: 3 });
      await page.keyboard.type(Number(monto).toFixed(2), { delay: 30 });
      await page.waitForTimeout(300);
      await page.click("#agregar_tickets");
      await page.waitForTimeout(3500);
      enCarrito = await page.evaluate((folio) => document.body.innerText.includes(String(folio)), folio);
    }
    if (!enCarrito) throw new Error("no se pudo agregar el ticket al carrito tras 2 intentos");

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
