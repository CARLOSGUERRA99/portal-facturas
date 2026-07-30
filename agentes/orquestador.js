const fs = require('fs');
const path = require('path');
const { analizarPortal } = require('./analizador');
const { generarBot, nombreArchivoDesde } = require('./generador');
const { validarBot } = require('./validador');
const { corregirBot } = require('./corrector');

const MAX_CORRECCIONES = 2; // El corrector auto-arregla hasta 2 veces con feedback de la prueba en vivo

// Lee una columna MySQL de tipo JSON de forma segura.
// mysql2 deserializa las columnas `json` automáticamente, así que el valor puede
// llegar YA como objeto. Hacerle JSON.parse() encima revienta con
// `"[object Object]" is not valid JSON`. Esta helper acepta ambas formas (objeto
// ya parseado o string) y nunca lanza — devuelve {} si no se puede interpretar.
function parseJsonCol(valor) {
  if (!valor) return {};
  if (typeof valor === 'object') return valor;
  try { return JSON.parse(valor); } catch { return {}; }
}

// Datos de prueba genéricos — el portal devolverá "ticket no encontrado"
// pero eso demuestra que el bot cargó el portal e interactuó con el formulario
const DATOS_TEST = {
  rfc: 'XAXX010101000',
  razonSocial: 'PUBLICO EN GENERAL',
  regimenFiscal: '601',
  usoCfdi: 'G03',
  folio: '0000000001',
  referencia: '0000000001',
  total: '100.00',
  fecha: new Date().toISOString().split('T')[0],
};

// Convierte nombre comercial en slug: "Rendichicas" → "rendichicas"
function slugify(nombre) {
  return nombre
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 30);
}

// Serializa el orquestador por slug: si llegan 2 tickets del MISMO portal nuevo
// a la vez, el segundo espera al primero y luego cae en la guarda de "ya existe"
// (estado activo/pendiente_aprobacion), evitando filas duplicadas en
// portales_agente y dobles sesiones de Browserless corriendo el mismo análisis.
const _orquestarColas = new Map();
function orquestar(args) {
  const slug = slugify(args.comercioNombre || '');
  const anterior = _orquestarColas.get(slug) || Promise.resolve();
  const siguiente = anterior.then(() => _orquestarImpl(args), () => _orquestarImpl(args));
  _orquestarColas.set(slug, siguiente.catch(() => {}));
  return siguiente;
}

