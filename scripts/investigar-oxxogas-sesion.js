require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  // Visita anónima al login — sin autenticar, solo observar cookies/estructura
  const resp = await page.goto('https://facturacion.oxxogas.com/login', { waitUntil: 'load', timeout: 30000 });
  console.log('Status login GET:', resp.status());

  const cookiesIniciales = await page.cookies();
  console.log('\n=== Cookies tras GET /login (sin autenticar) ===');
  console.log(JSON.stringify(cookiesIniciales.map(c => ({ name: c.name, domain: c.domain, expires: c.expires, httpOnly: c.httpOnly, session: c.session })), null, 2));

  // Buscar el iframe/recaptcha y confirmar en qué endpoint vive el formulario de login
  const formInfo = await page.evaluate(() => {
    const forms = Array.from(document.querySelectorAll('form')).map(f => ({
      action: f.action, method: f.method, id: f.id,
    }));
    const recaptchaIframe = document.querySelector('iframe[src*="recaptcha"]');
    return {
      forms,
      recaptchaSrc: recaptchaIframe ? recaptchaIframe.src : null,
      bodySnippet: document.body.innerText.slice(0, 500),
    };
  });
  console.log('\n=== Formularios + reCAPTCHA ===');
  console.log(JSON.stringify(formInfo, null, 2));

  // Intentar navegar DIRECTO a una URL protegida sin login, para ver si redirige (y a dónde) —
  // esto indica si hay verificación de sesión por cookie o por token en cada request.
  const respProtegida = await page.goto('https://facturacion.oxxogas.com/facturacion/nueva', { waitUntil: 'load', timeout: 20000 }).catch(e => ({ status: () => 'ERROR: ' + e.message }));
  console.log('\nStatus al pedir /facturacion/nueva sin login:', typeof respProtegida.status === 'function' ? respProtegida.status() : respProtegida);
  console.log('URL final (tras posible redirect):', page.url());

  const buf = await page.screenshot({ fullPage: true });
  console.log('📸', await subirArchivoR2(buf, `debug/oxxogas_sesion_${Date.now()}.png`, 'image/png'));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
