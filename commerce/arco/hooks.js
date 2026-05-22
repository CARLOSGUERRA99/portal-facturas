const { subirArchivoR2 } = require('../../storage/r2');

// ── Paso 1: submit RFC y esperar navegación ──────────────────────────────────
async function clickRfcYContinuar(page) {
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'load', timeout: 20000 }),
    page.evaluate(() => {
      const btn = document.querySelector('button[type="submit"].btn-info');
      if (btn) btn.click();
    }),
  ]);
}

// ── Paso 2: click "Guardar y continuar" → navega a /DatosTicket ──────────────
async function clickGuardarYContinuar(page) {
  await page.waitForSelector('button[name="btn"][value="GenerarFactura"], button.btn-success', { timeout: 10000 });
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'load', timeout: 20000 }),
    page.evaluate(() => {
      const btn = document.querySelector('button[name="btn"][value="GenerarFactura"]')
        || Array.from(document.querySelectorAll('button.btn-success'))
            .find(b => /guardar|continuar/i.test(b.textContent));
      if (btn) btn.click();
    }),
  ]);
  if (!page.url().includes('DatosTicket')) {
    throw new Error(`URL inesperada tras Guardar: ${page.url()}`);
  }
}

// ── Paso 3: click Verificar, detectar errores, guardar resultado en context ──
async function verificarCodigo(page, context) {
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'load', timeout: 20000 }).catch(() => {}),
    page.click('button#btnVerificar'),
  ]);

  const resultado = await page.evaluate(() => {
    const body = document.body.innerText;
    if (body.match(/excede los 2 d[ií]as|más de 2 días|plazo.*vencido|fuera de plazo|tiempo.*expirado/i))
      return 'vencido';
    if (body.match(/ya fue facturado|ya existe|ya procesado|previously invoiced/i))
      return 'ya_facturado';
    return 'ok';
  });

  if (resultado === 'vencido') {
    return { ok: false, error_code: 'datos_invalidos', msg: 'El ticket excede los 2 días permitidos para facturar en BuzonFacturas.' };
  }
  context.resultadoVerificar = resultado;
}

// ── Recuperar factura existente desde /CFDI/DescargarFactura ─────────────────
async function recuperarExistente(page, context) {
  await page.goto('https://buzonfacturas.com/CFDI/DescargarFactura', { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(1500);

  const rfcInput = await page.$('input[name="Rfc"], input#Rfc, input[placeholder*="RFC"]');
  if (rfcInput) {
    await rfcInput.click({ clickCount: 3 });
    await rfcInput.type(context.rfc);
  }

  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button, input[type="submit"]'))
      .find(el => el.textContent?.includes('Buscar') || el.value?.includes('Buscar'));
    if (btn) btn.click();
  });
  await page.waitForTimeout(3000);

  try {
    await page.waitForSelector('table tbody tr', { timeout: 10000 });
  } catch {
    return { ok: true, procesandoCorreo: true };
  }

  const browser = page.browser();

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

  const pdfBuf = await interceptar(() =>
    page.evaluate(() => {
      const icons = document.querySelectorAll('table tbody tr:first-child td:last-child img, table tbody tr:first-child td:last-child a');
      if (icons[0]) icons[0].click();
    })
  ).catch(() => null);

  const xmlBuf = await interceptar(() =>
    page.evaluate(() => {
      const icons = document.querySelectorAll('table tbody tr:first-child td:last-child img, table tbody tr:first-child td:last-child a');
      if (icons[1]) icons[1].click();
    })
  ).catch(() => null);

  if (!xmlBuf && !pdfBuf) return { ok: true, procesandoCorreo: true };

  const upload = async (buf, ext) => {
    if (!buf) return null;
    const key = `facturas/${context.portal}_${context.ticketId}.${ext}`;
    return subirArchivoR2(buf, key, ext === 'xml' ? 'application/xml' : 'application/pdf');
  };

  return { ok: true, xmlUrl: await upload(xmlBuf, 'xml'), pdfUrl: await upload(pdfBuf, 'pdf') };
}

