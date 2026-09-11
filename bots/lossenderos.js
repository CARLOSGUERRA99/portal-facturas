const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");

/**
 * LOS SENDEROS — facturafranquicias.lossenderos.com.mx/generar-factura
 * Franquicias de las centrales de autobuses de Grupo Estrella Blanca:
 * KFC y SUSHIITTO. Ticket #350 = KFC Central Durango (sucursal 1434, $149).
 *
 * Plataforma AMS Integra: SPA React 18 (CRA) + Redux Toolkit + react-select,
 * sobre la MISMA API que factura.estrellablanca.com.mx
 * (https://apifacturasestrellablanca.amsintegra.com.mx/main, idEmpresa "GEB").
 * Cambia la MARCA, no el backend: el bundle imprime REACT_APP_BRAND="SENDERO".
 * Aun asi este bot es autonomo a proposito — el paso 1 NO es el mismo que el de
 * Estrella Blanca: sendero pide Franquicia + Sucursal + FechaVenta + NoTicket y
 * manda claveTicket=CONSUMO; eb pide #NoComprobante + #NoTr y manda
 * claveTicket=AUTOBUS. Unificarlos es posible pero no es "cambiar el subdominio".
 *
 * ─────────────────────────── LAS TRAMPAS ───────────────────────────
 *
 * ⚠️ LOS DOS FOLIOS (esto tumbo el #350 en el reconocimiento). El campo
 *    "# Comprobante" NO es el "Ticket: 217" que sale arriba del ticket: es el
 *    "No. Ticket Unico: 80" del pie. Con 217 la API responde
 *    {isSuccess:false, errorCode:"E-05", error:"El ticket no se encontro"}.
 *    Por eso este bot resuelve el ticket ANTES de abrir el navegador probando
 *    los candidatos contra GET /Catalogos/obtenerTicket (consulta pura, no
 *    reserva ni factura nada) y se queda con el que el portal reconoce.
 *
 * ⚠️ LA FECHA TIENE QUE SER EXACTA, no hay tolerancia de un dia: 2026-09-03 y
 *    2026-09-05 con el noTicket bueno dan las dos E-05. Y NO se barren fechas
 *    a ciegas a proposito: en comida rapida el numero de ticket se reinicia
 *    cada dia, asi que un "80" del dia siguiente con el mismo importe es OTRO
 *    ticket fisico y facturarlo seria facturar lo que no es.
 *
 * ⚠️ EL VALUE DE #regimenFiscal NO ES LA CLAVE DEL SAT: es el IdRegimenFiscal
 *    del catalogo interno (601 => "1", 603 => "2", 622 => "14", 624 => "16"...).
 *    Si le pones "601" el select no casa y ademas
 *    GET /Catalogos/obtenerUsoCfdi?rfc=..&regimenFiscal=601 devuelve data:[],
 *    con lo que el combo de Uso de CFDI se queda vacio para siempre. Aqui se
 *    elige por la ETIQUETA de la <option> ("601 - General de Ley Personas
 *    Morales"), que es lo unico estable. En #usoCfdi si es la clave del SAT.
 *
 * ⚠️ LOS DOS <select> DEL MODAL LLEGAN CON UNA SOLA <option> (el placeholder) y
 *    se pueblan en cascada por AJAX: el focusout de #rfc dispara
 *    obtenerRegimenFiscal, y elegir regimen dispara obtenerUsoCfdi. No es que
 *    tarden: hasta que no hay interaccion no hay catalogo. Hay que esperar a
 *    que crezca options.length, no a un timeout fijo.
 *
 * ⚠️ NO TOCAR EL BOTON DE LA LUPA que hay junto a #rfc. Llama a
 *    /Catalogos/obtenerReceptor/{RFC} y autorrellena el domicilio, pero escribe
 *    RegimenFiscalReceptor ("601", la clave) dentro de un select cuyas options
 *    son Ids: el select queda visualmente vacio y el envio falla.
 *
 * ⚠️ FRANQUICIA Y SUCURSAL NO SON <select>: son react-select. Poner .value no
 *    hace absolutamente nada. Hay que click + teclear de verdad + Enter, y
 *    RELEER el rotulo del control para confirmarlo. Ademas se DESHABILITAN en
 *    cuanto hay tickets anadidos, asi que se eligen antes que nada.
 *
 * ⚠️ #FechaVenta es <input type=date> y el Chrome de Browserless va en locale
 *    en-US: hay que teclear MMDDYYYY, no YYYY-MM-DD. Tecleando "09042026" el
 *    value queda en "2026-09-04".
 *
 * ⚠️ DOS MODALES TAPAN EL FORMULARIO Y SE COMEN LOS CLICKS EN SILENCIO (sin
 *    error, sin excepcion): el "Aviso Importante" de la CFDI 4.0 que sale al
 *    cargar, y el "Ticket(s) anadido(s)" que sale despues de anadir. Solo se
 *    comen los page.click() de raton; el tecleo de Puppeteer enfoca el campo
 *    por codigo y SI entra, asi que el formulario puede parecer que va bien
 *    mientras el modal sigue delante.
 *
 * ⚠️ NO SE PUEDE DETECTAR ESOS MODALES CON offsetParent. El CSS es
 *    .modal-wrapper{position:fixed;opacity:0;pointer-events:none} y
 *    .modal-wrapper.active{opacity:1;pointer-events:auto} — y offsetParent
 *    devuelve SIEMPRE null en un elemento position:fixed, este delante o no.
 *    Con esa comprobacion el bot "no veia" ningun modal: ni el aviso inicial,
 *    ni el mensaje de error de "Anadir ticket", ni —lo peligroso— el modal de
 *    confirmacion del timbrado. Lo que hay que mirar es la clase .active.
 *
 * ⚠️⚠️ HAY TRES BOTONES QUE SE LLAMAN CASI IGUAL Y SOLO UNO EMITE:
 *      1) modal fiscal  → div.modal button.ternary-second "Facturar"
 *         = PREfactura. POST /Operacion/generarCfdi con isGenerarCFDI:"0".
 *           Inofensivo: devuelve la vista previa y pasa al paso 2.
 *      2) paso 2         → section.datos-fiscales .actions button.primary
 *         "Facturar" = solo ABRE el modal de confirmacion. Tampoco emite.
 *      3) modal de confirmacion (div.modal.steps, titulo "Facturar",
 *         "¿Desea confirmar la emision de la factura?") → button.primary
 *         "Aceptar"  ← ESTE ES EL QUE TIMBRA ANTE EL SAT.
 *      El endpoint es EL MISMO para los dos; lo unico que cambia es
 *      isGenerarCFDI ("0" previsualiza, "1" emite). Un bot que busque botones
 *      por su rotulo pulsa el que no es: hay que filtrar SIEMPRE por clase.
 *
 * ⚠️ EL "Aceptar" DEL AVISO INICIAL Y EL "Aceptar" QUE TIMBRA SON EL MISMO
 *    COMPONENTE (div.modal.steps). Se distinguen porque el de confirmacion
 *    lleva ademas un boton "Cancelar" (isMostrarAceptar=true) y el aviso no.
 *    Este bot comprueba eso antes de pulsar cualquiera de los dos.
 *
 * ─────────────────────── LA PRUEBA DE QUE SE EMITIO ───────────────────────
 * La respuesta del POST que timbra trae data.FacturasTimbradas[] y cada
 * elemento lleva Uuid + ArchivoXML + ArchivoPDF EN BASE64 (la pantalla final
 * no tiene enlaces: los botones de descarga arman un <a download> con esos
 * base64). O sea: el XML y el PDF salen de la propia respuesta, sin descargar
 * nada. Si un elemento trae Error/DetalleError, ESE no se timbro.
 * Como red de seguridad hay ademas una comprobacion independiente por API:
 * GET /Operacion/obtenerCfdis?franquicia=..&sucursal=..&fechaVenta=..&noTicket=..
 * &precio=..&claveTicket=CONSUMO devuelve el CFDI ya emitido (RUTA_XML/RUTA_PDF,
 * que se resuelven con /Operacion/obtenerRutaS3?keyUrl=..). Es lo que permite
 * saber si el ticket ya estaba facturado ANTES de gastar una sesion de
 * Browserless, y si de verdad se emitio DESPUES del click.
 *
 * PLAZO (publicado por el propio portal, arriba del formulario): "A partir de
 * la compra de su ticket, solo tiene el mes en que lo adquirio y hasta 7 dias
 * del mes siguiente para poder generar su factura". Se comprueba antes de
 * abrir el navegador; la API lo confirma con FacturableMes.
 *
 * PRUEBAS SIN TIMBRAR: LOSSENDEROS_PARAR_EN=prefactura|confirmacion detiene el
 * bot en la pantalla anterior al boton que se indique y devuelve un resultado
 * de parada. Sin esa variable el bot hace el ciclo completo. Sirve para
 * verificar selectores en vivo sin emitir un CFDI irreversible.
 */

