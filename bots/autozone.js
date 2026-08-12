/**
 * Bot AutoZone de México — plataforma CDC (Origon Cloud) — Angular Material
 *
 * Flujo (multi-step wizard con DIV.navigation-container como botones de navegación):
 *   Inicio → Facturación Rápida → Iniciar →
 *   Paso 1 (0%)  : Código de barras (mat-input-0, text)
 *   Paso 2 (20%) : Fecha de compra (calendario con <td> clickeables)
 *   Paso 3 (30%) : Monto de compra (mat-input-1, number) → validación AJAX
 *   Paso 4 (40%+): Datos de Facturación (RFC, nombre, CP, régimen, CFDI, correo)
 *   Paso final   : Generar factura → descarga XML/PDF o correo
 *
 * Tecnología: Angular Material v14+ con custom navigation-container buttons
 */

const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

async function fillAngular(page, selector, value) {
  await page.evaluate((sel, val) => {
    const el = document.querySelector(sel);
    if (!el) return;
    // Angular native input setter
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(el, val);
    else el.value = val;
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur',   { bubbles: true }));
  }, selector, value);
}

async function facturarAutoZone({
  barcode, referencia, folio, fecha, total, formaPago: formaPagoTicket,
  rfc, razonSocial, regimenFiscal, usoCfdi, codigoPostal,
  calle, ext, int: numInt, colonia, municipio, estado,
  ticketId, portalUrl,
}) {
  const barcodeVal = String(barcode || referencia || folio || '').trim();
  const totalVal   = String(Math.round(parseFloat(total || 0)));   // número entero
  const fechaVal   = fecha || '';  // YYYY-MM-DD

  console.log('🤖 Iniciando bot AutoZone (CDC/Origon Cloud)...');
  console.log(`   Barcode: ${barcodeVal} | Fecha: ${fechaVal} | Monto: ${totalVal} | RFC: ${rfc}`);

  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error('BROWSERLESS_TOKEN no definido');

  let browser;
  try {
    browser = await puppeteer.connect({
      browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true`,
    });
  } catch (e) {
    return { ok: false, msg: `AutoZone: no se pudo conectar al browser — ${e.message}` };
  }

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  );
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8' });

  const ts = ticketId || Date.now();
  // ⚠️ Cada captura es un viaje al navegador y cuesta ~1s, y el flujo completo
  // no cabe en el tope de sesión de Browserless: 5 capturas de la ruta feliz
  // eran la diferencia entre terminar y morir a mitad de los datos fiscales.
  // Las de ERROR siempre se toman — son las que sirven para diagnosticar.
  // Para ver todas: AUTOZONE_DEBUG=1.
  const snap = async (label) => {
    if (!label.startsWith('error') && process.env.AUTOZONE_DEBUG !== '1') return;
    try {
      const buf = await page.screenshot({ fullPage: false });
      const u = await subirArchivoR2(buf, `debug/autozone_${ts}_${label}_${Date.now()}.png`, 'image/png');
      console.log(`📸 [${label}]: ${u}`);
    } catch {}
  };

  // Clic en botón de navegación del wizard (Iniciar / Siguiente / Anterior)
  // Los botones son DIV.navigation-container — no son <button> nativos.
  const clickNavBtn = async (text) => {
    const rect = await page.evaluate((txt) => {
      const divs = Array.from(document.querySelectorAll('div.navigation-container'));
      const d = divs.find(d => d.textContent.trim() === txt && d.getBoundingClientRect().width > 5);
      if (!d) return null;
      const r = d.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, text);
    if (!rect) return false;
    await page.mouse.click(rect.x, rect.y);
    await page.waitForTimeout(300);
    return true;
  };

  try {
    const url = portalUrl || 'https://autozone.cdc.origon.cloud/facturacion/autozone';
    console.log('🌐 Cargando portal AutoZone:', url);
    // 'networkidle2' esperaba a que callaran las peticiones de fondo de una
    // página Angular con imagen grande: 6-8s tirados. Basta con que exista el
    // enlace que se va a pulsar. Esos segundos hacen falta al final, donde el
    // asistente todavía pide domicilio y la sesión de Browserless se acaba.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll('a')).some(a => /facturaci[oó]n\s+r[aá]pida/i.test(a.textContent)),
      { timeout: 20000 }
    ).catch(() => {});
    await snap('p0_inicio');

    // ── Navegar a Facturación Rápida (sin login) ────────────────────────────
    await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      const link = links.find(a => /facturaci[oó]n\s+r[aá]pida/i.test(a.textContent));
      if (link) link.click();
    });
    // 900ms se quedaba corto: la SPA no había pintado el botón "Iniciar" y el
    // bot abortaba con "no se encontró el botón Iniciar". Recortar esperas para
    // caber en el tope de sesión tiene un suelo.
    await page.waitForTimeout(1600);

    // ── Click en Iniciar (DIV.navigation-container animated) ─────────────────
    const iniciarOk = await clickNavBtn('Iniciar');
    if (!iniciarOk) {
      await snap('error_sin_iniciar');
      await browser.close();
      return { ok: false, msg: 'AutoZone: no se encontró el botón Iniciar en el wizard' };
    }
    await page.waitForTimeout(1800);
    await snap('p1_barcode_form');

    // ── PASO 1: Código de barras ─────────────────────────────────────────────
    const barcodeInput = await page.waitForSelector('#mat-input-0', { timeout: 10000 }).catch(() => null);
    if (!barcodeInput) {
      await snap('error_sin_barcode_input');
      await browser.close();
      return { ok: false, msg: 'AutoZone: no apareció el campo de código de barras' };
    }
    await barcodeInput.click({ clickCount: 3 });
    await barcodeInput.type(barcodeVal, { delay: 60 });
    await page.waitForTimeout(400);
    await clickNavBtn('Siguiente');
    await page.waitForTimeout(1800);
    await snap('p2_fecha_calendar');

    // ── PASO 2: Fecha de compra (calendario) ─────────────────────────────────
    // El portal muestra un calendario con <td> por día.
    // Navegar al mes/año correcto si es necesario.
    // Aceptar fecha en YYYY-MM-DD o DD/MM/YYYY (el OCR de 'desconocido' usa DD/MM/YYYY)
    let fy, fm, fd;
    if (/^\d{4}-\d{1,2}-\d{1,2}/.test(fechaVal)) {
      [fy, fm, fd] = fechaVal.split('-').map(Number);
    } else if (/^\d{1,2}\/\d{1,2}\/\d{4}/.test(fechaVal)) {
      const p = fechaVal.split('/').map(Number); fd = p[0]; fm = p[1]; fy = p[2];
    }
    if (fy && fm && fd) {
      // ⚠️ Este calendario NO se navega como un Angular Material estándar.
      //
      // Reconocimiento real del 02/08/2026 (scripts/recon-autozone-calendario.js):
      // el CUERPO sí es Material (button.mat-calendar-body-cell y
      // .mat-calendar-body-disabled), pero la CABECERA es del portal
      // (<app-calendar-header>) y NO existe ninguno de estos:
      //     .mat-calendar-period-button   → 0 en el DOM
      //     .mat-calendar-previous-button → 0
      //     .mat-calendar-next-button     → 0
      // La versión anterior los buscaba, no encontraba nada, no cambiaba de mes
      // y acababa clickeando el día en el MES ACTUAL. Como los días futuros
      // están deshabilitados, cualquier ticket de un mes anterior fallaba
      // siempre — y el síntoma aparecía dos pasos después, como "no apareció el
      // campo de monto", que no señalaba a la fecha ni de lejos.
      //
      // Cómo se navega de verdad: la cabecera son dos <span class="example-header-label">,
      // uno con el mes y otro con el año, y son desplegables. Al pulsar el del
      // mes, el calendario cambia a mat-year-view con botones ENE…DIC.
      const MESES_CORTOS = ['ENE','FEB','MAR','ABR','MAY','JUN','JUL','AGO','SEP','OCT','NOV','DIC'];

      const etiquetasCabecera = () => page.evaluate(() =>
        Array.from(document.querySelectorAll('span.example-header-label')).map(s => s.textContent.trim()));

      // Pulsa una celda del cuerpo del calendario por su texto, saltando las
      // deshabilitadas. Devuelve false si no existe o no se puede pulsar.
      const pulsarCelda = (texto) => page.evaluate((t) => {
        const b = Array.from(document.querySelectorAll('button.mat-calendar-body-cell'))
          .find(b => b.textContent.trim().toUpperCase() === t.toUpperCase()
                  && !b.classList.contains('mat-calendar-body-disabled'));
        if (!b) return false;
        b.click();
        return true;
      }, String(texto));

      const [mesActual, anioActual] = await etiquetasCabecera();
      console.log(`📅 Calendario abierto en: ${mesActual} ${anioActual} — objetivo ${fd}/${fm}/${fy}`);

      if (String(anioActual) !== String(fy)) {
        await page.evaluate(() => {
          const spans = Array.from(document.querySelectorAll('span.example-header-label'));
          if (spans[1]) spans[1].click();   // el segundo es el año
        });
        await page.waitForTimeout(600);
        if (!await pulsarCelda(fy)) {
          await snap('error_anio_no_disponible');
          await browser.close();
          return { ok: false, error_code: 'ticket_vencido', msg: `AutoZone: el año ${fy} no está disponible en el calendario` };
        }
        await page.waitForTimeout(600);
      }

      if ((mesActual || '').toUpperCase().slice(0, 3) !== MESES_CORTOS[fm - 1]) {
        await page.evaluate(() => {
          const spans = Array.from(document.querySelectorAll('span.example-header-label'));
          if (spans[0]) spans[0].click();   // el primero es el mes
        });
        await page.waitForTimeout(600);
        if (!await pulsarCelda(MESES_CORTOS[fm - 1])) {
          await snap('error_mes_no_disponible');
          await browser.close();
          return { ok: false, error_code: 'ticket_vencido', msg: `AutoZone: el mes ${MESES_CORTOS[fm - 1]} ${fy} aparece deshabilitado — el portal ya no acepta ese periodo` };
        }
        await page.waitForTimeout(900);
      }

      if (!await pulsarCelda(fd)) {
        await snap('error_dia_no_disponible');
        await browser.close();
        return { ok: false, error_code: 'ticket_vencido', msg: `AutoZone: el día ${fd}/${fm}/${fy} está deshabilitado en el calendario` };
      }
      await page.waitForTimeout(600);

      // ⚠️ Comprobar que el portal REGISTRÓ la fecha. Antes se imprimía
      // "Fecha seleccionada" pasara lo que pasara, así que un fallo aquí se
      // descubría tres pasos más adelante con un mensaje que no tenía que ver.
      //
      // Ojo con CÓMO se comprueba: elegir el día hace que el wizard avance solo,
      // así que el calendario desaparece y buscar la celda seleccionada da falso
      // negativo. La señal buena es el resumen lateral, que pasa a mostrar la
      // fecha elegida (ej. "27/7/2026").
      const quedoSeleccionada = await page.evaluate((d, m, y) => {
        if (document.querySelector('.mat-calendar-body-selected, [aria-selected="true"]')) return true;
        const txt = document.body.innerText;
        return txt.includes(`${d}/${m}/${y}`) || txt.includes(`${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`);
      }, fd, fm, fy);
      if (!quedoSeleccionada) {
        await snap('error_fecha_no_registrada');
        await browser.close();
        return { ok: false, msg: `AutoZone: se pulsó ${fd}/${fm}/${fy} pero el calendario no lo marcó como seleccionado` };
      }
      console.log(`✅ Fecha ${fd}/${fm}/${fy} seleccionada y confirmada en el calendario`);
    } else {
      // Sin fecha: hacer click en el primer día disponible
      await page.evaluate(() => {
        const cells = Array.from(document.querySelectorAll('td'));
        const day = cells.find(c => /^\d{1,2}$/.test(c.textContent.trim()) && c.offsetParent && !c.classList.contains('disabled'));
        if (day) day.click();
      });
    }
    await page.waitForTimeout(900);

    // ⚠️ Elegir el día YA avanza el wizard al paso del monto. Pulsar "Siguiente"
    // aquí sin más lo empujaba un paso de más, con el monto vacío, y el portal
    // sacaba su modal de "ingresa el monto" bloqueando todo. Solo se pulsa si el
    // campo del monto todavía no está.
    const yaEnMonto = await page.$('#mat-input-1');
    if (!yaEnMonto) {
      await clickNavBtn('Siguiente');
      await page.waitForTimeout(1800);
    }
    await snap('p3_monto_form');

    // ── PASO 3: Monto de compra ───────────────────────────────────────────────
    const montoInput = await page.waitForSelector('#mat-input-1', { timeout: 8000 }).catch(() => null);
    if (!montoInput) {
      await snap('error_sin_monto_input');
      await browser.close();
      return { ok: false, msg: 'AutoZone: no apareció el campo de monto' };
    }
    await montoInput.click({ clickCount: 3 });
    await montoInput.type(totalVal, { delay: 60 });
    await page.waitForTimeout(500);
    console.log(`💰 Monto ingresado: ${totalVal}`);

    // Click Siguiente — dispara validación AJAX del ticket (barcode + fecha + monto)
    await clickNavBtn('Siguiente');
    await page.waitForTimeout(4000);
    await snap('p4_post_validacion');

    // Detectar error de ticket no encontrado
    const bodyValidacion = await page.evaluate(() => document.body.innerText);
    if (/no se encontr[oó]|no encontrado|ticket.*no.*v[aá]lid|datos.*incorrectos|verifique/i.test(bodyValidacion)) {
      console.log('⚠️ Ticket no encontrado — datos incorrectos');
      await browser.close();
      return {
        ok: false,
        error_code: 'datos_invalidos',
        msg: 'AutoZone: el ticket no fue encontrado. Verifica código de barras, fecha y monto.',
      };
    }
    if (/ya.*facturad|facturado.*previamente|ya.*fue.*generado|ya.*emitid/i.test(bodyValidacion)) {
      console.log('⚠️ Ticket ya facturado');
      await browser.close();
      return { ok: false, error_code: 'ya_facturado', msg: 'AutoZone: este ticket ya fue facturado' };
    }

    // ── PASO 3.5: la pantalla de "inicia sesión" que se cuela en medio ────────
    //
    // Después de validar el ticket, y ANTES del formulario fiscal, el portal
    // mete esta pantalla:
    //   "Probablemente ya tengamos tus datos. Si deseas precargarlos, inicia
    //    sesión con tu cuenta"    [Iniciar sesión]  [Continuar sin iniciar sesión]
    //
    // El bot no la conocía: creía estar ya en el formulario fiscal, no
    // encontraba el campo de RFC (por eso salía "RFC llenado en: null"),
    // escribía el correo en el campo de LOGIN y se quedaba ahí hasta que
    // Browserless mataba la sesión — "Requesting main frame too early!".
    // Ese era el final real del ticket #142.
    //
    // Se continúa SIN cuenta: el flujo sin registro ya funciona y aquí no se
    // teclean contraseñas.
    // ⚠️ Con CLIC SINTÉTICO (page.mouse.click), no con .click() dentro de
    // evaluate. El .click() de JS no dispara el handler de Angular: la pantalla
    // se quedaba igual, el botón solo cogía el foco, y el bot seguía como si
    // hubiera avanzado. Es la misma lección que ya está anotada en
    // bots/enerfueltech.js para los MudSelect de Blazor.
    const rectLogin = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button, a, div'))
        .filter(b => /^continuar sin iniciar sesi[oó]n$/i.test((b.textContent || '').trim()))
        .find(b => b.getBoundingClientRect().width > 5 && b.offsetParent !== null);
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (rectLogin) {
      console.log('🔓 Pantalla de sesión detectada — se continúa SIN iniciar sesión');
      await page.mouse.click(rectLogin.x, rectLogin.y);
      await page.waitForTimeout(1800);
      await snap('p4b_sin_sesion');
      const sigueLogin = await page.evaluate(() =>
        /inicia sesi[oó]n con tu cuenta/i.test(document.body.innerText));
      if (sigueLogin) {
        await browser.close();
        return { ok: false, msg: 'AutoZone: no se pudo saltar la pantalla de inicio de sesión' };
      }
    }

    // ── PASO 4: Datos de Facturación — UNA PREGUNTA POR PANTALLA ─────────────
    //
    // ⚠️ Aquí estaba el error de diseño del bot. Esta parte del asistente NO es
    // un formulario con todos los campos a la vez: es una secuencia de
    // pantallas, cada una con UNA pregunta y UN control ("¿Cuál es tu RFC?",
    // "Confirmanos la forma de pago usada", …). El bot intentaba llenar RFC,
    // razón social, CP, régimen, uso de CFDI y correo de golpe, contra la
    // pantalla que hubiera en ese momento. Consecuencias medidas el 02/08/2026
    // con el ticket #142:
    //   · El RFC acabó escrito en #mat-input-4, que es "Selecciona la forma de
    //     pago" — por un fallback de "escribe en el primer input visible".
    //   · Los demás campos no se escribían en ninguna parte (todos "null").
    //   · El asistente se quedaba clavado y la sesión de Browserless moría.
    //
    // Ahora se LEE la pregunta de cada pantalla y se responde solo esa. Los
    // controles son de dos tipos:
    //   · input normal  → se teclea el valor.
    //   · autocompletar → placeholder "Selecciona …"; hay que TECLEAR para que
    //     filtre y luego pulsar la opción, que se busca POR TEXTO (no son
    //     <mat-option> pese a ser Angular Material).
    const correoCaptura = 'buzonfacturas@serviciosga.site';

    // La forma de pago sale del ticket: el #142 dice "VISADEBITO/VISADEBITO" y
    // "XXXXXXXXXXXX9913 VISA". El portal la ofrece con clave SAT ("28 - Tarjeta
    // de débito"), así que basta con filtrar por la palabra.
    const esTarjeta = /debito|débito|credito|crédito|visa|master|amex|tarjeta|chip/i.test(String(formaPagoTicket || ''));
    const esCredito = /credito|crédito/i.test(String(formaPagoTicket || ''));
    const buscado = esTarjeta ? (esCredito ? 'crédito' : 'débito') : 'efectivo';

    const RESPUESTAS = [
      // ⚠️ EL ORDEN IMPORTA: gana el primer patrón que case. "La razón social
      // asociada al RFC" contiene "RFC", así que si la regla del RFC fuera
      // antes, el RFC acabaría escrito en el campo de la razón social — pasó.
      { pregunta: /forma de pago/i,                       buscar: [buscado] },
      { pregunta: /raz[oó]n social|nombre.*fiscal|nombre del receptor/i, texto: razonSocial },
      { pregunta: /r\.?f\.?c|registro federal/i,          texto: rfc },
      { pregunta: /c[oó]digo postal|c\.?p\.?\b/i,         texto: codigoPostal },
      // El desplegable puede listar la clave, la descripción o ambas: se
      // prueban varias formas de nombrar lo mismo antes de rendirse.
      { pregunta: /r[eé]gimen/i,                          buscar: [String(regimenFiscal || '601'), 'General de Ley Personas Morales', 'Personas Morales'] },
      { pregunta: /uso.*(cfdi|factura)|para qu[eé]/i,     buscar: [String(usoCfdi || 'G03'), 'Gastos en general'] },
      { pregunta: /correo|e-?mail/i,                      texto: correoCaptura },
      // Domicilio fiscal: el asistente lo pide al final (68-84%), en pantallas
      // aparte. Sin estas reglas el bot llegaba hasta ahí y se quedaba mirando
      // campos que no sabía contestar ("No. Exterior", "Delegación o municipio").
      { pregunta: /delegaci[oó]n|municipio/i,             texto: municipio },
      { pregunta: /no\.?\s*exterior|n[uú]mero exterior/i, texto: ext || 'S/N' },
      { pregunta: /no\.?\s*interior|n[uú]mero interior/i, texto: numInt || 'S/N' },
      { pregunta: /colonia/i,                             texto: colonia },
      { pregunta: /calle/i,                               texto: calle },
      { pregunta: /estado|entidad/i,                      texto: estado },
    ];

    // Devuelve las líneas candidatas a ser el enunciado, sin la barra lateral ni
    // la navegación. Ojo: entre ellas también caen las OPCIONES del
    // autocompletar ("28 - Tarjeta de débito"), así que quedarse con la última
    // línea larga no vale — hay que dejar que el llamador busque un patrón.
    const lineasPantalla = () => page.evaluate(() => {
      const ignorar = /^(iniciar sesi|receipt|facturaci|help|ayuda|view_list|anterior|siguiente|\d+%|datos de|bienvenido|iniciar|keyboard|ver ticket|\d{2}\s*-\s)/i;
      return document.body.innerText.split('\n').map(l => l.trim())
        .filter(l => l.length > 12 && !ignorar.test(l));
    });

    // ⚠️ Devuelve TODOS los campos visibles, no solo el primero.
    //
    // Los pasos 1-3 son de una pregunta por pantalla, pero el de datos fiscales
    // apila varios campos con su rótulo encima: correo, RFC, régimen y uso de
    // CFDI, todos a la vez. Con la versión de "un solo control" el bot rellenaba
    // el correo una y otra vez y el asistente se quedaba clavado en el 45%.
    //
    // El rótulo se asocia por POSICIÓN: es el texto visible que queda justo
    // encima del campo y alineado con él. No hay <label for> utilizable.
    const controlesVisibles = () => page.evaluate(() => {
      const textos = Array.from(document.querySelectorAll('div, span, p, h1, h2, h3'))
        .filter(e => e.offsetParent !== null && e.children.length === 0 && (e.textContent || '').trim().length > 8)
        .map(e => ({ txt: e.textContent.trim(), r: e.getBoundingClientRect() }));
      // Hay TRES tipos de control en este asistente y hace falta distinguirlos:
      //   · input normal      → se teclea el valor
      //   · input autocompletar (placeholder "Selecciona …") → teclear filtra
      //   · <mat-select>      → NO es un <input>; se abre con clic y se elige
      // Buscar solo 'input' dejaba fuera el régimen fiscal, que se quedaba en
      // rojo con "Campo Obligatorio" y bloqueaba el asistente en el 45%.
      const nodos = Array.from(document.querySelectorAll('input, mat-select, .mat-select'));
      return nodos
        .filter(i => i.offsetParent !== null && i.type !== 'hidden' && i.getBoundingClientRect().width > 40)
        .map((i, idx) => {
          const r = i.getBoundingClientRect();
          const arriba = textos
            .filter(t => t.r.bottom <= r.top + 4 && r.top - t.r.bottom < 70 && Math.abs(t.r.left - r.left) < 120)
            .sort((a, b) => b.r.bottom - a.r.bottom)[0];
          const esSelect = i.tagName.toLowerCase() !== 'input';
          return {
            idx,
            x: r.x + r.width / 2,
            y: r.y + r.height / 2,
            esSelect,
            placeholder: i.placeholder || i.getAttribute('data-placeholder') || '',
            etiqueta: arriba ? arriba.txt : '',
            valor: esSelect ? (i.textContent || '').trim() : (i.value || '').trim(),
          };
        });
    });

    // `candidatos` son varias formas de nombrar la MISMA opción: el portal a
    // veces lista "601", a veces "General de Ley Personas Morales". Se prueban
    // en orden y se elige la primera que aparezca de verdad en la lista.
    const opcionesEnPantalla = () => page.evaluate(() =>
      Array.from(document.querySelectorAll('mat-option, .mat-option, li, div, span'))
        .filter(o => o.offsetParent !== null && o.children.length === 0 && o.getBoundingClientRect().width > 20)
        .map(o => (o.textContent || '').trim())
        .filter(t => t.length > 2 && t.length < 80));

    const elegirDeLista = async (candidatos, teclear = true) => {
      const lista = [].concat(candidatos).filter(Boolean);
      for (const filtro of lista) {
        if (teclear && filtro) {
          await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
          await page.keyboard.type(filtro, { delay: 55 });
        }
        await page.waitForTimeout(600);
        const rect = await page.evaluate((f) => {
          const o = Array.from(document.querySelectorAll('mat-option, .mat-option, li, div, span'))
            .filter(o => o.offsetParent !== null && o.children.length === 0 && o.getBoundingClientRect().width > 20)
            .find(o => (o.textContent || '').toLowerCase().includes(f.toLowerCase()));
          if (!o) return null;
          const r = o.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2, txt: o.textContent.trim() };
        }, filtro);
        if (rect) {
          await page.mouse.click(rect.x, rect.y);
          await page.waitForTimeout(600);
          return rect.txt;
        }
      }
      return null;
    };

    // El modal "Elige la forma de pago…" / "Ingresa…" bloquea todo hasta que se
    // acepta. Aparece cuando se pulsa Siguiente sin haber respondido.
    const cerrarModal = async () => {
      const r = await page.evaluate(() => {
        const b = Array.from(document.querySelectorAll('button, div'))
          .find(b => /^ok$/i.test((b.textContent || '').trim()) && b.offsetParent !== null && b.getBoundingClientRect().width > 5);
        if (!b) return null;
        const q = b.getBoundingClientRect();
        return { x: q.x + q.width / 2, y: q.y + q.height / 2 };
      });
      if (!r) return false;
      await page.mouse.click(r.x, r.y);
      await page.waitForTimeout(500);
      return true;
    };

    // Bucle acotado: cada vuelta responde una pantalla. El límite existe para no
    // girar en vacío si el asistente deja de avanzar — y para no comerse el tope
    // de sesión de Browserless, que es lo que mataba al bot a mitad de camino.
    let progresoPrevio = '';
    let vueltasAlCien = 0;
    for (let vuelta = 0; vuelta < 12; vuelta++) {
      await cerrarModal();
      const lineas = await lineasPantalla();
      const progreso = await page.evaluate(() => (document.body.innerText.match(/(\d{1,3})%/) || [])[0] || '');

      // ¿Ya terminó? El asistente muestra la confirmación del CFDI al final.
      const terminado = await page.evaluate(() =>
        /factura.*(generad|emitid|exitos)|cfdi.*(generad|list)|descargar/i.test(document.body.innerText));
      if (terminado) { console.log(`🎉 El asistente llegó al final (${progreso})`); break; }

      const controles = await controlesVisibles();
      if (!controles.length) {
        // Pantalla sin campo: solo hay que avanzar.
        if (!await clickNavBtn('Siguiente')) break;
        await page.waitForTimeout(1200);
        continue;
      }

      // Se rellena TODO lo que haya en esta pantalla antes de pulsar Siguiente.
      let algoLlenado = false;
      for (const ctrl of controles) {
        const pista = `${ctrl.etiqueta} ${ctrl.placeholder}`.trim();
        const r = RESPUESTAS.find(x => x.pregunta.test(pista));
        if (!r) {
          console.log(`   ⤳ campo sin respuesta conocida: "${pista}"`);
          continue;
        }
        // Ya contestado: no se vuelve a tocar (reescribirlo reabría el
        // autocompletar y el asistente se quedaba dando vueltas).
        const esperado = String(r.texto || r.buscar || '').toLowerCase();
        if (ctrl.valor && ctrl.valor.toLowerCase().includes(esperado.slice(0, 6))) continue;

        if (ctrl.esSelect) {
          // Un mat-select no acepta escritura: se abre y se elige la opción.
          //
          // ⚠️ NO se puede clicar en ctrl.x/ctrl.y: esas coordenadas son de
          // cuando se leyó la pantalla, ANTES de rellenar los campos de arriba.
          // Al escribir el correo y el RFC el formulario crece y el régimen baja
          // varias decenas de píxeles, así que el clic caía en el vacío, el
          // panel no llegaba a abrirse y el bot listaba como "opciones
          // disponibles" el texto suelto de la página ("Anterior | Siguiente |
          // 45% | …"). Tumbó los tickets #215 ($2,456) y #228 ($399).
          // Se vuelve a localizar el control por su índice justo antes de
          // pulsarlo, y se lleva a la vista por si quedó fuera de pantalla.
          const punto = await page.evaluate((idx) => {
            const nodos = Array.from(document.querySelectorAll('input, mat-select, .mat-select'))
              .filter(i => i.offsetParent !== null && i.type !== 'hidden' && i.getBoundingClientRect().width > 40);
            const el = nodos[idx];
            if (!el) return null;
            el.scrollIntoView({ block: 'center' });
            const r = el.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          }, ctrl.idx);
          if (!punto) { console.log(`   ⚠️ el control "${pista}" desapareció de la pantalla`); continue; }
          await page.mouse.click(punto.x, punto.y);
          await page.waitForTimeout(800);

          // Si el panel no abrió, el clic no llegó: sin esto el bot se conforma
          // y culpa al portal de no tener la opción.
          const abierto = await page.evaluate(() =>
            !!document.querySelector('mat-option, .mat-option, .cdk-overlay-pane'));
          if (!abierto) {
            console.log(`   ↻ el panel de "${pista}" no abrió — reintento con teclado`);
            await page.keyboard.press('Enter').catch(() => {});
            await page.waitForTimeout(700);
          }
          const elegido = await elegirDeLista(r.buscar || r.texto, false);
          if (!elegido) {
            const disponibles = (await opcionesEnPantalla()).slice(0, 12).join(' | ');
            console.log(`   opciones disponibles: ${disponibles}`);
            await snap('error_sin_opcion_select');
            await browser.close();
            return { ok: false, msg: `AutoZone: sin opción ${JSON.stringify(r.buscar || r.texto)} en "${pista}" (había: ${disponibles})` };
          }
          console.log(`   ${progreso} ${pista} → ${elegido}`);
          algoLlenado = true;
          continue;
        }

        // Los campos de texto se escriben de golpe con el setter nativo de
        // Angular (instantáneo) en vez de tecla a tecla: son ~100 caracteres
        // entre correo, RFC, razón social y domicilio, y a 35ms cada uno eran
        // varios segundos que no sobran contra el tope de sesión. Los de
        // autocompletar SÍ necesitan tecleo real, porque es lo que dispara el
        // filtrado de la lista.
        if (!r.buscar) {
          // Por ÍNDICE, no por elementFromPoint: en las pantallas con varios
          // campos ese punto podía caer sobre un contenedor y el valor no se
          // escribía nunca — el bot lo daba por puesto, volvía a encontrarlo
          // vacío en la siguiente vuelta y se quedaba en bucle al 100%.
          await page.evaluate((idx, val) => {
            const el = Array.from(document.querySelectorAll('input, mat-select, .mat-select'))
              .filter(i => i.offsetParent !== null && i.type !== 'hidden' && i.getBoundingClientRect().width > 40)[idx];
            if (!el || el.tagName !== 'INPUT') return;
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            if (setter) setter.call(el, val); else el.value = val;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new Event('blur', { bubbles: true }));
          }, ctrl.idx, String(r.texto || ''));
          console.log(`   ${progreso} ${pista} → ${r.texto}`);
          algoLlenado = true;
          continue;
        }

        await page.mouse.click(ctrl.x, ctrl.y, { clickCount: 3 });
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(200);

        if (r.buscar) {
          const elegido = await elegirDeLista(r.buscar);
          if (!elegido) {
            await snap('error_sin_opcion');
            await browser.close();
            return { ok: false, msg: `AutoZone: sin opción "${r.buscar}" para "${pista}"` };
          }
          console.log(`   ${progreso} ${pista} → ${elegido}`);
        } else {
          await page.keyboard.type(String(r.texto || ''), { delay: 35 });
          await page.waitForTimeout(200);
          console.log(`   ${progreso} ${pista} → ${r.texto}`);
        }
        algoLlenado = true;
      }
      if (!algoLlenado && controles.every(c => !c.valor)) {
        console.log(`❓ Pantalla no reconocida (${progreso}) — campos: ${controles.map(c => `"${c.etiqueta}|${c.placeholder}"`).join(', ')}`);
        await snap('error_pantalla_desconocida');
        await browser.close();
        return { ok: false, msg: `AutoZone: pantalla no reconocida en ${progreso}` };
      }

      await clickNavBtn('Siguiente');
      await page.waitForTimeout(1100);

      // Si el progreso no se mueve dos veces seguidas, algo se atascó.
      const nuevo = await page.evaluate(() => (document.body.innerText.match(/(\d{1,3})%/) || [])[0] || '');

      // Al 100% ya no queda nada que responder: el asistente deja de tener
      // "Siguiente" y lo que toca es pulsar el botón de generar la factura, que
      // se maneja fuera del bucle. Sin esta salida el bot seguía dándole a
      // Siguiente y se declaraba a sí mismo atascado teniendo todo relleno.
      if (progreso === '100%' && (!algoLlenado || vueltasAlCien++ >= 1)) {
        console.log('✅ Todos los datos capturados — el asistente está al 100%');
        break;
      }

      if (nuevo === progreso && progreso === progresoPrevio) {
        await snap('error_asistente_atascado');
        await browser.close();
        return { ok: false, msg: `AutoZone: el asistente se quedó atascado en ${progreso}` };
      }
      progresoPrevio = progreso;
    }
    await snap('p5_fiscal_llenado');
    // Click Siguiente / Generar / Facturar
    const generarOk = await clickNavBtn('Siguiente');
    if (!generarOk) {
      // Buscar botón de generación por texto
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, a'));
        const btn = btns.find(b => /generar|facturar|emitir/i.test(b.textContent || ''));
        if (btn) btn.click();
      });
    }
    await page.waitForTimeout(4000);
    await snap('p6_resultado_final');

    const bodyFinal = await page.evaluate(() => document.body.innerText);

    if (/error|no.*pudo.*generar|falla.*factura/i.test(bodyFinal) && !/exitoso|generada|emitida/i.test(bodyFinal)) {
      await browser.close();
      return { ok: false, msg: 'AutoZone: error al generar la factura' };
    }

    // Intentar descargar XML/PDF si hay links directos
    const xmlUrl = await page.evaluate(() => {
      const a = Array.from(document.querySelectorAll('a[href]')).find(a =>
        /\.xml(\?|$)|xml/i.test(a.href + ' ' + a.textContent)
      );
      return a?.href || null;
    });
    const pdfUrl = await page.evaluate(() => {
      const a = Array.from(document.querySelectorAll('a[href]')).find(a =>
        /\.pdf(\?|$)|pdf/i.test(a.href + ' ' + a.textContent)
      );
      return a?.href || null;
    });

    if (xmlUrl || pdfUrl) {
      await browser.close();
      console.log(`✅ AutoZone OK — XML: ${xmlUrl} | PDF: ${pdfUrl}`);
      return { ok: true, xmlUrl, pdfUrl };
    }

    // ⚠️ NO dar por buena la factura solo porque no hubo enlace de descarga.
    //
    // Antes se caía directo a `{ok:true, procesandoCorreo:true}`, y eso es
    // exactamente lo que dejaba tickets en "procesando_correo" para siempre:
    // el bot decía que sí, el correo no llegaba nunca porque NUNCA se generó
    // nada, y nadie se enteraba. Medido con el #142: el portal se había quedado
    // al 40% en "Confirmanos la forma de pago usada" y el bot devolvió ok:true.
    //
    // El progreso del asistente es la prueba: si sigue en "Datos de Compra" o
    // por debajo del tramo final, no hay factura.
    // ⚠️ El texto exacto de AutoZone al terminar es
    //   "Se generó y envió correctamente el documento."
    // — dice "documento", no "factura", así que una regex que solo buscara
    // "factura generada" daba el trabajo por fallido cuando el CFDI YA existía.
    // Pasó con el #142: folio 995272 emitido y el bot devolviendo error.
    const seFacturo = /se gener[oó].*(correctamente|documento)|factura.*(generad|emitid|exitos)|cfdi.*(generad|list)|comprobante.*generad|descarga/i.test(bodyFinal);
    const sigueEnElAsistente = /cu[aá]l fue|confirmanos|elige la forma|ingresa (la fecha|el monto)/i.test(bodyFinal);
    if (!seFacturo || sigueEnElAsistente) {
      const paso = (bodyFinal.match(/\d{1,3}%/) || ['?'])[0];
      await snap('error_no_llego_al_final');
      await browser.close();
      return {
        ok: false,
        msg: `AutoZone: el asistente se quedó en ${paso} sin generar la factura (no hay confirmación de CFDI en pantalla)`,
      };
    }

    await browser.close();
    console.log('📧 Factura confirmada en pantalla, sin descarga directa — fallback IMAP');
    return { ok: true, procesandoCorreo: true };

  } catch (err) {
    console.error('❌ Error en bot AutoZone:', err.message);
    await snap('error').catch(() => {});
    try { await browser.close(); } catch {}
    return { ok: false, msg: err.message };
  }
}

module.exports = { facturarAutoZone };
