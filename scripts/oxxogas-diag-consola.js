require('dotenv').config();
const puppeteer = require('puppeteer');

const [, , estacionId, folio, monto] = process.argv;

(async () => {
  const ciSession = process.env.OXXOGAS_CI_SESSION;
  const incapSes117 = process.env.OXXOGAS_INCAP_SES_117;
  const incapSes363 = process.env.OXXOGAS_INCAP_SES_363;
  const visidIncap = process.env.OXXOGAS_VISID_INCAP;
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1100 });
  page.on('console', m => console.log('CONSOLE:', m.type(), m.text()));
  page.on('pageerror', e => console.log('PAGEERROR:', e.message));
  page.on('requestfailed', r => console.log('REQUESTFAILED:', r.url(), r.failure()?.errorText));

  const cookies = [{ name: 'ci_sessions', value: ciSession, domain: 'facturacion.oxxogas.com', path: '/' }];
  if (incapSes117) cookies.push({ name: 'incap_ses_117_3020163', value: incapSes117, domain: '.oxxogas.com', path: '/' });
  if (incapSes363) cookies.push({ name: 'incap_ses_363_3020163', value: incapSes363, domain: '.oxxogas.com', path: '/' });
  if (visidIncap) cookies.push({ name: 'visid_incap_3020163', value: visidIncap, domain: '.oxxogas.com', path: '/' });
  await page.setCookie(...cookies);

  await page.goto('https://facturacion.oxxogas.com/', { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForTimeout(2500);
  const facturarHandle = await page.evaluateHandle(() =>
    Array.from(document.querySelectorAll('a')).find(a => a.textContent.trim() === 'ACCEDER A FACTURAR') || null
  );
  await facturarHandle.asElement().click();
  await page.waitForTimeout(2500);

  await page.select('#rfc', '2186617');
  await page.waitForTimeout(1200);
  await page.select('#regimen_fiscal', '601');
  await page.waitForTimeout(500);
  await page.select('#usocfdi', 'G03');
  await page.waitForTimeout(500);
  await page.select('#estacion', estacionId);
  await page.waitForTimeout(500);
  const ticketInput = await page.$('#ticket');
  await ticketInput.click({ clickCount: 3 });
  await page.keyboard.type(String(folio), { delay: 30 });
  const montoInput = await page.$('#monto');
  await montoInput.click({ clickCount: 3 });
  await page.keyboard.type(Number(monto).toFixed(2), { delay: 30 });
  await page.waitForTimeout(300);

  // Verificar estructura del botón/form justo antes de click
  const info = await page.evaluate(() => {
    const btn = document.getElementById('agregar_tickets');
    return {
      btnExists: !!btn,
      btnType: btn ? btn.type : null,
      btnDisabled: btn ? btn.disabled : null,
      btnForm: btn && btn.form ? btn.form.id : null,
      formExists: !!document.getElementById('agrega_tickets'),
      ticketValue: document.getElementById('ticket') ? document.getElementById('ticket').value : null,
      montoValue: document.getElementById('monto') ? document.getElementById('monto').value : null,
    };
  });
  console.log('Info antes de click:', JSON.stringify(info, null, 2));

  console.log('➡️ Click...');
  await page.click('#agregar_tickets');
  await page.waitForTimeout(4000);

  const enCarrito = await page.evaluate((folio) => document.body.innerText.includes(String(folio)), folio);
  console.log('¿En carrito?:', enCarrito);

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
