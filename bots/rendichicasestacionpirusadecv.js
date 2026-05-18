const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

async function facturarRendichicas({
  rfc, razonSocial, regimenFiscal, usoCfdi, codigoPostal,
  folio, fecha, total, formaPago,
  ticketId, portalUrl,
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
      const key = `debug/rendichicas_${ticketId}_${nombre}_${Date.now()}.png`;
      await subirArchivoR2(buf, key, 'image/png');
    } catch {}
  };

  async function fillInput(selector, value) {
    await page.waitForSelector(selector, { visible: true });
    await page.click(selector, { clickCount: 3 });
    await page.keyboard.type(String(value), { delay: 50 });
  }

  try {
    // ── PASO 1: Cargar portal ────────────────────────────────────────────────
    await page.goto(url, { waitUntil: 'networkidle2' });
    await shot('paso1_carga');

    // ── PASO 2: Llenar datos del ticket ──────────────────────────────────────
    // Ticket (solo números)
    await fillInput('input[type="text"], input[placeholder*="ticket" i], input[placeholder*="número" i]', folio);

    // Fecha — el portal muestra MM/DD/YYYY (date input type="date" usa YYYY-MM-DD internamente)
    const fechaISO = parseFecha(fecha); // convierte de DD/MM/YYYY a YYYY-MM-DD
    const fechaInput = await page.$('input[type="date"]');
    if (fechaInput) {
      await fechaInput.evaluate((el, val) => { el.value = val; el.dispatchEvent(new Event('change', { bubbles: true })); }, fechaISO);
    }

    // Total pagado
    await fillInput('input[placeholder*="total" i], input[placeholder*="monto" i], input[placeholder*="0" i]', total);

    // RFC
    await fillInput('input[placeholder*="RFC" i], input[name*="rfc" i]', rfc);

    // Forma de pago — seleccionar tarjeta de débito
    try {
      const selectPago = await page.$('select');
      if (selectPago) {
        const optElegida = await selectPago.evaluate(el => {
          const opts = Array.from(el.options);
          const target = opts.find(o =>
            /débito|debito|tarjeta/i.test(o.text)
          ) || opts.find(o => o.value && o.value !== '');
          if (target) {
            el.value = target.value;
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return target.text;
          }
          return null;
        });
        console.log(`💳 Forma de pago seleccionada: ${optElegida}`);
      }
    } catch {}

    await shot('paso2_formulario');

    // ── PASO 3: Click Siguiente ──────────────────────────────────────────────
    const btnSiguiente = await page.$('button[type="submit"], input[type="submit"], button');
    if (!btnSiguiente) throw new Error('No se encontró el botón Siguiente');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {}),
      btnSiguiente.click(),
    ]);
    await shot('paso3_post_siguiente');

    // Detectar error de ticket no encontrado
    const textoError = await page.evaluate(() => document.body.innerText.toLowerCase());
    if (/no encontrado|no existe|inválido|invalido|error/i.test(textoError) &&
        !/datos fiscales|rfc|razón/i.test(textoError)) {
      await browser.close();
      return { ok: false, msg: 'Ticket no encontrado o datos incorrectos en el portal Rendichicas' };
    }

    // ── PASO 4: Datos fiscales ───────────────────────────────────────────────
    // RFC (puede estar pre-llenado o necesitar confirmación)
    try { await fillInput('input[placeholder*="RFC" i], input[name*="rfc" i]', rfc); } catch {}

    // Razón social
    try { await fillInput('input[placeholder*="razón" i], input[placeholder*="nombre" i], input[name*="razon" i], input[name*="nombre" i]', razonSocial); } catch {}

    // CP
    if (codigoPostal) {
      try { await fillInput('input[placeholder*="postal" i], input[placeholder*="CP" i], input[name*="cp" i]', codigoPostal); } catch {}
    }

    // Régimen fiscal
    try {
      const selRegimen = await page.$('select[name*="regimen" i], select[name*="fiscal" i], select[id*="regimen" i]');
      if (selRegimen) {
        await selRegimen.evaluate((el, reg) => {
          const opt = Array.from(el.options).find(o => o.value === reg || o.text.includes(reg));
          if (opt) { el.value = opt.value; el.dispatchEvent(new Event('change', { bubbles: true })); }
        }, regimenFiscal || '601');
      }
    } catch {}

    // Uso CFDI
    try {
      const selCfdi = await page.$('select[name*="cfdi" i], select[name*="uso" i], select[id*="cfdi" i]');
      if (selCfdi) {
        await selCfdi.evaluate(el => {
          const opt = Array.from(el.options).find(o => /G03|gastos/i.test(o.text) || /G03/i.test(o.value));
          if (opt) { el.value = opt.value; el.dispatchEvent(new Event('change', { bubbles: true })); }
        });
      }
    } catch {}

    // Email
    try { await fillInput('input[type="email"], input[placeholder*="correo" i], input[name*="email" i]', 'buzonfacturas@serviciosga.site'); } catch {}

    await shot('paso4_datos_fiscales');

    // ── PASO 5: Confirmar / Facturar ─────────────────────────────────────────
    const btnFacturar = await page.evaluateHandle(() => {
      const btns = Array.from(document.querySelectorAll('button, input[type="submit"]'));
      return btns.find(b => /facturar|confirmar|generar|siguiente/i.test(b.textContent || b.value));
    });

    let xmlUrl = null;
    let pdfUrl = null;

    // Interceptar descargas
    page.on('response', async (resp) => {
      const ct = resp.headers()['content-type'] || '';
      const ru = resp.url();
      if (ct.includes('xml') || ru.endsWith('.xml')) {
        try {
          const buf = Buffer.from(await resp.buffer());
          xmlUrl = await subirArchivoR2(buf, `facturas/rendichicas_${ticketId}.xml`, 'application/xml');
        } catch {}
      }
      if (ct.includes('pdf') || ru.endsWith('.pdf')) {
        try {
          const buf = Buffer.from(await resp.buffer());
          pdfUrl = await subirArchivoR2(buf, `facturas/rendichicas_${ticketId}.pdf`, 'application/pdf');
        } catch {}
      }
    });

    if (btnFacturar) {
      const el = await btnFacturar.asElement();
      if (el) {
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 25000 }).catch(() => {}),
          el.click(),
        ]);
      }
    }

    await page.waitForTimeout(3000);
    await shot('paso5_post_facturar');

    // ── PASO 6: Buscar links de descarga en la página ────────────────────────
    if (!xmlUrl || !pdfUrl) {
      const links = await page.$$eval('a[href]', as => as.map(a => a.href));
      for (const link of links) {
        if (/\.xml/i.test(link) && !xmlUrl) {
          try {
            const resp = await page.goto(link, { waitUntil: 'networkidle2' });
            const buf = Buffer.from(await resp.buffer());
            xmlUrl = await subirArchivoR2(buf, `facturas/rendichicas_${ticketId}.xml`, 'application/xml');
            await page.goBack();
          } catch {}
        }
        if (/\.pdf/i.test(link) && !pdfUrl) {
          try {
            const resp = await page.goto(link, { waitUntil: 'networkidle2' });
            const buf = Buffer.from(await resp.buffer());
            pdfUrl = await subirArchivoR2(buf, `facturas/rendichicas_${ticketId}.pdf`, 'application/pdf');
            await page.goBack();
          } catch {}
        }
      }
    }

    await browser.close();

    if (xmlUrl || pdfUrl) {
      return { ok: true, xmlUrl, pdfUrl };
    }

    // Fallback: esperar por correo IMAP
    return { ok: true, procesandoCorreo: true };

  } catch (err) {
    await shot('error');
    try { await browser.close(); } catch {}
    return { ok: false, msg: err.message };
  }
}

// Convierte DD/MM/YYYY → YYYY-MM-DD (formato ISO para input type="date")
function parseFecha(fecha) {
  if (!fecha) return new Date().toISOString().split('T')[0];
  // Ya está en formato YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return fecha;
  // Formato DD/MM/YYYY
  const [d, m, y] = fecha.split(/[\/\-]/);
  if (y && y.length === 4) return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
  return fecha;
}

module.exports = { facturarRendichicas };
