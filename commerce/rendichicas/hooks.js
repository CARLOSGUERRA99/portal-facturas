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

// Descarga PDF y XML interceptando nueva pestaña o respuesta en página
async function descargarArchivos(page, context) {
  const browser = page.browser();

  const interceptar = (ngClick, ext, mime) =>
    new Promise(resolve => {
      const onTarget = async target => {
        if (target.type() !== 'page') return;
        const np = await target.page();
        try {
          await np.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
          const resp = await np.goto(np.url(), { waitUntil: 'networkidle2' }).catch(() => null);
          if (resp) {
            const buf = Buffer.from(await resp.buffer());
            if (buf.length > 100) {
              const key = `facturas/${context.portal}_${context.ticketId}.${ext}`;
              resolve(subirArchivoR2(buf, key, mime));
              return;
            }
          }
        } catch {}
        await np.close().catch(() => {});
        resolve(null);
      };

      const onResp = async response => {
        const ct = response.headers()['content-type'] || '';
        if ((ext === 'pdf' && ct.includes('pdf')) ||
            (ext === 'xml' && (ct.includes('xml') || ct.includes('octet')))) {
          try {
            const buf = Buffer.from(await response.buffer());
            if (buf.length > 100) {
              browser.removeListener('targetcreated', onTarget);
              const key = `facturas/${context.portal}_${context.ticketId}.${ext}`;
              resolve(subirArchivoR2(buf, key, mime));
            }
          } catch {}
        }
      };

      browser.once('targetcreated', onTarget);
      page.once('response', onResp);
      page.click(`[ng-click="${ngClick}"]`).catch(() => {});
      setTimeout(() => {
        browser.removeListener('targetcreated', onTarget);
        page.removeListener('response', onResp);
        resolve(null);
      }, 8000);
    });

  const pdfUrl = await interceptar('descargarPDFStep4()', 'pdf', 'application/pdf');
  await new Promise(r => setTimeout(r, 1000));
  const xmlUrl = await interceptar('descargarXMLStep4()', 'xml', 'application/xml');

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

module.exports = { llenarFecha, seleccionarFormaPago, seleccionarCfdiYRegimen, descargarArchivos };
