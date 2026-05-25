const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");
const unzipper = require("unzipper");

// ── Helpers ───────────────────────────────────────────────────────────────

async function fillInput(page, selector, value) {
  await page.click(selector);
  await page.waitForTimeout(150);
  await page.keyboard.down("Control");
  await page.keyboard.press("a");
  await page.keyboard.up("Control");
  await page.keyboard.press("Delete");
  await page.waitForTimeout(80);
  await page.keyboard.type(String(value), { delay: 60 });
  await page.waitForTimeout(150);
  const actual = await page.$eval(selector, el => el.value).catch(() => "?");
  console.log(`📝 ${selector}: "${actual}"`);
}

async function selectByText(page, selector, keywords) {
  const found = await page.$eval(selector, (el, kws) => {
    const opt = Array.from(el.options).find(o =>
      kws.some(k => o.text.toLowerCase().includes(k.toLowerCase()))
    );
    if (!opt) return null;
    el.value = opt.value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("input",  { bubbles: true }));
    return opt.text;
  }, keywords);
  console.log(`📝 ${selector}: "${found || "NO ENCONTRADO"}"`);
  return !!found;
}

// Hace click en el botón "Siguiente" (es dinámico, sin ID fijo)
async function clickSiguiente(page) {
  const clicked = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button, input[type='submit'], input[type='button'], a"));
    const btn = btns.find(b =>
      /siguiente/i.test((b.textContent || "") + (b.value || ""))
    );
    if (btn) { btn.click(); return true; }
    return false;
  });
  if (!clicked) throw new Error("Benavides: botón Siguiente no encontrado");
  await page.waitForTimeout(5000); // portal pide ~5s entre pasos
}

// Captura el ZIP que genera DescargarArchivoPet() parcheando XHR/fetch en el browser.
// Benavides usa AJAX para generar la descarga; el body binario no llega a page.on("response")
// porque Chrome lo procesa como file-download antes de exponerlo a Puppeteer.
async function capturaDescargaZip(page) {
  return page.evaluate(() => new Promise(resolve => {
    let done = false;
    const fin = v => { if (!done) { done = true; resolve(v); } };

    // Parchear XHR — overrideMimeType preserva bytes binarios como Latin-1
    const ox = XMLHttpRequest.prototype.open;
    const os = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(m, u, ...a) {
      this._u = u;
      const r = ox.call(this, m, u, ...a);
      try { this.overrideMimeType('text/plain; charset=x-user-defined'); } catch {}
      return r;
    };
    XMLHttpRequest.prototype.send = function(b) {
      this.addEventListener('load', function() {
        const t = this.responseText || '';
        // ZIP magic bytes: PK = 0x50 0x4B
        if (this.status === 200 && t.length > 200 &&
            t.charCodeAt(0) === 0x50 && t.charCodeAt(1) === 0x4B) {
          let bin = '';
          for (let i = 0; i < t.length; i++) bin += String.fromCharCode(t.charCodeAt(i) & 0xFF);
          fin({ ok: true, data: btoa(bin), via: 'xhr' });
        }
      });
      return os.call(this, b);
    };

    // Parchear fetch (por si la plataforma lo usa en lugar de XHR)
    const of_ = window.fetch;
    window.fetch = async function(url, opts) {
      const res = await of_(url, opts);
      try {
        const arr = new Uint8Array(await res.clone().arrayBuffer());
        if (arr[0] === 0x50 && arr[1] === 0x4B && arr.length > 200) {
          let bin = '';
          arr.forEach(x => bin += String.fromCharCode(x));
          fin({ ok: true, data: btoa(bin), via: 'fetch' });
        }
      } catch {}
      return res;
    };

    // Click en el botón de descarga — prioriza name*="AMBOS" del modal, luego IDs fijos
    const btn =
      document.querySelector('[name*="AMBOS"]') ||
      document.querySelector('#btn_dxmlpet')    ||
      document.querySelector('#btn_dxmlpdf')    ||
      [...document.querySelectorAll('button, a')].find(b =>
        /descargar\s*xml\s*\+\s*pdf|xml\s*\+\s*pdf/i.test(b.textContent)
      );

    if (btn) { console.log('🖱️ click descarga:', btn.id || btn.name || btn.textContent.trim()); btn.click(); }
    else fin({ error: 'no-btn' });

    setTimeout(() => fin({ error: 'timeout' }), 12000);
  }));
}

