const { facturarOXXO } = require('./oxxo');
const { facturarBuzonFacturas } = require('./buzonfacturas');
const { facturarGasmaz } = require('./gasmaz');
const { facturarFarmaciasGuadalajara } = require('./farmaciaguadalajara');
const { facturarHomeDepotMexico } = require('./homedepot');
const { facturarRendichicas } = require('./rendichicasestacionpirusadecv');
const { facturarBenavides } = require('./benavides');
const { facturarPanama } = require('./panama');
const { facturarCarlsJr } = require('./carljr');
const { facturarSushito } = require('./sushito');
const { facturarAutoZone } = require('./autozone');
const { facturarAlbatros } = require('./albatros');
const { facturarPinfra } = require('./pinfra');
const { facturarDana } = require('./dana');
const { facturarTufesa } = require('./tufesa');
const { facturarBodegaAurrera } = require('./bodegaaurrera');
const { facturarPetrofigues } = require('./petrofigues');
const { facturarGASHR } = require('./gashr');
const { facturarGasolineros } = require('./gasolineros');
const { facturarG500 } = require('./g500');
const { facturarFacturaGAS } = require('./facturagas');
const { facturarERFC } = require('./erfc');
const { facturarOrler } = require('./orler');
const { facturarEnerfuelTech } = require('./enerfueltech');
const { facturarEnerser } = require('./enerser');
const { facturarGrupoCentra } = require('./grupocentra');
const { facturarTopGas } = require('./topgas');
const { facturarQualligas } = require('./qualligas');
const { facturarEstrellaBlanca } = require('./estrellablanca');
const { facturarLosSenderos } = require('./lossenderos');
const { facturarGrupoArlosa } = require('./grupoarlosa');
const { facturarYoubuy } = require('./youbuy');
const { facturarFacturaT } = require('./facturat');
const { facturarRedco } = require('./redco');
const { facturarCadisa } = require('./cadisa');
const { facturarOrsan } = require('./orsan');
const { facturarRAMCAL } = require('./ramcal');
const { facturarCaffenio } = require('./caffenio');
const { facturarCapufe } = require('./capufe');
const { facturarIGasFac } = require('./igasfac');
const { facturarOxxoGas } = require('./oxxogas');
const { facturarLittleCaesars } = require('./littlecaesars');
const { facturarConEngine, tieneEngine } = require('../engine');
const fs = require('fs');
const path = require('path');

// ⚠️ NORMALIZACIÓN DE CAMPOS — no quitar.
//
// El OCR entrega SIEMPRE nombres genéricos (folio, total, fecha, referencia,
// portalUrl), pero cada bot se escribió con los nombres del portal que
// automatiza: `importe` en GASHR/Petrofigues, `fechaPago` en Orler, `codigo` en
// CAPUFE/RAMCAL, `urlEstacion` en RAMCAL, `idw` en eRFC...
//
// Cuando no coinciden, el bot recibe `undefined` y falla de forma críptica
// ("Fecha de pago con formato inesperado: undefined",
// "Cannot read properties of undefined (reading 'replace')"). Ha pasado ya con
// RAMCAL, CAFFENIO y Orler, así que se resuelve UNA vez aquí en el router en
// lugar de parchear cada bot por separado.
//
// Solo se RELLENAN huecos: si el dato ya viene con el nombre que el bot espera,
// no se toca.
function normalizarDatos(datos) {
  const d = { ...datos };
  const primero = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== '');

  d.folio      = primero(d.folio, d.codigoTicket, d.referencia, d.numeroTicket, d.noTicket);
  d.importe    = primero(d.importe, d.total, d.monto);
  d.total      = primero(d.total, d.importe, d.monto);
  d.monto      = primero(d.monto, d.total, d.importe);
  d.fechaPago  = primero(d.fechaPago, d.fecha, d.fechaCompra);
  d.fecha      = primero(d.fecha, d.fechaPago, d.fechaCompra);
  // CAPUFE: el código de 18 caracteres llega como `codigo` con el prompt nuevo,
  // pero las lecturas hechas antes con el prompt genérico lo dejaron en
  // `referencia` — es el caso de los tickets #199 y #200 del cliente DGA.
  // El folio numérico va el ÚLTIMO a propósito: no sirve para facturar y
  // mandarlo sería quemar el código sin remedio, porque consultar reserva.
  d.codigo     = primero(d.codigo, d.codigoTicket, d.codigoFacturacion, d.referencia, d.folio);
  d.referencia = primero(d.referencia, d.codigoTicket, d.folio);
  d.urlEstacion = primero(d.urlEstacion, d.portalUrl, d.portal_url);
  d.portalUrl  = primero(d.portalUrl, d.portal_url, d.urlEstacion);

  // ⚠️ DOS CORREOS QUE NO SE DEBEN CONFUNDIR:
  //   d.email        → el del residente. Sirve para AVISARLE que su factura ya
  //                    esta lista (lo manda lib/facturacion.js aparte).
  //   d.emailEntrega → el buzon de captura. Es el que hay que escribir en el
  //                    campo "enviar factura a" de CUALQUIER portal, para que
  //                    el CFDI entre solo por IMAP y se asocie al ticket.
  // Escribir el correo del residente en el portal —que es lo que hacia
  // cadisa.js— manda el CFDI a un buzon que el sistema no lee: la factura se
  // emite y el ticket se queda esperando para siempre. Paso con Casa Ley y La
  // Parisina, cuyos CFDI acabaron en GASTOSCULIACAN@GMAIL.COM.
  d.emailEntrega = primero(d.emailEntrega, process.env.IMAP_USER, 'buzonfacturas@serviciosga.site');

  // Datos fiscales de GPN: constantes del emisor receptor, no salen del ticket.
  d.rfc = primero(d.rfc, 'GPR110128QD8');
  d.regimenFiscal = primero(d.regimenFiscal, '601');
  d.usoCfdi = primero(d.usoCfdi, 'G03');

  return d;
}

