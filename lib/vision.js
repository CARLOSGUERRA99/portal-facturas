// Pipeline de lectura de tickets (Vision) — extraído de server.js en FASE 1.
// Pasada 1: detección de portal (Sonnet; escala solo si se baja de modelo).
// Pasada 2: extracción dirigida (Sonnet). Pasada 3: relectura de campos dudosos.
// Corre en el WORKER (cola vision), ya no dentro del request HTTP de subida.
const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");
const db = require("./db");
const { corregirFolioOxxo, corregirIdVentaOxxo, corregirAnioReciente } = require("./util");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ⚠️ AMBAS PASADAS EN SONNET. SE PROBÓ HAIKU Y SE DESCARTÓ CON DATOS.
//
// La idea era barata y sonaba razonable: la Pasada 1 solo clasifica el ticket
// entre portales conocidos y devuelve 200 tokens, así que parecía trabajo de
// modelo pequeño. Medido con scripts/evaluar-ocr.js sobre las 24 fotos reales:
//
//     Sonnet  98.5% de campos · 23/24 tickets perfectos
//     Haiku   92.6% de campos · 20/24            ← peor
//
// Y el fallo importante no es el porcentaje: Haiku detectó el ticket de
// Petrolíferos La Territorial como "petrofigues" en vez de "enerser". Dos
// gasolineras, dos portales distintos. Eso NO es un OCR un poco peor: es
// enrutar al bot equivocado, o sea una factura que no sale. El ahorro por
// ticket era de céntimos; la factura perdida vale cientos de pesos.
//
// Regla del proyecto, decidida por Carlos el 02/08/2026: NO se sacrifica
// calidad por coste. Las constantes se quedan para poder SUBIR de modelo sin
// tocar código — el agente es el siguiente candidato a Opus, porque un bot mal
// generado cuesta muchísimo más que la diferencia de tokens.
const MODELO_DETECCION  = process.env.MODELO_DETECCION  || "claude-sonnet-4-6";
const MODELO_EXTRACCION = process.env.MODELO_EXTRACCION || "claude-sonnet-4-6";

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
    // `nota_deteccion` sirve para desambiguar portales cuyas pistas se solapan.
    // Caso real: "OXXO GAS" contiene "oxxo", así que la gasolinera se detectaba
    // como la tienda de conveniencia y corría su prompt — leyendo mal el folio.
    // Las pistas positivas no bastan cuando una es subcadena de la otra: hace
    // falta poder decir explícitamente "esto NO es aquello".
    const nota = det.nota_deteccion ? ` ⚠️ ${det.nota_deteccion}` : "";
    return `- "${clave}": si ves ${pistas.map(s => `"${s}"`).join(", ")} o el nombre "${p.nombre}"${nota}`;
  });

  return `Identifica el tipo de ticket de compra. Responde SOLO este JSON:
{
  "portal": "${opcionesPortal}",
  "confianza": número del 0 al 100,
  "urlQR": "URL completa si hay un QR de facturación, o null",
  "comercio": "nombre del comercio",
  "ticketsEnFoto": cuántas COMPRAS DISTINTAS Y FACTURABLES hay en la foto (casi siempre 1)
}
Cómo contar "ticketsEnFoto": cuenta 1 por cada compra distinta, es decir, con
otro importe u otro folio. NO cuentan como ticket aparte, aunque sean papeles
separados: el voucher del banco (Banorte, BBVA, NetPay…), la "COPIA CLIENTE",
el comprobante de pago con tarjeta, ni el reverso del mismo ticket. Todos esos
pertenecen a la MISMA compra y suman 1, no 2.
Si de verdad hay más de una compra, responde por la PRIMERA (la de más arriba, y
si están lado a lado, la de la IZQUIERDA) y aun así reporta el total en
"ticketsEnFoto". No dejes campos en null por el hecho de que haya varias.
${lineasDeteccion.join("\n")}
- "desconocido": cualquier otro caso`;
}

