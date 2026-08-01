const Mustache = require('mustache');
// Engine templates (flow.json) NO son HTML — deshabilitar escaping de entidades.
// Sin esto, {{url}} convierte https://foo.com/ en https:&#x2F;&#x2F;foo.com&#x2F;
Mustache.escape = String;
const { abrirBrowser } = require('./browser');
const { goto }       = require('./actions/goto');
const { fill }       = require('./actions/fill');
const { click }      = require('./actions/click');
const { waitFor }    = require('./actions/waitFor');
const { screenshot } = require('./actions/screenshot');

const ACTIONS = { goto, fill, click, waitFor, screenshot };

// ─────────────────────────────────────────────
// Logger estructurado: [ENGINE][portal][ticketId] mensaje
// ─────────────────────────────────────────────
function makeLog(portal, ticketId) {
  const prefix = `[ENGINE][${portal}][${ticketId}]`;
  return {
    info:  (msg, data) => console.log(`${prefix} ${msg}`, data !== undefined ? JSON.stringify(data) : ''),
    warn:  (msg, data) => console.warn(`${prefix} ⚠️  ${msg}`, data !== undefined ? JSON.stringify(data) : ''),
    error: (msg, err)  => console.error(`${prefix} ❌ ${msg}`, err?.stack || err?.message || err || ''),
    step:  (i, action, ms) => console.log(`${prefix} [step ${String(i).padStart(2,'0')}] ${action} — ${ms}ms`),
    hook:  (name)      => console.log(`${prefix} [hook] → ${name}()`),
    result:(r)         => console.log(`${prefix} RESULTADO:`, JSON.stringify(r, null, 2)),
  };
}

// ─────────────────────────────────────────────
// buildContext — toda la lógica de fallback vive aquí
// ─────────────────────────────────────────────
function buildContext(datos, config, selectors) {
  const parseFecha = (f) => {
    if (!f) return new Date().toISOString().split('T')[0];
    if (/^\d{4}-\d{2}-\d{2}$/.test(f)) return f;
    const p = f.split(/[\/\-]/);
    if (p.length === 3 && p[2].length === 4)
      return `${p[2]}-${p[1].padStart(2,'0')}-${p[0].padStart(2,'0')}`;
    return f;
  };

  const fechaISO = parseFecha(datos.fecha);
  const [y, m, d] = fechaISO.split('-');
  const fechaDMY = `${d}/${m}/${y}`;
  const totalRaw = parseFloat(datos.total) || 0;

  return {
    ticketId:    String(datos.ticketId || ''),
    portal:      config.id || datos.portal || '',
    url: (datos.portalUrl && config.dominio && datos.portalUrl.includes(config.dominio))
           ? datos.portalUrl
           : (config.url_base || ''),
    rfc:           String(datos.rfc           || ''),
    razonSocial:   String(datos.razonSocial   || ''),
    regimenFiscal: String(datos.regimenFiscal || config.defaults?.regimenFiscal || '626'),
    usoCfdi:       String(datos.usoCfdi       || config.defaults?.usoCfdi       || 'G03'),
    codigoPostal:  String(datos.codigoPostal  || config.defaults?.codigoPostal  || ''),
    email:         String(datos.email         || config.datos_fijos?.email      || ''),
    folio:         String(datos.folio || ''),
    referencia:    String(datos.referencia || datos.folio || ''), // Gasmaz: referencia = folio
    codigoTicket:  String(datos.codigoTicket || ''), // ARCO/BuzonFacturas
    idVenta:       String(datos.idVenta || ''),      // OXXO
    calle:         String(datos.calle     || ''),
    ext:           String(datos.ext       || 'S/N'),
    int:           String(datos.int       || ''),
    colonia:       String(datos.colonia   || ''),
    municipio:     String(datos.municipio || ''),
    estado:        String(datos.estado    || config.defaults?.estado || ''),
    total:        String(datos.total || ''),
    totalDecimal: totalRaw.toFixed(2),
    fecha:        fechaISO,
    fechaDMY,
    selectors,
    config,
  };
}

// ─────────────────────────────────────────────
// validateContext — detecta placeholders vacíos o rotos
// ─────────────────────────────────────────────
function validateContext(flow, context, log) {
  const placeholderRe = /\{\{([^}]+)\}\}/g;
  const warnings = [];

  const checkValue = (template, stepIndex, key) => {
    if (typeof template !== 'string') return;
    let match;
    placeholderRe.lastIndex = 0;
    while ((match = placeholderRe.exec(template)) !== null) {
      const varName = match[1].trim();
      // Resolver ruta de objeto (ej: selectors.rfc → context.selectors.rfc)
      const parts = varName.split('.');
      let val = context;
      for (const p of parts) { val = val?.[p]; }
      if (val === undefined || val === null || val === '') {
        warnings.push(`step[${stepIndex}].${key}: "{{${varName}}}" resuelve vacío`);
      }
    }
  };

  flow.forEach((step, i) => {
    Object.entries(step).forEach(([key, val]) => {
      if (key === 'action') return;
      if (typeof val === 'string') checkValue(val, i, key);
      if (typeof val === 'object' && val !== null) {
        Object.entries(val).forEach(([k, v]) => checkValue(String(v), i, `${key}.${k}`));
      }
    });
  });

  if (warnings.length === 0) {
    log.info('validateContext: todos los placeholders resuelven OK');
  } else {
    warnings.forEach(w => log.warn(`validateContext: ${w}`));
  }
  return warnings;
}

