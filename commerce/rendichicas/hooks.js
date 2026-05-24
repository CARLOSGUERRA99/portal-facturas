const { subirArchivoR2 } = require('../../storage/r2');

// Fecha: el campo tiene onfocus que cambia type a 'date' — no se puede escribir directo
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

// Select AngularJS: asignar .value + disparar change
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

// Siempre usa el correo de captura del config, ignorando datos.email del usuario
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

// Intercepta window.open que dispara AngularJS al descargar, navega directo a la URL
async function descargarArchivos(page, context) {
  const descargarUno = async (btnSelector, idFallback, ext, mime) => {
    const url = await page.evaluate((sel, idFb) => {
      return new Promise((resolve) => {
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
  descargarArchivos,
};