// Saca el objeto JSON de la respuesta del modelo aunque venga acompañado.
//
// ⚠️ Por qué hace falta: `JSON.parse()` sobre la respuesta cruda revienta en
// cuanto el modelo escribe una sola palabra antes o después del JSON, y la
// excepción tiraba TODOS los datos del ticket — aunque los hubiera leído bien.
// Ese era el verdadero motivo de los tickets que "no extraían nada": no era la
// foto, era el parser. Los casos reales que lo provocaban:
//   · "I see two tickets in this image..."  (dos tickets en la misma foto)
//   · "Hay DOS tickets en la imagen..."
//   · JSON válido seguido de una nota explicativa
//
// Estrategia, de menos a más tolerante: quitar las vallas markdown, y si aún
// falla, recortar desde la primera llave hasta la última y parsear eso.
function extraerJson(texto) {
  const limpio = String(texto || "").replace(/```json|```/g, "").trim();
  try { return JSON.parse(limpio); } catch {}

  const ini = limpio.indexOf("{");
  const fin = limpio.lastIndexOf("}");
  if (ini !== -1 && fin > ini) {
    const recorte = limpio.slice(ini, fin + 1);
    try { return JSON.parse(recorte); } catch {}
    // Último recurso: el modelo escribió dos objetos seguidos (una foto con dos
    // tickets). Se toma el primero completo, contando llaves.
    let nivel = 0;
    for (let i = ini; i <= fin; i++) {
      if (limpio[i] === "{") nivel++;
      else if (limpio[i] === "}" && --nivel === 0) {
        try { return JSON.parse(limpio.slice(ini, i + 1)); } catch {}
        break;
      }
    }
  }
  throw new Error(`no se pudo extraer JSON de la respuesta: ${limpio.slice(0, 90)}`);
}

const INSTRUCCION_CONFIANZA = `
"confianza": "alta|media|baja",
"campos_dudosos": [],
"ticketsEnFoto": 1,
"ok": true
}
Reglas de confianza:
- alta: todos los campos requeridos están claros y legibles sin ambigüedad.
- media: corregiste caracteres ambiguos (O/0, I/1, S/5) pero estás bastante seguro del resultado.
- baja: algún campo requerido es ilegible, parcialmente visible o muy incierto.
campos_dudosos: lista los nombres exactos de los campos con incertidumbre (array vacío si confianza=alta).

⚠️ SI LA FOTO TIENE VARIAS COMPRAS: extrae SOLO la PRIMERA (la de más arriba; si
están lado a lado, la de la IZQUIERDA) y pon cuántas hay en "ticketsEnFoto". No
mezcles datos de un ticket con los de otro y no describas la situación en prosa:
responde el JSON del primero y nada más.
En "ticketsEnFoto" cuenta solo COMPRAS DISTINTAS (otro importe u otro folio). El
voucher del banco, la "COPIA CLIENTE" o el comprobante de tarjeta de esa misma
compra NO cuentan como ticket aparte: son papeles de la misma venta → 1.

⚠️ NUNCA devuelvas todos los campos en null. Si algo no se lee, pon ESE campo en
null, deja los demás con lo que sí leíste y ponlos en campos_dudosos. Un ticket
con el comercio y el total ya sirve para revisarlo a mano; uno vacío se pierde.`;

