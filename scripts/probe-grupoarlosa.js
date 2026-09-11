/**
 * RECONOCIMIENTO de https://facturacion.grupoarlosa.mx/ — ticket #367
 * (Carl's Jr Independencia, Torreon; franquicia Grupo Arlosa / STAR LAGUNA SA de CV).
 *
 * ESTE SCRIPT NUNCA TIMBRA.
 *    El wizard tiene 4 pasos y el boton de timbrar NO es un boton propio: es el
 *    MISMO <a href="#next">, cuyo <span id="boton_siguiente"> cambia el texto a
 *    "Facturar" al llegar al paso indice 2 (Vista Previa). Por eso este probe
 *    para en el paso 1 (Datos Personales) y NUNCA pulsa "Siguiente" desde ahi:
 *    ese click dispara users/guardarCuenta + facturacion/generarVistaPrevia, y
 *    el siguiente ya seria facturacion/verificaFactura = timbrado irreversible.
 *
 * Uso:  node scripts/probe-grupoarlosa.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PORTAL = 'https://facturacion.grupoarlosa.mx/';
const OUT = path.join(__dirname, '..', 'tmp', 'arlosa');
try { fs.mkdirSync(OUT, { recursive: true }); } catch {}

// Datos del ticket #367 (leidos del pie del ticket, no del OCR generico)
const T = { serie: 'CJRIND', folio: '1310093', importe: '241.00', fecha: '2026-09-03' };
// Receptor GPN
const R = {
  rfc: 'GPR110128QD8', razon: 'GPN PINTURAS Y RECUBRIMIENTOS',
  regimen: '601', uso: 'G03', cp: '80140', email: 'buzonfacturas@serviciosga.site',
};

async function dump(page, label, { texto = 2500 } = {}) {
  const d = await page.evaluate(() => {
    const vis = (e) => !!(e.offsetParent !== null || e.getClientRects().length);
    return {
      url: location.href,
      pasoActual: (() => { const s = document.querySelector('#div-factura-web .steps li.current a'); return s ? s.textContent.trim() : null; })(),
      botonSiguiente: (() => { const b = document.querySelector('#boton_siguiente'); return b ? b.textContent.trim() : null; })(),
      campos: Array.from(document.querySelectorAll('#div-factura-web input, #div-factura-web select, #div-factura-web textarea')).map((e) => ({
        id: e.id || null, name: e.getAttribute('name') || null, type: e.type, vis: vis(e),
        dis: e.disabled || undefined, val: (e.value || '').slice(0, 45) || null,
        opts: e.tagName === 'SELECT' ? e.options.length : undefined,
        sel: e.tagName === 'SELECT' ? (e.value + '|' + ((e.selectedOptions[0] || {}).text || '')).slice(0, 60) : undefined,
      })),
      visibles: Array.from(document.querySelectorAll('button, a[href^="#"], input[type=submit]')).filter(vis)
        .map((e) => ({ t: e.tagName, id: e.id || null, href: e.getAttribute('href') || null, txt: (e.textContent || e.value || '').trim().replace(/\s+/g, ' ').slice(0, 40) })),
      toasts: Array.from(document.querySelectorAll('.iziToast, .toast, .notify-msg, .alert, #toast-container'))
        .map((e) => (e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 240)).filter(Boolean),
      notify: (() => { const n = document.querySelector('#validation-notification'); return n ? { tipo: n.getAttribute('data-notify-type'), msg: n.getAttribute('data-notify-msg') } : null; })(),
      txt: (document.body.innerText || '').replace(/\n{2,}/g, '\n').slice(0, 3000),
    };
  });
  console.log('\n============== ' + label + ' ==============');
  console.log('URL          :', d.url);
  console.log('PASO ACTUAL  :', d.pasoActual);
  console.log('BOTON NEXT   :', JSON.stringify(d.botonSiguiente));
  console.log('NOTIFY       :', JSON.stringify(d.notify));
  if (d.toasts.length) console.log('TOASTS       :', JSON.stringify(d.toasts, null, 1));
  console.log('--- CAMPOS (wizard) ---');
  d.campos.forEach((c) => console.log('  ', JSON.stringify(c)));
  console.log('--- CLICKABLES VISIBLES ---');
  d.visibles.forEach((b) => console.log('  ', JSON.stringify(b)));
  console.log('--- TEXTO ---');
  console.log(d.txt.slice(0, texto));
  fs.writeFileSync(path.join(OUT, label + '.json'), JSON.stringify(d, null, 1));
  try { fs.writeFileSync(path.join(OUT, label + '.png'), await page.screenshot({ fullPage: true })); } catch (e) { /* noop */ }
  return d;
}

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) { console.error('Falta BROWSERLESS_TOKEN'); process.exit(1); }
  const browser = await puppeteer.connect({ browserWSEndpoint: 'wss://production-sfo.browserless.io?token=' + token + '&stealth=true' });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1200 });
  // Obligatorio: un alert() sin handler cuelga el hilo y Browserless mata la pestana.
  page.on('dialog', async (d) => { console.log('  [dialog]', d.type(), '->', d.message()); await d.accept().catch(() => {}); });

  // Espia de la API: es donde el portal dice de verdad que pasa.
  page.on('response', async (res) => {
    const u = res.url();
    if (!/\/(facturacion|users|mailer|signup)\//.test(u)) return;
    let body = '';
    try { body = (await res.text()).slice(0, 700); } catch (e) { /* noop */ }
    console.log('  <- ' + res.request().method() + ' ' + res.status() + ' ' + u.replace(PORTAL, '/') + '\n      ' + body.replace(/\s+/g, ' '));
  });

  // Teclea de verdad (hay jquery.mask en #tienda, #fecha_ticket y .rfc:
  // poner .value se lo salta y el validador de cliente ve el campo vacio).
  async function teclear(sel, v) {
    await page.evaluate((s) => { const e = document.querySelector(s); if (e) { e.removeAttribute('readonly'); e.value = ''; } }, sel);
    const el = await page.$(sel);
    if (!el) { console.log('  [!] no existe ' + sel); return null; }
    await el.click({ clickCount: 3 }).catch(() => {});
    await page.keyboard.type(String(v), { delay: 70 });
    await page.evaluate((s) => {
      const e = document.querySelector(s);
      ['input', 'keyup', 'change', 'blur'].forEach((ev) => e.dispatchEvent(new Event(ev, { bubbles: true })));
    }, sel);
    await sleep(250);
    const q = await page.$eval(sel, (e) => e.value);
    console.log('  [type] ' + sel + ' = ' + JSON.stringify(q) + (q === String(v) ? '' : '   <-- se pidio ' + JSON.stringify(String(v))));
    return q;
  }

  const clickNext = async (motivo) => {
    console.log('\n>> Siguiente (' + motivo + ')');
    await page.evaluate(() => document.querySelector('.actions a[href="#next"]').click());
  };

  try {
    await page.goto(PORTAL, { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(2500);
    // El modal informativo "CFDI Version 4.0" tapa el formulario: hay que cerrarlo.
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find((x) => /aceptar/i.test(x.textContent || ''));
      if (b) b.click();
    });
    await sleep(1200);
    await dump(page, 'a1_paso1_vacio', { texto: 900 });

    // -- PASO 0 - Datos del Ticket ------------------------------------------
    console.log('\n### PASO 0 - Datos del Ticket');
    await teclear('#tienda', T.serie);
    await teclear('#ticket', T.folio);
    await teclear('#importe', T.importe);
    await teclear('#fecha_ticket', T.fecha);
    await page.keyboard.press('Escape').catch(() => {});   // cierra el datepicker
    await page.evaluate(() => { const h = document.querySelector('h1,h2,body'); if (h) h.click(); }).catch(() => {});
    await sleep(600);
    await dump(page, 'a2_paso1_lleno', { texto: 600 });

    // Dispara facturacion/verificaParametros: SOLO VALIDA el ticket, no timbra.
    await clickNext('valida el ticket via facturacion/verificaParametros');
    await sleep(10000);
    const d1 = await dump(page, 'a3_tras_validar_ticket', { texto: 1600 });

    if (!/datos personales/i.test(d1.pasoActual || '')) {
      console.log('\n[STOP] El portal NO acepto el ticket - se para aqui.');
      await browser.close();
      process.exit(0);
    }

    // -- PASO 1 - Datos Personales ------------------------------------------
    // ORDEN OBLIGATORIO. "Buscar RFC" va PRIMERO: si el RFC no esta en el
    // padron de Arlosa, traerDatos hace $("#register-form")[0].reset() y borra
    // razon social / email / CP / la seleccion de los dos selects. Rellenar
    // antes de pulsarlo es tirar el trabajo.
    console.log('\n### PASO 1 - Datos Personales (RFC del receptor)');
    await teclear('#register-rfc', R.rfc);

    console.log('\n>> Pulsando "Buscar RFC" (#verificarRFC -> facturacion/traerDatos)');
    await page.evaluate(() => document.querySelector('#verificarRFC').click());
    await sleep(8000);
    await dump(page, 'a4_tras_buscar_rfc', { texto: 1200 });

    // Espera a que un <select> tenga catalogo. Los dos se repueblan por fetch
    // asincrono y una respuesta que llega tarde hace innerHTML="" y BORRA la
    // opcion ya elegida: por eso se espera y se relee, nunca se elige a ciegas.
    const esperarOpciones = async (sel, seg = 20) => {
      for (let i = 0; i < seg * 2; i++) {
        const n = await page.$eval(sel, (s) => s.options.length).catch(() => 0);
        if (n > 1) return n;
        await sleep(500);
      }
      return 0;
    };

    // Un solo 'change' en el RFC -> facturacion/get_regimen
    await page.evaluate(() => document.querySelector('#register-rfc').dispatchEvent(new Event('change')));
    const nReg = await esperarOpciones('#regimen');
    const regs = await page.$eval('#regimen', (s) => ({ n: s.options.length, dis: s.disabled, o: Array.from(s.options).map((x) => x.value + '|' + x.text) }));
    console.log('\n#regimen (' + nReg + ') ->', JSON.stringify(regs, null, 1));

    await page.select('#regimen', R.regimen);      // dispara get_uso_CFDI
    const nUso = await esperarOpciones('#uso_cfdi');
    const usos = await page.$eval('#uso_cfdi', (s) => ({ n: s.options.length, dis: s.disabled, o: Array.from(s.options).map((x) => x.value + '|' + x.text) }));
    console.log('#uso_cfdi (' + nUso + ') ->', JSON.stringify(usos, null, 1));
    await page.select('#uso_cfdi', R.uso);
    await sleep(2500);

    if (!(await page.$eval('#razon_social', (e) => e.value))) await teclear('#razon_social', R.razon);
    if (!(await page.$eval('#email', (e) => e.value))) await teclear('#email', R.email);
    if (!(await page.$eval('#codigo_postal', (e) => e.value))) await teclear('#codigo_postal', R.cp);

    // Relectura final: si una respuesta tardia borro la seleccion, se reelige.
    for (const [sel, v] of [['#regimen', R.regimen], ['#uso_cfdi', R.uso]]) {
      let cur = await page.$eval(sel, (e) => e.value);
      if (cur !== v) {
        console.log('  [!] ' + sel + ' se quedo en ' + JSON.stringify(cur) + ' - se reelige');
        await esperarOpciones(sel);
        await page.select(sel, v).catch(() => {});
        await sleep(2000);
        cur = await page.$eval(sel, (e) => e.value);
      }
      console.log('  [ok] ' + sel + ' = ' + JSON.stringify(cur));
    }

    await dump(page, 'a5_paso2_lleno', { texto: 1200 });

    // Validacion de cliente SIN avanzar de paso: jQuery.validate es local, no
    // manda nada al servidor. Dice si "Siguiente" pasaria el filtro.
    const validacion = await page.evaluate(() => {
      const f = window.jQuery('#register-form');
      f.validate().settings.ignore = ':disabled,:hidden';
      const ok = f.valid();
      return { valid: ok, errores: Array.from(document.querySelectorAll('#register-form .validation-message')).map((e) => (e.textContent || '').trim()).filter(Boolean) };
    }).catch((e) => ({ error: e.message }));
    console.log('\njQuery.validate sobre #register-form ->', JSON.stringify(validacion));
    const flags = await page.evaluate(() => ({
      rfc_validado: typeof rfc_validado !== 'undefined' ? rfc_validado : 'n/d',
      bandera_pago_app: typeof bandera_pago_app !== 'undefined' ? bandera_pago_app : 'n/d',
      bandera_guardado: typeof bandera_guardado !== 'undefined' ? bandera_guardado : 'n/d',
      bandera_pdf: typeof bandera_pdf !== 'undefined' ? bandera_pdf : 'n/d',
      skin: document.body.className,
      hay_check_detalle: !!document.querySelector('#check_detalle'),
    }));
    console.log('\nFLAGS DEL PORTAL:', JSON.stringify(flags, null, 1));

    console.log('\n[STOP] PARADA DELIBERADA. El siguiente click ("Siguiente" desde Datos');
    console.log('       Personales) dispararia users/guardarCuenta + facturacion/generarVistaPrevia');
    console.log('       y dejaria el wizard en "Vista Previa", donde el MISMO <a href="#next">');
    console.log('       ya se llama "Facturar" y un click mas (+ el iziToast "SI") llama a');
    console.log('       facturacion/verificaFactura = TIMBRADO IRREVERSIBLE. No se sigue.');
  } catch (e) {
    console.error('ERROR:', e.message);
    await dump(page, 'zz_error').catch(() => {});
  }
  await browser.close().catch(() => {});
  process.exit(0);
})();
