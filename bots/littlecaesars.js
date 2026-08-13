// Little Caesars (Cafrema) — cfdi.analytix360.cloud/cafrema/lc/
//
// ⚠️ ESTE PORTAL NO SE PUEDE FACTURAR SOLO. Tiene reCAPTCHA v2 de Google en el
// formulario, y por decisión de Carlos NO se usa ningún servicio de resolución
// automatizada. Así que el bot hace TODO menos el CAPTCHA, y para en seco.
//
// Que no se pueda automatizar del todo no significa que no valga la pena: el
// bot deja el formulario relleno y verificado, de modo que a la persona solo le
// queda marcar la casilla y pulsar Enviar. Pasa de "facturar a mano desde cero"
// (buscar la tienda entre 86, teclear folio, fecha, total y RFC sin
// equivocarse) a "un clic". Ese es todo su propósito.
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
  if (faltan.length) {
    return { ok: false, error_code: "datos_invalidos", msg: `Little Caesars: faltan datos del ticket — ${faltan.join(", ")}` };
  }

  console.log("🤖 Little Caesars (Cafrema)");
  console.log(`   tienda ${tienda} · ticket ${numTicket} · ${fIso} · $${total} · ${rfc} · modo ${modo}`);

  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error("BROWSERLESS_TOKEN no definido");

  let browser;
  try {
    browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
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
      return await enviarYLeer(page, browser, snap, ticketId);
    }

    const captura = await snap("listo_falta_captcha");

    // ── 4a. Modo desatendido: preparar y parar ──────────────────────────────
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

    // ── 4b. Modo asistido: esperar a que una PERSONA lo resuelva ────────────
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
    return await enviarYLeer(page, browser, snap, ticketId);
  } catch (e) {
    await snap("excepcion").catch(() => {});
    await browser.close().catch(() => {});
    return { ok: false, msg: `Little Caesars: ${e.message}` };
  }
}

// Pulsa Enviar y clasifica la respuesta por lo que DICE el portal, nunca por
// suposición. Es la parte que aún NO se ha podido ver en vivo, porque para
// llegar hasta aquí hace falta un reCAPTCHA resuelto por una persona.
async function enviarYLeer(page, browser, snap, ticketId) {
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll("button, input[type=submit]"))
      .find((x) => /enviar/i.test(x.textContent || x.value || "") && x.offsetParent);
    if (b) b.click();
  });
  await page.waitForTimeout(15000);
  const captura = await snap("tras_enviar");

  const r = await page.evaluate(() => ({
    url: location.href,
    texto: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 900),
    enlaces: Array.from(document.querySelectorAll("a")).map((a) => a.href).filter((h) => /\.xml|\.pdf/i.test(h)),
    avisos: Array.from(document.querySelectorAll(".alert, .error, [class*=danger], .invalid-feedback"))
      .filter((e) => e.offsetParent !== null).map((e) => e.textContent.trim().replace(/\s+/g, " ")).filter(Boolean).slice(0, 5),
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
// maneje el navegador remoto. Si esta versión no lo soporta, se devuelve null y
// el modo asistido lo dice en el mensaje en vez de fallar en silencio.
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