// Familia de tickets impresos por la misma terminal NetPay: Enerfuel Tech,
// Enerser y las gasolineras que usan su plataforma. Todos traen DOS números que
// parecen "el folio", y el que sirve es el de abajo:
//
//   Folio: 06922-25102-071-260729135651   ← de la terminal bancaria. INÚTIL.
//   ...
//   PAGINA(S) PARA FACTURAR
//   http://facturacion.enerser.com.mx/
//   Referencia: 06922132266334FC          ← ESTE es el que pide el portal.
//
// La estructura de la Referencia lo confirma: estación (06922) + número de
// ticket (1322663) + 4 caracteres de verificación (34FC). El bot de
// enerfueltech.js pide exactamente un campo "Referencia" y nada más.
//
// Este era el motivo real de que estos tickets no facturaran: el OCR entregaba
// el folio de la terminal, el portal contestaba "No se encontró el consumo" y
// parecía un ticket vencido cuando en realidad era el dato equivocado.
const PROMPT_NETPAY_REFERENCIA = `Extrae estos datos de un ticket de gasolinera con terminal NetPay (Enerfuel Tech / Enerser y marcas que usan su plataforma). Responde SOLO JSON sin texto adicional:
{
  "comercio": "razón social de la gasolinera, la línea de arriba del ticket",
  "fecha": "DD/MM/YYYY",
  "referencia": "⚠️ EL DATO CLAVE. Es el código alfanumérico que sigue a la palabra 'Referencia:' al FINAL del ticket, justo debajo de 'PAGINA(S) PARA FACTURAR' y de la URL. Son 15 o 16 caracteres SIN guiones (ej. '06922132266334FC', '049847152458CE1'). NO confundir con el 'Folio:' de la parte de arriba, que lleva guiones y pertenece a la terminal bancaria: ese NO sirve para facturar.",
  "folioTerminal": "el 'Folio:' con guiones de la parte de arriba, solo como referencia. Puede ser null.",
  "noTicket": "el número que sigue a 'Ticket:' (debe aparecer también dentro de la referencia)",
  "total": número sin signos (el TOTAL, no el SUB TOTAL),
  "portalUrl": "la URL completa impresa bajo 'PAGINA(S) PARA FACTURAR'",
  "portal": "enerfueltech si la URL dice enerfueltech.com, enerser si dice enerser.com.mx",
${INSTRUCCION_CONFIANZA}`;

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
  // OXXO GAS es una gasolinera, NO la tienda: otro portal, otro ticket, otros
  // campos. Antes caía en el prompt de arriba, que busca "Fol_Vta:" e "ID=" —
  // etiquetas que este ticket no tiene — y el folio salía con dígitos de más
  // (75400070 en vez de 7540670).
  oxxogas: `Extrae estos datos del ticket de OXXO GAS (gasolinera, NO la tienda de conveniencia). Responde SOLO JSON sin texto adicional:
{
  "comercio": "nombre completo de la estación tal como aparece (ej. 'OXXO GAS Estacion Galerias BJX')",
  "fecha": "DD/MM/YYYY",
  "folio": "el número junto a 'Folio:' — son 7 dígitos, ni uno más. Corrige O→0, I→1, S→5. ⚠️ NO repitas dígitos: si dudas entre '7540670' y '75400070', el correcto es el de 7 dígitos.",
  "bomba": "número junto a 'Bomba:' o 'Posición', o null",
  "litros": "cantidad de litros cargados, número decimal, o null",
  "precioLitro": "precio por litro, número decimal, o null",
  "total": "número sin signos. ⚠️ VERIFÍCALO: total ≈ litros × precioLitro. Si no cuadra, vuelve a leer los tres y devuelve el juego que sea consistente.",
  "portal": "oxxogas",
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
  "referencia": "el número que sigue a la palabra 'REFERENCIA' cerca del final del ticket (ej. 'REFERENCIA 20386409' → 20386409)",
  "folio": "⚠️ el número que sigue a 'Ticket:' (ej. 'Ticket 7634595 Bomba 6' → 7634595). NO devuelvas la línea 'FOLIO:' de la terminal bancaria, que lleva guiones y es más larga (ej. '6409-6-7634595-4697'): esa NO sirve, aunque contenga el número correcto en medio. Si solo encuentras la versión con guiones, extrae de ella el tramo que coincide con 'Ticket:'.",
  "total": número sin signos,
  "portalUrl": "URL COMPLETA del QR de facturación (debe incluir nexusfuel.mx), o null. ⚠️ Suele venir PARTIDA EN DOS LÍNEAS a mitad de palabra: júntala sin espacios ni guiones antes de responder.",
  "portal": "gasmaz",
${INSTRUCCION_CONFIANZA}`,
  // facturacionestacion.com es NexusFuel multi-tenant: un subdominio por
  // estación (valerogdl., lasconchas., …). El bot pide referencia + folio, y el
  // ticket los imprime con nombres que invitan a confundirlos: la "Referencia
  // para facturar" es el número de ESTACIÓN, y el folio es el "Ticket:".
  gashr: `Extrae estos datos del ticket de gasolinera que factura en un subdominio de facturacionestacion.com. Responde SOLO JSON sin texto adicional:
{
  "comercio": "razón social de la estación, las primeras líneas del ticket",
  "fecha": "DD/MM/YYYY",
  "folio": "el número que sigue a 'Ticket:' (ej. 'Ticket:72272' → 72272)",
  "referencia": "el número que sigue a 'Referencia para facturar:' al final del ticket. Coincide con el de 'Estación:' de arriba — si ves los dos y no coinciden, vuelve a leerlos.",
  "total": "el 'Total General' (o 'Total' si no hay general), número sin signos",
  "portalUrl": "la URL completa impresa bajo 'Facturación en línea' (incluye facturacionestacion.com)",
  "portal": "gashr",
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
  // CAPUFE pide UN dato y no es el folio: el código "FACTURACION" de 18
  // caracteres, impreso en bloques de 4 separados por espacios. Sin este prompt
  // se usaba el genérico, que lo devolvía como "referencia" y encima ponía
  // portal:"desconocido" — con eso los tickets de casetas se quedaban parados.
  //
  // ⚠️ Cuidado especial con la lectura: consultar el código en el portal LO
  // RESERVA. Si se manda mal, ese código queda quemado y la caseta ya no se
  // puede facturar. Por eso aquí se prefiere devolver null antes que adivinar.
  capufe: `Extrae estos datos del ticket de caseta de CAPUFE (Caminos y Puentes Federales). Responde SOLO JSON sin texto adicional:
{
  "comercio": "CAPUFE y el nombre de la plaza de cobro si aparece",
  "fecha": "DD/MM/YYYY",
  "codigo": "⚠️ EL DATO QUE PIDE EL PORTAL: el código de FACTURACION de EXACTAMENTE 18 caracteres alfanuméricos, impreso en bloques separados por espacios (ej. 'K8KP KTZB HKSF 7WMV HQ'). Devuélvelo TAL CUAL lo ves, con los espacios. NO es el folio numérico. Cuenta los caracteres sin espacios: si no son 18, vuelve a leerlo. Si no puedes leer TODOS con certeza, devuelve null: el portal reserva el código al consultarlo y un carácter mal lo inutiliza para siempre.",
  "folio": "el folio numérico de la parte de arriba, solo como referencia",
  "plaza": "número y nombre de la plaza de cobro, o null",
  "total": número sin signos,
  "portal": "capufe",
${INSTRUCCION_CONFIANZA}`,
  enerfueltech: PROMPT_NETPAY_REFERENCIA,
  enerser: PROMPT_NETPAY_REFERENCIA,
  // El portal pide TRES datos y el genérico solo sacaba uno. Tenía bot desde
  // julio pero nunca prompt: los tickets llegaban sin estación ni WebID.
  facturagas: `Extrae estos datos del ticket de gasolinera que factura en app.facturagas.net / ControlGAS (MIGASOLINA y similares). Responde SOLO JSON sin texto adicional:
{
  "comercio": "razón social de la estación, con su clave si aparece",
  "estacionNombre": "⚠️ OBLIGATORIO: la clave y el nombre de la estación tal cual salen en la línea destacada de arriba, justo bajo el logo (ej. 'E12430 - FRESNO'). El portal la busca por autocompletado, así que se devuelve COMPLETA, con la clave, el guion y el nombre.",
  "fecha": "la de 'FECHA:' en DD/MM/YYYY",
  "folio": "⚠️ OBLIGATORIO: el número de la línea 'FOLIO :' (ej. '2431019'). NO el 'NOTA #' de arriba ni el número entre paréntesis que sigue a la hora.",
  "webId": "⚠️ OBLIGATORIO: el número de la línea 'WEB ID :' (ej. '85006100'). Es un campo aparte del portal; sin él no busca.",
  "total": número de 'TOTAL:', sin signos,
  "portalUrl": "app.facturagas.net",
  "portal": "facturagas",
${INSTRUCCION_CONFIANZA}`,
  // El portal pide TIENDA + ORDEN. Sin la tienda no se puede facturar: tiene 86
  // y elegir mal timbraría a nombre de otra sucursal.
  littlecaesars: `Extrae estos datos del ticket de Little Caesars. Responde SOLO JSON sin texto adicional:
{
  "comercio": "Little Caesars y la ciudad si aparece",
  "tienda": "⚠️ OBLIGATORIO: la clave de tienda de arriba, justo debajo de 'Little Caesars'. Formato 04123-000NN (ej. '04123-00053'). A veces lleva la etiqueta 'Tienda:' delante y a veces va suelta, sin etiqueta. Devuélvela COMPLETA, con el guion y los ceros.",
  "ticketNumero": "⚠️ OBLIGATORIO: el número que sigue a la palabra 'Orden' (ej. 'Orden 1099876' → '1099876'). Suelen ser 7 dígitos. Cuéntalos: si la sombra o un doblez tapan alguno, NO lo acortes ni lo inventes — devuelve null y ponlo en campos_dudosos. Un número corto de más hace que el portal no encuentre la venta.",
  "folio": "el mismo valor que ticketNumero",
  "fecha": "la del ticket (ej. 'Aug 4, 2026') en DD/MM/YYYY",
  "total": número de la línea 'Total' (el final con impuestos, NO el Subtotal),
  "portalUrl": "https://cfdi.analytix360.cloud/cafrema/lc/",
  "portal": "littlecaesars",
${INSTRUCCION_CONFIANZA}`,
  // Casetas de concesionaria (Santa Ana-Altar y demás de PINFRA). NO son
  // CAPUFE: no traen código de 18 caracteres, y el portal pide la HORA.
  pinfra: `Extrae estos datos del ticket de caseta de peaje. Responde SOLO JSON sin texto adicional:
{
  "comercio": "la razón social de arriba y la plaza, ej. 'Concesionaria Santa Ana-Altar, S.A. de C.V. — Plaza de Cobro Santa Ana'",
  "autopista": "el nombre de la autopista o de la concesionaria, sin 'S.A. de C.V.' (ej. 'Santa Ana-Altar')",
  "fecha": "DD/MM/YYYY",
  "hora": "⚠️ OBLIGATORIA, el portal no busca sin ella: la hora impresa junto a la fecha, en formato 24h HH:MM:SS (ej. '18:40:08')",
  "folio": "el valor completo de la línea 'FOLIO =', CON su guion y sus ceros (ej. '2-0000983716'). No lo partas ni le quites ceros.",
  "carril": "⚠️ OBLIGATORIO: el valor de 'CARRIL:' (ej. '2B'). Solo el carril, sin la palabra.",
  "total": número de TOTAL (el mayor, no el IMPORTE sin IVA),
  "portalUrl": "www.pinfrafacturacion.com.mx",
  "portal": "pinfra",
${INSTRUCCION_CONFIANZA}`,
  // El boleto imprime DOS códigos y el portal solo acepta uno.
  albatros: `Extrae estos datos del boleto de autobús de Albatros Autobuses. Responde SOLO JSON sin texto adicional:
{
  "comercio": "Albatros Autobuses",
  "fecha": "la de 'Fecha de Viaje' en DD/MM/YYYY",
  "boleto": "⚠️ EL DATO QUE PIDE EL PORTAL: el código corto de ARRIBA DEL TODO, en la misma línea que 'Albatros Autobuses' y justo encima de la palabra BOLETO (ej. 'I7UB8C'). NO es el 'Turno # S-XXXXXX' que aparece abajo en la línea 'Vendido en:' — ese es el turno de la taquilla y el portal lo rechaza.",
  "folio": "el mismo valor que boleto",
  "referencia": "el 'Turno # S-XXXXXX' de la línea 'Vendido en:', solo como referencia. Si no aparece, null",
  "origen": "la ciudad de 'Desde:'",
  "destino": "la ciudad de 'Hacia:'",
  "total": número de 'Total:', sin signos ni 'MXN',
  "portalUrl": "www.albatrosautobuses.com",
  "portal": "albatros",
${INSTRUCCION_CONFIANZA}`,
  // ⚠️ Orler tenía bot desde julio pero NUNCA prompt propio: caía en el
  // genérico, que no pide el CARRIL. Y el portal lo exige — sin él, el
  // formulario queda incompleto, BUSCAR no llega a ejecutarse y sale
  // "Debes ingresar los campos solicitados". Los tickets #207/#229/#230
  // murieron así, y el bot lo reportó como "folio reconocido pero no se
  // encontró el botón Facturar", que era falso. La prueba E2E de julio pasó
  // porque el carril iba a mano en el script, no por el pipeline.
  orler: `Extrae estos datos del ticket de caseta de peaje de Sinaloa (Orler). Responde SOLO JSON sin texto adicional:
{
  "comercio": "nombre de la autopista y de la caseta, ej. 'Autopista de Cuota Culiacán - Caseta 59 Las Brisas'",
  "fecha": "la de FECHA:, en DD/MM/YYYY",
  "folio": "⚠️ el de la línea FOL:, con sus ceros a la izquierda (ej. '0281752'). NO el de SEC:, que es otro número parecido justo encima.",
  "carril": "⚠️ OBLIGATORIO, el portal no busca sin él: el número de la línea CARRIL: (ej. '5908'). Va antes de la palabra SENTIDO. Solo los dígitos, sin el sentido.",
  "caseta": "el número de la línea CASETA: (ej. '59'), o null",
  "total": número de IMPORTE, sin signos,
  "portalUrl": "//facturacion.sinaloa.gob.mx",
  "portal": "orler",
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
  "portal": "oxxo|oxxogas|arco|gasmaz|farmaciaguadalajara|benavides|homedepot|rendichicas|panama|carljr|autozone|7eleven|igasfac|caffenio|sushito|desconocido",
${INSTRUCCION_CONFIANZA}`,
};

// Petrofigues es otro tenant de la misma plataforma NexusFuel: el ticket sale
// idéntico, así que comparte prompt en vez de duplicarlo. Va fuera del literal
// porque un objeto no puede referirse a sus propias claves mientras se define.
promptsPorPortal.petrofigues = promptsPorPortal.gashr;

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
  // El portal busca la estación por autocompletado y exige el WebID aparte.
  facturagas:          ['estacionNombre', 'folio', 'webId', 'total'],
  gashr:               ['folio', 'referencia', 'total'],
  // El portal solo pide el código de 18 caracteres.
  capufe:              ['codigo', 'total'],
  petrofigues:         ['folio', 'referencia', 'total'],
  // El portal pide el boleto (el de arriba), no el turno.
  albatros:            ['boleto', 'total'],
  // Sin tienda el portal no sabe dónde buscar; sin orden, qué buscar.
  littlecaesars:       ['tienda', 'ticketNumero', 'fecha', 'total'],
  // El portal exige la hora y el carril además del folio.
  pinfra:              ['folio', 'carril', 'fecha', 'hora', 'total'],
  // Sin carril el portal ni siquiera busca: es tan obligatorio como el folio.
  orler:               ['folio', 'carril', 'fecha', 'total'],
  oxxogas:             ['folio', 'fecha', 'total'],
  // El portal pide UN solo campo: la Referencia del pie del ticket.
  enerfueltech:        ['referencia', 'total'],
  enerser:             ['referencia', 'total'],
  desconocido:         ['fecha', 'total'],
};

// Saca de un prompt de portal la descripción de un campo, para poder reusarla
// como pista en la relectura sin duplicar el texto en dos sitios.
function pistaDeCampo(portal, campo) {
  const prompt = promptsPorPortal[portal] || promptsPorPortal.desconocido;
  const m = new RegExp(`"${campo}":\\s*"([^"]*)"`).exec(prompt);
  return m ? m[1] : null;
}

// ── PASADA 3: relectura dirigida de los campos que el portal necesita ──
//
// La Pasada 2 lee 8-10 campos de golpe y el folio compite por atención con todo
// lo demás. Cuando el folio sale mal por UN carácter, el portal no factura y el
// ticket se pierde entero — un dígito equivale a perder la factura completa.
// Caso medido: OXXO GAS, folio real 7540670, leído 7540070.
//
// Aquí se vuelve a mirar la MISMA foto pero preguntando solo por los campos
// obligatorios que quedaron nulos o dudosos, y obligando a deletrearlos. Es una
// pregunta corta sobre una imagen, no una segunda extracción: cuesta poco y solo
// se dispara cuando la Pasada 2 admitió duda, así que la mayoría de tickets ni
// la ejecutan.
async function releerCamposDudosos(base64Image, mimeType, portal, datosOCR, campos) {
  const dudosos = new Set(Array.isArray(datosOCR.campos_dudosos) ? datosOCR.campos_dudosos : []);
  const vacio = (v) => v === null || v === undefined || v === "";
  const aRevisar = campos
    .filter((c) => vacio(datosOCR[c]) || dudosos.has(c))
    .slice(0, 3); // acotado: más campos = respuesta larga y cara sin ganancia clara
  if (!aRevisar.length) return { revisados: [], correcciones: [] };

  const lineas = aRevisar.map((c) => {
    const pista = pistaDeCampo(portal, c);
    return `- "${c}"${pista ? `: ${pista}` : ""}`;
  });

  console.log(`🔎 Pasada 3: relectura dirigida de ${aRevisar.join(", ")}`);
  const resp = await anthropic.messages.create({
    model: MODELO_EXTRACCION,
    max_tokens: 400,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mimeType, data: base64Image } },
        { type: "text", text: `Estás VERIFICANDO la lectura de un ticket, no extrayéndolo de cero. Localiza en la imagen únicamente estos campos y léelos carácter por carácter.

${lineas.join("\n")}

Responde SOLO este JSON, una entrada por campo:
{
  "<campo>": { "valor": "el valor completo", "deletreado": "los caracteres separados por guiones, en orden", "seguro": true }
}
Reglas:
- "deletreado" existe para que no se te cuele ni sobre ningún carácter: escríbelo antes de decidir "valor", y que "valor" sea exactamente esos caracteres sin los guiones.
- "seguro": true SOLO si distingues cada carácter sin adivinar. Si dudas de uno, false.
- Si el campo no aparece en el ticket: "valor" null y "seguro" false.
- Para importes, "valor" es el número sin símbolos ni comas.` }
      ],
    }],
  });

  const leido = extraerJson(resp.content[0].text);
  const correcciones = [];
  for (const campo of aRevisar) {
    const r = leido[campo];
    if (!r || typeof r !== "object") continue;
    let valor = r.valor;
    if (valor === undefined) continue;
    if (typeof valor === "string" && valor.trim() === "") valor = null;
    if (campo === "total" && valor !== null) valor = parseFloat(String(valor).replace(/[^0-9.]/g, ""));

    const antes = datosOCR[campo];
    const mismo = String(antes ?? "").trim().toUpperCase() === String(valor ?? "").trim().toUpperCase();

    if (mismo) {
      // Dos lecturas independientes coinciden: deja de ser dudoso.
      dudosos.delete(campo);
    } else if (valor !== null && (vacio(antes) || r.seguro === true)) {
      // Solo se pisa un valor existente si la relectura dice estar segura.
      datosOCR[campo] = valor;
      dudosos.delete(campo);
      correcciones.push(`${campo}: "${antes ?? "null"}" → "${valor}"`);
    } else {
      dudosos.add(campo);
    }
  }

  datosOCR.campos_dudosos = [...dudosos];
  if (correcciones.length) console.log(`✏️ Pasada 3 corrigió → ${correcciones.join(" | ")}`);
  else console.log(`👍 Pasada 3 confirmó la lectura de la Pasada 2`);
  return { revisados: aRevisar, correcciones };
}