// ── Forma de pago, Uso CFDI y correo de captura ──────────────────────────────
async function configurarFormaPago(page, context) {
  await page.waitForFunction(
    () => document.querySelector('select#FormaDePago') !== null,
    { timeout: 10000 }
  );
  await page.evaluate(() => {
    const fp = document.querySelector('select#FormaDePago');
    const uc = document.querySelector('select#UsoCFDI');
    if (fp) fp.removeAttribute('disabled');
    if (uc) uc.removeAttribute('disabled');
  });
  await page.select('select#FormaDePago', '28');
  await page.select('select#UsoCFDI', 'G03');

  await page.evaluate(() => {
    const input = document.querySelector('input#correo');
    if (input) { input.removeAttribute('readonly'); input.value = ''; }
  });
  await page.type('input#correo', 'buzonfacturas@serviciosga.site', { delay: 50 });
}

// ── Click "Generar Factura", detectar errores post-generación ────────────────
async function generarFactura(page) {
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'load', timeout: 20000 }).catch(() => {}),
    page.evaluate(() => {
      const btn = document.querySelector('button[name="btn"][value="GenerarFactura"]');
      if (btn) { btn.removeAttribute('disabled'); btn.click(); }
    }),
  ]);

  const resultado = await page.evaluate(() => {
    const body = document.body.innerText;
    if (body.match(/excede los 2 d[ií]as|más de 2 días|plazo.*vencido|fuera de plazo|tiempo.*expirado/i))
      return 'vencido';
    if (body.match(/ya fue facturado|ya existe|ya procesado|previously|ya tiene factura/i))
      return 'ya_facturado';
    return 'ok';
  });

  if (resultado === 'vencido') {
    return { ok: false, error_code: 'datos_invalidos', msg: 'El ticket excede los 2 días permitidos para facturar.' };
  }
  if (resultado === 'ya_facturado') {
    return { ok: true, procesandoCorreo: true };
  }

  // Reenviar correo si hay botón separado
  await page.evaluate(() => {
    const btn = document.querySelector('button[name="btn"][value="btnCorreo"]');
    if (btn) { btn.removeAttribute('disabled'); btn.click(); }
  });
  await page.waitForTimeout(2000);
}

// ── Descargar XML + PDF via interceptación de nueva pestaña ──────────────────
async function descargarArchivos(page, context) {
  // El click en btnCorreo puede causar navegación — ignorar si el contexto fue destruido
  await page.evaluate(() => {
    document.querySelectorAll('input[type="submit"], a, button')
      .forEach(b => { if (b.removeAttribute) b.removeAttribute('disabled'); });
  }).catch(() => {});

  const browser = page.browser();

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

  const xmlBuf = await interceptar(() =>
    page.evaluate(() => {
      const btn = document.querySelector('input[type="submit"][value="Descargar XML"]')
        || Array.from(document.querySelectorAll('a, button'))
            .find(el => el.textContent?.includes('XML') || el.href?.includes('.xml'));
      if (btn) { btn.scrollIntoView(); btn.click(); }
    })
  ).catch(() => null);

  const pdfBuf = await interceptar(() =>
    page.evaluate(() => {
      const btn = document.querySelector('input[type="submit"][value="Descargar PDF"]')
        || Array.from(document.querySelectorAll('a, button'))
            .find(el => el.textContent?.includes('PDF') || el.href?.includes('.pdf'));
      if (btn) { btn.scrollIntoView(); btn.click(); }
    })
  ).catch(() => null);

  if (!xmlBuf && !pdfBuf) return { ok: true, procesandoCorreo: true };

  const upload = async (buf, ext) => {
    if (!buf) return null;
    const key = `facturas/${context.portal}_${context.ticketId}.${ext}`;
    return subirArchivoR2(buf, key, ext === 'xml' ? 'application/xml' : 'application/pdf');
  };

  const xmlUrl = await upload(xmlBuf, 'xml');
  const pdfUrl = await upload(pdfBuf, 'pdf');
  if (!xmlUrl && !pdfUrl) return { ok: true, procesandoCorreo: true };

  return { ok: true, xmlUrl, pdfUrl };
}

module.exports = {
  clickRfcYContinuar,
  clickGuardarYContinuar,
  verificarCodigo,
  recuperarExistente,
  configurarFormaPago,
  generarFactura,
  descargarArchivos,
};
