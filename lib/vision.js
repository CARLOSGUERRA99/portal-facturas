// Pipeline de lectura de tickets (Vision) — extraído de server.js en FASE 1.
// Pasada 1: detección de portal (Sonnet). Pasada 2: extracción dirigida (Sonnet).
// Corre en el WORKER (cola vision), ya no dentro del request HTTP de subida.
const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");
const db = require("./db");
const { corregirFolioOxxo, corregirIdVentaOxxo, corregirAnioReciente } = require("./util");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Construye el prompt de detección dinámicamente desde portales.json
function buildPromptDeteccion() {
  let portalesData = { portales: {} };
  try {
    const raw = fs.readFileSync(path.join(__dirname, "../portales/portales.json"), "utf8");
    portalesData = JSON.parse(raw);
  } catch {}

  const portales = portalesData.portales || {};
  const claves = Object.keys(portales);
  const opcionesPortal = [...claves, "desconocido"].join('" | "');

  const lineasDeteccion = claves.map(clave => {
    const p = portales[clave];
    const det = p.deteccion || {};
    const pistas = [
      ...(det.por_texto_ocr || []),
      ...(det.por_comercio || []),
      ...(det.por_url_qr || []),
    ].filter((v, i, a) => a.indexOf(v) === i);
    return `- "${clave}": si ves ${pistas.map(s => `"${s}"`).join(", ")} o el nombre "${p.nombre}"`;
  });

  return `Identifica el tipo de ticket de compra. Responde SOLO este JSON:
{
  "portal": "${opcionesPortal}",
  "confianza": número del 0 al 100,
  "urlQR": "URL completa si hay un QR de facturación, o null",
  "comercio": "nombre del comercio"
}
${lineasDeteccion.join("\n")}
- "desconocido": cualquier otro caso`;
}

const INSTRUCCION_CONFIANZA = `
"confianza": "alta|media|baja",
"campos_dudosos": [],
"ok": true
}
Reglas de confianza:
- alta: todos los campos requeridos están claros y legibles sin ambigüedad.
- media: corregiste caracteres ambiguos (O/0, I/1, S/5) pero estás bastante seguro del resultado.
- baja: algún campo requerido es ilegible, parcialmente visible o muy incierto.
campos_dudosos: lista los nombres exactos de los campos con incertidumbre (array vacío si confianza=alta).`;

