// Utilidades compartidas entre server.js y worker.js.
// Extraídas de server.js en la FASE 1 (colas) sin cambios de comportamiento.
const db = require("./db");
const { subirArchivoR2, borrarArchivoR2 } = require("../storage/r2");

const PORTALES_CONOCIDOS = ['oxxo', 'arco', 'gasmaz', 'homedepot', 'buzonfacturas', 'farmaciaguadalajara', 'rendichicas', 'benavides', 'panama'];

// Portales que la cola de bots puede facturar automáticamente (antes: gate SQL de
// procesarCola en server.js). Un ticket es "facturable" si su portal está en la
// lista, o si el portal es desconocido pero la URL/comercio corresponden a un bot.
// ⚠️ REGISTRO OBLIGATORIO AL AGREGAR UN BOT NUEVO ─────────────────────────────
// Un bot en bots/index.js NO se ejecuta solo por estar enrutado ahí: el pipeline
// solo lo alcanza si el portal pasa este gate. Si el portal queda fuera de estas
// listas, el ticket se queda en 'pendiente_confirmacion' y — peor — el agente de
// alta automática lo trata como portal NUEVO y genera un bot DUPLICADO
// (pasó de verdad: el orquestador creó "autopistadecuotacasetaelpisals.js"
// compitiendo con bots/orler.js, ver deploy del 2026-07-29).
// Al agregar un bot hay que tocar TRES lugares:
//   1. bots/index.js       → routing
//   2. PORTALES_FACTURABLES (aquí) → gate de la cola
//   3. lib/vision.js       → detección de portal por comercio/URL en el OCR
const PORTALES_FACTURABLES = [
  'oxxo', 'arco', 'gasmaz', 'farmaciaguadalajara', 'homedepot', 'buzonfacturas', 'rendichicas',
  'benavides', 'panama', 'sushito', 'sushio', 'carljr', 'elcaporal', 'elcaporalrestaurante',
  'allegro', 'allegrecaffe', 'allegrezonadorada', 'autozone', 'albatros', '7eleven', 'dana', 'tufesa', 'bodegaaurrera',
  // Bots de gasolineras/casetas dados de alta en jul-2026 (sesiones 27-29/07).
  // Estaban huérfanos: enrutados en bots/index.js pero fuera de este gate.
  'orler', 'petrofigues', 'gashr', 'facturagas', 'erfc', 'enerfueltech', 'ramcal',
  // CAFFENIO: la búsqueda del ticket sí está verificada en vivo y el portal no
  // tiene CAPTCHA, así que entra al gate. El tramo posterior (datos fiscales →
  // timbrado) aún no está verificado y el bot devuelve un error explícito en vez
  // de fingir éxito, así que lo peor que puede pasar es un error controlado con
  // screenshot — nunca una factura inventada. Ver cabecera de bots/caffenio.js.
  'caffenio',
  // CAPUFE: el bot llevaba sesiones escrito pero nunca se registró aquí ni en
  // bots/index.js, así que sus tickets caían en "portal no reconocido" y
  // disparaban al agente de altas para un portal que ya tenía bot.
  'capufe', 'igasfac',
  // NOTA: 'oxxogas' se deja FUERA a propósito — su bot requiere una cookie de
  // sesión inyectada a mano por el usuario (login con reCAPTCHA v2 que no se
  // resuelve nunca). Si entrara al gate, cada ticket gastaría intentos en vano.
];
const URLS_FACTURABLES = [
  'autozone', 'origon.cloud', 'albatrosautobuses', 'grupoalbatros', 'mefacturo.mx', 'elcaporal', 'allegre', 'sushio', 'analytix360',
  'tufesa', 'e7-eleven', 'softrestaurant.com',
  // Bots nuevos, por URL impresa en el ticket (el OCR a veces no acierta la
  // clave de portal pero sí copia la URL).
  'sinaloa.gob.mx', 'facturacionestacion.com', 'petrofigues', 'valerogdl',
  'facturagas.net', 'erfc.com.mx', 'enerfueltech.com', 'corporativoramcal', 'ramcal.no-ip',
  'facturaciondrive.caffenio', 'facturacioncapufe', 'capufe.gob.mx',
  '1gasfac', 'lgasfac', 'igasfac',
];

// Comercios cuyo portal de facturación bloquea el acceso automatizado (p.ej.
// protección anti-bots de Cloudflare que rechaza toda la infraestructura de
// automatización, no solo un endpoint puntual — confirmado en vivo con
// soriana.com, ver debate en la sesión del 27-jul). No se intenta evadir esa
// protección; en vez de tratarlos como "portal nuevo" para el agente de alta
// automática, se bloquean explícitamente con un mensaje claro al residente.
const COMERCIOS_NO_AUTOMATIZABLES = ['soriana'];

