const fs = require('fs');
const path = require('path');
const { analizarPortal } = require('./analizador');
const { generarBot, nombreArchivoDesde } = require('./generador');
const { validarBot } = require('./validador');
const { corregirBot } = require('./corrector');

const MAX_CORRECCIONES = 5;

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

// ── Orquestar: analizar → generar → validar → [corregir×N] → pendiente_aprobacion ──────────
async function orquestar({ db, ticketId, portalUrl, comercioNombre, instrucciones = '' }) {
  const slug = slugify(comercioNombre);
  console.log(`🎯 [Orquestador] Iniciando: ${slug} (${comercioNombre})`);

  // Crear o recuperar registro en portales_agente
  let [rows] = await db.query('SELECT id FROM portales_agente WHERE comercio = ? LIMIT 1', [slug]);
  let portalId;

  if (rows.length) {
    portalId = rows[0].id;
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

  // ── PASO 1: Analizar portal (hasta 3 intentos) ──────────────────────────────
  console.log('📡 [Orquestador] Paso 1: Analizando portal...');
  let analisis;
  let analisisErr;
  for (let intAnalisis = 1; intAnalisis <= 3; intAnalisis++) {
    try {
      analisis = await analizarPortal({ portalUrl, comercioNombre, notas: instrucciones });
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
  for (let intento = 0; intento <= MAX_CORRECCIONES; intento++) {
    console.log(`🧪 [Orquestador] Validando (intento ${intento + 1}/${MAX_CORRECCIONES + 1})...`);

    const validacion = await validarBot({
      codigo: codigoActual,
      nombrePortal: comercioNombre,
      datosTest: process.env.BROWSERLESS_TOKEN ? DATOS_TEST : null,
    });

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

  // Llegamos aquí con errores pendientes — igual pasamos a revisión manual
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
    const portalesData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const analisis = portal.analisis ? JSON.parse(portal.analisis) : {};

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
      "SELECT comercio, nombre_archivo, bot_code FROM portales_agente WHERE estado='activo' AND bot_code IS NOT NULL"
    );
    for (const row of rows) {
      const archivo = row.nombre_archivo || `${row.comercio}.js`;
      const botPath = path.join(__dirname, '../bots', archivo);
      if (!fs.existsSync(botPath)) {
        fs.writeFileSync(botPath, row.bot_code, 'utf8');
        console.log(`✅ Bot dinámico restaurado: bots/${archivo}`);
      }
    }
  } catch (e) {
    console.log('⚠️ restaurarBotsDinamicos:', e.message);
  }
}

module.exports = { orquestar, activarBot, restaurarBotsDinamicos };
