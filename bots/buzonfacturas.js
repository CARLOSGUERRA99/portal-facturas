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

  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}`,
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");

  try {
    // ── PASO 1: Navegar al portal ──
    console.log("🌐 Abriendo BuzonFacturas...");
    await page.goto("https://buzonfacturas.com/GenerarCFDI/Index?avanzada=0", {
      waitUntil: "networkidle2",
      timeout: 30000,
    });
    await page.waitForTimeout(2500);

    // ── PASO 2: Llenar RFC → click Buscar ──
    console.log("🔑 Llenando RFC:", rfc);
    const rfcSel = 'input[name="RFC"], input[id*="rfc" i], input[id*="RFC"], input[placeholder*="RFC"]';
    await page.waitForSelector(rfcSel, { timeout: 15000 });
    await page.click(rfcSel, { clickCount: 3 });
    await page.type(rfcSel, rfc, { delay: 80 });
    await page.waitForTimeout(500);

    console.log("🔍 Clic Buscar...");
    const buscado = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, input[type='submit'], a, span"));
      const btn = btns.find(b => /buscar/i.test(b.textContent || b.value || ""));
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (!buscado) throw new Error("No se encontró el botón Buscar");
    await page.waitForTimeout(4000);

    const ss1 = await page.screenshot({ encoding: "base64" });
    console.log("📸 Screenshot 1 — después de buscar RFC");

    // ── PASO 3: Guardar y continuar ──
    console.log("💾 Clic Guardar y continuar...");
    const guardado = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, input[type='submit'], a, span"));
      const btn = btns.find(b => /guardar.*continuar|guardar\s+y\s+continuar/i.test(b.textContent || b.value || ""));
      if (btn) { btn.click(); return true; }
      // fallback: any "continuar" button
      const cont = btns.find(b => /continuar/i.test(b.textContent || b.value || ""));
      if (cont) { cont.click(); return true; }
      return false;
    });
    if (!guardado) throw new Error("No se encontró botón Guardar y continuar");
    await page.waitForTimeout(3000);

    // ── PASO 4: Código de ticket → Verificar ──
    console.log("🎫 Llenando código de ticket:", codigoTicket);
    const codeCandidates = [
      'input[name*="codigo" i]',
      'input[name*="Codigo" ]',
      'input[name*="ticket" i]',
      'input[name*="folio" i]',
      'input[id*="codigo" i]',
      'input[id*="ticket" i]',
      'input[placeholder*="código" i]',
      'input[placeholder*="folio" i]',
      'input[placeholder*="ticket" i]',
      'input[type="text"]:not([id*="rfc" i]):not([name*="rfc" i])',
    ];
    let codeFilled = false;
    for (const sel of codeCandidates) {
      try {
        const el = await page.$(sel);
        if (el) {
          await el.click({ clickCount: 3 });
          await el.type(codigoTicket, { delay: 80 });
          console.log(`✅ Código llenado — selector: ${sel}`);
          codeFilled = true;
          break;
        }
      } catch {}
    }
    if (!codeFilled) throw new Error("No se encontró campo para el código de ticket");
    await page.waitForTimeout(500);

    console.log("✅ Clic Verificar...");
    const verificado = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, input[type='submit'], a, span"));
      const btn = btns.find(b => /verificar/i.test(b.textContent || b.value || ""));
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (!verificado) throw new Error("No se encontró botón Verificar");
    await page.waitForTimeout(4000);

    const ss2 = await page.screenshot({ encoding: "base64" });
    console.log("📸 Screenshot 2 — después de verificar código");

    // ── PASO 5: Forma de pago → Tarjeta de débito ──
    console.log("💳 Seleccionando Tarjeta de débito...");
    await page.evaluate(() => {
      const selects = document.querySelectorAll("select");
      for (const sel of selects) {
        const opts = Array.from(sel.options);
        const debito = opts.find(o => /d[eé]bito/i.test(o.text));
        if (debito) {
          sel.value = debito.value;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          console.log("💳 Forma de pago seleccionada:", debito.text);
          break;
        }
      }
    });
    await page.waitForTimeout(500);

    // ── PASO 6: Email (opcional) ──
    if (email) {
      console.log("📧 Llenando correo:", email);
      await page.evaluate((mail) => {
        const el = document.querySelector(
          'input[type="email"], input[name*="email" i], input[id*="email" i], input[placeholder*="correo" i], input[placeholder*="email" i]'
        );
        if (el) {
          el.value = "";
          el.value = mail;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }, email);
      await page.waitForTimeout(300);
    }

    // ── PASO 7: Generar factura ──
    console.log("🧾 Clic Generar factura...");
    const generado = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, input[type='submit'], a, span"));
      const btn = btns.find(b => /generar.*factura|generar\s+cfdi/i.test(b.textContent || b.value || ""));
      if (btn) { btn.click(); return true; }
      // fallback: any prominent submit
      const sub = document.querySelector("button[type='submit'], input[type='submit']");
      if (sub) { sub.click(); return true; }
      return false;
    });
    if (!generado) throw new Error("No se encontró botón Generar factura");
    await page.waitForTimeout(8000);

    const ss3 = await page.screenshot({ encoding: "base64" });
    console.log("📸 Screenshot 3 — después de generar factura");

    // ── PASO 8: Obtener links ──
    console.log("📥 Buscando links de descarga...");
    const links = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll("a"));
      const pdf = anchors.find(a => /\.pdf/i.test(a.href) || /\bpdf\b/i.test(a.textContent));
      const xml = anchors.find(a => /\.xml/i.test(a.href) || /\bxml\b/i.test(a.textContent));
      return { pdf: pdf?.href || null, xml: xml?.href || null };
    });
    console.log("🔗 Links:", links);

    if (!links.pdf && !links.xml) {
      await browser.close();
      return { ok: false, msg: "No se encontraron archivos de factura en el portal.", screenshot: ss3 };
    }

    // ── PASO 9: Descargar archivos a facturas/ ──
    const ts = Date.now();
    const xmlDest = path.join(facturasDir, `${ts}.xml`);
    const pdfDest = path.join(facturasDir, `${ts}.pdf`);

    try {
      if (links.xml) await downloadFile(links.xml, xmlDest);
      if (links.pdf) await downloadFile(links.pdf, pdfDest);
      console.log("✅ Archivos descargados:", ts);
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