const URL_PORTAL = "https://facturafranquicias.lossenderos.com.mx/generar-factura";
const API = "https://apifacturasestrellablanca.amsintegra.com.mx/main";
const EMPRESA = "GEB";
const CLAVE_TICKET = "CONSUMO"; // sendero=CONSUMO, eb=AUTOBUS, envia=GUIA
const CORREO_PORTAL = "atencion.cliente@estrellablancasendero.com.mx";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── API de AMS Integra (solo GET de consulta; el POST que factura lo hace la
// pagina, nunca este helper) ────────────────────────────────────────────────
async function apiGet(ruta) {
  const r = await fetch(`${API}${ruta}`, {
    headers: { Accept: "application/json", Origin: "https://facturafranquicias.lossenderos.com.mx", "User-Agent": UA },
  });
  const txt = await r.text();
  try {
    return JSON.parse(txt);
  } catch {
    return { isSuccess: false, error: `respuesta no-JSON (HTTP ${r.status}): ${txt.slice(0, 140)}` };
  }
}

const consultarTicket = (t) =>
  apiGet(`/Catalogos/obtenerTicket/${EMPRESA}?tipo=1&` + new URLSearchParams({
    noComprobante: "", noTr: "", precio: String(t.precio), claveTicket: CLAVE_TICKET,
    franquicia: t.franquicia, noTicket: String(t.noTicket), sucursal: String(t.sucursal), fechaVenta: t.fechaVenta,
  }));

// Misma consulta que la pantalla "Mis Facturas" del portal. Devuelve data:[] si
// el ticket no tiene CFDI, y el CFDI (RUTA_XML/RUTA_PDF) si ya lo tiene.
const consultarCfdis = (t) =>
  apiGet(`/Operacion/obtenerCfdis?` + new URLSearchParams({
    rfc: "", folio: "", fecha: "", claveTicket: CLAVE_TICKET,
    franquicia: t.franquicia, sucursal: String(t.sucursal), fechaVenta: t.fechaVenta,
    noTicket: String(t.noTicket), precio: String(t.precio),
  }));

// keyUrl se manda SIN codificar, igual que lo hace el portal.
async function bajarDeS3(keyUrl) {
  if (!keyUrl) return null;
  try {
    const j = await apiGet(`/Operacion/obtenerRutaS3?keyUrl=${keyUrl}`);
    if (!j || !j.isSuccess || !j.data) return null;
    const r = await fetch(j.data);
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch {
    return null;
  }
}

// ── Datos del ticket ────────────────────────────────────────────────────────
function aFechaISO(v) {
  const s = String(v || "").trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})/); // DD/MM/YYYY, que es como lo guarda el OCR
  if (m) return `${m[3]}-${String(m[2]).padStart(2, "0")}-${String(m[1]).padStart(2, "0")}`;
  return null;
}

// "El mes en que lo adquirio y hasta 7 dias del mes siguiente". No son 30 dias
// ni un mes movil: es el dia 7 del mes SIGUIENTE, a las 23:59.
function limitePlazo(fechaISO) {
  const [y, m] = fechaISO.split("-").map(Number);
  const d = new Date(y, m, 7, 23, 59, 59); // m ya es 1-based => mes siguiente en base 0
  // Se rotula a mano: toISOString() lo pasaria a UTC y el dia 7 a las 23:59 de
  // Mexico se imprimiria como dia 8, que no es el plazo que publica el portal.
  d.etiqueta = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return d;
}

// El catalogo real solo tiene dos franquicias: KFC y SUS (SUSHIITTO).
function sacarFranquicia(datos) {
  const crudo = String(datos.franquicia || "").trim().toUpperCase();
  if (crudo === "KFC" || crudo === "SUS") return crudo;
  const texto = `${datos.comercio || ""} ${datos.sucursalNombre || ""} ${crudo} ${datos.ocr_text || ""}`.toUpperCase();
  if (/\bKFC\b|KENTUCKY/.test(texto)) return "KFC";
  if (/SUSHI/.test(texto)) return "SUS";
  return null;
}

// El "# Comprobante" que pide el portal. ticketUnico va PRIMERO porque es el
// que el portal reconoce; folio/ticket son el numero grande del encabezado, que
// da E-05. Se prueban todos contra la API y manda el que exista de verdad.
function candidatosNoTicket(datos) {
  const vistos = new Set();
  const out = [];
  for (const v of [datos.ticketUnico, datos.noTicketUnico, datos.ticket, datos.folio, datos.referencia, datos.numeroTicket]) {
    const s = String(v ?? "").trim().replace(/^0+(?=\d)/, ""); // el portal filtra con /^\d+$/
    if (/^\d{1,25}$/.test(s) && !vistos.has(s)) { vistos.add(s); out.push(s); }
  }
  return out;
}

