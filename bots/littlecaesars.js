// Little Caesars (Cafrema) — cfdi.analytix360.cloud/cafrema/lc/
//
// ✅ FACTURA SOLO. El formulario tiene reCAPTCHA v2 de Google y se resuelve con
// CapSolver (ReCaptchaV2TaskProxyLess), igual que 7-Eleven usa CapSolver para
// su captcha de imagen. Decisión de Carlos del 15/08/2026: sí se usa servicio
// de resolución en este portal.
//
// Si CapSolver no está configurado (sin CAPSOLVER_API_KEY) o falla, el bot
// vuelve al comportamiento anterior: deja el formulario relleno y verificado,
// hace captura y devuelve error_code 'captcha' con el dosier para terminarlo a
// mano. Nunca tira el trabajo hecho por un fallo del tercero.
//
// ── RECONOCIMIENTO REAL (12/08/2026) ───────────────────────────────────────
//   Portada  cfdi.analytix360.cloud/cafrema/lc/
//            Dos opciones: "Crear Nueva Factura" y "Reimprimir Factura".
//            ⚠️ La portada SIN el /lc/ (…/cafrema/ a secas) NO tiene
//            formulario: es solo texto. Perdí un reconocimiento entero ahí.
//   Alta     …/lc/crear/
//            select#ticket_cv_store    86 tiendas, formato 04123-000NN
//            input#ticket_cv_ticket    [number]  ph "272483"
//            input#ticket_cv_fecha     [text]    ph "2026-08-12"  → YYYY-MM-DD
//            input#ticket_cv_total     [text]    ph "79"
//            input#ticket_cv_rfc       [text]    ph "RFC de Cliente"
//            .g-recaptcha  sitekey 6Lft1l8UAAAAAE08IIf97xe4Gam2xRRAJAS1_qpa
//            botón "Enviar"
//
// ── LOS DOS MODOS ──────────────────────────────────────────────────────────
//   desatendido (por defecto, el de la cola)
//       Rellena, comprueba que todo cuadra, hace captura y devuelve
//       error_code 'captcha' con un DOSIER: qué tienda eligió, qué escribió en
//       cada campo y la URL de la captura. lib/facturacion.js ya trata ese
//       error_code y avisa al usuario.
//   asistido
//       Igual, pero NO cierra el navegador: publica la sesión en vivo de
//       Browserless para que una persona resuelva el reCAPTCHA con sus propios
//       ojos y sus propias manos, y el bot espera a que aparezca el token para
//       pulsar Enviar y recoger el resultado.
//       El CAPTCHA lo resuelve SIEMPRE una persona. El bot solo espera.
const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");

const BASE = "https://cfdi.analytix360.cloud/cafrema/lc";
const SITEKEY = "6Lft1l8UAAAAAE08IIf97xe4Gam2xRRAJAS1_qpa";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── CapSolver: reCAPTCHA v2 ─────────────────────────────────────────────────
// A diferencia del ImageToTextTask de 7-Eleven (síncrono), ReCaptchaV2 es
// ASÍNCRONO: createTask devuelve taskId y hay que hacer polling en
// getTaskResult hasta que status sea "ready". Suele tardar 10-40 s.
// Se usa la variante ProxyLess: el token NO va ligado a la IP de Browserless.
async function resolverRecaptchaV2(websiteURL, websiteKey) {
  const apiKey = process.env.CAPSOLVER_API_KEY;
  if (!apiKey) throw new Error("CAPSOLVER_API_KEY no definida");

  const c = await fetch("https://api.capsolver.com/createTask", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientKey: apiKey,
      task: { type: "ReCaptchaV2TaskProxyLess", websiteURL, websiteKey },
    }),
  }).then((r) => r.json());
  if (c.errorId) throw new Error(`CapSolver create: ${c.errorCode || c.errorDescription}`);
  if (!c.taskId) throw new Error("CapSolver: no devolvió taskId");

  for (let i = 0; i < 40; i++) {
    await sleep(3000);
    const res = await fetch("https://api.capsolver.com/getTaskResult", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: apiKey, taskId: c.taskId }),
    }).then((r) => r.json());
    if (res.status === "ready") {
      const token = res.solution?.gRecaptchaResponse;
      if (!token) throw new Error("CapSolver: ready pero sin gRecaptchaResponse");
      console.log(`🔓 reCAPTCHA v2 resuelto por CapSolver (${(i + 1) * 3}s)`);
      return token;
    }
    if (res.errorId) throw new Error(`CapSolver result: ${res.errorCode || res.errorDescription}`);
  }
  throw new Error("CapSolver timeout 120s esperando el token de reCAPTCHA");
}

