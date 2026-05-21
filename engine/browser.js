const puppeteer = require('puppeteer');

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
    // Modo local — usa Chromium bundled con puppeteer
    console.log('[browser] Modo LOCAL — lanzando Chromium local');
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  } else {
    const token = process.env.BROWSERLESS_TOKEN;
    if (!token) throw new Error('BROWSERLESS_TOKEN no configurado');
    const stealth = config.stealth === true ? '&stealth=true' : '';
    const endpoint = `wss://production-sfo.browserless.io?token=${token}${stealth}`;
    console.log(`[browser] Conectando a Browserless (stealth: ${config.stealth === true})`);
    browser = await puppeteer.connect({ browserWSEndpoint: endpoint });
  }

  const page = await browser.newPage();
  page.setDefaultTimeout(config.timeout || 30000);
  return { browser, page };
}

module.exports = { abrirBrowser };