// La Referencia de los tickets NetPay no es un número opaco: es
// estación(5) + número de ticket + verificador(4), y el número de ticket está
// impreso APARTE en la línea "Ticket: 1322663". O sea, el propio ticket trae con
// qué comprobar la lectura — la única familia de este sistema que lo permite.
//
// Se usa porque el fallo típico es un solo carácter: se leyó
// "06922132265334FC" cuando lo impreso era "06922132266334FC". Sin esta
// comprobación el portal responde "No se encontró el consumo" y el ticket se
// archiva como vencido cuando en realidad estaba bien fotografiado.
//
// Solo se reconstruye si la longitud cuadra EXACTAMENTE con 5+ticket+4: si no
// cuadra, el formato no es el que se cree y se deja como está, marcado dudoso.
function repararReferenciaNetPay(datosOCR) {
  const ref = datosOCR.referencia ? String(datosOCR.referencia).trim().toUpperCase() : null;
  const noTicket = datosOCR.noTicket ? String(datosOCR.noTicket).replace(/\D/g, "") : null;
  if (!ref || !noTicket || ref.includes(noTicket)) return;

  const dudosos = new Set(Array.isArray(datosOCR.campos_dudosos) ? datosOCR.campos_dudosos : []);
  if (ref.length === 5 + noTicket.length + 4) {
    const reparada = ref.slice(0, 5) + noTicket + ref.slice(-4);
    console.log(`🔧 Referencia reconstruida con el nº de ticket: ${ref} → ${reparada}`);
    datosOCR.referencia = reparada;
    dudosos.delete("referencia");
  } else {
    console.log(`⚠️ La referencia ${ref} no contiene el ticket ${noTicket} y la longitud no cuadra: queda dudosa`);
    dudosos.add("referencia");
  }
  datosOCR.campos_dudosos = [...dudosos];
}