const promptsPorPortal = {
  oxxo: `Extrae estos datos del ticket OXXO. Responde SOLO JSON sin texto adicional:
{
  "comercio": "OXXO",
  "fecha": "DD/MM/YYYY",
  "folio": "SOLO dígitos después de Fol_Vta: — corrige O→0 S→5 I→1 T→1",
  "idVenta": "código después de ID= — formato exacto: 2dígitos + 3LETRAS + 2dígitos + 3alfanum + 1dígito (11 chars). En posiciones 1-2 y 6-7 y 11 (dígito): O→0 I→1 S→5. En posiciones 3-5 (SOLO LETRAS): 0→O 1→I 5→S. Ejemplo: '100BR50UZD1' → '10OBR50UZD1' porque pos 3 debe ser letra",
  "total": número sin signos,
  "portal": "oxxo",
${INSTRUCCION_CONFIANZA}`,
  arco: `Extrae estos datos del ticket ARCO/BuzonFacturas. Responde SOLO JSON sin texto adicional:
{
  "comercio": "nombre exacto de la gasolinera ARCO",
  "fecha": "DD/MM/YYYY",
  "codigoTicket": "número de barcode o código grande impreso para facturación (bajo el código de barras o etiquetado como Código/Folio)",
  "total": número sin signos,
  "portal": "arco",
${INSTRUCCION_CONFIANZA}`,
  gasmaz: `Extrae estos datos del ticket GASMAZ/NexusFuel. Responde SOLO JSON sin texto adicional:
{
  "comercio": "nombre de la gasolinera",
  "fecha": "DD/MM/YYYY",
  "referencia": "número de referencia grande (primer número prominente del ticket)",
  "folio": "número de ticket o folio",
  "total": número sin signos,
  "portalUrl": "URL COMPLETA del QR de facturación (debe incluir nexusfuel.mx), o null",
  "portal": "gasmaz",
${INSTRUCCION_CONFIANZA}`,
  farmaciaguadalajara: `Extrae estos datos del ticket de Farmacias Guadalajara. Responde SOLO JSON sin texto adicional:
{
  "comercio": "Farmacias Guadalajara",
  "fecha": "YYYY-MM-DD",
  "folioFactura": "número de folio formato XXXXXX-XXXXXX-X (con guiones)",
  "caja": "número de caja",
  "fechaCompra": "fecha de compra en formato YYYY-MM-DD",
  "noTicket": "número de ticket",
  "total": número sin signos,
  "portal": "farmaciaguadalajara",
${INSTRUCCION_CONFIANZA}`,
  homedepot: `Extrae estos datos del ticket de The Home Depot México. Responde SOLO JSON sin texto adicional:
{
  "comercio": "Home Depot Mexico",
  "fecha": "DD/MM/YYYY",
  "folio": "EL NÚMERO BAJO EL CÓDIGO DE BARRAS — es el código numérico más largo del ticket, entre 18 y 23 dígitos. Lee cada dígito con cuidado: NO omitas ni agregues dígitos. Si hay ambigüedad entre 0 y O, usa 0. Si no puedes leerlo con certeza, devuelve null.",
  "total": número sin signos,
  "portal": "homedepot",
${INSTRUCCION_CONFIANZA}`,
  rendichicas: `Extrae estos datos del ticket de gasolinera con portal Rendichicas/rendilitros. Responde SOLO JSON sin texto adicional:
{
  "comercio": "nombre de la estación (ej. ESTACION PIRU SA DE CV)",
  "fecha": "DD/MM/YYYY",
  "folio": "número de folio o ticket (el número largo impreso)",
  "total": número sin signos,
  "portalUrl": "URL completa del QR de facturación si aparece (debe incluir rendilitros o rendichicas), o null",
  "portal": "rendichicas",
${INSTRUCCION_CONFIANZA}`,
  benavides: `Extrae estos datos del ticket de Farmacias Benavides. Responde SOLO JSON sin texto adicional:
{
  "comercio": "Farmacias Benavides",
  "fecha": "DD/MM/YYYY",
  "folio": "número entre asteriscos *XXXXXXXXXXXXXX* o el número de ticket largo impreso",
  "total": número sin signos,
  "portal": "benavides",
${INSTRUCCION_CONFIANZA}`,
  panama: `Extrae estos datos del ticket de Panamá Restaurante y Pastelería. Responde SOLO JSON sin texto adicional:
{
  "comercio": "nombre exacto del establecimiento (ej. PASTELERIAS PANAMA DE MAZATLAN SA DE CV)",
  "fecha": "DD/MM/YYYY",
  "idFacturacion": "número que aparece después de la leyenda SU ID DE FACTURACION ES (solo dígitos)",
  "total": número sin signos,
  "portal": "panama",
${INSTRUCCION_CONFIANZA}`,
  carljr: `Extrae estos datos del ticket de Carl's Jr (ICR S.A. de C.V.). Responde SOLO JSON sin texto adicional:
{
  "comercio": "ICR S.A. DE C.V.",
  "fecha": "DD/MM/YYYY",
  "referencia": "número que aparece junto a la leyenda REFERENCIA: (es un número largo ~14 dígitos, también puede aparecer como código de comedor al inicio del ticket)",
  "total": número sin signos (campo Total o Totall del ticket),
  "portalUrl": "URL del portal de facturación si aparece (facturacion4.icr.mx o carlsjrclub.com.mx), o null",
  "portal": "carljr",
${INSTRUCCION_CONFIANZA}`,
  "7eleven": `Extrae estos datos del ticket de 7-Eleven México. Responde SOLO JSON sin texto adicional:
{
  "comercio": "7 Eleven Mexico SA de CV",
  "fecha": "DD/MM/YYYY",
  "folio": "el CÓDIGO numérico de EXACTAMENTE 35 DÍGITOS para facturar (suele estar impreso bajo el código de barras, o etiquetado como 'Folio'/'No. Ticket'/'Folio de facturación'). REGLA CRÍTICA: CUÉNTALOS, deben ser EXACTAMENTE 35 dígitos. Léelo dígito por dígito SIN omitir ninguno — el portal RECHAZA el ticket si faltan dígitos. Corrige ambigüedades O→0, I→1, S→5, B→8. Si no logras leer los 35 dígitos con certeza, devuelve null (es mejor null que un folio incompleto).",
  "total": número sin signos,
  "portalUrl": "https://www.e7-eleven.com.mx/facturacion/KPortalExterno/",
  "portal": "7eleven",
${INSTRUCCION_CONFIANZA}`,
  bodegaaurrera: `Extrae estos datos del ticket de Walmart de México (Bodega Aurrera, Mi Bodega Aurrera, Walmart, Sam's Club o Superama). Responde SOLO JSON sin texto adicional:
{
  "comercio": "nombre exacto de la tienda (ej. NUEVA WAL MART DE MEXICO S DE RL DE CV, BODEGA AURRERA, etc.)",
  "fecha": "DD/MM/YYYY",
  "tc": "el NÚMERO DE TICKET (TC#) — código numérico largo de 20-21 dígitos que aparece justo arriba del código de barras, etiquetado 'TC#'. A veces incluye un dígito de sub-formato pegado al inicio (ej. 'TC#3:...') — inclúyelo como parte del número si está pegado sin espacio. CUENTA los dígitos con cuidado, es una tira larga: corrige ambigüedades O→0, I→1, S→5, B→8. Si no puedes leer todos los dígitos con certeza, devuelve null.",
  "tr": "el NÚMERO DE TRANSACCIÓN (TR#) — SOLO 5 dígitos, etiquetado 'TR#' en la misma línea que TDA#/OP#/TE# (ej. 'TR#08384' → '08384'). NO confundir con TDA#(tienda), OP#(operador) o TE#(caja).",
  "total": número sin signos,
  "portal": "bodegaaurrera",
${INSTRUCCION_CONFIANZA}`,
  igasfac: `Extrae estos datos del ticket de gasolinera que factura en www.igasfac.com.mx. Responde SOLO JSON sin texto adicional:
{
  "comercio": "nombre de la gasolinera tal como aparece arriba del ticket",
  "fecha": "DD/MM/YYYY",
  "folio": "⚠️ EL FOLIO WEB, que NO es el 'Folio:' corto de la parte de arriba. Es el número LARGO impreso ABAJO, justo debajo de la línea 'Facturacion en: www.igasfac.com.mx', con formato 4-8-8 separado por guiones (ej. '0310-00823049-00759353'). Devuélvelo CON los guiones. Si solo ves el folio corto de arriba y no encuentras el largo de abajo, devuelve null: el portal rechaza el corto.",
  "folioCorto": "el 'Folio:' de la parte de arriba, solo como referencia",
  "estacion": "número después de 'Estacion de Servicio:' (ej. E04156)",
  "total": número sin signos,
  "portalUrl": "www.igasfac.com.mx",
  "portal": "igasfac",
${INSTRUCCION_CONFIANZA}`,
  caffenio: `Extrae estos datos del ticket de CAFFENIO (café drive). Responde SOLO JSON sin texto adicional:
{
  "comercio": "CAFFENIO",
  "fecha": "DD/MM/YYYY",
  "folio": "el número de FOLIO del ticket — normalmente 6 a 7 dígitos. Corrige ambigüedades O→0, I→1, S→5, B→8, G→6. Si no puedes leer TODOS los dígitos con certeza, devuelve null: el portal valida folio+código+drive en conjunto y un dígito mal hace que no encuentre nada.",
  "codFacturacion": "el CÓDIGO DE FACTURACIÓN (aparece etiquetado 'Cod. Facturacion', 'Código de facturación' o similar) — normalmente 8 dígitos, DISTINTO del folio. Mismas correcciones de ambigüedad. Si no lo ves o no puedes leerlo completo, devuelve null.",
  "drive": "el nombre del DRIVE/sucursal CAFFENIO tal como está impreso (ej. 'Bellavista', 'Alvaro Obregon', 'Nainari'). Sin el prefijo 'Caffenio'. Si no aparece, devuelve null.",
  "total": número sin signos,
  "portal": "caffenio",
${INSTRUCCION_CONFIANZA}`,
  desconocido: `Extrae los datos que puedas de este ticket. Si reconoces el portal, identifícalo.
Portales conocidos: oxxo (tiendas OXXO), arco (gasolineras ARCO, portal buzonfacturas.com), gasmaz (gasolineras Gasmaz/RedMax/NexusFuel), farmaciaguadalajara (Farmacias Guadalajara), benavides (Farmacias Benavides), homedepot (Home Depot México), rendichicas (gasolineras con QR a rendilitros.com o rendichicas.com), panama (Panamá Restaurante y Pastelería, portal grupopanama.mx), carljr (Carl's Jr / ICR S.A. de C.V., portal facturacion4.icr.mx), autozone (AutoZone de México, portal autozone.cdc.origon.cloud), 7eleven (tiendas 7-Eleven, "7 Eleven Mexico SA de CV", portal e7-eleven.com.mx — el folio es un código de 35 dígitos), caffenio (cafeterías CAFFENIO drive, portal facturaciondrive.caffenio.com — requiere folio + código de facturación + nombre del drive).
Responde SOLO JSON sin texto adicional:
{
  "comercio": "nombre del comercio",
  "fecha": "DD/MM/YYYY",
  "folio": "número de folio o ticket, o null. IMPORTANTE: si es AutoZone, aquí va el NÚMERO LARGO DEBAJO DEL CÓDIGO DE BARRAS (la tira de ~20+ dígitos), NO el folio corto. Si es 7-Eleven (e7-eleven.com.mx), el folio es el CÓDIGO DE BARRAS de EXACTAMENTE 35 dígitos — CUÉNTALOS, deben ser 35, NO omitas el último dígito (el portal rechaza si son menos). Léelo dígito por dígito.",
  "referencia": "para portales SoftRestaurant/restaurante (SushiO, Dana Comida Mexicana, El Caporal, Allegro): el CÓDIGO DE FACTURACIÓN o código único (alfanumérico, distinto del folio). Si no aplica, null",
  "origen": "para TUFESA (boletos de autobús): la CIUDAD DE ORIGEN del viaje impresa en el boleto. Si no aplica, null",
  "total": número sin signos,
  "portalUrl": "URL de QR de facturación si aparece, o null",
  "portal": "oxxo|arco|gasmaz|farmaciaguadalajara|benavides|homedepot|rendichicas|panama|carljr|autozone|7eleven|desconocido",
${INSTRUCCION_CONFIANZA}`,
};

