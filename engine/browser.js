const puppeteer = require('puppeteer');
const dns = require('dns').promises;

/**
 * Resuelve el IP de un dominio desde Node.js y devuelve un flag de Chrome
 * --host-resolver-rules=MAP *.dominio IP que fuerza a Chrome a usar ese IP.
 * Útil cuando Browserless no puede resolver el dominio pero Railway sí.
 */
async function resolverHostRules(dominio) {
  if (!dominio) return null;
  try {
    const { address } = await dns.lookup(dominio);
    const rule = `MAP *.${dominio} ${address},MAP ${dominio} ${address}`;
    console.log(`[browser] DNS pre-resolved: ${dominio} → ${address}`);
    return `--host-resolver-rules=${rule}`;
  } catch (err) {
    console.warn(`[browser] DNS pre-resolve falló para ${dominio}: ${err.message}`);
    return null;
  }
}

/**
 * Abre un browser y retorna { browser, page }.
 *
 * Modos:
 *   LOCAL_BROWSER=true  → lanza Chrome/Chromium local (para tests sin Browserless)
 *   default             → conecta a Browserless remoto
 *
 * @param {object} config  - config.json del portal
 */
async function abrirBrowser(config = {}) {
  let browser;

  if (process.env.LOCAL_BROWSER === 'true') {
    console.log('[browser] Modo LOCAL — lanzando Chromium local');
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  } else {
    const token = process.env.BROWSERLESS_TOKEN;
    if (!token) throw new Error('BROWSERLESS_TOKEN no configurado');

    // Pre-resolver DNS desde Node.js y pasárselo a Chrome via launch args
    // Browserless v2 acepta ?launch={"args":[...]} en el WebSocket URL
    const extraArgs = [];
    const hostRule = await resolverHostRules(config.dominio);
    if (hostRule) extraArgs.push(hostRule);

    const stealth = config.stealth === true;
    const launchObj = { args: extraArgs };
    const launchParam = extraArgs.length > 0
      ? `&launch=${encodeURIComponent(JSON.stringify(launchObj))}`
      : '';
    const stealthParam = stealth ? '&stealth=true' : '';
    const endpoint = `wss://production-sfo.browserless.io?token=${token}${stealthParam}${launchParam}`;

    console.log(`[browser] Conectando a Browserless (stealth: ${stealth}, hostRules: ${!!hostRule})`);
    browser = await puppeteer.connect({ browserWSEndpoint: endpoint });
  }

  const page = await browser.newPage();
  page.setDefaultTimeout(config.timeout || 30000);
  return { browser, page };
}

module.exports = { abrirBrowser };
