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
const { facturarDana } = require('./dana');
const { facturarTufesa } = require('./tufesa');
const { facturarBodegaAurrera } = require('./bodegaaurrera');
const { facturarPetrofigues } = require('./petrofigues');
const { facturarGASHR } = require('./gashr');
const { facturarFacturaGAS } = require('./facturagas');
const { facturarERFC } = require('./erfc');
const { facturarOrler } = require('./orler');
const { facturarEnerfuelTech } = require('./enerfueltech');
const { facturarRAMCAL } = require('./ramcal');
const { facturarCaffenio } = require('./caffenio');
const { facturarCapufe } = require('./capufe');
const { facturarOxxoGas } = require('./oxxogas');
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
  d.codigo     = primero(d.codigo, d.codigoTicket, d.codigoFacturacion, d.folio);
  d.referencia = primero(d.referencia, d.codigoTicket, d.folio);
  d.urlEstacion = primero(d.urlEstacion, d.portalUrl, d.portal_url);
  d.portalUrl  = primero(d.portalUrl, d.portal_url, d.urlEstacion);

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

  if (
    portal === 'carljr' ||
    portal === 'icr' ||
    comercio.includes('carls jr') ||
    comercio.includes("carl's jr") ||
    comercio.includes('icr s.a') ||
    portalUrl.includes('facturacion4.icr.mx') ||
    portalUrl.includes('icr.mx')
  ) {
    console.log("🎯 Portal detectado: Carl's Jr (ICR S.A. de C.V.)");
    return await facturarCarlsJr(datos);
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

  if (
    portal === 'dana' ||
    comercio.includes('dana comida') ||
    comercio.includes('dana mexicana') ||
    portalUrl.includes('danacomidamexicana')
  ) {
    console.log('🎯 Portal detectado: Dana Comida Mexicana (SoftRestaurant)');
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

  if (
    portal === 'gashr' ||
    comercio.includes('gashr') ||
    portalUrl.includes('grupogashr') ||
    portalUrl.includes('valerogdl.facturacionestacion.com') ||
    texto.includes('grupogashr.com.mx') ||
    texto.includes('gashr')
  ) {
    console.log('🎯 Portal detectado: Grupo GASHR');
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