const camposPorPortal = {
  oxxo:                ['fecha', 'folio', 'idVenta', 'total'],
  arco:                ['codigoTicket', 'total'],
  gasmaz:              ['portalUrl', 'referencia', 'folio', 'total'],
  farmaciaguadalajara: ['folioFactura', 'caja', 'fechaCompra', 'noTicket'],
  homedepot:           ['folio', 'fecha', 'total'],
  rendichicas:         ['folio', 'fecha', 'total'],
  benavides:           ['folio', 'fecha', 'total'],
  carljr:              ['referencia', 'total'],
  bodegaaurrera:       ['tc', 'tr', 'fecha', 'total'],
  panama:              ['idFacturacion', 'total', 'comercio'],
  sushito:             ['referencia', 'folio', 'total'],
  sushio:              ['referencia', 'folio', 'total'],
  "7eleven":           ['folio', 'fecha', 'total'],
  // El portal de CAFFENIO valida los tres juntos: si falta uno no encuentra la
  // orden, así que los tres son requeridos para que la cola siquiera lo intente.
  caffenio:            ['folio', 'codFacturacion', 'drive', 'total'],
  // El folio de IGasFac es el WEB (formato 4-8-8), no el corto de arriba.
  igasfac:             ['folio', 'total'],
  desconocido:         ['fecha', 'total'],
};

