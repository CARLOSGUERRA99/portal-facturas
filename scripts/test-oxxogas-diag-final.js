require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

(async () => {
  const ciSession = process.env.OXXOGAS_CI_SESSION;
  const incapSes117 = process.env.OXXOGAS_INCAP_SES_117;
  const incapSes363 = process.env.OXXOGAS_INCAP_SES_363;
  const visidIncap = process.env.OXXOGAS_VISID_INCAP;
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
  console.log('Status:', resp.status());
  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 600));
  console.log('BODY:\n', bodyText);

  const buf = await page.screenshot({ fullPage: true });
  console.log('📸', await subirArchivoR2(buf, `debug/oxxogas_diag_final_${Date.now()}.png`, 'image/png'));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
