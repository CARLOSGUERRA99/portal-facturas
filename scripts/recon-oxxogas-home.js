// Reconocimiento de OXXO GAS entrando POR LA HOME (https://facturacion.oxxogas.com/)
// y pulsando "ACCEDER A FACTURAR", que es exactamente el camino con el que sí
// cerró la única factura real (ticket 02, folio 62703067).
//
// El intento anterior navegaba DIRECTO a /facturacion/facturar y obtenía un
// HTML sin JavaScript. Hay que comprobar si eso era consecuencia de saltarse la
// home (deep link rechazado / redirección a una página degradada) y no un
// bloqueo del WAF como se concluyó.
require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

function cookiesDesdeEnv() {
  const c = [{ name: 'ci_sessions', value: process.env.OXXOGAS_CI_SESSION, domain: 'facturacion.oxxogas.com', path: '/' }];
  for (const [n, v] of [
    ['incap_ses_363_3020163', process.env.OXXOGAS_INCAP_363],
    ['incap_ses_396_3020163', process.env.OXXOGAS_INCAP_396],
    ['incap_ses_397_3020163', process.env.OXXOGAS_INCAP_397],
    ['incap_ses_92_3020163', process.env.OXXOGAS_INCAP_92],
  ]) if (v) c.push({ name: n, value: v, domain: '.oxxogas.com', path: '/' });
  return c;
}

const diag = (page) => page.evaluate(() => ({
  scripts: document.querySelectorAll('script[src]').length,
  inline: document.querySelectorAll('script:not([src])').length,
  jquery: !!window.jQuery,
  chosen: !!(window.jQuery && window.jQuery.fn && window.jQuery.fn.chosen),
  chosenDom: document.querySelectorAll('.chosen-container').length,
  url: location.href,
  rfcOpts: document.querySelector('#rfc') ? document.querySelector('#rfc').options.length : null,
  regOpts: document.querySelector('#regimen_fiscal') ? document.querySelector('#regimen_fiscal').options.length : null,
  usoOpts: document.querySelector('#usocfdi') ? document.querySelector('#usocfdi').options.length : null,
  estOpts: document.querySelector('#estacion') ? document.querySelector('#estacion').options.length : null,
}));

(async () => {
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}&stealth=true`,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 900 });
  page.on('dialog', async (d) => { console.log('🔔', d.message()); await d.accept().catch(() => {}); });
  await page.setCookie(...cookiesDesdeEnv());

  try {
    console.log('1) HOME https://facturacion.oxxogas.com/');
    await page.goto('https://facturacion.oxxogas.com/', { waitUntil: 'networkidle2', timeout: 40000 });
    await dormir(3000);
    console.log('   ', JSON.stringify(await diag(page)));
    const saludo = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 110));
    console.log('   texto:', saludo);

    console.log('2) Click en ACCEDER A FACTURAR (no navegación directa)');
    const h = await page.evaluateHandle(() =>
      Array.from(document.querySelectorAll('a')).find((a) => /acceder a facturar/i.test(a.textContent || '')) || null
    );
    const el = h.asElement();
    if (!el) { console.log('   ❌ no está el enlace'); }
    else {
      await el.click();
      await dormir(6000);
      console.log('   ', JSON.stringify(await diag(page)));
    }

    // Si el RFC ya tiene opciones, probamos si al elegirlo se pueblan los
    // dependientes — esa es la prueba de que el JavaScript SÍ está vivo.
    const tieneRfc = await page.$('#rfc');
    if (tieneRfc) {
      const val = await page.evaluate(() => {
        const o = Array.from(document.querySelector('#rfc').options).find((x) => x.text.toUpperCase().includes('GPR110128QD8'));
        return o ? o.value : null;
      });
      console.log('3) select #rfc → value', val);
      if (val) {
        await page.select('#rfc', val);
        await dormir(5000);
        console.log('   tras elegir RFC:', JSON.stringify(await diag(page)));
      }
    }

    console.log('📸', await subirArchivoR2(await page.screenshot(), `debug/oxxogas_home_recon_${Date.now()}.png`, 'image/png'));
  } catch (e) {
    console.log('❌', e.message);
  }
  await browser.close().catch(() => {});
  process.exit(0);
})();