// Procesa la imagen de un ticket: 2 pasadas Sonnet + heurísticas de reclasificación.
// Devuelve { datosOCR, textoOCR, portalDetectado, confianza, camposDudosos,
//            requiereConfirmacion, campos, portalUrl }.
async function procesarImagenTicket(imageBuffer, mimeType) {
  const base64Image = imageBuffer.toString("base64");
  let datosOCR = {};
  let textoOCR = "";
  let portalDetectado = "desconocido";

  // ── PASADA 1: Detección de portal (Sonnet) ──
  console.log("🔍 Pasada 1: detección con Sonnet...");
  const t1start = Date.now();
  try {
    const resp1 = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 200,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mimeType, data: base64Image } },
          { type: "text", text: buildPromptDeteccion() }
        ],
      }],
    });
    const t1ms = Date.now() - t1start;
    const det = JSON.parse(resp1.content[0].text.replace(/```json|```/g, "").trim());
    portalDetectado = det.portal || "desconocido";
    const urlQR = det.urlQR || null;
    if (det.comercio) datosOCR.comercio = det.comercio;
    console.log(`⏱️ Sonnet detección: ${t1ms}ms | Portal: ${portalDetectado} (${det.confianza || 0}pts)`);

    if (portalDetectado === "desconocido" && urlQR) {
      const urlLow = urlQR.toLowerCase();
      if (urlLow.includes("nexusfuel") || urlLow.includes("gasmaz")) portalDetectado = "gasmaz";
      else if (urlLow.includes("buzonfacturas") || urlLow.includes("arco")) portalDetectado = "arco";
      else if (urlLow.includes("oxxo")) portalDetectado = "oxxo";
      else if (urlLow.includes("farmaciasguadalajara")) portalDetectado = "farmaciaguadalajara";
      else if (urlLow.includes("rendilitros") || urlLow.includes("rendichicas")) portalDetectado = "rendichicas";
      else if (urlLow.includes("homedepot.com.mx")) portalDetectado = "homedepot";
      else if (urlLow.includes("e-facturate.com/benavides")) portalDetectado = "benavides";
      else if (urlLow.includes("facturacion4.icr.mx") || urlLow.includes("icr.mx")) portalDetectado = "carljr";
      else if (urlLow.includes("grupopanama.mx")) portalDetectado = "panama";
      else if (urlLow.includes("e7-eleven") || urlLow.includes("7-eleven")) portalDetectado = "7eleven";
      // Bots de gasolineras/casetas dados de alta en jul-2026. Sin estas reglas
      // el portal queda "desconocido" y el agente genera bots DUPLICADOS de
      // portales que ya tienen bot escrito y verificado.
      else if (urlLow.includes("sinaloa.gob.mx")) portalDetectado = "orler";
      else if (urlLow.includes("petrofigues")) portalDetectado = "petrofigues";
      else if (urlLow.includes("valerogdl")) portalDetectado = "gashr";
      else if (urlLow.includes("facturagas.net") || urlLow.includes("controlgasfe")) portalDetectado = "facturagas";
      else if (urlLow.includes("erfc.com.mx")) portalDetectado = "erfc";
      else if (urlLow.includes("enerfueltech.com")) portalDetectado = "enerfueltech";
      else if (urlLow.includes("corporativoramcal") || urlLow.includes("ramcal.no-ip")) portalDetectado = "ramcal";
      else if (urlLow.includes("oxxogas.com")) portalDetectado = "oxxogas";
      else if (urlLow.includes("facturaciondrive.caffenio")) portalDetectado = "caffenio";
      // facturacionestacion.com reparte un subdominio por estación
      // (valerogdl., lasconchas., …): se reconoce el dominio completo.
      else if (urlLow.includes("facturacionestacion.com")) portalDetectado = "gashr";
      // El OCR confunde el "1" inicial con una "l" minúscula en 1gasfac.com.mx
      // (leyó "lgasfac.com.mx" en el ticket #197). Se aceptan las dos grafías.
      else if (urlLow.includes("1gasfac") || urlLow.includes("lgasfac") || urlLow.includes("igasfac")) portalDetectado = "igasfac";
      else if (urlLow.includes("facturacioncapufe") || urlLow.includes("capufe.gob.mx")) portalDetectado = "capufe";
      if (portalDetectado !== "desconocido")
        console.log(`🔗 Portal resuelto por URL del QR: ${portalDetectado}`);
      datosOCR.portalUrl = urlQR;
    }

    if (portalDetectado === "desconocido" && det.comercio && det.comercio.toLowerCase().includes("oxxo")) {
      portalDetectado = "oxxo";
      console.log(`🏪 Portal resuelto por nombre OXXO: ${det.comercio}`);
    }

    if (portalDetectado === "desconocido" && det.comercio && /eleven/i.test(det.comercio)) {
      portalDetectado = "7eleven";
      console.log(`🏪 Portal resuelto por nombre 7-Eleven: ${det.comercio}`);
    }

    if (portalDetectado === "desconocido" && det.comercio && /caffenio/i.test(det.comercio)) {
      portalDetectado = "caffenio";
      console.log(`🏪 Portal resuelto por nombre CAFFENIO: ${det.comercio}`);
    }

    if (portalDetectado === "desconocido" && det.comercio && /capufe|plaza de cobro|caminos y puentes/i.test(det.comercio)) {
      portalDetectado = "capufe";
      console.log(`🛣️ Portal resuelto por nombre CAPUFE: ${det.comercio}`);
    }
  } catch (e) {
    console.log("⚠️ Sonnet detección falló:", e.message);
  }

  // Normalizar cualquier variante de 7-Eleven a la clave única "7eleven"
  if (/eleven/i.test(portalDetectado)) portalDetectado = "7eleven";

  // ── PASADA 2: Extracción dirigida (Sonnet) ──
  console.log(`🔍 Pasada 2: extracción Sonnet para portal '${portalDetectado}'...`);
  const t2start = Date.now();
  try {
    const resp2 = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 600,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mimeType, data: base64Image } },
          { type: "text", text: promptsPorPortal[portalDetectado] || promptsPorPortal.desconocido }
        ],
      }],
    });
    const t2ms = Date.now() - t2start;
    textoOCR = resp2.content[0].text;
    const extraido = JSON.parse(textoOCR.replace(/```json|```/g, "").trim());
    datosOCR = { ...datosOCR, ...extraido };
    for (const campo of ['fecha', 'fechaCompra']) {
      if (datosOCR[campo]) {
        const corr = corregirAnioReciente(datosOCR[campo]);
        if (corr !== datosOCR[campo]) {
          console.log(`📅 Año corregido en '${campo}': ${datosOCR[campo]} → ${corr}`);
          datosOCR[campo] = corr;
        }
      }
    }
    const nCampos = Object.values(datosOCR).filter(v => v !== null && v !== undefined).length;
    console.log(`⏱️ Sonnet extracción: ${t2ms}ms | Campos: ${nCampos}`);
    console.log("✅ Datos extraídos:", datosOCR);
  } catch (e) {
    console.log("⚠️ Sonnet extracción falló:", e.message);
    if (!datosOCR.comercio) {
      const err = new Error("No se pudo identificar el portal");
      err.sinComercio = true;
      throw err;
    }
  }

  // Reclasificaciones post-Pasada 2 (mismo comportamiento que server.js original)
  if (portalDetectado === "desconocido" && (datosOCR.comercio || "").toLowerCase().includes("oxxo")) {
    portalDetectado = "oxxo";
    datosOCR.portal = "oxxo";
    console.log(`🏪 Portal reclasificado como OXXO por comercio Sonnet: ${datosOCR.comercio}`);
  }

  if (portalDetectado === "desconocido" && datosOCR.portal && datosOCR.portal !== "desconocido") {
    portalDetectado = datosOCR.portal;
    console.log(`🔄 Portal reclasificado por Pasada 2: ${portalDetectado}`);
  }

  if (portalDetectado === "desconocido" && (datosOCR.comercio || "").toLowerCase().includes("eleven")) {
    portalDetectado = "7eleven";
    datosOCR.portal = "7eleven";
    console.log(`🏪 Portal reclasificado como 7-Eleven por comercio: ${datosOCR.comercio}`);
  }
  if (portalDetectado === "7eleven" && !datosOCR.portalUrl) {
    datosOCR.portalUrl = "https://www.e7-eleven.com.mx/facturacion/KPortalExterno/";
  }

  if (portalDetectado === "oxxo" || datosOCR.portal === "oxxo") {
    datosOCR.folio = corregirFolioOxxo(datosOCR.folio);
    datosOCR.idVenta = corregirIdVentaOxxo(datosOCR.idVenta);
  }

  const portalUrl = datosOCR.portalUrl || (portalDetectado === "arco" ? "buzonfacturas" : null) || null;
  const campos = camposPorPortal[portalDetectado] || camposPorPortal.desconocido;
  const confianza = datosOCR.confianza || 'media';
  const camposDudosos = Array.isArray(datosOCR.campos_dudosos) ? datosOCR.campos_dudosos : [];
  const requiereConfirmacion = (portalDetectado !== 'desconocido') && (confianza !== 'alta' || camposDudosos.length > 0) ? 1 : 0;

  return { datosOCR, textoOCR, portalDetectado, confianza, camposDudosos, requiereConfirmacion, campos, portalUrl };
}

