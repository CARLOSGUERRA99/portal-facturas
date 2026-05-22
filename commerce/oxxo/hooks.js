// ── Cerrar popup inicial si aparece ─────────────────────────────────────────
async function cerrarPopup(page) {
  try {
    await page.waitForSelector('.ui-dialog-titlebar-close', { timeout: 6000 });
    await page.evaluate(() => {
      document.querySelectorAll('.ui-dialog-titlebar-close, .ui-dialog-titlebar-icon')
        .forEach(b => b.click());
    });
    await page.waitForTimeout(500);
    const aun = await page.evaluate(() => {
      const d = document.querySelector('.ui-dialog');
      return d && d.style.display !== 'none';
    });
    if (aun) { await page.keyboard.press('Escape'); await page.waitForTimeout(300); }
  } catch {
    // No apareció popup — ok
  }
}

// ── Datepicker jQuery UI: navegar al mes/año correcto y seleccionar el día ───
async function seleccionarFecha(page, context) {
  const { fechaDMY } = context;
  const [dStr, mStr, yStr] = fechaDMY.split('/');
  const dia = parseInt(dStr);
  const mes = parseInt(mStr) - 1; // 0-based
  const anio = parseInt(yStr);

  await page.waitForSelector('#form\\:fecha_input', { timeout: 15000 });
  await page.click('#form\\:fecha_input');
  await page.waitForTimeout(500);

  await page.evaluate(async (dia, mes, anio) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const meses = ['enero','febrero','marzo','abril','mayo','junio','julio',
                   'agosto','septiembre','octubre','noviembre','diciembre'];
    for (let i = 0; i < 24; i++) {
      const mesSpan  = document.querySelector('.ui-datepicker-month');
      const anioSpan = document.querySelector('.ui-datepicker-year');
      if (!mesSpan || !anioSpan) break;
      const mesIdx     = meses.indexOf(mesSpan.textContent.toLowerCase().trim());
      const anioActual = parseInt(anioSpan.textContent);
      if (mesIdx === mes && anioActual === anio) break;
      const target  = new Date(anio, mes, 1);
      const current = new Date(anioActual, mesIdx < 0 ? 0 : mesIdx, 1);
      if (target < current) document.querySelector('.ui-datepicker-prev')?.click();
      else document.querySelector('.ui-datepicker-next:not(.ui-state-disabled)')?.click();
      await sleep(300);
    }
    const celdas = document.querySelectorAll(
      '.ui-datepicker-calendar td[data-handler="selectDay"]'
    );
    for (const c of celdas) {
      const link = c.querySelector('a');
      if (link && parseInt(link.textContent) === dia) { link.click(); break; }
    }
  }, dia, mes, anio);

  await page.waitForTimeout(800);

  // Cerrar datepicker si quedó abierto
  const calAbierto = await page.$('.ui-datepicker:not([style*="display: none"])');
  if (calAbierto) {
    await page.click('#form\\:fecha_input');
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }

  // Fallback: escribir fecha directo si el picker no la tomó
  const valor = await page.$eval('#form\\:fecha_input', el => el.value).catch(() => '');
  if (!valor) {
    await page.evaluate((f) => {
      const input = document.querySelector('#form\\:fecha_input');
      if (!input) return;
      input.removeAttribute('readonly');
      input.value = f;
      ['input','change','blur'].forEach(ev =>
        input.dispatchEvent(new Event(ev, { bubbles: true }))
      );
    }, fechaDMY);
    await page.waitForTimeout(500);
  }
}

// ── Folio, ID Venta y Total ───────────────────────────────────────────────────
async function llenarTicket(page, context) {
  const { folio, idVenta, totalDecimal } = context;

  await page.click('#form\\:folio', { clickCount: 3 });
  await page.type('#form\\:folio', String(folio), { delay: 60 });
  await page.waitForTimeout(150);

  await page.click('#form\\:venta', { clickCount: 3 });
  await page.type('#form\\:venta', String(idVenta).toUpperCase(), { delay: 60 });
  await page.waitForTimeout(150);

  await page.click('#form\\:total', { clickCount: 3 });
  await page.type('#form\\:total', totalDecimal, { delay: 60 });
  await page.waitForTimeout(150);
}

