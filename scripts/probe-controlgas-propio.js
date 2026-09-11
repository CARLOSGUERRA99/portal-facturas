/**
 * Sondea el portal PROPIO de una estación ControlGAS (el que corre en el DDNS de
 * la gasolinera, no app.facturagas.net) y comprueba si su RadCaptcha de Telerik
 * se puede resolver con CapSolver.
 *
 * Por qué hace falta: no todas las estaciones están en app.facturagas.net.
 * Comprobado el 11-sep-2026 leyendo el catálogo completo del portal (2393
 * estaciones): E13272 "Gaservicio Morelos" SÍ está, pero E01744 "Servicio GMV"
 * NO — el único 1744 del catálogo es E11744 "SERVICIO PARADOR EL ESPAÑOL", que
 * es otra gasolinera. Para esas estaciones el único camino es su portal propio,
 * y ese SÍ lleva captcha (app.facturagas.net no lleva ninguno).
 *
 * ⛔ NO TIMBRA. Llega hasta "Agregar", que es la CONSULTA del consumo, y para.
 * El botón que emite viene después.
 *
 * Uso:
 *   node scripts/probe-controlgas-propio.js <urlBase> <estacion> <folio> <webId>
 *   node scripts/probe-controlgas-propio.js http://es1744gmv.fortiddns.com:8088/controlgasfe/ 01744 4987234 83925103
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

const [, , BASE, ESTACION, FOLIO, WEBID] = process.argv;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function resolverCaptcha(b64) {
  const c = await fetch('https://api.capsolver.com/createTask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientKey: process.env.CAPSOLVER_API_KEY,
      // El RadCaptcha de Telerik son 5 caracteres alfanuméricos en MAYÚSCULA.
      task: { type: 'ImageToTextTask', module: 'common', body: b64, case: true },
    }),
  }).then((r) => r.json());
  if (c.errorId) throw new Error(c.errorCode || c.errorDescription);
  return (c.solution?.text || '').trim();
}

(async () => {
  if (!BASE || !ESTACION || !FOLIO || !WEBID) {
    console.error('Uso: node scripts/probe-controlgas-propio.js <urlBase> <estacion> <folio> <webId>');
    process.exit(1);
  }
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}&stealth=true`,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 900 });
  page.on('dialog', async (d) => { console.log('💬', d.message()); await d.accept().catch(() => {}); });

  const snap = async (l) => {
    try {
      const u = await subirArchivoR2(await page.screenshot(), `debug/controlgas_${l}_${Date.now()}.png`, 'image/png');
      console.log(`📸 ${l}: ${u}`);
    } catch {}
  };

  try {
    console.log(`🌐 ${BASE}`);
    await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 45000 });
    await sleep(2000);

    // El botón Facturar de la portada NAVEGA: envolver o el evaluate siguiente
    // muere con "Execution context was destroyed".
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 45000 }).catch(() => {}),
      page.evaluate(() => {
        const b = Array.from(document.querySelectorAll('button, a, input[type=button], input[type=submit]'))
          .filter((x) => x.offsetParent)
          .find((x) => /^\s*Facturar\s*$/i.test((x.textContent || x.value || '').trim()));
        if (b) b.click();
      }),
    ]);
    await page.waitForSelector('#txtDespacho', { timeout: 25000 });
    await snap('01_formulario');

    // Estación: es un RadComboBox de Telerik — hay que TECLEAR de verdad y
    // elegir de la lista; poner el .value deja el combo creyendo que está vacío.
    await page.click('#cmbGasolineras_Input');
    await page.keyboard.type(String(ESTACION), { delay: 90 });
    await sleep(2500);
    const opciones = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.rcbList li, .rcbItem'))
        .filter((x) => x.offsetParent).map((x) => (x.textContent || '').trim()).filter(Boolean)
    );
    console.log('   opciones del combo:', JSON.stringify(opciones).slice(0, 200));
    if (opciones.length) {
      await page.evaluate(() => {
        const li = Array.from(document.querySelectorAll('.rcbList li, .rcbItem')).filter((x) => x.offsetParent)[0];
        if (li) li.click();
      });
      await sleep(1200);
    }

    await page.click('#txtDespacho'); await page.keyboard.type(String(FOLIO), { delay: 70 });
    await page.click('#txtIdentificador'); await page.keyboard.type(String(WEBID), { delay: 70 });
    await snap('02_datos');

    // Captcha: imagen de Telerik. Se lee del DOM por canvas (necesita la cookie
    // de sesión, un fetch desde Node devuelve vacío).
    const b64 = await page.evaluate(() => {
      const img = Array.from(document.querySelectorAll('img'))
        .find((i) => /captcha/i.test(i.src + i.id + i.className) && i.naturalWidth > 0);
      if (!img) return null;
      const c = document.createElement('canvas');
      c.width = img.naturalWidth * 3; c.height = img.naturalHeight * 3;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL('image/png').split(',')[1];
    });
    if (!b64) { console.log('⚠️ no se encontró la imagen del captcha'); await snap('03_sin_captcha'); await browser.close(); process.exit(2); }

    const sol = await resolverCaptcha(b64);
    console.log(`🔓 CapSolver dice: "${sol}" (${sol.length} caracteres)`);
    await page.click('#RadCaptcha1_CaptchaTextBox');
    await page.keyboard.type(sol, { delay: 80 });

    // "Agregar" CONSULTA el consumo; no emite nada.
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
      page.evaluate(() => document.getElementById('btnAgregar')?.click()),
    ]);
    await sleep(3000);
    await snap('04_tras_agregar');

    const estado = await page.evaluate(() => ({
      texto: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 500),
      sigueCaptcha: !!document.getElementById('RadCaptcha1_CaptchaTextBox'),
    }));
    console.log('\n── TRAS AGREGAR ──────────────────────────');
    console.log(estado.texto);

    // Si el consumo apareció, seguimos UN PASO MÁS para ver qué pide el portal
    // antes de emitir. Se para ahí: el botón que timbra no se pulsa.
    if (/Informaci[oó]n de consumo/i.test(estado.texto) && /Total/i.test(estado.texto)) {
      const siguiente = await page.evaluate(() =>
        Array.from(document.querySelectorAll('button, a, input[type=button], input[type=submit]'))
          .filter((x) => x.offsetParent)
          .map((x) => ({ t: ((x.textContent || x.value || '') + '').replace(/\s+/g, ' ').trim(), id: x.id }))
          .filter((x) => x.t)
      );
      console.log('\nbotones disponibles:', JSON.stringify(siguiente).slice(0, 400));

      // "Continuar"/"Siguiente" suele llevar a los datos fiscales, que es la
      // pantalla ANTERIOR al timbrado. Ahí es donde hay que parar.
      const avanzar = siguiente.find((b) => /continuar|siguiente|datos|generar factura/i.test(b.t));
      if (avanzar) {
        console.log(`→ pulsando "${avanzar.t}" para ver la pantalla de datos fiscales`);
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
          page.evaluate((id, txt) => {
            const b = Array.from(document.querySelectorAll('button, a, input[type=button], input[type=submit]'))
              .filter((x) => x.offsetParent)
              .find((x) => (id && x.id === id) || ((x.textContent || x.value || '').trim() === txt));
            if (b) b.click();
          }, avanzar.id, avanzar.t),
        ]);
        await sleep(3000);
        await snap('05_datos_fiscales');
        const fiscal = await page.evaluate(() => ({
          url: location.href,
          texto: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 500),
          campos: Array.from(document.querySelectorAll('input, select')).filter((e) => e.offsetParent)
            .map((e) => ({ id: e.id, name: e.name, ph: e.placeholder, tipo: e.type, opts: e.tagName === 'SELECT' ? e.options.length : undefined })),
          botones: Array.from(document.querySelectorAll('button, a, input[type=button], input[type=submit]'))
            .filter((x) => x.offsetParent).map((x) => ((x.textContent || x.value || '') + '').trim()).filter(Boolean).slice(0, 12),
        }));
        console.log('\n── PANTALLA DE DATOS FISCALES (NO se timbró) ──');
        console.log(JSON.stringify(fiscal, null, 1).slice(0, 1800));
      }
    }
    console.log(`\ncaptcha sigue en pantalla: ${estado.sigueCaptcha}`);
    await browser.close();
    process.exit(0);
  } catch (e) {
    console.error('❌', e.message);
    await snap('error').catch(() => {});
    await browser.close().catch(() => {});
    process.exit(1);
  }
})();
