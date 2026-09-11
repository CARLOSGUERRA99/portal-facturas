// RedCo — plataforma "facturaenlinea.aspx" de la ALIANZA GASOLINERA REDCO.
// (IIS 10 / ASP.NET 4.0 + DevExpress. Sin login, sin captcha, un solo paso
// visible.)
//
// ⚠️ ESTE BOT NO ES DE UNA GASOLINERA: ES DE UNA PLATAFORMA COMPARTIDA.
// gruporedco.com/acceso-facturacion.html publica un mapeo JS de ~18 grupos
// gasolineros, y CADA UNO tiene SU PROPIA instancia del MISMO
// facturaenlinea.aspx, en su propio host DDNS y su propio puerto. Confirmados
// en el reconocimiento del 11-sep-2026:
//     REDMAX        http://facturasproneg.dynu.net:8000
//     SEVAFUSA      http://sevafusa.fortiddns.com:8081
//     JEZAM         http://jezam.dnsalias.net:8082
//     LOS ARRIEROS  http://losarrieros.dynalias.net:8083
//     HORIZON       http://horizoncongreso.bounceme.net:8092   <- ticket #371
// Por eso el bot NO fija un host: acepta la base por parámetro (baseUrl /
// portalUrl / urlEstacion) y, si no la tiene, la RESUELVE leyendo ese mapeo.
// Está escrito para cubrir los tickets futuros de los otros 17 grupos, no solo
// el de Horizon.
//
// ⚠️ TRAMPA DEL PUERTO (la que costó el reconocimiento): las DOS URLs
// PUBLICADAS OFICIALMENTE PARA HORIZON ESTÁN CAÍDAS. La web de Grupo Horizon
// enlaza a 201.140.99.157:698 y el mapeo de RedCo a ...bounceme.net:82; las
// dos dan conexión rechazada. Los tres nombres apuntan al MISMO host: es un
// DDNS doméstico con el puerto móvil, y el que responde hoy (HTTP 200) es el
// 8092. Conclusión de diseño: el puerto que venga de cualquier fuente es solo
// una PISTA. El bot PRUEBA UNA LISTA de puertos contra el host y se queda con
// el primero que sirva el formulario. Fijar un puerto aquí sería garantizar
// que el bot muera el día que el router del dueño reasigne el NAT.
//
// ── CAMPOS (vistos en vivo en el HTML de Horizon, HTTP 200) ─────────────────
//   #ASPxFormLayout1_Txt_RFC_I               RFC
//   #ASPxFormLayout1_Txt_FolioFacturacion_I  Folio de Facturación
//   #ASPxFormLayout1_Txt_Importe_I           Importe (validación de cliente
//                                            "Valor no válido")
//   #ASPxFormLayout1_Btn_Facturar_I          botón Facturar
// El sufijo "_I" es DevExpress: es el <input> real dentro del control. Por eso
// aquí NO se pone .value — se TECLEA de verdad (click + keyboard.type) y se
// verifica que el valor quedó puesto. Con .value el campo se ve lleno y el
// framework lo sigue creyendo vacío, y la búsqueda no encuentra nada. Mismo
// toolkit que bots/gasolineros.js, que es la REFERENCIA DE CÓDIGO de este
// archivo (no de cobertura: es otro sitio y otro flujo).
//
// ── LO QUE NO SE PUDO CONFIRMAR (queda DEFENSIVO, no adivinado) ─────────────
// (1) NO SE ENVIÓ EL FORMULARIO. No se sabe qué hay después de "Facturar":
//     puede timbrar de una y ofrecer descarga, puede abrir un SEGUNDO PASO
//     pidiendo razón social / CP / régimen / uso de CFDI / correo, o entregar
//     solo por correo. El bot detecta los tres casos y no asume ninguno: si
//     aparecen campos nuevos los llena por rótulo, si aparecen enlaces XML/PDF
//     los baja, y si no hay ni lo uno ni lo otro devuelve procesandoCorreo o
//     un reintentar_despues que dice EXPLÍCITAMENTE que pudo haberse emitido.
//     PENDIENTE DE VERIFICAR EN VIVO.
// (2) NO SE SABE CUÁL DE LOS DOS DATOS DEL OCR ES EL "Folio de Facturación":
//     el ticket #371 trae folio=52675 y referencia=62CDC36. Es la trampa de
//     "los dos folios" ya documentada en el proyecto (IGasFac, NetPay,
//     NexusFuel: cuando dos números parecen el folio, casi siempre vale el
//     otro). El bot PRUEBA LOS DOS: primero el alfanumérico (62CDC36 — en
//     estos portales el "folio de facturación" suele ser el código con letras,
//     no el consecutivo de la impresora) y, si el portal lo rechaza SIN haber
//     emitido nada, reintenta con el numérico y lo deja escrito en el log.
//     PENDIENTE DE VERIFICAR EN VIVO cuál es el bueno.
// (3) El mapeo JS de gruporedco.com se lee con un parser HEURÍSTICO: se
//     confirmó que la página existe y qué hosts publica, pero NO la forma
//     exacta del objeto JS. Si el parser no saca nada, cae al mapa semilla de
//     abajo, y siempre se puede forzar con baseUrl/portalUrl. PENDIENTE DE
//     VERIFICAR EN VIVO.
// (4) Los correos de facturación propios de Horizon no se pudieron verificar.
//     El único CONFIRMADO es el de la alianza: atencionclientes@gruporedco.com
//     — es el que se devuelve como email_contacto para que el sistema reclame
//     la factura por correo cuando el portal no se puede automatizar.
//
// 🛑 Sobre duplicados: no se sabe si este portal frena un folio ya facturado.
// Mientras no se compruebe, "no se confirmó nada" NO se trata como "no pasó
// nada" — ver la nota del click que navega, más abajo.

const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");

const MAPEO_URL = "https://gruporedco.com/acceso-facturacion.html";
const RUTA_FORM = "/facturaenlinea.aspx";
const EMAIL_ALIANZA = "atencionclientes@gruporedco.com";
const BUZON_DEFECTO = process.env.IMAP_USER || "buzonfacturas@serviciosga.site";

const SEL = {
  rfc: "#ASPxFormLayout1_Txt_RFC_I",
  folio: "#ASPxFormLayout1_Txt_FolioFacturacion_I",
  importe: "#ASPxFormLayout1_Txt_Importe_I",
  facturar: "#ASPxFormLayout1_Btn_Facturar_I",
};

