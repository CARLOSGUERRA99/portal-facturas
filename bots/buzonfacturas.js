const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const unzipper = require('unzipper');
const { subirArchivoR2 } = require('../storage/r2');

async function facturarBuzonFacturas({ rfc, codigoTicket, portalUrl, email, fecha, folio, total, ticketId }) {
  console.log('🤖 Iniciando bot BuzonFacturas...');
  console.log(`   RFC: ${rfc} | Código: ${codigoTicket} | Email: ${email}`);

  const _bfToken = process.env.BROWSERLESS_TOKEN || '';
  const _bfRaw = process.env.BROWSERLESS_URL || process.env.BROWSERLESS_WS_ENDPOINT || `wss://production-sfo.browserless.io?token=${_bfToken}`;
  const [_bfPath, _bfQs] = _bfRaw.split('?');
  const _bfPathFinal = _bfPath.replace(/\/$/, '').endsWith('/chromium') ? _bfPath.replace(/\/$/, '') : `${_bfPath.replace(/\/$/, '')}/chromium`;
  const _bfParams = new URLSearchParams(_bfQs || '');
  if (!_bfParams.has('token') && _bfToken) _bfParams.set('token', _bfToken);
  if (!_bfParams.has('timeout')) _bfParams.set('timeout', '120000');
  const browser = await puppeteer.connect({ browserWSEndpoint: `${_bfPathFinal}?${_bfParams.toString()}` });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  async function guardarEnR2(buffer, extension) {
    if (!buffer) return null;
    const key = `facturas/${ticketId || Date.now()}_${Date.now()}.${extension}`;
    const contentType = extension === 'xml' ? 'application/xml' : 'application/pdf';
    return await subirArchivoR2(buffer, key, contentType);
  }

  async function interceptarDescarga(clickFn) {
    const newPagePromise = new Promise(resolve =>
      browser.once('targetcreated', target => resolve(target.page()))
    );
    await clickFn();
    const newPage = await Promise.race([
      newPagePromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout newPage')), 8000)),
    ]).catch(() => null);

    if (!newPage) return null;
    await newPage.waitForTimeout(1500);

    const response = await newPage.waitForResponse(
      r => r.status() === 200, { timeout: 10000 }
    ).catch(() => null);

    const buffer = response ? await response.buffer().catch(() => null) : null;
    await newPage.close().catch(() => {});
    return buffer;
  }

  async function runEstrategiaB(folioHint) {
    try {
      console.log('📥 Estrategia B — Recuperando desde DescargarFactura...');
      await page.waitForTimeout(2000);
      await page.goto('https://buzonfacturas.com/CFDI/DescargarFactura', {
        waitUntil: 'networkidle2',
        timeout: 30000,
      });
      await page.waitForTimeout(1500);

      const rfcInput = await page.$('input[name="Rfc"], input#Rfc, input[placeholder*="RFC"]');
      if (rfcInput) {
        await rfcInput.click({ clickCount: 3 });
        await rfcInput.type(rfc);
      }

      const folio = folioHint || await page.evaluate(() => {
        const match = document.body.innerText.match(/[A-Z]{2,6}-\d{6,10}/);
        return match ? match[0] : null;
      });

      if (folio) {
        const folioInput = await page.$('input[name="Folio"], input[placeholder*="folio" i], input[placeholder*="Folio"]');
        if (folioInput) {
          await folioInput.click({ clickCount: 3 });
          await folioInput.type(folio);
        }
      }

      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button, input[type="submit"]'))
          .find(el => el.textContent?.includes('Buscar') || el.value?.includes('Buscar'));
        if (btn) btn.click();
      });
      await page.waitForTimeout(3000);
      await page.waitForSelector('table tbody tr', { timeout: 10000 });

      const pdfBuffer = await interceptarDescarga(() =>
        page.evaluate(() => {
          const icons = document.querySelectorAll(
            'table tbody tr:first-child td:last-child img, table tbody tr:first-child td:last-child a'
          );
          if (icons[0]) icons[0].click();
        })
      ).catch(() => null);

      const xmlBuffer = await interceptarDescarga(() =>
        page.evaluate(() => {
          const icons = document.querySelectorAll(
            'table tbody tr:first-child td:last-child img, table tbody tr:first-child td:last-child a'
          );
          if (icons[1]) icons[1].click();
        })
      ).catch(() => null);

      if (!xmlBuffer && !pdfBuffer) throw new Error('No se interceptaron archivos en Estrategia B');

      const xmlUrl = await guardarEnR2(xmlBuffer, 'xml');
      const pdfUrl = await guardarEnR2(pdfBuffer, 'pdf');

      console.log('✅ Estrategia B exitosa');
      return { ok: true, xmlUrl, pdfUrl };
    } catch (e) {
      console.log('❌ Estrategia B falló:', e.message);
      return { ok: false, msg: e.message };
    }
  }

  try {
    // PASO 1 — Navegar y RFC
    console.log('🌐 PASO 1 — Navegando a BuzonFacturas...');
    const url = (portalUrl && portalUrl.startsWith('http'))
      ? portalUrl
      : 'https://buzonfacturas.com/GenerarCFDI/Index?avanzada=0';
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    console.log('🔑 Esperando input RFC...');
    let rfcInput = null;
    for (const sel of ['input[name="Rfc"]', 'input#Rfc', 'input[placeholder*="RFC"]', 'input[placeholder*="rfc"]']) {
      try {
        await page.waitForSelector(sel, { timeout: 5000 });
        rfcInput = await page.$(sel);
        console.log(`✅ Input RFC encontrado: ${sel}`);
        break;
      } catch { console.log(`⚠️ No encontrado: ${sel}`); }
    }

    if (!rfcInput) throw new Error('No se encontró input de RFC');
    await rfcInput.click({ clickCount: 3 });
    await rfcInput.type(rfc);

    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button, input[type="submit"]'))
        .find(el => el.textContent?.includes('Buscar') || el.value?.includes('Buscar'));
      if (btn) btn.click();
    });
    console.log('🔍 Click en Buscar...');
    const ss1 = await page.screenshot({ encoding: 'base64' });
    console.log('📸 Screenshot 1 — después de buscar RFC');

    // PASO 2 — Guardar y continuar
    console.log('💾 PASO 2 — Esperando botón Guardar y continuar...');
    await page.waitForSelector('button.btn-success, input.btn-success, a.btn-success', { timeout: 10000 });
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button, a, input'))
        .find(el => el.textContent?.includes('Guardar') || el.value?.includes('Guardar'));
      if (btn) btn.click();
    });
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
    console.log('✅ URL actual:', page.url());

    // PASO 3 — Código de facturación
    console.log('🎫 PASO 3 — Esperando campo CodigoFacturacion...');
    await page.waitForSelector('input#CodigoFacturacion, input[name="CodigoFacturacion"]', { timeout: 10000 });
    await page.click('input#CodigoFacturacion, input[name="CodigoFacturacion"]', { clickCount: 3 });
    await page.type('input#CodigoFacturacion, input[name="CodigoFacturacion"]', codigoTicket);
    console.log(`✅ Código llenado: ${codigoTicket}`);

    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button, input[type="submit"]'))
        .find(el => el.textContent?.includes('Verificar') || el.value?.includes('Verificar'));
      if (btn) btn.click();
    });
    console.log('✅ Click en Verificar...');

    const resultado = await page.waitForFunction(() => {
      const body = document.body.innerText;
      const yaFacturado = body.match(/ya fue facturado|ya existe|ya procesado|previously invoiced/i);
      const verificado = body.match(/Estaci[oó]n|N[uú]mero de venta|Fecha de compra/i);
      if (yaFacturado) return { tipo: 'yaFacturado', folio: body.match(/[A-Z]{2,6}-\d{6,10}/)?.[0] || null };
      if (verificado) return { tipo: 'verificado' };
      return false;
    }, { timeout: 15000 }).catch(() => null);

    const ss2 = await page.screenshot({ encoding: 'base64' });
    console.log('📸 Screenshot 2 — respuesta tras Verificar');

    if (resultado) {
      const val = await resultado.jsonValue();
      if (val?.tipo === 'yaFacturado') {
        console.log('⚠️ Ticket ya facturado, saltando a recuperador...');
        const r = await runEstrategiaB(val.folio);
        await browser.close();
        return r;
      }
    }
    console.log('✅ Ticket verificado correctamente');

    // PASO 4 — Forma de pago
    console.log('💳 PASO 4 — Seleccionando forma de pago...');
    await page.evaluate(() => {
      const selects = Array.from(document.querySelectorAll('select'));
      const pagoSelect = selects.find(s =>
        !s.name?.toLowerCase().includes('cfdi') &&
        !s.id?.toLowerCase().includes('cfdi') &&
        Array.from(s.options).some(o => o.text.toLowerCase().includes('débito') || o.text.toLowerCase().includes('debito'))
      );
      if (pagoSelect) {
        const debitoOption = Array.from(pagoSelect.options)
          .find(o => o.text.toLowerCase().includes('débito') || o.text.toLowerCase().includes('debito') || o.value === '28');
        if (debitoOption) pagoSelect.value = debitoOption.value;
      }
    });

    // PASO 5 — Generar factura
    console.log('🧾 PASO 5 — Generando factura...');
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button, input[type="submit"]'))
        .find(el => el.textContent?.includes('Generar') || el.value?.includes('Generar'));
      if (btn) { console.log('🔘 Botón:', btn.textContent || btn.value); btn.click(); }
    });

    const paso5 = await page.waitForFunction(() => {
      const body = document.body.innerText;
      // Condición 1: factura generada exitosamente
      const folioInput = Array.from(document.querySelectorAll('input'))
        .find(i => i.id?.includes('Folio') && i.value?.match(/[A-Z]{2,6}-\d+/));
      if (folioInput) return { tipo: 'generado', folio: folioInput.value };

      // Condición 2: ya estaba facturado
      const yaFacturado = body.match(
        /ya fue facturado|ya existe|ya procesado|previously|ya tiene factura/i
      );
      if (yaFacturado) return { tipo: 'yaFacturado' };

      return false;
    }, { timeout: 15000 }).catch(() => null);

    const paso5Val = paso5 ? await paso5.jsonValue().catch(() => null) : null;
    console.log('📋 PASO 5 resultado:', paso5Val);

    if (paso5Val?.tipo === 'yaFacturado') {
      console.log('⚠️ PASO 5: ticket ya facturado — saltando a runEstrategiaB...');
      const r = await runEstrategiaB(null);
      await browser.close();
      return r;
    }

    const folioGenerado = paso5Val?.folio || null;
    console.log('✅ Factura generada. Folio:', folioGenerado);
    const ss3 = await page.screenshot({ encoding: 'base64' });
    console.log('📸 Screenshot 3 — factura generada');

    // PASO 6 — Enviar al correo de captura
    console.log('📧 PASO 6 — Enviando a correo de captura...');
    try {
      await page.type(
        'input[type="email"], input[name*="orreo"], input[placeholder*="orreo"]',
        'buzonfacturas@serviciosga.site',
        { delay: 50 }
      );
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button, input[type="submit"]'))
          .find(el => el.textContent?.includes('Enviar') || el.value?.includes('Enviar'));
        if (btn) btn.click();
      });
      console.log('📤 Correo enviado a buzonfacturas@serviciosga.site');
      await page.waitForTimeout(2000);
    } catch (e) {
      console.log('⚠️ No se pudo enviar correo de captura:', e.message);
    }

    // PASO 7 — Estrategia A: interceptar descarga
    console.log('📥 PASO 7 — Estrategia A: interceptar descarga...');
    let xmlBuffer = null, pdfBuffer = null;

    const xmlBuf = await interceptarDescarga(() =>
      page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a, button'));
        const xml = links.find(el => el.textContent?.includes('XML') || el.href?.includes('xml'));
        if (xml) xml.click();
      })
    ).catch(() => null);

    if (xmlBuf) {
      if (xmlBuf.length > 4 && xmlBuf.slice(0, 4).toString() === 'PK\x03\x04') {
        const zip = await unzipper.Open.buffer(xmlBuf);
        for (const file of zip.files) {
          if (file.path.endsWith('.xml')) xmlBuffer = await file.buffer();
          if (file.path.endsWith('.pdf')) pdfBuffer = await file.buffer();
        }
      } else {
        xmlBuffer = xmlBuf;
      }
    }

    if (!pdfBuffer) {
      const pdfBuf = await interceptarDescarga(() =>
        page.evaluate(() => {
          const links = Array.from(document.querySelectorAll('a, button'));
          const pdf = links.find(el => el.textContent?.includes('PDF') || el.href?.includes('pdf'));
          if (pdf) pdf.click();
        })
      ).catch(() => null);
      if (pdfBuf) pdfBuffer = pdfBuf;
    }

    // Si Estrategia A no funcionó → marcar para job IMAP asíncrono
    if (!xmlBuffer && !pdfBuffer) {
      console.log('⚠️ Estrategia A falló — marcando ticket para procesamiento IMAP asíncrono...');
      await browser.close();
      return { ok: true, procesandoCorreo: true, folioGenerado };
    }

    const xmlUrl = await guardarEnR2(xmlBuffer, 'xml');
    const pdfUrl = await guardarEnR2(pdfBuffer, 'pdf');

    if (!xmlUrl && !pdfUrl) {
      await browser.close();
      return { ok: true, procesandoCorreo: true, folioGenerado };
    }

    await browser.close();
    console.log('✅ BuzonFacturas completado — XML:', xmlUrl, '| PDF:', pdfUrl);
    return { ok: true, xmlUrl, pdfUrl };

  } catch (err) {
    console.error('❌ Error en bot BuzonFacturas:', err.message);
    const r = await runEstrategiaB(null);
    try { await browser.close(); } catch {}
    return r;
  }
}

module.exports = { facturarBuzonFacturas };
