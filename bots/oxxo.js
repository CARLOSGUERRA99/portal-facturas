const puppeteer = require("puppeteer");

async function facturarOXXO({ fecha, folio, idVenta, total, rfc, razonSocial, codigoPostal, regimenFiscal, usoCfdi }) {
  console.log("🤖 Iniciando bot OXXO...");

  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}`,
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  try {
    console.log("🌐 Abriendo portal OXXO...");
    await page.goto("https://www.oxxo.com/facturacion", { 
      waitUntil: "networkidle2", 
      timeout: 30000 
    });

    // Cerrar popup si aparece
    try {
      await page.waitForSelector(".close, .cerrar, [class*='close']", { timeout: 5000 });
      await page.click(".close, .cerrar, [class*='close']");
      console.log("✅ Popup cerrado");
    } catch {
      console.log("ℹ️ Sin popup");
    }

    // Llenar fecha
    console.log("📅 Llenando fecha...");
    await page.waitForSelector("input[name='fecha'], input[placeholder*='fecha'], input[placeholder*='Fecha']", { timeout: 15000 });
    await page.type("input[name='fecha'], input[placeholder*='fecha'], input[placeholder*='Fecha']", fecha);

    // Llenar folio
    console.log("🔢 Llenando folio...");
    await page.waitForSelector("input[name='folio'], input[placeholder*='folio'], input[placeholder*='Folio']", { timeout: 10000 });
    await page.type("input[name='folio'], input[placeholder*='folio'], input[placeholder*='Folio']", String(folio));

    // Llenar ID de venta
    console.log("🔑 Llenando ID venta...");
    await page.waitForSelector("input[name='idVenta'], input[placeholder*='ID'], input[placeholder*='id']", { timeout: 10000 });
    await page.type("input[name='idVenta'], input[placeholder*='ID'], input[placeholder*='id']", String(idVenta));

    // Llenar total
    console.log("💰 Llenando total...");
    await page.waitForSelector("input[name='total'], input[placeholder*='total'], input[placeholder*='Total'], input[placeholder*='monto'], input[placeholder*='Monto']", { timeout: 10000 });
    await page.type("input[name='total'], input[placeholder*='total'], input[placeholder*='Total'], input[placeholder*='monto'], input[placeholder*='Monto']", String(total));

    // Validar ticket
    console.log("✅ Validando ticket...");
    await page.click("button[type='submit'], input[type='submit'], button[class*='validar'], button[class*='buscar']");
    await page.waitForTimeout(3000);

    // Llenar RFC
    console.log("📋 Llenando datos fiscales...");
    await page.waitForSelector("input[name='rfc'], input[placeholder*='RFC']", { timeout: 15000 });
    await page.type("input[name='rfc'], input[placeholder*='RFC']", rfc);

    // Llenar razón social
    await page.waitForSelector("input[name='razonSocial'], input[name='razon_social'], input[placeholder*='Raz']", { timeout: 10000 });
    await page.type("input[name='razonSocial'], input[name='razon_social'], input[placeholder*='Raz']", razonSocial);

    // Llenar CP
    await page.waitForSelector("input[name='cp'], input[name='codigoPostal'], input[placeholder*='postal'], input[placeholder*='Postal']", { timeout: 10000 });
    await page.type("input[name='cp'], input[name='codigoPostal'], input[placeholder*='postal'], input[placeholder*='Postal']", codigoPostal);

    // Seleccionar régimen fiscal
    await page.waitForSelector("select[name='regimenFiscal'], select[name='regimen']", { timeout: 10000 });
    await page.select("select[name='regimenFiscal'], select[name='regimen']", String(regimenFiscal));

    // Seleccionar uso CFDI
    await page.waitForSelector("select[name='usoCfdi'], select[name='uso_cfdi'], select[name='uso']", { timeout: 10000 });
    await page.select("select[name='usoCfdi'], select[name='uso_cfdi'], select[name='uso']", usoCfdi || "G03");

    // Generar factura
    console.log("🧾 Generando factura...");
    await page.click("button[type='submit'], button[class*='generar'], button[class*='factura']");
    await page.waitForTimeout(5000);

    // Obtener links de descarga
    console.log("📥 Buscando links de descarga...");
    const links = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll("a"));
      const pdf = anchors.find(a => a.href.includes(".pdf") || a.textContent.includes("PDF"));
      const xml = anchors.find(a => a.href.includes(".xml") || a.textContent.includes("XML"));
      return {
        pdf: pdf ? pdf.href : null,
        xml: xml ? xml.href : null,
      };
    });

    console.log("✅ Links obtenidos:", links);
    await browser.close();
    return { ok: true, pdf: links.pdf, xml: links.xml };

  } catch (err) {
    console.error("❌ Error en bot OXXO:", err.message);
    
    // Tomar screenshot para debug
    try {
      const screenshot = await page.screenshot({ encoding: "base64" });
      await browser.close();
      return { ok: false, msg: err.message, screenshot };
    } catch {
      await browser.close();
      return { ok: false, msg: err.message };
    }
  }
}

module.exports = { facturarOXXO };
