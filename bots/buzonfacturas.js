const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const unzipper = require('unzipper');
const { subirArchivoR2 } = require('../storage/r2');

async function facturarBuzonFacturas({ rfc, codigoTicket, portalUrl, email, fecha, folio, total, ticketId }) {
  console.log('🤖 Iniciando bot BuzonFacturas...');
  console.log(`   RFC: ${rfc} | Código: ${codigoTicket} | Email: ${email}`);

  const _bfToken = process.env.BROWSERLESS_TOKEN;
  if (!_bfToken) throw new Error('BROWSERLESS_TOKEN no definido');
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${_bfToken}&timeout=120000`
  });

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

    console.log('🔑 Llenando RFC...');
    await page.waitForSelector('input#RFC', { timeout: 10000 });
    await page.click('input#RFC', { clickCount: 3 });
    await page.type('input#RFC', rfc, { delay: 80 });
    await page.evaluate(() => {
      const btn = document.querySelector('button[type="submit"].btn-info');
      if (btn) btn.click();
    });
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
    console.log('✅ RFC enviado, URL:', page.url());

    // PASO 2 — Guardar y continuar
    console.log('💾 PASO 2 — Guardando y continuando...');
    await page.waitForSelector('button[name="btn"][value="GenerarFactura"]', { timeout: 10000 });
    await page.click('button[name="btn"][value="GenerarFactura"]');
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
    console.log('✅ Guardado, URL:', page.url());

    // PASO 3 — Código de facturación y Verificar
    console.log('🎫 PASO 3 — Llenando código de facturación...');
    await page.waitForSelector('input#CodigoFacturacion, input[name="CodigoFacturacion"]', { timeout: 10000 });
    await page.click('input#CodigoFacturacion, input[name="CodigoFacturacion"]', { clickCount: 3 });
    await page.type('input#CodigoFacturacion, input[name="CodigoFacturacion"]', codigoTicket);
    console.log(`✅ Código llenado: ${codigoTicket}`);

    await page.click('button#btnVerificar');
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
    console.log('✅ Click en Verificar...');

    const yaFacturadoCheck = await page.evaluate(() => {
      const body = document.body.innerText;
      if (!body.match(/ya fue facturado|ya existe|ya procesado|previously invoiced/i)) return null;
      return body.match(/[A-Z]{2,6}-\d{6,10}/)?.[0] || 'desconocido';
    });
    if (yaFacturadoCheck !== null) {
      console.log('⚠️ Ticket ya facturado, saltando a recuperador...');
      const r = await runEstrategiaB(yaFacturadoCheck === 'desconocido' ? null : yaFacturadoCheck);
      await browser.close();
      return r;
    }
    console.log('✅ Ticket verificado correctamente');

    // PASO 4 — Forma de pago y Uso CFDI
    console.log('💳 PASO 4 — Seleccionando forma de pago y uso CFDI...');
    await page.waitForFunction(() => {
      const fp = document.querySelector('select#FormaDePago');
      return fp && !fp.disabled;
    }, { timeout: 10000 }).catch(() =>
      page.evaluate(() => {
        const fp = document.querySelector('select#FormaDePago');
        const uc = document.querySelector('select#UsoCFDI');
        if (fp) fp.removeAttribute('disabled');
        if (uc) uc.removeAttribute('disabled');
      })
    );
    await page.select('select#FormaDePago', '28');
    console.log('✅ Forma de pago: Tarjeta de débito (28)');
    await page.select('select#UsoCFDI', 'G03');
    console.log('✅ Uso CFDI: Gastos en general (G03)');

    // PASO 5 — Generar factura
    console.log('🧾 PASO 5 — Generando factura...');
    await page.evaluate(() => {
      const btn = document.querySelector('button[name="btn"][value="GenerarFactura"]');
      if (btn) {
        btn.removeAttribute('disabled');
        btn.click();
      }
    });
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});

    const paso5YaFacturado = await page.evaluate(() =>
      document.body.innerText.match(/ya fue facturado|ya existe|ya procesado|previously|ya tiene factura/i) !== null
    );
    if (paso5YaFacturado) {
      console.log('⚠️ PASO 5: ticket ya facturado — saltando a runEstrategiaB...');
      const r = await runEstrategiaB(null);
      await browser.close();
      return r;
    }

    const folioGenerado = await page.$eval('input#folioFactura', el => el.value).catch(() => null);
    console.log('✅ Folio generado:', folioGenerado);

    // PASO 6 — Enviar al correo de captura
    console.log('📧 PASO 6 — Enviando a correo de captura...');
    await page.evaluate(() => {
      const input = document.querySelector('input#correo');
      if (input) {
        input.removeAttribute('readonly');
        input.value = '';
      }
    });
    await page.type('input#correo', 'buzonfacturas@serviciosga.site', { delay: 50 });
    await page.evaluate(() => {
      const btn = document.querySelector('button[name="btn"][value="btnCorreo"]');
      if (btn) {
        btn.removeAttribute('disabled');
        btn.click();
      }
    });
    await page.waitForTimeout(3000);
    console.log('📧 Correo enviado a buzonfacturas@serviciosga.site');

    // PASO 7 — Descargar XML y PDF
    console.log('📥 PASO 7 — Descargando archivos...');
    let xmlBuffer = null, pdfBuffer = null;

    await page.evaluate(() => {
      document.querySelectorAll('input[type="submit"]').forEach(b => b.removeAttribute('disabled'));
    });

    const xmlBuf = await interceptarDescarga(() =>
      page.evaluate(() => {
        const btn = document.querySelector('input[type="submit"][value="Descargar XML"]');
        if (btn) btn.click();
      })
    ).catch(() => null);

    const pdfBuf = await interceptarDescarga(() =>
      page.evaluate(() => {
        const btn = document.querySelector('input[type="submit"][value="Descargar PDF"]');
        if (btn) btn.click();
      })
    ).catch(() => null);

    if (!xmlBuf && !pdfBuf) {
      console.log('⚠️ Descarga directa falló, usando recuperador...');
      await browser.close();
      return await runEstrategiaB(folioGenerado);
    }

    if (xmlBuf) xmlBuffer = xmlBuf;
    if (pdfBuf) pdfBuffer = pdfBuf;

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