function esComercioBloqueado(comercio = '') {
  const c = (comercio || '').toLowerCase();
  return COMERCIOS_NO_AUTOMATIZABLES.some(b => c.includes(b));
}

function esPortalFacturable(datosOCR = {}, portalUrl = '') {
  const portal = (datosOCR.portal || '').toLowerCase();
  const url = (portalUrl || datosOCR.portalUrl || '').toLowerCase();
  const comercio = (datosOCR.comercio || '').toLowerCase();
  if (PORTALES_FACTURABLES.includes(portal)) return true;
  if (portal === 'desconocido' || !portal) {
    if (URLS_FACTURABLES.some(u => url.includes(u))) return true;
    if (comercio.includes('autozone') || comercio.includes('eleven')) return true;
  }
  return false;
}

async function crearNotificacion(userId, tipo, mensaje) {
  try {
    await db.query(
      "INSERT INTO notificaciones (user_id, tipo, mensaje) VALUES (?, ?, ?)",
      [userId, tipo, mensaje]
    );
  } catch (e) {
    console.error("⚠️ crearNotificacion:", e.message);
  }
}

async function registrarIntento(ticketId, bot, resultado, mensaje, duracionMs, screenshotUrls = []) {
  try {
    await db.query(
      "INSERT INTO ticket_intentos (ticket_id, bot, resultado, mensaje, screenshot_urls, duracion_ms) VALUES (?, ?, ?, ?, ?, ?)",
      [ticketId, bot || null, resultado, mensaje || null,
       screenshotUrls.length ? JSON.stringify(screenshotUrls) : null, duracionMs || null]
    );
  } catch (e) {
    console.error("⚠️ registrarIntento:", e.message);
  }
}

// Calcula la próxima medianoche (hora local del servidor)
function proximaMedianoche() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  return d;
}