async function detectarYFacturar(datosCrudos, db = null) {
  const datos = normalizarDatos(datosCrudos);
  const texto = (datos.ocr_text || '').toLowerCase();
  const comercio = (datos.comercio || '').toLowerCase();
  const portalUrl = (datos.portalUrl || '').toLowerCase();
  const portal = (datos.portal || '').toLowerCase();

  // ── OXXO GAS — DEBE ir antes que el chequeo genérico de "oxxo" (línea
  // ~42/239 más abajo), porque "OXXO GAS" contiene la palabra "oxxo" y
  // sería capturado por error por el bot de la tienda de conveniencia.
  // ⚠️ Este bot NO es autónomo: requiere cookies de sesión inyectadas por
  // variables de entorno (OXXO_GAS_CI_SESSION y similares) que el usuario
  // debe generar iniciando sesión a mano — el login tiene reCAPTCHA v2 que
  // este proyecto nunca resuelve. Si no hay sesión vigente, el bot regresa
  // error_code:'captcha' de forma controlada (ver bots/oxxogas.js).
  if (
    portal === 'oxxogas' ||
    portalUrl.includes('oxxogas.com') ||
    comercio.includes('oxxo gas') ||
    texto.includes('oxxo gas') ||
    texto.includes('oxxogas.com')
  ) {
    console.log('🎯 Portal detectado: OXXO GAS (requiere sesión manual)');
    return await facturarOxxoGas(datos);
  }

  // NexusFuel tiene DOS plantillas distintas y el TLD es lo único que las
  // separa: nexusfuel.mx (gasmazfactura./redmaxfactura., formulario del engine)
  // y nexusfuel.com.mx (un subdominio POR ESTACIÓN — lugasa., … — con el mismo
  // formulario "Ingrese sus datos / (N) Ticket Agregado" de petrosistemas, que
  // maneja gashr.js). Mandar los segundos al engine cargaba el tenant genérico
  // equivocado y el portal se quedaba sin responder (ticket #347).
  if (portalUrl.includes('nexusfuel.com.mx')) {
    console.log('🎯 Portal detectado: NexusFuel por estación (nexusfuel.com.mx) → bot GASHR');
    return await facturarGASHR(datos);
  }

  // ── ENGINE EXPERIMENTAL — intenta primero con el portal declarativo ───────
  // Resolver variante NexusFuel: gasmaz (gasmazfactura) vs ramsa (redmaxfactura).
  // Mismo mecanismo, diferente url_base en config.json.
  let enginePortal = portal;
  if (portal === 'gasmaz' || portalUrl.includes('nexusfuel') || portalUrl.includes('redmaxfactura') || portalUrl.includes('gasmaz')) {
    enginePortal = portalUrl.includes('redmaxfactura') ? 'ramsa' : 'gasmaz';
  }
  if (portal === 'arco' || portalUrl.includes('buzonfacturas.com')) {
    enginePortal = 'arco';
  }
  if (portal === 'oxxo' || texto.includes('oxxo') || comercio.includes('oxxo')) {
    enginePortal = 'oxxo';
  }
  if (
    portal === 'rendichicas' ||
    portal === 'rendichicasestacionpirusadecv' ||
    comercio.includes('rendichicas') ||
    comercio.includes('rendi chicas') ||
    portalUrl.includes('rendilitros') ||
    portalUrl.includes('rendichicas')
  ) {
    enginePortal = 'rendichicas';
  }

  // Fallback automático al bot legacy en caso de cualquier excepción.
  // En esta fase de validación: OK→retorna engine, error→retorna engine, excepción→legacy.
  if (enginePortal && tieneEngine(enginePortal)) {
    console.log(`[ENGINE][${enginePortal}] Iniciando engine declarativo...`);
    try {
      const resultado = await facturarConEngine(enginePortal, datos);
      if (resultado === null) {
        // null = engine no tiene flow para este portal (no debería pasar si tieneEngine=true)
        console.log(`[ENGINE FALLBACK][${enginePortal}] Engine retornó null inesperado — usando bot legacy`);
      } else {
        // Resultado controlado (ok:true o ok:false) — lo retornamos directamente.
        // No re-intentar con legacy: si el engine dijo "ya_facturado" o "datos_invalidos",
        // legacy también fallará. Si el engine dijo "ok:true", ya terminamos.
        const estado = resultado.ok ? '✅ OK' : `❌ ${resultado.error_code}`;
        console.log(`[ENGINE][${enginePortal}] Resultado: ${estado}`);
        return resultado;
      }
    } catch (err) {
      // Excepción inesperada en el engine (bug en hooks.js, acción faltante, etc.)
      // Caemos al bot legacy para proteger producción.
      console.error(`[ENGINE FALLBACK][${enginePortal}] Excepción no controlada: ${err.message}`);
      console.error(`[ENGINE FALLBACK][${enginePortal}] Stack: ${err.stack}`);
      // Continúa al fallback legacy abajo
    }
  }

  // LITTLE CAESARS (Cafrema) — ⚠️ NO enrutar por el comercio "little caesars"
  // a secas: hay un SEGUNDO Little Caesars, el de Navojoa (CAFRENA,
  // /cafrena/lc/crear-cvo/), con su propio bot que entra por el fallback
  // dinámico. Se distinguen por la clave de portal y por /cafrema/ en la URL.
  if (portal === 'littlecaesars' || portalUrl.includes('/cafrema/')) {
    console.log('🎯 Portal detectado: Little Caesars (Cafrema)');
    return await facturarLittleCaesars(datos);
  }

  if (
    portal === 'homedepot' ||
    texto.includes('home depot') ||
    comercio.includes('home depot') ||
    portalUrl.includes('homedepot.com.mx')
  ) {
    console.log('🎯 Portal detectado: Home Depot Mexico');
    return await facturarHomeDepotMexico(datos);
  }

  if (
    portal === 'rendichicas' ||
    portal === 'rendichicasestacionpirusadecv' ||
    comercio.includes('rendichicas') ||
    comercio.includes('rendi chicas') ||
    portalUrl.includes('rendilitros') ||
    portalUrl.includes('rendichicas')
  ) {
    console.log('🎯 Portal detectado: Rendichicas');
    return await facturarRendichicas(datos);
  }

  if (
    portal === 'benavides' ||
    portal === 'farmaciasbenavides' ||
    comercio.includes('benavides') ||
    portalUrl.includes('e-facturate.com/benavides')
  ) {
    console.log('🎯 Portal detectado: Farmacias Benavides');
    return await facturarBenavides(datos);
  }

  if (
    portal === 'panama' ||
    portal === 'grupopanama' ||
    portalUrl.includes('grupopanama.mx') ||
    comercio.includes('pasteleria panama') ||
    comercio.includes('pastelerias panama') ||
    comercio.includes('restaurante panama') ||
    texto.includes('grupopanama')
  ) {
    console.log('🎯 Portal detectado: Panamá Restaurante y Pastelería');
    return await facturarPanama(datos);
  }

  // ⚠️ GRUPO A-LOSA VA ANTES QUE CARL'S JR, NO DESPUÉS.
  //
  // Carl's Jr opera con franquicias, y cada franquiciatario factura por su
  // cuenta: el ticket lleva el logo de Carl's Jr, pero el emisor fiscal es otra
  // empresa (STAR LAGUNA S.A. de C.V. en el #367) y el portal es el suyo, no el
  // Egrid corporativo de ICR. Si se comprueba primero `comercio.includes("carl's
  // jr")`, TODOS los tickets de franquicia caen en carljr.js, que ni siquiera
  // encuentra los campos y contesta "no hay referencia que capturar" — un
  // mensaje que suena a OCR malo cuando el problema es el portal equivocado.
  // Le pasó al #367.
  if (
    portal === 'grupoarlosa' ||
    portalUrl.includes('grupoarlosa') ||
    portalUrl.includes('grupoa-losa') ||   // el OCR lee un guion que no existe
    comercio.includes('star laguna') ||
    texto.includes('grupoarlosa') ||
    texto.includes('grupoa-losa') ||
    texto.includes('sla101203dx4')
  ) {
    console.log("🎯 Portal detectado: Grupo A-Losa (Carl's Jr franquicia)");
    return await facturarGrupoArlosa(datos);
  }

  if (
    portal === 'carljr' ||
    portal === 'icr' ||
    comercio.includes('carls jr') ||
    comercio.includes("carl's jr") ||
    comercio.includes('icr s.a') ||
    portalUrl.includes('egridhub') ||            // portal nuevo (ago-2026)
    portalUrl.includes('facturacion4.icr.mx') ||
    portalUrl.includes('icr.mx')
  ) {
    console.log("🎯 Portal detectado: Carl's Jr (ICR S.A. de C.V.)");
    return await facturarCarlsJr(datos);
  }

  if (
    portal === 'pinfra' ||
    comercio.includes('pinfra') ||
    comercio.includes('santa ana-altar') ||
    comercio.includes('santa ana altar') ||
    portalUrl.includes('pinfrafacturacion')
  ) {
    console.log('🎯 Portal detectado: PINFRA (casetas)');
    // El correo del login tiene que ser uno ya asociado al RFC en el portal.
    return await facturarPinfra({ ...datos, email: datos.email });
  }

  if (
    portal === 'albatros' ||
    comercio.includes('albatros') ||
    portalUrl.includes('albatrosautobuses') ||
    portalUrl.includes('grupoalbatros')
  ) {
    console.log('🎯 Portal detectado: Albatros Autobuses');
    return await facturarAlbatros(datos);
  }

  if (
    portal === 'autozone' ||
    comercio.includes('autozone') ||
    portalUrl.includes('autozone.cdc.origon.cloud') ||
    portalUrl.includes('origon.cloud')
  ) {
    console.log('🎯 Portal detectado: AutoZone (CDC Origon Cloud)');
    return await facturarAutoZone(datos);
  }

  // G500 Network — ControlGAS con login; la estación va en el PermisoCRE de
  // la URL, no por autocompletado como facturagas.net.
  if (
    portal === 'g500' ||
    portalUrl.includes('g500facturagas') ||
    portalUrl.includes('g500network.com') ||
    comercio.includes('g500') ||
    comercio.includes('servicio gastur')
  ) {
    console.log('🎯 Portal detectado: G500 Network (ControlGAS con login)');
    return await facturarG500(datos);
  }

  // Gasolineros.mx (Grupo Timex) — plataforma compartida: una sola URL, la
  // estación se elige por número. Cubre La Cuesta/Grupo Hispánica (13236),
  // MABA San Francisco/Mobil (2380) y cualquier otra que use el mismo portal.
  if (
    portal === 'gasolineros' ||
    portalUrl.includes('gasolineros.mx') ||
    portalUrl.includes('hercorgas.com') ||   // el ticket de La Cuesta imprime esta URL
    portalUrl.includes('grupomaba.com') ||   // el de MABA imprime esta otra
    comercio.includes('la cuesta') ||
    comercio.includes('grupo hispanica') ||
    comercio.includes('maba san francisco')
  ) {
    console.log('🎯 Portal detectado: Gasolineros.mx (Grupo Timex)');
    return await facturarGasolineros(datos);
  }

  if (
    portal === 'dana' ||
    comercio.includes('dana comida') ||
    comercio.includes('dana mexicana') ||
    portalUrl.includes('danacomidamexicana') ||
    // ⚠️ HAY DOS FAMILIAS "mefacturo" CON SELECTORES DISTINTOS, y confundirlas
    // manda el ticket al bot equivocado:
    //   mefacturo.mx/*  → admin.softrestaurant.com → #FolioTicket /
    //                     #CodigoUnicoTicket  → bots/sushito.js
    //   mefacturo.com/* → facturacion.softrestaurant.com → #folio /
    //                     #unicCode / #RFC    → bots/dana.js  (ESTE)
    // Comprobado en vivo sobre mefacturo.com/chayitocentro: redirige a
    // facturacion.softrestaurant.com y sirve #folio, #unicCode y #RFC.
    // Pollo Feliz vive en mefacturo.com pero tiene su propia rama mas abajo.
    (portalUrl.includes('mefacturo.com') && !portalUrl.includes('pollofeliz')) ||
    portalUrl.includes('facturacion.softrestaurant.com')
  ) {
    console.log('🎯 Portal detectado: SoftRestaurant / mefacturo.com (bot dana)');
    return await facturarDana(datos);
  }

  if (
    portal === 'pollofeliz' ||
    comercio.includes('pollo feliz') ||
    portalUrl.includes('mefacturo.com/pollofelizfact')
  ) {
    // Mismo SoftRestaurant que Dana (#unicCode/#folio/#RFC), confirmado en vivo
    // el 08-sep-2026 inspeccionando el DOM real del portal.
    console.log('🎯 Portal detectado: Pollo Feliz (SoftRestaurant, variante Dana)');
    return await facturarDana(datos);
  }

  if (
    portal === 'tufesa' ||
    comercio.includes('tufesa') ||
    portalUrl.includes('tufesa.com')
  ) {
    console.log('🎯 Portal detectado: TUFESA');
    return await facturarTufesa(datos);
  }

  if (
    portal === 'bodegaaurrera' ||
    comercio.includes('bodega aurrera') ||
    comercio.includes('wal mart') ||
    comercio.includes('walmart') ||
    comercio.includes("sam's club") ||
    comercio.includes('superama') ||
    portalUrl.includes('walmartmexico.com.mx')
  ) {
    console.log('🎯 Portal detectado: Bodega Aurrera / Walmart de México');
    return await facturarBodegaAurrera(datos);
  }

  if (
    portal === '7eleven' ||
    portal === 'seveneleven' ||
    comercio.includes('eleven') ||
    portalUrl.includes('e7-eleven') ||
    portalUrl.includes('7-eleven')
  ) {
    console.log('🎯 Portal detectado: 7-Eleven México');
    const { facturar7Eleven } = require('./7elevenmexicosadecv');
    return await facturar7Eleven(datos);
  }

  if (
    portal === 'sushito' ||
    portal === 'sushio' ||
    portal === 'elcaporal' ||
    portal === 'elcaporalrestaurante' ||
    portal === 'allegro' ||
    portal === 'allegrecaffe' ||
    portal === 'allegrezonadorada' ||
    comercio.includes('sushi o') ||
    comercio.includes('sushio') ||
    comercio.includes('el caporal') ||
    comercio.includes('caporal') ||
    comercio.includes('allegro') ||
    portalUrl.includes('mefacturo.mx/sushio') ||
    portalUrl.includes('mefacturo.mx/elcaporal') ||
    portalUrl.includes('mefacturo.mx/allegre')
  ) {
    console.log('🎯 Portal detectado: mefacturo.mx (SushiO / El Caporal / Allegro)');
    return await facturarSushito(datos);
  }

  if (
    portal === 'farmaciaguadalajara' ||
    texto.includes('farmacia guadalajara') ||
    texto.includes('farmaciasguadalajara') ||
    texto.includes('fragua') ||
    comercio.includes('farmacia guadalajara') ||
    comercio.includes('fragua') ||
    portalUrl.includes('farmaciasguadalajara.com')
  ) {
    console.log('🎯 Portal detectado: Farmacias Guadalajara');
    return await facturarFarmaciasGuadalajara(datos);
  }

  if (
    portal === 'arco' ||
    texto.includes('buzonfacturas') ||
    portalUrl.includes('buzonfacturas') ||
    texto.includes('arco') ||
    comercio.includes('arco')
  ) {
    console.log('🎯 Portal detectado: BuzonFacturas');
    return await facturarBuzonFacturas(datos);
  }

  if (portal === 'oxxo' || texto.includes('oxxo') || comercio.includes('oxxo')) {
    console.log('🎯 Portal detectado: OXXO');
    return await facturarOXXO(datos);
  }

  if (
    portal === 'gasmaz' ||
    texto.includes('nexusfuel') ||
    texto.includes('gasmaz') ||
    portalUrl.includes('nexusfuel') ||
    portalUrl.includes('gasmaz') ||
    comercio.includes('gasmaz')
  ) {
    console.log('[LEGACY][gasmaz] Ejecutando bot legacy NexusFuel/Gasmaz');
    return await facturarGasmaz(datos);
  }

  if (
    portal === 'petrofigues' ||
    comercio.includes('gonzer') ||
    portalUrl.includes('petrofigues') ||
    texto.includes('petrofigues')
  ) {
    console.log('🎯 Portal detectado: Petrofigues');
    return await facturarPetrofigues(datos);
  }

  // ⚠️ facturacionestacion.com da un SUBDOMINIO POR ESTACIÓN
  // (valerogdl., lasconchas., …). Aquí solo se reconocía "valerogdl." a pelo,
  // así que cualquier otra estación de la misma plataforma caía en "portal no
  // reconocido" y disparaba al agente de altas para un portal que YA tiene bot
  // — pasó con el ticket #182 (lasconchas.facturacionestacion.com). Se
  // reconoce el dominio entero, venga del subdominio que venga.
  if (
    portal === 'gashr' ||
    comercio.includes('gashr') ||
    portalUrl.includes('grupogashr') ||
    portalUrl.includes('facturacionestacion.com') ||
    // petrosistemas.com.mx es el OTRO dominio de la misma plataforma NexusFuel
    // (facturagruposanpedro., facturadieselmax., …). resolverBaseUrl() en
    // gashr.js ya lo resolvía, pero el router nunca llegaba aquí y los tickets
    // caían al agente de altas como si fuera un portal nuevo (#325/#326/#332).
    portalUrl.includes('petrosistemas.com.mx') ||
    texto.includes('grupogashr.com.mx') ||
    texto.includes('gashr')
  ) {
    console.log('🎯 Portal detectado: Grupo GASHR / NexusFuel (facturacionestacion o petrosistemas)');
    return await facturarGASHR(datos);
  }

  if (
    portal === 'facturagas' ||
    portalUrl.includes('facturagas.net') ||
    texto.includes('facturagas') ||
    texto.includes('controlgasfe') ||
    texto.includes('ddns.net')
  ) {
    console.log('🎯 Portal detectado: FacturaGAS/ControlGAS');
    return await facturarFacturaGAS(datos);
  }

  if (
    portal === 'erfc' ||
    portalUrl.includes('erfc.com.mx') ||
    texto.includes('erfc.com.mx') ||
    texto.includes('idw:')
  ) {
    console.log('🎯 Portal detectado: eRFC');
    return await facturarERFC(datos);
  }

  if (
    portal === 'orler' ||
    portalUrl.includes('sinaloa.gob.mx') ||
    comercio.includes('caseta') ||
    (texto.includes('caseta') && texto.includes('sinaloa'))
  ) {
    console.log('🎯 Portal detectado: Orler / Sinaloa (casetas de peaje)');
    return await facturarOrler(datos);
  }

  if (
    portal === 'enerfueltech' ||
    portalUrl.includes('enerfueltech.com') ||
    texto.includes('enerfueltech')
  ) {
    console.log('🎯 Portal detectado: Enerfuel Tech');
    return await facturarEnerfuelTech(datos);
  }

  // Enerser comparte el formato de referencia NetPay con Enerfuel Tech (y por
  // eso el mismo prompt de OCR), pero es OTRO portal: Angular con lote de
  // hasta 20 tickets. Tenía prompt desde julio y nunca bot ni routing, así que
  // sus tickets caían en "portal no reconocido" (casos #335 y #338).
  if (
    portal === 'enerser' ||
    portalUrl.includes('enerser.com.mx') ||
    texto.includes('enerser')
  ) {
    console.log('🎯 Portal detectado: Enerser');
    return await facturarEnerser(datos);
  }

  if (
    portal === 'grupocentra' ||
    portalUrl.includes('grupocentra.mx') ||
    texto.includes('grupocentra') ||
    texto.includes('operadora rio colorado') ||
    texto.includes('operadora río colorado')
  ) {
    console.log('🎯 Portal detectado: Grupo Centra (Karmi)');
    return await facturarGrupoCentra(datos);
  }

  // ── AMS Integra: DOS marcas, MISMO backend, PASO 1 DISTINTO ──────────────
  //
  // factura.estrellablanca.com.mx y facturafranquicias.lossenderos.com.mx son
  // el mismo build de React contra el mismo API (amsintegra.com.mx/main), pero
  // el primer paso NO es intercambiable:
  //   · Estrella Blanca  → NoComprobante + NoTr + Precio, claveTicket=AUTOBUS
  //   · Los Senderos     → Franquicia + Sucursal + FechaVenta + NoTicket,
  //                        claveTicket=CONSUMO
  // Mandar un ticket al bot equivocado no falla con un mensaje claro: el API
  // responde "El boleto no se encontró" y parece un folio mal leído.
  //
  // ⚠️ LOS SENDEROS VA PRIMERO A PROPÓSITO. El OCR del #350 (KFC Central
  // Durango) escribió portal:'estrellablanca' y portalUrl:'imprimefactura.mx',
  // y las dos cosas son falsas. Si se comprobara antes `portal ===
  // 'estrellablanca'`, ese ticket se iría al bot de autobuses para siempre. La
  // marca de la franquicia (KFC / SUSHIITTO) es la señal fiable.
  if (
    portal === 'lossenderos' ||
    portal === 'senderos' ||
    portalUrl.includes('lossenderos.com.mx') ||
    portalUrl.includes('facturafranquicias') ||
    comercio.includes('kfc') ||
    comercio.includes('sushiitto') ||
    texto.includes('facturafranquicias')
  ) {
    // KFC El Refugio (#364) NO es de Los Senderos: factura en
    // facturacion.prb.com.mx:444, que es otra plataforma entera. Se reconoce
    // porque su referencia es un folio largo de 16 dígitos.
    const esPRB = portalUrl.includes('prb.com.mx') ||
      /\b\d{16}\b/.test(String(datos.referencia || datos.folio || ''));
    if (!esPRB) {
      console.log('🎯 Portal detectado: Los Senderos franquicias (AMS Integra)');
      return await facturarLosSenderos(datos);
    }
  }

  if (
    portal === 'estrellablanca' ||
    portalUrl.includes('estrellablanca.com.mx') ||
    portalUrl.includes('apifacturasestrellablanca') ||
    comercio.includes('expreso futura') ||
    comercio.includes('estrella blanca') ||
    texto.includes('futura siente') ||
    texto.includes('fsm210831qu5')
  ) {
    console.log('🎯 Portal detectado: Estrella Blanca / Expreso Futura (AMS Integra)');
    return await facturarEstrellaBlanca(datos);
  }

  // Grupo A-Losa: franquiciatario de Carl's Jr que factura POR SU CUENTA, no
  // por el portal Egrid de ICR corporativo que maneja carljr.js. Va ANTES que
  // carljr porque el ticket dice "Carl's Jr" en grande y caería allí.
  // ⚠️ El OCR lee el dominio como "grupoa-losa.mx" (con guion) sobre la tira
  // térmica; ese dominio NO EXISTE. El bueno es grupoarlosa.mx.
  if (
    portal === 'grupoarlosa' ||
    portalUrl.includes('grupoarlosa') ||
    portalUrl.includes('grupoa-losa') ||
    comercio.includes('star laguna') ||
    texto.includes('grupoarlosa') ||
    texto.includes('sla101203dx4')
  ) {
    console.log('🎯 Portal detectado: Grupo A-Losa (Carl\'s Jr franquicia)');
    return await facturarGrupoArlosa(datos);
  }

  // YouBuy: plataforma multi-inquilino, un subdominio por comercio
  // (facturasvalencia.youbuy.mx, facturasheparestaurantes.youbuy.mx…). El
  // subdominio NO se puede adivinar por el nombre del comercio: sale de la URL
  // impresa en el ticket.
  if (portal === 'youbuy' || portalUrl.includes('youbuy.mx') || texto.includes('youbuy.mx')) {
    console.log('🎯 Portal detectado: YouBuy');
    return await facturarYoubuy(datos);
  }

  // AutoFacturaT / Factura-T ("DescargaT"): multimarca, una ruta por marca
  // (/FacturacionChurchsChicken/, …). La marca sale de la URL.
  if (portal === 'facturat' || portalUrl.includes('autofacturat.com.mx') || texto.includes('autofacturat')) {
    console.log('🎯 Portal detectado: AutoFacturaT (Factura-T)');
    return await facturarFacturaT(datos);
  }

  // Alianza RedCo: ~18 grupos gasolineros comparten el MISMO facturaenlinea.aspx,
  // cada uno en su propio host DDNS y su propio puerto. El ticket llega con la
  // web corporativa del grupo (grupohorizon.com.mx en el #371), que es una
  // página de marketing y no el formulario: el bot resuelve la instancia real
  // probando puertos, porque el puerto publicado suele estar caído.
  if (
    portal === 'redco' ||
    portalUrl.includes('gruporedco') ||
    portalUrl.includes('grupohorizon') ||
    portalUrl.includes('facturaenlinea.aspx') ||
    comercio.includes('redco') ||
    comercio.includes('grupo horizon') ||
    texto.includes('gruporedco')
  ) {
    console.log('🎯 Portal detectado: Alianza RedCo (facturaenlinea.aspx)');
    return await facturarRedco(datos);
  }

  // QualliGas: plataforma multi-estación en estacion.qualligas.com/{numero}.
  // QualliGas no es la gasolinera, es el proveedor del software — el comercio
  // del ticket es otro (Grupo Gasolinero del Pacífico en el #357), así que la
  // detección tiene que mirar la URL y el texto, no el nombre del comercio.
  if (
    portal === 'qualligas' ||
    portalUrl.includes('qualligas') ||
    comercio.includes('qualligas') ||
    texto.includes('qualligas')
  ) {
    console.log('🎯 Portal detectado: QualliGas');
    return await facturarQualligas(datos);
  }

  // TopGas va ANTES que IGasFac a propósito: sus tickets no nombran su portal
  // (dicen "www.topgasmexico.com", que es la web comercial, no el de
  // facturación), así que con portal='desconocido' caían en IGasFac por
  // parecido del folio y el portal respondía "Ticket no encontrado" — que
  // suena a dato mal leído cuando en realidad era el portal equivocado
  // (tickets #331 y #339).
  if (
    portal === 'topgas' ||
    portalUrl.includes('topgasmexico') ||
    portalUrl.includes('topgas.kernotek') ||
    comercio.includes('topgas') ||
    texto.includes('topgas')
  ) {
    console.log('🎯 Portal detectado: TopGas (Kernotek)');
    return await facturarTopGas(datos);
  }

  // Grupo CADISA "AutoFacturas RADEC": la misma app desplegada una vez por
  // gasolinera, cada una en su propio DDNS (rindemas*.dyndns.org,
  // palov966facturas.ddns.net…). El ticket dice "RADEC" arriba y publica la
  // web comercial de la estación, no el DDNS — bots/cadisa.js lo resuelve.
  if (
    portal === 'cadisa' ||
    portal === 'radec' ||
    portalUrl.includes('rindemas') ||
    portalUrl.includes('estacionpaloverde') ||
    portalUrl.includes('palov966facturas') ||
    /dyndns\.org|ddns\.net/.test(portalUrl) && /facturas|autofactura/.test(portalUrl) ||
    comercio.includes('radec') ||
    texto.includes('autofacturas radec') ||
    texto.includes('grupo cadisa')
  ) {
    console.log('🎯 Portal detectado: Grupo CADISA / AutoFacturas RADEC');
    return await facturarCadisa(datos);
  }

  if (
    portal === 'orsan' ||
    portalUrl.includes('orsan.com.mx') ||
    texto.includes('mifactura.orsan')
  ) {
    console.log('🎯 Portal detectado: ORSAN (requiere cuenta)');
    return await facturarOrsan(datos);
  }

  if (
    portal === 'ramcal' ||
    portalUrl.includes('ramcal') ||
    comercio.includes('ramcal') ||
    texto.includes('ramcal')
  ) {
    console.log('🎯 Portal detectado: RAMCAL');
    return await facturarRAMCAL(datos);
  }

  if (
    portal === 'caffenio' ||
    portalUrl.includes('facturaciondrive.caffenio') ||
    comercio.includes('caffenio') ||
    texto.includes('caffenio')
  ) {
    console.log('🎯 Portal detectado: CAFFENIO');
    return await facturarCaffenio(datos);
  }

  // CAPUFE — el bot existía desde hace sesiones pero nunca se enrutó aquí ni se
  // añadió al gate, así que sus tickets caían en "portal no reconocido" y
  // disparaban al agente de altas para un portal que YA tenía bot.
  if (
    portal === 'capufe' ||
    portalUrl.includes('facturacioncapufe') ||
    portalUrl.includes('capufe.gob.mx') ||
    comercio.includes('capufe') ||
    /plaza de cobro|caminos y puentes/i.test(comercio)
  ) {
    console.log('🎯 Portal detectado: CAPUFE');
    return await facturarCapufe(datos);
  }

  // IGasFac — www.igasfac.com.mx. El OCR confunde el "1" inicial de la URL
  // impresa con una "l" minúscula (leyó "lgasfac.com.mx"), así que se aceptan
  // las tres grafías.
  if (
    portal === 'igasfac' ||
    portalUrl.includes('1gasfac') || portalUrl.includes('lgasfac') || portalUrl.includes('igasfac') ||
    texto.includes('1gasfac') || texto.includes('igasfac')
  ) {
    console.log('🎯 Portal detectado: IGasFac');
    return await facturarIGasFac(datos);
  }

  // Buscar bot dinámico generado por el sistema de agentes
  const slugify = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '').slice(0, 30);
  const portalVal = (portal && portal !== 'desconocido') ? portal : comercio;
  const slug = slugify(portalVal);
  if (slug) {
    const candidatos = [
      path.join(__dirname, `${slug}.js`),
      path.join(__dirname, `${slug.replace(/_/g, '')}.js`),
    ];
    for (const botPath of candidatos) {
      if (fs.existsSync(botPath)) {
        // Pre-chequeo de sintaxis: un bot truncado/malformado (p.ej. generado por
        // una versión vieja del agente) se descarta aquí en vez de reventar el require.
        try {
          new (require('vm').Script)(fs.readFileSync(botPath, 'utf8'), { filename: botPath });
        } catch (e) {
          console.log(`⚠️ Bot dinámico inválido (sintaxis), se ignora ${path.basename(botPath)}:`, e.message);
          continue;
        }
        try {
          delete require.cache[require.resolve(botPath)];
          const botModule = require(botPath);
          const fn = Object.values(botModule)[0];
          if (typeof fn === 'function') {
            console.log(`🤖 Bot dinámico: ${path.basename(botPath)}`);
            return await fn(datos);
          }
        } catch (e) {
          console.log(`⚠️ Error cargando bot dinámico ${botPath}:`, e.message);
        }
      }
    }
  }

  // Último recurso: buscar en DB por bots activos cuyo comercio empiece igual
  // (cubre casos donde el slug del OCR no coincide exactamente con el nombre registrado)
  if (db && slug && slug.length >= 4) {
    try {
      const prefijo = slug.slice(0, Math.min(10, slug.length));
      const [rows] = await db.query(
        "SELECT comercio, nombre_archivo, bot_code FROM portales_agente WHERE estado='activo' AND bot_code IS NOT NULL AND comercio LIKE ? LIMIT 1",
        [`${prefijo}%`]
      );
      if (rows.length) {
        const row = rows[0];
        const archivo = row.nombre_archivo || `${row.comercio}.js`;
        const botPath = path.join(__dirname, archivo);
        // No restaurar ni ejecutar código de DB que esté truncado/malformado.
        try {
          new (require('vm').Script)(row.bot_code || '', { filename: archivo });
        } catch (e) {
          console.log(`⚠️ Bot en DB inválido (sintaxis), se ignora ${archivo}:`, e.message);
          throw e; // sale del bloque try externo → cae a "Portal no reconocido"
        }
        if (!fs.existsSync(botPath)) {
          fs.writeFileSync(botPath, row.bot_code, 'utf8');
          console.log(`♻️ Bot restaurado desde DB: ${archivo}`);
        }
        try {
          delete require.cache[require.resolve(botPath)];
          const mod = require(botPath);
          const fn = Object.values(mod)[0];
          if (typeof fn === 'function') {
            console.log(`🤖 Bot dinámico (DB fallback): ${archivo}`);
            return await fn(datos);
          }
        } catch (e) {
          console.log(`⚠️ Error ejecutando bot DB ${archivo}:`, e.message);
        }
      }
    } catch (e) {
      console.log('⚠️ Error consultando portales_agente:', e.message);
    }
  }

  console.log('⚠️ Portal no reconocido:', datos.comercio);
  return {
    ok: false,
    sinPortal: true,
    msg: `Portal no reconocido para: ${datos.comercio || 'desconocido'}`,
  };
}

module.exports = { detectarYFacturar };

