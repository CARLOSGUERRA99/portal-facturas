require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

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
  page.on('dialog', async d => { console.log('🔔 Dialog:', d.message()); await d.accept().catch(() => {}); });

  const cookies = [{ name: 'ci_sessions', value: ciSession, domain: 'facturacion.oxxogas.com', path: '/' }];
  if (incapSes117) cookies.push({ name: 'incap_ses_117_3020163', value: incapSes117, domain: '.oxxogas.com', path: '/' });
  if (incapSes363) cookies.push({ name: 'incap_ses_363_3020163', value: incapSes363, domain: '.oxxogas.com', path: '/' });
  if (visidIncap) cookies.push({ name: 'visid_incap_3020163', value: visidIncap, domain: '.oxxogas.com', path: '/' });
  await page.setCookie(...cookies);

  await page.goto('https://facturacion.oxxogas.com/', { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForTimeout(2000);

  // Enlaces reales dentro del módulo rojo "Facturar"
  const enlaces = await page.evaluate(() => Array.from(document.querySelectorAll('a')).map(a => ({ text: a.textContent.trim(), href: a.href })));
  console.log('ENLACES en el dashboard:', JSON.stringify(enlaces.filter(e => e.text), null, 2));

  const target = enlaces.find(e => /facturar/i.test(e.text) && !/mis facturas/i.test(e.text));
  if (!target) { console.log('❌ No se encontró enlace de Facturar'); await browser.close(); process.exit(1); }
  console.log('➡️ Navegando a:', target.href);
  const resp = await page.goto(target.href, { waitUntil: 'networkidle2', timeout: 25000 });
  console.log('Status:', resp.status(), '| URL final:', page.url());
  await page.waitForTimeout(1500);

  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 2000));
  console.log('BODY:\n', bodyText);

  const inputs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('input,select,textarea,button')).map(el => {
      const r = el.getBoundingClientRect();
      return { tag: el.tagName, id: el.id, name: el.name, type: el.type, placeholder: el.placeholder, texto: (el.textContent||'').trim().slice(0,40), visible: r.width>0 && r.height>0 };
    }).filter(el => el.type !== 'hidden' && el.visible);
  });
  console.log('\n=== CAMPOS visibles ===');
  console.log(JSON.stringify(inputs, null, 2));

  const buf = await page.screenshot({ fullPage: true });
  console.log('📸', await subirArchivoR2(buf, `debug/oxxogas_form_facturar2_${Date.now()}.png`, 'image/png'));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