// ─────────────────────────────────────────────
// renderParams — Mustache en todos los valores string del step
// ─────────────────────────────────────────────
function renderParams(params, context) {
  const result = {};
  for (const [key, val] of Object.entries(params)) {
    if (key === 'action') continue;
    if (typeof val === 'string') {
      result[key] = Mustache.render(val, context);
    } else if (Array.isArray(val)) {
      result[key] = val.map(v => typeof v === 'string' ? Mustache.render(v, context) : v);
    } else if (val && typeof val === 'object') {
      result[key] = renderParams(val, context);
    } else {
      result[key] = val;
    }
  }
  return result;
}

// ─────────────────────────────────────────────
// run — ejecuta el flow.json completo
// ─────────────────────────────────────────────
async function run({ datos, config, selectors, flow, hooksPath, telemetry }) {
  const context = buildContext(datos, config, selectors);
  const portalId = config.id || context.portal; // usa config.id (ej. 'ramsa') no datos.portal ('gasmaz')
  const log = makeLog(portalId, context.ticketId);

  const hooks = hooksPath
    ? (() => { try { return require(hooksPath); } catch(e) { log.error('No se pudo cargar hooks.js', e); return {}; } })()
    : {};

  const noop = { log: () => {}, record: () => {} };
  const tel = telemetry || noop;

  // Imprimir contexto y validar placeholders antes de abrir browser
  log.info('buildContext:', {
    portal: context.portal, ticketId: context.ticketId,
    url: context.url, rfc: context.rfc, razonSocial: context.razonSocial,
    regimenFiscal: context.regimenFiscal, usoCfdi: context.usoCfdi,
    folio: context.folio, total: context.total, totalDecimal: context.totalDecimal,
    fecha: context.fecha, email: context.email,
  });
  validateContext(flow, context, log);

  log.info(`Abriendo browser (stealth: ${config.stealth === true})`);
  const { browser, page } = await abrirBrowser(config);
  const t0Flow = Date.now();
  log.info('flow_start', { steps: flow.length });
  tel.log({ event: 'flow_start', ticketId: context.ticketId, portal: context.portal });

  let exitResult = null;

  try {
    for (let i = 0; i < flow.length; i++) {
      const step = flow[i];
      const action = step.action;
      const t0 = Date.now();
      const params = renderParams(step, context);

      // ── exit
      if (action === 'exit') {
        log.info(`[step ${i}] exit`, params.result);
        exitResult = params.result;
        break;
      }

      // ── hook
      if (action === 'hook') {
        log.hook(params.name);
        const fn = hooks[params.name];
        if (typeof fn !== 'function')
          throw new Error(`[hook] "${params.name}" no existe en hooks.js`);
        const hookResult = await fn(page, context, params.params || {});
        log.step(i, `hook:${params.name}`, Date.now() - t0);
        if (hookResult) { exitResult = hookResult; break; }
        continue;
      }

      // ── on
      if (action === 'on') {
        const actual = context[params.value] ?? params.value;
        log.info(`[step ${i}] on — "${params.value}" = "${actual}" === "${params.equals}"? ${actual === params.equals}`);
        if (actual === params.equals) {
          for (const subStep of (params.steps || [])) {
            const subParams = renderParams(subStep, context);
            if (subStep.action === 'exit') {
              log.info(`[step ${i}] on→exit`, subParams.result);
              exitResult = subParams.result;
              break;
            }
            if (subStep.action === 'hook') {
              log.hook(subParams.name);
              const fn = hooks[subParams.name];
              if (typeof fn !== 'function') throw new Error(`[hook] "${subParams.name}" no existe`);
              const r = await fn(page, context, subParams.params || {});
              if (r) { exitResult = r; break; }
            } else {
              const subFn = ACTIONS[subStep.action];
              if (subFn) await subFn(page, subParams, context);
            }
          }
          if (exitResult) break;
        }
        log.step(i, `on:${params.value}=${params.equals}`, Date.now() - t0);
        continue;
      }

      // ── waitForAny
      if (action === 'waitForAny') {
        const { selectors: selectorMap, saveAs, timeout = 15000, retries = 0 } = params;
        const opciones = Object.keys(selectorMap);
        log.info(`[waitForAny] listening... opciones: [${opciones.join(', ')}] timeout: ${timeout}ms`);

        let categoria = null;
        let lastErr;

        for (let attempt = 0; attempt <= retries; attempt++) {
          if (attempt > 0) log.info(`[waitForAny] retry ${attempt}/${retries}`);
          try {
            // Cada selector corre en paralelo. El primero que aparezca gana.
            //
            // ⚠️ Los perdedores se silencian con una promesa que NUNCA resuelve,
            // para que un selector que no aparece no haga perder la carrera al
            // que sí va a aparecer. Eso está bien mientras ALGUNO gane — pero si
            // NINGUNO aparece, todas las ramas quedan colgadas y Promise.race no
            // se resuelve nunca: el proceso se congela para siempre, sin error,
            // sin log y sin dejar rastro. Pasó de verdad con el ticket #181
            // (Estación Fundadores): el bot pulsó Facturar, ni la descarga ni el
            // error aparecieron, y el worker se quedó clavado ahí.
            //
            // Por eso la carrera lleva su PROPIO temporizador: cuando vence,
            // rechaza y el flujo continúa por el camino de error, como debe.
            let cortar;
            const reloj = new Promise((_, rechazar) => {
              cortar = setTimeout(
                () => rechazar(new Error(`[waitForAny] ninguna opción apareció en ${timeout}ms`)),
                timeout + 1000, // un segundo de gracia sobre el de waitForSelector
              );
            });
            try {
              categoria = await Promise.race([
                ...Object.entries(selectorMap).map(([cat, sel]) =>
                  page.waitForSelector(sel, { visible: true, timeout })
                    .then(() => {
                      log.info(`[waitForAny] matched: ${cat} → "${sel}"`);
                      return cat;
                    })
                    .catch(() => new Promise(() => {})) // silenciar perdedores
                ),
                reloj,
              ]);
            } finally {
              clearTimeout(cortar);
            }
            break;
          } catch (err) {
            log.warn(`[waitForAny] timeout en intento ${attempt}`);
            lastErr = err;
          }
        }

        if (!categoria) {
          log.warn(`[waitForAny] timeout — ningún selector apareció en ${timeout}ms × ${retries + 1} intentos`);
          throw new Error(`[waitForAny] Ningún selector apareció: [${opciones.join(', ')}]`);
        }

        if (saveAs) {
          context[saveAs] = categoria;
          log.info(`[waitForAny] "${categoria}" guardado en context.${saveAs}`);
        }
        log.step(i, `waitForAny→${categoria}`, Date.now() - t0);
        tel.log({ event: 'waitForAny_result', categoria, ticketId: context.ticketId });
        continue;
      }

      // ── action estándar
      const fn = ACTIONS[action];
      if (!fn) throw new Error(`[runner] action desconocida: "${action}"`);
      try {
        await fn(page, params, context);
      } catch (actionErr) {
        // Screenshot inmediato al fallar cualquier action
        try {
          const buf = await page.screenshot({ fullPage: false });
          const { subirArchivoR2 } = require('../storage/r2');
          const key = `debug/${portalId}_${context.ticketId}_ERROR_step${i}_${action}_${Date.now()}.png`;
          const url = await subirArchivoR2(buf, key, 'image/png');
          log.error(`Action "${action}" falló en step ${i} — screenshot: ${url}`, actionErr);
        } catch {
          log.error(`Action "${action}" falló en step ${i} (screenshot no disponible)`, actionErr);
        }
        throw actionErr; // propagar para que el catch del flow lo maneje
      }
      log.step(i, action, Date.now() - t0);
      tel.log({ event: 'step_ok', action, durationMs: Date.now() - t0, stepIndex: i });
    }

    await browser.close();
    log.info(`flow_end — total: ${Date.now() - t0Flow}ms`);

    if (exitResult) {
      log.result(exitResult);
      tel.record({ ticketId: context.ticketId, portal: context.portal, resultado: exitResult });
      return exitResult;
    }

    const fallback = { ok: false, error_code: 'desconocido', msg: 'El flow terminó sin resultado explícito' };
    log.result(fallback);
    return fallback;

  } catch (err) {
    log.error(`Error en step — ${err.message}`, err);
    try {
      const buf = await page.screenshot({ fullPage: false });
      const { subirArchivoR2 } = require('../storage/r2');
      const key = `debug/${portalId}_${context.ticketId}_crash_${Date.now()}.png`;
      await subirArchivoR2(buf, key, 'image/png');
      log.info(`Screenshot de crash subido: ${key}`);
    } catch {}

    try { await browser.close(); } catch {}

    const error_code = clasificarError(err.message);
    const result = { ok: false, error_code, msg: err.message };
    log.result(result);
    tel.record({ ticketId: context.ticketId, portal: context.portal, resultado: result, error: err.message });
    tel.log({ event: 'flow_error', error: err.message, error_code, ticketId: context.ticketId });
    return result;
  }
}

function clasificarError(msg = '') {
  const m = msg.toLowerCase();
  if (m.includes('timeout') || m.includes('waiting'))   return 'timeout';
  if (m.includes('captcha') || m.includes('turnstile')) return 'captcha';
  if (m.includes('net::') || m.includes('navigation'))  return 'portal_caido';
  if (m.includes('ya_facturado'))                       return 'ya_facturado';
  if (m.includes('hook'))                               return 'hook_error';
  return 'desconocido';
}

module.exports = { run, buildContext };