// Busca un ticket duplicado del mismo usuario. Devuelve el existente o null.
//
// ⚠️ DOS CAMBIOS QUE IMPORTAN, ambos por duplicados que se colaron de verdad:
//
// 1. YA NO se excluyen los tickets en 'error'. Antes había un
//    `AND status NOT IN ('error')`, y como un ticket que falla queda
//    justamente en 'error', volver a subir la misma foto pasaba el filtro.
//    Ese era el origen de casi todos los duplicados.
//
// 2. YA NO se compara el nombre del comercio, solo FOLIO + TOTAL. El OCR lee
//    el comercio distinto en cada subida de la misma foto ("Caseta El Pisal
//    (Orler" vs "Caseta El Pisal (Sinaloa)"), así que exigir que coincidiera
//    dejaba escapar duplicados evidentes. Que dos comercios emitan el mismo
//    folio por el mismo importe al mismo cliente es prácticamente imposible.
//
// Esto es el chequeo "amable", el que da un mensaje bonito. El candado de
// verdad es el índice UNIQUE `uq_ticket_dedupe` de la BD (ver
// scripts/candado-duplicados.js), que no se puede saltar por ningún camino.
async function buscarDuplicado(userId, datosOCR, excludeTicketId = null) {
  const folioUnico = datosOCR.folio || datosOCR.codigoTicket || datosOCR.referencia
    || datosOCR.idFacturacion || datosOCR.folioFactura || datosOCR.idVenta || datosOCR.tc || null;
  if (!folioUnico || datosOCR.total == null) return null;
  try {
    const [dups] = await db.query(
      `SELECT id, status, creado, comercio FROM tickets
       WHERE user_id = ?
         AND id != ?
         AND CAST(JSON_UNQUOTE(JSON_EXTRACT(ocr_json,'$.total')) AS DECIMAL(12,2)) = ?
         AND COALESCE(
           JSON_UNQUOTE(JSON_EXTRACT(ocr_json,'$.folio')),
           JSON_UNQUOTE(JSON_EXTRACT(ocr_json,'$.codigoTicket')),
           JSON_UNQUOTE(JSON_EXTRACT(ocr_json,'$.referencia')),
           JSON_UNQUOTE(JSON_EXTRACT(ocr_json,'$.idFacturacion')),
           JSON_UNQUOTE(JSON_EXTRACT(ocr_json,'$.folioFactura')),
           JSON_UNQUOTE(JSON_EXTRACT(ocr_json,'$.idVenta')),
           JSON_UNQUOTE(JSON_EXTRACT(ocr_json,'$.tc'))
         ) = ?
       ORDER BY creado ASC LIMIT 1`,
      [userId, excludeTicketId || 0, parseFloat(datosOCR.total).toFixed(2), String(folioUnico)]
    );
    return dups.length ? { ...dups[0], folio: folioUnico } : null;
  } catch (e) {
    console.log("⚠️ Chequeo anti-duplicados falló (continúa):", e.message);
    return null;
  }
}

module.exports = { procesarImagenTicket, buscarDuplicado, camposPorPortal, buildPromptDeteccion };
