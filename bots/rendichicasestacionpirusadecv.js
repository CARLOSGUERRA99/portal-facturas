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

  async function fillInput(selector, value) {
    await page.waitForSelector(selector, { visible: true, timeout: 8000 });
    const el = await page.$(selector);
    if (!el) return;
    await el.click({ clickCount: 3 });
    await page.keyboard.press('Delete');
    await el.type(String(value), { delay: 50 });
  }

  // Devuelve el primer botón cuyo texto coincide con el regex
  async function clickBtn(regex, waitNav = true) {
    const handle = await page.evaluateHandle((re) => {
      const btns = Array.from(document.querySelectorAll('button, input[type="submit"], a.btn, a[class*="btn"]'));
      return btns.find(b => new RegExp(re, 'i').test((b.textContent || b.value || '').trim())) || null;
    }, regex.source);
    const el = await handle.asElement();
    if (!el) return false;
    if (waitNav) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {}),
        el.click(),
      ]);
    } else {
      await el.click();
    }
    return true;
  }

  try {
    // ── PASO 1: Cargar portal ────────────────────────────────────────────────
    await page.goto(url, { waitUntil: 'networkidle2' });
    await shot('p1_carga');

    // ── PASO 2: Datos del ticket ─────────────────────────────────────────────
    // Ticket (solo números)
    try { await fillInput('input[placeholder*="ticket" i], input[placeholder*="Ticket" i]', folio); } catch {}

    // Fecha — input type="date" requiere YYYY-MM-DD
    const fechaISO = parseFecha(fecha);
    try {
      await page.waitForSelector('input[type="date"]', { timeout: 5000 });
      await page.$eval('input[type="date"]', (el, v) => {
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, fechaISO);
    } catch {}

    // Total
    try { await fillInput('input[placeholder*="total" i], input[placeholder*="Total" i], input[placeholder="0"]', total); } catch {}

    // RFC
    try { await fillInput('input[placeholder="RFC"], input[placeholder*="RFC" i]', rfc); } catch {}

    // Forma de pago — seleccionar tarjeta de débito
    try {
      await page.$eval('select', (el) => {
        const opt = Array.from(el.options).find(o => /débito|debito/i.test(o.text))
                 || Array.from(el.options).find(o => o.value && o.value !== '');
        if (opt) { el.value = opt.value; el.dispatchEvent(new Event('change', { bubbles: true })); }
      });
    } catch {}

    await shot('p2_formulario');

    // ── PASO 3: Click "Siguiente" ────────────────────────────────────────────
    await clickBtn(/^siguiente$/);
    // Esperar que la página de datos fiscales cargue completamente
    await new Promise(r => setTimeout(r, 2500));
    await shot('p3_datos_fiscales');

    // Verificar que llegamos a datos fiscales (y no a un error)
    const texto = await page.evaluate(() => document.body.innerText).catch(() => '');
    if (/no encontrado|no existe|inválido|invalido/i.test(texto) &&
        !/datos fiscales|razón social|razon social/i.test(texto)) {
      await browser.close();
      return { ok: false, msg: 'Ticket no encontrado o datos incorrectos en Rendichicas' };
    }

    // ── PASO 4: Datos fiscales — el portal ya los tiene pre-llenados ─────────
    // Solo necesitamos llenar el correo y dar Siguiente

    // Correo electrónico
    const emailSelectors = [
      'input[type="email"]',
      'input[placeholder*="correo" i]',
      'input[placeholder*="Correo" i]',
      'input[name*="correo" i]',
      'input[name*="email" i]',
      'input[id*="correo" i]',
      'input[id*="email" i]',
    ];
    let emailLlenado = false;
    for (const sel of emailSelectors) {
      try {
        await page.waitForSelector(sel, { visible: true, timeout: 3000 });
        const el = await page.$(sel);
        if (el) {
          await el.click({ clickCount: 3 });
          await page.keyboard.press('Delete');
          await el.type('buzonfacturas@serviciosga.site', { delay: 60 });
          emailLlenado = true;
          console.log(`📧 [Rendichicas] Email llenado con selector: ${sel}`);
          break;
        }
      } catch {}
    }
    if (!emailLlenado) console.log('⚠️ [Rendichicas] No se encontró campo de correo');

    await shot('p4_correo_llenado');

    // ── PASO 5: Click "Siguiente" en datos fiscales ──────────────────────────
    await clickBtn(/^siguiente$/);
    await new Promise(r => setTimeout(r, 2500));
    await shot('p5_post_siguiente_fiscal');

    // ── PASO 6: Manejar diálogo "Actualizar datos fiscales" si aparece ───────
    const textoPost = await page.evaluate(() => document.body.innerText).catch(() => '');
    if (/actualizar|confirmar|¿desea/i.test(textoPost)) {
      console.log('💬 [Rendichicas] Diálogo de confirmación detectado — aceptando');
      const aceptado = await clickBtn(/^sí$|^si$|^aceptar$|^confirmar$|^continuar$/);
      if (!aceptado) await clickBtn(/siguiente/); // fallback
      await new Promise(r => setTimeout(r, 2000));
      await shot('p6_post_dialogo');
    }

    // ── PASO 7: Página de descarga — buscar links PDF y XML ──────────────────
    await new Promise(r => setTimeout(r, 2000));
    await shot('p7_descarga');

    let xmlUrl = null;
    let pdfUrl = null;

    // Buscar links visibles en la página
    const links = await page.$$eval('a[href]', as => as.map(a => a.href)).catch(() => []);
    for (const link of links) {
      if (/\.xml(\?|$)/i.test(link) && !xmlUrl) {
        try {
          const resp = await page.goto(link, { waitUntil: 'networkidle2', timeout: 15000 });
          if (resp && resp.ok()) {
            const buf = Buffer.from(await resp.buffer());
            xmlUrl = await subirArchivoR2(buf, `facturas/rendichicas_${ticketId}.xml`, 'application/xml');
            await page.goBack({ waitUntil: 'networkidle2' }).catch(() => {});
          }
        } catch {}
      }
      if (/\.pdf(\?|$)/i.test(link) && !pdfUrl) {
        try {
          const resp = await page.goto(link, { waitUntil: 'networkidle2', timeout: 15000 });
          if (resp && resp.ok()) {
            const buf = Buffer.from(await resp.buffer());
            pdfUrl = await subirArchivoR2(buf, `facturas/rendichicas_${ticketId}.pdf`, 'application/pdf');
            await page.goBack({ waitUntil: 'networkidle2' }).catch(() => {});
          }
        } catch {}
      }
    }

    // Buscar botones de descarga si no había links directos
    if (!xmlUrl || !pdfUrl) {
      const btnXml = await page.$('a[href*="xml" i], button[onclick*="xml" i], a:has-text("XML")').catch(() => null);
      const btnPdf = await page.$('a[href*="pdf" i], button[onclick*="pdf" i], a:has-text("PDF")').catch(() => null);
      if (btnXml && !xmlUrl) { try { await btnXml.click(); await new Promise(r => setTimeout(r, 2000)); } catch {} }
      if (btnPdf && !pdfUrl) { try { await btnPdf.click(); await new Promise(r => setTimeout(r, 2000)); } catch {} }
    }

    await browser.close();

    if (xmlUrl || pdfUrl) {
      console.log(`✅ [Rendichicas] Factura descargada — XML: ${xmlUrl} | PDF: ${pdfUrl}`);
      return { ok: true, xmlUrl, pdfUrl };
    }

    // El portal envía por correo — esperar IMAP
    console.log('📬 [Rendichicas] Sin archivos directos — esperando correo IMAP');
    return { ok: true, procesandoCorreo: true };

  } catch (err) {
    await shot('error');
    try { await browser.close(); } catch {}
    console.log(`❌ [Rendichicas] Error: ${err.message}`);
    return { ok: false, msg: err.message };
  }
}

// DD/MM/YYYY o YYYY-MM-DD → YYYY-MM-DD
function parseFecha(fecha) {
  if (!fecha) return new Date().toISOString().split('T')[0];
  if (/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return fecha;
  const partes = fecha.split(/[\/\-]/);
  if (partes.length === 3 && partes[2].length === 4) {
    return `${partes[2]}-${partes[1].padStart(2, '0')}-${partes[0].padStart(2, '0')}`;
  }
  return fecha;
}

module.exports = { facturarRendichicas };
