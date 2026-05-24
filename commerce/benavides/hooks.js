const { subirArchivoR2 } = require('../../storage/r2');
const unzipper = require('unzipper');

// Typeahead jQuery UI del catálogo SAT — type código y click primera sugerencia
async function seleccionarUsoCfdi(page, context) {
  const usoCfdi = context.usoCfdi || 'G03';
  const sel = "input[placeholder*='cat']";

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
    const sel = Array.from(document.querySelectorAll('select')).find(s =>
      /regimen|fiscal/i.test(s.name + s.id)
    );
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
    const input = Array.from(document.querySelectorAll('input')).find(i =>
      /correo|email/i.test(i.name + i.id + i.type)
    );
    if (!input) return;
    input.value = v;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, email);
}

// Espera paso 3 (Confirmar Datos), hace click en Siguiente,
// acepta el popup de éxito y descarga el ZIP con PDF+XML
async function confirmarYDescargar(page, context) {
  // Esperar que cargue el paso 3 o que ya esté en paso 4
  try {
    await page.waitForFunction(
      () => /Confirmar Datos|COMPROBANTE FISCAL|Verifica los datos|exitosamente|Enhorabuena/i
        .test(document.body.textContent),
      { timeout: 25000 }
    );
  } catch {
    return { ok: false, error_code: 'timeout', msg: 'Benavides: timeout esperando paso 3' };
  }

  // Si aún no llegamos al paso 4, hacer click en Siguiente del paso 3
  const yaEnPaso4 = await page.evaluate(() =>
    /exitosamente|Enhorabuena|Descargar/i.test(document.body.textContent)
  );

  if (!yaEnPaso4) {
    const clicked = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('input[type="submit"], button'))
        .find(b => /siguiente|confirmar/i.test(b.value + b.textContent));
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (!clicked) return { ok: false, error_code: 'desconocido', msg: 'Benavides: botón Siguiente no encontrado en paso 3' };
  }

  // Esperar popup o paso 4
  try {
    await page.waitForFunction(
      () => /exitosamente|Enhorabuena|Descargar/i.test(document.body.textContent),
      { timeout: 30000 }
    );
  } catch {
    return { ok: false, error_code: 'timeout', msg: 'Benavides: timeout esperando generación de factura' };
  }

  // Cerrar popup "La factura se generó exitosamente" si aparece
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"]'))
      .find(b => /aceptar|ok/i.test(b.value + b.textContent));
    if (btn) btn.click();
  });
  await new Promise(r => setTimeout(r, 1500));

  // Esperar enlace de descarga
  try {
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll('a')).some(a =>
        /descargar/i.test(a.textContent) || /\.zip|download/i.test(a.href)
      ),
      { timeout: 15000 }
    );
  } catch {
    return { ok: true, procesandoCorreo: true };
  }

  // Obtener URL del ZIP (PDF+XML o "ambos formatos")
  const zipUrl = await page.evaluate(() => {
    const link = Array.from(document.querySelectorAll('a')).find(a =>
      (/descargar/i.test(a.textContent) && /pdf|xml|ambos/i.test(a.textContent)) ||
      /\.zip/i.test(a.href) ||
      /download/i.test(a.href)
    );
    return link?.href || null;
  });

  if (!zipUrl) return { ok: true, procesandoCorreo: true };

  try {
    const resp = await page.goto(zipUrl, { waitUntil: 'networkidle2', timeout: 20000 });
    if (!resp) return { ok: true, procesandoCorreo: true };
    const zipBuf = Buffer.from(await resp.buffer());
    if (zipBuf.length < 100) return { ok: true, procesandoCorreo: true };

    // Extraer PDF y XML del ZIP
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
  } catch (e) {
    console.error('[benavides] Error descargando ZIP:', e.message);
    return { ok: true, procesandoCorreo: true };
  }
}

module.exports = { seleccionarUsoCfdi, seleccionarRegimen, cambiarCorreo, confirmarYDescargar };