// Procesa la imagen de un ticket: 2 pasadas Sonnet + heurísticas de reclasificación.
// Devuelve { datosOCR, textoOCR, portalDetectado, confianza, camposDudosos,
//            requiereConfirmacion, campos, portalUrl }.
async function procesarImagenTicket(imageBuffer, mimeType) {
  const base64Image = imageBuffer.toString("base64");
  let datosOCR = {};
  let textoOCR = "";
  let portalDetectado = "desconocido";
  // Las dos pasadas cuentan los tickets de la foto por separado; basta con que
  // UNA vea el segundo para mandar la foto a revisión.
  let ticketsVistos = 1;

  // ── PASADA 1: Detección de portal ──
  //
  // Corre en HAIKU, no en Sonnet. Esta pasada no extrae nada: solo clasifica el
  // ticket entre los portales conocidos y devuelve 200 tokens. Es justo el
  // trabajo que un modelo pequeño hace igual de bien y muchísimo más barato, y
  // era la mitad de cada ticket pagada a precio de Sonnet sin necesidad.
  //
  // Escalado: si Haiku dice "desconocido" o no llega a 70 de confianza, se
  // repite en Sonnet. Así lo caro se paga SOLO en los tickets difíciles, que es
  // donde de verdad aporta — y un fallo de Haiku no degrada el resultado, solo
  // añade una segunda llamada.
  const t1start = Date.now();
  try {
    const promptDeteccion = buildPromptDeteccion();
    const pedirDeteccion = async (modelo) => {
      const r = await anthropic.messages.create({
        model: modelo,
        max_tokens: 200,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mimeType, data: base64Image } },
            { type: "text", text: promptDeteccion },
          ],
        }],
      });
      return extraerJson(r.content[0].text);
    };

    const nombreCorto = (m) => (m.includes("haiku") ? "Haiku" : m.includes("opus") ? "Opus" : "Sonnet");
    console.log(`🔍 Pasada 1: detección con ${nombreCorto(MODELO_DETECCION)}...`);
    let det = await pedirDeteccion(MODELO_DETECCION);
    let modeloUsado = nombreCorto(MODELO_DETECCION);

    // El escalado solo tiene sentido si la detección corre en un modelo MENOR
    // que la extracción. Con los dos en Sonnet, repetir sería pagar dos veces
    // lo mismo para obtener lo mismo.
    if (MODELO_DETECCION !== MODELO_EXTRACCION &&
        ((det.portal || "desconocido") === "desconocido" || Number(det.confianza || 0) < 70)) {
      console.log(`↗️ Haiku no se decidió (${det.portal}/${det.confianza}) — se reintenta en Sonnet`);
      try {
        const det2 = await pedirDeteccion(MODELO_EXTRACCION);
        // Solo se acepta si Sonnet aporta algo mejor: si también duda, se
        // conserva lo de Haiku (que al menos pudo traer el comercio o el QR).
        if ((det2.portal || "desconocido") !== "desconocido" || Number(det2.confianza || 0) > Number(det.confianza || 0)) {
          det = det2;
          modeloUsado += "→" + nombreCorto(MODELO_EXTRACCION);
        }
      } catch (e) {
        console.log("⚠️ El reintento en Sonnet falló, se usa lo de Haiku:", e.message);
      }
    }

    const t1ms = Date.now() - t1start;
    portalDetectado = det.portal || "desconocido";
    const urlQR = det.urlQR || null;
    if (det.comercio) datosOCR.comercio = det.comercio;
    ticketsVistos = Math.max(ticketsVistos, Number(det.ticketsEnFoto) || 1);
    console.log(`⏱️ ${modeloUsado} detección: ${t1ms}ms | Portal: ${portalDetectado} (${det.confianza || 0}pts)`);

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
      model: MODELO_EXTRACCION,
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
    const extraido = extraerJson(textoOCR);
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

  // Relectura dirigida. Si falla, no se toca nada: lo de la Pasada 2 sigue en pie.
  try {
    await releerCamposDudosos(base64Image, mimeType, portalDetectado, datosOCR, campos);
  } catch (e) {
    console.log("⚠️ Pasada 3 falló (se conserva la lectura anterior):", e.message);
  }

  // La Pasada 3 puede tocar la fecha, y `corregirAnioReciente` solo había
  // corrido tras la Pasada 2. Sin esto, una relectura "seguro: true" mete un año
  // viejo saltándose el corrector: medido en un ticket de JUL 27 26 que la
  // relectura dejó en 27/07/2025.
  for (const campo of ['fecha', 'fechaCompra']) {
    if (datosOCR[campo]) {
      const corr = corregirAnioReciente(datosOCR[campo]);
      if (corr !== datosOCR[campo]) {
        console.log(`📅 Año corregido tras la Pasada 3 en '${campo}': ${datosOCR[campo]} → ${corr}`);
        datosOCR[campo] = corr;
      }
    }
  }

  if (portalDetectado === "enerfueltech" || portalDetectado === "enerser") repararReferenciaNetPay(datosOCR);

  // Cuántos tickets vio el modelo en la foto. Con más de uno solo se registra el
  // primero: el resto se perdería en silencio, así que el ticket va a revisión
  // aunque la lectura sea buena, para que alguien suba los que faltan.
  const ticketsEnFoto = Math.max(ticketsVistos, Number(datosOCR.ticketsEnFoto) || 1);
  if (ticketsEnFoto > 1) console.log(`📸 La foto trae ${ticketsEnFoto} tickets — se registra solo el primero`);

  const confianza = datosOCR.confianza || 'media';
  const camposDudosos = Array.isArray(datosOCR.campos_dudosos) ? datosOCR.campos_dudosos : [];

  // ⚠️ La regla anterior era: portal CONOCIDO + confianza != 'alta' → a revisión
  // humana. Estaba al revés. Cuanto mejor conocíamos el portal, más
  // bloqueábamos — justo cuando teníamos un bot capaz de preguntárselo al
  // portal, que valida el folio gratis y en segundos.
  //
  // Medido sobre los 67 tickets del sistema (12/08/2026):
  //     alta   36/40 facturados  90%
  //     media   5/5              100%   ← los que sí se intentaron
  //     baja    1/1              100%
  // 'media' no predice fallo: es lo que Sonnet contesta por defecto cuando no
  // puede jurarlo. Bloqueaba 13 de 17 tickets de una tanda sin ningún motivo
  // medible.
  //
  // Ahora solo paramos cuando de verdad no se puede seguir. Si el folio está
  // mal, el portal lo rechaza y ENTONCES se pide confirmación (error_code
  // datos_invalidos en lib/facturacion.js). La atención humana se gasta en lo
  // que el portal rechazó, no en cada duda del modelo.
  // Qué campos pide ESTE portal ya está declarado arriba, en `campos`
  // (camposPorPortal). Es la fuente correcta: una lista genérica de "folio o
  // referencia o codigoTicket…" daba por bueno un ticket de CAPUFE con
  // codigo=null solo porque traía folio — y el portal de CAPUFE no busca por
  // folio. Fue justo lo que pasó con los #208 y #210.
  const faltantes = campos.filter(c => {
    const v = datosOCR[c];
    return v === null || v === undefined || String(v).trim() === '';
  });
  if (faltantes.length) console.log(`🔎 Faltan campos que pide ${portalDetectado}: ${faltantes.join(', ')} — va a confirmación`);

  const requiereConfirmacion =
    ticketsEnFoto > 1 ||     // se perdería el resto de compras de la foto
    faltantes.length > 0     // el portal no puede buscar sin ellos
      ? 1 : 0;

  return { datosOCR, textoOCR, portalDetectado, confianza, camposDudosos, requiereConfirmacion, campos, portalUrl, ticketsEnFoto };
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
