const puppeteer = require("puppeteer");
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");

const facturasDir = path.join(__dirname, "..", "facturas");
if (!fs.existsSync(facturasDir)) fs.mkdirSync(facturasDir, { recursive: true });

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(destPath);
    protocol.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlink(destPath, () => {});
        return downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
      }
      res.pipe(file);
      file.on("finish", () => { file.close(); resolve(); });
    }).on("error", (err) => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

async function facturarBuzonFacturas({ rfc, codigoTicket, email }) {
  console.log("🤖 Iniciando bot BuzonFacturas...");
  console.log(`   RFC: ${rfc} | Código: ${codigoTicket} | Email: ${email}`);

  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}`,
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  );

  // Interceptar URLs de descarga que dispare el navegador
  let downloadedXmlUrl = null;
  let downloadedPdfUrl = null;
  page.on("response", async (response) => {
    const url = response.url();
    const ct = response.headers()["content-type"] || "";
    if (ct.includes("application/xml") || url.toLowerCase().includes(".xml")) {
      downloadedXmlUrl = url;
    }
    if (ct.includes("application/pdf") || url.toLowerCase().includes(".pdf")) {
      downloadedPdfUrl = url;
    }
  });

  try {
    // ── PASO 1: RFC ──
    console.log("🌐 PASO 1 — Navegando a BuzonFacturas...");
    await page.goto("https://buzonfacturas.com/GenerarCFDI/Index?avanzada=0", {
      waitUntil: "networkidle2",
      timeout: 30000,
    });

    console.log("🔑 Esperando input RFC...");
    await page.waitForSelector('input[name="Rfc"]', { timeout: 10000 });
    await page.click('input[name="Rfc"]', { clickCount: 3 });
    await page.type('input[name="Rfc"]', rfc, { delay: 60 });
    console.log(`✅ RFC llenado: ${rfc}`);

    console.log("🔍 Clic en Buscar...");
    const buscado = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, input[type='submit']"));
      const btn = btns.find(b => /buscar/i.test(b.textContent || b.value || ""));
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (!buscado) throw new Error("No se encontró el botón Buscar");
    await page.waitForTimeout(3000);

    const ss1 = await page.screenshot({ encoding: "base64" });
    console.log("📸 Screenshot 1 — después de buscar RFC");

    // ── PASO 2: Guardar y continuar ──
    console.log("💾 PASO 2 — Esperando botón 'Guardar y continuar'...");
    await page.waitForSelector("button.btn-success, input.btn-success", { timeout: 10000 });

    const guardado = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button.btn-success, input.btn-success"));
      const btn = btns.find(b => /guardar.*continuar|guardar\s+y\s+continuar/i.test(b.textContent || b.value || ""));
      if (btn) { btn.click(); return true; }
      // Fallback: primer btn-success disponible
      if (btns.length) { btns[0].click(); return true; }
      return false;
    });
    if (!guardado) throw new Error("No se encontró botón 'Guardar y continuar'");

    console.log("⏳ Esperando navegación a DatosTicket...");
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 }).catch(() => {});
    console.log(`✅ URL actual: ${page.url()}`);

    // ── PASO 3: Código de facturación ──
    console.log("🎫 PASO 3 — Esperando campo CodigoFacturacion...");
    await page.waitForSelector('input#CodigoFacturacion, input[name="CodigoFacturacion"]', { timeout: 10000 });

    const codeEl = await page.$('input#CodigoFacturacion');
    const codeSel = codeEl ? 'input#CodigoFacturacion' : 'input[name="CodigoFacturacion"]';
    await page.click(codeSel, { clickCount: 3 });
    await page.type(codeSel, codigoTicket, { delay: 60 });
    console.log(`✅ Código de facturación llenado: ${codigoTicket}`);

    console.log("✅ Clic en Verificar...");
    const verificado = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, input[type='submit']"));
      const btn = btns.find(b => /verificar/i.test(b.textContent || b.value || ""));
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (!verificado) throw new Error("No se encontró botón Verificar");

    console.log("⏳ Esperando confirmación de verificación (Estación / Fecha / Número de venta)...");
    await page.waitForFunction(
      () => /estaci[oó]n|n[uú]mero de venta|fecha/i.test(document.body.innerText || ""),
      { timeout: 15000 }
    );
    console.log("✅ Ticket verificado correctamente");

    const ss2 = await page.screenshot({ encoding: "base64" });
    console.log("📸 Screenshot 2 — después de verificar código");

    // ── PASO 4: Forma de pago → Tarjeta de débito (valor 28) ──
    console.log("💳 PASO 4 — Seleccionando forma de pago (débito)...");
    await page.evaluate(() => {
      const selects = document.querySelectorAll("select");
      for (const sel of selects) {
        const name = (sel.name || sel.id || "").toLowerCase();
        // Saltar selects de Uso CFDI
        if (name.includes("uso") || name.includes("cfdi")) continue;
        const opts = Array.from(sel.options);
        const debito = opts.find(o => o.value === "28") || opts.find(o => /d[eé]bito/i.test(o.text));
        if (debito) {
          sel.value = debito.value;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          console.log("💳 Forma de pago seleccionada:", debito.text, "value:", debito.value);
          break;
        }
      }
    });
    await page.waitForTimeout(500);

    // ── PASO 5: Generar factura ──
    console.log("🧾 PASO 5 — Clic en Generar factura...");
    const generado = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll("button, input[type='submit']"));
      const btn = all.find(b => /generar.*factura|generar\s+cfdi/i.test(b.textContent || b.value || ""));
      if (btn) { btn.click(); return (btn.textContent || btn.value || "").trim(); }
      // Fallback: btn-success que no sea Verificar/Buscar
      const fallback = all.find(b =>
        b.classList.contains("btn-success") &&
        !/verificar|buscar/i.test(b.textContent || b.value || "")
      );
      if (fallback) { fallback.click(); return (fallback.textContent || fallback.value || "").trim(); }
      return null;
    });
    if (!generado) throw new Error("No se encontró botón Generar factura");
    console.log(`🔘 Botón clickeado: "${generado}"`);

    console.log("⏳ Esperando campo 'Folio factura' con valor...");
    await page.waitForFunction(
      () => /folio\s+factura|folio\s+fiscal/i.test(document.body.innerText || ""),
      { timeout: 20000 }
    );
    console.log("✅ Factura generada exitosamente");

    const ss3 = await page.screenshot({ encoding: "base64" });
    console.log("📸 Screenshot 3 — factura generada");

    // ── PASO 6: Correo electrónico y enviar XML/PDF ──
    if (email) {
      console.log(`📧 PASO 6 — Llenando correo: ${email}`);
      await page.evaluate((mail) => {
        const el = document.querySelector(
          'input[type="email"], input[name*="email" i], input[id*="email" i], input[placeholder*="correo" i], input[placeholder*="email" i]'
        );
        if (el) {
          el.value = "";
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.value = mail;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }, email);
      await page.waitForTimeout(400);

      console.log("📤 Clic en Enviar XML/PDF...");
      const enviado = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button, input[type='submit'], a"));
        const btn = btns.find(b => /enviar\s*(xml|pdf|comprobante)?/i.test(b.textContent || b.value || ""));
        if (btn) { btn.click(); return true; }
        return false;
      });
      if (enviado) {
        await page.waitForTimeout(2000);
        console.log("✅ Correo enviado");
      } else {
        console.log("⚠️ No se encontró botón Enviar XML/PDF — continuando con descarga directa");
      }
    }

    // ── PASO 7: Descargar archivos ──
    console.log("📥 PASO 7 — Buscando links de descarga...");
    await page.waitForTimeout(1500);

    const links = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll("a"));
      const xml = anchors.find(a => /descargar\s*xml|\.xml/i.test(a.textContent + a.href));
      const pdf = anchors.find(a => /descargar\s*pdf|\.pdf/i.test(a.textContent + a.href));
      return { xml: xml?.href || null, pdf: pdf?.href || null };
    });
    console.log("🔗 Links encontrados en DOM:", links);

    // Completar con URLs interceptadas si faltan
    if (!links.xml && downloadedXmlUrl) links.xml = downloadedXmlUrl;
    if (!links.pdf && downloadedPdfUrl) links.pdf = downloadedPdfUrl;
    console.log("🔗 Links finales:", links);

    if (!links.pdf && !links.xml) {
      await browser.close();
      return { ok: false, msg: "No se encontraron archivos de factura en el portal.", screenshot: ss3 };
    }

    // ── Descargar a disco ──
    const ts = Date.now();
    const xmlDest = path.join(facturasDir, `${ts}.xml`);
    const pdfDest = path.join(facturasDir, `${ts}.pdf`);

    try {
      if (links.xml) await downloadFile(links.xml, xmlDest);
      if (links.pdf) await downloadFile(links.pdf, pdfDest);
      console.log(`✅ Archivos guardados con timestamp: ${ts}`);
      await browser.close();
      return {
        ok: true,
        pdf: links.pdf ? `/facturas/${ts}.pdf` : null,
        xml: links.xml ? `/facturas/${ts}.xml` : null,
      };
    } catch (dlErr) {
      console.log("⚠️ Descarga local falló, usando URLs remotas:", dlErr.message);
      await browser.close();
      return { ok: true, pdf: links.pdf, xml: links.xml };
    }

  } catch (err) {
    console.error("❌ Error en bot BuzonFacturas:", err.message);
    try {
      const screenshot = await page.screenshot({ encoding: "base64" });
      await browser.close();
      return { ok: false, msg: err.message, screenshot };
    } catch {
      try { await browser.close(); } catch {}
      return { ok: false, msg: err.message };
    }
  }
}

module.exports = { facturarBuzonFacturas };
