// ¿Por qué no hay jQuery/Chosen/Angular en la página? Se listan TODAS las
// peticiones de scripts y su status para ver si el WAF (Incapsula) las bloquea
// desde la IP de Browserless.
require('dotenv').config();
const puppeteer = require('puppeteer');
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const cookies = [{ name: 'ci_sessions', value: process.env.OXXOGAS_CI_SESSION, domain: 'facturacion.oxxogas.com', path: '/' }];
  for (const [n, v] of [['incap_ses_363_3020163', process.env.OXXOGAS_INCAP_SES_363], ['incap_ses_396_3020163', process.env.OXXOGAS_INCAP_SES_396]])
    if (v) cookies.push({ name: n, value: v, domain: '.oxxogas.com', path: '/' });

  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}&stealth=true` });
  const page = await browser.newPage();
  const reqs = [];
  page.on('response', (r) => { const u = r.url(); if (/\.js(\?|$)/i.test(u)) reqs.push({ s: r.status(), u: u.slice(-70) }); });
  page.on('requestfailed', (r) => { if (/\.js(\?|$)/i.test(r.url())) reqs.push({ s: 'FAILED:' + (r.failure()?.errorText || '?'), u: r.url().slice(-70) }); });
  page.on('console', (m) => { if (m.type() === 'error') console.log('   🟥 console:', m.text().slice(0, 120)); });
  await page.setCookie(...cookies);

  await page.goto('https://facturacion.oxxogas.com/facturacion/facturar', { waitUntil: 'networkidle2', timeout: 40000 }).catch(e => console.log('goto:', e.message));
  await dormir(4000);

  console.log('=== SCRIPTS (' + reqs.length + ') ===');
  for (const r of reqs) console.log('  ' + String(r.s).padEnd(22) + r.u);
  const enHtml = await page.evaluate(() => Array.from(document.querySelectorAll('script[src]')).map(s => s.src.slice(-60)));
  console.log('\n=== <script src> EN EL HTML (' + enHtml.length + ') ===');
  for (const s of enHtml) console.log('  ' + s);
  console.log('\nlibs:', JSON.stringify(await page.evaluate(() => ({ jq: !!window.jQuery, ch: !!(window.jQuery && window.jQuery.fn && window.jQuery.fn.chosen), ng: !!window.angular }))));
  await browser.close(); process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
