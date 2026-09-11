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
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${_bfToken}`
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

  // ⚠️ ESTA FUNCIÓN SOLO PUEDE CORRER CON EL FOLIO INTERNO EN LA MANO.
  //
  // Baja los archivos de la PRIMERA FILA de la tabla de DescargarFactura. Si se
  // la llama sin folio, esa primera fila es un CFDI CUALQUIERA del RFC — la
  // factura de OTRO ticket — y se la acaba pegando a este. No es un falso
  // positivo: es adjuntar el comprobante equivocado, que es peor, porque el
  // ticket queda "resuelto" con una factura que no le corresponde y nadie lo
  // vuelve a mirar. El `catch` general la llamaba justo así, con null.
  //
  // El portal EXIGE los dos datos (RFC **y** Folio interno): buscar solo por RFC
  // responde "El dato no puede estar vacío" — comprobado en vivo el 11-sep-2026.
  // Así que sin folio no hay nada que recuperar y lo honesto es decirlo.
  async function runEstrategiaB(folioHint) {
    if (!folioHint) {
      console.log('⛔ Estrategia B cancelada: sin folio interno se bajaría la factura de OTRO ticket');
      return { ok: false, sinFolio: true, msg: 'Estrategia B necesita el folio interno (BXI-xxxxxxx); sin él, la primera fila de la tabla es la factura de otro ticket.' };
    }
    try {
      console.log(`📥 Estrategia B — Recuperando ${folioHint} desde DescargarFactura...`);
      await page.waitForTimeout(2000);
      await page.goto('https://buzonfacturas.com/CFDI/DescargarFactura', {
        waitUntil: 'networkidle2',
        timeout: 30000,
      });
      await page.waitForTimeout(1500);

      // El id real es #RFC en MAYÚSCULAS. Los selectores CSS distinguen
      // mayúsculas, así que `input#Rfc` no casaba con nada y el RFC nunca se
      // escribía — el portal contestaba "El dato no puede estar vacío" y parecía
      // que el problema era otro.
      const rfcInput = await page.$('input#RFC, input[name="RFC"], input[placeholder*="RFC"]');
      if (rfcInput) {
        await rfcInput.click({ clickCount: 3 });
        await rfcInput.type(rfc, { delay: 60 });
      }

      const folio = folioHint;

      // El campo se llama FolioInterno, no Folio, y su placeholder es
      // "Ejemplo: BXI-0123456" — sin la palabra "folio". Los tres selectores
      // que había (`[name="Folio"]`, `[placeholder*="folio"]`) no casaban con
      // nada, así que el folio tampoco se escribía nunca.
      const folioInput = await page.$('input#FolioInterno, input[name="FolioInterno"], input[placeholder*="BXI" i]');
      if (!folioInput) {
        throw new Error('no apareció el campo de Folio interno en DescargarFactura');
      }
      await folioInput.click({ clickCount: 3 });
      await folioInput.type(folio, { delay: 60 });

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

  // Declarados FUERA del try a proposito: el catch los necesita. Antes
  // folioGenerado era un const dentro del try y en el catch ni existia, asi
  // que el unico dato con el que se puede recuperar la factura se perdia.
  let folioGenerado = null;
  let facturaDisparada = false;

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
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
      page.evaluate(() => {
        const btn = document.querySelector('button[type="submit"].btn-info');
        if (btn) btn.click();
      }),
    ]);
    console.log('✅ RFC enviado, URL:', page.url());

    // PASO 2 — Guardar y continuar → navega a /DatosTicket
    console.log('💾 PASO 2 — Guardando y continuando...');
    await page.waitForSelector(
      'button[name="btn"][value="GenerarFactura"], button.btn-success',
      { timeout: 10000 }
    );
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
      page.evaluate(() => {
        const btn = document.querySelector('button[name="btn"][value="GenerarFactura"]')
          || Array.from(document.querySelectorAll('button.btn-success'))
              .find(b => /guardar|continuar/i.test(b.textContent));
        if (btn) btn.click();
      }),
    ]);
    console.log('✅ Guardado, URL:', page.url());
    if (!page.url().includes('DatosTicket')) {
      throw new Error(`URL inesperada tras Guardar: ${page.url()}`);
    }

    // PASO 3 — Código de facturación y Verificar
    console.log('🎫 PASO 3 — Llenando código de facturación...');
    await page.waitForSelector('input#CodigoFacturacion, input[name="CodigoFacturacion"]', { timeout: 10000 });
    await page.click('input#CodigoFacturacion, input[name="CodigoFacturacion"]', { clickCount: 3 });
    await page.type('input#CodigoFacturacion, input[name="CodigoFacturacion"]', codigoTicket);
    console.log(`✅ Código llenado: ${codigoTicket}`);

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {}),
      page.click('button#btnVerificar'),
    ]);
    console.log('✅ Click en Verificar, URL:', page.url());

    const verificarCheck = await page.evaluate(() => {
      const body = document.body.innerText;
      if (body.match(/excede los 2 d[ií]as|más de 2 días|plazo.*vencido|fuera de plazo|tiempo.*expirado/i))
        return { tipo: 'vencido' };
      if (body.match(/ya fue facturado|ya existe|ya procesado|previously invoiced/i))
        return { tipo: 'yaFacturado', folio: body.match(/[A-Z]{2,6}-\d{6,10}/)?.[0] || null };
      return null;
    });
    if (verificarCheck?.tipo === 'vencido') {
      console.log('❌ Ticket fuera del plazo de 2 días permitidos');
      await browser.close();
      return { ok: false, msg: 'El ticket excede los 2 días permitidos para facturar en BuzonFacturas.' };
    }
    if (verificarCheck?.tipo === 'yaFacturado') {
      console.log('⚠️ Ticket ya facturado, saltando a recuperador...');
      const r = await runEstrategiaB(verificarCheck.folio);
      await browser.close();
      return r;
    }
    console.log('✅ Ticket verificado correctamente');

    // PASO 4 — Forma de pago, Uso CFDI y correo (todo antes de generar)
    console.log('💳 PASO 4 — Configurando forma de pago, CFDI y correo...');
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

    // Llenar correo ANTES de generar para que el portal lo envíe al generar
    await page.evaluate(() => {
      const input = document.querySelector('input#correo');
      if (input) {
        input.removeAttribute('readonly');
        input.value = '';
      }
    });
    await page.type('input#correo', 'buzonfacturas@serviciosga.site', { delay: 50 });
    console.log('📧 Correo de captura ingresado');

    // PASO 5 — Generar factura
    // A partir de este click el CFDI puede existir ya: ningún camino posterior
    // —ni el catch— puede devolver un error reintentable.
    console.log('🧾 PASO 5 — Generando factura...');
    facturaDisparada = true;
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {}),
      page.evaluate(() => {
        const btn = document.querySelector('button[name="btn"][value="GenerarFactura"]');
        if (btn) {
          btn.removeAttribute('disabled');
          btn.click();
        }
      }),
    ]);
    console.log('✅ PASO 5 completado, URL:', page.url());

    const paso5Error = await page.evaluate(() => {
      const body = document.body.innerText;
      if (body.match(/excede los 2 d[ií]as|más de 2 días|plazo.*vencido|fuera de plazo|tiempo.*expirado/i))
        return 'vencido';
      if (body.match(/ya fue facturado|ya existe|ya procesado|previously|ya tiene factura/i))
        return 'yaFacturado';
      return null;
    });
    if (paso5Error === 'vencido') {
      console.log('❌ PASO 5: ticket fuera del plazo de 2 días');
      await browser.close();
      return { ok: false, msg: 'El ticket excede los 2 días permitidos para facturar en BuzonFacturas.' };
    }
    if (paso5Error === 'yaFacturado') {
      console.log('⚠️ PASO 5: ticket ya facturado — retornando procesandoCorreo...');
      await browser.close();
      return { ok: true, procesandoCorreo: true };
    }

    // Buscar folio en múltiples selectores posibles
    folioGenerado = await page.evaluate(() => {
      const candidates = [
        document.querySelector('input#folioFactura'),
        document.querySelector('input[id*="folio" i]'),
        document.querySelector('input[id*="Folio"]'),
        document.querySelector('span#folioFactura'),
        document.querySelector('[id*="folio" i]'),
      ];
      for (const el of candidates) {
        const val = el?.value || el?.textContent;
        if (val && /[A-Z]{2,6}-\d+/.test(val)) return val.trim();
      }
      // Buscar en texto de la página
      const match = document.body.innerText.match(/[A-Z]{2,6}-\d{6,10}/);
      return match ? match[0] : null;
    });
    console.log('✅ Folio generado:', folioGenerado);

    // PASO 6 — Intentar reenviar correo si hay botón separado
    await page.evaluate(() => {
      const btn = document.querySelector('button[name="btn"][value="btnCorreo"]');
      if (btn) { btn.removeAttribute('disabled'); btn.click(); }
    });
    await page.waitForTimeout(2000);
    console.log('📧 Correo procesado (enviado al generar + reenvío si disponible)');

    // PASO 7 — Intentar descarga directa
    console.log('📥 PASO 7 — Intentando descarga directa...');
    let xmlBuffer = null, pdfBuffer = null;

    await page.evaluate(() => {
      document.querySelectorAll('input[type="submit"], a, button').forEach(b => {
        if (b.removeAttribute) b.removeAttribute('disabled');
      });
    });

    const xmlBuf = await interceptarDescarga(() =>
      page.evaluate(() => {
        const btn = document.querySelector('input[type="submit"][value="Descargar XML"]')
          || Array.from(document.querySelectorAll('a, button'))
              .find(el => el.textContent?.includes('XML') || el.href?.includes('.xml'));
        if (btn) { btn.scrollIntoView(); btn.click(); }
      })
    ).catch(() => null);

    const pdfBuf = await interceptarDescarga(() =>
      page.evaluate(() => {
        const btn = document.querySelector('input[type="submit"][value="Descargar PDF"]')
          || Array.from(document.querySelectorAll('a, button'))
              .find(el => el.textContent?.includes('PDF') || el.href?.includes('.pdf'));
        if (btn) { btn.scrollIntoView(); btn.click(); }
      })
    ).catch(() => null);

    if (!xmlBuf && !pdfBuf) {
      // El folio interno es el ÚNICO modo de recuperar esta factura después:
      // buzonfacturas.com exige RFC **y** folio para consultar, y el folio no
      // viene impreso en el ticket — lo asigna el portal al generar. Al #373 se
      // le perdió justo aquí y quedó irrecuperable. Va en el mensaje para que
      // sobreviva en la BD (lib/facturacion.js lo guarda en error_msg).
      console.log(`⚠️ Descarga directa falló — IMAP recogerá del correo. Folio interno: ${folioGenerado || '(no capturado)'}`);
      await browser.close();
      return {
        ok: true, procesandoCorreo: true, folioGenerado,
        msg: folioGenerado
          ? `BuzonFacturas: factura generada con folio interno ${folioGenerado}; la descarga directa falló y se espera por correo. Si el correo no llega, recupérala en buzonfacturas.com/CFDI/DescargarFactura con RFC + ${folioGenerado}. NO RELANZAR: se emitiría un duplicado.`
          : `BuzonFacturas: factura generada pero NO se pudo capturar el folio interno ni descargar los archivos. Si el correo no llega, la factura NO se puede consultar (el portal exige RFC + folio interno) y habrá que pedirla a la estación. NO RELANZAR: se emitiría un duplicado.`,
      };
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
    // ⚠️ Antes esto era `runEstrategiaB(null)`, que sin folio se traía la
    // primera fila de la tabla del RFC — la factura de OTRO ticket — y la
    // devolvía como si fuera de este. Ahora solo se intenta si tenemos el folio
    // interno de ESTA factura.
    const r = folioGenerado ? await runEstrategiaB(folioGenerado) : { ok: false, sinFolio: true };
    try { await browser.close(); } catch {}
    if (r && r.ok) return r;

    // Si el click de generar ya había salido, la factura puede existir: NO se
    // devuelve un error reintentable, porque el reintento de medianoche
    // emitiría un segundo CFDI al mismo ticket.
    if (facturaDisparada) {
      return {
        ok: true, procesandoCorreo: true, folioGenerado,
        msg: `BuzonFacturas: el bot falló (${err.message}) DESPUÉS de pulsar Generar. ${folioGenerado ? `Folio interno ${folioGenerado}.` : 'No se capturó el folio interno.'} NO RELANZAR: comprobar antes si el CFDI existe.`,
      };
    }
    return { ok: false, error_code: 'reintentar_despues', msg: `BuzonFacturas: ${err.message} (no se llegó a generar nada)` };
  }
}

module.exports = { facturarBuzonFacturas };