// Orden a propósito: primero el puerto que HOY responde en Horizon, después
// los dos publicados (caídos el 11-sep-2026, pueden revivir) y después el
// rango que usan las otras instancias de la alianza, que es de donde sale la
// costumbre de numeración de este proveedor.
const PUERTOS_CONOCIDOS = [8092, 82, 698, 8000, 8081, 8082, 8083, 8084, 8085, 8086, 8087, 8088, 8089, 8090, 8091, 8093, 80];

// Mapa SEMILLA — lo confirmado en el reconocimiento. NO es la verdad: la
// verdad es el mapeo vivo de gruporedco.com y, por encima de todo, el puerto
// que responda. Esto es el suelo para que el bot funcione aunque
// gruporedco.com esté caído.
const MAPA_SEMILLA = {
  HORIZON: "http://horizoncongreso.bounceme.net:8092",
  REDMAX: "http://facturasproneg.dynu.net:8000",
  SEVAFUSA: "http://sevafusa.fortiddns.com:8081",
  JEZAM: "http://jezam.dnsalias.net:8082",
  "LOS ARRIEROS": "http://losarrieros.dynalias.net:8083",
};

// Webs corporativas y de la alianza: son páginas de MARKETING, no instancias
// del formulario. Si portalUrl apunta a una de ellas hay que RESOLVER, no
// intentar facturar ahí. (El ticket #371 llegó con portalUrl =
// https://www.grupohorizon.com.mx, que es exactamente este caso.)
const DOMINIOS_VITRINA = {
  "grupohorizon.com.mx": "HORIZON",
  "gruporedco.com": null,
  "redco.com.mx": null,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const norm = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();

const igualito = (a, b) =>
  String(a || "").replace(/[\s,]/g, "").toUpperCase() === String(b || "").replace(/[\s,]/g, "").toUpperCase();

const aNumero = (v) => {
  const n = parseFloat(String(v == null ? "" : v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : NaN;
};

// Empareja "RedCo / Grupo Horizon (Gasolinera)" con la clave "HORIZON" sin
// exigir que el OCR escriba el nombre igual que el mapeo.
function coincide(clave, aguja) {
  const k = norm(clave);
  const a = norm(aguja);
  if (!k || !a) return false;
  if (a.includes(k) || k.includes(a)) return true;
  return k.split(" ").some((t) => t.length >= 4 && a.includes(t));
}

function partirUrl(u) {
  try {
    const url = new URL(String(u || "").trim());
    if (!/^https?:$/.test(url.protocol)) return null;
    return {
      esquema: url.protocol.replace(":", ""),
      host: url.hostname.toLowerCase(),
      puerto: url.port ? Number(url.port) : null,
    };
  } catch {
    return null;
  }
}

const esVitrina = (host) =>
  Object.keys(DOMINIOS_VITRINA).some((d) => host === d || host.endsWith("." + d));

// Construye la lista de orígenes a probar para un host: primero los puertos
// que alguna fuente sugirió, después la lista conocida. Sin esto el bot se
// queda con el puerto publicado, que es justo el que está caído.
function origenesDe(host, puertosPreferidos, esquema) {
  const puertos = [];
  for (const p of [...(puertosPreferidos || []), ...PUERTOS_CONOCIDOS]) {
    const n = Number(p);
    if (n > 0 && n < 65536 && !puertos.includes(n)) puertos.push(n);
  }
  return puertos.map((p) => `${esquema || "http"}://${host}:${p}`);
}

// Parser HEURÍSTICO del mapeo de gruporedco.com (ver punto 3 de la cabecera:
// la página está confirmada, la forma del objeto JS no). Recoge TODAS las URLs
// que no sean de la vitrina y les cuelga como clave el último literal
// entrecomillado que las precede — que es como se escriben estos mapeos, sea
// objeto, switch o if encadenado. Además indexa cada URL por la primera
// etiqueta DNS del host ("sevafusa", "jezam"), que en esta alianza coincide
// con el nombre del grupo y salva el caso de que el parser falle con la clave.
function extraerMapeoRedco(html) {
  const texto = String(html || "");
  const mapa = {};
  const basura = /(w3\.org|schema\.org|jquery|bootstrap|fontawesome|fonts\.|google|gstatic|facebook|instagram|youtube|whatsapp|maps\.|\.(css|js|png|jpe?g|gif|svg|ico|woff2?)(\?|$))/i;
  const re = /https?:\/\/[a-z0-9.\-]+(?::\d{2,5})?[^\s"'<>)]*/gi;
  let m;
  while ((m = re.exec(texto)) !== null) {
    const url = m[0];
    const p = partirUrl(url);
    if (!p || esVitrina(p.host) || basura.test(url)) continue;

    const antes = texto.slice(Math.max(0, m.index - 240), m.index);
    const literales = [...antes.matchAll(/["']([A-Za-z0-9 ._\-À-ÿ]{3,40})["']/g)].map((x) => x[1].trim());
    const clave = literales.length ? literales[literales.length - 1] : null;
    if (clave && !/^https?$/i.test(clave) && !/^\/|\.(aspx|html?)$/i.test(clave) && !mapa[clave]) {
      mapa[clave] = url;
    }
    const etiqueta = p.host.split(".")[0];
    if (etiqueta && etiqueta.length >= 4 && !mapa[etiqueta]) mapa[etiqueta] = url;
  }
  return mapa;
}

async function leerMapeoVivo() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    const r = await fetch(MAPEO_URL, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36" },
    });
    clearTimeout(t);
    if (!r.ok) return {};
    const mapa = extraerMapeoRedco(await r.text());
    console.log(`   🗺️ Mapeo vivo de gruporedco.com: ${Object.keys(mapa).length} entradas`);
    return mapa;
  } catch (e) {
    console.log(`   ⚠️ No se pudo leer el mapeo de gruporedco.com (${e.message}) — se usa el mapa semilla`);
    return {};
  }
}

// Decide CONTRA QUÉ INSTANCIA hay que facturar. Orden:
//   1. Una base explícita que ya apunte a una instancia (no a la vitrina).
//   2. El mapeo VIVO de gruporedco.com, casado con el nombre del comercio.
//   3. El mapa semilla.
//   4. La pista de dominio (grupohorizon.com.mx -> HORIZON).
// Devuelve TODOS los orígenes candidatos; quien decide de verdad es el sondeo
// de puertos.
async function resolverInstancia({ baseUrl, portalUrl, urlEstacion, comercio, grupo }) {
  const aguja = [grupo, comercio].filter(Boolean).join(" ");
  const puertosPreferidos = [];
  let hostExplicito = null;
  let pistaVitrina = null;

  for (const cand of [baseUrl, portalUrl, urlEstacion]) {
    const p = partirUrl(cand);
    if (!p) continue;
    if (esVitrina(p.host)) {
      const d = Object.keys(DOMINIOS_VITRINA).find((x) => p.host === x || p.host.endsWith("." + x));
      pistaVitrina = pistaVitrina || DOMINIOS_VITRINA[d];
      continue;
    }
    if (!hostExplicito) {
      hostExplicito = p;
      if (p.puerto) puertosPreferidos.push(p.puerto);
    }
  }

  const vivo = await leerMapeoVivo();
  const mapa = { ...MAPA_SEMILLA, ...vivo };
  const disponibles = Object.keys(mapa);

  // GANA LA CLAVE MÁS ESPECÍFICA, no la primera: el comercio del ticket dice
  // "RedCo / Grupo Horizon", y si el mapeo vivo publica una entrada genérica
  // "REDCO" además de "HORIZON", quedarse con la primera que case mandaría el
  // bot a la instancia equivocada de la alianza.
  const mejorClave = (needle) =>
    disponibles
      .filter((c) => needle && coincide(c, needle))
      .sort((a, b) => norm(b).length - norm(a).length)[0] || null;

  let grupoElegido = mejorClave(aguja) || (pistaVitrina ? mejorClave(pistaVitrina) : null);
  const urlGrupo = grupoElegido ? mapa[grupoElegido] : null;

  // El mismo grupo puede estar publicado en varias claves (nombre y etiqueta
  // DNS) con PUERTOS distintos: todos entran como pista.
  if (grupoElegido) {
    const host = (partirUrl(urlGrupo) || {}).host;
    for (const clave of disponibles) {
      const p = partirUrl(mapa[clave]);
      if (p && p.host === host && p.puerto) puertosPreferidos.push(p.puerto);
    }
  }

  let origenes = [];
  if (hostExplicito) origenes = origenesDe(hostExplicito.host, puertosPreferidos, hostExplicito.esquema);
  if (grupoElegido) {
    const p = partirUrl(urlGrupo);
    if (p) origenes = [...origenes, ...origenesDe(p.host, puertosPreferidos, p.esquema)];
  }

  return {
    origenes: [...new Set(origenes)],
    grupo: grupoElegido,
    hostExplicito: hostExplicito ? hostExplicito.host : null,
    fuente: hostExplicito ? "parámetro del ticket" : vivo[grupoElegido] ? "mapeo vivo de gruporedco.com" : "mapa semilla",
    disponibles,
  };
}

async function facturarRedco(datos = {}) {
  const {
    folio, referencia, folioFacturacion,
    total, importe, monto,
    rfc, razonSocial, codigoPostal, regimenFiscal, usoCfdi,
    emailEntrega, ticketId, comercio, grupo, formaPago,
    baseUrl, portalUrl, urlEstacion,
  } = datos;

  // ── 1. VALIDACIÓN ANTES DE ABRIR EL NAVEGADOR ────────────────────────────
  const rfcLimpio = String(rfc || "").trim().toUpperCase().replace(/[\s\-]/g, "");
  const faltan = [];
  if (!/^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/.test(rfcLimpio)) faltan.push("RFC del receptor válido");

  // Trampa de "los dos folios": se prueban los dos, el alfanumérico primero.
  const brutos = [folioFacturacion, referencia, folio]
    .map((v) => String(v == null ? "" : v).trim())
    .filter(Boolean);
  const unicos = [...new Set(brutos)];
  const candidatosFolio = folioFacturacion
    ? unicos // si el llamador dice explícitamente cuál es, se respeta su orden
    : [...unicos.filter((v) => /[A-Za-z]/.test(v)), ...unicos.filter((v) => !/[A-Za-z]/.test(v))];
  if (!candidatosFolio.length) faltan.push('"Folio de Facturación" (el folio o la referencia impresos en el ticket)');

  const totalTicket = aNumero(total != null ? total : importe != null ? importe : monto);
  if (!Number.isFinite(totalTicket) || totalTicket <= 0) faltan.push("importe total del ticket");

  if (faltan.length) {
    return {
      ok: false,
      error_code: "datos_invalidos",
      msg: `RedCo: faltan datos del ticket — ${faltan.join(", ")}.`,
    };
  }

  // Si el OCR dejó dos importes distintos NO se elige uno a dedo: se aborta.
  // El Importe es el dato con el que el portal identifica la venta; escribir
  // el que no es acaba, en el mejor caso, en "no encontrado" y, en el peor, en
  // un CFDI por una cantidad que no es la del ticket.
  for (const otro of [importe, monto]) {
    const n = aNumero(otro);
    if (Number.isFinite(n) && n > 0 && Math.abs(n - totalTicket) > 0.5) {
      return {
        ok: false,
        error_code: "datos_invalidos",
        msg: `RedCo: el ticket trae dos importes que no cuadran ($${totalTicket} vs $${n}). Hay que releer la foto antes de facturar — emitir un CFDI por el importe equivocado es peor que no emitirlo.`,
      };
    }
  }

  // ⚠️ El correo del portal SIEMPRE es el buzón de captura, nunca el del
  // residente: si el CFDI va a otro buzón, la factura se emite y el ticket se
  // queda esperando para siempre.
  const correoEntrega = String(emailEntrega || BUZON_DEFECTO).trim();

  console.log("🤖 Iniciando bot RedCo (facturaenlinea.aspx)...");
  console.log(`   Comercio: ${comercio || grupo || "?"} | RFC: ${rfcLimpio} | Total: $${totalTicket}`);
  console.log(`   Folios a probar (en orden): ${candidatosFolio.join(" , ")}`);

  // ── 2. RESOLUCIÓN DE LA INSTANCIA (sin navegador todavía) ────────────────
  const inst = await resolverInstancia({ baseUrl, portalUrl, urlEstacion, comercio, grupo });
  if (!inst.origenes.length) {
    return {
      ok: false,
      error_code: "datos_invalidos",
      email_contacto: EMAIL_ALIANZA,
      msg: `RedCo: no se pudo identificar a qué instancia de facturaenlinea.aspx pertenece "${comercio || grupo || "(sin comercio)"}". Grupos conocidos: ${inst.disponibles.slice(0, 20).join(", ")}. Se resuelve pasando baseUrl/portalUrl con el host:puerto de la estación.`,
    };
  }
  console.log(`   Instancia: grupo "${inst.grupo || inst.hostExplicito}" (${inst.fuente}) — ${inst.origenes.length} orígenes a sondear`);

  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error("BROWSERLESS_TOKEN no definido");

  let browser;
  try {
    browser = await puppeteer.connect({
      browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true`,
    });
  } catch (e) {
    return { ok: false, error_code: "reintentar_despues", msg: `RedCo: no se pudo conectar a Browserless — ${e.message}` };
  }

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1000 });
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");

  // Hooks de descarga ANTES de cargar nada: no se sabe cómo entrega este
  // portal (punto 1 de la cabecera). Se cubren los dos mecanismos habituales
  // de ASP.NET/DevExpress: <a> con blob y window.open a un .xml/.pdf.
  await page.evaluateOnNewDocument(() => {
    window.__descargas = [];
    window.__aperturas = [];
    const wOpen = window.open;
    window.open = function (u) {
      try { if (u) window.__aperturas.push(String(u)); } catch (e) {}
      try { return wOpen.apply(window, arguments); } catch (e) { return null; }
    };
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      try {
        if (this.href && this.href.startsWith("blob:")) {
          const name = this.download || "";
          fetch(this.href)
            .then((r) => r.blob())
            .then((b) => new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(b); }))
            .then((dataUrl) => window.__descargas.push({ name, dataUrl }))
            .catch(() => {});
          return;
        }
      } catch (e) {}
      return origClick.apply(this, arguments);
    };
  });

  // page.on('dialog') SIEMPRE: un alert() sin manejar cuelga el hilo y
  // Browserless mata la pestaña. Además el mensaje del alert suele ser LA
  // respuesta del portal ("folio ya facturado", "importe incorrecto").
  let ultimoDialog = null;
  // Se pone en true en cuanto sale el click que EMITE. Fuera del try a
  // proposito: el catch lo necesita.
  let timbradoDisparado = false;
  page.on("dialog", async (d) => {
    ultimoDialog = d.message();
    console.log(`💬 ALERT: "${d.message()}"`);
    try { await d.accept(); } catch (e) {}
  });

  const ts = ticketId || Date.now();
  async function screenshot(label) {
    try {
      const buf = await page.screenshot({ fullPage: true });
      const u = await subirArchivoR2(buf, `debug/redco_${ts}_${label}_${Date.now()}.png`, "image/png");
      console.log(`📸 [${label}]: ${u}`);
    } catch (e) {}
  }
  // Devuelve "" en vez de reventar si la página está navegando justo en ese
  // instante (cada botón de ASP.NET es un postback).
  const texto = () => page.evaluate(() => document.body.innerText.replace(/\s+/g, " ")).catch(() => "");
  const cerrar = async () => { try { await browser.close(); } catch (e) {} };
  // ⚠️ `fallo` NO cierra el navegador: cuando el portal rechaza el primer
  // folio hay que seguir en la misma sesión para probar el otro (trampa de los
  // dos folios). El cierre es SIEMPRE del llamador, al final.
  const fallo = async (label, error_code, msg, extra) => {
    await screenshot(label);
    return Object.assign({ ok: false, error_code, msg }, extra || {});
  };

  // DevExpress: TECLEAR de verdad y comprobar que el valor quedó. Poner .value
  // deja el campo lleno en pantalla y vacío para el framework.
  async function teclear(sel, valor) {
    const el = await page.$(sel);
    if (!el) return null;
    try {
      await el.click({ clickCount: 3 });
      await page.keyboard.press("Backspace");
    } catch (e) {}
    await page.keyboard.type(String(valor), { delay: 60 });
    await page.evaluate((s) => {
      const e = document.querySelector(s);
      if (!e) return;
      e.dispatchEvent(new Event("change", { bubbles: true }));
      e.blur();
    }, sel).catch(() => {});
    await sleep(400);
    return await page.$eval(sel, (e) => e.value).catch(() => null);
  }

  // Solo los mensajes de validación VISIBLES: DevExpress deja los <span> de
  // error en el DOM aunque estén ocultos, y darlos por buenos hacía descartar
  // formatos de importe que en realidad el portal había aceptado.
  const erroresVisibles = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll("span,div,td,li,p"))
        .filter((e) => e.children.length === 0 && e.offsetParent !== null && /valor no v[aá]lid|campo.{0,12}(requerid|obligatori)|dato.{0,12}(inv[aá]lid|incorrect)/i.test(e.textContent || ""))
        .map((e) => (e.textContent || "").trim())
        .slice(0, 5)
    ).catch(() => []);

  // Todos los importes que el PORTAL pinta en pantalla (texto y valores de los
  // campos visibles). Es con lo que se cruza el total del ticket antes de
  // timbrar.
  async function montosEnPantalla() {
    const t = await texto();
    const valores = await page.evaluate(() =>
      Array.from(document.querySelectorAll("input"))
        .filter((i) => i.offsetParent !== null && i.type !== "hidden")
        .map((i) => i.value || "")
        .join(" ")
    ).catch(() => "");
    const todo = `${t} ${valores}`;
    return [...todo.matchAll(/([0-9]{1,3}(?:,[0-9]{3})+\.[0-9]{2}|[0-9]+\.[0-9]{2})/g)]
      .map((m) => parseFloat(m[1].replace(/,/g, "")))
      .filter((n) => Number.isFinite(n) && n > 0);
  }

  // Click que PUEDE NAVEGAR. Va envuelto en Promise.all con waitForNavigation
  // porque, si navega y el evaluate siguiente corre sin esperar, revienta con
  // "Execution context was destroyed" DESPUÉS de que el click ya salió: la
  // factura queda emitida y el ticket marcado como error, que es justo lo que
  // invita a reintentar y a duplicar el CFDI. Si el botón resuelve por
  // callback de DevExpress no hay navegación y el wait simplemente agota su
  // plazo: perder un minuto es infinitamente más barato que duplicar un CFDI.
  async function clickQuePuedeNavegar(fnClick) {
    const [, r] = await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }).catch(() => {}),
      fnClick(),
    ]);
    await sleep(2500);
    return r;
  }
  const clickSelector = (sel) =>
    page.evaluate((s) => { const b = document.querySelector(s); if (!b) return false; b.click(); return true; }, sel).catch(() => false);
  const clickPorTexto = (patron) =>
    page.evaluate((p) => {
      const re = new RegExp(p, "i");
      const b = Array.from(document.querySelectorAll("input[type=submit],input[type=button],button,a"))
        .find((x) => x.offsetParent !== null && re.test((x.value || x.textContent || "").trim()));
      if (!b) return null;
      b.click();
      return (b.value || b.textContent || "").trim().slice(0, 40);
    }, patron).catch(() => null);

  // Campos visibles con su rótulo, calculado por POSICIÓN (encima o a la
  // izquierda). DevExpress FormLayout no usa <label for>, así que no hay otra
  // forma de saber qué pide cada caja.
  const camposVisibles = () =>
    page.evaluate(() => {
      const textos = Array.from(document.querySelectorAll("td,label,span,div,p,th"))
        .filter((e) => e.children.length === 0 && e.offsetParent !== null && (e.textContent || "").trim().length > 2)
        .map((e) => ({ txt: e.textContent.trim(), r: e.getBoundingClientRect() }));
      return Array.from(document.querySelectorAll("input,select,textarea"))
        .filter((i) => i.offsetParent !== null && !["hidden", "button", "submit", "image", "reset"].includes(i.type) && i.getBoundingClientRect().width > 30)
        .map((i) => {
          const r = i.getBoundingClientRect();
          const cerca = textos
            .filter((t) =>
              (t.r.bottom <= r.top + 6 && r.top - t.r.bottom < 60 && Math.abs(t.r.left - r.left) < 220) ||
              (t.r.right <= r.left + 8 && r.left - t.r.right < 280 && Math.abs(t.r.top - r.top) < 26))
            .sort((a, b) =>
              Math.abs(a.r.top - r.top) + Math.abs(a.r.left - r.left) - (Math.abs(b.r.top - r.top) + Math.abs(b.r.left - r.left)))[0];
          return {
            id: i.id || "",
            name: i.name || "",
            tag: i.tagName.toLowerCase(),
            tipo: i.type || "",
            ph: i.placeholder || "",
            rotulo: cerca ? cerca.txt.slice(0, 60) : "",
            valor: i.value || "",
          };
        });
    }).catch(() => []);

  // Combo DevExpress por su API de cliente (no por clicks: el desplegable no
  // se abre con un click sintético y las clases llevan sufijo de tema).
  const elegirCombo = (id, opciones) =>
    page.evaluate((idc, ops) => {
      const col = window.ASPxClientControl && window.ASPxClientControl.GetControlCollection
        ? window.ASPxClientControl.GetControlCollection() : null;
      if (!col) return null;
      const base = idc.replace(/_I$/, "");
      const c = (col.Get && col.Get(base)) || (col.GetByName && col.GetByName(base));
      if (!c || !c.GetItemCount) return null;
      const n = c.GetItemCount();
      for (const op of ops) {
        const o = String(op).toUpperCase();
        for (let i = 0; i < n; i++) {
          const it = c.GetItem(i);
          if (!it) continue;
          const v = String(it.value == null ? "" : it.value).toUpperCase();
          const tx = String(it.text == null ? "" : it.text).toUpperCase();
          if (v === o || tx.includes(o)) { c.SetSelectedIndex(i); return it.text; }
        }
      }
      return null;
    }, id, opciones).catch(() => null);

  const elegirSelect = (id, opciones) =>
    page.evaluate((idc, ops) => {
      const s = document.getElementById(idc);
      if (!s || s.tagName.toLowerCase() !== "select") return null;
      for (const op of ops) {
        const o = String(op).toUpperCase();
        const hit = Array.from(s.options).find((x) =>
          String(x.value).toUpperCase() === o || String(x.text).toUpperCase().includes(o));
        if (hit) {
          s.value = hit.value;
          s.dispatchEvent(new Event("change", { bubbles: true }));
          return hit.text;
        }
      }
      return null;
    }, id, opciones).catch(() => null);

  // Recoge XML/PDF si el portal los ofrece. Si no, el camino es el correo.
  async function capturarArchivos() {
    const urls = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll("a[href]").forEach((a) => {
        const h = a.href || "";
        if (/^https?:/i.test(h) && /\.(xml|pdf)(\?|$)/i.test(h)) out.push(h);
      });
      (window.__aperturas || []).forEach((u) => { if (/\.(xml|pdf)(\?|$)/i.test(u)) out.push(u); });
      return Array.from(new Set(out));
    }).catch(() => []);

    const piezas = [];
    for (const u of urls.slice(0, 6)) {
      const dataUrl = await page.evaluate(async (url) => {
        try {
          const r = await fetch(url, { credentials: "include" });
          if (!r.ok) return null;
          const b = await r.blob();
          return await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(b); });
        } catch (e) { return null; }
      }, u).catch(() => null);
      if (dataUrl) piezas.push({ name: u, dataUrl });
    }
    const blobs = await page.evaluate(() => window.__descargas || []).catch(() => []);
    for (const b of blobs) if (b && b.dataUrl) piezas.push(b);

    let xmlBuf = null;
    let pdfBuf = null;
    for (const p of piezas) {
      const buf = Buffer.from(String(p.dataUrl).split(",")[1] || "", "base64");
      if (buf.length < 100) continue;
      const cab = buf.slice(0, 8).toString("latin1");
      if (cab.startsWith("%PDF") || /\.pdf(\?|$)/i.test(p.name || "")) pdfBuf = pdfBuf || buf;
      else if (cab.includes("<?xml") || /\.xml(\?|$)/i.test(p.name || "")) xmlBuf = xmlBuf || buf;
    }
    if (!xmlBuf && !pdfBuf) return null;

    const marca = `${ts}_${Date.now()}`;
    const xmlUrl = xmlBuf ? await subirArchivoR2(xmlBuf, `facturas/redco_${marca}.xml`, "application/xml") : null;
    const pdfUrl = pdfBuf ? await subirArchivoR2(pdfBuf, `facturas/redco_${marca}.pdf`, "application/pdf") : null;
    return { xmlUrl, pdfUrl };
  }

  // ── Sondeo de puertos: aquí se decide contra qué URL se factura ──────────
  // Devuelve la URL del formulario, "DNS" si el nombre ni siquiera resuelve (y
  // entonces no hay por qué probar los otros 16 puertos de ese host), o null si
  // ese puerto no sirve.
  async function abrirFormulario(origen) {
    for (const ruta of [RUTA_FORM, "/"]) {
      let resp;
      try {
        resp = await page.goto(origen + ruta, { waitUntil: "domcontentloaded", timeout: 15000 });
      } catch (e) {
        // No conectó: puerto cerrado, filtrado o DNS muerto. Probar "/" en el
        // mismo origen sería quemar otros 15 s para nada — y con 17 puertos por
        // host eso se come el presupuesto de sondeo antes de llegar al bueno.
        if (/ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION/i.test(e.message || "")) return "DNS";
        return null;
      }
      if (resp && resp.status() >= 400) continue;  // conectó, pero esa ruta no es
      try {
        await page.waitForSelector(SEL.rfc, { visible: true, timeout: 8000 });
        return origen + ruta;
      } catch (e) { /* hay servidor, pero no es el formulario: probar la otra ruta */ }
    }
    return null;
  }

  let urlFormulario = null;
  try {
    console.log("🔌 Sondeando puertos (el publicado suele estar caído — ver cabecera)...");
    const t0 = Date.now();
    const hostsMuertos = [];
    for (const o of inst.origenes) {
      if (Date.now() - t0 > 180000) { console.log("   ⏱️ Límite de sondeo alcanzado"); break; }
      const host = (partirUrl(o) || {}).host;
      if (hostsMuertos.includes(host)) continue;
      const r = await abrirFormulario(o);
      if (r === "DNS") { console.log(`   · ${host} no resuelve — se saltan sus demás puertos`); hostsMuertos.push(host); continue; }
      if (r) { urlFormulario = r; console.log(`   ✔️ Instancia viva: ${urlFormulario}`); break; }
      console.log(`   · ${o} no responde`);
    }
  } catch (e) {
    const r = await fallo("sondeo_excepcion", "reintentar_despues", `RedCo: fallo sondeando la instancia — ${e.message}`, { email_contacto: EMAIL_ALIANZA });
    await cerrar();
    return r;
  }

  if (!urlFormulario) {
    // No es culpa del ticket: es el portal (DDNS doméstico con puerto móvil).
    // Por eso reintentar_despues, no datos_invalidos. Se manda el correo de la
    // alianza para que el sistema pueda reclamar la factura por correo si esto
    // se vuelve permanente.
    const r = await fallo(
      "sin_instancia_viva",
      "reintentar_despues",
      `RedCo: ninguna instancia de ${inst.grupo || inst.hostExplicito} respondió en los puertos probados (${PUERTOS_CONOCIDOS.slice(0, 6).join(", ")}...). Es un DDNS doméstico con el puerto móvil: suele volver solo. Si no vuelve, hay que pedir la URL nueva o reclamar la factura por correo.`,
      { email_contacto: EMAIL_ALIANZA }
    );
    await cerrar();
    return r;
  }

  // ── 3. INTENTO DE FACTURACIÓN (con la trampa de los dos folios) ──────────
  // `probarOtroFolio` solo se pone a true cuando el portal RECHAZÓ el folio
  // SIN emitir nada. Nunca después de una emisión: reintentar ahí sería
  // duplicar el CFDI.
  async function intentar(folioUsado, indice) {
    if (indice > 0) {
      await page.goto(urlFormulario, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForSelector(SEL.rfc, { visible: true, timeout: 15000 });
    }
    ultimoDialog = null;
    let avisoMonto = "";

    const puestoRfc = await teclear(SEL.rfc, rfcLimpio);
    if (!igualito(puestoRfc, rfcLimpio)) {
      return { res: await fallo(`p0_rfc_${indice}`, "reintentar_despues", `RedCo: el campo RFC no aceptó el valor (quedó "${puestoRfc}"). El formulario pudo cambiar de ids DevExpress.`) };
    }
    const puestoFolio = await teclear(SEL.folio, folioUsado);
    if (!igualito(puestoFolio, folioUsado)) {
      return { res: await fallo(`p0_folio_${indice}`, "reintentar_despues", `RedCo: el campo "Folio de Facturación" no aceptó "${folioUsado}" (quedó "${puestoFolio}").`) };
    }

    // El Importe tiene validación de cliente ("Valor no válido") y no se sabe
    // qué formato espera la cultura del servidor: se prueban las formas
    // habituales, TODAS con el MISMO valor del ticket (jamás redondeado).
    const variantes = [...new Set([
      totalTicket.toFixed(2),
      String(totalTicket),
      totalTicket.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    ])];
    let importePuesto = null;
    for (const v of variantes) {
      const puesto = await teclear(SEL.importe, v);
      if (puesto == null) break;
      await sleep(500);
      const errs = await erroresVisibles();
      if (errs.some((e) => /valor no v[aá]lid/i.test(e))) {
        console.log(`   · el portal rechazó el formato de importe "${v}"`);
        continue;
      }
      if (Math.abs(aNumero(puesto) - totalTicket) > 0.01) {
        console.log(`   · el campo reformateó "${v}" a "${puesto}" con otro valor — se descarta`);
        continue;
      }
      importePuesto = puesto;
      break;
    }
    if (importePuesto == null) {
      return { res: await fallo(`p0_importe_${indice}`, "datos_invalidos", `RedCo: el campo Importe rechazó todas las formas de escribir $${totalTicket} ("Valor no válido"). Hay que revisar el total en la foto del ticket.`) };
    }
    console.log(`   ✔️ Formulario: RFC ${rfcLimpio} | Folio "${folioUsado}" | Importe ${importePuesto}`);
    await screenshot(`p1_form_${indice}`);

    const idsAntes = (await camposVisibles()).map((c) => c.id).filter(Boolean);

    console.log("🧾 Pulsando Facturar...");
    // A partir de aquí el CFDI puede existir. El catch general lo mira para no
    // devolver un error reintentable: `reintentar_despues` manda el ticket al
    // portal CADA NOCHE, y su aviso "comprobar antes de relanzar" lo lee una
    // persona, no el sistema — el sistema solo mira el error_code.
    timbradoDisparado = true;
    const pulsado = await clickQuePuedeNavegar(() => clickSelector(SEL.facturar));
    if (pulsado === false) {
      // No se encontró el botón: no salió ningún click, así que reintentar es
      // seguro y hay que revertir la bandera.
      timbradoDisparado = false;
      return { res: await fallo(`p1_sin_boton_${indice}`, "reintentar_despues", "RedCo: no se encontró el botón Facturar (#ASPxFormLayout1_Btn_Facturar_I) — el formulario pudo cambiar.") };
    }

    let t = await texto();
    const aviso = ultimoDialog || "";
    await screenshot(`p2_post_facturar_${indice}`);
    const conjunto = `${aviso} ${t}`;

    // ── a) plazo vencido ──────────────────────────────────────────────────
    if (/fuera de(l)? (plazo|periodo|per[ií]odo|mes)|venci(d|ó|o)|caduc|ya no (se )?puede (facturar|generar)|plazo.{0,20}(expir|termin)/i.test(conjunto)) {
      return { res: await fallo(`p2_vencido_${indice}`, "ticket_vencido", `RedCo: el portal no acepta este consumo por plazo — "${(conjunto.match(/[^.]{0,140}(venci|fuera de|caduc|plazo)[^.]{0,80}/i) || [""])[0].trim()}"`, { email_contacto: EMAIL_ALIANZA, permite_solicitud_correo: true }) };
    }

    // ── b) ya facturado ───────────────────────────────────────────────────
    if (/ya (fue|ha sido|est[aá]|se) facturad|previamente facturad|factura ya (existe|fue generada)|ya cuenta con (su )?factura|folio ya (usado|utilizado)/i.test(conjunto)) {
      const arch = await capturarArchivos();
      if (arch) {
        console.log("♻️ El folio ya estaba facturado, pero el portal dejó recuperar el CFDI");
        return { res: { ok: true, xmlUrl: arch.xmlUrl, pdfUrl: arch.pdfUrl } };
      }
      return { res: await fallo(`p2_ya_facturado_${indice}`, "ya_facturado", `RedCo: el folio "${folioUsado}" YA está facturado y el portal no ofreció el CFDI para descargar${aviso ? ` (alert: "${aviso}")` : ""}. Hay que pedirlo a la estación o a ${EMAIL_ALIANZA}.`, { email_contacto: EMAIL_ALIANZA }) };
    }

    // ── c) el portal no reconoce los datos -> probar el OTRO folio ────────
    if (/no (se )?(encontr|existe|hay (datos|registro|resultados))|folio.{0,24}(inv[aá]lid|incorrect|no v[aá]lid)|datos.{0,20}(inv[aá]lid|incorrect|no coinciden)|no coincide|sin resultados|verifique (sus )?datos|intente de nuevo/i.test(conjunto)) {
      console.log(`   ✖ El portal rechazó "${folioUsado}" sin emitir nada`);
      return {
        probarOtroFolio: true,
        res: await fallo(
          `p2_no_encontrado_${indice}`,
          "datos_invalidos",
          `RedCo: el portal no encontró la venta con Folio de Facturación "${candidatosFolio.join('" ni "')}" e Importe $${totalTicket}${aviso ? ` (alert: "${aviso}")` : ""}. Es la trampa de los dos folios: se probaron los ${candidatosFolio.length} candidatos del ticket y ninguno cuadró — hay que releer la foto (el dato bueno puede ser otro código impreso).`
        ),
      };
    }

    // ── d) ¿apareció un SEGUNDO PASO? (no confirmado: ver cabecera) ───────
    let campos = await camposVisibles();
    const nuevos = campos.filter((c) => c.id && !idsAntes.includes(c.id));
    const pideFiscales = campos.some((c) =>
      /raz[oó]n\s*social|c[oó]digo\s*postal|r[eé]gimen|uso.{0,12}cfdi|correo|e-?mail|forma.{0,6}de.{0,6}pago/i.test(`${c.rotulo} ${c.id} ${c.name} ${c.ph}`));

    if (nuevos.length && pideFiscales) {
      console.log(`📝 Segundo paso detectado (${nuevos.length} campos nuevos) — llenando datos fiscales...`);
      const esTarjeta = /debito|débito|credito|crédito|visa|master|amex|tarjeta/i.test(String(formaPago || ""));
      const esCredito = /credito|crédito/i.test(String(formaPago || ""));
      // ⚠️ EL ORDEN IMPORTA: gana el primer patrón que case. "Razón social
      // asociada al RFC" contiene "RFC", así que la regla del RFC va la última
      // o el RFC acaba escrito en la razón social.
      const REGLAS = [
        { re: /raz[oó]n\s*social|nombre.{0,20}(fiscal|receptor|contribuyente)/i, valor: razonSocial },
        { re: /c[oó]digo\s*postal|domicilio\s*fiscal|\bc\.?p\.?\b/i, valor: codigoPostal },
        { re: /r[eé]gimen/i, opciones: [String(regimenFiscal || "601"), "General de Ley Personas Morales", "Personas Morales"] },
        { re: /uso.{0,12}(cfdi|factura)|cfdi.{0,12}uso/i, opciones: [String(usoCfdi || "G03"), "Gastos en general"] },
        { re: /forma.{0,6}de.{0,6}pago/i, opciones: esTarjeta ? [esCredito ? "crédito" : "débito", "tarjeta"] : ["efectivo"] },
        { re: /correo|e-?mail/i, valor: correoEntrega },
        { re: /r\.?f\.?c\.?|registro federal/i, valor: rfcLimpio },
      ];

      const sinResolver = [];
      for (const c of nuevos) {
        const pista = `${c.rotulo} ${c.id} ${c.name} ${c.ph}`;
        const regla = REGLAS.find((r) => r.re.test(pista));
        if (!regla) { if (!c.valor) sinResolver.push(c.rotulo || c.id); continue; }
        if (regla.opciones) {
          const elegido = (await elegirSelect(c.id, regla.opciones)) || (await elegirCombo(c.id, regla.opciones));
          if (elegido) console.log(`   · ${c.rotulo || c.id}: ${String(elegido).slice(0, 40)}`);
          else if (!c.valor) sinResolver.push(c.rotulo || c.id);
        } else if (regla.valor) {
          const puesto = await teclear(`#${c.id}`, regla.valor);
          if (puesto) console.log(`   · ${c.rotulo || c.id}: ${String(puesto).slice(0, 40)}`);
          else sinResolver.push(c.rotulo || c.id);
        } else if (!c.valor) {
          sinResolver.push(`${c.rotulo || c.id} (el ticket no trae ese dato)`);
        }
        await sleep(300);
      }
      await screenshot(`p3_segundo_paso_${indice}`);

      if (sinResolver.length) {
        // No se timbra a medias: un campo fiscal vacío o mal puesto emite un
        // CFDI incorrecto, y eso no tiene vuelta atrás.
        return { res: await fallo(`p3_campos_sin_datos_${indice}`, "datos_invalidos", `RedCo: el segundo paso del portal pide datos que el bot no supo llenar: ${sinResolver.slice(0, 6).join(", ")}. Este paso NO estaba confirmado en el reconocimiento — hay que verlo en vivo y ajustar el bot antes de dejarlo timbrar.`) };
      }

      // VERIFICACIÓN DE MONTO ANTES DE TIMBRAR. Emitir un CFDI que no
      // corresponde es peor que no emitirlo.
      const montos = await montosEnPantalla();
      if (montos.length && !montos.some((n) => Math.abs(n - totalTicket) <= 1)) {
        return { res: await fallo(`p3_monto_no_cuadra_${indice}`, "datos_invalidos", `RedCo: el portal muestra ${montos.slice(0, 5).map((n) => "$" + n).join(", ")} y el ticket dice $${totalTicket}. No se timbra.`) };
      }
      console.log(montos.length ? `   ✔ Monto verificado contra el portal ($${totalTicket})` : "   ⚠️ El portal no muestra importe: no se pudo cruzar (se escribió el del ticket)");

      console.log("🧾 Confirmando el segundo paso...");
      const etiqueta = await clickQuePuedeNavegar(() => clickPorTexto("^\\s*(facturar|generar|timbrar|confirmar|aceptar|continuar|finalizar)"));
      if (!etiqueta) {
        return { res: await fallo(`p3_sin_boton_${indice}`, "reintentar_despues", "RedCo: el segundo paso no ofreció un botón reconocible para confirmar. Paso no confirmado en el reconocimiento: hay que verlo en vivo.") };
      }
      console.log(`   · pulsado "${etiqueta}"`);
      t = await texto();
      await screenshot(`p4_post_confirmar_${indice}`);
    } else {
      // UN SOLO PASO. Aquí la verificación del monto tiene que ser ANTES del
      // click, y lo es: el Importe que se tecleó ES el total del ticket (se
      // comprobó arriba que el OCR no trae dos importes distintos) y el portal
      // solo acepta el folio si ese importe cuadra con su propia venta. Después
      // del click ya no hay nada que abortar — el CFDI existe. Lo que queda es
      // DECIRLO si el portal pinta otra cifra, no callarlo.
      const montos = await montosEnPantalla();
      if (montos.length && !montos.some((n) => Math.abs(n - totalTicket) <= 1)) {
        avisoMonto = `⚠️ El portal muestra ${montos.slice(0, 5).map((n) => "$" + n).join(", ")} y el ticket dice $${totalTicket}: revisar que el CFDI emitido sea el de esta venta.`;
        console.log(`   ${avisoMonto}`);
      }
    }

    // ── e) éxito ──────────────────────────────────────────────────────────
    const exito = /(factura|cfdi|comprobante).{0,50}(gener|emiti|timbr|cread|realiz)|exitosamente|con éxito|con exito|descargar.{0,20}(xml|pdf)|se (ha )?envi[oó]|enviad[oa].{0,20}correo/i.test(`${aviso} ${t}`);
    if (exito) {
      console.log("✅ El portal confirma la emisión");
      const arch = await capturarArchivos();
      if (arch && (arch.xmlUrl || arch.pdfUrl)) {
        console.log(`✅ RedCo OK — XML: ${arch.xmlUrl} | PDF: ${arch.pdfUrl}`);
        return { res: Object.assign({ ok: true, xmlUrl: arch.xmlUrl, pdfUrl: arch.pdfUrl }, avisoMonto ? { msg: `RedCo: ${avisoMonto}` } : {}) };
      }
      // Sin archivos a mano: queda el correo. Si el portal nunca pidió un
      // correo, el CFDI se fue al que tenga registrado el RFC y puede que no
      // llegue al buzón — se dice en el msg en vez de fingir que todo está bien.
      const pidioCorreo = campos.some((c) => /correo|e-?mail/i.test(`${c.rotulo} ${c.id} ${c.name} ${c.ph}`));
      console.log("📧 Sin descarga directa — queda en manos del correo (IMAP)");
      return {
        res: {
          ok: true,
          procesandoCorreo: true,
          msg: [
            avisoMonto ? `RedCo: ${avisoMonto}` : "",
            pidioCorreo
              ? ""
              : `RedCo: CFDI emitido (folio "${folioUsado}"), pero el portal no pidió correo de envío: puede haber ido al buzón registrado del RFC y no al de captura. Si no entra por IMAP hay que recuperarlo del portal — NO relanzar el bot, se duplicaría.`,
          ].filter(Boolean).join(" ") || undefined,
        },
      };
    }

    // ── f) no se entendió nada: NO se da por no emitido ───────────────────
    // Se listan los botones que quedaron en pantalla: si hay un "Continuar" o
    // un "Aceptar" pendiente, el flujo se quedó a medias (nada emitido) y el
    // reconocimiento en vivo tiene que seguir por ahí. El bot NO lo pulsa a
    // ciegas: ese click puede ser justo el que timbra.
    const botones = await page.evaluate(() =>
      Array.from(document.querySelectorAll("input[type=submit],input[type=button],button,a"))
        .filter((b) => b.offsetParent !== null)
        .map((b) => (b.value || b.textContent || "").trim())
        .filter((x) => x && x.length < 40)
        .slice(0, 8)
    ).catch(() => []);
    return {
      res: await fallo(
        `p4_indeterminado_${indice}`,
        "reintentar_despues",
        `RedCo: se pulsó Facturar y el portal no dio una respuesta reconocible${aviso ? ` (alert: "${aviso}")` : ""}. Pantalla: "${t.slice(0, 200)}". Botones visibles: ${botones.join(" | ") || "(ninguno)"}. ⚠️ PUEDE HABERSE EMITIDO: comprobar en el portal antes de relanzar el bot, o se duplica el CFDI.`
      ),
    };
  }

  try {
    let resultado = null;
    for (let i = 0; i < candidatosFolio.length; i++) {
      const folioUsado = candidatosFolio[i];
      console.log(`🎫 Intento ${i + 1}/${candidatosFolio.length} — Folio de Facturación = "${folioUsado}"`);
      const r = await intentar(folioUsado, i);
      const quedan = candidatosFolio.length - 1 - i;
      if (r.probarOtroFolio && quedan > 0) {
        console.log(`   ↩️ Trampa de los dos folios: "${folioUsado}" no sirvió, se prueba "${candidatosFolio[i + 1]}"`);
        continue;
      }
      resultado = r.res;
      break;
    }
    await cerrar();
    return resultado;
  } catch (e) {
    console.error("❌ Error en bot RedCo:", e.message);
    await screenshot("excepcion");
    await cerrar();
    // ⚠️ Si el click de Facturar ya había salido, devolver un error reintentable
    // es peor que no devolver nada: la cola relanza a medianoche y emite un
    // SEGUNDO CFDI. "Execution context was destroyed" es exactamente ese caso —
    // la excepción la provoca la navegación que dispara el propio click.
    if (timbradoDisparado) {
      return {
        ok: true,
        procesandoCorreo: true,
        msg: `RedCo: el bot falló (${e.message}${ultimoDialog ? `; alert: "${ultimoDialog}"` : ""}) DESPUÉS de pulsar Facturar. NO RELANZAR: comprobar primero en el portal si el CFDI ya existe.`,
      };
    }
    return {
      ok: false,
      error_code: "reintentar_despues",
      msg: `RedCo: ${e.message}${ultimoDialog ? ` (alert: "${ultimoDialog}")` : ""} (no se llegó a pulsar Facturar, no se emitió nada).`,
    };
  }
}

module.exports = { facturarRedco };