// ── Validar Ticket (botón PrimeFaces por texto) ──────────────────────────────
async function validarTicket(page, context) {
  await page.evaluate(() => {
    const spans = Array.from(document.querySelectorAll('span'));
    const btn = spans.find(s => s.textContent.trim() === 'Validar Ticket');
    if (btn) btn.click();
  });

  const resultado = await Promise.race([
    page.waitForFunction(
      () => { const b = document.querySelector('#form\\:continuar'); return b && !b.disabled; },
      { timeout: 15000 }
    ).then(() => 'continuar'),
    page.waitForFunction(
      () => /no tuvo éxito|no encontr|folio.*no.*valid|favor de volver/i.test(document.body.innerText || ''),
      { timeout: 15000 }
    ).then(() => 'folio_no_disponible'),
  ]).catch(() => 'timeout');

  if (resultado === 'timeout') {
    throw new Error('Timeout validando ticket OXXO — portal no respondió');
  }

  context.resultadoValidacion = resultado;
}

// ── RFC, Razón Social, Dirección, CP, Estado, Régimen, CFDI ─────────────────
async function llenarDatosFactura(page, context) {
  const { rfc, razonSocial, calle, ext, int: intNum, colonia, municipio, estado,
          codigoPostal, regimenFiscal, usoCfdi, config } = context;
  const estadoVal = estado || config.defaults?.estado || 'SONORA';

  // Continuar usa AJAX parcial PrimeFaces — no hay navegación completa
  await page.click('#form\\:continuar');
  await page.waitForTimeout(2000);

  // Cerrar chatbot GINA si apareció (bloquea visualmente pero no el DOM)
  await page.evaluate(() => {
    const closeBtns = document.querySelectorAll(
      '[class*="close"][class*="chat"], [aria-label*="close"], [title*="Cerrar"], button[class*="minimiz"]'
    );
    closeBtns.forEach(b => b.click());
  }).catch(() => {});

  // Loguear todos los inputs visibles para diagnóstico
  const inputIds = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input')).map(el => ({
      id: el.id, name: el.name, disabled: el.disabled, type: el.type
    }))
  ).catch(() => []);
  console.log('[OXXO][DEBUG] inputs en página tras Continuar:', JSON.stringify(inputIds.slice(0, 20)));

  // RFC — polling flexible con múltiples selectores (el id real puede variar)
  let rfcSel = null;
  for (let i = 0; i < 40; i++) {
    rfcSel = await page.evaluate(() => {
      window.scrollBy(0, 1); window.scrollBy(0, -1);
      const sels = ['#form\\:rfc', 'input[id$="rfc"]', 'input[id*=":rfc"]',
                    'input[placeholder*="RFC"]', 'input[maxlength="13"]',
                    'input[name*="rfc"]'];
      for (const s of sels) {
        const el = document.querySelector(s);
        if (el && !el.disabled) return { sel: s, id: el.id };
      }
      return null;
    });
    if (rfcSel) break;
    await page.waitForTimeout(300);
  }
  if (!rfcSel) throw new Error('Campo RFC no encontrado ni habilitado tras Continuar');
  console.log('[OXXO][DEBUG] RFC selector encontrado:', JSON.stringify(rfcSel));

  await page.click(rfcSel.sel, { clickCount: 3 });
  await page.keyboard.type(rfc, { delay: 100 });
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur',   { bubbles: true }));
  }, rfcSel.sel);
  await page.waitForTimeout(2000);

  // Razón Social — polling hasta que se habilite
  let razonSel = null;
  for (let i = 0; i < 40; i++) {
    razonSel = await page.evaluate(() => {
      window.scrollBy(0, 1); window.scrollBy(0, -1);
      const sels = ['#form\\:razon','#form\\:razonSocial',
                    'input[name*="razon"]','input[name*="razonSocial"]',
                    'input[placeholder*="az"]','input[placeholder*="ombre"]'];
      for (const s of sels) {
        const el = document.querySelector(s);
        if (el && !el.disabled) return s;
      }
      return null;
    });
    if (razonSel) break;
    await page.waitForTimeout(300);
  }
  if (!razonSel) throw new Error('Razón social no se habilitó');
  await page.click(razonSel, { clickCount: 3 });
  await page.type(razonSel, razonSocial, { delay: 40 });
  await page.waitForTimeout(200);

  // Dirección
  await page.click('#form\\:calle',   { clickCount: 3 }); await page.type('#form\\:calle',   calle || '',        { delay: 40 });
  await page.click('#form\\:ext',     { clickCount: 3 }); await page.type('#form\\:ext',     ext   || 'S/N',     { delay: 40 });
  if (intNum) { await page.click('#form\\:int', { clickCount: 3 }); await page.type('#form\\:int', intNum, { delay: 40 }); }
  await page.click('#form\\:colonia', { clickCount: 3 }); await page.type('#form\\:colonia', colonia  || '',     { delay: 40 });
  await page.click('#form\\:dele',    { clickCount: 3 }); await page.type('#form\\:dele',    municipio || '',    { delay: 40 });

  // Código Postal + blur → carga Estado
  await page.click('#form\\:codigo', { clickCount: 3 });
  await page.keyboard.type(String(codigoPostal), { delay: 100 });
  await page.evaluate(() => {
    const el = document.querySelector('#form\\:codigo');
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur',   { bubbles: true }));
  });
  await page.waitForTimeout(2500);

  // Estado — PrimeFaces dropdown
  await page.click('#form\\:estado_label');
  await page.waitForTimeout(500);
  await page.evaluate((val) => {
    const items = document.querySelectorAll('#form\\:estado_panel li.ui-selectonemenu-item');
    for (const item of items) {
      if (item.textContent.trim().toUpperCase() === val.toUpperCase()) { item.click(); return; }
    }
  }, estadoVal);
  await page.waitForTimeout(1500);

  // Régimen Fiscal — PrimeFaces dropdown
  await page.click('#form\\:selectOneMenuRegFis_label');
  await page.waitForTimeout(500);
  await page.evaluate((rf) => {
    const items = document.querySelectorAll(
      '#form\\:selectOneMenuRegFis_panel li.ui-selectonemenu-item'
    );
    for (const item of items) {
      if (item.textContent.includes(rf) || item.textContent.includes('General de Ley')) {
        item.click(); return;
      }
    }
  }, regimenFiscal || '601');
  await page.waitForTimeout(2000);

  // Uso CFDI — PrimeFaces dropdown
  await page.click('#form\\:selectOneMenuCFDI_label');
  await page.waitForTimeout(500);
  await page.evaluate((uc) => {
    const items = document.querySelectorAll(
      '#form\\:selectOneMenuCFDI_panel li.ui-selectonemenu-item'
    );
    for (const item of items) {
      if (item.textContent.includes('Gastos en general') || item.textContent.includes(uc)) {
        item.click(); return;
      }
    }
  }, usoCfdi || 'G03');
}

