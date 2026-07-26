/**
 * Sonda de DOM del portal de Dana (SoftRestaurant variante).
 * Dumpea inputs y botones de la pantalla inicial para sacar selectores reales.
 * Uso: node scripts/probe-dana.js
 */
require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto('https://facturacion.softrestaurant.com/DANACOMIDAMEXICANA', { waitUntil: 'networkidle2', timeout: 35000 });
  await page.waitForTimeout(3500);

  const buf = await page.screenshot({ fullPage: false });
  const url = await subirArchivoR2(buf, `debug/probe_dana_${Date.now()}.png`, 'image/png');
  console.log('screenshot:', url);

  const tech = await page.evaluate(() => {
    if (window.__NEXT_DATA__) return 'Next.js';
    if (document.querySelector('[ng-version]')) return 'Angular ' + document.querySelector('[ng-version]').getAttribute('ng-version');
    if (window.angular) return 'AngularJS';
    if (window.jQuery) return 'jQuery';
    return 'HTML/JS';
  });
  console.log('tech:', tech);

  const dump = await page.evaluate(() => {
    const vis = el => el.offsetParent !== null;
    const inputs = Array.from(document.querySelectorAll('input, select, textarea')).filter(vis).map(i => ({
      tag: i.tagName, type: i.type || null, id: i.id || null, name: i.name || null,
      placeholder: i.placeholder || null, formControl: i.getAttribute('formcontrolname') || null,
    }));
    const botones = Array.from(document.querySelectorAll('button, a, input[type=submit], input[type=button], [role=button], .btn')).filter(vis).map(b => ({
      tag: b.tagName, id: b.id || null, cls: (b.className || '').toString().slice(0, 35),
      text: (b.textContent || b.value || '').trim().slice(0, 35), onclick: b.getAttribute && b.getAttribute('onclick') ? b.getAttribute('onclick').slice(0, 50) : null,
    }));
    return { inputs, botones, titulo: document.title, emails: (document.body.innerText.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi) || []).slice(0, 3) };
  });
  console.log('\n=== TITULO ===', dump.titulo);
  console.log('=== EMAILS ===', dump.emails);
  console.log('\n=== INPUTS ===');
  console.log(JSON.stringify(dump.inputs, null, 2));
  console.log('\n=== BOTONES ===');
  console.log(JSON.stringify(dump.botones, null, 2));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
