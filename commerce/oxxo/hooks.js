const { subirArchivoR2 } = require('../../storage/r2');

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
      () => /facturado previamente|el ticket fue facturado/i
            .test(document.body.innerText || ''),
      { timeout: 15000 }
    ).then(() => 'ya_facturado'),
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

  // Loguear todos los elementos que dicen "Continuar" para identificar el correcto
  const continurBtns = await page.evaluate(() =>
    Array.from(document.querySelectorAll('button, a, input[type="submit"], span'))
      .filter(el => el.textContent?.trim().toLowerCase().includes('continuar'))
      .map(el => ({ tag: el.tagName, id: el.id, class: el.className, disabled: el.disabled, text: el.textContent.trim().substring(0, 30) }))
  ).catch(() => []);
  console.log('[OXXO][DEBUG] Botones Continuar encontrados:', JSON.stringify(continurBtns));

  // Click Continuar via evaluate (ignora overlays como el chatbot GINA)
  await page.evaluate(() => {
    const btn = document.querySelector('#form\\:continuar');
    if (btn) btn.click();
  });
  await page.waitForTimeout(2000);

  // RFC — polling hasta que se habilite (el AJAX del Continuar lo activa)
  let rfcSel = null;
  for (let i = 0; i < 40; i++) {
    rfcSel = await page.evaluate(() => {
      window.scrollBy(0, 1); window.scrollBy(0, -1);
      const el = document.querySelector('#form\\:rfc');
      if (el && !el.disabled) return '#form\\:rfc';
      return null;
    });
    if (rfcSel) break;
    await page.waitForTimeout(300);
  }
  if (!rfcSel) throw new Error('Campo RFC no se habilitó tras seleccionar País');

  await page.click(rfcSel, { clickCount: 3 });
  await page.keyboard.type(rfc, { delay: 100 });
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur',   { bubbles: true }));
  }, rfcSel);
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
async function generarYEnviar(page, context) {
  const ticketId = context?.ticketId || 'unknown';
  const snap = async (label) => {
    try {
      const buf = await page.screenshot({ fullPage: false });
      const url = await subirArchivoR2(buf, `debug/oxxo_${ticketId}_${label}_${Date.now()}.png`, 'image/png');
      console.log(`[OXXO] Screenshot ${label}:`, url);
    } catch {}
  };

  // Click via evaluate — ignora overlay GINA
  await page.evaluate(() => {
    const btn = document.querySelector('#form\\:generarFactura');
    if (btn) btn.click();
  });
  await page.waitForTimeout(5000);

  // Esperar diálogo con opciones (email / PDF / XML)
  await page.waitForFunction(() => {
    const body = document.body.innerText;
    return body.includes('Descargar PDF') || body.includes('Descargar XML') ||
           body.includes('Enviar correo')  || body.includes('Envía o descarga') ||
           body.includes('correo electrónico') || body.includes('enviar');
  }, { timeout: 25000 });

  await page.waitForTimeout(1500);
  await snap('generacion_dialogo');

  // Llenar email y enviar
  const emailInput = await page.$(
    'input[type="email"], input[placeholder*="orreo"], input[placeholder*="ORREO"], input[id*="mail"]'
  );
  if (emailInput) {
    await emailInput.click({ clickCount: 3 });
    await emailInput.type('buzonfacturas@serviciosga.site', { delay: 50 });
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('a, button, input[type="submit"], span'));
      const btn = btns.find(b =>
        b.textContent?.toLowerCase().includes('enviar') ||
        b.value?.toLowerCase().includes('enviar')
      );
      if (btn) btn.click();
    });
    await page.waitForTimeout(3000);
    await snap('generacion_postenvio');
  } else {
    await snap('generacion_sin_emailinput');
  }

  // Intentar también descargar PDF y XML si están en el mismo diálogo
  // (pueden abrirse en nueva pestaña; si fallan, IMAP cubre el correo)
  const browser = page.browser();
  const newTabPromise = new Promise(resolve => {
    browser.once('targetcreated', async t => {
      try {
        const p = await t.page();
        await p.waitForTimeout(2000);
        const xmlBuf = await p.evaluate(() => document.body.innerText).catch(() => null);
        resolve({ page: p, text: xmlBuf });
      } catch { resolve(null); }
    });
    setTimeout(() => resolve(null), 8000);
  });

  await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a, button'));
    const xml = links.find(l => l.textContent?.includes('XML') || l.href?.includes('.xml'));
    if (xml) xml.click();
  });

  const newTab = await newTabPromise;
  if (newTab?.page) {
    try { await newTab.page.close(); } catch {}
  }

  return { ok: true, procesandoCorreo: true };
}