function candidatosPrecio(total) {
  const n = Number(String(total).replace(/[^\d.]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return [];
  const out = [n.toFixed(2)];
  if (Number.isInteger(n)) out.unshift(String(n)); // "149" es lo que manda el portal cuando se teclea 149
  return [...new Set(out)];
}

// Resuelve sucursal + noTicket + precio contra la API ANTES de abrir el
// navegador. Todo son GET de consulta: no reservan ni facturan nada.
async function resolverTicket({ franquicia, sucursales, noTickets, precios, fechaVenta }) {
  const encontrados = [];
  let ultimoError = null;
  for (const sucursal of sucursales) {
    for (const noTicket of noTickets) {
      for (const precio of precios) {
        const r = await consultarTicket({ franquicia, sucursal, noTicket, precio, fechaVenta });
        if (r && r.isSuccess && Array.isArray(r.data) && r.data.length > 0) {
          encontrados.push({ sucursal, noTicket, precio, fechaVenta, franquicia, ticket: r.data[0] });
        } else if (r) {
          ultimoError = r.errorCode ? `${r.errorCode} ${r.error}` : r.error || "sin detalle";
        }
      }
    }
  }
  // Dos combinaciones distintas que dan DOS tickets distintos = no sabemos cual
  // es el de la foto. Antes de facturar el que no es, se para.
  const ids = [...new Set(encontrados.map((e) => e.ticket.IdTicket))];
  return { encontrados, ids, ultimoError };
}

async function facturarLosSenderos(datos) {
  const {
    rfc, razonSocial, regimenFiscal, usoCfdi, codigoPostal, emailEntrega,
    calle, ext, int: numInt, colonia, municipio, estado, total, fecha, ticketId,
  } = datos;

  const correo = emailEntrega || "buzonfacturas@serviciosga.site";
  const franquicia = sacarFranquicia(datos);
  const fechaVenta = aFechaISO(fecha);
  const noTickets = candidatosNoTicket(datos);
  const precios = candidatosPrecio(total);
  const sucursalOcr = String(datos.sucursal || "").trim().match(/^\d{3,6}$/)
    ? String(datos.sucursal).trim()
    : null;

  console.log("🤖 Los Senderos (AMS Integra)...");
  console.log(`   Franquicia: ${franquicia} | Sucursal: ${sucursalOcr || "(sin clave)"} | Fecha: ${fechaVenta} | # Comprobante candidatos: ${noTickets.join(", ") || "(ninguno)"} | Importe: ${precios.join(" / ") || "(ninguno)"}`);

  // ── Validaciones baratas. Abrir Browserless cuesta y el limite de sesiones
  // simultaneas es bajo: aqui se cae todo lo que ya se sabe que no va a ir.
  if (!franquicia) {
    return { ok: false, error_code: "datos_invalidos", msg: "Los Senderos: no se pudo determinar la franquicia. El portal solo factura KFC y SUSHIITTO (catalogo GEB: KFC / SUS)." };
  }
  if (!fechaVenta) {
    return { ok: false, error_code: "datos_invalidos", msg: `Los Senderos: la fecha del ticket no es utilizable ("${fecha}"). El portal la exige EXACTA en formato YYYY-MM-DD y no tolera ni un dia de diferencia.` };
  }
  if (noTickets.length === 0) {
    return { ok: false, error_code: "datos_invalidos", msg: 'Los Senderos: falta el "# Comprobante". OJO: es el "No. Ticket Unico" del PIE del ticket (ej. 80), no el "Ticket: 217" del encabezado. Revisalo en la foto.' };
  }
  if (precios.length === 0) {
    return { ok: false, error_code: "datos_invalidos", msg: `Los Senderos: el importe del ticket no es utilizable ("${total}").` };
  }
  if (!rfc || !razonSocial || !codigoPostal) {
    return { ok: false, error_code: "datos_invalidos", msg: `Los Senderos: faltan datos fiscales obligatorios del receptor (rfc=${rfc || "-"}, razonSocial=${razonSocial || "-"}, cp=${codigoPostal || "-"}).` };
  }

  const limite = limitePlazo(fechaVenta);
  if (Date.now() > limite.getTime()) {
    return {
      ok: false, error_code: "ticket_vencido", email_contacto: CORREO_PORTAL, permite_solicitud_correo: true,
      msg: `Los Senderos: el ticket es del ${fechaVenta} y el portal solo factura "el mes en que lo adquirio y hasta 7 dias del mes siguiente" (limite: ${limite.etiqueta}). Hay que pedirla por correo.`,
    };
  }

  // ── Resolucion del ticket por API (GET puros, sin navegador) ──────────────
  let sucursales = sucursalOcr ? [sucursalOcr] : [];
  let catalogoSucursales = null;
  try {
    const cat = await apiGet(`/catalogos/XML/empresa/${EMPRESA}/sucursal_${franquicia}`);
    if (cat && cat.isSuccess && Array.isArray(cat.data)) {
      catalogoSucursales = cat.data;
      // Sin clave (o con una clave que no esta en el catalogo) se intenta casar
      // por nombre: el OCR lee "KFC CENTRAL DURANGO" y el catalogo dice
      // "1434 - KFC DURANGO", asi que se compara por palabras sueltas.
      const nombre = String(datos.sucursalNombre || datos.comercio || "").toUpperCase();
      const palabras = nombre.replace(/[^A-ZÑ ]/g, " ").split(/\s+/).filter((p) => p.length >= 4 && !["CENTRAL", "SUCURSAL", "AUTOBUSES", "TERMINAL"].includes(p));
      const porNombre = cat.data.filter((s) => palabras.some((p) => s.Descripcion.toUpperCase().includes(p))).map((s) => s.Clave.trim());
      for (const c of porNombre) if (!sucursales.includes(c)) sucursales.push(c);
    }
  } catch (e) {
    console.log(`   ⚠️ no se pudo leer el catalogo de sucursales: ${e.message}`);
  }
  if (sucursales.length === 0) {
    return { ok: false, error_code: "datos_invalidos", msg: `Los Senderos: no se pudo determinar la sucursal de ${franquicia}. Viene impresa en el ticket como numero de tienda (ej. 1434 = KFC DURANGO).` };
  }
  // Mas de 4 sucursales candidatas es barrer a ciegas; se corta.
  sucursales = sucursales.slice(0, 4);

  let resuelto;
  try {
    resuelto = await resolverTicket({ franquicia, sucursales, noTickets, precios, fechaVenta });
  } catch (e) {
    return { ok: false, error_code: "reintentar_despues", msg: `Los Senderos: la API de AMS Integra no respondio al consultar el ticket (${e.message}). No se emitio nada.` };
  }

  if (resuelto.ids.length === 0) {
    return {
      ok: false, error_code: "datos_invalidos",
      msg: `Los Senderos: el portal no encuentra el ticket. Probado franquicia=${franquicia}, sucursal=${sucursales.join("/")}, fecha=${fechaVenta}, # Comprobante=${noTickets.join("/")}, importe=${precios.join("/")} → ${resuelto.ultimoError || "sin resultados"}. Recuerda que el "# Comprobante" es el "No. Ticket Unico" del PIE del ticket y que la fecha tiene que ser exacta.`,
    };
  }
  if (resuelto.ids.length > 1) {
    return {
      ok: false, error_code: "datos_invalidos",
      msg: `Los Senderos: los datos del ticket casan con ${resuelto.ids.length} tickets distintos del portal (IdTicket ${resuelto.ids.join(", ")}). No se factura ninguno para no emitir el CFDI del que no es: hace falta confirmar sucursal y # Comprobante a mano.`,
    };
  }

  const T = resuelto.encontrados[0];
  const info = T.ticket;
  console.log(`   ✅ Ticket localizado: Folio ${info.Folio} | ${info.RazonSocial} | Total ${info.Total} | TicketTimbrado=${info.TicketTimbrado} | FacturableMes=${info.FacturableMes}`);

  if (info.TicketTimbrado === 1 || info.TicketTimbrado === true || info.FacturadoPorOtroPac === true) {
    return { ok: false, error_code: "ya_facturado", msg: `Los Senderos: el portal ya tiene timbrado el ticket ${info.Folio} (TicketTimbrado=${info.TicketTimbrado}, FacturadoPorOtroPac=${info.FacturadoPorOtroPac}). No se vuelve a facturar.` };
  }
  if (info.FacturableMes === 0 || info.FacturableMes === false) {
    return {
      ok: false, error_code: "ticket_vencido", email_contacto: CORREO_PORTAL, permite_solicitud_correo: true,
      msg: `Los Senderos: el propio portal marca el ticket ${info.Folio} como fuera del mes facturable (FacturableMes=0). El plazo es el mes de compra + 7 dias del siguiente.`,
    };
  }

  // ¿Ya existe el CFDI aunque el ticket no lo diga? Es la consulta de "Mis
  // Facturas". Cuesta un GET y ahorra una emision duplicada.
  try {
    const previos = await consultarCfdis(T);
    if (previos && previos.isSuccess && Array.isArray(previos.data) && previos.data.length > 0) {
      const c = previos.data[0];
      return {
        ok: false, error_code: "ya_facturado",
        msg: `Los Senderos: el ticket ${info.Folio} YA tiene factura en el portal (emitida ${c.FechaHoraEmision || "?"}, $${c.Monto || "?"}). Se puede descargar en facturafranquicias.lossenderos.com.mx → Mis Facturas con franquicia ${franquicia}, sucursal ${T.sucursal}, fecha ${fechaVenta}, # Comprobante ${T.noTicket}, importe ${T.precio}.`,
      };
    }
  } catch (e) {
    console.log(`   ⚠️ no se pudo comprobar si ya estaba facturado: ${e.message}`);
  }

  const regimenClave = String(regimenFiscal || "601").trim();
  const usoClave = String(usoCfdi || "G03").trim().toUpperCase();
  const pararEn = String(process.env.LOSSENDEROS_PARAR_EN || "").toLowerCase();

  // ── Navegador ─────────────────────────────────────────────────────────────
  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error("BROWSERLESS_TOKEN no definido");
  // ⚠️ Browserless contesta 429 cuando ya hay una sesion viva con el mismo
  // token, y el WebSocket emite un ErrorEvent suelto: si puppeteer.connect no
  // va dentro de un try/catch, el fallo sale como una excepcion cruda que no
  // dice nada y cae en el error generico, que REINTENTA. Aqui se reintenta la
  // conexion un par de veces y, si no hay hueco, se devuelve un error limpio
  // (no se ha abierto ninguna pagina, asi que no se ha emitido nada).
  let browser = null;
  for (let intento = 1; intento <= 3 && !browser; intento++) {
    try {
      browser = await puppeteer.connect({
        browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true`,
      });
    } catch (e) {
      console.log(`   Browserless rechazo la conexion (intento ${intento}/3): ${e.message}`);
      if (intento < 3) await sleep(20000);
      else return { ok: false, error_code: "reintentar_despues", msg: `Los Senderos: Browserless no acepto la sesion (${e.message}). No se emitio nada.` };
    }
  }
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1100 });
  await page.setUserAgent(UA);
  await page.setExtraHTTPHeaders({ "Accept-Language": "es-MX,es;q=0.9,en;q=0.8" });
  // OBLIGATORIO y desde el primer instante: un alert() sin manejar cuelga el
  // hilo y Browserless mata la pestana ("Session closed"/"Target closed").
  page.on("dialog", async (d) => { console.log("💬", d.message()); await d.accept().catch(() => {}); });

  // La respuesta del POST que factura es la unica fuente fiable: trae el UUID y
  // los archivos en base64. Se captura al vuelo porque el DOM final no tiene
  // enlaces que rascar.
  const respuestas = [];
  page.on("response", async (r) => {
    try {
      if (!/\/Operacion\/generarCfdi/i.test(r.url())) return;
      const post = r.request().postData() || "";
      let json = null;
      try { json = JSON.parse(await r.text()); } catch { json = null; }
      // Se mira el cuerpo enviado (isGenerarCFDI) Y el recibido: el preflight
      // CORS llega aqui tambien, sin postData y con 204, y la respuesta del
      // timbrado es la unica que trae FacturasTimbradas.
      const esTimbrado = /"isGenerarCFDI"\s*:\s*"1"/.test(post) ||
        !!(json && json.data && Array.isArray(json.data.FacturasTimbradas));
      respuestas.push({ esTimbrado, status: r.status(), json });
      console.log(`   🌐 generarCfdi isGenerarCFDI=${esTimbrado ? "1 (TIMBRA)" : "0 (previsualiza)"} → HTTP ${r.status()}`);
    } catch { /* nunca tumbar la corrida por el listener */ }
  });

  const ts = ticketId || Date.now();
  const shot = async (etq) => {
    try {
      const buf = await page.screenshot({ fullPage: false });
      console.log(`📸 ${await subirArchivoR2(buf, `debug/lossenderos_${ts}_${etq}_${Date.now()}.png`, "image/png")}`);
    } catch { /* una captura fallida no puede cortar el flujo */ }
  };

  // Texto del modal visible (info, error o confirmacion). "" si no hay ninguno.
  const modalVisible = () => page.evaluate(() => {
    const w = document.querySelector(".modal-wrapper.active");
    if (!w) return null;
    const m = w.querySelector(".modal");
    return {
      clases: m ? m.className : "",
      titulo: (w.querySelector("h4, h5") || {}).textContent || "",
      texto: (w.innerText || "").replace(/\s+/g, " ").trim().slice(0, 300),
      botones: Array.from(w.querySelectorAll("button")).map((b) => (b.textContent || "").trim()).filter(Boolean),
    };
  }).catch(() => null);

  // Teclea de verdad (React ignora .value a pelo) y RELEE para confirmarlo.
  const escribir = async (sel, valor) => {
    const v = String(valor ?? "");
    if (!v) return true;
    const existe = await page.$(sel);
    if (!existe) { console.log(`   ⚠️ no existe ${sel}`); return false; }
    await page.click(sel, { clickCount: 3 }).catch(() => {});
    await page.keyboard.press("Backspace").catch(() => {});
    await page.type(sel, v, { delay: 45 });
    const leido = await page.$eval(sel, (e) => e.value).catch(() => null);
    const ok = String(leido || "").trim().toUpperCase() === v.trim().toUpperCase();
    if (!ok) console.log(`   ⚠️ ${sel} quedo en ${JSON.stringify(leido)} y se queria ${JSON.stringify(v)}`);
    return ok;
  };

  let timbradoDisparado = false;
  try {
    console.log(`🌐 ${URL_PORTAL}`);
    await page.goto(URL_PORTAL, { waitUntil: "networkidle2", timeout: 60000 });
    await page.waitForSelector("#Precio", { timeout: 30000 });
    await sleep(2500);

    // 1 — Cerrar el "Aviso Importante". Es el MISMO componente que el modal que
    // timbra: se exige que NO traiga "Cancelar" antes de pulsar su "Aceptar".
    const aviso = await modalVisible();
    if (aviso) {
      const esConfirmacion = aviso.botones.some((b) => /^cancelar$/i.test(b));
      if (esConfirmacion) {
        await shot("error_modal_inesperado");
        await browser.close();
        return { ok: false, error_code: "reintentar_despues", msg: `Los Senderos: al cargar salio un modal de CONFIRMACION, no el aviso ("${aviso.titulo}"). No se pulsa nada. No se emitio nada.` };
      }
      const cerrado = await page.evaluate(() => {
        const w = document.querySelector(".modal-wrapper.active");
        if (!w) return false;
        const b = Array.from(w.querySelectorAll("button.primary")).find((x) => /^\s*(aceptar|cerrar)\s*$/i.test(x.textContent || ""));
        if (!b) return false;
        b.click();
        return true;
      });
      console.log(`   Aviso "${(aviso.titulo || "").trim()}" ${cerrado ? "cerrado" : "NO se pudo cerrar"}`);
      await sleep(1800);
    }

    // 2 — Franquicia y Sucursal (react-select). Se localizan por la etiqueta que
    // muestran; si ya tienen valor, por su orden dentro del formulario.
    const elegirReactSelect = async (etiqueta, orden, textoTeclear, esperado) => {
      const id = await page.evaluate((etq, idx) => {
        const inputs = Array.from(document.querySelectorAll('input[id^="react-select"]')).filter((e) => e.offsetParent !== null || e.closest(".input-wrapper"));
        const porEtiqueta = inputs.find((i) => new RegExp(etq, "i").test(((i.closest(".input-wrapper") || i.parentElement || {}).innerText || "")));
        return (porEtiqueta || inputs[idx] || {}).id || null;
      }, etiqueta, orden);
      if (!id) return { ok: false, motivo: `no se encontro el react-select de ${etiqueta}` };
      const sel = `#${id}`;
      await page.click(sel).catch(() => {});
      await sleep(600);
      await page.type(sel, String(textoTeclear), { delay: 70 });
      // Esperar a que el menu filtre: sin esto el Enter elige la opcion anterior.
      await page.waitForFunction(
        () => document.querySelectorAll('[id^="react-select"][id*="option"]').length > 0,
        { timeout: 12000 }
      ).catch(() => {});
      await sleep(700);
      const opciones = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[id^="react-select"][id*="option"]')).map((o) => (o.textContent || "").trim())
      );
      if (opciones.length === 0) return { ok: false, motivo: `el desplegable de ${etiqueta} no mostro ninguna opcion al teclear "${textoTeclear}"` };
      await page.keyboard.press("Enter");
      await sleep(900);
      // PRUEBA de que quedo elegido: el control muestra el valor.
      const rotulo = await page.evaluate((s) => {
        const i = document.querySelector(s);
        const w = i && (i.closest(".input-wrapper") || i.parentElement);
        return w ? (w.innerText || "").replace(/\s+/g, " ").trim() : "";
      }, sel);
      const ok = new RegExp(String(esperado).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(rotulo);
      console.log(`   ${etiqueta}: "${rotulo}" ${ok ? "✓" : "✗ (esperaba " + esperado + "; opciones: " + opciones.slice(0, 6).join(" | ") + ")"}`);
      return { ok, motivo: ok ? null : `${etiqueta} quedo en "${rotulo}" y se esperaba "${esperado}"` };
    };

    const fq = await elegirReactSelect("Franquicia", 0, franquicia === "SUS" ? "SUSHIITTO" : franquicia, franquicia === "SUS" ? "SUSHI" : franquicia);
    if (!fq.ok) {
      await shot("error_franquicia");
      await browser.close();
      return { ok: false, error_code: "reintentar_despues", msg: `Los Senderos: ${fq.motivo}. No se emitio nada.` };
    }
    await sleep(1500); // el catalogo de sucursales se pide al elegir franquicia
    const nombreSucursal = (catalogoSucursales || []).find((s) => s.Clave.trim() === String(T.sucursal));
    const sc = await elegirReactSelect("Sucursal", 1, T.sucursal, T.sucursal);
    if (!sc.ok) {
      await shot("error_sucursal");
      await browser.close();
      return { ok: false, error_code: "reintentar_despues", msg: `Los Senderos: ${sc.motivo} (buscaba ${nombreSucursal ? nombreSucursal.Descripcion : T.sucursal}). No se emitio nada.` };
    }

    // 3 — Fecha, # Comprobante e Importe. #FechaVenta es type=date y el Chrome
    // de Browserless va en en-US: se teclea MMDDYYYY.
    const [aa, mm, dd] = T.fechaVenta.split("-");
    await page.click("#FechaVenta").catch(() => {});
    await page.keyboard.type(`${mm}${dd}${aa}`, { delay: 90 });
    let fechaLeida = await page.$eval("#FechaVenta", (e) => e.value).catch(() => "");
    if (fechaLeida !== T.fechaVenta) {
      // Plan B: setter nativo + evento input, que es lo unico que React escucha
      // si el input de tipo date no acepta el tecleo del locale.
      await page.evaluate((v) => {
        const e = document.getElementById("FechaVenta");
        const nat = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        nat.call(e, v);
        e.dispatchEvent(new Event("input", { bubbles: true }));
        e.dispatchEvent(new Event("change", { bubbles: true }));
      }, T.fechaVenta);
      await sleep(500);
      fechaLeida = await page.$eval("#FechaVenta", (e) => e.value).catch(() => "");
    }
    const okTicket = await escribir("#NoTicket", T.noTicket);
    const okPrecio = await escribir("#Precio", T.precio);
    console.log(`   Fecha=${fechaLeida} | #Comprobante ${okTicket ? "✓" : "✗"} | Importe ${okPrecio ? "✓" : "✗"}`);
    await shot("p1_formulario");

    if (fechaLeida !== T.fechaVenta || !okTicket || !okPrecio) {
      await shot("error_campos_paso1");
      await browser.close();
      return { ok: false, error_code: "reintentar_despues", msg: `Los Senderos: no se pudieron escribir los datos del paso 1 (fecha="${fechaLeida}" esperada "${T.fechaVenta}", comprobante=${okTicket}, importe=${okPrecio}). No se emitio nada.` };
    }

    // 4 — Anadir ticket. Solo CONSULTA (GET obtenerTicket); no factura.
    const pulsadoAnadir = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("button.primary")).filter((x) => x.offsetParent !== null)
        .find((x) => /a[nñ]adir/i.test(x.textContent || ""));
      if (!b) return false;
      b.click();
      return true;
    });
    if (!pulsadoAnadir) {
      await shot("error_sin_boton_anadir");
      await browser.close();
      return { ok: false, error_code: "reintentar_despues", msg: 'Los Senderos: no se encontro el boton "Anadir ticket". No se emitio nada.' };
    }
    // Sale un modal en los DOS casos: "Ticket(s) anadido(s)" si lo acepto, o el
    // error de la API si no. Se lee el texto para saber cual es.
    await page.waitForFunction(
      () => !!document.querySelector(".modal-wrapper.active"),
      { timeout: 30000 }
    ).catch(() => {});
    const aviso2 = await modalVisible();
    console.log(`   Tras anadir: ${aviso2 ? JSON.stringify(aviso2.texto).slice(0, 180) : "(sin modal)"}`);
    await shot("p2_tras_anadir");

    if (aviso2 && !/a[nñ]adid/i.test(aviso2.texto)) {
      const t = aviso2.texto;
      await browser.close();
      if (/ya\s+(est[aá]|fue|tiene)\s+.{0,20}factur/i.test(t)) return { ok: false, error_code: "ya_facturado", msg: `Los Senderos: ${t}` };
      if (/venci|caduc|fuera\s+de\s+(tiempo|plazo)|mes/i.test(t) && /factur/i.test(t)) {
        return { ok: false, error_code: "ticket_vencido", email_contacto: CORREO_PORTAL, permite_solicitud_correo: true, msg: `Los Senderos: ${t}` };
      }
      return { ok: false, error_code: "datos_invalidos", msg: `Los Senderos: el portal no acepto el ticket ${T.noTicket} (sucursal ${T.sucursal}, ${T.fechaVenta}, $${T.precio}): ${t}` };
    }

    // Cerrar el modal: mientras siga abierto se come los clicks de la tabla y de
    // "Siguiente" SIN dar ningun error.
    if (aviso2) {
      await page.evaluate(() => {
        const w = document.querySelector(".modal-wrapper.active");
        const b = w && Array.from(w.querySelectorAll("button")).find((x) => /^\s*cerrar\s*$/i.test(x.textContent || ""));
        if (b) { b.click(); return true; }
        return false;
      });
      const cerro = await page.waitForFunction(
        () => !document.querySelector(".modal-wrapper.active"),
        { timeout: 15000 }
      ).then(() => true).catch(() => false);
      if (!cerro) {
        await shot("error_modal_pegado");
        await browser.close();
        return { ok: false, error_code: "reintentar_despues", msg: 'Los Senderos: el modal "Ticket(s) anadido(s)" no se cerro y tapa el formulario. No se emitio nada.' };
      }
    }

    // 5 — Marcar el ticket. Sin marcarlo, "Siguiente" contesta "Selecciona al
    // menos un ticket para continuar".
    const marcado = await page.evaluate(() => {
      const all = document.getElementById("allSelect");
      if (all && !all.checked) all.click();
      const filas = Array.from(document.querySelectorAll("table input[type=checkbox]")).filter((c) => c.id !== "allSelect");
      filas.forEach((c) => { if (!c.checked) c.click(); });
      return { filas: filas.length, marcadas: filas.filter((c) => c.checked).length };
    });
    console.log(`   Tickets en la tabla: ${marcado.filas} | marcados: ${marcado.marcadas}`);
    if (marcado.filas === 0 || marcado.marcadas === 0) {
      await shot("error_sin_fila");
      await browser.close();
      return { ok: false, error_code: "reintentar_despues", msg: `Los Senderos: el ticket no aparecio en la tabla o no se pudo marcar (filas=${marcado.filas}, marcadas=${marcado.marcadas}). No se emitio nada.` };
    }

    // 6 — Siguiente. OJO: hay DOS button.ternary-second ahi, "Eliminar" y
    // "Siguiente". Se filtra por texto exacto.
    const pulsadoSiguiente = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("button.ternary-second")).filter((x) => x.offsetParent !== null)
        .find((x) => /^\s*siguiente\s*$/i.test(x.textContent || ""));
      if (!b || b.disabled) return false;
      b.click();
      return true;
    });
    if (!pulsadoSiguiente) {
      await shot("error_sin_siguiente");
      await browser.close();
      return { ok: false, error_code: "reintentar_despues", msg: 'Los Senderos: no se encontro (o estaba deshabilitado) el boton "Siguiente". No se emitio nada.' };
    }

    // 7 — Modal "Informacion de Facturacion". Sus campos estan en el DOM desde
    // el primer render aunque este cerrado: hay que mirar VISIBILIDAD.
    const modalAbierto = await page.waitForFunction(
      () => { const e = document.getElementById("rfc"); return !!(e && e.getClientRects().length > 0); },
      { timeout: 25000 }
    ).then(() => true).catch(() => false);
    if (!modalAbierto) {
      await shot("error_sin_modal_fiscal");
      await browser.close();
      return { ok: false, error_code: "reintentar_despues", msg: "Los Senderos: no se abrio el modal de datos fiscales. No se emitio nada." };
    }
    await shot("p3_modal_fiscal");

    // RFC + focusout real: eso y solo eso dispara obtenerRegimenFiscal. Sin el
    // blur, el select de Regimen se queda con su unica <option> placeholder.
    // (El boton de la LUPA de al lado NO se toca: rompe el select.)
    const okRfc = await escribir("#rfc", String(rfc).toUpperCase());
    await page.keyboard.press("Tab").catch(() => {});
    await page.evaluate(() => { const e = document.getElementById("rfc"); if (e) e.blur(); }).catch(() => {});
    if (!okRfc) {
      await shot("error_rfc");
      await browser.close();
      return { ok: false, error_code: "reintentar_despues", msg: "Los Senderos: no se pudo escribir el RFC en el modal fiscal. No se emitio nada." };
    }

    const hayRegimenes = await page.waitForFunction(
      () => (document.getElementById("regimenFiscal") || { options: [] }).options.length > 1,
      { timeout: 30000 }
    ).then(() => true).catch(() => false);
    if (!hayRegimenes) {
      await shot("error_sin_regimenes");
      await browser.close();
      return { ok: false, error_code: "reintentar_despues", msg: `Los Senderos: el portal no cargo el catalogo de Regimen Fiscal para ${rfc} (GET /Catalogos/obtenerRegimenFiscal). No se emitio nada.` };
    }

    // El value es el IdRegimenFiscal, NO la clave del SAT: se elige por etiqueta.
    const regimenPuesto = await page.evaluate((clave) => {
      const s = document.getElementById("regimenFiscal");
      const o = Array.from(s.options).find((x) => new RegExp(`^\\s*${clave}\\s*-`).test(x.textContent || ""));
      if (!o) return { ok: false, opciones: Array.from(s.options).map((x) => x.textContent.trim()) };
      const nat = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
      nat.call(s, o.value);
      s.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: s.value === o.value, value: s.value, etiqueta: o.textContent.trim() };
    }, regimenClave);
    console.log(`   Regimen: ${JSON.stringify(regimenPuesto)}`);
    if (!regimenPuesto.ok) {
      await shot("error_regimen");
      await browser.close();
      return { ok: false, error_code: "datos_invalidos", msg: `Los Senderos: el regimen fiscal ${regimenClave} no esta en el catalogo que el portal ofrece para el RFC ${rfc}${regimenPuesto.opciones ? ` (opciones: ${regimenPuesto.opciones.slice(1).join(" | ")})` : ""}. No se emitio nada.` };
    }

    // Que #usoCfdi se pueble es la PRUEBA de que React registro el cambio de
    // regimen: el catalogo se pide en cascada con el Id elegido.
    const hayUsos = await page.waitForFunction(
      () => (document.getElementById("usoCfdi") || { options: [] }).options.length > 1,
      { timeout: 30000 }
    ).then(() => true).catch(() => false);
    if (!hayUsos) {
      await shot("error_sin_usos");
      await browser.close();
      return { ok: false, error_code: "reintentar_despues", msg: `Los Senderos: el portal no cargo el catalogo de Uso de CFDI para regimen ${regimenClave}. No se emitio nada.` };
    }

    const usoPuesto = await page.evaluate((clave) => {
      const s = document.getElementById("usoCfdi");
      const o = Array.from(s.options).find((x) => x.value === clave) || Array.from(s.options).find((x) => x.value === "G03");
      if (!o) return { ok: false, opciones: Array.from(s.options).map((x) => x.textContent.trim()) };
      const nat = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
      nat.call(s, o.value);
      s.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: s.value === o.value, value: s.value };
    }, usoClave);
    console.log(`   Uso CFDI: ${JSON.stringify(usoPuesto)}`);
    if (!usoPuesto.ok) {
      await shot("error_uso");
      await browser.close();
      return { ok: false, error_code: "datos_invalidos", msg: `Los Senderos: el uso de CFDI ${usoClave} no esta disponible para el regimen ${regimenClave}. No se emitio nada.` };
    }

    // Obligatorios del portal: RFC, razon social, regimen, uso, CP y correo.
    // El domicilio es opcional; se rellena solo si viene en los datos.
    const okNombre = await escribir("#nombreRazonSocial", razonSocial);
    const okCp = await escribir("#codigoPostal", String(codigoPostal));
    if (calle) await escribir("#calle", calle);
    if (ext) await escribir("#noExterior", ext);
    if (numInt) await escribir("#noInterior", numInt);
    if (colonia) await escribir("#colonia", colonia);
    if (municipio) await escribir("#municipio", municipio);
    if (estado) await escribir("#estado", estado);
    // ⚠️ SIEMPRE el buzon de captura, NUNCA el correo del residente: si va el
    // del residente, el CFDI se emite y el sistema no lo recibe jamas.
    const okCorreo = await escribir("#email", correo);
    await shot("p4_modal_lleno");

    if (!okNombre || !okCp || !okCorreo) {
      await shot("error_datos_fiscales");
      await browser.close();
      return { ok: false, error_code: "reintentar_despues", msg: `Los Senderos: no se pudieron escribir los datos fiscales (nombre=${okNombre}, cp=${okCp}, correo=${okCorreo}). No se emitio nada.` };
    }

    if (pararEn === "prefactura") {
      await browser.close();
      return { ok: false, error_code: "datos_invalidos", msg: "Los Senderos: PARADA DE PRUEBA (LOSSENDEROS_PARAR_EN=prefactura) con el modal fiscal completo. NO se pulso nada. No se emitio nada." };
    }

    // 8 — "Facturar" DEL MODAL (button.ternary-second). Solo previsualiza:
    // POST generarCfdi con isGenerarCFDI:"0". NO timbra.
    const pulsadaPrefactura = await page.evaluate(() => {
      // El modal fiscal esta en el DOM aunque este cerrado: se busca DENTRO del
      // wrapper que lleva la clase "active", que es lo unico que lo muestra.
      const m = Array.from(document.querySelectorAll(".modal-wrapper.active .modal")).find((x) => x.querySelector("#rfc"));
      const b = m && Array.from(m.querySelectorAll("button.ternary-second")).find((x) => /^\s*facturar\s*$/i.test(x.textContent || ""));
      if (!b || b.disabled) return false;
      b.click();
      return true;
    });
    if (!pulsadaPrefactura) {
      await shot("error_sin_boton_prefactura");
      await browser.close();
      return { ok: false, error_code: "reintentar_despues", msg: 'Los Senderos: no se encontro el boton "Facturar" del modal fiscal (el de la previsualizacion). No se emitio nada.' };
    }

    const llegoPaso2 = await page.waitForFunction(
      () => !!document.querySelector("section.datos-fiscales") ||
            !!document.querySelector(".modal-wrapper.active"),
      { timeout: 60000 }
    ).then(() => true).catch(() => false);
    await sleep(2500);
    await shot("p5_previsualizacion");

    const enPaso2 = await page.$("section.datos-fiscales");
    if (!enPaso2) {
      const m = await modalVisible();
      const t = (m && m.texto) || "(sin mensaje)";
      await browser.close();
      if (/ya\s+(est[aá]|fue)\s+.{0,20}factur/i.test(t)) return { ok: false, error_code: "ya_facturado", msg: `Los Senderos: ${t}` };
      if (/rfc|raz[oó]n social|c[oó]digo postal|correo|r[eé]gimen|uso del cfdi/i.test(t)) {
        return { ok: false, error_code: "datos_invalidos", msg: `Los Senderos: el portal rechazo los datos fiscales: ${t}. No se emitio nada.` };
      }
      return { ok: false, error_code: "reintentar_despues", msg: `Los Senderos: la previsualizacion no llego al paso 2 (llegoPaso2=${llegoPaso2}): ${t}. No se emitio nada.` };
    }

    // Se descarta el preflight CORS (204 sin cuerpo) quedandose con la ultima
    // respuesta que de verdad trae JSON.
    const prefactura = respuestas.filter((r) => !r.esTimbrado && r.json).pop();
    if (prefactura && !(Array.isArray(prefactura.json.data) && prefactura.json.data.length > 0)) {
      await browser.close();
      return { ok: false, error_code: "reintentar_despues", msg: `Los Senderos: la previsualizacion volvio sin datos (${JSON.stringify(prefactura.json).slice(0, 200)}). No se emitio nada.` };
    }

    // 9 — Forma de pago. El react-select del paso 2 viene preseleccionado con la
    // FormaPago que trae la prefactura ("01" para el #350, efectivo); si llegara
    // vacio, el portal contesta "Por favor selecciona la forma de pago" y no
    // emite nada. Se comprueba y, si hace falta, se elige.
    const formaPagoTexto = await page.evaluate(() => {
      const s = document.querySelector("section.datos-fiscales");
      const i = s && s.querySelector('input[id^="react-select"]');
      const w = i && (i.closest(".input-wrapper") || i.parentElement.parentElement);
      return w ? (w.innerText || "").replace(/\s+/g, " ").trim() : "";
    });
    console.log(`   Forma de pago en pantalla: "${formaPagoTexto}"`);
    if (!/\b(01|03|04|28)\b/.test(formaPagoTexto)) {
      const clave = /transferencia/i.test(String(datos.formaPago || "")) ? "03"
        : /cr[eé]dito/i.test(String(datos.formaPago || "")) ? "04"
        : /d[eé]bito/i.test(String(datos.formaPago || "")) ? "28" : "01";
      await page.evaluate(() => {
        const s = document.querySelector("section.datos-fiscales");
        const i = s && s.querySelector('input[id^="react-select"]');
        if (i) i.focus();
      });
      await page.keyboard.type(clave, { delay: 90 });
      await sleep(800);
      await page.keyboard.press("Enter");
      await sleep(800);
    }

    if (pararEn === "confirmacion") {
      await browser.close();
      return { ok: false, error_code: "datos_invalidos", msg: "Los Senderos: PARADA DE PRUEBA (LOSSENDEROS_PARAR_EN=confirmacion) en el paso 2, con la prefactura a la vista. NO se pulso el boton que emite. No se emitio nada." };
    }

    // 10 — "Facturar" del paso 2 (button.primary). Tampoco emite: solo ABRE el
    // modal de confirmacion.
    const abrioConfirmacion = await page.evaluate(() => {
      const s = document.querySelector("section.datos-fiscales");
      const b = s && Array.from(s.querySelectorAll(".actions button.primary")).find((x) => /^\s*facturar\s*$/i.test(x.textContent || ""));
      if (!b || b.disabled) return false;
      b.click();
      return true;
    });
    if (!abrioConfirmacion) {
      await shot("error_sin_boton_paso2");
      await browser.close();
      return { ok: false, error_code: "reintentar_despues", msg: 'Los Senderos: no se encontro el boton "Facturar" del paso 2. No se emitio nada.' };
    }
    await sleep(2000);

    // El modal de confirmacion tiene que estar delante Y llevar "Cancelar":
    // ese boton es lo que lo distingue del aviso inicial, que usa el mismo
    // componente. Si no esta, no se pulsa nada.
    const conf = await modalVisible();
    const esConfirmacionReal = !!conf &&
      /modal\s+steps/.test(conf.clases) &&
      conf.botones.some((b) => /^cancelar$/i.test(b)) &&
      conf.botones.some((b) => /^aceptar$/i.test(b)) &&
      /confirmar la emisi[oó]n|facturar/i.test(`${conf.titulo} ${conf.texto}`);
    await shot("p6_confirmacion");
    if (!esConfirmacionReal) {
      await browser.close();
      return { ok: false, error_code: "reintentar_despues", msg: `Los Senderos: no aparecio el modal de confirmacion de la emision (${conf ? JSON.stringify(conf).slice(0, 200) : "sin modal"}). No se emitio nada.` };
    }

    // ═══════════ EL CLICK QUE EMITE ═══════════
    // A partir de la linea siguiente ningun camino puede devolver un error
    // reintentable: el reintento de medianoche emitiria un segundo CFDI.
    timbradoDisparado = true;
    const pulsadoAceptar = await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 }).catch(() => {}),
      page.evaluate(() => {
        const w = document.querySelector(".modal-wrapper.active");
        const b = w && Array.from(w.querySelectorAll("button.primary")).find((x) => /^\s*aceptar\s*$/i.test(x.textContent || ""));
        if (!b) return false;
        b.click();
        return true;
      }),
    ]).then((r) => r[1]);
    console.log(`   ⚡ Aceptar (timbrado) pulsado: ${pulsadoAceptar}`);

    // Prueba de emision: la respuesta del POST con isGenerarCFDI="1", o la
    // pantalla 3 "Tu factura se genero correctamente".
    await page.waitForFunction(
      () => !!document.querySelector("section.generar") ||
            /Tu factura se gener[oó] correctamente/i.test(document.body.innerText || "") ||
            !!document.querySelector(".modal-wrapper.active"),
      { timeout: 120000 }
    ).catch(() => {});
    await sleep(3000);
    await shot("p7_resultado");

    const pantalla = await page.evaluate(() => ({
      hayPantallaFinal: !!document.querySelector("section.generar"),
      texto: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 400),
    })).catch(() => ({}));
    const timbrado = respuestas.filter((r) => r.esTimbrado && r.json).pop() || respuestas.filter((r) => r.esTimbrado).pop();
    const facturas = timbrado && timbrado.json && timbrado.json.data && Array.isArray(timbrado.json.data.FacturasTimbradas)
      ? timbrado.json.data.FacturasTimbradas : [];
    const buena = facturas.find((f) => f && f.Uuid && !f.Error);
    const conError = facturas.find((f) => f && f.Error);
    console.log(`   Respuesta del timbrado: ${facturas.length} factura(s), UUID=${buena ? buena.Uuid : "-"}, error=${conError ? conError.Error : "-"}`);

    // Ya no hace falta el navegador: se suelta la sesion de Browserless antes
    // de ponerse a sondear la API (el limite de sesiones simultaneas es bajo y
    // este sondeo puede tardar 15 s).
    await browser.close().catch(() => {});

    // Comprobacion independiente del portal (no del DOM): ¿existe ya el CFDI?
    let cfdiEnPortal = null;
    for (let i = 0; i < 3 && !cfdiEnPortal; i++) {
      try {
        const c = await consultarCfdis(T);
        if (c && c.isSuccess && Array.isArray(c.data) && c.data.length > 0) cfdiEnPortal = c.data[0];
      } catch { /* la comprobacion es un extra, no puede tumbar el cierre */ }
      if (!cfdiEnPortal) await sleep(5000);
    }
    console.log(`   obtenerCfdis dice: ${cfdiEnPortal ? "CFDI YA EN EL PORTAL" : "todavia sin CFDI"}`);

    // ── Caso 1: el portal rechazo el timbrado Y no hay CFDI en el portal. No se
    // emitio nada, pero NO se devuelve un codigo reintentable: si el rechazo es
    // por datos, reintentar cada noche no lo arregla y ademas el click ya salio.
    if (!buena && conError && !cfdiEnPortal) {
      return {
        ok: false, error_code: "datos_invalidos",
        msg: `Los Senderos: el portal RECHAZO el timbrado del ticket ${info.Folio}: ${conError.Error}${conError.DetalleError ? ` — ${conError.DetalleError}` : ""}. La consulta Mis Facturas confirma que NO hay CFDI. Revisar los datos fiscales antes de reintentar a mano; NO relanzar el bot a ciegas.`,
      };
    }

    // ── Caso 2: hay prueba de emision. Los archivos vienen en base64 dentro de
    // la propia respuesta; si no, se bajan del S3 del portal.
    const uuid = (buena && buena.Uuid) || (cfdiEnPortal && (cfdiEnPortal.Uuid || cfdiEnPortal.UUID)) || null;
    if (buena || cfdiEnPortal || pantalla.hayPantallaFinal || /Tu factura se gener[oó] correctamente/i.test(pantalla.texto || "")) {
      let bufXml = null, bufPdf = null;
      if (buena && buena.ArchivoXML) { try { bufXml = Buffer.from(buena.ArchivoXML, "base64"); } catch { bufXml = null; } }
      if (buena && buena.ArchivoPDF) { try { bufPdf = Buffer.from(buena.ArchivoPDF, "base64"); } catch { bufPdf = null; } }
      if (!bufXml && cfdiEnPortal && cfdiEnPortal.RUTA_XML) bufXml = await bajarDeS3(cfdiEnPortal.RUTA_XML);
      if (!bufPdf && cfdiEnPortal && cfdiEnPortal.RUTA_PDF) bufPdf = await bajarDeS3(cfdiEnPortal.RUTA_PDF);

      const base = uuid || `lossenderos_${ts}`;
      let xmlUrl = null, pdfUrl = null;
      try { if (bufXml && bufXml.length) xmlUrl = await subirArchivoR2(bufXml, `facturas/${base}.xml`, "application/xml"); } catch (e) { console.log(`   ⚠️ R2 xml: ${e.message}`); }
      try { if (bufPdf && bufPdf.length) pdfUrl = await subirArchivoR2(bufPdf, `facturas/${base}.pdf`, "application/pdf"); } catch (e) { console.log(`   ⚠️ R2 pdf: ${e.message}`); }

      if (xmlUrl || pdfUrl) {
        console.log(`✅ Los Senderos OK — ${uuid || "(sin uuid)"} · ${xmlUrl || pdfUrl}`);
        return { ok: true, xmlUrl, pdfUrl, uuid };
      }
      // Emitido y sin archivos: el portal tambien manda XML y PDF al correo
      // capturado, asi que IMAP lo recoge. Nunca reintentable aqui.
      return {
        ok: true, procesandoCorreo: true, uuid,
        msg: `Los Senderos: CFDI EMITIDO${uuid ? ` (UUID ${uuid})` : ""} para el ticket ${info.Folio}, pero no se pudieron guardar los archivos. El portal los manda tambien al correo ${correo}. NO RELANZAR: comprobar antes en facturafranquicias.lossenderos.com.mx → Mis Facturas (franquicia ${franquicia}, sucursal ${T.sucursal}, fecha ${T.fechaVenta}, # Comprobante ${T.noTicket}, importe ${T.precio}); relanzar emitiria un CFDI duplicado.`,
      };
    }

    // ── Caso 3: el click salio y no hay ni prueba ni desmentido. Se avisa como
    // "procesando correo" porque relanzar seria emitir dos veces.
    return {
      ok: true, procesandoCorreo: true, uuid,
      msg: `Los Senderos: se pulso el "Aceptar" que emite (pulsado=${pulsadoAceptar}) y no se pudo confirmar el resultado en pantalla (${(pantalla.texto || "").slice(0, 160)}). NO RELANZAR: comprobar antes en facturafranquicias.lossenderos.com.mx → Mis Facturas (franquicia ${franquicia}, sucursal ${T.sucursal}, fecha ${T.fechaVenta}, # Comprobante ${T.noTicket}, importe ${T.precio}) si el CFDI ya existe.`,
    };
  } catch (err) {
    console.error("❌ Los Senderos:", err.message);
    await shot("error").catch(() => {});
    try { await browser.close(); } catch { /* la sesion de Browserless ya puede estar muerta */ }
    if (timbradoDisparado) {
      return {
        ok: true, procesandoCorreo: true,
        msg: `Los Senderos: el bot fallo (${err.message}) DESPUES de pulsar el "Aceptar" que emite el CFDI. NO RELANZAR: comprobar antes en facturafranquicias.lossenderos.com.mx → Mis Facturas (franquicia ${franquicia}, sucursal ${T.sucursal}, fecha ${T.fechaVenta}, # Comprobante ${T.noTicket}, importe ${T.precio}) si el CFDI ya existe; relanzarlo emitiria un duplicado.`,
      };
    }
    return { ok: false, error_code: "reintentar_despues", msg: `Los Senderos: ${err.message} (no se emitio nada)` };
  }
}

module.exports = { facturarLosSenderos };
