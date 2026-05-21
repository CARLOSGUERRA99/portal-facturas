const path = require('path');
const fs   = require('fs');
const { run } = require('./runner');

const COMMERCE_DIR = path.join(__dirname, '..', 'commerce');

/**
 * facturarConEngine(portal, datos, telemetry?)
 *
 * Carga config.json + selectors.json + flow.json del portal,
 * construye el contexto y ejecuta el runner.
 *
 * @returns RunnerResult:
 *   { ok: true,  xmlUrl, pdfUrl }
 *   { ok: true,  procesandoCorreo: true }
 *   { ok: false, error_code, msg }
 *   null — si el portal no tiene carpeta en commerce/
 */
async function facturarConEngine(portal, datos, telemetry = null) {
  const portalDir = path.join(COMMERCE_DIR, portal);

  if (!fs.existsSync(portalDir)) return null;

  const configPath    = path.join(portalDir, 'config.json');
  const selectorsPath = path.join(portalDir, 'selectors.json');
  const flowPath      = path.join(portalDir, 'flow.json');
  const hooksPath     = path.join(portalDir, 'hooks.js');

  if (!fs.existsSync(flowPath)) return null;

  const config    = JSON.parse(fs.readFileSync(configPath,    'utf8'));
  const selectors = JSON.parse(fs.readFileSync(selectorsPath, 'utf8'));
  const flow      = JSON.parse(fs.readFileSync(flowPath,      'utf8'));
  const hooks     = fs.existsSync(hooksPath) ? hooksPath : null;

  console.log(`⚙️  [engine] Ejecutando portal "${portal}" via flow.json`);

  return await run({ datos, config, selectors, flow, hooksPath: hooks, telemetry });
}

/**
 * tieneEngine(portal) — true si el portal está migrado al engine
 */
function tieneEngine(portal) {
  const flowPath = path.join(COMMERCE_DIR, portal, 'flow.json');
  return fs.existsSync(flowPath);
}

module.exports = { facturarConEngine, tieneEngine };
