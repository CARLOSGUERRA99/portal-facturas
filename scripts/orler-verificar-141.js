require('dotenv').config();
const puppeteer = require('puppeteer');
const API = 'https://apifacturacion.sinaloa.gob.mx';

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  let jwt = null;
  page.on('request', (r) => { const m = r.url().match(/[?&]authorization=([^&]+)/); if (m && !jwt) jwt = decodeURIComponent(m[1]); });
  await page.goto('https://facturacion.sinaloa.gob.mx/login', { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('input[name="user"]', { timeout: 15000 });
  await page.click('input[name="user"]'); await page.keyboard.type(process.env.ORLER_SINALOA_USER, { delay: 25 });
  await page.click('input[name="password"]'); await page.keyboard.type(process.env.ORLER_SINALOA_PASS, { delay: 25 });
  await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find(x => /iniciar|entrar|acceder/i.test(x.textContent || '')); if (b) b.click(); });
  await page.waitForTimeout(6000);
  await browser.close();

  const r = await fetch(`${API}/api/facturas/list/0/60?authorization=${encodeURIComponent(jwt)}`);
  const arr = await r.json();
  const lista = Array.isArray(arr) ? arr : (arr.data || []);
  console.log(`Total facturas: ${lista.length}\n`);
  console.log('=== Facturas timbradas HOY (2026-07-29/30) ===');
  for (const f of lista) {
    const ts = f.fechaTimbrado || '';
    if (!/2026-07-(29|30)/.test(ts)) continue;
    console.log(`folio ${f.folio} | folioTicket ${f.folioTicket} | $${f.total} | ${f.tipoContribucion} | timbrado ${ts} | uuid ${f.uuid}`);
  }
  console.log('\n=== ¿Existe alguna con folioTicket 2860513? ===');
  const m = lista.filter(f => String(f.folioTicket || '').includes('2860513'));
  console.log(m.length ? JSON.stringify(m.map(f => ({ folio: f.folio, folioTicket: f.folioTicket, total: f.total, uuid: f.uuid, fechaTimbrado: f.fechaTimbrado })), null, 2) : '❌ NINGUNA');
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
