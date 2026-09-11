// Reconocimiento ControlGasFE de SERVICIO PIONEROS 4 (pioneros4.ddns.net:82),
// ticket #360. Familia ControlGAS auto-hospedada: cada estación corre su propia
// instancia en un DDNS del negocio, HTTP sin TLS y puerto no estándar.
// NO PULSA NINGÚN BOTÓN QUE TIMBRE.
//
// RESULTADO (11-sep-2026) — lo importante primero:
//
// ⚠️ NO USAR ESTE PORTAL PARA FACTURAR. La estación E13549 SÍ está en la
//    fachada central app.facturagas.net (se busca escribiendo "13549" →
//    "E13549: Servicio Pioneros") y ahí el ticket #360 valida sin captcha:
//    "Ticket validado correctamente", Folio 31443100, $1191.23,
//    2026-09-01 08:45. O sea: bots/facturagas.js sirve TAL CUAL.
//    Ver scripts/probe-apv-10736.js, que es el que comprueba eso.
//    Este portal propio solo tiene sentido si algún día app.facturagas.net
//    deja de listar la estación.
//
// El portal propio (lo que se documentó aquí, por si hace falta):
//  1. http://pioneros4.ddns.net:82/controlgasfe/ — ASP.NET WebForms,
//     ControlGasFE v2.9.13.0. Tres botones: #consultar, #facturar, #cliente,
//     todos __doPostBack.
//  2. ⚠️ HAY QUE ENTRAR POR EL POSTBACK, NO POR URL DIRECTA. Navegar a
//     facturar.aspx a pelo devuelve 200 pero con "Error: Referencia a objeto
//     no establecida como instancia de un objeto" y el combo de estaciones
//     VACÍO (itemData:[]). El postback redirige a
//     facturar.aspx?SS=<token de sesión> y ahí el combo llega con su única
//     estación ya seleccionada ("E13549: SERVICIO PIONEROS 4 SA DE CV").
//  3. facturar.aspx (pantalla "FOLIO Y WEB ID"): #cmbGasolineras_Input
//     (RadComboBox Telerik, ya precargado), #txtDespacho (*Folio, maxlength
//     15), #txtIdentificador (*Web Id, maxlength 8),
//     #RadCaptcha1_CaptchaTextBox (captcha, maxlength 5, mayúsculas) y
//     #btnAgregar (value="Agregar" — valida/agrega el ticket, NO timbra).
//  4. ⛔ CAPTCHA: Telerik RadCaptcha de IMAGEN (no reCAPTCHA, no Turnstile,
//     no hay sitekey). Imagen en #RadCaptcha1_CaptchaImageUP, servida por
//     Telerik.Web.UI.WebResource.axd?type=rca&guid=... Refresco:
//     #RadCaptcha1_CaptchaLinkButton. Fallar solo repinta la página con
//     "Código Captcha incorrecto." y una imagen nueva.
//     TRAMPA MEDIDA: el widget va con _persistCode:false, así que CADA GET a
//     esa URL GENERA UN CÓDIGO NUEVO (3 GET seguidos al MISMO guid dieron 3
//     imágenes distintas: len 4157/4147/3964). Bajar la imagen aparte para
//     mandarla a un solver cambia el código que el servidor espera: hay que
//     pedirla UNA sola vez por intento y enviar el formulario acto seguido,
//     o capturarla con elementHandle.screenshot() (sin GET extra).
//  5. datos_facturacion.aspx?SS=<token> (pantalla 2, sin captcha): #txtRFC
//     ("*RFC ó número de cliente") + #btnBuscar (submit "Buscar"). Sin un
//     despacho válido en sesión responde "El RFC no coincide con el asignado
//     al Despacho.". El botón que TIMBRA vive detrás de esta pantalla y solo
//     se alcanza pasando el captcha; no se llegó a él a propósito.
//  6. alta_direccion_inicio.aspx?SS= ("Alta Cliente", SIN captcha):
//     #cmbGasolineras (select), radios #rdHabilitaFisica / #rdHabilitaMoral /
//     #rdHabilitaExtranjero (cada uno hace postback y cambia el catálogo de
//     #cmbRegimen), #txtCodExt (Código de Cliente), #txtRFC (maxlength 13),
//     #txtCorreo1, #txtNombre, #txtApePat, #txtApeMat, #txtDenSat (Razón
//     Social), #txtCP, #cmbRegimen y #btnGuarda (value="Guardar").
//     Con "Persona Física" el combo solo trae regímenes de física (605..626);
//     hay que pulsar #rdHabilitaMoral para que aparezca el 601.
//  7. consultar.aspx?SS= (recuperar CFDI ya emitido, SIN captcha):
//     #cmbGasolineras_Input, #txtRFC, #txtCodigo ("*Código Cliente") y
//     #btnSiguiente (submit "Siguiente"). Ese "Código Cliente" sale del alta
//     del punto 6: no es ningún dato impreso en el ticket.
//  8. PLAZO: el inicio avisa "Solo se pueden facturar notas máximo 72 horas
//     posteriores a haber sido realizadas". app.facturagas.net, en cambio,
//     validó este ticket a los 10 días.
//  9. Sin login para facturar. El "Alta Cliente" no es una cuenta con
//     contraseña, es dar de alta el RFC receptor.
// 10. Dato suelto: facturar.aspx expone un PageMethod
//     POST facturar.aspx/getGasolineras que devuelve el catálogo en JSON
//     ({cod, den}) — útil si alguna vez el combo llega vacío.
//
// Uso: PASO=1..12 node scripts/probe-pioneros4.js
//   1 inicio · 2 facturar.aspx directo (roto) · 3 consultar.aspx directo
//   4 combo+captcha+JS · 5 rellenar y pulsar Agregar · 6 entrar por postback
//   7 alta cliente · 8 consultar · 9 estabilidad del captcha
//   10 gpopioneros.com · 11 datos_facturacion.aspx · 12 buscar RFC
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');
const dormir = ms => new Promise(r => setTimeout(r, ms));

