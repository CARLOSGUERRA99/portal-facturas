const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");

async function facturarGasmaz({ referencia, folio, total, rfc, email, ticketId, portalUrl }) {
  console.log("🤖 Iniciando bot Gasmaz/NexusFuel...");

  const url = (portalUrl && portalUrl.includes('nexusfuel')) ? portalUrl : 'https://gasmazfactura.nexusfuel.mx/';
  console.log("🌐 URL portal:", url);

  const _gmToken = process.env.BROWSERLESS_TOKEN;
  if (!_gmToken) throw new Error('BROWSERLESS_TOKEN no definido');
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${_gmToken}&timeout=120000`
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");

  try {
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    await page.waitForTimeout(2000);

    // ── PASO 1 — Llenar campos del ticket ──
    console.log("📋 Llenando campos del ticket...");
    await page.waitForSelector('input', { timeout: 10000 });

    const inputs = await page.$$('input[type="text"], input:not([type])');
    if (inputs[0]) { await inputs[0].click({ clickCount: 3 }); await inputs[0].type(String(referencia), { delay: 80 }); }
    if (inputs[1]) { await inputs[1].click({ clickCount: 3 }); await inputs[1].type(String(folio), { delay: 80 }); }
    if (inputs[2]) { await inputs[2].click({ clickCount: 3 }); await inputs[2].type(parseFloat(total).toFixed(2), { delay: 80 }); }
    console.log(`✅ Referencia: ${referencia}, Folio: ${folio}, Total: ${parseFloat(total).toFixed(2)}`);

    // RFC — verificar y corregir si es necesario
    const rfcInput = await page.$('input[value*="GPR"], input#rfc, input[placeholder*="RFC"]');
    if (rfcInput) {
      const rfcVal = await rfcInput.evaluate(el => el.value);
      if (rfcVal !== rfc) {
        console.log(`⚠️ RFC en campo: "${rfcVal}", reemplazando con: "${rfc}"`);
        await rfcInput.click({ clickCount: 3 });
        await rfcInput.type(rfc, { delay: 80 });
      } else {
        console.log("✅ RFC correcto:", rfcVal);
      }
    }
    await page.waitForTimeout(500);

    // ── PASO 2 — Verificar selects ──
    console.log("📋 Configurando selects...");
    await page.evaluate(() => {
      const selects = Array.from(document.querySelectorAll('select'));

      // Régimen fiscal — 601 General de Ley
      const regimen = selects.find(s =>
        Array.from(s.options).some(o => o.text.includes('601') || o.text.includes('General de Ley'))
      );
      if (regimen) {
        const opt = Array.from(regimen.options)
          .find(o => o.text.includes('601') || o.text.includes('General de Ley'));
        if (opt) regimen.value = opt.value;
      }

      // Uso CFDI — Gastos en general
      const cfdi = selects.find(s =>
        Array.from(s.options).some(o => o.text.toLowerCase().includes('gasto'))
      );
      if (cfdi) {
        const opt = Array.from(cfdi.options)
          .find(o => o.text.toLowerCase().includes('gasto'));
        if (opt) cfdi.value = opt.value;
      }

      // Forma de pago — Tarjeta de débito
      const pago = selects.find(s =>
        Array.from(s.options).some(o => o.text.toLowerCase().includes('débito') || o.text.toLowerCase().includes('debito'))
      );
      if (pago) {
        const opt = Array.from(pago.options)
          .find(o => o.text.toLowerCase().includes('débito') || o.text.toLowerCase().includes('debito'));
        if (opt) pago.value = opt.value;
      }
    });
    await page.waitForTimeout(500);

    // ── PASO 3 — Correo de captura IMAP ──
    const correoInput = await page.$('input[placeholder*="orreo"], input[type="email"]');
    if (correoInput) {
      await correoInput.click({ clickCount: 3 });
      await correoInput.type('buzonfacturas@serviciosga.site', { delay: 50 });
      console.log("📧 Correo de captura ingresado");
    }
    await page.waitForTimeout(300);

    const ss1 = await page.screenshot({ encoding: "base64" });
    console.log("📸 Screenshot antes de facturar");

    // ── PASO 4 — Click Facturar ──
    console.log("🧾 Haciendo click en Facturar...");
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, input[type="submit"]'));
      const btn = btns.find(b => b.textContent?.includes('Facturar') || b.value?.includes('Facturar'));
      if (btn) btn.click();
    });
    await page.waitForTimeout(5000);

    // ── PASO 5 — Esperar pantalla de descarga y capturar archivos ──
    await page.waitForFunction(() => {
      const body = document.body.innerText;
      return body.includes('PDF') && body.includes('XML');
    }, { timeout: 15000 });
    console.log("✅ Pantalla de descarga detectada");

    let pdfUrl = null;
    let xmlUrl = null;

    // PDF
    const newPagePdfPromise = new Promise(resolve =>
      browser.once('targetcreated', t => resolve(t.page()))
    );
    const pdfClicked = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a, button'));
      const btn = links.find(b => b.textContent?.includes('PDF') || b.href?.includes('.pdf'));
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (pdfClicked) {
      const newPage = await Promise.race([
        newPagePdfPromise,
        new Promise((_, r) => setTimeout(() => r(), 8000))
      ]).catch(() => null);
      if (newPage) {
        await newPage.waitForTimeout(2000);
        const response = await newPage.waitForResponse(
          r => r.status() === 200, { timeout: 10000 }
        ).catch(() => null);
        if (response) {
          const buf = await response.buffer().catch(() => null);
          if (buf) {
            pdfUrl = await subirArchivoR2(buf, `facturas/gasmaz_${Date.now()}.pdf`, 'application/pdf');
            console.log('✅ PDF subido a R2:', pdfUrl);
          }
        }
        await newPage.close().catch(() => {});
      }
    }

    // XML
    const newPageXmlPromise = new Promise(resolve =>
      browser.once('targetcreated', t => resolve(t.page()))
    );
    const xmlClicked = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a, button'));
      const btn = links.find(b => b.textContent?.includes('XML') || b.href?.includes('.xml'));
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (xmlClicked) {
      const newPage = await Promise.race([
        newPageXmlPromise,
        new Promise((_, r) => setTimeout(() => r(), 8000))
      ]).catch(() => null);
      if (newPage) {
        await newPage.waitForTimeout(2000);
        const response = await newPage.waitForResponse(
          r => r.status() === 200, { timeout: 10000 }
        ).catch(() => null);
        if (response) {
          const buf = await response.buffer().catch(() => null);
          if (buf) {
            xmlUrl = await subirArchivoR2(buf, `facturas/gasmaz_${Date.now()}.xml`, 'application/xml');
            console.log('✅ XML subido a R2:', xmlUrl);
          }
        }
        await newPage.close().catch(() => {});
      }
    }

    await browser.close();

    if (!xmlUrl && !pdfUrl) {
      console.log('⚠️ Sin archivos directos, IMAP recogerá del correo');
      return { ok: true, procesandoCorreo: true };
    }

    return { ok: true, xmlUrl, pdfUrl };

  } catch (err) {
    console.error("❌ Error en bot Gasmaz:", err.message);
    let screenshot = null;
    try { screenshot = await page.screenshot({ encoding: "base64" }); } catch {}
    await browser.close();
    return { ok: false, msg: err.message, screenshot };
  }
}

module.exports = { facturarGasmaz };
