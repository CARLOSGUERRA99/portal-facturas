/**
 * RECONOCIMIENTO de https://facturacion.prb.com.mx:444/ (ticket #364, KFC El
 * Refugio, referencia 0593101192624086, $199, 28/08/2026).
 *
 * El portal estuvo en MANTENIMIENTO mucho tiempo: aqui se comprueba si volvio.
 * La pagina de fuera esta vacia y mete el formulario real en un <iframe> que
 * apunta a /index.jsp — hay que entrar al frame.
 *
 * ⛔ NO FACTURA: solo inventaria pantallas y selectores.
 *
 * Uso: node scripts/probe-prb-kfc.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// El WebSocket de Browserless a veces emite un ErrorEvent suelto; sin estos
// dos handlers Node aborta el proceso entero antes de imprimir nada.
process.on('unhandledRejection', (e) => console.log('  unhandledRejection:', (e && e.message) || String(e)));
process.on('uncaughtException', (e) => console.log('  uncaughtException:', (e && e.message) || String(e)));

const conectar = async () => {
  for (let i = 1; i <= 6; i++) {
    try {
      return await puppeteer.connect({
        browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}&stealth=true`,
      });
    } catch (e) {
      console.log(`  intento ${i}/6 fallo (${e.message}); espero 20s...`);
      await new Promise((r) => setTimeout(r, 20000));
    }
  }
  throw new Error('Browserless no acepta sesiones (429) tras 6 intentos');
};

(async () => {
  const browser = await conectar();
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
  page.on('dialog', async (d) => { console.log('  dialog:', d.message()); await d.accept().catch(() => {}); });
  page.on('console', (m) => console.log('  console:', m.text().slice(0, 160)));
  page.on('error', (e) => console.log('  page error:', e.message));
  page.on('pageerror', (e) => console.log('  pageerror:', e.message));
  page.on('requestfailed', (r) => console.log('  requestfailed:', r.url().slice(0, 110), r.failure() && r.failure().errorText));

  const volcar = async (ctx, etq) => {
    const d = await ctx.evaluate(() => {
      const vis = (e) => e.offsetParent !== null;
      return {
        url: location.href,
        title: document.title,
        campos: Array.from(document.querySelectorAll('input,select,textarea')).map((e) => ({
          tag: e.tagName, id: e.id || null, name: e.name || null, type: e.type || null,
          ph: e.placeholder || null, vis: vis(e),
          opts: e.tagName === 'SELECT' ? e.options.length : undefined,
          primeras: e.tagName === 'SELECT'
            ? Array.from(e.options).slice(0, 8).map((o) => `${o.value}|${o.textContent.trim()}`) : undefined,
        })),
        botones: Array.from(document.querySelectorAll('button,a,input[type=submit],input[type=button]')).map((b) => ({
          tag: b.tagName, id: b.id || null, cls: (b.className || '').toString().slice(0, 40),
          text: (b.textContent || b.value || '').replace(/\s+/g, ' ').trim().slice(0, 50),
          onclick: (b.getAttribute('onclick') || '').slice(0, 90), href: b.getAttribute('href') || null, vis: vis(b),
        })).filter((b) => b.text || b.id),
        txt: (document.body.innerText || '').replace(/\n{2,}/g, '\n').slice(0, 2000),
        emails: (document.body.innerText.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi) || []).slice(0, 5),
        htmlLen: document.documentElement.outerHTML.length,
      };
    }).catch((e) => ({ err: e.message }));
    console.log(`\n═══════ ${etq} ═══════`);
    console.log(JSON.stringify(d, null, 1));
  };

  try {
    console.log('1. Abriendo https://facturacion.prb.com.mx:444/ ...');
    const resp = await page.goto('https://facturacion.prb.com.mx:444/', { waitUntil: 'networkidle2', timeout: 60000 });
    console.log('   HTTP', resp && resp.status());
    await sleep(9000);
    await volcar(page, 'PAGINA EXTERIOR');

    const frames = page.frames();
    console.log('\n2. Frames:', frames.map((f) => f.url()));
    for (const f of frames) {
      if (f === page.mainFrame()) continue;
      await volcar(f, `IFRAME ${f.url()}`);
    }

    // Por si el iframe carga solo al abrirlo directo.
    console.log('\n3. Abriendo /index.jsp directamente...');
    await page.goto('https://facturacion.prb.com.mx:444/index.jsp', { waitUntil: 'networkidle2', timeout: 60000 }).catch((e) => console.log('   ', e.message));
    await sleep(8000);
    await volcar(page, 'index.jsp DIRECTO');

    const b = await page.screenshot({ fullPage: true }).catch(() => null);
    if (b) console.log('📸', await subirArchivoR2(b, `debug/prb_indexjsp_${Date.now()}.png`, 'image/png'));

    // El JS del portal dice que pantallas hay.
    console.log('\n4. scripts_20220106.js — pistas del flujo:');
    const js = await page.evaluate(async () => {
      try { const r = await fetch('/scripts_20220106.js'); return (await r.text()).slice(0, 4000); } catch (e) { return 'ERR ' + e.message; }
    });
    console.log(js);

    await browser.close().catch(() => {});
    process.exit(0);
  } catch (e) {
    console.error('❌', e.message);
    await browser.close().catch(() => {});
    process.exit(1);
  }
})();