// Deposita el token donde grecaptcha.getResponse() lo va a buscar. El handler
// jQuery del portal valida `grecaptcha.getResponse() === ""` antes de dejar
// pasar el submit, y getResponse() lee el textarea #g-recaptcha-response del
// widget 0 — por eso basta escribir ahí, sin tocar internals de Google.
async function inyectarTokenRecaptcha(page, token) {
  return await page.evaluate((t) => {
    const areas = document.querySelectorAll("textarea[name='g-recaptcha-response'], #g-recaptcha-response");
    areas.forEach((a) => { a.value = t; a.innerHTML = t; });
    let respuesta = null;
    try { respuesta = window.grecaptcha && window.grecaptcha.getResponse(); } catch (e) { respuesta = `error: ${e.message}`; }
    return { areas: areas.length, respuesta: String(respuesta || "").slice(0, 40), largo: String(respuesta || "").length };
  }, token);
}

// El portal lista las tiendas como "04123-00007". El ticket imprime el número
// de tienda suelto ("7", "07", "TIENDA 7"). Se normaliza a las dos formas para
// poder emparejar sin depender de cómo venga.
function clavesTienda(numeroTienda) {
  const bruto = String(numeroTienda || "").trim();
  if (!bruto) return [];

  // ⚠️ Si ya viene la clave completa hay que respetarla TAL CUAL. Quitarle los
  // no-dígitos pega los dos bloques ("04123-00023" → "0412300023") y sale una
  // clave inventada que no existe en el portal.
  const completa = bruto.match(/\b(\d{5})\s*-\s*(\d{1,5})\b/);
  if (completa) {
    const suf = completa[2].padStart(5, "0");
    return [`${completa[1]}-${suf}`, suf, String(Number(suf))];
  }

  const n = bruto.replace(/\D/g, "");
  if (!n) return [];
  const corto = String(Number(n));
  return [
    `04123-${corto.padStart(5, "0")}`,   // 04123-00007
    corto.padStart(5, "0"),              // 00007
    corto,                               // 7
  ];
}

