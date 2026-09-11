/**
 * probe-facturat.js — RECONOCIMIENTO de https://autofacturat.com.mx/Facturacion<Marca>/
 * (plataforma "Factura-T / DescargaT", Apache Wicket). Caso: ticket #362
 * Church's Chicken, folio 271404, total 330.01 del 07-sep-2026.
 *
 * ESTE SCRIPT NO TIMBRA. Llega hasta la pantalla de previsualizacion y para.
 *    El boton que emite el CFDI es img.boton-chico[title="Generar Factura"]
 *    (behavior ...-form-btnExecute) y aqui NUNCA se pulsa: el paso 4 solo pulsa
 *    el "+" (addImage), que es una CONSULTA, no una emision.
 *
 * -- LO CONFIRMADO EN VIVO (11-sep-2026) -------------------------------------
 *  . /login?0 redirige a /login;jsessionid=XXX?0 — es un login de usuario/clave,
 *    pero NO hace falta cuenta: el <a> "Factura al Instante (sin registro)"
 *    lleva a la pagina publica
 *      /Facturacion<Marca>/wicket/bookmarkable/com.descargat.view.page.QuickCFDiPanel
 *  . NO hay captcha de ningun tipo (ni reCAPTCHA, ni Turnstile, ni de imagen).
 *  . La consulta del ticket exige folio Y total: valida los dos contra su BD.
 *  . Mensajes del servidor (en ul.feedbackPanel):
 *      INFO  "Ticket o Remision encontrada, datos mostrados en pantalla"
 *      ERROR "Monto del ticket Invalido"        (folio bien, total mal)
 *      ERROR "Ticket o Remision no encontrada"  (folio inexistente)
 *  . Tras el "+" el portal PINTA el desglose real (subtotal/IVA/total) — sirve
 *    para cruzar el monto antes de timbrar, que es la regla dura del proyecto.
 *  . El CFDI sale por dos <a> ocultos dentro de <table id="descarga-Docto">
 *    (#ide y #idf, ids generados) que se rellenan DESPUES de timbrar.
 *
 * -- TRAMPAS -----------------------------------------------------------------
 *  . Wicket genera los ids (id2, id7, ida, id10...) y CAMBIAN en cada carga.
 *    Localizar SIEMPRE por el atributo name (queryContainer:txtX), por el
 *    title/alt de la imagen, o por el trozo de behavior del onclick.
 *  . Los botones son <img class="boton-chico"> SIN texto: un clickTexto() por
 *    textContent no los encuentra nunca. Ahi es donde falla bots/facturat.js.
 *  . queryContainer:txtReservationId NO es una reserva: es el campo TOTAL.
 *  . Salta un alert() VACIO al consultar -> page.on('dialog') es obligatorio.
 *
 * Uso: node scripts/probe-facturat.js   (vuelca JSON/PNG/HTML en .probe-facturat/)
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = 'https://autofacturat.com.mx/FacturacionChurchsChicken/';
const OUT = path.join(__dirname, '..', '.probe-facturat');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

async function inventario(page, label) {
  const d = await page.evaluate(() => {
    const lim = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 90);
    const vis = (el) => !!(el.offsetParent !== null || el.getClientRects().length);
    const rotulo = (el) => {
      if (el.id) { try { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l && lim(l.innerText)) return lim(l.innerText); } catch {} }
      const w = el.closest('label'); if (w && lim(w.innerText)) return lim(w.innerText);
      const td = el.closest('td,th'); if (td && td.previousElementSibling && lim(td.previousElementSibling.innerText)) return lim(td.previousElementSibling.innerText);
      let n = el.previousElementSibling; while (n) { if (lim(n.innerText)) return lim(n.innerText); n = n.previousElementSibling; }
      const g = el.closest('.form-group,.row,.field,div,p');
      if (g && lim(g.innerText)) return lim(g.innerText);
      return '';
    };
    const campos = Array.from(document.querySelectorAll('input,select,textarea')).map((e) => ({
      tag: e.tagName.toLowerCase(), type: (e.type || '').toLowerCase(), id: e.id || null,
      name: e.getAttribute('name') || null, ph: e.getAttribute('placeholder') || null,
      aria: e.getAttribute('aria-label') || e.getAttribute('title') || null,
      label: rotulo(e), val: e.value || '', visible: vis(e), ro: !!(e.readOnly || e.disabled),
      nOpts: e.tagName === 'SELECT' ? e.options.length : undefined,
      opts: e.tagName === 'SELECT' ? Array.from(e.options).slice(0, 12).map((o) => `${o.value}|${lim(o.text)}`) : undefined,
    }));
    const botones = Array.from(document.querySelectorAll('a,button,input[type=submit],input[type=button],[onclick]')).filter(vis).map((b) => ({
      tag: b.tagName.toLowerCase(), id: b.id || null, name: b.getAttribute('name') || null,
      cls: (b.className && String(b.className).slice(0, 50)) || null,
      text: lim(b.textContent || b.value), href: b.getAttribute('href') || null,
      onclick: (b.getAttribute('onclick') || '').slice(0, 160) || null,
    })).filter((b) => b.text || b.onclick);
    const forms = Array.from(document.querySelectorAll('form')).map((f) => ({ id: f.id, name: f.getAttribute('name'), action: f.getAttribute('action'), method: f.method }));
    const iframes = Array.from(document.querySelectorAll('iframe')).map((f) => f.src);
    const capt = {
      recaptcha: !!document.querySelector('.g-recaptcha,[data-sitekey],iframe[src*="recaptcha"]'),
      sitekey: (document.querySelector('[data-sitekey]') || {}).dataset ? document.querySelector('[data-sitekey]').dataset.sitekey : null,
      turnstile: !!document.querySelector('.cf-turnstile,iframe[src*="challenges.cloudflare"]'),
      hcaptcha: !!document.querySelector('.h-captcha,iframe[src*="hcaptcha"]'),
      imgCaptcha: Array.from(document.querySelectorAll('img')).filter((i) => /captcha|codigo|valida/i.test(`${i.src} ${i.id} ${i.alt}`)).map((i) => i.src).slice(0, 3),
    };
    return { url: location.href, title: document.title, forms, iframes, capt, campos, botones, txt: lim(document.body.innerText).slice(0, 2500) };
  }).catch((e) => ({ error: e.message }));
  console.log(`\n########## ${label} ##########`);
  console.log(JSON.stringify(d, null, 1));
  fs.writeFileSync(path.join(OUT, `${label}.json`), JSON.stringify(d, null, 1));
  try { await page.screenshot({ path: path.join(OUT, `${label}.png`), fullPage: true }); } catch {}
  return d;
}

async function esperarAjax(page, maxMs = 20000) {
  const t0 = Date.now(); let prev = null, est = 0;
  while (Date.now() - t0 < maxMs) {
    await sleep(600);
    const busy = await page.evaluate(() => {
      try { if (window.Wicket && window.Wicket.Ajax && window.Wicket.Ajax.isBusy) return !!window.Wicket.Ajax.isBusy(); } catch {}
      const i = document.querySelector('.wicket-ajax-indicator,.wicket-ajax-indicator-visible,#ajax-indicator');
      return !!(i && i.offsetParent !== null);
    }).catch(() => false);
    if (busy) { est = 0; continue; }
    const f = await page.evaluate(() => document.body ? `${document.body.innerHTML.length}|${document.body.innerText.slice(0, 2000)}` : '').catch(() => '');
    if (f && f === prev) { est++; if (est >= 2) return; } else { prev = f; est = 0; }
  }
}

(async () => {
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}&stealth=true`,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1100 });
  page.on('dialog', async (d) => { console.log('💬 DIALOG:', d.message()); await d.accept().catch(() => {}); });
  // Captura las respuestas AJAX de Wicket (traen el <ajax-response> con el
  // feedback real del servidor; en pantalla a veces no se ve nada).
  const ajax = [];
  page.on('response', async (res) => {
    const u = res.url();
    if (!/IBehaviorListener|IFormSubmitListener/.test(u)) return;
    let body = '';
    try { body = await res.text(); } catch {}
    ajax.push({ url: u.split('/').pop(), status: res.status(), body });
    console.log(`\n📡 AJAX ${res.status()} ${u.split('?').pop()}`);
    console.log(body.replace(/\s+/g, ' ').slice(0, 4000));
  });
  page.on('console', (m) => { const t = m.text(); if (/error|fail/i.test(t)) console.log('  [console]', t.slice(0, 150)); });

  try {
    console.log('1) Abriendo la URL del ticket:', BASE + 'login?0');
    const r = await page.goto(BASE + 'login?0', { waitUntil: 'networkidle2', timeout: 60000 });
    console.log('   status:', r && r.status(), '| url final:', page.url());
    await esperarAjax(page, 8000);
    await inventario(page, 'p1_login');

    // Los <script> inline suelen traer las funciones Wicket y las URLs de los behaviors
    const scripts = await page.evaluate(() => Array.from(document.querySelectorAll('script'))
      .filter((s) => !s.src).map((s) => s.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean));
    fs.writeFileSync(path.join(OUT, 'p1_scripts.txt'), scripts.join('\n\n---\n\n'));

    // 2) Salida de invitado. El <a> tiene id generado (id2) -> se busca por texto.
    console.log('\n2) Pulsando "Factura al Instante (sin registro)"...');
    const clic = await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 25000 }).catch(() => {}),
      page.evaluate(() => {
        const a = Array.from(document.querySelectorAll('a,button,input[type=submit],input[type=button]'))
          .find((e) => /factura\s*al\s*instante|sin\s*registro/i.test(e.textContent || e.value || ''));
        if (!a) return null;
        a.click();
        return { text: (a.textContent || a.value).trim(), id: a.id, onclick: (a.getAttribute('onclick') || '').slice(0, 300) };
      }),
    ]).then((x) => x[1]);
    console.log('   clic:', JSON.stringify(clic));
    await esperarAjax(page, 20000);
    await inventario(page, 'p2_quick');

    const botonesImg = await page.evaluate(() => Array.from(document.querySelectorAll('img.boton-chico'))
      .map((i) => ({ id: i.id, src: (i.getAttribute('src') || '').split('/').pop(), alt: i.alt || null, title: i.title || null,
                     behavior: (i.getAttribute('onclick') || '').match(/IBehaviorListener\.\d+-([\w-]+)/) || null })));
    console.log('\n--- BOTONES <img> (sin pulsar) ---\n' + JSON.stringify(botonesImg, null, 1));
    fs.writeFileSync(path.join(OUT, 'p2_botones_img.json'), JSON.stringify(botonesImg, null, 1));
    fs.writeFileSync(path.join(OUT, 'p2_texto.txt'), await page.evaluate(() => document.body.innerText));
    fs.writeFileSync(path.join(OUT, 'p2_form.html'), await page.content());

    // ── 3) LLENAR EL FORMULARIO ───────────────────────────────────────────────
    // Se teclea de verdad (click + keyboard.type): poner .value a pelo deja el
    // campo visualmente lleno y el servidor lo recibe vacio.
    const DATOS = {
      'queryContainer:txtTargetName':   'GPN PINTURAS Y RECUBRIMIENTOS',
      'queryContainer:txtTargetRFC':    'GPR110128QD8',
      'queryContainer:txtTargetEmail':  'buzonfacturas@serviciosga.site',
      'queryContainer:zipcodeReceptor': '80140',
      'queryContainer:txtTrackingId':   '271404',
      'queryContainer:txtReservationId':'330.01',
    };
    console.log('\n3) Llenando el formulario...');
    for (const [name, val] of Object.entries(DATOS)) {
      const sel = `[name="${name}"]`;
      const h = await page.$(sel);
      if (!h) { console.log(`   !! no existe ${name}`); continue; }
      await h.click({ clickCount: 3 });
      await page.keyboard.press('Backspace').catch(() => {});
      await page.keyboard.type(val, { delay: 40 });
      const puesto = await page.$eval(sel, (e) => e.value).catch(() => null);
      console.log(`   ${name} = "${val}"  -> el portal dejo "${puesto}"`);
    }
    // Selects: por VALOR de indice (el value es un indice, no la clave SAT)
    for (const [sel, valor, etiq] of [
      ['[name="queryContainer:cfdiusage"]', '2', 'Uso CFDI G03'],
      ['[name="queryContainer:regimenDropDown"]', '0', 'Regimen 601 General de Ley PM'],
    ]) {
      await page.select(sel, valor).catch((e) => console.log('   !! select', e.message));
      await page.evaluate((s) => { const e = document.querySelector(s); if (e) e.dispatchEvent(new Event('change', { bubbles: true })); }, sel).catch(() => {});
      const txt = await page.$eval(sel, (e) => e.options[e.selectedIndex] && e.options[e.selectedIndex].text).catch(() => null);
      console.log(`   ${etiq} -> "${txt}"`);
    }
    await esperarAjax(page, 8000);
    await inventario(page, 'p3_lleno');

    // ── 4) PULSAR SOLO EL "+" (addImage): agrega el ticket a la factura ───────
    // NO es el boton que timbra. El que timbra es title="Generar Factura"
    // (btnExecute) y NO se toca.
    console.log('\n4) Pulsando el "+" (agregar ticket) — NO es el boton que timbra...');
    const masClic = await page.evaluate(() => {
      const img = Array.from(document.querySelectorAll('img.boton-chico'))
        .find((i) => /addImage/.test(i.getAttribute('onclick') || ''));
      if (!img) return null;
      if (/Generar Factura/i.test(img.title || '')) return 'ABORTADO: es el boton de timbrar';
      img.click();
      return { id: img.id, title: img.title || null, src: (img.getAttribute('src') || '').split('/').pop() };
    });
    console.log('   ->', JSON.stringify(masClic));
    await esperarAjax(page, 30000);
    await inventario(page, 'p4_tras_agregar');
    console.log('\n--- TEXTO TRAS AGREGAR ---\n' + await page.evaluate(() => document.body.innerText));
    fs.writeFileSync(path.join(OUT, 'p4_texto.txt'), await page.evaluate(() => document.body.innerText));
    fs.writeFileSync(path.join(OUT, 'p4.html'), await page.content());

    console.log('\n=== ALTO: la siguiente pantalla seria el timbrado. NO se pulsa "Generar Factura". ===');

    // ── 5) EXTRAS SIN RIESGO, en pestana aparte ──────────────────────────────
    //    a) el texto de AYUDA del login (ahi suele venir el plazo)
    //    b) el mensaje exacto cuando el ticket NO cuadra (total equivocado),
    //       que es lo que el bot necesita para distinguir "no encontrado".
    const p2 = await browser.newPage();
    await p2.setViewport({ width: 1400, height: 1100 });
    p2.on('dialog', async (d) => { console.log('💬 DIALOG(p2):', d.message()); await d.accept().catch(() => {}); });
    p2.on('response', async (res) => {
      if (!/IBehaviorListener|IFormSubmitListener/.test(res.url())) return;
      const b = await res.text().catch(() => '');
      const fb = b.match(/<li class="feedbackPanel(\w+)">\s*<span[^>]*>([^<]*)</g);
      if (fb) console.log('   📡 feedback:', fb.join(' || ').replace(/\s+/g, ' '));
    });

    await p2.goto(BASE + 'login?0', { waitUntil: 'networkidle2', timeout: 60000 });
    await esperarAjax(p2, 6000);
    console.log('\n5a) Pulsando el icono de AYUDA del login...');
    await p2.evaluate(() => { const a = document.querySelector('#ayuda') || Array.from(document.querySelectorAll('img')).find((i) => /helpImage/.test(i.getAttribute('onclick') || '')); if (a) a.click(); });
    await esperarAjax(p2, 15000);
    const ayuda = await p2.evaluate(() => document.body.innerText.replace(/\n{2,}/g, '\n').trim());
    console.log('--- TEXTO CON AYUDA ABIERTA ---\n' + ayuda);
    fs.writeFileSync(path.join(OUT, 'p5_ayuda.txt'), ayuda);
    try { await p2.screenshot({ path: path.join(OUT, 'p5_ayuda.png'), fullPage: true }); } catch {}

    console.log('\n5b) Probando el "+" con un TOTAL que no cuadra (para leer el mensaje de error)...');
    await Promise.all([
      p2.waitForNavigation({ waitUntil: 'networkidle2', timeout: 25000 }).catch(() => {}),
      p2.evaluate(() => {
        const a = Array.from(document.querySelectorAll('a')).find((e) => /factura\s*al\s*instante|sin\s*registro/i.test(e.textContent || ''));
        if (a) a.click();
      }),
    ]);
    await esperarAjax(p2, 20000);
    for (const [name, val] of [
      ['queryContainer:txtTargetRFC', 'GPR110128QD8'],
      ['queryContainer:txtTrackingId', '271404'],
      ['queryContainer:txtReservationId', '999.99'],
    ]) {
      const h = await p2.$(`[name="${name}"]`);
      if (!h) continue;
      await h.click({ clickCount: 3 });
      await p2.keyboard.type(val, { delay: 35 });
    }
    await p2.evaluate(() => {
      const img = Array.from(document.querySelectorAll('img.boton-chico')).find((i) => /addImage/.test(i.getAttribute('onclick') || ''));
      if (img && !/Generar Factura/i.test(img.title || '')) img.click();
    });
    await esperarAjax(p2, 25000);
    const malo = await p2.evaluate(() => document.body.innerText.replace(/\n{2,}/g, '\n').trim());
    console.log('--- PANTALLA CON TOTAL EQUIVOCADO (solo la parte util) ---');
    console.log(malo.split('Régimen Simplificado de Confianza').pop().trim());
    fs.writeFileSync(path.join(OUT, 'p5_total_malo.txt'), malo);
  } catch (e) {
    console.error('X', e.message);
  }
  await browser.close();
  process.exit(0);
})();
