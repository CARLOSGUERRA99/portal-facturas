const { subirArchivoR2 } = require('../../storage/r2');

async function llenarFecha(page, context) {
  await page.waitForSelector('#form-field-Fecha', { visible: true });
  const fechaISO = parseFecha(context.fecha);
  await page.$eval('#form-field-Fecha', (el, v) => {
    el.focus();
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
  }, fechaISO);
}

async function seleccionarFormaPago(page) {
  await page.$eval('#form-field-FormaPago', el => {
    el.value = '28';
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function seleccionarCfdiYRegimen(page, context) {
  await page.$eval('#form-field-cmbUsoCFDI', (el, v) => {
    el.value = v;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, context.usoCfdi || 'G03');

  await page.$eval('#form-field-Regimen', (el, v) => {
    el.value = v;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, context.regimenFiscal || '601');
}

async function llenarCorreoCaptura(page, context) {
  const email = context.config?.datos_fijos?.email || 'buzonfacturas@serviciosga.site';
  await page.waitForSelector('#form-field-Correo', { visible: true });
  await page.$eval('#form-field-Correo', (el, v) => {
    el.click();
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, email);
}

// Espera éxito (#btnPdf) o error "ya facturado" y actúa en consecuencia
async function esperarResultadoYDescargar(page, context) {
  const resultado = await Promise.race([
    page.waitForSelector('#btnPdf', { visible: true, timeout: 30000 })
      .then(() => 'exito'),
    page.waitForFunction(
      () => document.body.innerText.includes('ya se encuentra facturado') ||
            document.body.innerText.includes('ya fue facturado') ||
            document.body.innerText.includes('already invoiced'),
      { timeout: 30000 }
    ).then(() => 'ya_facturado'),
  ]).catch(() => 'timeout');

  if (resultado === 'timeout') {
    return { ok: false, error_code: 'timeout', msg: 'Rendichicas: timeout esperando resultado' };
  }
  if (resultado === 'ya_facturado') {
    return await recuperarDesdeHistorial(page, context);
  }
  return await descargarArchivos(page, context);
}

// Cuando el ticket ya fue facturado: ir a MIS FACTURAS y descargar de la tabla
async function recuperarDesdeHistorial(page, context) {
  // Clic en "MIS FACTURAS" del nav
  await page.evaluate(() => {
    const link = Array.from(document.querySelectorAll('a, button'))
      .find(el => el.textContent.trim().toUpperCase().includes('MIS FACTURAS'));
    if (link) link.click();
  });

  // Esperar campo RFC del historial
  await page.waitForSelector('input[type="text"], input[placeholder*="RFC"]', { visible: true, timeout: 15000 });
  await new Promise(r => setTimeout(r, 800));

  // Llenar RFC
  await page.evaluate((rfc) => {
    const input = document.querySelector('input[ng-model*="rfc"], input[placeholder*="RFC"], input[type="text"]');
    if (!input) return;
    input.value = rfc;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, context.rfc);

  // Llenar fechas: ticket date → hoy
  const ticketDate = context.fecha || new Date().toISOString().split('T')[0];
  const today = new Date().toISOString().split('T')[0];
  const dateInputs = await page.$$('input[type="date"]');
  if (dateInputs[0]) await dateInputs[0].$eval('', () => {}).catch(() =>
    page.$eval('input[type="date"]:first-of-type', (el, v) => {
      el.value = v;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, ticketDate)
  );
  // Forma más directa para los date inputs
  for (let i = 0; i < dateInputs.length; i++) {
    const val = i === 0 ? ticketDate : today;
    await page.evaluate((el, v) => {
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, dateInputs[i], val);
  }

  // Click Consultar
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button'))
      .find(b => /consultar/i.test(b.textContent));
    if (btn) btn.click();
  });

  // Esperar tabla de resultados
  await page.waitForSelector('table tbody tr', { visible: true, timeout: 15000 });
  await new Promise(r => setTimeout(r, 500));

  // Descargar PDF y XML de la primera fila
  // Columnas: Estacion(0) Folio(1) Serie(2) Fecha(3) Estatus(4) Total(5) PDF(6) XML(7)
  // Estrategia: href directo del anchor → window.open interception → null
  const descargarColumna = async (colIndex, ext, mime) => {
    const url = await page.evaluate((idx) => {
      return new Promise(resolve => {
        const cells = document.querySelectorAll('table tbody tr:first-child td');
        const el = cells[idx]?.querySelector('a, button, img, span');
        if (!el) { resolve(null); return; }

        // Si es un anchor con href directo (no javascript:), úsalo sin interceptar
        if (el.tagName === 'A' && el.href && !el.href.toLowerCase().startsWith('javascript')) {
          resolve(el.href); return;
        }

        // Fallback: interceptar window.open
        const orig = window.open;
        window.open = (u) => { window.open = orig; resolve(u || null); return null; };
        el.click();
        setTimeout(() => { window.open = orig; resolve(null); }, 5000);
      });
    }, colIndex).catch(() => null);

    if (!url) return null;
    try {
      const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
      if (!resp) return null;
      const buf = Buffer.from(await resp.buffer());
      if (buf.length < 100) return null;
      return subirArchivoR2(buf, `facturas/${context.portal}_${context.ticketId}.${ext}`, mime);
    } catch { return null; }
  };

  const pdfUrl = await descargarColumna(6, 'pdf', 'application/pdf');
  await new Promise(r => setTimeout(r, 800));
  const xmlUrl = await descargarColumna(7, 'xml', 'application/xml');

  if (!pdfUrl && !xmlUrl) return { ok: true, procesandoCorreo: true };
  return { ok: true, xmlUrl, pdfUrl };
}

// Descarga desde la pantalla de éxito interceptando window.open de AngularJS
async function descargarArchivos(page, context) {
  const descargarUno = async (btnSelector, idFallback, ext, mime) => {
    const url = await page.evaluate((sel, idFb) => {
      return new Promise(resolve => {
        const orig = window.open;
        window.open = (u) => { window.open = orig; resolve(u || null); return null; };
        const btn = document.querySelector(sel) || document.querySelector(idFb);
        if (btn) btn.click(); else resolve(null);
        setTimeout(() => { window.open = orig; resolve(null); }, 5000);
      });
    }, btnSelector, idFallback).catch(() => null);

    if (!url) return null;
    try {
      const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
      if (!resp) return null;
      const buf = Buffer.from(await resp.buffer());
      if (buf.length < 100) return null;
      return subirArchivoR2(buf, `facturas/${context.portal}_${context.ticketId}.${ext}`, mime);
    } catch { return null; }
  };

  const pdfUrl = await descargarUno('[ng-click="descargarPDFStep4()"]', '#btnPdf', 'pdf', 'application/pdf');
  await new Promise(r => setTimeout(r, 800));
  const xmlUrl = await descargarUno('[ng-click="descargarXMLStep4()"]', '#btnXml', 'xml', 'application/xml');

  if (!pdfUrl && !xmlUrl) return { ok: true, procesandoCorreo: true };
  return { ok: true, xmlUrl, pdfUrl };
}

function parseFecha(fecha) {
  if (!fecha) return new Date().toISOString().split('T')[0];
  if (/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return fecha;
  const p = fecha.split(/[\/\-]/);
  if (p.length === 3 && p[2].length === 4)
    return `${p[2]}-${p[1].padStart(2, '0')}-${p[0].padStart(2, '0')}`;
  return fecha;
}

module.exports = {
  llenarFecha,
  seleccionarFormaPago,
  seleccionarCfdiYRegimen,
  llenarCorreoCaptura,
  esperarResultadoYDescargar,
  recuperarDesdeHistorial,
  descargarArchivos,
};