// Extrae el UUID del CFDI desde el contenido XML (atributo UUID de TimbreFiscalDigital)
function extraerUUIDcfdi(xmlBuffer) {
  try {
    const xml = xmlBuffer.toString('utf8');
    const m = xml.match(/UUID="([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i);
    return m ? m[1].toLowerCase() : null;
  } catch { return null; }
}

// Descarga XML desde R2, extrae UUID, re-sube XML y PDF con nombre facturas/{uuid},
// borra los archivos originales y devuelve { xmlUrl, pdfUrl } con los nuevos nombres.
// Si no puede extraer UUID, devuelve las URLs originales sin cambios.
async function renombrarConUUID(xmlUrlOrig, pdfUrlOrig, comercio) {
  try {
    const r2Base = process.env.R2_PUBLIC_URL;
    if (!r2Base || !xmlUrlOrig) return { xmlUrl: xmlUrlOrig, pdfUrl: pdfUrlOrig };

    const xmlResp = await fetch(xmlUrlOrig).catch(() => null);
    if (!xmlResp?.ok) return { xmlUrl: xmlUrlOrig, pdfUrl: pdfUrlOrig };
    const xmlBuf = Buffer.from(await xmlResp.arrayBuffer());

    const uuid = extraerUUIDcfdi(xmlBuf);
    if (!uuid) {
      console.log('⚠️ UUID no encontrado en XML — se mantienen nombres originales');
      return { xmlUrl: xmlUrlOrig, pdfUrl: pdfUrlOrig };
    }

    const prefijo = `facturas/${uuid}`;
    console.log(`🔖 UUID CFDI: ${uuid}`);

    const xmlUrl = await subirArchivoR2(xmlBuf, `${prefijo}.xml`, 'application/xml');

    let pdfUrl = pdfUrlOrig;
    if (pdfUrlOrig) {
      const pdfResp = await fetch(pdfUrlOrig).catch(() => null);
      if (pdfResp?.ok) {
        const pdfBuf = Buffer.from(await pdfResp.arrayBuffer());
        pdfUrl = await subirArchivoR2(pdfBuf, `${prefijo}.pdf`, 'application/pdf');
      }
    }

    const xmlKeyOrig = xmlUrlOrig.replace(r2Base + '/', '');
    const pdfKeyOrig = pdfUrlOrig?.replace(r2Base + '/', '');
    if (xmlUrl && xmlKeyOrig !== `${prefijo}.xml`) await borrarArchivoR2(xmlKeyOrig);
    if (pdfUrl && pdfKeyOrig && pdfKeyOrig !== `${prefijo}.pdf`) await borrarArchivoR2(pdfKeyOrig);

    return { xmlUrl, pdfUrl };
  } catch (e) {
    console.log('⚠️ renombrarConUUID error:', e.message);
    return { xmlUrl: xmlUrlOrig, pdfUrl: pdfUrlOrig };
  }
}

// ── Correcciones OCR OXXO ──
function corregirIdVentaOxxo(id) {
  if (!id) return id;
  const s = String(id).toUpperCase().replace(/\s/g, '');
  if (s.length !== 11) return s;
  const c = s.split('');
  // Posiciones de DÍGITO (0,1,5,6,10): letra confundible → dígito
  const L2D = { O:'0', I:'1', L:'1', T:'1', S:'5', B:'8', G:'6', Z:'2' };
  // Posiciones de LETRA (2,3,4): dígito confundible → letra
  const D2L = { '0':'O', '1':'I', '5':'S', '8':'B', '6':'G', '2':'Z' };
  for (const i of [0, 1, 5, 6, 10]) c[i] = L2D[c[i]] ?? c[i];
  for (const i of [2, 3, 4])        c[i] = D2L[c[i]] ?? c[i];
  return c.join('');
}

function corregirFolioOxxo(folio) {
  if (!folio) return folio;
  return String(folio).replace(/[OoSsIiTt]/g,
    c => ({ O:'0', o:'0', S:'5', s:'5', I:'1', i:'1', T:'1', t:'1' }[c] || c)
  );
}

function validarDatosOxxo(datos) {
  const errores = [];
  if (!datos.folio || !/^\d+$/.test(String(datos.folio).replace(/\s/, '')))
    errores.push('folio inválido: ' + datos.folio);
  const idVentaNorm = corregirIdVentaOxxo(String(datos.idVenta || '').toUpperCase().replace(/\s/g, ''));
  if (!idVentaNorm || idVentaNorm.length !== 11 || !/^\d{2}[A-Z]{3}\d{2}[A-Z0-9]+\d{1,2}$/.test(idVentaNorm))
    errores.push(`idVenta inválido (${idVentaNorm.length} chars, esperado 11): ${datos.idVenta}`);
  if (!datos.total || isNaN(parseFloat(datos.total)))
    errores.push('total inválido: ' + datos.total);
  return errores;
}

// Corrige el AÑO mal leído por el OCR. Los tickets siempre son recientes (días),
// así que si el OCR leyó un año implausible, reasignamos el año más reciente
// —entre el actual y el anterior— que NO caiga en el futuro, conservando día y mes.
function corregirAnioReciente(fechaStr) {
  if (!fechaStr || typeof fechaStr !== 'string') return fechaStr;
  const s = fechaStr.trim();
  let dd, mm, yyyy, formato, m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)))      { yyyy = +m[1]; mm = +m[2]; dd = +m[3]; formato = 'YMD'; }
  else if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) { dd = +m[1]; mm = +m[2]; yyyy = +m[3]; formato = 'DMY'; }
  else return fechaStr;
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return fechaStr;

  const hoy = new Date();
  const cap = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() + 2); // tolera 2 días
  let mejor = null;
  for (const a of [hoy.getFullYear(), hoy.getFullYear() - 1]) {
    const d = new Date(a, mm - 1, dd);
    if (d <= cap && (!mejor || d > mejor.d)) mejor = { a, d };
  }
  if (!mejor || mejor.a === yyyy) return fechaStr;
  const p2 = (n) => String(n).padStart(2, '0');
  return formato === 'YMD' ? `${mejor.a}-${p2(mm)}-${p2(dd)}` : `${p2(dd)}/${p2(mm)}/${mejor.a}`;
}

// Envuelve un job de setInterval para que NUNCA se solape consigo mismo.
function sinSolape(fn, nombre) {
  let corriendo = false;
  return async function () {
    if (corriendo) {
      console.log(`⏭️ [job:${nombre}] ciclo anterior aún en ejecución — se omite este tick`);
      return;
    }
    corriendo = true;
    try { await fn(); }
    catch (e) { console.error(`❌ [job:${nombre}]`, e?.message || e); }
    finally { corriendo = false; }
  };
}

const ADMIN_EMAIL = "carlosguerra@grupogpn.com";

module.exports = {
  PORTALES_CONOCIDOS, PORTALES_FACTURABLES, esPortalFacturable,
  COMERCIOS_NO_AUTOMATIZABLES, esComercioBloqueado,
  crearNotificacion, registrarIntento, proximaMedianoche,
  extraerUUIDcfdi, renombrarConUUID,
  corregirIdVentaOxxo, corregirFolioOxxo, validarDatosOxxo, corregirAnioReciente,
  sinSolape, ADMIN_EMAIL,
};
