const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");

/**
 * Grupo Estrella Blanca / Autobuses Expreso Futura (emisor real: FUTURA SIENTE MX,
 * RFC FSM210831QU5, régimen 624) — https://factura.estrellablanca.com.mx/generar-factura
 *
 * SPA React (Create React App) + Redux Toolkit. Todo el trabajo real lo hace el
 * backend de AMS Integra: https://apifacturasestrellablanca.amsintegra.com.mx/main
 * Sin login y SIN CAPTCHA de ningún tipo (el bundle no carga ningún script de
 * terceros: ni reCAPTCHA, ni Turnstile, ni captcha de imagen).
 *
 * ── POR QUÉ ESTE PORTAL ESTUVO SEMANAS BLOQUEADO ──────────────────────────────
 * "#regimenFiscal y #usoCfdi nunca se poblaban" NO era lentitud ni un <input>
 * hidden: los dos catálogos se piden EN CASCADA y solo los dispara la interacción
 * humana, uno detrás del otro:
 *     #rfc --focusout REAL, y solo si value.length es 12 o 13-->
 *          GET /Catalogos/obtenerRegimenFiscal/{RFC}     → 9 opciones
 *     #regimenFiscal --change--> useEffect([regimenFiscal]) -->
 *          GET /Catalogos/obtenerUsoCfdi?rfc=..&regimenFiscal={IdRegimenFiscal} → 12
 * Si el RFC se pone con `.value = ...` a pelo, React no se entera y NINGUNA de las
 * dos llamadas sale: los selects se quedan con su único <option> placeholder para
 * siempre. Por eso aquí se TECLEA de verdad y se fuerza un blur.
 *
 * ⚠️ EL value DE #regimenFiscal NO ES LA CLAVE DEL SAT: es IdRegimenFiscal
 *    (601 => "1", 603 => "2", 610 => "7"). Hay que elegir por la ETIQUETA
 *    ("601 - General de Ley Personas Morales"). Comprobado contra la API:
 *    obtenerUsoCfdi?...&regimenFiscal=1 devuelve las 12 opciones y
 *    ...&regimenFiscal=601 devuelve data:[]. Además el payload final saldría con
 *    regimenFiscal:"" → "El Régimen Fiscal es requerido".
 *
 * ⚠️ NO USAR LA LUPA que hay junto al #rfc (/Catalogos/obtenerReceptor/{RFC}):
 *    autorrellena el domicilio pero mete la CLAVE "601" en un select cuyas
 *    opciones son ids → el select queda visualmente vacío y el envío falla.
 *
 * ── LAS TRAMPAS DE LOS MODALES (aquí se perdían los clicks en silencio) ───────
 * (1) Al cargar sale el modal "Aviso Importante" (CFDI 4.0) que TAPA TODA la
 *     página. Mientras esté abierto, un click sobre #NoComprobante se lo come el
 *     overlay: el input se queda VACÍO y no salta ningún error.
 * (2) Tras "Añadir boleto" sale otro modal, "Boleto(s) añadido(s)". Mismo
 *     síntoma: tapa la tabla, las casillas y "Siguiente".
 * (3) EL MODAL DE CONFIRMACIÓN ES EL MISMO COMPONENTE QUE EL "Aviso Importante"
 *     (div.modal.steps, botón "Aceptar" class primary). Lo único que los
 *     distingue es el <h4>: "Aviso Importante" vs "Facturar". Un bot que cierre
 *     avisos pulsando "Aceptar" a ciegas puede TIMBRAR sin querer. Por eso aquí
 *     nunca se pulsa un "Aceptar" sin comprobar antes el título del modal.
 * (4) TODOS los modales viven en el DOM desde el primer render y ocupan tamaño
 *     aunque estén cerrados: offsetWidth/getClientRects los dan por VISIBLES.
 *     La visibilidad de verdad es que su div.modal-wrapper tenga la clase
 *     'active'. Es lo que usa `visible()` más abajo.
 *
 * ── HAY DOS BOTONES QUE DICEN "Facturar" Y SOLO LOS SEPARA LA CLASE ──────────
 *     button.ternary-second (dentro del modal fiscal) → POST generarCfdi con
 *        isGenerarCFDI:"0" = SOLO PREVISUALIZA (responde Folio:"" y
 *        NoCertificado:"00000000000000000000"). NO timbra.
 *     button.primary (paso 3 "Genera tu factura") → abre el modal de
 *        confirmación; su "Aceptar" lanza generarCfdi con isGenerarCFDI:"1".
 *        ESE, y solo ese, es el que TIMBRA ante el SAT.
 *
 * ── LA PRUEBA DE QUE SE TIMBRÓ (regla: nunca ok:true sin prueba) ─────────────
 * El POST final responde {data:{FacturasTimbradas:[{Uuid, ArchivoXML, ArchivoPDF,
 * Error, DetalleError}]}} y el XML y el PDF vienen ahí mismo EN BASE64. Este bot
 * engancha esa respuesta (page.on('response')) y solo devuelve ok:true si trae
 * Uuid sin Error. Si no la ve, no adivina: vuelve a preguntarle al portal por
 * HTTP (obtenerTicket.TicketTimbrado / obtenerCfdis) antes de decidir.
 *
 * ── PLAZO (lo publica la propia página) ──────────────────────────────────────
 * "A partir de la compra de su boleto, solo tiene el mes en que lo adquirió y
 * hasta 7 días del mes siguiente para poder generar su factura."
 * Se comprueba ANTES de abrir el navegador, y con la FechaVenta que devuelve la
 * API, no con la del OCR: en los tickets #354 y #369 el OCR leyó 04/09 y 03/09
 * pero la venta real de los dos fue el 2026-09-02.
 *
 * ── ENDPOINTS ÚTILES (GET, sin sesión, contestan desde Node sin navegador) ────
 *   /Catalogos/obtenerTicket/GEB?tipo=1&noComprobante=..&noTr=..&precio=..
 *        &claveTicket=AUTOBUS&franquicia=null&noTicket=&sucursal=null&fechaVenta=
 *      → valida el boleto y trae TicketTimbrado (0/1), FacturadoPorOtroPac y
 *        FacturableMes (0/1). Con esto se detecta "ya facturado" y "vencido"
 *        SIN gastar una sesión de Browserless. Si el boleto no existe responde
 *        {isSuccess:false, errorCode:"E-05"}.
 *   /Operacion/obtenerCfdis?rfc=..&folio={# Comprobante}&claveTicket=AUTOBUS
 *      → CFDIs ya emitidos (data:[] si no hay). Trae RUTA_XML / RUTA_PDF.
 *   /Operacion/obtenerRutaS3?keyUrl={RUTA_*}  → {data:"<url firmada>"}
 *
 * Contacto del portal si todo falla: atencion.cliente@estrellablanca.com.mx
 * (indicando en el asunto el # Comprobante, TR y Total, como pide la página).
 *
 * ⚠️ El importe que se teclea en #Precio es Subtotal+IVA y NO incluye "Programa
 *    de Asistencia" ni "Sin Carbono": eso se factura aparte con la aseguradora.
 */

