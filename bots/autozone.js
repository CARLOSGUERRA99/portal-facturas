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
  const snap = async (label) => {
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
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    await page.waitForTimeout(1800);
    await snap('p0_inicio');

    // ── Navegar a Facturación Rápida (sin login) ────────────────────────────
    await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      const link = links.find(a => /facturaci[oó]n\s+r[aá]pida/i.test(a.textContent));
      if (link) link.click();
    });
    await page.waitForTimeout(900);

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

    // ── PASO 4: Datos de Facturación ──────────────────────────────────────────
    console.log('✅ Ticket válido — llenando datos fiscales...');
    await page.waitForTimeout(900);

    // RFC — buscar por formcontrolname o aria-label
    const rfcFilled = await page.evaluate((rfcVal) => {
      const sels = [
        'input[formcontrolname="rfc"]',
        'input[formcontrolname="RFC"]',
        'input[aria-label*="RFC" i]',
        'input[aria-label*="rfc" i]',
        'input[placeholder*="RFC" i]',
        'input[placeholder*="rfc" i]',
      ];
      for (const s of sels) {
        const el = document.querySelector(s);
        if (el && el.offsetParent) {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          if (setter) setter.call(el, rfcVal); else el.value = rfcVal;
          el.dispatchEvent(new Event('input',  { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new Event('blur',   { bubbles: true }));
          return s;
        }
      }
      // Fallback: primer input visible de tipo text
      const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'));
      const vis = inputs.find(el => el.offsetParent);
      if (vis) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(vis, rfcVal); else vis.value = rfcVal;
        vis.dispatchEvent(new Event('input', { bubbles: true }));
        return 'fallback:' + vis.id;
      }
      return null;
    }, rfc);
    console.log(`📋 RFC (${rfc}) llenado en: ${rfcFilled}`);
    await page.waitForTimeout(900);

    // Razón social (si existe campo separado)
    await page.evaluate((val) => {
      const sels = [
        'input[formcontrolname="razonSocial"]',
        'input[formcontrolname="nombre"]',
        'input[formcontrolname="name"]',
        'input[aria-label*="raz" i]',
        'input[aria-label*="nombre" i]',
      ];
      for (const s of sels) {
        const el = document.querySelector(s);
        if (el && el.offsetParent) {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          if (setter) setter.call(el, val); else el.value = val;
          el.dispatchEvent(new Event('input',  { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return;
        }
      }
    }, razonSocial || '');
    await page.waitForTimeout(500);

    // CP
    if (codigoPostal) {
      await page.evaluate((val) => {
        const sels = [
          'input[formcontrolname="codigoPostal"]',
          'input[formcontrolname="cp"]',
          'input[formcontrolname="zipCode"]',
          'input[aria-label*="postal" i]',
          'input[aria-label*="C.P" i]',
        ];
        for (const s of sels) {
          const el = document.querySelector(s);
          if (el && el.offsetParent) {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            if (setter) setter.call(el, val); else el.value = val;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            return;
          }
        }
      }, String(codigoPostal));
    }
    await page.waitForTimeout(500);

    // Régimen Fiscal — mat-select (Angular Material dropdown)
    if (regimenFiscal) {
      await page.evaluate(async (regimen) => {
        const sels = [
          'mat-select[formcontrolname="regimen"]',
          'mat-select[formcontrolname="regimenFiscal"]',
          'mat-select[formcontrolname="fiscal"]',
          'mat-select[aria-label*="egimen" i]',
        ];
        for (const s of sels) {
          const sel = document.querySelector(s);
          if (sel) { sel.click(); break; }
        }
        await new Promise(r => setTimeout(r, 600));
        // Buscar opción correcta en el panel
        const options = Array.from(document.querySelectorAll('mat-option, [class*=mat-option]'));
        const opt = options.find(o => o.textContent.includes(regimen) || o.textContent.includes('Personas Morales') || o.textContent.includes('601'));
        if (opt) opt.click();
      }, String(regimenFiscal));
      await page.waitForTimeout(600);
    }

    // Uso CFDI — mat-select
    await page.evaluate(async (usoCfdiVal) => {
      const sels = [
        'mat-select[formcontrolname="usoCfdi"]',
        'mat-select[formcontrolname="uso"]',
        'mat-select[formcontrolname="cfdi"]',
        'mat-select[aria-label*="uso" i]',
        'mat-select[aria-label*="cfdi" i]',
      ];
      for (const s of sels) {
        const sel = document.querySelector(s);
        if (sel) { sel.click(); break; }
      }
      await new Promise(r => setTimeout(r, 600));
      const options = Array.from(document.querySelectorAll('mat-option, [class*=mat-option]'));
      const opt = options.find(o =>
        o.textContent.includes(usoCfdiVal) ||
        o.textContent.includes('Gastos en general') ||
        o.textContent.includes('G03')
      );
      if (opt) opt.click();
    }, usoCfdi || 'G03');
    await page.waitForTimeout(600);

    // Correo — buzón de captura
    const emailFilled = await page.evaluate(() => {
      const sels = [
        'input[type="email"]',
        'input[formcontrolname="email"]',
        'input[formcontrolname="correo"]',
        'input[aria-label*="correo" i]',
        'input[aria-label*="email" i]',
      ];
      for (const s of sels) {
        const el = document.querySelector(s);
        if (el && el.offsetParent) {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          if (setter) setter.call(el, 'buzonfacturas@serviciosga.site'); else el.value = 'buzonfacturas@serviciosga.site';
          el.dispatchEvent(new Event('input',  { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return s;
        }
      }
      return null;
    });
    console.log(`📧 Correo llenado en: ${emailFilled}`);
    await page.waitForTimeout(500);
    await snap('p5_fiscal_llenado');

    // ── PASO 5: "Confirmanos la forma de pago usada" ─────────────────────────
    //
    // Otro paso que el bot no conocía. Sin resolverlo, el portal se queda al 40%
    // con el modal "Elige la forma de pago de tu compra" y NO factura nada — y
    // el bot devolvía ok:true igualmente (ver más abajo).
    //
    // El dato sale del ticket: el #142 dice "VISADEBITO/VISADEBITO" y
    // "XXXXXXXXXXXX9913 VISA", así que débito. Si el ticket no lo dice, efectivo.
    const esTarjeta = /debito|débito|credito|crédito|visa|master|amex|tarjeta|chip/i
      .test(String(formaPagoTicket || ''));
    const esCredito = /credito|crédito/i.test(String(formaPagoTicket || ''));
    const buscado = esTarjeta ? (esCredito ? 'crédito' : 'débito') : 'efectivo';

    const cerrarModal = async () => {
      const r = await page.evaluate(() => {
        const b = Array.from(document.querySelectorAll('button, div'))
          .find(b => /^ok$/i.test((b.textContent || '').trim()) && b.offsetParent !== null && b.getBoundingClientRect().width > 5);
        if (!b) return null;
        const q = b.getBoundingClientRect();
        return { x: q.x + q.width / 2, y: q.y + q.height / 2 };
      });
      if (r) { await page.mouse.click(r.x, r.y); await page.waitForTimeout(600); return true; }
      return false;
    };

    const necesitaFormaPago = await page.evaluate(() =>
      /forma de pago/i.test(document.body.innerText));
    if (necesitaFormaPago) {
      await cerrarModal();
      console.log(`💳 Forma de pago del ticket → se buscará "${buscado}"`);
      // El desplegable es un mat-select: se abre con clic sintético y las
      // opciones salen en un overlay (.mat-option), fuera del propio select.
      const sel = await page.evaluate(() => {
        const cands = Array.from(document.querySelectorAll(
          'mat-select, .mat-select, select, [role="combobox"], [role="listbox"], .mat-form-field, input[readonly]'
        )).filter(s => s.offsetParent !== null && s.getBoundingClientRect().width > 40);
        const inventario = cands.map(c => `${c.tagName.toLowerCase()}.${(typeof c.className === 'string' ? c.className : '').split(' ')[0]}="${(c.textContent || c.value || '').trim().slice(0, 25)}"`);
        // El de la forma de pago es el ÚLTIMO: arriba va el RFC.
        const s = cands[cands.length - 1];
        if (!s) return { inventario, rect: null };
        const r = s.getBoundingClientRect();
        return { inventario, rect: { x: r.x + r.width / 2, y: r.y + r.height / 2 } };
      });
      console.log(`   controles en pantalla: ${sel.inventario.join(' | ') || '(ninguno)'}`);
      const rectSel = sel.rect;
      if (rectSel) {
        await page.mouse.click(rectSel.x, rectSel.y);
        await page.waitForTimeout(1200);
        const opciones = await page.evaluate(() =>
          Array.from(document.querySelectorAll('mat-option, .mat-option'))
            .filter(o => o.offsetParent !== null).map(o => o.textContent.trim()));
        console.log(`   opciones: ${opciones.join(' | ') || '(ninguna)'}`);
        const rectOpt = await page.evaluate((txt) => {
          const o = Array.from(document.querySelectorAll('mat-option, .mat-option'))
            .filter(o => o.offsetParent !== null)
            .find(o => o.textContent.toLowerCase().includes(txt));
          if (!o) return null;
          const r = o.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }, buscado);
        if (rectOpt) {
          await page.mouse.click(rectOpt.x, rectOpt.y);
          await page.waitForTimeout(1000);
          console.log(`   ✅ forma de pago seleccionada: ${buscado}`);
        } else {
          await snap('error_forma_pago_sin_opcion');
          await browser.close();
          return { ok: false, msg: `AutoZone: no había opción de forma de pago "${buscado}" (opciones: ${opciones.join(', ')})` };
        }
      }
      await clickNavBtn('Siguiente');
      await page.waitForTimeout(2500);
      await snap('p5b_post_forma_pago');
    }

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
    const seFacturo = /factura.*(generad|emitid|exitos)|cfdi.*(generad|list)|descarga|comprobante.*generad/i.test(bodyFinal);
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