// El portal quiere YYYY-MM-DD; el OCR entrega DD/MM/YYYY.
function fechaISO(f) {
  const s = String(f || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const p = s.split(/[\/\-]/);
  if (p.length !== 3) return "";
  const [d, m, a] = p;
  return `${a}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

async function facturarLittleCaesars({
  folio, ticketNumero, tienda, fecha, total, rfc,
  razonSocial, regimenFiscal, codigoPostal, usoCfdi, email,
  ticketId, modo = "desatendido", esperaAsistidaMs = 5 * 60 * 1000,
}) {
  const numTicket = String(ticketNumero || folio || "").replace(/\D/g, "");
  const fIso = fechaISO(fecha);

  // Lo que el portal exige. Se comprueba ANTES de abrir el navegador: no tiene
  // sentido gastar una sesión de Browserless para descubrir que falta un dato.
  const faltan = [];
  if (!numTicket) faltan.push("número de ticket");
  if (!fIso) faltan.push("fecha");
  if (!total) faltan.push("total");
  if (!rfc) faltan.push("RFC");
  if (!String(tienda || "").trim()) faltan.push("número de tienda (el portal tiene 86 y no se puede adivinar)");
  // Paso 2 (/lc/validar/): el portal pide los datos fiscales DESPUÉS del ticket.
  // Sin ellos no tiene caso quemar navegador ni captcha.
  if (!String(razonSocial || "").trim()) faltan.push("razón social (perfil fiscal)");
  if (!String(regimenFiscal || "").trim()) faltan.push("régimen fiscal (perfil fiscal)");
  if (!String(codigoPostal || "").trim()) faltan.push("código postal fiscal (perfil fiscal)");
  if (!String(email || "").trim()) faltan.push("email (a donde el portal envía la factura)");
  if (faltan.length) {
    return { ok: false, error_code: "datos_invalidos", msg: `Little Caesars: faltan datos del ticket — ${faltan.join(", ")}` };
  }

  console.log("🤖 Little Caesars (Cafrema)");
  console.log(`   tienda ${tienda} · ticket ${numTicket} · ${fIso} · $${total} · ${rfc} · modo ${modo}`);

  // PUPPETEER_LOCAL=1 lanza un Chromium local (pruebas fuera de Railway);
  // en producción siempre se conecta a Browserless.
  let browser;
  try {
    if (process.env.PUPPETEER_LOCAL === "1") {
      browser = await puppeteer.launch({
        headless: "new",
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
      });
    } else {
      const token = process.env.BROWSERLESS_TOKEN;
      if (!token) throw new Error("BROWSERLESS_TOKEN no definido");
      browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
    }
  } catch (e) {
    return { ok: false, msg: `Little Caesars: no se pudo conectar al browser — ${e.message}` };
  }

  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 950 });
  page.on("dialog", async (d) => { console.log("🔔 Dialog:", d.message()); await d.accept().catch(() => {}); });

  const ts = ticketId || Date.now();
  const snap = async (etq) => {
    try {
      return await subirArchivoR2(await page.screenshot({ fullPage: true }), `debug/lc_${ts}_${etq}_${Date.now()}.png`, "image/png");
    } catch { return null; }
  };

  const poner = (sel, v) => page.evaluate((s, val) => {
    const e = document.querySelector(s);
    if (!e) return false;
    e.value = val;
    ["input", "change", "keyup", "blur"].forEach((ev) => e.dispatchEvent(new Event(ev, { bubbles: true })));
    return true;
  }, sel, String(v ?? ""));

  try {
    // ── 1. Formulario de alta ────────────────────────────────────────────────
    // Se va directo a /lc/crear/. La portada solo tiene dos enlaces y pasar por
    // ella no aporta nada; si el portal cambia y /crear/ deja de existir, el
    // waitForSelector de abajo lo dice claro.
    await page.goto(`${BASE}/crear/`, { waitUntil: "domcontentloaded", timeout: 40000 });
    await page.waitForSelector("#ticket_cv_store", { timeout: 20000 })
      .catch(() => { throw new Error("no apareció el formulario en /lc/crear/ — puede que el portal haya cambiado de ruta"); });
    await page.waitForTimeout(1500);

    // ── 2. Tienda ───────────────────────────────────────────────────────────
    // Es el campo que más se puede torcer: 86 opciones y el ticket no siempre
    // imprime la clave completa. Si no casa, se para y se dice qué había.
    const tiendaOk = await page.evaluate((claves) => {
      const s = document.querySelector("#ticket_cv_store");
      const ops = Array.from(s.options);
      for (const c of claves) {
        const o = ops.find((x) => x.textContent.trim() === c) ||
                  ops.find((x) => x.textContent.trim().endsWith(`-${c}`)) ||
                  ops.find((x) => x.value === c);
        if (o) {
          s.value = o.value;
          s.dispatchEvent(new Event("change", { bubbles: true }));
          return { elegida: o.textContent.trim() };
        }
      }
      return { lista: ops.map((x) => x.textContent.trim()).filter(Boolean).slice(0, 90) };
    }, clavesTienda(tienda));

    if (!tiendaOk.elegida) {
      const cap = await snap("sin_tienda");
      await browser.close();
      return {
        ok: false, error_code: "datos_invalidos",
        msg: `Little Caesars: la tienda "${tienda}" no está entre las ${tiendaOk.lista.length} del portal. Se esperaba el formato 04123-000NN. Captura: ${cap || "no disponible"}`,
      };
    }
    console.log(`   tienda: ${tiendaOk.elegida}`);

    // ── 3. El resto de campos ───────────────────────────────────────────────
    await poner("#ticket_cv_ticket", numTicket);
    await poner("#ticket_cv_fecha", fIso);
    await poner("#ticket_cv_total", Number(total).toFixed(2));
    await poner("#ticket_cv_rfc", String(rfc).toUpperCase());

    // Releer lo que quedó escrito de verdad. Los formularios con datepicker o
    // máscaras se comen valores en silencio — es exactamente lo que pasó en
    // PINFRA, donde tres campos quedaron vacíos y el fallo se achacó al portal.
    const escrito = await page.evaluate(() => ({
      tienda: document.querySelector("#ticket_cv_store")?.selectedOptions[0]?.textContent.trim(),
      ticket: document.querySelector("#ticket_cv_ticket")?.value,
      fecha: document.querySelector("#ticket_cv_fecha")?.value,
      total: document.querySelector("#ticket_cv_total")?.value,
      rfc: document.querySelector("#ticket_cv_rfc")?.value,
    }));
    const vacios = Object.entries(escrito).filter(([, v]) => !String(v || "").trim()).map(([k]) => k);
    if (vacios.length) {
      const cap = await snap("campos_vacios");
      await browser.close();
      return {
        ok: false, error_code: "reintentar_despues",
        msg: `Little Caesars: estos campos no aceptaron el valor: ${vacios.join(", ")}. Captura: ${cap || "no disponible"}`,
      };
    }
    console.log(`   formulario listo: ${JSON.stringify(escrito)}`);

    // ── 4. El CAPTCHA ───────────────────────────────────────────────────────
    const hayCaptcha = await page.evaluate(() =>
      !!document.querySelector(".g-recaptcha, iframe[src*='recaptcha']"));

    // Si algún día lo quitan, el bot factura solo. Ese es el único camino por
    // el que este archivo llega a Enviar sin una persona delante.
    if (!hayCaptcha) {
      console.log("   ℹ️ no hay reCAPTCHA en esta carga — se envía directamente");
      return await enviarYLeer(page, browser, snap, ticketId, { rfc, razonSocial, regimenFiscal, codigoPostal, usoCfdi, email });
    }

    const captura = await snap("listo_falta_captcha");

    // ── 4a. CapSolver: resolver el reCAPTCHA v2 y enviar ────────────────────
    // Camino principal desde el 15/08/2026. El token caduca a los ~2 minutos,
    // así que se inyecta y se envía enseguida, sin pausas de por medio.
    if (modo !== "asistido" && process.env.CAPSOLVER_API_KEY) {
      try {
        const tokenCaptcha = await resolverRecaptchaV2(`${BASE}/crear/`, SITEKEY);
        const inj = await inyectarTokenRecaptcha(page, tokenCaptcha);
        console.log(`   token inyectado: ${inj.areas} textarea(s), getResponse() ${inj.largo} chars`);
        if (!inj.areas || inj.largo < 30) {
          throw new Error(`el token no prendió en la página (getResponse=${inj.largo} chars)`);
        }
        return await enviarYLeer(page, browser, snap, ticketId, { rfc, razonSocial, regimenFiscal, codigoPostal, usoCfdi, email });
      } catch (e) {
        // CapSolver falló o el token no prendió: NO se tira el trabajo. Se cae
        // al dosier de siempre para que una persona lo termine a mano.
        console.log(`   ⚠️ CapSolver no resolvió el reCAPTCHA: ${e.message} — se devuelve el dosier manual`);
        const capFallo = await snap("capsolver_fallo");
        await browser.close();
        return {
          ok: false,
          error_code: "captcha",
          portal_url: `${BASE}/crear/`,
          datos_para_capturar: escrito,
          captura: capFallo || captura,
          msg: `Little Caesars: CapSolver no pudo con el reCAPTCHA (${e.message}). Datos ya verificados: tienda ${escrito.tienda}, ticket ${escrito.ticket}, fecha ${escrito.fecha}, total $${escrito.total}, RFC ${escrito.rfc}. Formulario en ${BASE}/crear/`,
        };
      }
    }

    // ── 4b. Sin CapSolver: preparar y parar (comportamiento original) ───────
    if (modo !== "asistido") {
      await browser.close();
      return {
        ok: false,
        error_code: "captcha",
        portal_url: `${BASE}/crear/`,
        // El dosier: todo lo que una persona necesita para terminarlo sin
        // volver a leer el ticket ni buscar nada.
        datos_para_capturar: escrito,
        captura,
        msg: `Little Caesars pide reCAPTCHA y solo puede terminarlo una persona. Datos ya verificados: tienda ${escrito.tienda}, ticket ${escrito.ticket}, fecha ${escrito.fecha}, total $${escrito.total}, RFC ${escrito.rfc}. Formulario en ${BASE}/crear/`,
      };
    }

    // ── 4c. Modo asistido: esperar a que una PERSONA lo resuelva ────────────
    // El bot no toca el reCAPTCHA. Publica la sesión en vivo, se queda mirando
    // el campo donde Google deposita el token y sigue cuando aparece.
    const enVivo = await sesionEnVivo(browser);
    console.log(`   🧑 Esperando a una persona en: ${enVivo || "(no se pudo publicar la sesión en vivo)"}`);

    const resuelto = await page.waitForFunction(
      () => {
        const t = document.querySelector("#g-recaptcha-response");
        return !!(t && t.value && t.value.length > 30);
      },
      { timeout: esperaAsistidaMs, polling: 1000 }
    ).then(() => true).catch(() => false);

    if (!resuelto) {
      await browser.close();
      return {
        ok: false, error_code: "captcha", portal_url: `${BASE}/crear/`, captura,
        msg: `Little Caesars: nadie resolvió el reCAPTCHA en ${Math.round(esperaAsistidaMs / 60000)} minutos. El formulario estaba listo; se puede reintentar en modo asistido.`,
      };
    }
    console.log("   ✅ una persona resolvió el reCAPTCHA — enviando");
    return await enviarYLeer(page, browser, snap, ticketId, { rfc, razonSocial, regimenFiscal, codigoPostal, usoCfdi, email });
  } catch (e) {
    await snap("excepcion").catch(() => {});
    await browser.close().catch(() => {});
    return { ok: false, msg: `Little Caesars: ${e.message}` };
  }
}

// Pulsa Enviar y clasifica la respuesta por lo que DICE el portal, nunca por
// suposición. El form hace POST clásico (Symfony) con navegación completa; los
// errores de validación salen en sweetAlert (.sweet-alert) y los de servidor en
// .alert de Bootstrap. La portada avisa que la factura llega por correo, así
// que el éxito más probable es un texto de confirmación, no un enlace directo.
// El flujo real del portal (comprobado en vivo el 15/08/2026) tiene DOS pasos:
//   1. /lc/crear/    → datos del ticket + reCAPTCHA
//   2. /lc/validar/  → datos fiscales del receptor (RFC, nombre, régimen, CP,
//                      email, uso CFDI). Aquí es donde de verdad se timbra.
// fiscales = { rfc, razonSocial, regimenFiscal, codigoPostal, usoCfdi, email }
async function enviarYLeer(page, browser, snap, ticketId, fiscales = {}) {
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll("button, input[type=submit]"))
      .find((x) => /enviar/i.test(x.textContent || x.value || "") && x.offsetParent);
    if (b) b.click();
  });

  // El POST recarga la página; si en 20s no navegó, igual hay un sweetAlert
  // de error que leer. No se trata como fallo: la lectura de abajo decide.
  await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(12000);

  // ── Paso 2: pantalla "Validar RFC" ──────────────────────────────────────
  // Se detecta por la URL o por el campo del formulario Symfony.
  const enValidar = page.url().includes("/validar/") ||
    (await page.evaluate(() => !!document.querySelector("#appbundle_financial_clientes_rfc")));
  if (enValidar) {
    console.log("   📋 paso 2: datos fiscales del receptor (/lc/validar/)");
    await snap("paso2_validar");

    const soloCodigo = (v) => (String(v || "").match(/\d{3}/) || [""])[0];
    const soloUso = (v) => (String(v || "").match(/[A-Z]\d{2}/) || ["G03"])[0];

    const llenado = await page.evaluate((f) => {
      const poner = (sel, val) => {
        const e = document.querySelector(sel);
        if (!e) return false;
        e.value = val;
        ["input", "change", "keyup", "blur"].forEach((ev) => e.dispatchEvent(new Event(ev, { bubbles: true })));
        return true;
      };
      const elegir = (sel, val) => {
        const s = document.querySelector(sel);
        if (!s) return false;
        const o = Array.from(s.options).find((x) => x.value === val) ||
                  Array.from(s.options).find((x) => x.value.startsWith(val));
        if (!o) return false;
        s.value = o.value;
        s.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      };
      return {
        rfc: poner("#appbundle_financial_clientes_rfc", f.rfc),
        nombre: poner("#appbundle_financial_clientes_nombre", f.razonSocial),
        regimen: elegir("#appbundle_financial_clientes_regimenFiscal", f.regimenFiscal),
        cp: poner("#appbundle_financial_clientes_domicilioFiscalReceptor", f.codigoPostal),
        email: poner("#appbundle_financial_clientes_email", f.email),
        uso: elegir("#appbundle_financial_clientes_usoCfdi", f.usoCfdi),
      };
    }, {
      rfc: String(fiscales.rfc || "").toUpperCase(),
      razonSocial: String(fiscales.razonSocial || "").trim(),
      regimenFiscal: soloCodigo(fiscales.regimenFiscal),
      codigoPostal: String(fiscales.codigoPostal || "").trim(),
      email: String(fiscales.email || "").trim(),
      usoCfdi: soloUso(fiscales.usoCfdi),
    });

    const noLleno = Object.entries(llenado).filter(([, ok]) => !ok).map(([k]) => k);
    if (noLleno.length) {
      const cap = await snap("paso2_campos");
      await browser.close();
      return {
        ok: false, error_code: "datos_invalidos",
        msg: `Little Caesars: en la pantalla de datos fiscales no se pudieron llenar: ${noLleno.join(", ")}. Captura: ${cap || "no disponible"}`,
      };
    }
    console.log("   📋 paso 2 llenado:", JSON.stringify(llenado));

    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("button, input[type=submit]"))
        .find((x) => /enviar/i.test(x.textContent || x.value || "") && x.offsetParent);
      if (b) b.click();
    });
    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(12000);
  }

  const captura = await snap("tras_enviar");

  const r = await page.evaluate(() => ({
    url: location.href,
    texto: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 900),
    enlaces: Array.from(document.querySelectorAll("a")).map((a) => a.href).filter((h) => /\.xml|\.pdf|descarga|download/i.test(h)),
    avisos: Array.from(document.querySelectorAll(".alert, .error, [class*=danger], .invalid-feedback, .sweet-alert h2, .sweet-alert p, .help-block"))
      .filter((e) => e.offsetParent !== null).map((e) => e.textContent.trim().replace(/\s+/g, " ")).filter(Boolean).slice(0, 6),
  }));
  await browser.close();

  const t = r.texto;
  if (/ya (fue|est[aá]) facturad|ya se factur|previamente/i.test(t))
    return { ok: false, error_code: "ya_facturado", msg: `Little Caesars: el ticket ya fue facturado. Se puede recuperar con "Reimprimir Factura".` };
  if (/no (se )?(encontr|existe)|inv[aá]lid|incorrect/i.test(t))
    return { ok: false, error_code: "datos_invalidos", msg: `Little Caesars: el portal no reconoce el ticket${r.avisos.length ? ` — "${r.avisos[0]}"` : ""}` };
  if (/venci|fuera de plazo|caduc|30 d[ií]as/i.test(t))
    return { ok: false, error_code: "ticket_vencido", msg: `Little Caesars: fuera de plazo${r.avisos.length ? ` — "${r.avisos[0]}"` : ""}` };

  if (r.enlaces.length)
    return { ok: true, xmlUrl: r.enlaces.find((h) => /\.xml/i.test(h)) || null, pdfUrl: r.enlaces.find((h) => /\.pdf/i.test(h)) || null };

  // El portal dice en su portada que manda la factura al correo.
  if (/correo|email|enviad|generad|gracias/i.test(t))
    return { ok: true, procesandoCorreo: true };

  return {
    ok: false, error_code: "reintentar_despues",
    msg: `Little Caesars: se envió y el portal no confirmó ni rechazó${r.avisos.length ? ` — "${r.avisos.join(" | ")}"` : " y no mostró ningún aviso"}. Captura: ${captura || "no disponible"}`,
  };
}

// Browserless publica una URL de sesión en vivo para que una persona vea y
// maneje el navegador remoto.
//
// ⚠️ COMPROBADO EL 13/08/2026 CON LA CUENTA REAL: el plan gratuito NO lo
// soporta. El comando responde {"error":"Live URLs are not supported.",
// "liveURL":null}. O sea que HOY el modo asistido no puede funcionar aquí, por
// bien escrito que esté: no hay forma de enseñarle el reCAPTCHA a una persona.
// Queda escrito para cuando se suba de plan; mientras tanto, el camino que sí
// funciona es el modo desatendido, que deja el formulario listo y devuelve el
// dosier para terminarlo en el navegador de uno.
async function sesionEnVivo(browser) {
  try {
    const cdp = await browser.target().createCDPSession();
    const { liveURL } = await cdp.send("Browserless.liveURL");
    return liveURL || null;
  } catch {
    return null;
  }
}

module.exports = { facturarLittleCaesars, clavesTienda, fechaISO };