const PORTAL = "https://factura.estrellablanca.com.mx/generar-factura";
const API = "https://apifacturasestrellablanca.amsintegra.com.mx/main";
const CONTACTO = "atencion.cliente@estrellablanca.com.mx";

// RFC de GPN. Solo para él se conoce el domicilio fiscal completo; para otro
// receptor esos campos (que el portal marca como opcionales, sin asterisco) se
// dejan vacíos antes que inventarle a un cliente el domicilio de otro.
const RFC_GPN = "GPR110128QD8";
const DOMICILIO_GPN = {
  calle: "CALZADA AEROPUERTO",
  noExterior: "7569",
  colonia: "BACHIGUALATO",
  municipio: "CULIACAN",
  estado: "SINALOA",
  pais: "MEX",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────── datos del ticket
// El # Comprobante NO es `folio`: normalizarDatos() pone en `folio` el número
// largo del boleto (A1132757185 en el #354) y el portal lo rechaza. El dato
// bueno es el que el OCR guarda como `comprobante` (MAZE1600176772285).
function sacarComprobante(datos) {
  const directo = datos.comprobante || datos.noComprobante || datos.numeroComprobante;
  if (directo) return String(directo).trim().toUpperCase();
  const t = String(datos.ocr_text || "");
  const m = t.match(/\b([A-Z]{2,5}\d{10,20})\b/);
  return m ? m[1].toUpperCase() : null;
}

// El # TR son 4-6 caracteres alfanuméricos impresos junto al comprobante.
function sacarTr(datos) {
  const directo = datos.tr || datos.noTr || datos.numeroTr;
  if (directo) return String(directo).trim().toUpperCase();
  const m = String(datos.ocr_text || "").match(/\bTR\b[:\s#]*([A-Z0-9]{2,8})\b/i);
  return m ? m[1].toUpperCase() : null;
}

// El portal valida el importe contra /^[0-9]+([.][0-9]{1,2})?$/, así que hay que
// quitar comas de millar y el símbolo de moneda antes de teclearlo.
function limpiarImporte(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n.toFixed(2) : null;
}

function parsearFecha(v) {
  if (!v) return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); // FechaVenta de la API
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  m = s.match(/(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})/); // dd/mm/yyyy del OCR
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  return null;
}

// "el mes en que lo adquirió y hasta 7 días del mes siguiente": el límite es el
// día 7 del mes siguiente al de la compra, no una ventana de 30 días.
function limitePlazo(fechaVenta) {
  return new Date(fechaVenta.getFullYear(), fechaVenta.getMonth() + 1, 7, 23, 59, 59);
}
function fueraDePlazo(fechaVenta, hoy = new Date()) {
  return hoy.getTime() > limitePlazo(fechaVenta).getTime();
}
const formatoLimite = (f) => limitePlazo(f).toLocaleDateString("es-MX");

// ───────────────────────────────────────────────────── consultas HTTP directas
async function consultarBoleto(comprobante, tr, precio) {
  const u = `${API}/Catalogos/obtenerTicket/GEB?tipo=1&noComprobante=${encodeURIComponent(comprobante)}`
    + `&noTr=${encodeURIComponent(tr)}&precio=${encodeURIComponent(precio)}`
    + `&claveTicket=AUTOBUS&franquicia=null&noTicket=&sucursal=null&fechaVenta=`;
  const r = await fetch(u, { headers: { Accept: "application/json" } });
  return await r.json();
}

async function consultarCfdis(rfc, comprobante) {
  const u = `${API}/Operacion/obtenerCfdis?rfc=${encodeURIComponent(rfc)}`
    + `&folio=${encodeURIComponent(comprobante)}&claveTicket=AUTOBUS`;
  const r = await fetch(u, { headers: { Accept: "application/json" } });
  return await r.json();
}

// RUTA_XML / RUTA_PDF son claves de S3, no URLs: hay que canjearlas por una URL
// firmada. Es lo mismo que hace el botón de descarga de "Mis Facturas".
async function bajarDeS3(keyUrl) {
  if (!keyUrl) return null;
  const r = await fetch(`${API}/Operacion/obtenerRutaS3?keyUrl=${encodeURIComponent(keyUrl)}`);
  const j = await r.json();
  if (!j || !j.isSuccess || !j.data) return null;
  const f = await fetch(j.data);
  if (!f.ok) return null;
  return Buffer.from(await f.arrayBuffer());
}

async function subir(buf, nombre, tipo) {
  if (!buf || !buf.length) return null;
  try {
    return await subirArchivoR2(buf, `facturas/${nombre}`, tipo);
  } catch (e) {
    console.log(`   ⚠️ no se pudo subir ${nombre} a R2: ${e.message}`);
    return null;
  }
}

// Recupera un CFDI que YA existe en el portal (ticket timbrado en una corrida
// anterior o a mano). Devuelve {xmlUrl, pdfUrl, uuid} o null.
async function recuperarCfdiExistente(rfc, comprobante) {
  try {
    const j = await consultarCfdis(rfc, comprobante);
    if (!j || !j.isSuccess || !Array.isArray(j.data) || !j.data.length) return null;
    const c = j.data[0];
    const uuid = c.Uuid || c.UUID || c.Folio || comprobante;
    const [bx, bp] = await Promise.all([
      bajarDeS3(c.RUTA_XML).catch(() => null),
      bajarDeS3(c.RUTA_PDF).catch(() => null),
    ]);
    const xmlUrl = await subir(bx, `${uuid}.xml`, "application/xml");
    const pdfUrl = await subir(bp, `${uuid}.pdf`, "application/pdf");
    return { xmlUrl, pdfUrl, uuid, hayRegistro: true };
  } catch (e) {
    console.log(`   ⚠️ recuperarCfdiExistente falló: ${e.message}`);
    return null;
  }
}

// ¿El portal tiene ya este boleto como timbrado? Se usa DESPUÉS del click que
// emite, cuando la respuesta no llegó: preguntarle al portal es la única forma
// honesta de saber si hay un CFDI o no.
async function constaComoTimbrado(comprobante, tr, precio, rfc) {
  try {
    const j = await consultarBoleto(comprobante, tr, precio);
    if (j && j.isSuccess && Array.isArray(j.data) && j.data.length) {
      const b = j.data[0];
      if (Number(b.TicketTimbrado) === 1 || b.FacturadoPorOtroPac === true) return true;
    }
  } catch {}
  try {
    const c = await consultarCfdis(rfc, comprobante);
    if (c && c.isSuccess && Array.isArray(c.data) && c.data.length) return true;
  } catch {}
  return false;
}

async function facturarEstrellaBlanca(datos) {
  const {
    rfc, razonSocial, regimenFiscal, usoCfdi, codigoPostal, emailEntrega, ticketId,
  } = datos;

  const comprobante = sacarComprobante(datos);
  const tr = sacarTr(datos);
  const precio = limpiarImporte(datos.total || datos.importe || datos.monto);
  const correo = emailEntrega || "buzonfacturas@serviciosga.site";
  const claveRegimen = String(regimenFiscal || "601").trim();
  const claveUso = String(usoCfdi || "G03").trim().toUpperCase();

  console.log("🤖 Estrella Blanca / Expreso Futura...");
  console.log(`   # Comprobante: ${comprobante} | # TR: ${tr} | Importe: ${precio} | RFC: ${rfc}`);

  // ── Todo lo que se pueda comprobar SIN navegador se comprueba aquí: abrir
  //    Browserless cuesta y el límite de sesiones simultáneas es bajo.
  if (!comprobante || !tr || !precio) {
    return {
      ok: false, error_code: "datos_invalidos",
      msg: `Estrella Blanca: faltan datos del boleto (# Comprobante: ${comprobante || "—"}, # TR: ${tr || "—"}, importe: ${precio || "—"}). Los tres están impresos en el boleto; el "# Comprobante" es el código largo tipo MAZE1600176772285, NO el folio del billete.`,
    };
  }
  if (!rfc || !razonSocial || !codigoPostal) {
    return {
      ok: false, error_code: "datos_invalidos",
      msg: `Estrella Blanca: faltan datos fiscales del receptor (RFC: ${rfc || "—"}, razón social: ${razonSocial || "—"}, C.P.: ${codigoPostal || "—"}).`,
    };
  }

  // Guarda de plazo con la fecha del OCR, con un mes de margen por si el OCR se
  // equivocó de mes: sirve para no molestar a la API con boletos claramente
  // muertos. La comprobación fina se hace abajo con la FechaVenta real.
  const fechaOcr = parsearFecha(datos.fecha || datos.fechaPago || datos.fechaCompra);
  if (fechaOcr && fueraDePlazo(new Date(fechaOcr.getFullYear(), fechaOcr.getMonth() + 1, 1))) {
    return {
      ok: false, error_code: "ticket_vencido", email_contacto: CONTACTO, permite_solicitud_correo: true,
      msg: `Estrella Blanca: el boleto es del ${fechaOcr.toLocaleDateString("es-MX")} y el portal solo factura "el mes en que lo adquirió y hasta 7 días del mes siguiente" (venció el ${formatoLimite(fechaOcr)}). Hay que pedir la factura por correo a ${CONTACTO} indicando # Comprobante ${comprobante}, TR ${tr} y total ${precio}.`,
    };
  }

  // La API dice la verdad sobre el boleto sin gastar navegador: si existe, si ya
  // está timbrado y si todavía es facturable este mes.
  let boleto = null;
  try {
    const j = await consultarBoleto(comprobante, tr, precio);
    if (!j || j.isSuccess !== true || !Array.isArray(j.data) || !j.data.length) {
      const motivo = (j && j.error) || "el portal no devolvió el boleto";
      // "El boleto no se encontró" sale también cuando el importe no cuadra al
      // céntimo: los tres datos (comprobante, TR y precio) tienen que coincidir.
      return {
        ok: false, error_code: "datos_invalidos",
        msg: `Estrella Blanca: ${motivo}. Se consultó # Comprobante ${comprobante}, # TR ${tr}, importe ${precio}. Ojo: el importe a facturar es Subtotal+IVA y NO incluye "Programa de Asistencia" ni "Sin Carbono"; si el ticket los trae, hay que restarlos.`,
      };
    }
    boleto = j.data[0];
    console.log(`   Boleto OK — FechaVenta ${boleto.FechaVenta} | Total ${boleto.Total} | Timbrado ${boleto.TicketTimbrado} | FacturableMes ${boleto.FacturableMes}`);
  } catch (e) {
    // Sin navegador abierto: no se emitió nada, reintentar es seguro. Salvo que
    // la fecha del OCR ya diga que está vencido, que no mejorará mañana.
    if (fechaOcr && fueraDePlazo(fechaOcr)) {
      return {
        ok: false, error_code: "ticket_vencido", email_contacto: CONTACTO, permite_solicitud_correo: true,
        msg: `Estrella Blanca: el boleto del ${fechaOcr.toLocaleDateString("es-MX")} venció el ${formatoLimite(fechaOcr)} y además la API no respondió (${e.message}).`,
      };
    }
    return { ok: false, error_code: "reintentar_despues", msg: `Estrella Blanca: la API del portal no respondió a la consulta del boleto (${e.message}). No se abrió el navegador ni se emitió nada.` };
  }

  if (Number(boleto.TicketTimbrado) === 1 || boleto.FacturadoPorOtroPac === true) {
    // Ya hay CFDI. Antes de darlo por perdido se intenta recuperarlo: si es
    // nuestro, el ticket se cierra con sus archivos en vez de con un error.
    const rec = await recuperarCfdiExistente(rfc, comprobante);
    if (rec && (rec.xmlUrl || rec.pdfUrl)) {
      console.log(`✅ Estrella Blanca — el boleto ya estaba facturado; CFDI recuperado (${rec.uuid})`);
      return { ok: true, xmlUrl: rec.xmlUrl, pdfUrl: rec.pdfUrl, uuid: rec.uuid, msg: "Estrella Blanca: el boleto ya estaba timbrado; se recuperó el CFDI del portal sin volver a emitir." };
    }
    return {
      ok: false, error_code: "ya_facturado",
      msg: `Estrella Blanca: el portal marca el boleto ${comprobante} como YA TIMBRADO${boleto.FacturadoPorOtroPac ? " (facturado por otro PAC)" : ""} y no devuelve un CFDI para el RFC ${rfc}. NO se volvió a emitir. Se puede buscar a mano en factura.estrellablanca.com.mx → "Consultar Mis Facturas" con RFC y # Comprobante.`,
    };
  }

  const fechaVenta = parsearFecha(boleto.FechaVenta) || fechaOcr;
  if (Number(boleto.FacturableMes) === 0 || (fechaVenta && fueraDePlazo(fechaVenta))) {
    return {
      ok: false, error_code: "ticket_vencido", email_contacto: CONTACTO, permite_solicitud_correo: true,
      msg: `Estrella Blanca: el boleto se vendió el ${boleto.FechaVenta} y el plazo del portal ("el mes en que lo adquirió y hasta 7 días del mes siguiente") terminó el ${fechaVenta ? formatoLimite(fechaVenta) : "—"}${Number(boleto.FacturableMes) === 0 ? " (la API lo confirma: FacturableMes=0)" : ""}. Hay que pedirla por correo a ${CONTACTO} indicando # Comprobante ${comprobante}, TR ${tr} y total ${precio}.`,
    };
  }

  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error("BROWSERLESS_TOKEN no definido");
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true`,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1100 });
  // Sin esto, un alert() sin manejar cuelga el hilo y Browserless mata la
  // pestaña ("Session closed" / "Target closed"). Va lo primero, siempre.
  page.on("dialog", async (d) => { console.log(`   💬 dialog: ${d.message()}`); await d.accept().catch(() => {}); });

  // LA PRUEBA DEL TIMBRE. El mismo endpoint sirve para previsualizar y para
  // timbrar; lo que los separa es isGenerarCFDI en el cuerpo del POST.
  const respuesta = { preview: null, timbrado: null };
  page.on("response", async (res) => {
    try {
      if (!/\/Operacion\/generarCfdi/i.test(res.url())) return;
      if (res.request().method() !== "POST") return;
      const esFinal = /"isGenerarCFDI"\s*:\s*"1"/.test(res.request().postData() || "");
      const cuerpo = await res.json().catch(() => null);
      if (esFinal) respuesta.timbrado = { status: res.status(), cuerpo };
      else respuesta.preview = { status: res.status(), cuerpo };
      console.log(`   🌐 generarCfdi ${esFinal ? "TIMBRADO" : "previsualización"} → HTTP ${res.status()}`);
    } catch {}
  });

  const ts = ticketId || Date.now();
  const shot = async (etiqueta) => {
    try {
      const buf = await page.screenshot({ fullPage: false });
      console.log(`   📸 ${await subirArchivoR2(buf, `debug/estrellablanca_${ts}_${etiqueta}_${Date.now()}.png`, "image/png")}`);
    } catch {}
  };

  // Lee el modal que esté realmente abierto. Sin esto no se puede distinguir el
  // aviso inocuo del modal que confirma la emisión: son el MISMO componente.
  const modalActivo = () => page.evaluate(() => {
    const abiertos = Array.from(document.querySelectorAll(".modal-wrapper.active"));
    if (!abiertos.length) return null;
    const w = abiertos[abiertos.length - 1];
    const caja = w.querySelector(".modal") || w;
    const h = caja.querySelector("h4, h5");
    return {
      clase: (caja.className || "").toString(),
      titulo: h ? (h.textContent || "").trim() : "",
      texto: (w.innerText || "").replace(/\s+/g, " ").trim().slice(0, 400),
      botones: Array.from(w.querySelectorAll("button")).map((b) => (b.textContent || "").trim()),
    };
  }).catch(() => null);

  // Cierra un modal pulsando un botón suyo cuyo texto coincida, pero SOLO si el
  // título del modal es el esperado. Devuelve qué hizo, nunca undefined.
  const cerrarModal = (tituloEsperado, textoBoton) => page.evaluate((reTitulo, reBoton) => {
    const abiertos = Array.from(document.querySelectorAll(".modal-wrapper.active"));
    if (!abiertos.length) return { cerrado: false, motivo: "no hay modal abierto" };
    const w = abiertos[abiertos.length - 1];
    const caja = w.querySelector(".modal") || w;
    const h = caja.querySelector("h4, h5");
    const titulo = h ? (h.textContent || "").trim() : "";
    if (reTitulo && !new RegExp(reTitulo, "i").test(titulo)) {
      return { cerrado: false, motivo: `el modal abierto es "${titulo}", no el esperado`, titulo };
    }
    const b = Array.from(w.querySelectorAll("button")).find((x) => new RegExp(reBoton, "i").test((x.textContent || "").trim()));
    if (!b) return { cerrado: false, motivo: "no encontré el botón", titulo };
    b.click();
    return { cerrado: true, titulo };
  }, tituloEsperado, textoBoton);

  // Teclear de verdad: en un input controlado por React el .value puesto a mano
  // se ve en pantalla pero el estado del componente sigue vacío.
  const teclear = async (sel, texto) => {
    const existe = await page.$(sel);
    if (!existe) { console.log(`   ⚠️ no existe ${sel}`); return false; }
    await page.click(sel, { clickCount: 3 });
    await page.keyboard.press("Backspace");
    await page.keyboard.type(String(texto), { delay: 35 });
    const v = await page.$eval(sel, (e) => e.value);
    const ok = String(v).trim().toUpperCase() === String(texto).trim().toUpperCase();
    console.log(`   ✏️ ${sel} = "${v}"${ok ? "" : "  ⚠️ NO COINCIDE"}`);
    return ok;
  };

  let timbradoDisparado = false;
  try {
    // ── PASO 1: el boleto ──────────────────────────────────────────────────
    console.log(`🌐 ${PORTAL}`);
    await page.goto(PORTAL, { waitUntil: "networkidle2", timeout: 60000 });
    await page.waitForSelector("#NoComprobante", { timeout: 30000 });
    await sleep(2500);

    const aviso = await cerrarModal("aviso importante", "^\\s*aceptar\\s*$");
    console.log(`   🚪 Aviso Importante: ${JSON.stringify(aviso)}`);
    await sleep(1200);

    // Los ids del paso 1 empiezan por MAYÚSCULA (#NoComprobante, #NoTr,
    // #Precio); los del modal fiscal van en minúscula. #noComprobante es null.
    const okComprobante = await teclear("#NoComprobante", comprobante);
    const okTr = await teclear("#NoTr", tr);
    const okPrecio = await teclear("#Precio", precio);
    if (!okComprobante || !okTr || !okPrecio) {
      await shot("error_campos_boleto");
      await browser.close();
      return { ok: false, error_code: "reintentar_despues", msg: "Estrella Blanca: no se pudieron teclear los datos del boleto (¿quedó un modal tapando la página?). No se emitió nada." };
    }
    await shot("p1_boleto");

    const pulsadoAnadir = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("button"))
        .find((x) => /a[ñn]adir\s+boleto/i.test(x.textContent || "") && !x.disabled);
      if (!b) return false;
      b.click();
      return true;
    });
    if (!pulsadoAnadir) {
      await shot("error_sin_anadir");
      await browser.close();
      return { ok: false, error_code: "reintentar_despues", msg: 'Estrella Blanca: no apareció el botón "Añadir boleto". No se emitió nada.' };
    }

    // Espera al modal que confirma (o al que da el error) en vez de dormir a ciegas.
    await page.waitForFunction(() => document.querySelectorAll(".modal-wrapper.active").length > 0, { timeout: 30000 }).catch(() => {});
    const tras = await modalActivo();
    console.log(`   🚪 tras Añadir boleto: ${JSON.stringify(tras)}`);
    await shot("p2_boleto_anadido");

    // El modal de error se llama "Ups...". OJO: el de éxito dice "Boleto(s)
    // añadido(s)" AUNQUE la lista venga vacía, así que no vale como prueba: la
    // prueba es que la tabla tenga la fila. Por eso se comprueba más abajo.
    if (tras && /ups/i.test(tras.titulo + " " + tras.texto)) {
      await cerrarModal(null, "^\\s*cerrar\\s*$");
      await browser.close();
      const t = tras.texto || "";
      if (/no se encontr|verificar los datos/i.test(t)) {
        return { ok: false, error_code: "datos_invalidos", msg: `Estrella Blanca: el portal rechazó el boleto — ${t.slice(0, 220)}` };
      }
      return { ok: false, error_code: "reintentar_despues", msg: `Estrella Blanca: el portal dio un error al añadir el boleto — ${t.slice(0, 220)}. No se emitió nada.` };
    }
    await cerrarModal(null, "^\\s*cerrar\\s*$");
    await sleep(1500);

    // Prueba real de que el boleto entró: la fila en la tabla con su folio.
    const tabla = await page.evaluate((folio) => {
      const filas = Array.from(document.querySelectorAll("table tr"))
        .map((r) => (r.innerText || "").replace(/\s+/g, " ").trim()).filter(Boolean);
      const siguiente = Array.from(document.querySelectorAll("button"))
        .find((b) => /^\s*siguiente\s*$/i.test(b.textContent || ""));
      return {
        filas: filas.slice(0, 6),
        tieneFolio: filas.some((f) => f.toUpperCase().includes(String(folio).toUpperCase())),
        siguienteHabilitado: !!(siguiente && !siguiente.disabled),
      };
    }, comprobante);
    console.log(`   📋 tabla: ${JSON.stringify(tabla)}`);
    if (!tabla.tieneFolio || !tabla.siguienteHabilitado) {
      await shot("error_sin_fila");
      await browser.close();
      return { ok: false, error_code: "datos_invalidos", msg: `Estrella Blanca: el boleto ${comprobante} no apareció en la tabla después de "Añadir boleto" (el modal de confirmación sale igual aunque la lista venga vacía). Filas: ${JSON.stringify(tabla.filas).slice(0, 200)}` };
    }

    // Sin marcar la casilla, "Siguiente" contesta "Selecciona al menos un boleto".
    const marcado = await page.evaluate(() => {
      const cbs = Array.from(document.querySelectorAll('input[type=checkbox]'))
        .filter((c) => c.offsetWidth || c.offsetHeight);
      cbs.forEach((c) => { if (!c.checked) c.click(); });
      return cbs.length > 0 && cbs.every((c) => c.checked);
    });
    console.log(`   ☑️ casillas marcadas: ${marcado}`);
    if (!marcado) {
      await shot("error_sin_casilla");
      await browser.close();
      return { ok: false, error_code: "reintentar_despues", msg: "Estrella Blanca: no se pudo marcar la casilla del boleto. No se emitió nada." };
    }
    await sleep(800);

    const pulsadoSiguiente = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("button"))
        .find((x) => /^\s*siguiente\s*$/i.test(x.textContent || "") && !x.disabled);
      if (!b) return false;
      b.click();
      return true;
    });
    if (!pulsadoSiguiente) {
      await shot("error_sin_siguiente");
      await browser.close();
      return { ok: false, error_code: "reintentar_despues", msg: 'Estrella Blanca: no se pudo pulsar "Siguiente". No se emitió nada.' };
    }

    // ── PASO 2: el modal fiscal y LA CASCADA QUE ESTABA ROTA ───────────────
    // #rfc está en el DOM desde el primer render aunque el modal esté cerrado,
    // y hasta getClientRects() lo da por visible: lo que de verdad dice que el
    // modal está abierto es la clase 'active' de su .modal-wrapper.
    const modalFiscal = await page.waitForFunction(() => {
      const e = document.getElementById("rfc");
      if (!e) return false;
      const w = e.closest(".modal-wrapper");
      return !!(w && w.classList.contains("active"));
    }, { timeout: 30000 }).then(() => true).catch(() => false);
    console.log(`   🪟 modal "Información de Facturación" abierto: ${modalFiscal}`);
    if (!modalFiscal) {
      await shot("error_sin_modal_fiscal");
      await browser.close();
      return { ok: false, error_code: "reintentar_despues", msg: "Estrella Blanca: no se abrió el modal de datos fiscales tras Siguiente. No se emitió nada." };
    }
    await shot("p3_modal_fiscal");

    // El radio input[name=nacionalidad][value=mex] ya viene marcado: no se toca.
    const okRfc = await teclear("#rfc", rfc);
    if (!okRfc) {
      await shot("error_rfc");
      await browser.close();
      return { ok: false, error_code: "reintentar_despues", msg: "Estrella Blanca: no se pudo teclear el RFC en el modal fiscal. No se emitió nada." };
    }
    // ESTE focusout es el que dispara obtenerRegimenFiscal. Sin él no hay
    // catálogo, y ese fue el bloqueo de semanas.
    await page.keyboard.press("Tab");
    await page.evaluate(() => { const e = document.getElementById("rfc"); if (e) e.blur(); });

    const hayRegimenes = await page.waitForFunction(
      () => { const e = document.getElementById("regimenFiscal"); return !!(e && e.options.length > 1); },
      { timeout: 30000 }
    ).then(() => true).catch(() => false);
    console.log(`   🔁 catálogo de Régimen Fiscal poblado: ${hayRegimenes}`);
    if (!hayRegimenes) {
      await shot("error_sin_regimenes");
      await browser.close();
      return { ok: false, error_code: "reintentar_despues", msg: `Estrella Blanca: el portal no devolvió el catálogo de Régimen Fiscal para el RFC ${rfc} (GET /Catalogos/obtenerRegimenFiscal). No se emitió nada.` };
    }

    // Se elige por la ETIQUETA porque el value es IdRegimenFiscal (601 => "1").
    // El setter nativo evita que React descarte el cambio.
    const elegirPorEtiqueta = (sel, clave) => page.evaluate((s, c) => {
      const el = document.querySelector(s);
      if (!el) return { ok: false, motivo: "no existe el select" };
      const op = Array.from(el.options).find((o) => new RegExp("^\\s*" + c + "\\b").test(o.textContent || ""))
        || Array.from(el.options).find((o) => o.value === c);
      if (!op) return { ok: false, motivo: `sin opción "${c}"`, hay: el.options.length };
      Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set.call(el, op.value);
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: el.value === op.value, value: op.value, label: (op.textContent || "").trim() };
    }, sel, clave);

    const reg = await elegirPorEtiqueta("#regimenFiscal", claveRegimen);
    console.log(`   🔽 #regimenFiscal → ${JSON.stringify(reg)}`);
    if (!reg.ok) {
      await shot("error_regimen");
      await browser.close();
      return { ok: false, error_code: "datos_invalidos", msg: `Estrella Blanca: el portal no ofrece el régimen fiscal ${claveRegimen} para el RFC ${rfc} (${reg.motivo || ""}). No se emitió nada.` };
    }

    // El onChange del régimen dispara obtenerUsoCfdi: el segundo escalón.
    const hayUsos = await page.waitForFunction(
      () => { const e = document.getElementById("usoCfdi"); return !!(e && e.options.length > 1); },
      { timeout: 30000 }
    ).then(() => true).catch(() => false);
    console.log(`   🔁 catálogo de Uso de CFDI poblado: ${hayUsos}`);
    if (!hayUsos) {
      await shot("error_sin_usos");
      await browser.close();
      return { ok: false, error_code: "reintentar_despues", msg: `Estrella Blanca: el portal no devolvió el catálogo de Uso de CFDI (GET /Catalogos/obtenerUsoCfdi?rfc=${rfc}&regimenFiscal=${reg.value}). No se emitió nada.` };
    }

    // Aquí el value SÍ es la clave del SAT ("G03").
    const uso = await elegirPorEtiqueta("#usoCfdi", claveUso);
    console.log(`   🔽 #usoCfdi → ${JSON.stringify(uso)}`);
    if (!uso.ok) {
      await shot("error_uso");
      await browser.close();
      return { ok: false, error_code: "datos_invalidos", msg: `Estrella Blanca: el portal no ofrece el uso de CFDI ${claveUso} para el régimen ${claveRegimen} (${uso.motivo || ""}). No se emitió nada.` };
    }

    // Domicilio: el portal solo marca con * RFC, Nombre, Régimen, Uso, C.P. y
    // correo. El resto se rellena si viene en los datos; si el receptor no es
    // GPN no se le inventa el domicilio de GPN.
    const esGPN = String(rfc).toUpperCase() === RFC_GPN;
    const dom = {
      calle: datos.calle || (esGPN ? DOMICILIO_GPN.calle : ""),
      noExterior: datos.noExterior || datos.numeroExterior || (esGPN ? DOMICILIO_GPN.noExterior : ""),
      colonia: datos.colonia || (esGPN ? DOMICILIO_GPN.colonia : ""),
      municipio: datos.municipio || datos.ciudad || (esGPN ? DOMICILIO_GPN.municipio : ""),
      estado: datos.estado || (esGPN ? DOMICILIO_GPN.estado : ""),
      pais: datos.pais || (esGPN ? DOMICILIO_GPN.pais : ""),
    };

    // ⚠️ EL CORREO ES SIEMPRE emailEntrega (el buzón de captura). Si aquí va el
    // del residente, el CFDI se emite y el sistema nunca lo recibe por IMAP.
    const okNombre = await teclear("#nombreRazonSocial", razonSocial);
    const okCp = await teclear("#codigoPostal", String(codigoPostal));
    const okCorreo = await teclear("#email", correo);
    for (const [sel, valor] of [["#calle", dom.calle], ["#noExterior", dom.noExterior], ["#colonia", dom.colonia],
      ["#municipio", dom.municipio], ["#estado", dom.estado], ["#pais", dom.pais]]) {
      if (valor) await teclear(sel, valor);
    }
    if (!okNombre || !okCp || !okCorreo) {
      await shot("error_datos_fiscales");
      await browser.close();
      return { ok: false, error_code: "reintentar_despues", msg: `Estrella Blanca: no se pudieron escribir los datos fiscales obligatorios (nombre:${okNombre} cp:${okCp} correo:${okCorreo}). No se emitió nada.` };
    }
    await sleep(1000);
    await shot("p4_modal_completo");

    // ── El "Facturar" DEL MODAL: previsualiza (isGenerarCFDI:"0"), NO timbra.
    // Se filtra por clase porque hay otro "Facturar" que sí timbra.
    const estadoBotonPreview = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("button"))
        .find((x) => /^\s*facturar\s*$/i.test(x.textContent || "") && /ternary-second/.test(x.className || ""));
      return b ? { existe: true, disabled: !!b.disabled } : { existe: false };
    });
    if (!estadoBotonPreview.existe || estadoBotonPreview.disabled) {
      await shot("error_preview_disabled");
      await browser.close();
      return { ok: false, error_code: "datos_invalidos", msg: `Estrella Blanca: el botón "Facturar" del modal fiscal sigue deshabilitado (${JSON.stringify(estadoBotonPreview)}): el portal considera que faltan datos obligatorios. No se emitió nada.` };
    }
    const pulsadoPreview = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("button"))
        .find((x) => /^\s*facturar\s*$/i.test(x.textContent || "") && /ternary-second/.test(x.className || "") && !x.disabled);
      if (!b) return false;
      b.click();
      return true;
    });
    if (!pulsadoPreview) {
      await shot("error_sin_preview");
      await browser.close();
      return { ok: false, error_code: "reintentar_despues", msg: "Estrella Blanca: no se pudo pulsar el Facturar del modal (previsualización). No se emitió nada." };
    }

    // ── PASO 3: la prefactura. Es la pantalla ANTERIOR al timbre.
    const enPaso3 = await page.waitForFunction(
      () => /Revisa tus datos para realizar tu factura final/i.test(document.body.innerText || ""),
      { timeout: 60000 }
    ).then(() => true).catch(() => false);
    await sleep(1500);
    await shot("p5_prefactura");

    if (!enPaso3) {
      const err = await modalActivo();
      await browser.close();
      const t = err ? `${err.titulo} ${err.texto}` : "(sin modal)";
      console.log(`   ⚠️ no se llegó a la prefactura: ${t}`);
      // La previsualización NO timbra: aquí todavía no existe ningún CFDI.
      return { ok: false, error_code: "datos_invalidos", msg: `Estrella Blanca: el portal no generó la previsualización de la factura. Respuesta: ${t.slice(0, 250)}. No se emitió nada.` };
    }

    // La "Forma de pago" es un react-select que llega preseleccionado con la
    // FormaPago del boleto (28 = tarjeta de débito en estos tickets). Si
    // estuviera vacío, el portal contesta "Por favor selecciona la forma de
    // pago" y NO timbra: mejor parar antes que pulsar a ciegas.
    const prefactura = await page.evaluate(() => {
      const txt = (document.body.innerText || "").replace(/\s+/g, " ");
      const control = document.querySelector('[class*="-control"]');
      return {
        formaPago: control ? (control.textContent || "").trim() : "",
        total: (txt.match(/Total:\s*([\d,]+\.?\d*)/) || [])[1] || null,
        receptor: /RFC:\s*([A-Z0-9]{12,13})/.test(txt),
      };
    });
    console.log(`   🧾 prefactura: ${JSON.stringify(prefactura)}`);
    if (!prefactura.formaPago) {
      await shot("error_sin_forma_pago");
      await browser.close();
      return { ok: false, error_code: "reintentar_despues", msg: 'Estrella Blanca: la "Forma de pago" de la prefactura llegó vacía; el portal rechazaría el timbrado. No se emitió nada.' };
    }
    if (prefactura.total && Number(prefactura.total.replace(/,/g, "")).toFixed(2) !== Number(precio).toFixed(2)) {
      await shot("error_total_distinto");
      await browser.close();
      return { ok: false, error_code: "datos_invalidos", msg: `Estrella Blanca: el total de la prefactura (${prefactura.total}) no coincide con el del ticket (${precio}). No se timbró nada; revisar el importe antes de reintentar.` };
    }

    // Este click NO emite: solo abre el modal de confirmación. Aun así se
    // envuelve en waitForNavigation por si el submit llegara a navegar (los
    // botones son type=submit). El timeout es corto porque en un SPA nunca se
    // cumple: se paga entero en cada corrida.
    const pulsadoFacturar = (await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 8000 }).catch(() => {}),
      page.evaluate(() => {
        const b = Array.from(document.querySelectorAll("button"))
          .find((x) => /^\s*facturar\s*$/i.test(x.textContent || "")
            && /\bprimary\b/.test(x.className || "") && !/ternary/.test(x.className || "") && !x.disabled);
        if (!b) return false;
        b.click();
        return true;
      }),
    ]))[1];
    if (!pulsadoFacturar) {
      await shot("error_sin_facturar_paso3");
      await browser.close();
      return { ok: false, error_code: "reintentar_despues", msg: 'Estrella Blanca: no se encontró el botón "Facturar" (class primary) del paso 3. No se emitió nada.' };
    }

    // El modal de confirmación es el MISMO componente que el "Aviso
    // Importante": hay que comprobar el título y el texto antes de pulsar su
    // "Aceptar", porque ese Aceptar es el que timbra.
    const hayConfirmacion = await page.waitForFunction(() => {
      const abiertos = Array.from(document.querySelectorAll(".modal-wrapper.active"));
      if (!abiertos.length) return false;
      const w = abiertos[abiertos.length - 1];
      const h = w.querySelector("h4");
      const titulo = h ? (h.textContent || "").trim() : "";
      return /^facturar$/i.test(titulo) && /Desea confirmar la emisi/i.test(w.innerText || "");
    }, { timeout: 30000 }).then(() => true).catch(() => false);
    const confirma = await modalActivo();
    console.log(`   🪟 modal de confirmación: ${hayConfirmacion} ${JSON.stringify(confirma)}`);
    await shot("p6_confirmacion");

    if (!hayConfirmacion) {
      await browser.close();
      return { ok: false, error_code: "reintentar_despues", msg: `Estrella Blanca: no salió el modal "¿Desea confirmar la emisión de la factura?". No se emitió nada. Pantalla: ${confirma ? confirma.texto.slice(0, 200) : "(sin modal)"}` };
    }

    // ══ AQUÍ SE EMITE ═════════════════════════════════════════════════════
    // A partir de la línea siguiente ningún camino puede devolver un error
    // reintentable: el reintento de medianoche emitiría un SEGUNDO CFDI sobre
    // el mismo boleto, y cancelar ante el SAT es un marrón.
    timbradoDisparado = true;
    const pulsadoAceptar = (await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 20000 }).catch(() => {}),
      page.evaluate(() => {
        const abiertos = Array.from(document.querySelectorAll(".modal-wrapper.active"));
        if (!abiertos.length) return false;
        const w = abiertos[abiertos.length - 1];
        const h = w.querySelector("h4");
        const titulo = h ? (h.textContent || "").trim() : "";
        // Doble cinturón: solo se pulsa el Aceptar del modal correcto.
        if (!/^facturar$/i.test(titulo) || !/Desea confirmar la emisi/i.test(w.innerText || "")) return false;
        const b = Array.from(w.querySelectorAll("button")).find((x) => /^\s*aceptar\s*$/i.test((x.textContent || "").trim()));
        if (!b) return false;
        b.click();
        return true;
      }),
    ]))[1];

    if (!pulsadoAceptar) {
      // El evaluate busca y pulsa en la MISMA vuelta: si devuelve false, el
      // click no llegó a salir y no hay CFDI. Es el único caso en que se puede
      // deshacer la bandera con la conciencia tranquila.
      timbradoDisparado = false;
      await shot("error_sin_aceptar");
      await browser.close();
      return { ok: false, error_code: "reintentar_despues", msg: 'Estrella Blanca: no se pudo pulsar el "Aceptar" del modal de confirmación; el click nunca salió y no se emitió nada.' };
    }
    console.log("   ⏳ timbrando (POST generarCfdi con isGenerarCFDI:1)...");

    // La prueba puede llegar por dos sitios: la respuesta del POST (que trae el
    // UUID y los archivos en base64) o la pantalla final. Se esperan las dos.
    let pantallaLista = false;
    const pantallaFinal = page.waitForFunction(
      () => /Tu factura se gener[óo] correctamente|Tu factura\s+est[áa] lista/i.test(document.body.innerText || ""),
      { timeout: 120000 }
    ).then(() => { pantallaLista = true; return true; }).catch(() => false);
    for (let i = 0; i < 120 && !respuesta.timbrado; i++) await sleep(1000);
    // Si el timbrado falla, la pantalla de éxito NO llega nunca: sin esta
    // carrera nos quedaríamos los 120 s enteros esperándola para nada.
    const huboPantalla = await Promise.race([pantallaFinal, sleep(10000).then(() => pantallaLista)]);
    await sleep(1500);
    await shot("p7_resultado");

    const timbradas = respuesta.timbrado
      && respuesta.timbrado.cuerpo
      && respuesta.timbrado.cuerpo.data
      && Array.isArray(respuesta.timbrado.cuerpo.data.FacturasTimbradas)
      ? respuesta.timbrado.cuerpo.data.FacturasTimbradas : null;
    const conError = timbradas ? timbradas.filter((f) => f.Error) : [];
    const buena = timbradas ? timbradas.find((f) => f.Uuid && !f.Error) : null;
    console.log(`   🧾 respuesta del timbrado: ${timbradas ? `${timbradas.length} factura(s), ${conError.length} con error` : "no capturada"} | pantalla final: ${huboPantalla}`);

    if (buena) {
      // PRUEBA DE VERDAD: UUID emitido por el PAC. El XML y el PDF vienen en la
      // misma respuesta en base64, así que no hace falta pelear con la descarga
      // del navegador (que además el sandbox bloquearía).
      const uuid = buena.Uuid;
      const bufXml = buena.ArchivoXML ? Buffer.from(buena.ArchivoXML, "base64") : null;
      const bufPdf = buena.ArchivoPDF ? Buffer.from(buena.ArchivoPDF, "base64") : null;
      await browser.close();
      const xmlUrl = await subir(bufXml, `${uuid}.xml`, "application/xml");
      const pdfUrl = await subir(bufPdf, `${uuid}.pdf`, "application/pdf");
      if (xmlUrl || pdfUrl) {
        console.log(`✅ Estrella Blanca OK — UUID ${uuid} — ${xmlUrl || pdfUrl}`);
        return { ok: true, xmlUrl, pdfUrl, uuid };
      }
      // El CFDI existe (hay UUID) pero no se pudo guardar el archivo. El portal
      // lo manda además al correo capturado, así que IMAP lo recogerá.
      return {
        ok: true, procesandoCorreo: true, uuid,
        msg: `Estrella Blanca: CFDI TIMBRADO (UUID ${uuid}) pero no se pudieron guardar los archivos en R2. Llega también por correo a ${correo}. NO RELANZAR: el CFDI ya existe.`,
      };
    }

    // No hay UUID en la respuesta. NO se inventa nada: se le vuelve a preguntar
    // al portal, que es quien sabe si hay CFDI o no.
    const consta = await constaComoTimbrado(comprobante, tr, precio, rfc);
    console.log(`   🔎 ¿el portal lo da por timbrado?: ${consta}`);

    if (consta) {
      const rec = await recuperarCfdiExistente(rfc, comprobante);
      await browser.close();
      if (rec && (rec.xmlUrl || rec.pdfUrl)) {
        console.log(`✅ Estrella Blanca OK — CFDI recuperado del portal (${rec.uuid})`);
        return { ok: true, xmlUrl: rec.xmlUrl, pdfUrl: rec.pdfUrl, uuid: rec.uuid };
      }
      return {
        ok: true, procesandoCorreo: true,
        msg: `Estrella Blanca: el portal confirma que el boleto ${comprobante} YA ESTÁ TIMBRADO, pero no se pudieron bajar los archivos. El CFDI llega por correo a ${correo}. NO RELANZAR: comprobar antes en factura.estrellablanca.com.mx → "Consultar Mis Facturas" (RFC ${rfc}, # Comprobante ${comprobante}).`,
      };
    }

    await browser.close();
    const detalle = conError.length
      ? conError.map((f) => `${f.Error}: ${f.DetalleError || ""}`).join(" | ")
      : (respuesta.timbrado && respuesta.timbrado.cuerpo && (respuesta.timbrado.cuerpo.error || ""))
        || (huboPantalla ? "salió la pantalla de éxito pero sin UUID" : "el portal no respondió al timbrado");

    // Se pulsó el botón que emite y el portal dice que NO hay CFDI. Aun así NO
    // se devuelve un error reintentable: la regla del proyecto es que después
    // de ese click nadie vuelve solo al portal de madrugada. datos_invalidos
    // devuelve el ticket a confirmación humana, que es quien debe decidir.
    return {
      ok: false, error_code: "datos_invalidos",
      msg: `Estrella Blanca: se pulsó el botón de emitir y el portal NO timbró (${String(detalle).slice(0, 220)}). Comprobado por API después del intento: el boleto ${comprobante} NO consta como timbrado y no hay CFDI para el RFC ${rfc}. Revisar los datos y relanzar a mano; no se reintenta solo para no arriesgar un CFDI duplicado.`,
    };
  } catch (err) {
    console.error(`❌ Estrella Blanca: ${err.message}`);
    await shot("error_excepcion").catch(() => {});
    try { await browser.close(); } catch {}

    if (timbradoDisparado) {
      // El click que emite ya había salido: jamás un error reintentable aquí.
      return {
        ok: true, procesandoCorreo: true,
        msg: `Estrella Blanca: el bot falló (${err.message}) DESPUÉS de pulsar el "Aceptar" que timbra. El CFDI llega por correo a ${correo}. NO RELANZAR: comprobar antes en factura.estrellablanca.com.mx → "Consultar Mis Facturas" (RFC ${rfc}, # Comprobante ${comprobante}) si el CFDI ya existe.`,
      };
    }
    return { ok: false, error_code: "reintentar_despues", msg: `Estrella Blanca: ${err.message} (no se emitió nada)` };
  }
}

module.exports = { facturarEstrellaBlanca };