// ── Orquestar: analizar → generar → validar → [corregir×N] → pendiente_aprobacion ──────────
async function _orquestarImpl({ db, ticketId, portalUrl, comercioNombre, instrucciones = '' }) {
  const slug = slugify(comercioNombre);
  console.log(`🎯 [Orquestador] Iniciando: ${slug} (${comercioNombre})`);

  // Crear o recuperar registro en portales_agente
  let [rows] = await db.query('SELECT id FROM portales_agente WHERE comercio = ? LIMIT 1', [slug]);
  let portalId;

  if (rows.length) {
    portalId = rows[0].id;
    const estadoActual = rows[0].estado;
    // Si ya está activo o pendiente de revisión, no re-correr el agente
    if (estadoActual === 'activo' || estadoActual === 'pendiente_aprobacion') {
      console.log(`⏭️ [Orquestador] Bot '${slug}' ya está en '${estadoActual}' — sin re-ejecución`);
      return { ok: true, etapa: estadoActual, portalId, msg: `Bot ya existe en estado '${estadoActual}'. Edítalo manualmente desde Admin si necesitas cambios.` };
    }
    await db.query(
      'UPDATE portales_agente SET estado=?, portal_url=?, instrucciones=?, ticket_id=?, error_msg=NULL, intentos_correccion=0, actualizado=NOW() WHERE id=?',
      ['analizando', portalUrl, instrucciones, ticketId || null, portalId]
    );
  } else {
    const [ins] = await db.query(
      'INSERT INTO portales_agente (comercio, nombre, portal_url, instrucciones, estado, ticket_id) VALUES (?,?,?,?,?,?)',
      [slug, comercioNombre, portalUrl, instrucciones, 'analizando', ticketId || null]
    );
    portalId = ins.insertId;
  }

  // Datos reales del ticket: permiten que el analizador RECORRA el flujo de verdad
  // (pase la validación de referencia/RFC y llegue a datos fiscales / modales / pasos 2-3).
  let datosReales = null;
  if (ticketId) {
    try {
      const [[tk]] = await db.query(
        'SELECT t.ocr_json, u.rfc, u.razon_social FROM tickets t JOIN users u ON t.user_id = u.id WHERE t.id = ?',
        [ticketId]
      );
      if (tk) {
        let ocr = {};
        try { ocr = JSON.parse(tk.ocr_json || '{}'); } catch {}
        datosReales = {
          rfc: tk.rfc || 'XAXX010101000',
          razonSocial: tk.razon_social || 'PUBLICO EN GENERAL',
          referencia: ocr.referencia || ocr.folio || ocr.codigoTicket || ocr.idFacturacion || '0000000001',
          folio: ocr.folio || ocr.referencia || '0000000001',
          total: ocr.total != null ? String(ocr.total) : '100.00',
          fechaDMY: ocr.fecha || new Date().toLocaleDateString('es-MX'),
          email: 'buzonfacturas@serviciosga.site',
        };
      }
    } catch (e) {
      console.log('⚠️ [Orquestador] No se pudieron leer datos reales del ticket:', e.message);
    }
  }

  // ── PASO 1: Analizar portal (hasta 3 intentos) ──────────────────────────────
  console.log('📡 [Orquestador] Paso 1: Analizando portal...');
  let analisis;
  let analisisErr;
  for (let intAnalisis = 1; intAnalisis <= 3; intAnalisis++) {
    try {
      analisis = await analizarPortal({ portalUrl, comercioNombre, notas: instrucciones, datosReales });
      analisisErr = null;
      break;
    } catch (err) {
      analisisErr = err;
      console.log(`⚠️ [Orquestador] Análisis intento ${intAnalisis}/3 falló: ${err.message}`);
      if (intAnalisis < 3) await new Promise(r => setTimeout(r, 3000));
    }
  }
  if (analisisErr) {
    await db.query('UPDATE portales_agente SET estado=?, error_msg=? WHERE id=?', ['error', `Análisis: ${analisisErr.message}`, portalId]);
    return { ok: false, etapa: 'analisis', portalId, msg: analisisErr.message };
  }

  await db.query('UPDATE portales_agente SET analisis=?, estado=? WHERE id=?',
    [JSON.stringify(analisis), 'generando', portalId]);
  console.log('✅ [Orquestador] Análisis guardado');

  // ── PASO 2: Generar bot ──────────────────────────────────────────────────────
  console.log('⚙️ [Orquestador] Paso 2: Generando bot...');
  let genResult;
  try {
    genResult = await generarBot({ analisisJson: analisis, nombrePortal: comercioNombre });
  } catch (err) {
    await db.query('UPDATE portales_agente SET estado=?, error_msg=? WHERE id=?', ['error', `Generación: ${err.message}`, portalId]);
    return { ok: false, etapa: 'generacion', portalId, msg: err.message };
  }

  let codigoActual = genResult.codigo;
  await db.query('UPDATE portales_agente SET bot_code=?, nombre_archivo=?, nombre_funcion=?, estado=? WHERE id=?',
    [codigoActual, genResult.nombreArchivo, genResult.nombreFuncion, 'validando', portalId]);
  console.log(`✅ [Orquestador] Bot generado: ${genResult.nombreArchivo}`);

  // ── PASO 3+: Validar → corregir → validar (loop) ────────────────────────────
  let ultimaValidacion = null;
  for (let intento = 0; intento <= MAX_CORRECCIONES; intento++) {
    console.log(`🧪 [Orquestador] Validando (intento ${intento + 1}/${MAX_CORRECCIONES + 1})...`);

    const validacion = await validarBot({
      codigo: codigoActual,
      nombrePortal: comercioNombre,
      datosTest: process.env.BROWSERLESS_TOKEN ? DATOS_TEST : null,
    });
    ultimaValidacion = validacion;

    await db.query('UPDATE portales_agente SET intentos_correccion=? WHERE id=?', [intento, portalId]);

    console.log(`📊 [Orquestador] Validación: ${validacion.ok ? 'OK' : 'FALLA'} | errores: ${validacion.errores.length} | advertencias: ${validacion.advertencias.length}`);

    if (validacion.ok) {
      await db.query('UPDATE portales_agente SET estado=?, bot_code=? WHERE id=?', ['pendiente_aprobacion', codigoActual, portalId]);
      console.log('✅ [Orquestador] Listo para aprobación');
      return {
        ok: true,
        etapa: 'pendiente_aprobacion',
        portalId,
        msg: `Bot listo para revisión. Errores: 0, advertencias: ${validacion.advertencias.length}. Requiere tu aprobación.`,
        validacion,
        nombreArchivo: genResult.nombreArchivo,
      };
    }

    if (intento >= MAX_CORRECCIONES) break;

    // Corregir y reintentar
    console.log(`🔧 [Orquestador] Corrigiendo (intento ${intento + 1}/${MAX_CORRECCIONES})...`);
    await db.query('UPDATE portales_agente SET estado=? WHERE id=?', ['corrigiendo', portalId]);

    try {
      const corrResult = await corregirBot({
        codigoBot: codigoActual,
        errores: validacion.errores,
        advertencias: validacion.advertencias,
        testLive: validacion.test_live,
        analisisJson: analisis,
        nombrePortal: comercioNombre,
      });
      codigoActual = corrResult.codigo;
      await db.query('UPDATE portales_agente SET bot_code=?, estado=? WHERE id=?', [codigoActual, 'validando', portalId]);
    } catch (err) {
      console.log('⚠️ [Orquestador] Error en corrector:', err.message);
      break;
    }
  }

  // Llegamos aquí porque la última validación NO pasó (ok: false).
  // Si hay errores duros (sintaxis, falta puppeteer, sin module.exports, etc.) el bot
  // NO sirve y no debe ofrecerse para aprobación: lo marcamos 'error'.
  const erroresDuros = (ultimaValidacion && ultimaValidacion.errores) || [];
  if (erroresDuros.length > 0) {
    const detalle = erroresDuros.join('; ');
    await db.query('UPDATE portales_agente SET estado=?, error_msg=?, bot_code=? WHERE id=?',
      ['error', `Validación: ${detalle}`, codigoActual, portalId]);
    console.log(`❌ [Orquestador] Bot inválido — no se ofrece para aprobación. Errores: ${detalle}`);
    return {
      ok: false,
      etapa: 'validacion',
      portalId,
      msg: `El bot generado tiene errores que impiden su uso: ${detalle}`,
      validacion: ultimaValidacion,
    };
  }

  // Solo advertencias (sin errores duros) — pasamos a revisión manual.
  await db.query('UPDATE portales_agente SET estado=?, bot_code=? WHERE id=?', ['pendiente_aprobacion', codigoActual, portalId]);
  return {
    ok: true,
    etapa: 'pendiente_aprobacion',
    portalId,
    msg: 'Bot generado con advertencias. Requiere revisión manual antes de activar.',
    nombreArchivo: genResult.nombreArchivo,
  };
}

