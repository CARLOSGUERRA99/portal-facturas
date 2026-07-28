require('dotenv').config();
const puppeteer = require('puppeteer');

(async () => {
  const ciSession = process.env.OXXOGAS_CI_SESSION;
  const incapSes117 = process.env.OXXOGAS_INCAP_SES_117;
  const incapSes363 = process.env.OXXOGAS_INCAP_SES_363;
  const visidIncap = process.env.OXXOGAS_VISID_INCAP;
  if (!ciSession) { console.error('❌ Falta OXXOGAS_CI_SESSION'); process.exit(1); }

  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  const cookies = [{ name: 'ci_sessions', value: ciSession, domain: 'facturacion.oxxogas.com', path: '/' }];
  if (incapSes117) cookies.push({ name: 'incap_ses_117_3020163', value: incapSes117, domain: '.oxxogas.com', path: '/' });
  if (incapSes363) cookies.push({ name: 'incap_ses_363_3020163', value: incapSes363, domain: '.oxxogas.com', path: '/' });
  if (visidIncap) cookies.push({ name: 'visid_incap_3020163', value: visidIncap, domain: '.oxxogas.com', path: '/' });
  await page.setCookie(...cookies);

  const resp = await page.goto('https://facturacion.oxxogas.com/', { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForTimeout(2500);
  const bodyInicial = await page.evaluate(() => document.body.innerText.slice(0, 200));
  const sesionValida = /Hola/i.test(bodyInicial);
  console.log('Status:', resp.status(), '| ¿Sesión válida?:', sesionValida);
  if (!sesionValida) { console.log('❌ Sesión inválida.'); await browser.close(); process.exit(2); }

  const facturarHandle = await page.evaluateHandle(() =>
    Array.from(document.querySelectorAll('a')).find(a => a.textContent.trim() === 'ACCEDER A FACTURAR') || null
  );
  const facturarEl = facturarHandle.asElement();
  if (!facturarEl) { console.log('❌ No se encontró el enlace Facturar'); await browser.close(); process.exit(2); }
  await facturarEl.click();
  await page.waitForTimeout(2500);

  const matches = await page.evaluate(() => {
    const sel = document.getElementById('estacion');
    return Array.from(sel.options)
      .filter(o => /panchon|nardos/i.test(o.text))
      .map(o => ({ value: o.value, text: o.text }));
  });
  console.log('Estaciones encontradas:', JSON.stringify(matches, null, 2));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
