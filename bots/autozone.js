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
  barcode, referencia, folio, fecha, total,
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
    await page.waitForTimeout(4000);
    await snap('p0_inicio');

    // ── Navegar a Facturación Rápida (sin login) ────────────────────────────
    await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      const link = links.find(a => /facturaci[oó]n\s+r[aá]pida/i.test(a.textContent));
      if (link) link.click();
    });
    await page.waitForTimeout(2000);

    // ── Click en Iniciar (DIV.navigation-container animated) ─────────────────
    const iniciarOk = await clickNavBtn('Iniciar');
    if (!iniciarOk) {
      await snap('error_sin_iniciar');
      await browser.close();
      return { ok: false, msg: 'AutoZone: no se encontró el botón Iniciar en el wizard' };
    }
    await page.waitForTimeout(3000);
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
    await page.waitForTimeout(3500);
    await snap('p2_fecha_calendar');

    // ── PASO 2: Fecha de compra (calendario) ─────────────────────────────────
    // El portal muestra un calendario con <td> por día.
    // Navegar al mes/año correcto si es necesario.
    const [fy, fm, fd] = fechaVal.split('-').map(Number);
    if (fy && fm && fd) {
      await page.evaluate(async (targetY, targetM, targetD) => {
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        const meses = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
        for (let i = 0; i < 24; i++) {
          // Leer mes/año actual del calendario
          const headerEls = Array.from(document.querySelectorAll('.mat-calendar-period-button, [class*=period], [class*=header]'));
          const headerText = headerEls.map(el => el.textContent.toLowerCase()).join(' ');
          const curMonthOk = headerText.includes(meses[targetM - 1]?.substring(0, 3));
          const curYearOk  = headerText.includes(String(targetY));
          if (curMonthOk && curYearOk) break;
          // Navegar
          const needNext = !curYearOk || (curYearOk && !curMonthOk);
          if (needNext) {
            const nextBtn = document.querySelector('.mat-calendar-next-button, [class*=next-button]');
            const prevBtn = document.querySelector('.mat-calendar-previous-button, [class*=previous-button]');
            // Determinar si avanzar o retroceder
            const yearMatch = headerText.match(/\d{4}/);
            const curYear = yearMatch ? parseInt(yearMatch[0]) : 0;
            const curMesIdx = meses.findIndex(m => headerText.includes(m.substring(0, 3)));
            const curDate = new Date(curYear, curMesIdx < 0 ? 0 : curMesIdx, 1);
            const tgtDate = new Date(targetY, targetM - 1, 1);
            if (tgtDate > curDate && nextBtn) nextBtn.click();
            else if (prevBtn) prevBtn.click();
            await sleep(600);
          }
        }
        // Hacer click en el día correcto
        const cells = Array.from(document.querySelectorAll('td, .mat-calendar-body-cell-content'));
        const dayCell = cells.find(c =>
          c.textContent.trim() === String(targetD) &&
          c.offsetParent !== null &&
          !c.classList.contains('mat-calendar-body-disabled')
        );
        if (dayCell) dayCell.click();
      }, fy, fm, fd);
    } else {
      // Sin fecha: hacer click en el primer día disponible
      await page.evaluate(() => {
        const cells = Array.from(document.querySelectorAll('td'));
        const day = cells.find(c => /^\d{1,2}$/.test(c.textContent.trim()) && c.offsetParent && !c.classList.contains('disabled'));
        if (day) day.click();
      });
    }
    console.log(`📅 Fecha seleccionada: ${fechaVal}`);
    await page.waitForTimeout(1500);
    await clickNavBtn('Siguiente');
    await page.waitForTimeout(3500);
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
    await page.waitForTimeout(6000);
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

    // ── PASO 4: Datos de Facturación ──────────────────────────────────────────
    console.log('✅ Ticket válido — llenando datos fiscales...');
    await page.waitForTimeout(2000);

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
    await page.waitForTimeout(1500);

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
      await page.waitForTimeout(1000);
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
    await page.waitForTimeout(800);

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
    await page.waitForTimeout(8000);
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

    await browser.close();

    if (xmlUrl || pdfUrl) {
      console.log(`✅ AutoZone OK — XML: ${xmlUrl} | PDF: ${pdfUrl}`);
      return { ok: true, xmlUrl, pdfUrl };
    }

    console.log('📧 Sin descarga directa — fallback IMAP');
    return { ok: true, procesandoCorreo: true };

  } catch (err) {
    console.error('❌ Error en bot AutoZone:', err.message);
    await snap('error').catch(() => {});
    try { await browser.close(); } catch {}
    return { ok: false, msg: err.message };
  }
}

module.exports = { facturarAutoZone };