// ── Bot principal ─────────────────────────────────────────────────────────

async function facturarBenavides({
  folio, total,
  rfc, razonSocial, regimenFiscal, usoCfdi,
  ticketId
}) {
  console.log("🤖 Iniciando bot Farmacias Benavides...");
  console.log(`   Folio: ${folio} | Total: ${total} | RFC: ${rfc}`);

  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error("BROWSERLESS_TOKEN no definido");

  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true`,
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
  );
  await page.setExtraHTTPHeaders({ "Accept-Language": "es-MX,es;q=0.9,en;q=0.8" });

  const ts = ticketId || Date.now();
  async function screenshot(label) {
    try {
      const buf = await page.screenshot({ fullPage: false });
      const u = await subirArchivoR2(buf, `debug/benavides_${ts}_${label}_${Date.now()}.png`, "image/png");
      console.log(`📸 [${label}]: ${u}`);
    } catch {}
  }

  try {
    // ── PASO 1 — Cargar portal e ingresar ticket ──────────────────────────
    console.log("🌐 Cargando portal...");
    await page.goto("https://e-facturate.com/benavides/", { waitUntil: "load", timeout: 30000 });
    await page.waitForSelector("#txt_ticket", { timeout: 15000 });
    await screenshot("p1_cargado");

    // El folio es el número entre asteriscos *45061402333295* del ticket
    const folioLimpio = String(folio).replace(/\*/g, "").trim();
    await fillInput(page, "#txt_ticket",     folioLimpio);
    await fillInput(page, "#txt_total",      parseFloat(total).toFixed(2));
    await fillInput(page, "#txt_rfccliente", rfc);
    await screenshot("p2_ticket_llenado");

    // ── PASO 2 — Siguiente → Datos Fiscales ──────────────────────────────
    console.log("➡️ Avanzando a Datos Fiscales...");
    await clickSiguiente(page);

    // Detectar si el portal rechazó los datos o si ya fue facturado
    const errTexto = await page.evaluate(() => {
      const body = document.body.innerText;
      if (/ya fue facturado|ya facturado|ha sido generada/i.test(body)) return "YA_FACTURADO";
      if (/no encontrado|no existe|datos incorrectos|ticket inv/i.test(body)) return "DATOS_INVALIDOS";
      return null;
    });
    if (errTexto === "YA_FACTURADO") {
      console.log("⚠️ Ya facturado — descargando factura existente del modal...");
      await screenshot("ya_facturado_modal");

      const zipRes = await capturaDescargaZip(page);
      console.log(`📋 capturaDescargaZip (ya_facturado): ${JSON.stringify({ ...zipRes, data: zipRes?.data ? `[${zipRes.data.length}b64]` : undefined })}`);

      if (zipRes?.ok) {
        const zipBuf = Buffer.from(zipRes.data, "base64");
        console.log(`📦 ZIP: ${zipBuf.length} bytes (vía ${zipRes.via}) — extrayendo...`);
        let pdfBuf = null, xmlBuf = null;
        try {
          const dir = await unzipper.Open.buffer(zipBuf);
          for (const f of dir.files) {
            const c = await f.buffer();
            if (f.path.toLowerCase().endsWith(".pdf")) pdfBuf = c;
            else if (f.path.toLowerCase().endsWith(".xml")) xmlBuf = c;
          }
        } catch (e) { console.log("⚠️ Error extrayendo ZIP:", e.message); }

        const pdfUrl = pdfBuf ? await subirArchivoR2(pdfBuf, `facturas/benavides_${ts}.pdf`, "application/pdf") : null;
        const xmlUrl = xmlBuf ? await subirArchivoR2(xmlBuf, `facturas/benavides_${ts}.xml`, "application/xml") : null;

        if (pdfUrl || xmlUrl) {
          await browser.close();
          console.log("✅ Factura existente descargada directamente");
          return { ok: true, xmlUrl, pdfUrl };
        }
      }

      // Fallback email — selectores correctos del modal: #txt_dcorreopet + #btn_denviarpet
      console.log("📧 Fallback: enviando al buzón por correo (IMAP)...");
      await page.evaluate(() => {
        const inp = document.querySelector("#txt_dcorreopet");
        if (inp) {
          inp.value = "buzonfacturas@serviciosga.site";
          inp.dispatchEvent(new Event("input",  { bubbles: true }));
          inp.dispatchEvent(new Event("change", { bubbles: true }));
        }
      });
      await page.evaluate(() => {
        const btn = document.querySelector("#btn_denviarpet");
        if (btn) btn.click();
      });
      await page.waitForTimeout(2000);
      await browser.close();
      return { ok: true, procesandoCorreo: true };
    }
    if (errTexto) {
      await browser.close();
      return { ok: false, error_code: "datos_invalidos", msg: `Benavides: ${errTexto}` };
    }

    // Esperar que cargue paso 2 (aparece el campo Uso de CFDI)
    await page.waitForSelector("#txt_cucfdi", { visible: true, timeout: 20000 });
    await screenshot("p3_datos_fiscales");

    // ── PASO 3 — Llenar solo los 3 campos requeridos ──────────────────────
    // El portal auto-llena razón social, CP, colonia, calle, municipio desde el RFC.
    // Solo necesitamos: Uso CFDI, Régimen Fiscal y Correo.

    // Uso de CFDI — typeahead jQuery UI
    const cfdiCode = String(usoCfdi || "G03").toUpperCase();
    console.log(`📋 Uso CFDI: ${cfdiCode}`);
    await page.click("#txt_cucfdi", { clickCount: 3 });
    await page.type("#txt_cucfdi", cfdiCode, { delay: 80 });
    await page.waitForTimeout(1500);
    const cfdiClicked = await page.evaluate((code) => {
      const selectors = [".ui-autocomplete .ui-menu-item", ".ui-autocomplete li"];
      for (const s of selectors) {
        for (const item of document.querySelectorAll(s)) {
          if (item.textContent.includes(code)) {
            (item.querySelector("a, div") || item).click();
            return true;
          }
        }
      }
      return false;
    }, cfdiCode);
    if (!cfdiClicked) {
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
    }
    await page.waitForTimeout(500);

    // Régimen Fiscal — select por valor SAT (ej. "601")
    const regimen = String(regimenFiscal || "601");
    console.log(`📋 Régimen Fiscal: ${regimen}`);
    await page.evaluate((v) => {
      const sel = document.querySelector("#cbo_cregfiscal");
      if (!sel) return;
      for (const opt of sel.options) {
        if (opt.value === v || opt.text.includes(v)) {
          sel.value = opt.value;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          return;
        }
      }
    }, regimen);
    await page.waitForTimeout(300);

    // Correo — siempre nuestro buzón de captura
    await page.evaluate(() => {
      const inp = document.querySelector("#txt_ccorreo");
      if (!inp) return;
      inp.value = "buzonfacturas@serviciosga.site";
      inp.dispatchEvent(new Event("input",  { bubbles: true }));
      inp.dispatchEvent(new Event("change", { bubbles: true }));
    });
    console.log("📧 Correo: buzonfacturas@serviciosga.site");
    await screenshot("p4_datos_fiscales_llenados");

    // ── PASO 4 — Siguiente → Confirmar Datos ─────────────────────────────
    console.log("➡️ Avanzando a Confirmar Datos...");
    await clickSiguiente(page);

    // Esperar que cargue el paso 3 (preview con "COMPROBANTE FISCAL DIGITAL")
    await page.waitForFunction(
      () => /COMPROBANTE FISCAL|Confirmar Datos|Verifica los datos/i.test(document.body.textContent),
      { timeout: 20000 }
    );
    await screenshot("p5_confirmar");

    // ── PASO 5 — Siguiente → Generar factura ─────────────────────────────
    console.log("🧾 Generando factura...");
    await clickSiguiente(page);

    // Esperar paso 4 (modal o página de descarga)
    await page.waitForFunction(
      () => /Descargar Factura|exitosamente|Enhorabuena|ha sido generada/i.test(document.body.textContent) ||
            document.querySelector("#btn_dxmlpdf, #btn_dxmlpet, [name*='AMBOS']") !== null,
      { timeout: 30000 }
    );
    await screenshot("p6_descarga");

    // ── PASO 6 — Descargar ZIP (PDF + XML) ───────────────────────────────
    console.log("📥 Descargando ZIP vía XHR intercept...");

    const zipRes = await capturaDescargaZip(page);
    console.log(`📋 capturaDescargaZip (normal): ${JSON.stringify({ ...zipRes, data: zipRes?.data ? `[${zipRes.data.length}b64]` : undefined })}`);

    if (zipRes?.ok) {
      const zipBuffer = Buffer.from(zipRes.data, "base64");
      console.log(`📦 ZIP: ${zipBuffer.length} bytes (vía ${zipRes.via}) — extrayendo...`);
      let pdfBuf = null, xmlBuf = null;
      try {
        const dir = await unzipper.Open.buffer(zipBuffer);
        for (const file of dir.files) {
          const content = await file.buffer();
          if (file.path.toLowerCase().endsWith(".pdf")) pdfBuf = content;
          else if (file.path.toLowerCase().endsWith(".xml")) xmlBuf = content;
        }
      } catch (e) { console.log("⚠️ Error extrayendo ZIP:", e.message); }

      const pdfUrl = pdfBuf ? await subirArchivoR2(pdfBuf, `facturas/benavides_${ts}.pdf`, "application/pdf") : null;
      const xmlUrl = xmlBuf ? await subirArchivoR2(xmlBuf, `facturas/benavides_${ts}.xml`, "application/xml") : null;

      await browser.close();

      if (!pdfUrl && !xmlUrl) {
        console.log("⚠️ ZIP vacío — fallback IMAP");
        return { ok: true, procesandoCorreo: true };
      }
      console.log(`✅ Benavides OK — PDF: ${pdfUrl} | XML: ${xmlUrl}`);
      return { ok: true, xmlUrl, pdfUrl };
    }

    // Fallback email — intentar ambos selector sets (modal: *pet, página normal: sin sufijo)
    console.log("📧 Sin ZIP — enviando por correo (IMAP)...");
    await page.evaluate(() => {
      const inp = document.querySelector("#txt_dcorreopet") || document.querySelector("#txt_dcorreo");
      if (inp) {
        inp.value = "buzonfacturas@serviciosga.site";
        inp.dispatchEvent(new Event("input",  { bubbles: true }));
        inp.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    const btnEnviar = await page.$("#btn_denviarpet") || await page.$("#btn_denviar");
    if (btnEnviar) await btnEnviar.click();
    await page.waitForTimeout(2000);

    await browser.close();
    return { ok: true, procesandoCorreo: true };

  } catch (err) {
    console.error("❌ Error en bot Benavides:", err.message);
    await screenshot("error").catch(() => {});
    try { await browser.close(); } catch {}
    return { ok: false, msg: err.message };
  }
}

module.exports = { facturarBenavides };