// ── Activar bot aprobado: escribe en disco y actualiza portales.json ─────────
async function activarBot({ db, portalId }) {
  const [rows] = await db.query('SELECT * FROM portales_agente WHERE id=? LIMIT 1', [portalId]);
  if (!rows.length) return { ok: false, msg: 'Portal no encontrado' };
  const portal = rows[0];

  // Escribir bot en bots/{slug}.js
  const botPath = path.join(__dirname, '../bots', portal.nombre_archivo || `${portal.comercio}.js`);
  fs.writeFileSync(botPath, portal.bot_code, 'utf8');
  console.log(`💾 [Orquestador] Bot escrito: ${botPath}`);

  // Actualizar portales.json con el nuevo portal
  try {
    const jsonPath = path.join(__dirname, '../portales/portales.json');
    let portalesData = { version: '1.0', actualizado: '', portales: {} };
    if (fs.existsSync(jsonPath)) {
      const raw = fs.readFileSync(jsonPath, 'utf8');
      console.log(`📄 [Orquestador] portales.json leído (${raw.length} bytes)`);
      try {
        portalesData = JSON.parse(raw);
      } catch (parseErr) {
        console.log(`⚠️ [Orquestador] portales.json inválido (${parseErr.message}), se reinicia`);
      }
    } else {
      console.log('📄 [Orquestador] portales.json no existe, se crea nuevo');
    }
    if (!portalesData.portales || typeof portalesData.portales !== 'object') {
      portalesData.portales = {};
    }
    // portales_agente.analisis es una columna de tipo JSON en MySQL, así que
    // mysql2 YA la entrega deserializada como objeto. Hacerle JSON.parse()
    // encima lanza `"[object Object]" is not valid JSON` (el objeto se
    // convierte a string primero) — ese era el origen real del error
    // "No se pudo actualizar portales.json: Unexpected token o in JSON at
    // position 1" del deploy: portales.json NUNCA estuvo corrupto.
    const analisis = parseJsonCol(portal.analisis);

    portalesData.portales[portal.comercio] = {
      nombre: portal.nombre,
      bot: `bots/${portal.nombre_archivo || portal.comercio + '.js'}`,
      estado: 'produccion',
      url_base: portal.portal_url,
      tecnologia: analisis.tecnologia || 'Desconocida',
      stealth: analisis.stealth_recomendado || analisis.tiene_turnstile || false,
      comercios: [portal.nombre],
      deteccion: {
        por_portal_field: portal.comercio,
        por_texto_ocr: [portal.comercio, (portal.nombre || '').toLowerCase()],
        por_comercio: [portal.comercio],
        por_url_qr: [],
      },
      campos_ticket: analisis.campos || [],
      flujo: analisis.pasos || [],
      selectores_clave: analisis.selectores || {},
      datos_fijos: {
        usoCfdi: 'G03 — Gastos en general',
        email_captura: 'buzonfacturas@serviciosga.site',
      },
    };
    portalesData.actualizado = new Date().toISOString().split('T')[0];
    fs.writeFileSync(jsonPath, JSON.stringify(portalesData, null, 2), 'utf8');
    console.log('📝 [Orquestador] portales.json actualizado');
  } catch (e) {
    console.log('⚠️ [Orquestador] No se pudo actualizar portales.json:', e.message);
  }

  await db.query('UPDATE portales_agente SET estado=? WHERE id=?', ['activo', portalId]);
  return { ok: true, comercio: portal.comercio, nombre: portal.nombre, botPath };
}

