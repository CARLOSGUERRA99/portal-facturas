/**
 * RECONOCIMIENTO de la plataforma Youbuy (*.youbuy.mx) — Laravel + Vue.
 * Multi-inquilino: cada comercio es un subdominio.
 *
 *   Ticket #358 HEPA Restaurantes  -> facturasheparestaurantes.youbuy.mx
 *                                     folio 160420 · codigo 4QWNNKTP1LT · $2,980
 *   Ticket #365 Comedor Valencia   -> facturasvalencia.youbuy.mx
 *                                     folio 498257 · codigo B7LAPE4ISNI · $330
 *
 * NO TIMBRA. Llega hasta la pantalla anterior a "Guardar y Facturar" y para.
 * Tampoco pulsa "Guardar y Continuar" del paso 1 salvo con YOUBUY_SUBMIT_PASO1=1
 * (ese boton dispara grecaptcha.execute() y POST /clients/update, que reescribe
 * la ficha fiscal del RFC para TODA la plataforma).
 *
 * Uso:  node scripts/probe-youbuy.js [valencia|hepa]
 *
 * ══ LO QUE SE COMPROBO EN VIVO (11-sep-2026) ══════════════════════════════
 * ATAJO: /facturacion/{RFC}/{folio}/{codigo} monta <crear-factura> y lanza
 *   findTicket SOLO por el mounted(). NO lleva reCAPTCHA. Funciona porque el
 *   RFC GPR110128QD8 ya esta dado de alta (client id 4499) y la tabla de
 *   clientes es COMPARTIDA entre inquilinos (mismo id en valencia, hepa y yoko).
 *   Si el RFC NO existe, esa misma URL responde 200 pero pinta <datos-fiscales>
 *   -> detectar el atajo por la presencia de #uso_cfdi, nunca por el status.
 *
 * TRAMPAS (todas pagadas aqui):
 *  1. app.js define un bus global `Event` (Vue) que TAPA el constructor nativo:
 *     `new Event('change')` lanza "Event is not a constructor".
 *     Usar document.createEvent('HTMLEvents').
 *  2. Folio y Codigo COMPARTEN el id "inline-full-name" (duplicado en el
 *     template). querySelector('#inline-full-name') devuelve SIEMPRE el folio.
 *     Indexar: querySelectorAll('#inline-full-name')[0]=folio, [1]=codigo.
 *  3. findTicket devuelve SIEMPRE message:"No se encontro ningun ticket.",
 *     incluso cuando SI lo encuentra. El discriminante es data.ticket !== undefined.
 *  4. #uso_cfdi arranca con selectedIndex -1 y value "" aunque la pantalla
 *     pinte "G03 - Gastos en general.". Si no se elige, onSubmit aborta.
 *  5. Forma de Pago: <select disabled> sin id ni name, lo fija setFormaPago()
 *     desde ticket.payment (cash->01 check->02 transf->03 cardc->04 cardd->28).
 *     NO tocarlo.
 *  6. "Guardar y Facturar" NO timbra: abre un <vue-confirm-dialog>
 *     ("Generar Factura / ¿Esta seguro que desea facturar el ticket?").
 *     El que timbra de verdad es el OK del modal: button.vc-btn (el de Cancelar
 *     es button.vc-btn.left). Es una SPA: no hay navegacion, no esperar una.
 *  7. Las rutas POST exigen CSRF (419 sin X-XSRF-TOKEN). Desde el navegador
 *     axios lo pone solo con la cookie XSRF-TOKEN; desde Node hay que hacerlo
 *     a mano. Todo el flujo debe ir DENTRO de la pagina.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TENANTS = {
  valencia: { base: 'https://facturasvalencia.youbuy.mx', folio: '498257', codigo: 'B7LAPE4ISNI', total: 330 },
  hepa:     { base: 'https://facturasheparestaurantes.youbuy.mx', folio: '160420', codigo: '4QWNNKTP1LT', total: 2980 },
};

const RFC = 'GPR110128QD8';
const RAZON = 'GPN PINTURAS Y RECUBRIMIENTOS';
const REGIMEN = '601';
const CP = '80140';
const CORREO = 'buzonfacturas@serviciosga.site';

const OUT = path.join(__dirname, '..', 'tmp', 'youbuy'); // 'tmp/' esta en .gitignore
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

async function inventario(page, etiqueta) {
  let d;
  try {
    d = await page.evaluate(() => {
      const vis = (e) => e.offsetParent !== null || (e.getClientRects && e.getClientRects().length > 0);
      const campos = Array.from(document.querySelectorAll('input,select,textarea')).map((e) => {
        const o = {
          tag: e.tagName, type: e.type || null, id: e.id || null, name: e.name || null,
          ph: e.placeholder || null, cls: (e.className || '').toString().slice(0, 60) || null,
          val: (e.value || '').slice(0, 40) || null,
          disabled: e.disabled || undefined, readOnly: e.readOnly || undefined,
          visible: vis(e),
        };
        if (e.tagName === 'SELECT') {
          o.nOptions = e.options.length;
          o.options = Array.from(e.options).slice(0, 10).map((x) => x.value + '|' + x.textContent.trim().slice(0, 45));
        }
        try {
          const lf = e.id ? document.querySelector('label[for="' + e.id + '"]') : null;
          const grupo = e.closest('.form-group,.form-item,.field,.col,.col-md-6,.col-md-4,div');
          const lg = grupo ? grupo.querySelector('label') : null;
          o.label = ((lf && lf.textContent) || (lg && lg.textContent) || '').replace(/\s+/g, ' ').trim().slice(0, 45) || null;
        } catch (_) {}
        return o;
      });
      const botones = Array.from(document.querySelectorAll('button,a,input[type=submit],input[type=button],[role=button]')).map((e) => ({
        tag: e.tagName, type: e.type || null, id: e.id || null, cls: (e.className || '').toString().slice(0, 70) || null,
        text: (e.textContent || e.value || '').replace(/\s+/g, ' ').trim().slice(0, 55),
        href: (e.getAttribute && e.getAttribute('href')) || null,
        disabled: e.disabled || undefined, visible: vis(e),
      })).filter((b) => b.text || b.id);
      const captcha = {
        divs: Array.from(document.querySelectorAll('.g-recaptcha,[data-sitekey],[data-callback]')).map((e) => ({
          cls: (e.className || '').toString(), sitekey: e.getAttribute('data-sitekey'),
          callback: e.getAttribute('data-callback'), size: e.getAttribute('data-size'),
          badge: e.getAttribute('data-badge'), id: e.id || null,
        })),
        iframes: Array.from(document.querySelectorAll('iframe')).map((f) => (f.src || '').slice(0, 160)).filter((s) => /recaptcha|turnstile|hcaptcha/i.test(s)),
        scripts: Array.from(document.querySelectorAll('script[src]')).map((s) => s.src).filter((s) => /recaptcha|turnstile|hcaptcha/i.test(s)),
        grecaptchaPresente: typeof window.grecaptcha !== 'undefined',
        callbackRecaptch: typeof window.callbackRecaptch,
        callbackRecaptcha: typeof window.callbackRecaptcha,
        globalesCaptcha: Object.keys(window).filter((k) => /recaptch|captcha/i.test(k)).slice(0, 20),
      };
      return {
        url: location.href, title: document.title,
        texto: (document.body.innerText || '').replace(/\n{2,}/g, '\n').trim().slice(0, 1800),
        campos, botones, captcha,
      };
    });
  } catch (e) {
    console.log('=== ' + etiqueta + ' === (evaluate fallo: ' + e.message + ')');
    return null;
  }
  console.log('\n\n================ ' + etiqueta + ' ================');
  console.log(JSON.stringify(d, null, 1));
  try { fs.writeFileSync(path.join(OUT, etiqueta + '.html'), await page.content()); } catch (_) {}
  try { fs.writeFileSync(path.join(OUT, etiqueta + '.png'), await page.screenshot({ fullPage: true })); } catch (_) {}
  return d;
}

// Teclea de verdad: Vue no se entera de un .value pelado
async function escribir(page, selector, valor, nombre) {
  const el = await page.$(selector);
  if (!el) { console.log('   x ' + nombre + ': NO existe ' + selector); return false; }
  await el.click({ clickCount: 3 }).catch(() => {});
  await page.keyboard.type(String(valor), { delay: 40 }).catch(() => {});
  const leido = await page.evaluate((s) => { const e = document.querySelector(s); return e ? e.value : null; }, selector);
  console.log('   · ' + nombre + ' (' + selector + ') = "' + leido + '"');
  return String(leido).trim() === String(valor).trim();
}

(async () => {
  const which = (process.argv[2] || 'valencia').toLowerCase();
  const T = TENANTS[which] || TENANTS.valencia;
  console.log('Tenant: ' + T.base + ' · folio ' + T.folio + ' · codigo ' + T.codigo + ' · $' + T.total);

  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) { console.error('Falta BROWSERLESS_TOKEN en .env'); process.exit(1); }
  // Browserless devuelve 429 cuando la cuenta ya tiene sesiones abiertas. Sin
  // este try/retry el fallo sale como "UnhandledPromiseRejection: #<ErrorEvent>",
  // que no dice nada.
  let browser = null;
  for (let i = 1; i <= 6 && !browser; i++) {
    try {
      browser = await puppeteer.connect({
        browserWSEndpoint: 'wss://production-sfo.browserless.io?token=' + token + '&stealth=true',
      });
    } catch (e) {
      console.log('   intento ' + i + '/6 de conectar a Browserless fallo: ' + e.message);
      if (i === 6) { console.error('No se pudo conectar a Browserless.'); process.exit(1); }
      await sleep(15000);
    }
  }
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1050 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
  // OBLIGATORIO: un alert() sin manejar cuelga el hilo y Browserless mata la pestana
  page.on('dialog', async (d) => { console.log('DIALOG: ' + d.type() + ' — ' + d.message()); await d.accept().catch(() => {}); });
  page.on('console', (m) => { const t = m.text(); if (/error|fail|recaptch/i.test(t)) console.log('   [console] ' + t.slice(0, 180)); });
  page.on('pageerror', (e) => console.log('   [pageerror] ' + String(e.message).slice(0, 180)));

  const apiLog = [];
  page.on('response', async (res) => {
    const u = res.url();
    const req = res.request();
    if (/\.(js|css|png|jpg|jpeg|svg|woff2?|ico)(\?|$)/i.test(u)) return;
    if (req.method() === 'GET' && !/clients|factur|ticket|catalog|regim|uso|rfc/i.test(u)) return;
    let body = null;
    try { body = (await res.text()).slice(0, 1500); } catch (_) {}
    const reg = { m: req.method(), url: u.replace(T.base, ''), status: res.status(), postData: (req.postData() || '').slice(0, 400), body: body };
    apiLog.push(reg);
    console.log('   -> ' + reg.m + ' ' + reg.url + ' HTTP ' + reg.status + (reg.postData ? ' | POST ' + reg.postData : ''));
    if (body && !/^\s*<!DOCTYPE|^\s*<html/i.test(body)) console.log('      body: ' + body.replace(/\s+/g, ' ').slice(0, 700));
  });

  try {
    console.log('\n>> 1. Abriendo la portada del tenant...');
    const r = await page.goto(T.base, { waitUntil: 'networkidle2', timeout: 60000 });
    console.log('   HTTP ' + r.status() + ' · URL final: ' + page.url());
    await sleep(3000);
    await inventario(page, '01_portada');

    console.log('\n>> 2. Rastreando sitekey / rutas / componentes en el HTML y en app.js...');
    const rastro = await page.evaluate(async () => {
      const out = { enHtml: [], scriptsInline: [], srcs: [], appJs: null, hallazgos: {} };
      const html = document.documentElement.outerHTML;
      const k = html.match(/6L[\w-]{38}/g);
      out.enHtml = k ? Array.from(new Set(k)) : [];
      out.scriptsInline = Array.from(document.querySelectorAll('script:not([src])'))
        .map((s) => s.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean).map((s) => s.slice(0, 1200));
      out.srcs = Array.from(document.querySelectorAll('script[src]')).map((s) => s.src);
      const appUrl = out.srcs.find((s) => /app\.js/i.test(s));
      if (appUrl) {
        try {
          const txt = await fetch(appUrl).then((x) => x.text());
          out.appJs = { url: appUrl, bytes: txt.length };
          const sk = txt.match(/6L[\w-]{38}/g);
          out.hallazgos.sitekeysEnBundle = sk ? Array.from(new Set(sk)) : [];
          const rutas = txt.match(/["'`]\/[a-zA-Z0-9_\-\/{}.$]{3,60}["'`]/g) || [];
          out.hallazgos.rutas = Array.from(new Set(rutas.map((x) => x.slice(1, -1))))
            .filter((x) => /client|factur|ticket|rfc|regim|uso|cfdi|catalog/i.test(x)).slice(0, 40);
          out.hallazgos.callbacks = Array.from(new Set(txt.match(/callbackRecaptch\w*/g) || []));
          const extrae = (re, n) => { const i = txt.search(re); return i < 0 ? null : txt.slice(Math.max(0, i - 250), i + n); };
          out.hallazgos.extractoFindTicket = extrae(/findTicket/, 800);
          out.hallazgos.extractoCreate = extrae(/facturacion\/create/, 800);
          out.hallazgos.extractoClientsRfc = extrae(/clients\/rfc/, 500);
        } catch (e) { out.appJs = { url: appUrl, error: e.message }; }
      }
      return out;
    }).catch((e) => ({ error: e.message }));
    console.log(JSON.stringify(rastro, null, 1).slice(0, 12000));
    fs.writeFileSync(path.join(OUT, '02_rastro_' + which + '.json'), JSON.stringify(rastro, null, 1));

    const URL_DIRECTA = T.base + '/facturacion/' + RFC + '/' + T.folio + '/' + T.codigo;
    console.log('\n>> 3. Probando el atajo directo ' + URL_DIRECTA + ' ...');
    try {
      const r3 = await page.goto(URL_DIRECTA, { waitUntil: 'networkidle2', timeout: 60000 });
      console.log('   HTTP ' + r3.status() + ' · URL final: ' + page.url());
    } catch (e) { console.log('   goto fallo: ' + e.message); }
    await sleep(3000);
    await inventario(page, '03_atajo_directo');

    console.log('\n>> 4. Volviendo a la portada para rellenar DATOS FISCALES...');
    await page.goto(T.base, { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(3000);

    const selRfc = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('input')).filter((e) => e.offsetParent);
      const m = els.find((e) => /rfc/i.test(e.id + ' ' + e.name + ' ' + e.placeholder + ' ' + ((e.closest('div') || {}).innerText || '')));
      if (!m) return null;
      return m.id ? '#' + m.id : (m.name ? 'input[name="' + m.name + '"]' : null);
    });
    console.log('   selector RFC detectado: ' + selRfc);
    if (selRfc) {
      await escribir(page, selRfc, RFC, 'RFC');
      const pulsado = await page.evaluate(() => {
        const b = Array.from(document.querySelectorAll('button,a,input[type=submit],.btn'))
          .filter((e) => e.offsetParent && !e.disabled)
          .find((e) => /^\s*buscar\s*$/i.test((e.textContent || e.value || '').trim()));
        if (b) { b.click(); return (b.textContent || b.value || '').trim(); }
        return null;
      });
      console.log('   boton Buscar pulsado: ' + pulsado);
      await sleep(5000);
      await inventario(page, '04_tras_buscar_rfc');
    }

    const mapa = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('input,select,textarea')).filter((e) => e.offsetParent && e.type !== 'hidden');
      const sel = (e) => e.id ? '#' + e.id : (e.name ? e.tagName.toLowerCase() + '[name="' + e.name + '"]' : null);
      const ctx = (e) => e.id + ' ' + e.name + ' ' + (e.placeholder || '') + ' ' + ((e.closest('.form-group,.col,.col-md-6,div') || {}).innerText || '');
      const out = {};
      for (const e of els) {
        const c = ctx(e); const s = sel(e); if (!s) continue;
        if (!out.rfc && /rfc/i.test(c)) out.rfc = s;
        else if (!out.razon && /raz[oó]n|nombre|social/i.test(c)) out.razon = s;
        else if (!out.regimen && /r[eé]gimen|regimen/i.test(c)) out.regimen = s;
        else if (!out.cp && /postal|c\.?p\.?/i.test(c)) out.cp = s;
        else if (!out.correo && /correo|email|e-?mail/i.test(c)) out.correo = s;
        else if (!out.folio && /folio/i.test(c)) out.folio = s;
        else if (!out.codigo && /c[oó]digo(?!.*postal)/i.test(c)) out.codigo = s;
      }
      return out;
    });
    console.log('   mapa de selectores del paso 1: ' + JSON.stringify(mapa));

    if (mapa.razon) await escribir(page, mapa.razon, RAZON, 'Razon Social');
    if (mapa.cp) await escribir(page, mapa.cp, CP, 'CP');
    if (mapa.correo) await escribir(page, mapa.correo, CORREO, 'Correo');
    if (mapa.folio) await escribir(page, mapa.folio, T.folio, 'Folio');
    if (mapa.codigo) await escribir(page, mapa.codigo, T.codigo, 'Codigo');
    if (mapa.regimen) {
      const rg = await page.evaluate((s, v) => {
        const e = document.querySelector(s);
        if (!e) return 'no existe';
        if (e.tagName !== 'SELECT') return 'no es select (' + e.tagName + ')';
        const o = Array.from(e.options).find((x) => new RegExp('^' + v + '\\b').test(String(x.value)) || new RegExp('^' + v + '\\b').test(x.textContent.trim()));
        if (!o) return 'sin opcion ' + v + ' — opciones: ' + Array.from(e.options).map((x) => x.value + '|' + x.textContent.trim()).slice(0, 30).join(' / ');
        e.value = o.value;
        // TRAMPA: app.js define un bus global `Event` (Vue) que TAPA el
        // constructor nativo -> new Event('input') lanza "Event is not a
        // constructor". Hay que usar document.createEvent.
        var ev = function (t) { var x = document.createEvent('HTMLEvents'); x.initEvent(t, true, false); return x; };
        e.dispatchEvent(ev('input'));
        e.dispatchEvent(ev('change'));
        return 'elegido ' + o.value + ' — ' + o.textContent.trim();
      }, mapa.regimen, REGIMEN);
      console.log('   · Regimen (' + mapa.regimen + '): ' + rg);
    }

    await inventario(page, '05_paso1_relleno');

    // "Guardar y Continuar" NO se pulsa por defecto: dispara grecaptcha.execute()
    // (reCAPTCHA v2 invisible) y hace POST /clients/update, que sobrescribe la
    // ficha fiscal del RFC en el portal. Se activa con YOUBUY_SUBMIT_PASO1=1.
    const ENVIAR_PASO1 = process.env.YOUBUY_SUBMIT_PASO1 === '1';
    console.log('\n>> 5. Boton "Guardar y Continuar" (solo se pulsa si YOUBUY_SUBMIT_PASO1=1)...');
    const btnInfo = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button,a,input[type=submit],.btn'))
        .filter((e) => e.offsetParent)
        .find((e) => /guardar\s*y\s*continuar|continuar/i.test(e.textContent || e.value || ''));
      return b ? { tag: b.tagName, id: b.id || null, cls: (b.className || '').toString(), text: (b.textContent || b.value || '').trim(), type: b.type || null, disabled: b.disabled } : null;
    });
    console.log('   boton: ' + JSON.stringify(btnInfo));
    if (btnInfo && !ENVIAR_PASO1) console.log('   (no se pulsa: dispara grecaptcha.execute() y POST /clients/update)');
    if (btnInfo && ENVIAR_PASO1) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 45000 }).catch(() => {}),
        page.evaluate(() => {
          const b = Array.from(document.querySelectorAll('button,a,input[type=submit],.btn'))
            .filter((e) => e.offsetParent)
            .find((e) => /guardar\s*y\s*continuar|continuar/i.test(e.textContent || e.value || ''));
          if (b) b.click();
        }),
      ]);
      await sleep(10000);
      await inventario(page, '06_tras_guardar_continuar');
    }

    console.log('\n>> 6. Paso 2 — buscar el ticket (folio + codigo). NO se pulsara Facturar.');
    if (!/\/facturacion\//i.test(page.url())) {
      console.log('   no estamos en /facturacion/ (' + page.url() + ') — navegando a la URL canonica');
      await page.goto(URL_DIRECTA, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
      await sleep(3000);
      await inventario(page, '07_url_canonica');
    }

    // TRAMPA: los inputs de Folio y Codigo COMPARTEN el id "inline-full-name"
    // (esta duplicado en el template). document.querySelector('#inline-full-name')
    // siempre devuelve el de FOLIO. Hay que indexar:
    //    [0] = Folio del Ticket      [1] = Codigo de Facturacion
    // Entre los dos hay ademas un <input type="hidden"> con el RFC (sin id ni name).
    const SEL_FOLIO = '#inline-full-name';           // ...[0]
    const SEL_CODIGO = '#inline-full-name';          // ...[1]
    const hayForm = await page.$('#uso_cfdi');
    console.log('   <crear-factura> montado: ' + !!hayForm + ' (si es false, el RFC no esta dado de alta y el portal cae al form de datos fiscales)');

    // Se reescriben tecleando de verdad para comprobar que Vue se entera
    const reescribir = async (indice, valor, nombre) => {
      const el = (await page.$$(SEL_FOLIO))[indice];
      if (!el) { console.log('   x ' + nombre + ': no existe #inline-full-name[' + indice + ']'); return; }
      await el.click({ clickCount: 3 });
      await page.keyboard.press('Backspace');
      await page.keyboard.type(String(valor), { delay: 40 });
      const st = await page.evaluate((i) => {
        const e = document.querySelectorAll('#inline-full-name')[i];
        const app = document.querySelector('#app');
        const vm = app && app.__vue__ ? (app.__vue__.$children || [])[0] : null;
        return { dom: e.value, vueFolio: vm && vm.form ? vm.form.folio : null, vueCodigo: vm && vm.form ? vm.form.codigo : null };
      }, indice);
      console.log('   · ' + nombre + ' [' + indice + '] dom="' + st.dom + '" vue.folio="' + st.vueFolio + '" vue.codigo="' + st.vueCodigo + '"');
    };
    if (hayForm) {
      await reescribir(0, T.folio, 'Folio del Ticket');
      await reescribir(1, T.codigo, 'Codigo de Facturacion');
    }

    const pulsoTicket = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button,a,input[type=submit],.btn'))
        .filter((e) => e.offsetParent && !e.disabled)
        .find((e) => /buscar\s*ticket|^\s*buscar\s*$/i.test((e.textContent || e.value || '').trim()));
      if (b) { b.click(); return (b.textContent || b.value || '').trim(); }
      return null;
    });
    console.log('   boton Buscar Ticket pulsado: ' + pulsoTicket);
    await sleep(9000);
    await inventario(page, '08_ticket_encontrado');

    // Uso CFDI: el select PINTA "G03 - Gastos en general." pero form.uso_cfdi === ""
    // hasta que alguien lo elige de verdad. onSubmit aborta con un toast si va vacio.
    const usoAntes = await page.evaluate(() => {
      const app = document.querySelector('#app');
      const vm = app && app.__vue__ ? (app.__vue__.$children || [])[0] : null;
      const s = document.querySelector('#uso_cfdi');
      return { domValue: s ? s.value : null, domSelectedIndex: s ? s.selectedIndex : null, vueUso: vm && vm.form ? vm.form.uso_cfdi : null };
    }).catch(() => null);
    console.log('   Uso CFDI ANTES de tocarlo: ' + JSON.stringify(usoAntes));
    const usoDespues = await page.evaluate(() => {
      const s = document.querySelector('#uso_cfdi');
      if (!s) return null;
      s.value = 'G03';
      // TRAMPA: app.js define un bus global `Event` (Vue) que TAPA el constructor
      // nativo -> new Event('change') lanza "Event is not a constructor".
      const ev = document.createEvent('HTMLEvents'); ev.initEvent('change', true, false);
      s.dispatchEvent(ev);
      const app = document.querySelector('#app');
      const vm = app && app.__vue__ ? (app.__vue__.$children || [])[0] : null;
      return { domValue: s.value, vueUso: vm && vm.form ? vm.form.uso_cfdi : null };
    }).catch((e) => ({ error: e.message }));
    console.log('   Uso CFDI TRAS elegir G03: ' + JSON.stringify(usoDespues));

    console.log('\n>> 7. Inventario del boton FINAL (NO se pulsa):');
    const final = await page.evaluate(() => {
      const cands = Array.from(document.querySelectorAll('button,a,input[type=submit],.btn')).filter((e) => e.offsetParent);
      return cands.filter((e) => /factur|timbr|generar|emitir/i.test(e.textContent || e.value || ''))
        .map((e) => ({
          tag: e.tagName, id: e.id || null, type: e.type || null,
          cls: (e.className || '').toString(),
          text: (e.textContent || e.value || '').replace(/\s+/g, ' ').trim(),
          disabled: e.disabled,
        }));
    });
    console.log(JSON.stringify(final, null, 1));

    // ── 8. Sondeo de la API findTicket (solo LECTURA) desde la propia pagina ──
    //    a) folio inexistente  b) folio bueno + codigo malo  c) el nuestro
    console.log('\n>> 8. Sondeo directo de POST /facturacion/findTicket (solo lectura):');
    const sondeo = await page.evaluate(async (folio, codigo, rfc) => {
      const casos = [
        { etiqueta: 'folio inexistente', folio: '999999999', codigo: codigo, rfc: rfc },
        { etiqueta: 'folio bueno + codigo malo', folio: folio, codigo: 'XXXXXXXXXXX', rfc: rfc },
        { etiqueta: 'sin rfc', folio: folio, codigo: codigo, rfc: '' },
      ];
      const out = [];
      for (const c of casos) {
        try {
          const r = await axios.post('/facturacion/findTicket', { folio: c.folio, codigo: c.codigo, rfc: c.rfc });
          out.push({ caso: c.etiqueta, status: r.status, data: r.data });
        } catch (e) {
          out.push({ caso: c.etiqueta, error: e.message, status: e.response && e.response.status, data: e.response && e.response.data });
        }
      }
      return out;
    }, T.folio, T.codigo, RFC).catch((e) => ({ error: e.message }));
    console.log(JSON.stringify(sondeo, null, 1));

    // ── 9. Los dos inputs comparten id="inline-full-name": comprobar el orden ──
    console.log('\n>> 9. Duplicado de id "inline-full-name" — orden real y estado de Vue:');
    const dup = await page.evaluate(() => {
      const ins = Array.from(document.querySelectorAll('#inline-full-name'));
      const app = document.querySelector('#app');
      const vm = app && app.__vue__ ? (app.__vue__.$children || [])[0] : null;
      return {
        cuantos: ins.length,
        valores: ins.map((e) => e.value),
        querySelectorDevuelve: (document.querySelector('#inline-full-name') || {}).value,
        vueForm: vm && vm.form ? JSON.parse(JSON.stringify(vm.form)) : null,
        vueHasTicket: vm ? vm.hasTicket : null,
        vueTicket: vm && vm.ticket ? JSON.parse(JSON.stringify(vm.ticket)) : null,
        vueBillLimit: vm ? vm.bill_limit : null,
        vueBillLimitDate: vm ? vm.bill_limit_date : null,
      };
    }).catch((e) => ({ error: e.message }));
    console.log(JSON.stringify(dup, null, 1));

    fs.writeFileSync(path.join(OUT, 'apilog_' + which + '.json'), JSON.stringify(apiLog, null, 1));
    console.log('\nArtefactos en ' + OUT);
  } catch (e) {
    console.error('ERROR: ' + e.message + '\n' + e.stack);
    try { await inventario(page, '99_excepcion'); } catch (_) {}
  } finally {
    await browser.close().catch(() => {});
  }
  process.exit(0);
})();
