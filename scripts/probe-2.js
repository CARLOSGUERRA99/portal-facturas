require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

const PORTALES = [
  { nombre: 'TUFESA_form', url: 'https://ventas.tufesa.com.mx/apw3/tufesa_es/SolicitarFactura.aspx' },
  { nombre: 'KFC_form', url: 'https://facturacion.prb.com.mx:444/' },
];

async function probar(browser, p) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
  try {
    await page.goto(p.url, { waitUntil: 'networkidle2', timeout: 35000 });
    await page.waitForTimeout(3500);
    const buf = await page.screenshot({ fullPage: false });
    const url = await subirArchivoR2(buf, `debug/probe_${p.nombre}_${Date.now()}.png`, 'image/png');
    const info = await page.evaluate(() => {
      const vis = el => el.offsetParent !== null;
      const tech = window.__NEXT_DATA__ ? 'Next.js' : (document.querySelector('[ng-version]') ? 'Angular' : (window.angular ? 'AngularJS' : (window.jQuery ? 'jQuery' : 'HTML/JS/ASP.NET')));
      const inputs = Array.from(document.querySelectorAll('input,select,textarea')).filter(vis).map(i => ({ id: i.id || null, name: i.name || null, ph: i.placeholder || null, type: i.type || null }));
      const botones = Array.from(document.querySelectorAll('button,a,input[type=submit],input[type=button],[role=button],.btn')).filter(vis).map(b => ({ id: b.id || null, text: (b.textContent || b.value || '').trim().slice(0, 30) })).filter(b => b.text);
      const emails = (document.body.innerText.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi) || []).slice(0, 3);
      return { tech, title: document.title, loc: location.href, emails, inputs: inputs.slice(0, 25), botones: botones.slice(0, 25) };
    });
    console.log(`\n████ ${p.nombre} ████  ${info.loc}`);
    console.log('screenshot:', url, '| tech:', info.tech, '| title:', info.title, '| emails:', JSON.stringify(info.emails));
    console.log('INPUTS:', JSON.stringify(info.inputs));
    console.log('BOTONES:', JSON.stringify(info.botones));
  } catch (e) {
    console.log(`\n████ ${p.nombre} ████ ❌`, e.message);
  } finally { await page.close().catch(() => {}); }
}

(async () => {
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}&stealth=true` });
  for (const p of PORTALES) await probar(browser, p);
  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