// ── Restaurar bots activos desde DB al disco al arrancar el servidor ─────────
async function restaurarBotsDinamicos(db) {
  try {
    const [rows] = await db.query(
      "SELECT comercio, nombre, nombre_archivo, bot_code, portal_url, analisis FROM portales_agente WHERE estado='activo' AND bot_code IS NOT NULL"
    );

    if (!rows.length) return;

    // Restaurar archivos .js que falten en disco
    for (const row of rows) {
      const archivo = row.nombre_archivo || `${row.comercio}.js`;
      const botPath = path.join(__dirname, '../bots', archivo);
      if (!fs.existsSync(botPath)) {
        fs.writeFileSync(botPath, row.bot_code, 'utf8');
        console.log(`✅ Bot dinámico restaurado: bots/${archivo}`);
      }
    }

    // Sincronizar portales.json con todos los bots activos
    try {
      const jsonPath = path.join(__dirname, '../portales/portales.json');
      let portalesData = { version: '1.0', actualizado: '', portales: {} };
      if (fs.existsSync(jsonPath)) {
        try { portalesData = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch {}
      }
      if (!portalesData.portales || typeof portalesData.portales !== 'object') portalesData.portales = {};

      let updated = false;
      for (const row of rows) {
        if (portalesData.portales[row.comercio]) continue; // ya existe
        // Mismo caso que en activarBot: la columna es de tipo JSON y mysql2 ya
        // la deserializa. Aquí el bug quedaba silenciado por el catch vacío
        // (analisis={} → portales.json se escribía sin tecnología/campos/flujo).
        const analisis = parseJsonCol(row.analisis);
        portalesData.portales[row.comercio] = {
          nombre: row.nombre,
          bot: `bots/${row.nombre_archivo || row.comercio + '.js'}`,
          estado: 'produccion',
          url_base: row.portal_url,
          tecnologia: analisis.tecnologia || 'Desconocida',
          stealth: analisis.stealth_recomendado || analisis.tiene_turnstile || false,
          comercios: [row.nombre],
          deteccion: {
            por_portal_field: row.comercio,
            por_texto_ocr: [row.comercio, (row.nombre || '').toLowerCase()],
            por_comercio: [row.comercio],
            por_url_qr: [],
          },
          campos_ticket: analisis.campos || [],
          datos_fijos: { usoCfdi: 'G03 — Gastos en general', email_captura: 'buzonfacturas@serviciosga.site' },
        };
        updated = true;
        console.log(`📝 portales.json: agregado ${row.comercio}`);
      }
      if (updated) {
        portalesData.actualizado = new Date().toISOString().split('T')[0];
        fs.writeFileSync(jsonPath, JSON.stringify(portalesData, null, 2), 'utf8');
        console.log('✅ portales.json sincronizado con bots activos');
      }
    } catch (e) {
      console.log('⚠️ restaurarBotsDinamicos — portales.json:', e.message);
    }
  } catch (e) {
    console.log('⚠️ restaurarBotsDinamicos:', e.message);
  }
}

module.exports = { orquestar, activarBot, restaurarBotsDinamicos };
