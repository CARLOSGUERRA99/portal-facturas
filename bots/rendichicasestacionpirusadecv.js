const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

async function facturarRendichicas({
  rfc, razonSocial, regimenFiscal, usoCfdi, codigoPostal,
  folio, fecha, total, ticketId, portalUrl,
}) {
  const url = portalUrl || 'https://facturacion.rendilitros.com/';
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}&stealth=true`,
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);

  const shot = async (nombre) => {
    try {
      const buf = await page.screenshot({ fullPage: false });
      await subirArchivoR2(buf, `debug/rendichicas_${ticketId}_${nombre}_${Date.now()}.png`, 'image/png');
    } catch {}
  };

  // Llena un input AngularJS: click → seleccionar todo → escribir → disparar evento input
  async function fillNG(selector, value) {
    await page.waitForSelector(selector, { visible: true, timeout: 15000 });
    await page.click(selector, { clickCount: 3 });
    await page.keyboard.press('Delete');
    await page.keyboard.type(String(value), { delay: 40 });
    await page.$eval(selector, el => {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  // Selecciona opción de un <select> AngularJS por valor
  async function selectNG(selector, value) {
    await page.waitForSelector(selector, { visible: true, timeout: 15000 });
    await page.$eval(selector, (el, v) => {
      el.value = v;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
  }

  // Hace click en un botón por su ng-click
  async function clickNG(ngClick) {
    await page.waitForSelector(`button[ng-click="${ngClick}"], a[ng-click="${ngClick}"]`, { visible: true, timeout: 15000 });
    await page.click(`button[ng-click="${ngClick}"], a[ng-click="${ngClick}"]`);
  }

  try {
    // ── PASO 1: Cargar portal ────────────────────────────────────────────────
    await page.goto(url, { waitUntil: 'networkidle2' });
    await shot('p1_carga');

    // ── PASO 2: Datos del ticket ─────────────────────────────────────────────
    await fillNG('#form-field-Ticket', folio);

    // Fecha: el campo tiene onfocus que lo convierte a type="date"
    // Necesita valor en formato YYYY-MM-DD
    const fechaISO = parseFecha(fecha);
    await page.waitForSelector('#form-field-Fecha', { visible: true });
    await page.$eval('#form-field-Fecha', (el, v) => {
      el.focus(); // activa onfocus → type='date'
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.blur();
    }, fechaISO);

    await fillNG('#form-field-Importe', total);
    await fillNG('#form-field-RFC', rfc);

    // Forma de pago: 28 = Tarjeta de débito
    await selectNG('#form-field-FormaPago', '28');

    await shot('p2_ticket');

    // ── PASO 3: Click "Siguiente" (paso 1 → datos fiscales) ─────────────────
    await clickNG('btnSiguienteIT()');
    // SPA: esperar que aparezca el campo RFC de datos fiscales
    await page.waitForSelector('#form-field-DFRFC', { visible: true, timeout: 20000 });
    await shot('p3_datos_fiscales');

    // ── PASO 4: Llenar datos fiscales ────────────────────────────────────────
    // RFC (puede estar pre-llenado, lo sobreescribimos)
    await fillNG('#form-field-DFRFC', rfc);
    await fillNG('#form-field-Razon', razonSocial);
    await fillNG('#form-field-CP', codigoPostal || '80140');

    // Uso CFDI: G03
    await selectNG('#form-field-cmbUsoCFDI', usoCfdi || 'G03');

    // Régimen Fiscal: 601
    await selectNG('#form-field-Regimen', regimenFiscal || '601');

    // Correo: #form-field-Correo (type="email", ng-model="datosFiscales.correo")
    await fillNG('#form-field-Correo', 'buzonfacturas@serviciosga.site');

    await shot('p4_datos_fiscales_llenados');

    // ── PASO 5: Click "Siguiente" (datos fiscales → confirmar) ───────────────
    await clickNG('btnSiguienteDF()');
    // Esperar botón "Facturar" del paso de confirmación
    await page.waitForSelector('button[ng-click="btnSiguienteCD()"]', { visible: true, timeout: 20000 });
    await shot('p5_confirmar');

    // ── PASO 6: Click "Facturar" ─────────────────────────────────────────────
    await clickNG('btnSiguienteCD()');
    // Esperar botones de descarga
    await page.waitForSelector('#btnPdf', { visible: true, timeout: 30000 });
    await shot('p6_descarga');

    // ── PASO 7: Descargar PDF y XML ──────────────────────────────────────────
    let pdfUrl = null;
    let xmlUrl = null;

    // Interceptar archivos descargados via nuevas pestañas
    const descargar = async (ngClick, ext, mime) => {
      return new Promise(async (resolve) => {
        const onTarget = async (target) => {
          if (target.type() === 'page') {
            const newPage = await target.page();
            try {
              await newPage.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
              const resp = await newPage.goto(newPage.url(), { waitUntil: 'networkidle2' }).catch(() => null);
              if (resp) {
                const buf = Buffer.from(await resp.buffer());
                if (buf.length > 100) {
                  const key = `facturas/rendichicas_${ticketId}.${ext}`;
                  const uploaded = await subirArchivoR2(buf, key, mime);
                  resolve(uploaded);
                  return;
                }
              }
              await newPage.close().catch(() => {});
            } catch {}
            resolve(null);
          }
        };
        browser.once('targetcreated', onTarget);

        // También interceptar respuesta en la misma página
        const onResp = async (response) => {
          const ct = response.headers()['content-type'] || '';
          if ((ext === 'pdf' && ct.includes('pdf')) || (ext === 'xml' && (ct.includes('xml') || ct.includes('octet')))) {
            try {
              const buf = Buffer.from(await response.buffer());
              if (buf.length > 100) {
                const key = `facturas/rendichicas_${ticketId}.${ext}`;
                const uploaded = await subirArchivoR2(buf, key, mime);
                browser.removeListener('targetcreated', onTarget);
                resolve(uploaded);
              }
            } catch {}
          }
        };
        page.once('response', onResp);

        await page.click(`[ng-click="${ngClick}"], #btn${ext === 'pdf' ? 'Pdf' : 'Xml'}`).catch(() => {});

        // Si ningún listener resuelve en 8s, resolver como null
        setTimeout(() => {
          browser.removeListener('targetcreated', onTarget);
          page.removeListener('response', onResp);
          resolve(null);
        }, 8000);
      });
    };

    pdfUrl = await descargar('descargarPDFStep4()', 'pdf', 'application/pdf');
    await new Promise(r => setTimeout(r, 1000));
    xmlUrl = await descargar('descargarXMLStep4()', 'xml', 'application/xml');

    await browser.close();

    if (pdfUrl || xmlUrl) {
      console.log(`✅ [Rendichicas] PDF: ${pdfUrl} | XML: ${xmlUrl}`);
      return { ok: true, pdfUrl, xmlUrl };
    }

    // Fallback IMAP si las descargas fallaron
    console.log('📬 [Rendichicas] Sin archivos directos — esperando IMAP');
    return { ok: true, procesandoCorreo: true };

  } catch (err) {
    await shot('error');
    try { await browser.close(); } catch {}
    console.log(`❌ [Rendichicas] ${err.message}`);
    return { ok: false, msg: err.message };
  }
}

// DD/MM/YYYY → YYYY-MM-DD
function parseFecha(fecha) {
  if (!fecha) return new Date().toISOString().split('T')[0];
  if (/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return fecha;
  const p = fecha.split(/[\/\-]/);
  if (p.length === 3 && p[2].length === 4) return `${p[2]}-${p[1].padStart(2,'0')}-${p[0].padStart(2,'0')}`;
  return fecha;
}

module.exports = { facturarRendichicas };
