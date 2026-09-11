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

  // La sesión puede venir de dos sitios. Las variables de entorno se conservan
  // por compatibilidad, pero la vía buena es la tabla `config`: exigir cuatro
  // variables de entorno en CADA invocación era un trámite que en la práctica no
  // se hacía, y los tickets se quedaban parados aunque hubiera sesión válida.
  // Se guarda con: node scripts/oxxogas-sesion.js --ci <valor>
  let guardada = {};
  try {
    const db = require("../lib/db");
    const [[fila]] = await db.query("SELECT valor FROM config WHERE clave = 'oxxogas_sesion'");
    if (fila) guardada = JSON.parse(fila.valor || "{}");
  } catch { /* la tabla puede no existir todavía: se sigue con el entorno */ }

  const ciSession = process.env.OXXOGAS_CI_SESSION || guardada.ci_sessions;
  const incapSes117 = process.env.OXXOGAS_INCAP_SES_117 || guardada.incap_ses_117_3020163;
  const incapSes363 = process.env.OXXOGAS_INCAP_SES_363 || guardada.incap_ses_363_3020163;
  const visidIncap = process.env.OXXOGAS_VISID_INCAP || guardada.visid_incap_3020163;
  if (!ciSession) {
    return {
      ok: false,
      error_code: "captcha",
      msg: "OXXO GAS: no hay sesión guardada. Su login lleva reCAPTCHA v2 y NO se automatiza; el resto del flujo de facturación no tiene captcha, así que basta con iniciar sesión a mano UNA vez y guardar la cookie: entra a facturacion.oxxogas.com, F12 → Application → Cookies, copia el valor de `ci_sessions` y corre `node scripts/oxxogas-sesion.js --ci <valor>`. El script la verifica contra el portal antes de guardarla.",
    };
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

  // ⚠️ Marca de no retorno: se pone a true en la línea inmediatamente anterior
  // al click de "Facturar Tickets". A partir de ahí el CFDI puede existir ya, y
  // ningún camino —incluido el catch— puede devolver un error reintentable: la
  // cola reintenta a medianoche y emitiría un SEGUNDO CFDI al mismo folio, que
  // luego hay que cancelar ante el SAT.
  let timbradoDisparado = false;

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
        // El error_code va explícito: aquí todavía no se ha pulsado nada, así
        // que reintentar es lo correcto. Sin el campo caería igualmente en el
        // reintento, pero por omisión y no por decisión — y en este archivo esa
        // omisión es justo la que causó el problema más abajo.
        error_code: "reintentar_despues",
        msg: `OXXO GAS: la página llegó sin JavaScript (${js.scripts} scripts, jQuery=${js.jquery}). Normalmente pasa por entrar con deep link en vez de por la home — este bot ya entra por la home, así que revisar la sesión. No se emitió nada.`,
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
    // Si el botón no aparece NO salió ningún click: no se emitió nada y el
    // reintento sigue siendo legítimo (este throw cae en el catch con
    // timbradoDisparado todavía en false).
    if (!facturarTicketsEl) throw new Error("no se encontró el botón Facturar Tickets");

    // ── EL CLICK QUE TIMBRA ────────────────────────────────────────────────
    timbradoDisparado = true;
    await Promise.all([
      // Esta SPA no navega (la URL nunca cambia, ver cabecera), pero si algún
      // día lo hiciera el page.evaluate siguiente moriría con "Execution
      // context was destroyed" y la excepción subiría al catch. OJO: Promise.all
      // espera a AMBAS promesas, así que —al no haber navegación que lo resuelva
      // antes— este timeout se paga ENTERO en cada corrida, y son segundos
      // robados a los 60 s exactos que Browserless le da a la sesión. Por eso es
      // corto: la espera de verdad la hace el sondeo de aquí abajo, cuyo
      // evaluate ya tolera un contexto destruido con .catch(() => false).
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 2500 }).catch(() => {}),
      facturarTicketsEl.click(),
    ]);

    // El portal no imprime ningún mensaje de confirmación: la única señal de
    // éxito es que el carrito se vacíe (ver cabecera). Se sondea en vez de
    // dormir fijo para no gastar presupuesto de sesión cuando ya se vació.
    // La ventana es de 20 s y no de 8 porque el timbrado tarda: las dos corridas
    // reales del ticket 07 (scripts/oxxogas-ticket07-rapido.js y -lento.js)
    // esperan 25 s por esta misma señal. Con una ventana corta, un CFDI que se
    // emitió bien pero tardó 10 s se devuelve como 'timbrado_sin_archivos' y se
    // queda parado esperando a una persona. Sondear de más no cuesta nada en el
    // camino feliz: el bucle sale en cuanto el carrito se vacía.
    let carritoVacio = false;
    for (let i = 0; i < 20 && !carritoVacio; i++) {
      carritoVacio = await page
        .evaluate(() => document.body.innerText.includes("No tiene agregado ningún Ticket"))
        .catch(() => false);
      if (!carritoVacio) await page.waitForTimeout(1000);
    }
    await screenshot("post_facturar");

    if (!carritoVacio) {
      // Esto era un `throw` y el catch devolvía {ok:false} SIN error_code, es
      // decir error genérico ⇒ reintento a medianoche de un ticket cuyo click
      // de facturar YA había salido. Si el portal llegó a timbrar, ese
      // reintento emite un segundo CFDI al mismo folio. Se sale sin reintento y
      // dejando el ticket a la vista de una persona.
      await browser.close().catch(() => {});
      return {
        ok: false,
        error_code: "timbrado_sin_archivos",
        msg: `OXXO GAS: se pulsó "Facturar Tickets" (folio ${folio}) pero el carrito no se vació, así que no se pudo confirmar el timbrado ni descargar archivos. NO RELANZAR: comprobar antes a mano en ACCEDER A MIS FACTURAS si el CFDI ya existe.`,
      };
    }

    // Recuperar el UUID real desde "Mis Facturas" (la fila más reciente para este folio)
    const misFacturasHandle = await page.evaluateHandle(() =>
      Array.from(document.querySelectorAll("a")).find(a => a.textContent.trim() === "ACCEDER A MIS FACTURAS") || null
    );
    // asElement() devuelve null si el enlace no está, y el .click() encadenado
    // reventaba con un TypeError que terminaba en el catch — o sea, pidiendo el
    // reintento de una factura que en este punto YA está emitida (el carrito se
    // vació). Se comprueba y se sale sin reintento.
    const misFacturasEl = misFacturasHandle.asElement();
    if (!misFacturasEl) {
      await browser.close().catch(() => {});
      return {
        ok: false,
        error_code: "timbrado_sin_archivos",
        msg: `OXXO GAS: el CFDI del folio ${folio} se emitió (el carrito se vació) pero no apareció el enlace "ACCEDER A MIS FACTURAS" para bajar los archivos. NO RELANZAR: descargar el XML/PDF a mano desde el portal.`,
      };
    }
    await misFacturasEl.click();
    await page.waitForTimeout(3000);

    const enlaces = await page.evaluate((folioMonto) => {
      const rows = Array.from(document.querySelectorAll("tr"));
      const row = rows.find(tr => tr.textContent.includes(String(folioMonto)));
      if (!row) return null;
      const xmlA = Array.from(row.querySelectorAll("a")).find(a => /\/xml\//.test(a.href));
      return xmlA ? xmlA.href : null;
    }, Number(monto).toFixed(2).replace(/\.00$/, ""));

    // Mismo caso: la factura ya existe, sólo falla la descarga. Era un throw
    // que acababa en el error genérico y volvía a facturar el ticket de noche.
    if (!enlaces) {
      await browser.close().catch(() => {});
      return {
        ok: false,
        error_code: "timbrado_sin_archivos",
        msg: `OXXO GAS: el CFDI del folio ${folio} se emitió pero no se pudo ubicar su fila en Mis Facturas para descargar el XML. NO RELANZAR: bajar los archivos a mano desde el portal.`,
      };
    }

    const uuid = enlaces.split("/").pop();
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join("; ");
    const xmlResp = await fetch(`https://facturacion.oxxogas.com/facturacion/facturas/xml/${uuid}`, { headers: { Cookie: cookieHeader } });
    const pdfResp = await fetch(`https://facturacion.oxxogas.com/facturacion/facturas/pdf/${uuid}`, { headers: { Cookie: cookieHeader } });
    const xmlBuffer = xmlResp.ok ? Buffer.from(await xmlResp.arrayBuffer()) : null;
    const pdfBuffer = pdfResp.ok ? Buffer.from(await pdfResp.arrayBuffer()) : null;

    // El fetch del XML falló pero el CFDI está timbrado y localizado: nunca
    // reintentar por esto, que es literalmente el caso de 'timbrado_sin_archivos'.
    if (!xmlBuffer) {
      await browser.close().catch(() => {});
      return {
        ok: false,
        error_code: "timbrado_sin_archivos",
        msg: `OXXO GAS: el CFDI del folio ${folio} se emitió (UUID ${uuid}) pero la descarga del XML devolvió HTTP ${xmlResp.status}. NO RELANZAR: bajar el XML/PDF a mano desde Mis Facturas.`,
      };
    }
    const uuidReal = extraerUUIDcfdi(xmlBuffer) || uuid;
    const xmlUrl = await subirArchivoR2(xmlBuffer, `facturas/oxxogas_${uuidReal}.xml`, "application/xml");
    const pdfUrl = pdfBuffer ? await subirArchivoR2(pdfBuffer, `facturas/oxxogas_${uuidReal}.pdf`, "application/pdf") : null;

    await browser.close();
    return { ok: true, xmlUrl, pdfUrl };

  } catch (err) {
    console.error("❌ Error en bot OXXO GAS:", err.message);
    await screenshot("error").catch(() => {});
    await browser.close().catch(() => {});
    // Este catch devolvía {ok:false, msg} SIN error_code y cubre tres fallos
    // que ocurren DESPUÉS de pulsar "Facturar Tickets" (carrito que no se
    // vacía, factura no localizada en Mis Facturas, XML que no baja). Sin
    // error_code el ticket cae en el error genérico, que lo reintenta a
    // medianoche: un segundo CFDI al mismo folio, que hay que cancelar ante el
    // SAT. Si el click ya salió se sale sin reintento posible.
    if (timbradoDisparado) {
      return {
        ok: true,
        procesandoCorreo: true,
        // Sin `folioGenerado` este aviso se pierde: lib/facturacion.js solo
        // guarda en error_msg el rastro que arma con folioGenerado/uuid, así que
        // el ticket pasaría a procesando_correo con error_msg = NULL y nadie
        // sabría qué folio hay que ir a comprobar a Mis Facturas. Aquí el
        // identificador con el que se recupera el CFDI es el folio del ticket.
        folioGenerado: String(folio),
        msg: `OXXO GAS: el click de "Facturar Tickets" ya había salido cuando falló el bot (${err.message}). NO RELANZAR: comprobar antes en el portal (ACCEDER A MIS FACTURAS, folio ${folio}) si el CFDI ya existe.`,
      };
    }
    return { ok: false, error_code: "reintentar_despues", msg: `OXXO GAS: ${err.message} (no se emitió nada)` };
  }
}

module.exports = { facturarOxxoGas };