// ── Recuperador: reimpresión de factura ya generada ──────────────────────────
async function reimprimir(page, context) {
  const { folio, idVenta, totalDecimal, ticketId } = context;

  console.log(`[OXXO][reimprimir] Navegando a reimpresión para folio ${folio}`);
  await page.goto(
    'https://www4.oxxo.com:9443/facturacionElectronica-web/views/layout/reimpresionFactura.do',
    { waitUntil: 'load', timeout: 30000 }
  );
  await page.waitForTimeout(1500);

  // Fecha — reutilizar misma lógica del datepicker
  await seleccionarFecha(page, context);

  // Folio, Venta, Total
  await page.click('#form\\:folio', { clickCount: 3 });
  await page.type('#form\\:folio', String(folio), { delay: 60 });
  await page.click('#form\\:venta', { clickCount: 3 });
  await page.type('#form\\:venta', String(idVenta).toUpperCase(), { delay: 60 });
  await page.click('#form\\:total', { clickCount: 3 });
  await page.type('#form\\:total', totalDecimal, { delay: 60 });
  await page.waitForTimeout(300);

  // Verificar — buscar botón por texto (el id j_idt* cambia con cada deploy)
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button, input[type="submit"], span'))
      .find(b => b.textContent?.trim() === 'Verificar' || b.value?.includes('Verificar'));
    if (btn) btn.click();
  });

  // Portal tarda ~10s en encontrar la factura
  await page.waitForTimeout(10000);

  // Screenshot para diagnóstico
  try {
    const buf = await page.screenshot({ fullPage: false });
    const url = await subirArchivoR2(buf, `debug/oxxo_${ticketId}_reimprimir_${Date.now()}.png`, 'image/png');
    console.log('[OXXO][reimprimir] Screenshot:', url);
  } catch {}

  const encontrado = await page.evaluate(() => {
    const body = document.body.innerText;
    return body.includes('ha sido encontrada') || body.includes('Enviar correo') ||
           body.includes('Descargar PDF') || body.includes('Descargar XML');
  });

  if (!encontrado) {
    console.log('[OXXO][reimprimir] Factura no encontrada — folio inválido');
    return { ok: false, error_code: 'datos_invalidos', msg: 'Folio no encontrado en OXXO (ni en reimpresión).' };
  }

  console.log('[OXXO][reimprimir] Factura encontrada — descargando XML y PDF');

  const browser = page.browser();

  // Interceptar nueva pestaña para XML/PDF
  const interceptar = async (clickFn) => {
    const newPagePromise = new Promise(resolve =>
      browser.once('targetcreated', target => resolve(target.page()))
    );
    await clickFn();
    const newPage = await Promise.race([
      newPagePromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000)),
    ]).catch(() => null);
    if (!newPage) return null;
    await newPage.waitForTimeout(1500);
    const res = await newPage.waitForResponse(r => r.status() === 200, { timeout: 10000 }).catch(() => null);
    const buf = res ? await res.buffer().catch(() => null) : null;
    await newPage.close().catch(() => {});
    return buf;
  };

  // Plan A: descargar XML y PDF (se abren en nueva pestaña)
  const xmlBuf = await interceptar(() =>
    page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('a, button'))
        .find(el => el.textContent?.includes('Descargar XML') || el.href?.includes('.xml'));
      if (btn) { btn.scrollIntoView(); btn.click(); }
    })
  ).catch(() => null);

  const pdfBuf = await interceptar(() =>
    page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('a, button'))
        .find(el => el.textContent?.includes('Descargar PDF') || el.href?.includes('.pdf'));
      if (btn) { btn.scrollIntoView(); btn.click(); }
    })
  ).catch(() => null);

  if (xmlBuf || pdfBuf) {
    const extraerUUID = (buf) => {
      try {
        const xml = buf.toString('utf8');
        const m = xml.match(/UUID="([^"]+)"/i) || xml.match(/uuid="([^"]+)"/i);
        return m ? m[1].toLowerCase() : null;
      } catch { return null; }
    };
    const uuid = xmlBuf ? extraerUUID(xmlBuf) : null;
    const prefijo = `facturas/${uuid || Date.now()}`;
    const xmlUrl = xmlBuf ? await subirArchivoR2(xmlBuf, `${prefijo}.xml`, 'application/xml').catch(() => null) : null;
    const pdfUrl = pdfBuf ? await subirArchivoR2(pdfBuf, `${prefijo}.pdf`, 'application/pdf').catch(() => null) : null;
    console.log(`[OXXO][reimprimir] Plan A OK — xml: ${xmlUrl} pdf: ${pdfUrl}`);
    return { ok: true, xmlUrl, pdfUrl };
  }

  // Plan B: enviar por correo si no se pudieron interceptar los archivos
  console.log('[OXXO][reimprimir] Plan A falló — Plan B: enviar correo');
  const emailInput = await page.$('input[placeholder*="correo"], input[placeholder*="dominio"], input[type="email"]');
  if (emailInput) {
    await emailInput.click({ clickCount: 3 });
    await emailInput.type('buzonfacturas@serviciosga.site', { delay: 50 });
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button, a'))
        .find(b => b.textContent?.toLowerCase().includes('enviar correo'));
      if (btn) btn.click();
    });
    await page.waitForTimeout(2000);
    try {
      const buf2 = await page.screenshot({ fullPage: false });
      const url2 = await subirArchivoR2(buf2, `debug/oxxo_${ticketId}_reimprimir_correo_${Date.now()}.png`, 'image/png');
      console.log('[OXXO][reimprimir] Screenshot Plan B:', url2);
    } catch {}
  }
  return { ok: true, procesandoCorreo: true };
}

module.exports = { cerrarPopup, seleccionarFecha, llenarTicket, validarTicket, llenarDatosFactura, generarYEnviar, reimprimir };
