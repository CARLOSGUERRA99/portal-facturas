require('dotenv').config();
const puppeteer = require('puppeteer');

(async () => {
  const ciSession = process.env.OXXOGAS_CI_SESSION;
  const incapSes117 = process.env.OXXOGAS_INCAP_SES_117;
  const incapSes363 = process.env.OXXOGAS_INCAP_SES_363;
  const visidIncap = process.env.OXXOGAS_VISID_INCAP;
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1100 });

  const cookies = [{ name: 'ci_sessions', value: ciSession, domain: 'facturacion.oxxogas.com', path: '/' }];
  if (incapSes117) cookies.push({ name: 'incap_ses_117_3020163', value: incapSes117, domain: '.oxxogas.com', path: '/' });
  if (incapSes363) cookies.push({ name: 'incap_ses_363_3020163', value: incapSes363, domain: '.oxxogas.com', path: '/' });
  if (visidIncap) cookies.push({ name: 'visid_incap_3020163', value: visidIncap, domain: '.oxxogas.com', path: '/' });
  await page.setCookie(...cookies);

  await page.goto('https://facturacion.oxxogas.com/', { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForTimeout(2000);
  const facturarHandle = await page.evaluateHandle(() =>
    Array.from(document.querySelectorAll('a')).find(a => a.textContent.trim() === 'ACCEDER A FACTURAR') || null
  );
  await facturarHandle.asElement().click();
  await page.waitForTimeout(3000);

  const trCount = await page.evaluate(() => document.querySelectorAll('tr').length);
  console.log('Cantidad de <tr> en la página:', trCount);

  const trTexts = await page.evaluate(() => Array.from(document.querySelectorAll('tr')).map(tr => tr.textContent.trim().slice(0, 80)));
  console.log('Textos de cada <tr>:', JSON.stringify(trTexts, null, 2));

  // Buscar cualquier elemento (no solo tr) que contenga el folio
  const conFolio = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('*')).find(x => x.children.length < 5 && x.textContent.includes('7540670') && x.tagName !== 'BODY' && x.tagName !== 'HTML');
    return el ? { tag: el.tagName, class: el.className, html: el.outerHTML.slice(0, 500) } : null;
  });
  console.log('\nElemento que contiene el folio 7540670:', JSON.stringify(conFolio, null, 2));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