const BASE = process.env.PROBE_URL || 'http://pioneros4.ddns.net:82/controlgasfe/';
const PASO = process.env.PASO || '1';

async function dump(page, label, { scripts = false } = {}) {
  const info = await page.evaluate(() => {
    const vis = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const campos = Array.from(document.querySelectorAll('input,select,textarea')).map(el => ({
      tag: el.tagName, type: el.type || null, id: el.id || null, name: el.name || null,
      ph: el.placeholder || null, maxlength: el.maxLength > 0 && el.maxLength < 500 ? el.maxLength : null,
      value: (el.value || '').slice(0, 50) || null, vis: vis(el),
      nOptions: el.tagName === 'SELECT' ? el.options.length : undefined,
      ops: el.tagName === 'SELECT' ? Array.from(el.options).slice(0, 6).map(o => `${o.value}|${o.text}`.slice(0, 50)) : undefined,
    })).filter(c => c.vis || c.type === 'hidden');
    const botones = Array.from(document.querySelectorAll('a,button,input[type=button],input[type=submit],input[type=image],img[onclick],[onclick]')).map(b => ({
      tag: b.tagName, id: b.id || null, name: b.name || null,
      texto: (b.textContent || b.value || b.alt || b.title || '').trim().slice(0, 60) || null,
      href: (b.getAttribute && b.getAttribute('href')) || null,
      onclick: (b.getAttribute && (b.getAttribute('onclick') || '').slice(0, 120)) || null,
      src: (b.getAttribute && b.getAttribute('src')) || null,
      vis: vis(b),
    })).filter(b => b.vis && (b.texto || b.onclick || b.id));
    const captcha = {
      iframes: Array.from(document.querySelectorAll('iframe')).map(f => (f.src || '').slice(0, 140)),
      recaptchaKeys: Array.from(document.querySelectorAll('[data-sitekey]')).map(e => e.getAttribute('data-sitekey')),
      sospechosos: Array.from(document.querySelectorAll('[id*=aptcha],[class*=aptcha],[id*=Captcha],[name*=aptcha]')).map(e => `${e.tagName}#${e.id}.${e.className}`.slice(0, 80)),
    };
    return {
      url: location.href, title: document.title,
      texto: (document.body.innerText || '').replace(/\n{3,}/g, '\n\n').slice(0, 1800),
      campos, botones, captcha,
      frames: Array.from(document.querySelectorAll('frame,iframe')).map(f => f.src),
    };
  });
  console.log(`\n================ ${label} ================`);
  console.log(JSON.stringify(info, null, 1));
  if (scripts) {
    const js = await page.evaluate(() => Array.from(document.querySelectorAll('script')).filter(s => !s.src).map(s => s.textContent.slice(0, 4000)));
    console.log(`--- SCRIPTS INLINE (${js.length}) ---\n` + js.join('\n/*---*/\n').slice(0, 9000));
    const srcs = await page.evaluate(() => Array.from(document.querySelectorAll('script[src]')).map(s => s.src));
    console.log('--- SCRIPT SRC ---', JSON.stringify(srcs, null, 1));
  }
  try {
    const buf = await page.screenshot({ fullPage: true });
    console.log('📸', await subirArchivoR2(buf, `debug/pioneros4_${label}_${Date.now()}.png`, 'image/png'));
  } catch (e) { console.log('screenshot falló:', e.message); }
  return info;
}

