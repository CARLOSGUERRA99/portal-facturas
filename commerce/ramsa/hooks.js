const { subirArchivoR2 } = require('../../storage/r2');

// Selecciona la primera opción de un <select> cuyo texto contiene alguna keyword
async function selectByText(page, selector, keywords) {
  await page.waitForSelector(selector, { visible: true, timeout: 10000 });
  const found = await page.$eval(selector, (el, kws) => {
    const opt = Array.from(el.options).find(o =>
      kws.some(k => o.text.toLowerCase().includes(k.toLowerCase()))
    );
    if (!opt) return null;
    el.value = opt.value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    return opt.text;
  }, keywords);
  return found;
}

// Fetch con cookies de la sesión actual del browser
async function fetchConCookies(page, url) {
  const cookies = await page.cookies();
  const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  const data = await page.evaluate(async (u, ck) => {
    try {
      const r = await fetch(u, { headers: { Cookie: ck }, credentials: 'include' });
      const arr = await r.arrayBuffer();
      return { ct: r.headers.get('content-type') || '', bytes: Array.from(new Uint8Array(arr)), ok: r.ok };
    } catch (e) { return { error: e.message }; }
  }, url, cookieStr).catch(() => null);
  if (!data || data.error || !data.bytes) return null;
  return Buffer.from(data.bytes);
}

module.exports = {

  // Selecciona régimen fiscal en el <select>
  async seleccionarRegimen(page, context) {
    const keywords = [String(context.regimenFiscal)];
    await selectByText(page, context.selectors.regimen, keywords);
  },

  // Espera carga AJAX del select de Uso CFDI y lo selecciona
  async seleccionarCfdi(page, context) {
    await page.waitForFunction(
      sel => { const s = document.querySelector(sel); return s && s.options.length > 1; },
      { timeout: 15000 },
      context.selectors.usoCfdi
    );
    const cfdiMap = context.config.cfdi_keywords || {};
    const keywords = cfdiMap[String(context.usoCfdi).toUpperCase()] || ['Gastos en general'];
    const found = await selectByText(page, context.selectors.usoCfdi, keywords);
    if (!found) {
      const opciones = await page.$eval(context.selectors.usoCfdi,
        el => Array.from(el.options).map(o => o.text).join(' | ')
      );
      throw new Error(`Uso CFDI no seleccionado — opciones disponibles: ${opciones}`);
    }
  },

  // Selecciona forma de pago
  async seleccionarFormaPago(page, context) {
    await selectByText(page, context.selectors.formaPago, ['débito', 'debito', 'Tarjeta de déb']);
  },

  // Hace click en el botón "Facturar" buscándolo por texto
  async clickFacturar(page) {
    page.on('dialog', async dialog => await dialog.accept());
    const handle = await page.evaluateHandle(() =>
      [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Facturar')
    );
    const btn = handle.asElement();
    if (!btn) throw new Error('Botón "Facturar" no encontrado');
    await btn.click();
  },

  // Descarga XML y PDF usando URLs construidas desde los hrefs del portal
  async descargarArchivos(page, context) {
    const ticketId = context.ticketId;
    const links = await page.$$eval('#divFiles a', els =>
      els.map(el => ({ text: el.textContent.trim().toUpperCase(), href: el.href }))
    );

    const pageUrl = page.url();
    const baseUrl = new URL('../', pageUrl).href;
    let xmlUrl = null, pdfUrl = null;

    // ── XML ──
    const xmlLink = links.find(l => l.text.includes('XML'));
    if (xmlLink) {
      const m = xmlLink.href.match(/DownloadInvoice\('([^']+)',\s*(\d+)\)/);
      if (m) {
        const fiscalFolioId = m[1].split('_')[3]?.replace('.xml', '');
        const stationId = m[2];
        const xmlDlUrl = `${baseUrl}DownloadInvoice.aspx?fiscalFolioId=${fiscalFolioId}&stationId=${stationId}`;
        const buf = await fetchConCookies(page, xmlDlUrl);
        if (buf && buf.length > 200) {
          const preview = buf.toString('utf8', 0, 10);
          if (preview.includes('<?') || preview.includes('<cfdi') || preview.includes('<Comprobante')) {
            xmlUrl = await subirArchivoR2(buf, `facturas/ramsa_${ticketId}.xml`, 'application/xml');
          }
        }
      }
    }

    // ── PDF ──
    const pdfLink = links.find(l => l.text.includes('PDF'));
    if (pdfLink) {
      const m = pdfLink.href.match(/ShowInvoiceReport\('([^']+)',\s*(\d+),\s*(true|false)\)/);
      if (m) {
        const fiscalFolioId = m[1].split('_')[3]?.replace('.xml', '');
        const stationId = m[2];
        const isStationNum = m[3] === 'true';
        let pdfViewUrl = `${baseUrl}Report/ReportViewer.aspx?rptId=DigitalInvoiceReport&fiscalFolioId=${fiscalFolioId}`;
        pdfViewUrl += isStationNum ? `&stationNumber=${stationId}` : `&stationId=${stationId}`;

        const directBuf = await fetchConCookies(page, pdfViewUrl);
        if (directBuf && directBuf.toString('latin1', 0, 4) === '%PDF') {
          pdfUrl = await subirArchivoR2(directBuf, `facturas/ramsa_${ticketId}.pdf`, 'application/pdf');
        } else {
          // Abrir en nueva pestaña e interceptar respuesta PDF
          const browser = page.browser();
          const pdfPage = await browser.newPage();
          let pdfBuffer = null;
          await pdfPage.setRequestInterception(true);
          pdfPage.on('request', req => req.continue());
          pdfPage.on('response', async resp => {
            try {
              const ct = resp.headers()['content-type'] || '';
              if (ct.includes('pdf') || ct.includes('octet-stream')) {
                const b = await resp.buffer().catch(() => null);
                if (b && b.length > 500 && !pdfBuffer) pdfBuffer = b;
              }
            } catch {}
          });
          await pdfPage.goto(pdfViewUrl, { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
          await new Promise(r => setTimeout(r, 3000));
          if (pdfBuffer) {
            pdfUrl = await subirArchivoR2(pdfBuffer, `facturas/ramsa_${ticketId}.pdf`, 'application/pdf');
          }
          await pdfPage.close().catch(() => {});
        }
      }
    }

    // Resultado final
    if (!xmlUrl && !pdfUrl) return { ok: true, procesandoCorreo: true };
    return { ok: true, xmlUrl, pdfUrl };
  },

  // Caso: el folio ya fue facturado — recupera archivos existentes
  async descargarExistente(page, context) {
    await page.waitForSelector('#divFiles', { visible: true, timeout: 10000 });
    return await module.exports.descargarArchivos(page, context);
  },
};