// ── Generar Factura, enviar por correo → procesandoCorreo ────────────────────
async function generarYEnviar(page) {
  await page.click('#form\\:generarFactura');
  await page.waitForTimeout(5000);

  await page.waitForFunction(() => {
    const body = document.body.innerText;
    return body.includes('Descargar PDF') || body.includes('Descargar XML') ||
           body.includes('Enviar correo')  || body.includes('Envía o descarga');
  }, { timeout: 20000 });

  await page.waitForTimeout(2000);

  // Enviar por correo IMAP como respaldo principal
  const emailInput = await page.$(
    'input[type="email"], input[placeholder*="correo"], input[placeholder*="CORREO"]'
  );
  if (emailInput) {
    await emailInput.click({ clickCount: 3 });
    await emailInput.type('buzonfacturas@serviciosga.site', { delay: 50 });
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('a, button, input[type="submit"]'));
      const btn = btns.find(b =>
        b.textContent?.toLowerCase().includes('enviar') ||
        b.value?.toLowerCase().includes('enviar')
      );
      if (btn) btn.click();
    });
    await page.waitForTimeout(3000);
  }

  return { ok: true, procesandoCorreo: true };
}

module.exports = { cerrarPopup, seleccionarFecha, llenarTicket, validarTicket, llenarDatosFactura, generarYEnviar };
