const puppeteer = require("puppeteer");
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const unzipper = require("unzipper");

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

// ── Helper: descarga iconos en tabla DescargarFactura ──
async function runEstrategiaB({ page, rfc, ts, xmlDest, pdfDest, folioHint }) {
  console.log("📥 Estrategia B — Recuperar factura desde DescargarFactura...");

  // Extraer folio de la página actual si no viene del caller
  let folio = folioHint || null;
  if (!folio) {
    folio = await page.evaluate(() => {
      const el = document.querySelector(
        'input#FolioFactura, input[name="FolioFactura"], input[id*="folio" i], input[name*="folio" i]'
      );
      if (el && el.value) return el.value.trim();
      const match = document.body.innerText.match(/[A-Z]{2,6}-\d{6,10}/);
      return match ? match[0] : null;
    });
  }
  console.log("🔍 Folio para DescargarFactura:", folio);
  if (!folio) throw new Error("No se pudo extraer el folio de factura de la página");

  await page.goto("https://buzonfacturas.com/CFDI/DescargarFactura", {
    waitUntil: "networkidle2",
    timeout: 20000,
  });
  console.log("🌐 Navegado a DescargarFactura");
  console.log(`   RFC: ${rfc} | Folio: ${folio} (la página los carga automáticamente)`);

  // Esperar tabla con resultados
  await page.waitForSelector("table tbody tr", { timeout: 10000 });
  console.log("📋 Tabla de facturas visible");

  const ssB = await page.screenshot({ encoding: "base64" });
  console.log("📸 Screenshot B — tabla DescargarFactura");

  // ── Click icono 1 (PDF) ──
  console.log("📄 B: Interceptando click en icono PDF (1er icono)...");
  const pdfResponsePromise = page.waitForResponse(
    r => r.status() === 200 && (
      r.headers()["content-type"]?.includes("pdf") ||
      r.headers()["content-type"]?.includes("xml") ||
      r.headers()["content-type"]?.includes("zip") ||
      r.headers()["content-disposition"]?.includes("attachment")
    ),
    { timeout: 15000 }
  ).catch(() => null);

  await page.click(
    "table tbody tr:first-child td:last-child img:first-child, " +
    "table tbody tr:first-child td.opciones a:first-child, " +
    "table tbody tr:first-child td:last-child a:first-child"
  );
  const pdfResponse = await pdfResponsePromise;

  if (pdfResponse) {
    const ct = pdfResponse.headers()["content-type"] || "";
    const cd = pdfResponse.headers()["content-disposition"] || "";
    const buf = await pdfResponse.buffer();
    console.log(`📦 B: icono1 — content-type: ${ct} | disposition: ${cd} | ${buf.length} bytes`);

    if (ct.includes("zip") || pdfResponse.url().includes(".zip")) {
      const dir = await unzipper.Open.buffer(buf);
      for (const entry of dir.files) {
        const name = entry.path.toLowerCase();
        if (name.endsWith(".xml") && !fs.existsSync(xmlDest)) {
          fs.writeFileSync(xmlDest, await entry.buffer());
          console.log("✅ B: XML extraído del ZIP (icono1)");
        } else if (name.endsWith(".pdf") && !fs.existsSync(pdfDest)) {
          fs.writeFileSync(pdfDest, await entry.buffer());
          console.log("✅ B: PDF extraído del ZIP (icono1)");
        }
      }
    } else if (ct.includes("pdf") || cd.toLowerCase().includes(".pdf")) {
      if (!fs.existsSync(pdfDest)) fs.writeFileSync(pdfDest, buf);
      console.log("✅ B: PDF guardado (icono1)");
    } else if (ct.includes("xml") || cd.toLowerCase().includes(".xml")) {
      if (!fs.existsSync(xmlDest)) fs.writeFileSync(xmlDest, buf);
      console.log("✅ B: XML guardado (icono1)");
    }
  } else {
    console.log("⚠️ B: no se interceptó respuesta del primer icono");
  }

  // ── Click icono 2 (XML) ──
  console.log("📄 B: Interceptando click en icono XML (2do icono)...");
  const xmlResponsePromise = page.waitForResponse(
    r => r.status() === 200 && (
      r.headers()["content-type"]?.includes("xml") ||
      r.headers()["content-type"]?.includes("zip") ||
      r.headers()["content-disposition"]?.includes("attachment")
    ),
    { timeout: 15000 }
  ).catch(() => null);

  await page.click(
    "table tbody tr:first-child td:last-child img:nth-child(2), " +
    "table tbody tr:first-child td.opciones a:nth-child(2), " +
    "table tbody tr:first-child td:last-child a:nth-child(2)"
  );
  const xmlResponse = await xmlResponsePromise;

  if (xmlResponse) {
    const ct = xmlResponse.headers()["content-type"] || "";
    const cd = xmlResponse.headers()["content-disposition"] || "";
    const buf = await xmlResponse.buffer();
    console.log(`📦 B: icono2 — content-type: ${ct} | disposition: ${cd} | ${buf.length} bytes`);

    if (ct.includes("zip") || xmlResponse.url().includes(".zip")) {
      const dir = await unzipper.Open.buffer(buf);
      for (const entry of dir.files) {
        const name = entry.path.toLowerCase();
        if (name.endsWith(".xml") && !fs.existsSync(xmlDest)) {
          fs.writeFileSync(xmlDest, await entry.buffer());
          console.log("✅ B: XML extraído del ZIP (icono2)");
        } else if (name.endsWith(".pdf") && !fs.existsSync(pdfDest)) {
          fs.writeFileSync(pdfDest, await entry.buffer());
          console.log("✅ B: PDF extraído del ZIP (icono2)");
        }
      }
    } else if (ct.includes("xml") || cd.toLowerCase().includes(".xml")) {
      if (!fs.existsSync(xmlDest)) fs.writeFileSync(xmlDest, buf);
      console.log("✅ B: XML guardado (icono2)");
    }
  } else {
    console.log("⚠️ B: no se interceptó respuesta del segundo icono");
  }

  if (!fs.existsSync(xmlDest) && !fs.existsSync(pdfDest)) {
    throw new Error("Estrategia B: clicks en iconos realizados pero no se guardaron archivos");
  }
  console.log("✅ Estrategia B exitosa");
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

  // Interceptar URLs de descarga pasivas
  let downloadedXmlUrl = null;
  let downloadedPdfUrl = null;
  page.on("response", async (response) => {
    const url = response.url();
    const ct = response.headers()["content-type"] || "";
    if (ct.includes("application/xml") || url.toLowerCase().includes(".xml")) downloadedXmlUrl = url;
    if (ct.includes("application/pdf") || url.toLowerCase().includes(".pdf")) downloadedPdfUrl = url;
  });

  try {
    // ── PASO 1: RFC ──
    console.log("🌐 PASO 1 — Navegando a BuzonFacturas...");
    await page.goto("https://buzonfacturas.com/GenerarCFDI/Index?avanzada=0", {
      waitUntil: "networkidle2",
      timeout: 30000,
    });

    console.log("🔑 Esperando input RFC...");
    const rfcSelectors = [
      'input[name="Rfc"]',
      'input#Rfc',
      'input[placeholder*="RFC"]',
      'input[placeholder*="rfc"]',
    ];
    let rfcSel = null;
    for (const sel of rfcSelectors) {
      try {
        await page.waitForSelector(sel, { timeout: 20000 });
        rfcSel = sel;
        console.log(`✅ Input RFC encontrado con selector: ${sel}`);
        break;
      } catch {
        console.log(`⚠️ Selector no encontrado: ${sel}`);
      }
    }
    if (!rfcSel) {
      const found = await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'));
        const visible = inputs.find(el => el.offsetParent !== null);
        if (visible) { visible.setAttribute('data-rfc-fallback', '1'); return true; }
        return false;
      });
      if (found) {
        rfcSel = 'input[data-rfc-fallback="1"]';
        console.log("⚠️ Usando fallback: primer input visible de la página");
      } else {
        const html = await page.content();
        console.log("PAGE HTML:", html.substring(0, 2000));
        throw new Error("No se encontró ningún input para el RFC en la página");
      }
    }

    await page.click(rfcSel, { clickCount: 3 });
    await page.type(rfcSel, rfc, { delay: 60 });
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

    // Esperar confirmación OR mensaje de ya-facturado
    console.log("⏳ Esperando respuesta del portal tras Verificar...");
    await page.waitForFunction(
      () => /estaci[oó]n|n[uú]mero de venta|ya fue facturado|ya existe una factura|ticket ya procesado|ya facturado|factura.*generada/i
            .test(document.body.innerText || ""),
      { timeout: 15000 }
    );

    // Detectar si el ticket ya estaba facturado
    const yaFacturado = await page.evaluate(() =>
      /ya fue facturado|ya existe una factura|ticket ya procesado|ya facturado/i
        .test(document.body.innerText || "")
    );

    const ss2 = await page.screenshot({ encoding: "base64" });
    console.log("📸 Screenshot 2 — respuesta tras Verificar");

    if (yaFacturado) {
      console.log("⚠️ Ticket ya facturado, saltando a recuperador...");
      // Intentar extraer folio visible en el mensaje
      const folioHint = await page.evaluate(() => {
        const match = document.body.innerText.match(/[A-Z]{2,6}-\d{6,10}/);
        return match ? match[0] : null;
      });
      console.log("🔍 Folio encontrado en página:", folioHint);

      const ts = Date.now();
      const xmlDest = path.join(facturasDir, `${ts}.xml`);
      const pdfDest = path.join(facturasDir, `${ts}.pdf`);

      await runEstrategiaB({ page, rfc, ts, xmlDest, pdfDest, folioHint });

      const xmlOk = fs.existsSync(xmlDest);
      const pdfOk = fs.existsSync(pdfDest);
      await browser.close();
      return {
        ok: true,
        xml: xmlOk ? `/facturas/${ts}.xml` : null,
        pdf: pdfOk ? `/facturas/${ts}.pdf` : null,
      };
    }

    console.log("✅ Ticket verificado correctamente");

    // ── PASO 4: Forma de pago → Tarjeta de débito (valor 28) ──
    console.log("💳 PASO 4 — Seleccionando forma de pago (débito)...");
    await page.evaluate(() => {
      const selects = document.querySelectorAll("select");
      for (const sel of selects) {
        const name = (sel.name || sel.id || "").toLowerCase();
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
    console.log("📥 PASO 7 — Iniciando descarga de archivos...");
    await page.waitForTimeout(1500);

    const ts = Date.now();
    const xmlDest = path.join(facturasDir, `${ts}.xml`);
    const pdfDest = path.join(facturasDir, `${ts}.pdf`);

    // ── ESTRATEGIA A: interceptar respuesta del botón Descargar XML ──
    console.log("📥 Estrategia A — Interceptar respuesta del botón Descargar XML...");
    let strategyAOk = false;
    try {
      const downloadPromise = page.waitForResponse(
        r => {
          const url = r.url();
          const ct = r.headers()["content-type"] || "";
          return (
            url.includes(".zip") || ct.includes("zip") ||
            url.includes(".xml") || ct.includes("xml") ||
            url.includes(".pdf") || ct.includes("pdf")
          );
        },
        { timeout: 12000 }
      ).catch(() => null);

      const clickedDownload = await page.evaluate(() => {
        const anchors = Array.from(document.querySelectorAll("a, button"));
        const btn = anchors.find(a => /descargar\s*xml/i.test(a.textContent + (a.href || "")));
        if (btn) { btn.click(); return true; }
        return false;
      });
      console.log("🖱️ Clic Descargar XML:", clickedDownload);

      const dlResponse = await downloadPromise;
      if (dlResponse) {
        const ct = dlResponse.headers()["content-type"] || "";
        const buf = await dlResponse.buffer();
        console.log(`📦 Respuesta interceptada: ${ct} — ${buf.length} bytes`);

        if (ct.includes("zip") || dlResponse.url().includes(".zip")) {
          console.log("📦 Formato ZIP detectado — extrayendo archivos...");
          const dir = await unzipper.Open.buffer(buf);
          for (const entry of dir.files) {
            const name = entry.path.toLowerCase();
            if (name.endsWith(".xml")) {
              fs.writeFileSync(xmlDest, await entry.buffer());
              console.log(`✅ XML extraído del ZIP: ${entry.path}`);
            } else if (name.endsWith(".pdf")) {
              fs.writeFileSync(pdfDest, await entry.buffer());
              console.log(`✅ PDF extraído del ZIP: ${entry.path}`);
            }
          }
        } else if (ct.includes("xml") || dlResponse.url().includes(".xml")) {
          fs.writeFileSync(xmlDest, buf);
          console.log("✅ XML guardado directamente");
        } else if (ct.includes("pdf") || dlResponse.url().includes(".pdf")) {
          fs.writeFileSync(pdfDest, buf);
          console.log("✅ PDF guardado directamente");
        }

        // Si falta PDF, intentar botón Descargar PDF
        if (!fs.existsSync(pdfDest)) {
          const pdfPromise = page.waitForResponse(
            r => r.url().includes(".pdf") || (r.headers()["content-type"] || "").includes("pdf"),
            { timeout: 8000 }
          ).catch(() => null);

          await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll("a, button"));
            const btn = btns.find(a => /descargar\s*pdf/i.test(a.textContent + (a.href || "")));
            if (btn) btn.click();
          });

          const pdfResp = await pdfPromise;
          if (pdfResp) {
            fs.writeFileSync(pdfDest, await pdfResp.buffer());
            console.log("✅ PDF descargado en segundo click");
          }
        }

        strategyAOk = fs.existsSync(xmlDest) || fs.existsSync(pdfDest);
        if (strategyAOk) console.log("✅ Estrategia A exitosa");
      } else {
        console.log("⚠️ Estrategia A: no se interceptó respuesta de descarga");
      }
    } catch (eA) {
      console.log("⚠️ Estrategia A falló:", eA.message);
    }

    // ── ESTRATEGIA B: iconos en tabla DescargarFactura ──
    if (!strategyAOk) {
      try {
        await runEstrategiaB({ page, rfc, ts, xmlDest, pdfDest, folioHint: null });
      } catch (eB) {
        console.log("❌ Estrategia B falló:", eB.message);
        await browser.close();
        return {
          ok: false,
          msg: `No se pudieron descargar los archivos. Estrategia A y B fallaron. Último error: ${eB.message}`,
          screenshot: ss3,
        };
      }
    }

    // ── Retornar resultado ──
    const xmlOk = fs.existsSync(xmlDest);
    const pdfOk = fs.existsSync(pdfDest);
    if (!xmlOk && !pdfOk) {
      await browser.close();
      return { ok: false, msg: "Descarga completada pero no se encontraron archivos guardados.", screenshot: ss3 };
    }
    console.log(`✅ Archivos guardados — XML: ${xmlOk} | PDF: ${pdfOk} | ts: ${ts}`);
    await browser.close();
    return {
      ok: true,
      xml: xmlOk ? `/facturas/${ts}.xml` : null,
      pdf: pdfOk ? `/facturas/${ts}.pdf` : null,
    };

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
