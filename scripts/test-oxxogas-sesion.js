// Prueba de reutilización de sesión ya autenticada manualmente por el usuario.
// Las cookies se leen SOLO de variables de entorno pasadas inline al ejecutar
// este script (nunca hardcodeadas aquí, nunca escritas a .env ni a ningún
// archivo) — ver el mensaje del usuario para los valores reales.
require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

(async () => {
  const ciSession = process.env.OXXOGAS_CI_SESSION;
  const incapSes396 = process.env.OXXOGAS_INCAP_SES_396;
  const incapSes117 = process.env.OXXOGAS_INCAP_SES_117;
  const incapSes363 = process.env.OXXOGAS_INCAP_SES_363;
  const visidIncap = process.env.OXXOGAS_VISID_INCAP;

  if (!ciSession) { console.error('❌ Falta OXXOGAS_CI_SESSION en el entorno'); process.exit(1); }

  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  const cookies = [
    { name: 'ci_sessions', value: ciSession, domain: 'facturacion.oxxogas.com', path: '/' },
  ];
  if (incapSes396) cookies.push({ name: 'incap_ses_396_3020163', value: incapSes396, domain: '.oxxogas.com', path: '/' });
  if (incapSes117) cookies.push({ name: 'incap_ses_117_3020163', value: incapSes117, domain: '.oxxogas.com', path: '/' });
  if (incapSes363) cookies.push({ name: 'incap_ses_363_3020163', value: incapSes363, domain: '.oxxogas.com', path: '/' });
  if (visidIncap) cookies.push({ name: 'visid_incap_3020163', value: visidIncap, domain: '.oxxogas.com', path: '/' });

  await page.setCookie(...cookies);
  console.log(`🍪 ${cookies.length} cookies inyectadas`);

  const resp = await page.goto('https://facturacion.oxxogas.com/', { waitUntil: 'networkidle2', timeout: 30000 });
  console.log('Status:', resp.status(), '| URL final:', page.url());

  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 1000));
  console.log('BODY:\n', bodyText);

  const esLogin = /iniciar sesi[oó]n/i.test(bodyText) && /contrase/i.test(bodyText);
  console.log('\n¿Sigue pidiendo login?:', esLogin);

  const buf = await page.screenshot({ fullPage: true });
  console.log('📸', await subirArchivoR2(buf, `debug/oxxogas_sesion_test_${Date.now()}.png`, 'image/png'));

  await browser.close();
  process.exit(esLogin ? 1 : 0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