(async () => {
  // Browserless devuelve 429 cuando otra corrida tiene la sesion ocupada;
  // reintentar con espera en vez de morir (pasa mucho al sondear en paralelo).
  let browser = null;
  for (let i = 0; i < 12 && !browser; i++) {
    try {
      browser = await puppeteer.connect({
        browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}&stealth=true`,
      });
    } catch (e) {
      console.log(`connect intento ${i + 1}: ${e.message} — esperando 20s`);
      await dormir(20000);
    }
  }
  if (!browser) throw new Error('Browserless no aceptó la conexión (429 persistente)');
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 1000 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
  page.on('dialog', async d => { console.log('🔔 DIALOG:', d.message()); await d.accept().catch(() => {}); });
  page.on('pageerror', e => console.log('PAGEERROR:', e.message.slice(0, 200)));
  page.on('requestfailed', r => console.log('REQFAIL:', r.url().slice(0, 120), r.failure() && r.failure().errorText));


  if (PASO === '1') {
    try {
      console.log('🌐 GET', BASE);
      const r = await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 45000 });
      console.log('Status:', r && r.status(), '| URL final:', page.url());
      await dormir(2500);
      await dump(page, 'p1_inicio', { scripts: true });
    } catch (e) { console.log('❌ No cargó:', e.message); }
  }

  // PASO 2 — facturar.aspx (formulario de emisión). SOLO carga y describe.
  if (PASO === '2') {
    const r = await page.goto(BASE + 'facturar.aspx', { waitUntil: 'networkidle2', timeout: 45000 });
    console.log('Status:', r && r.status(), '| URL:', page.url());
    await dormir(2500);
    await dump(page, 'p2_facturar_aspx', { scripts: true });
  }

  // PASO 3 — consultar.aspx (recuperar factura ya emitida). SOLO carga.
  if (PASO === '3') {
    const r = await page.goto(BASE + 'consultar.aspx', { waitUntil: 'networkidle2', timeout: 45000 });
    console.log('Status:', r && r.status(), '| URL:', page.url());
    await dormir(2500);
    await dump(page, 'p3_consultar_aspx', { scripts: true });
  }


  // PASO 4 — facturar.aspx: catálogo de estaciones (RadComboBox Telerik),
  // imagen del captcha y el JS gfProceso(). NO pulsa nada que timbre.
  if (PASO === '4') {
    await page.goto(BASE + 'facturar.aspx', { waitUntil: 'networkidle2', timeout: 45000 });
    await dormir(2500);
    // Abrir el desplegable de estaciones
    await page.click('#cmbGasolineras_Input').catch(e => console.log('click combo:', e.message));
    await dormir(2500);
    const combo = await page.evaluate(() => {
      const dd = document.getElementById('cmbGasolineras_DropDown');
      const items = dd ? Array.from(dd.querySelectorAll('li,.rcbItem,.rcbHovered')).map(i => i.textContent.trim()).filter(Boolean) : [];
      const cs = document.getElementById('cmbGasolineras_ClientState');
      return { hayDropDown: !!dd, nItems: items.length, items: items.slice(0, 30), clientState: cs && cs.value, htmlDD: dd ? dd.innerHTML.slice(0, 1200) : null };
    });
    console.log('=== COMBO ESTACIONES ===', JSON.stringify(combo, null, 1));
    const cap = await page.evaluate(() => {
      const img = document.getElementById('RadCaptcha1_CaptchaImageUP');
      const lbl = document.getElementById('RadCaptcha1_CaptchaTextBoxLabel');
      return { src: img && img.src, alt: img && img.alt, w: img && img.width, h: img && img.height,
               label: lbl && lbl.textContent.trim(),
               textoCaptcha: (document.getElementById('RadCaptcha1') || {}).innerText };
    });
    console.log('=== CAPTCHA ===', JSON.stringify(cap, null, 1));
    const js = await page.evaluate(() => Array.from(document.querySelectorAll('script')).filter(s => !s.src).map(s => s.textContent).join(String.fromCharCode(10)+'/*---*/'));
    console.log('=== JS INLINE COMPLETO ===');console.log(js.slice(0, 20000));
    await dump(page, 'p4_combo_abierto');
  }

  // PASO 5 — rellena Folio + Web Id + captcha (CapSolver) y pulsa "Agregar",
  // que SOLO valida/agrega el ticket y muestra el consumo. NO TIMBRA.
  // Hay que entrar por el postback del inicio: la URL directa a facturar.aspx
  // no trae el token ?SS=... y el combo de estaciones llega vacio.
  if (PASO === '5') {
    await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 45000 });
    await dormir(1500);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 40000 }).catch(e => console.log('nav:', e.message)),
      page.evaluate(() => document.getElementById('facturar').click()),
    ]);
    await dormir(3000);
    console.log('URL formulario:', page.url());

    const FOLIO = process.env.FOLIO || '31443100';
    const WEBID = process.env.WEBID || '78307049';
    console.log('Probando Folio=' + FOLIO + ' WebId=' + WEBID);

    const est = await page.evaluate(() => (document.getElementById('cmbGasolineras_Input') || {}).value);
    console.log('estacion precargada:', est);

    await page.click('#txtDespacho'); await page.keyboard.type(String(FOLIO), { delay: 60 });
    await page.click('#txtIdentificador'); await page.keyboard.type(String(WEBID), { delay: 60 });
    await dormir(400);

    const capUrl = await page.evaluate(() => { const i = document.getElementById('RadCaptcha1_CaptchaImageUP'); return i && i.src; });
    console.log('captcha img:', capUrl);
    let textoCap = null;
    if (capUrl && process.env.CAPSOLVER_API_KEY) {
      const b64 = await page.evaluate(async (u) => {
        const r = await fetch(u, { cache: 'no-store' });
        const b = await r.blob();
        return await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result.split(',')[1]); fr.readAsDataURL(b); });
      }, capUrl);
      console.log('captcha bytes b64:', b64 ? b64.length : 0);
      const resp = await fetch('https://api.capsolver.com/createTask', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: process.env.CAPSOLVER_API_KEY, task: { type: 'ImageToTextTask', module: 'common', body: b64 } }),
      }).then(r => r.json());
      console.log('CapSolver:', JSON.stringify(resp).slice(0, 400));
      textoCap = resp && resp.solution && resp.solution.text;
      if (textoCap) {
        textoCap = textoCap.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
        await page.click('#RadCaptcha1_CaptchaTextBox');
        await page.keyboard.type(textoCap, { delay: 90 });
        console.log('captcha escrito:', textoCap);
      }
    }
    const leido = await page.evaluate(() => ({
      folio: (document.getElementById('txtDespacho') || {}).value,
      webid: (document.getElementById('txtIdentificador') || {}).value,
      cap: (document.getElementById('RadCaptcha1_CaptchaTextBox') || {}).value,
    }));
    console.log('releido del DOM:', JSON.stringify(leido));
    await dump(page, 'p5_form_lleno');

    console.log('➡️ Click "Agregar" (#btnAgregar) — valida/agrega el ticket, NO timbra...');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 45000 }).catch(e => console.log('nav:', e.message)),
      page.click('#btnAgregar'),
    ]);
    await dormir(4000);
    await dump(page, 'p6_post_agregar');
  }

  // PASO 6 — llegar a facturar.aspx POR EL POSTBACK del inicio (no por URL
  // directa): la URL directa deja el combo de estaciones vacio y suelta un
  // NullReference del servidor.
  if (PASO === '6') {
    await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 45000 });
    await dormir(2000);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 40000 }).catch(e => console.log('nav:', e.message)),
      page.evaluate(() => document.getElementById('facturar').click()),
    ]);
    await dormir(3000);
    console.log('URL:', page.url());
    const combo = await page.evaluate(() => {
      const scripts = Array.from(document.querySelectorAll('script')).map(s => s.textContent).join(' ');
      const m = scripts.match(/RadComboBox[\s\S]{0,400}?itemData":(\[[\s\S]*?\])/);
      const dd = document.getElementById('cmbGasolineras_DropDown');
      return { itemData: m ? m[1].slice(0, 1500) : null, ddHtml: dd ? dd.innerHTML.slice(0, 1500) : null,
               errorTexto: (document.body.innerText.match(/Error:.*/g) || []).slice(0, 3) };
    });
    console.log('=== COMBO tras postback ===', JSON.stringify(combo, null, 1));
    await dump(page, 'p6_facturar_por_postback');

    // Probar carga bajo demanda: teclear en el combo y ver si pide al servidor
    page.on('request', r => { if (/callback|WebResource|\.aspx/i.test(r.url()) && r.method() === 'POST') console.log('POST →', r.url().slice(0, 120)); });
    await page.click('#cmbGasolineras_Input');
    await page.keyboard.type('PIONEROS', { delay: 120 });
    await dormir(4000);
    const tras = await page.evaluate(() => {
      const dd = document.getElementById('cmbGasolineras_DropDown');
      return { html: dd ? dd.innerHTML.slice(0, 1500) : null, valor: (document.getElementById('cmbGasolineras_Input') || {}).value,
               cs: (document.getElementById('cmbGasolineras_ClientState') || {}).value };
    });
    console.log('=== COMBO tras teclear PIONEROS ===', JSON.stringify(tras, null, 1));
    await dump(page, 'p6b_combo_tecleado');
  }


  // PASO 7 — "Alta Cliente" (cliente.aspx) por el postback del inicio. Aqui se
  // registra el RFC receptor; el flujo de facturar pide luego un "Codigo
  // Cliente" que sale de aqui.
  if (PASO === '7') {
    await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 45000 });
    await dormir(1500);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 40000 }).catch(e => console.log('nav:', e.message)),
      page.evaluate(() => document.getElementById('cliente').click()),
    ]);
    await dormir(3500);
    console.log('URL:', page.url());
    await dump(page, 'p7_alta_cliente');
  }

  // PASO 8 — "Consultar" (consultar.aspx) por el postback del inicio:
  // recuperar una factura ya emitida.
  if (PASO === '8') {
    await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 45000 });
    await dormir(1500);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 40000 }).catch(e => console.log('nav:', e.message)),
      page.evaluate(() => document.getElementById('consultar').click()),
    ]);
    await dormir(3500);
    console.log('URL:', page.url());
    await dump(page, 'p8_consultar');
  }

  // PASO 9 — ¿la imagen del RadCaptcha se regenera al pedirla por fetch?
  // Si cada GET a la WebResource.axd cambia el codigo, bajarla aparte invalida
  // el que el servidor espera y siempre saldra "Codigo Captcha incorrecto".
  if (PASO === '9') {
    await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 45000 });
    await dormir(1500);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 40000 }).catch(() => {}),
      page.evaluate(() => document.getElementById('facturar').click()),
    ]);
    await dormir(3000);
    const r = await page.evaluate(async () => {
      const img = document.getElementById('RadCaptcha1_CaptchaImageUP');
      // crypto.subtle no existe en contexto inseguro (http://), checksum a mano
      const hash = async (u) => {
        const b = new Uint8Array(await (await fetch(u, { cache: 'no-store' })).arrayBuffer());
        let h = 0; for (let i = 0; i < b.length; i++) h = (h * 31 + b[i]) >>> 0;
        return 'chk=' + h.toString(16) + ' len=' + b.length;
      };
      return { src: img.src, h1: await hash(img.src), h2: await hash(img.src), h3: await hash(img.src) };
    });
    console.log('=== ESTABILIDAD CAPTCHA (mismo guid, 3 GET) ===', JSON.stringify(r, null, 1));
    const el = await page.$('#RadCaptcha1_CaptchaImageUP');
    const buf = await el.screenshot();
    console.log('screenshot del <img> (sin GET extra):', buf.length, 'bytes →',
      await subirArchivoR2(buf, `debug/pioneros4_captcha_${Date.now()}.png`, 'image/png'));
  }


  // PASO 10 — la URL que IMPRIME el ticket es www.gpopioneros.com. Ver si
  // lleva al mismo ControlGasFE o es otra cosa.
  if (PASO === '10') {
    for (const u of ['http://www.gpopioneros.com', 'https://www.gpopioneros.com']) {
      try {
        const r = await page.goto(u, { waitUntil: 'networkidle2', timeout: 30000 });
        console.log(u, '→ status', r && r.status(), '| final:', page.url());
        await dormir(2000);
        const t = await page.evaluate(() => ({
          titulo: document.title,
          texto: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 700),
          links: Array.from(document.querySelectorAll('a[href]')).map(a => a.href).filter(h => /factur|ddns|controlgas/i.test(h)).slice(0, 15),
        }));
        console.log(JSON.stringify(t, null, 1));
      } catch (e) { console.log(u, '❌', e.message); }
    }
  }


  // PASO 11 — datos_facturacion.aspx (la pantalla que sigue a "Agregar", donde
  // esta el boton que TIMBRA). Se abre con el token ?SS=... que da el postback
  // del inicio. SOLO se describe: NO se pulsa nada.
  if (PASO === '11') {
    await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 45000 });
    await dormir(1500);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 40000 }).catch(() => {}),
      page.evaluate(() => document.getElementById('facturar').click()),
    ]);
    await dormir(2500);
    const ss = (page.url().match(/SS=([^&]+)/) || [])[1];
    console.log('token SS:', ss, '| desde', page.url());
    const destino = BASE + 'datos_facturacion.aspx' + (ss ? '?SS=' + ss : '');
    const r = await page.goto(destino, { waitUntil: 'networkidle2', timeout: 45000 });
    console.log('GET', destino, '→', r && r.status(), '| final:', page.url());
    await dormir(3000);
    await dump(page, 'p11_datos_facturacion');
  }


  // PASO 12 — datos_facturacion.aspx: escribir el RFC receptor y pulsar
  // "Buscar" (#btnBuscar), que SOLO consulta el cliente. Revela la pantalla 3.
  // NO se pulsa ningun boton que emita el CFDI.
  if (PASO === '12') {
    await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 45000 });
    await dormir(1500);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 40000 }).catch(() => {}),
      page.evaluate(() => document.getElementById('facturar').click()),
    ]);
    await dormir(2500);
    const ss = (page.url().match(/SS=([^&]+)/) || [])[1];
    await page.goto(BASE + 'datos_facturacion.aspx?SS=' + ss, { waitUntil: 'networkidle2', timeout: 45000 });
    await dormir(2500);
    const RFC = process.env.RFC || 'GPR110128QD8';
    await page.click('#txtRFC');
    await page.keyboard.type(RFC, { delay: 60 });
    console.log('RFC en el DOM:', await page.evaluate(() => document.getElementById('txtRFC').value));
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 45000 }).catch(e => console.log('nav:', e.message)),
      page.click('#btnBuscar'),
    ]);
    await dormir(3500);
    console.log('URL tras Buscar:', page.url());
    await dump(page, 'p12_post_buscar_rfc');
  }

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌ Error:', e.message); process.exit(1); });
