const { subirArchivoR2 } = require('../../storage/r2');
const unzipper = require('unzipper');

// Hace click en el botón Siguiente del paso actual.
// e-facturate usa botones dinámicos — intenta por texto, luego por clase Bootstrap.
async function clickSiguiente(page) {
  const clicked = await page.evaluate(() => {
    const candidatos = Array.from(document.querySelectorAll('button, input[type="submit"], a.btn'));
    const btn = candidatos.find(b =>
      /siguiente/i.test((b.textContent || '') + (b.value || ''))
    );
    if (btn) { btn.click(); return 'siguiente'; }
    const primary = document.querySelector('button.btn-primary, input[type="submit"].btn-primary');
    if (primary) { primary.click(); return 'primary'; }
    return null;
  });
  if (!clicked) throw new Error('Benavides: no se encontró botón Siguiente');
  await new Promise(r => setTimeout(r, 1000));
}

// Llena el CP y dispara blur (onblur="Salida(this,1)") para que el portal
// haga lookup AJAX de colonia. Espera 1.5s para que cargue la respuesta.
async function llenarCodigoPostal(page, context) {
  const cp = context.codigoPostal || '';
  if (!cp) return;
  await page.evaluate((v) => {
    const input = document.querySelector('#txt_ccp');
    if (!input) return;
    input.value = v;
    input.dispatchEvent(new Event('input',  { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur',   { bubbles: true }));
  }, cp);
  await new Promise(r => setTimeout(r, 1500));
}

// Typeahead jQuery UI del catálogo SAT — escribe el código y click primera sugerencia
async function seleccionarUsoCfdi(page, context) {
  const usoCfdi = context.usoCfdi || 'G03';
  const sel = '#txt_cucfdi';

  await page.waitForSelector(sel, { visible: true, timeout: 10000 });
  await page.click(sel, { clickCount: 3 });
  await page.type(sel, usoCfdi, { delay: 80 });
  await new Promise(r => setTimeout(r, 1500));

  const clicked = await page.evaluate((code) => {
    const selectors = [
      '.ui-autocomplete .ui-menu-item',
      '.ui-autocomplete li',
      '.autocomplete-suggestions .autocomplete-suggestion',
    ];
    for (const s of selectors) {
      for (const item of document.querySelectorAll(s)) {
        if (item.textContent.includes(code)) {
          (item.querySelector('a, div') || item).click();
          return true;
        }
      }
    }
    return false;
  }, usoCfdi);

  if (!clicked) {
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
  }
  await new Promise(r => setTimeout(r, 400));
}

// Selecciona régimen fiscal por valor SAT (ej. "601")
async function seleccionarRegimen(page, context) {
  const regimen = context.regimenFiscal || '601';
  await page.evaluate((v) => {
    const sel = document.querySelector('#cbo_cregfiscal');
    if (!sel) return;
    for (const opt of sel.options) {
      if (opt.value === v || opt.text.includes(v)) {
        sel.value = opt.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return;
      }
    }
  }, regimen);
  await new Promise(r => setTimeout(r, 300));
}

// Sobreescribe el correo con el email de captura del sistema
async function cambiarCorreo(page, context) {
  const email = context.config?.datos_fijos?.email || 'buzonfacturas@serviciosga.site';
  await page.evaluate((v) => {
    const input = document.querySelector('#txt_ccorreo');
    if (!input) return;
    input.value = v;
    input.dispatchEvent(new Event('input',  { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, email);
}

// Espera paso 3 (Confirmar Datos), hace click en Siguiente,
// acepta popup de éxito y descarga ZIP con PDF+XML
async function confirmarYDescargar(page, context) {
  try {
    await page.waitForFunction(
      () => /Confirmar Datos|COMPROBANTE FISCAL|Verifica los datos|exitosamente|Enhorabuena/i
        .test(document.body.textContent),
      { timeout: 25000 }
    );
  } catch {
    return { ok: false, error_code: 'timeout', msg: 'Benavides: timeout esperando paso 3' };
  }

  const yaEnPaso4 = await page.evaluate(() =>
    /exitosamente|Enhorabuena|Descargar/i.test(document.body.textContent)
  );

  if (!yaEnPaso4) {
    const clicked = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button, input[type="submit"]'))
        .find(b => /siguiente|confirmar/i.test((b.textContent || '') + (b.value || '')));
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (!clicked) return { ok: false, error_code: 'desconocido', msg: 'Benavides: botón Siguiente no encontrado en paso 3' };
  }

  try {
    await page.waitForFunction(
      () => /exitosamente|Enhorabuena|Descargar/i.test(document.body.textContent),
      { timeout: 30000 }
    );
  } catch {
    return { ok: false, error_code: 'timeout', msg: 'Benavides: timeout esperando generación de factura' };
  }

  // Cerrar popup "La factura se generó exitosamente"
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"]'))
      .find(b => /aceptar|ok/i.test((b.value || '') + b.textContent));
    if (btn) btn.click();
  });
  await new Promise(r => setTimeout(r, 1500));

  // Intentar descarga directa con los botones reales del paso 4
  const zipUrl = await page.evaluate(() => {
    // Botón "Descargar PDF + XML" (preferido)
    const btnAmbos = document.querySelector('#btn_dxmlpdf');
    if (btnAmbos) return '__btn_dxmlpdf__';
    // Fallback: cualquier link a ZIP o descarga
    const link = Array.from(document.querySelectorAll('a')).find(a =>
      /\.zip/i.test(a.href) || /download/i.test(a.href)
    );
    return link?.href || null;
  });

  if (zipUrl === '__btn_dxmlpdf__') {
    return await descargarViaBoton(page, context);
  }
  if (zipUrl) {
    return await descargarZip(page, zipUrl, context);
  }

  return { ok: true, procesandoCorreo: true };
}

async function descargarViaBoton(page, context) {
  try {
    const [download] = await Promise.all([
      new Promise(resolve => {
        page.once('response', async resp => {
          const ct = resp.headers()['content-type'] || '';
          if (ct.includes('zip') || ct.includes('octet')) resolve(resp);
        });
        setTimeout(() => resolve(null), 15000);
      }),
      page.click('#btn_dxmlpdf'),
    ]);
    if (!download) return { ok: true, procesandoCorreo: true };
    const buf = Buffer.from(await download.buffer());
    return await extraerZip(buf, context);
  } catch {
    return { ok: true, procesandoCorreo: true };
  }
}

async function descargarZip(page, zipUrl, context) {
  try {
    const resp = await page.goto(zipUrl, { waitUntil: 'networkidle2', timeout: 20000 });
    if (!resp) return { ok: true, procesandoCorreo: true };
    const buf = Buffer.from(await resp.buffer());
    if (buf.length < 100) return { ok: true, procesandoCorreo: true };
    return await extraerZip(buf, context);
  } catch {
    return { ok: true, procesandoCorreo: true };
  }
}

async function extraerZip(zipBuf, context) {
  const dir = await unzipper.Open.buffer(zipBuf);
  let pdfBuf = null, xmlBuf = null;
  for (const file of dir.files) {
    const content = await file.buffer();
    if (file.path.toLowerCase().endsWith('.pdf')) pdfBuf = content;
    else if (file.path.toLowerCase().endsWith('.xml')) xmlBuf = content;
  }
  const pdfUrl = pdfBuf
    ? await subirArchivoR2(pdfBuf, `facturas/${context.portal}_${context.ticketId}.pdf`, 'application/pdf')
    : null;
  const xmlUrl = xmlBuf
    ? await subirArchivoR2(xmlBuf, `facturas/${context.portal}_${context.ticketId}.xml`, 'application/xml')
    : null;
  if (!pdfUrl && !xmlUrl) return { ok: true, procesandoCorreo: true };
  return { ok: true, xmlUrl, pdfUrl };
}

module.exports = {
  clickSiguiente,
  llenarCodigoPostal,
  seleccionarUsoCfdi,
  seleccionarRegimen,
  cambiarCorreo,
  confirmarYDescargar,
};
