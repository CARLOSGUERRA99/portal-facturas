/**
 * RECONOCIMIENTO (no factura) de:
 *   1) https://facturafranquicias.lossenderos.com.mx/generar-factura   (ticket #350, KFC Central Durango)
 *   2) https://factura.estrellablanca.com.mx                           (para comparar el build)
 *   3) https://facturacion.prb.com.mx:444/                             (ticket #364, KFC El Refugio)
 *
 * Objetivo: confirmar/descartar que lossenderos y estrellablanca son la MISMA
 * plataforma (AMS Integra) y sacar selectores exactos.
 *
 * Uso: node scripts/probe-lossenderos.js [paso]
 *   paso 1 = huella tecnica de los 3 sitios (por defecto)
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SITIOS = [
  { n: 'senderos', url: 'https://facturafranquicias.lossenderos.com.mx/generar-factura' },
  { n: 'estrellablanca', url: 'https://factura.estrellablanca.com.mx' },
  { n: 'prb_kfc', url: 'https://facturacion.prb.com.mx:444/' },
];

async function huella(browser, s) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
  page.on('dialog', async (d) => { console.log(`  [${s.n}] dialog:`, d.message()); await d.accept().catch(() => {}); });

  const net = [];
  page.on('response', (r) => {
    const u = r.url();
    if (/\.(js|css)(\?|$)/i.test(u) || /\/api\//i.test(u)) net.push(`${r.status()} ${u.slice(0, 160)}`);
  });

  console.log(`\n████████ ${s.n} → ${s.url}`);
  try {
    const resp = await page.goto(s.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    console.log('HTTP:', resp ? resp.status() : '?');
  } catch (e) {
    console.log('❌ goto:', e.message);
    await page.close().catch(() => {});
    return;
  }
  await sleep(7000);

  const info = await page.evaluate(() => {
    const vis = (el) => el.offsetParent !== null || el.tagName === 'SELECT';
    const tech = [];
    if (window.__NEXT_DATA__) tech.push('Next.js');
    if (document.querySelector('[ng-version]')) tech.push('Angular ' + document.querySelector('[ng-version]').getAttribute('ng-version'));
    if (window.angular) tech.push('AngularJS');
    if (document.querySelector('#root,#app')) tech.push('React/Vue root(' + (document.querySelector('#root') ? '#root' : '#app') + ')');
    if (window.jQuery) tech.push('jQuery ' + window.jQuery.fn.jquery);
    if (document.querySelector('#__VIEWSTATE')) tech.push('ASP.NET WebForms');
    return {
      loc: location.href,
      title: document.title,
      tech,
      htmlLen: document.documentElement.outerHTML.length,
      headHtml: document.head.innerHTML.replace(/\s+/g, ' ').slice(0, 1500),
      bodyOpen: document.body.innerHTML.replace(/\s+/g, ' ').slice(0, 800),
      scripts: Array.from(document.querySelectorAll('script[src]')).map((x) => x.src),
      css: Array.from(document.querySelectorAll('link[rel=stylesheet]')).map((x) => x.href),
      inputs: Array.from(document.querySelectorAll('input,select,textarea')).map((i) => ({
        tag: i.tagName, type: i.type || null, id: i.id || null, name: i.name || null,
        ph: i.placeholder || null, formcontrol: i.getAttribute('formcontrolname') || null,
        vis: vis(i), opts: i.tagName === 'SELECT' ? i.options.length : undefined,
      })),
      botones: Array.from(document.querySelectorAll('button,a,input[type=submit],input[type=button],[role=button]')).map((b) => ({
        tag: b.tagName, id: b.id || null, cls: (b.className || '').toString().slice(0, 60),
        text: (b.textContent || b.value || '').replace(/\s+/g, ' ').trim().slice(0, 50),
        href: b.getAttribute('href') || null, vis: vis(b),
      })).filter((b) => b.text || b.id),
      txt: (document.body.innerText || '').replace(/\n{2,}/g, '\n').slice(0, 2500),
      emails: (document.body.innerText.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi) || []).slice(0, 5),
      recaptcha: !!(window.grecaptcha || document.querySelector('.g-recaptcha,[data-sitekey],script[src*=recaptcha]')),
      sitekey: (document.querySelector('[data-sitekey]') || {}).dataset?.sitekey || null,
      turnstile: !!document.querySelector('.cf-turnstile,script[src*=turnstile]'),
      iframes: Array.from(document.querySelectorAll('iframe')).map((f) => f.src).slice(0, 10),
    };
  }).catch((e) => ({ err: e.message }));

  console.log(JSON.stringify(info, null, 1));
  console.log('--- red (js/css/api) ---');
  console.log(net.slice(0, 25).join('\n'));

  const buf = await page.screenshot({ fullPage: true }).catch(() => null);
  if (buf) console.log('📸', await subirArchivoR2(buf, `debug/probe_${s.n}_${Date.now()}.png`, 'image/png'));
  await page.close().catch(() => {});
}

(async () => {
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}&stealth=true`,
  });
  for (const s of SITIOS) await huella(browser, s);
  await browser.close().catch(() => {});
  process.exit(0);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
