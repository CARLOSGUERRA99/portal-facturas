const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");

// ── Helpers reutilizables ─────────────────────────────────────────────────────

async function fillInput(page, selector, value) {
  await page.click(selector);
  await page.waitForTimeout(200);
  // Triple-click selecciona todo el texto en el campo
  await page.click(selector, { clickCount: 3 });
  await page.waitForTimeout(100);
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(80);
  await page.keyboard.type(String(value), { delay: 80 });
  await page.waitForTimeout(200);
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

// ── Bot principal ─────────────────────────────────────────────────────────────

async function facturarHomeDepotMexico({
  rfc, razonSocial, regimenFiscal, usoCfdi, codigoPostal,
  barcode, folio, ticketId,
}) {
  // El OCR puede guardar el folio como "folio" o "barcode" según el portal
  const codigoTicket = barcode || folio;
  console.log("🤖 Iniciando bot Home Depot Mexico...");
  console.log(`   Ticket: ${codigoTicket} | RFC: ${rfc} | CP: ${codigoPostal}`);

  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error("BROWSERLESS_TOKEN no definido");

  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true`,
    ignoreHTTPSErrors: true,
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
  );
  await page.setExtraHTTPHeaders({ "Accept-Language": "es-MX,es;q=0.9,en;q=0.8" });

  async function screenshot(label) {
    try {
      const buf = await page.screenshot({ fullPage: false });
      const u = await subirArchivoR2(buf, `debug/homedepot_${label}_${Date.now()}.png`, "image/png");
      console.log(`📸 [${label}]: ${u}`);
    } catch {}
  }

  try {
    // ── PASO 1 — Cargar portal ────────────────────────────────────────────────
    console.log("🌐 PASO 1 — Cargando portal...");
    await page.goto(
      "https://facturacion.homedepot.com.mx/",
      { waitUntil: "networkidle2", timeout: 40000 }
    );
    await page.waitForTimeout(3000);
    await screenshot("paso1_cargado");

    // Loguear URL actual y título para diagnóstico
    const urlActual = page.url();
    const titulo = await page.title();
    console.log(`📍 URL: ${urlActual} | Título: ${titulo}`);

    // ── PASO 2 — Inspeccionar campos ──────────────────────────────────────────
    console.log("📋 PASO 2 — Inspeccionando campos del formulario...");
    await page.waitForSelector("input", { timeout: 20000 });

    // Loguear todos los inputs visibles para diagnóstico
    const inputsInfo = await page.evaluate(() =>
      Array.from(document.querySelectorAll("input:not([type='hidden'])")).map(el => ({
        id: el.id,
        name: el.name,
        placeholder: el.placeholder,
        type: el.type,
        value: el.value,
      }))
    );
    console.log("📊 Inputs encontrados:", JSON.stringify(inputsInfo));

    // ── PASO 3 — Llenar RFC (primer campo) ────────────────────────────────────
    // El portal muestra: RFC primero, luego No. de Ticket
    console.log("📋 PASO 3 — Llenando RFC y No. de Ticket...");

    // Buscar campo RFC por placeholder, id, o name
    const rfcSelector = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll("input:not([type='hidden'])"));
      for (const el of all) {
        const hint = `${el.id} ${el.name} ${el.placeholder}`.toLowerCase();
        if (hint.includes("rfc")) {
          if (el.id) return `#${el.id}`;
          if (el.name) return `input[name="${el.name}"]`;
        }
      }
      // Fallback: primer input visible
      const first = all.find(el => el.offsetParent !== null);
      if (first) {
        if (first.id) return `#${first.id}`;
        if (first.name) return `input[name="${first.name}"]`;
      }
      return "input:not([type='hidden'])";
    });
    console.log(`🔍 Selector RFC: ${rfcSelector}`);
    await fillInput(page, rfcSelector, rfc);
    await page.waitForTimeout(400);

    // Buscar campo de ticket/folio/barcode
    const ticketSelector = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll("input:not([type='hidden'])"));
      for (const el of all) {
        const hint = `${el.id} ${el.name} ${el.placeholder}`.toLowerCase();
        if (hint.includes("ticket") || hint.includes("folio") || hint.includes("barcode") || hint.includes("no.")) {
          if (el.id) return `#${el.id}`;
          if (el.name) return `input[name="${el.name}"]`;
        }
      }
      // Fallback: segundo input visible
      const visible = all.filter(el => el.offsetParent !== null);
      if (visible[1]) {
        if (visible[1].id) return `#${visible[1].id}`;
        if (visible[1].name) return `input[name="${visible[1].name}"]`;
      }
      return null;
    });
    console.log(`🔍 Selector Ticket: ${ticketSelector}`);
    if (ticketSelector) {
      await fillInput(page, ticketSelector, codigoTicket);
      await page.waitForTimeout(400);
    }

    await screenshot("paso3_rfc_ticket");

    // ── PASO 4 — Cloudflare Turnstile ─────────────────────────────────────────
    console.log("🔒 PASO 4 — Manejando Cloudflare CAPTCHA...");

    // Buscar iframe de Cloudflare en los frames activos de Puppeteer
    const frames = page.frames();
    console.log(`🔒 Frames en página: ${frames.length}`);
    for (const f of frames) {
      console.log(`   frame url: ${f.url()}`);
    }

    const cfFrame = frames.find(f =>
      f.url().includes("cloudflare") ||
      f.url().includes("challenges.cloudflare") ||
      f.url().includes("turnstile")
    );

    if (cfFrame) {
      console.log(`🔒 Frame Cloudflare encontrado: ${cfFrame.url()}`);
      try {
        // Esperar a que el checkbox aparezca dentro del iframe
        await cfFrame.waitForSelector("input[type='checkbox']", { timeout: 8000 });
        await cfFrame.$eval("input[type='checkbox']", el => el.click());
        console.log("🔒 Checkbox Cloudflare clickado");
        await page.waitForTimeout(4000);
      } catch {
        // Stealth mode puede haberlo resuelto solo
        console.log("🔒 No se pudo clickar checkbox — esperando resolución stealth...");
        await page.waitForTimeout(6000);
      }
    } else {
      // Sin iframe visible — stealth pudo resolverlo o el portal no muestra CAPTCHA
      console.log("🔒 Sin iframe Cloudflare visible — asumiendo resuelto");
      await page.waitForTimeout(2000);
    }
    await screenshot("paso4_post_captcha");

    // Esperar a que el botón Continuar se habilite (CAPTCHA completado)
    console.log("⏳ Esperando que Continuar se habilite...");
    await page.waitForFunction(
      () => {
        const btn = Array.from(document.querySelectorAll("button, input[type='submit']"))
          .find(el => /continuar|siguiente|validar|buscar|facturar/i.test(el.textContent || el.value || ""));
        return btn && !btn.disabled;
      },
      { timeout: 15000 }
    ).catch(() => console.log("⚠️ Timeout esperando botón habilitado — intentando click de todos modos"));

    // ── PASO 5 — Click en Continuar ───────────────────────────────────────────
    console.log("🔍 PASO 5 — Haciendo click en Continuar...");
    const clickedContinuar = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button, input[type='submit'], a"))
        .find(el => /continuar|siguiente|validar|buscar|facturar/i.test(el.textContent || el.value || ""));
      if (btn) { btn.scrollIntoView(); btn.click(); return btn.textContent?.trim() || btn.value || "btn"; }
      return null;
    });
    console.log(`✅ Click en: "${clickedContinuar}"`);
    await page.waitForTimeout(3000);
    await screenshot("paso5_post_continuar");

    // Detectar resultado del paso 1
    const textoActual = await page.evaluate(() => document.body.innerText.toLowerCase());

    if (/ya\s*(fue\s*)?facturad|previously\s*invoiced/i.test(textoActual)) {
      console.log("♻️ Folio ya facturado — intentando recuperar...");
      await screenshot("ya_facturado");
      const { xmlUrl, pdfUrl } = await intentarDescarga(page, browser, ticketId);
      await browser.close();
      if (xmlUrl || pdfUrl) return { ok: true, xmlUrl, pdfUrl, yaExistia: true };
      return { ok: true, procesandoCorreo: true };
    }

    if (/folio\s*inv[aá]lido|no\s*(se\s*)?encontr|ticket\s*no\s*v[aá]lid|vencid|expirad|no\s*existe/i.test(textoActual)) {
      const msg = await page.evaluate(() => {
        const alertas = document.querySelectorAll(".alert, .error, [class*='error'], [class*='alert'], p");
        for (const a of alertas) {
          const t = a.innerText?.trim();
          if (t && t.length > 5) return t;
        }
        return "Folio o RFC inválido";
      });
      await browser.close();
      return { ok: false, msg: `Home Depot rechazó el folio: ${msg}` };
    }

    // ── PASO 6 — Llenar datos fiscales (paso 2 del portal) ───────────────────
    console.log("📋 PASO 6 — Llenando datos fiscales...");
    await page.waitForTimeout(2000);

    // Loguear inputs del paso 2
    const inputs2 = await page.evaluate(() =>
      Array.from(document.querySelectorAll("input:not([type='hidden']), select")).map(el => ({
        tag: el.tagName,
        id: el.id,
        name: el.name,
        placeholder: el.placeholder,
        type: el.type,
      }))
    );
    console.log("📊 Inputs paso 2:", JSON.stringify(inputs2));

    // Razón social
    const rsSelector = await encontrarInputPorLabel(page, ["razón social", "razon social", "nombre", "empresa", "name"]);
    if (rsSelector) await fillInput(page, rsSelector, razonSocial);

    // Código postal
    const cpSelector = await encontrarInputPorLabel(page, ["código postal", "codigo postal", "c.p.", "cp", "postal"]);
    if (cpSelector) {
      await fillInput(page, cpSelector, String(codigoPostal || ""));
      await page.waitForTimeout(800);
    }

    // Uso CFDI — select
    const cfdiOk = await selectByText(page, "select", ["gastos en general", "G03"]).catch(() => false);
    if (!cfdiOk) {
      await page.evaluate(() => {
        const selects = document.querySelectorAll("select");
        selects.forEach(s => {
          const opt = Array.from(s.options || []).find(o =>
            o.text.toLowerCase().includes("gastos en general")
          );
          if (opt) { s.value = opt.value; s.dispatchEvent(new Event("change", { bubbles: true })); }
        });
      });
    }
    await page.waitForTimeout(300);

    // Correo
    const emailSelector = await encontrarInputPorLabel(page, ["correo", "email", "e-mail", "mail"]);
    if (emailSelector) await fillInput(page, emailSelector, "buzonfacturas@serviciosga.site");

    await screenshot("paso6_datos_fiscales");

    // ── PASO 7 — Generar factura ──────────────────────────────────────────────
    console.log("🧾 PASO 7 — Generando factura...");
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button, input[type='submit']"))
        .find(el => /facturar|generar|emitir|continuar/i.test(el.textContent || el.value || ""));
      if (btn) { btn.scrollIntoView(); btn.click(); }
    });

    await page.waitForTimeout(6000);
    await screenshot("paso7_post_facturar");

    const textoFinal = await page.evaluate(() => document.body.innerText.toLowerCase());
    if (/error|inv[aá]lid|rechazad/i.test(textoFinal) && !/descarg|xml|pdf/i.test(textoFinal)) {
      const msgErr = await page.evaluate(() => {
        const el = document.querySelector(".alert, .error, [class*='error'], p");
        return el ? el.innerText.trim() : "Error al generar factura";
      });
      await browser.close();
      return { ok: false, msg: msgErr };
    }

    // ── PASO 8 — Descargar XML y PDF ──────────────────────────────────────────
    console.log("📥 PASO 8 — Descargando archivos...");
    const { xmlUrl, pdfUrl } = await intentarDescarga(page, browser, ticketId);
    await browser.close();

    if (!xmlUrl && !pdfUrl) {
      console.log("⚠️ Sin descarga directa — IMAP recogerá del correo");
      return { ok: true, procesandoCorreo: true };
    }

    console.log(`✅ Home Depot OK — XML: ${xmlUrl} | PDF: ${pdfUrl}`);
    return { ok: true, xmlUrl, pdfUrl };

  } catch (err) {
    console.error("❌ Error en bot Home Depot Mexico:", err.message);
    await screenshot("error").catch(() => {});
    try { await browser.close(); } catch {}
    return { ok: false, msg: err.message };
  }
}

// ── Helpers internos ──────────────────────────────────────────────────────────

async function encontrarInputPorLabel(page, keywords) {
  return await page.evaluate((kws) => {
    const labels = Array.from(document.querySelectorAll("label, .label, [class*='label']"));
    for (const label of labels) {
      const texto = label.innerText?.toLowerCase() || "";
      if (kws.some(k => texto.includes(k))) {
        const forAttr = label.getAttribute("for");
        if (forAttr) {
          const input = document.getElementById(forAttr);
          if (input) return `#${forAttr}`;
        }
        const parent = label.closest(".form-group, .field, [class*='form']");
        if (parent) {
          const input = parent.querySelector("input, textarea");
          if (input) {
            if (input.id) return `#${input.id}`;
            if (input.name) return `input[name="${input.name}"]`;
          }
        }
      }
    }
    return null;
  }, keywords);
}

async function intentarDescarga(page, browser, ticketId) {
  const ts = ticketId || Date.now();
  let xmlUrl = null, pdfUrl = null;

  try {
    const links = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a, button"))
        .filter(el => /xml|pdf|descarg|factura/i.test(el.textContent || el.href || ""))
        .map(el => ({ texto: el.textContent?.trim(), href: el.href || null }))
    );
    console.log("🔗 Links de descarga encontrados:", JSON.stringify(links));

    async function interceptarClick(keyword) {
      const newPagePromise = new Promise(resolve =>
        browser.once("targetcreated", t => resolve(t.page()))
      );
      await page.evaluate((kw) => {
        const el = Array.from(document.querySelectorAll("a, button"))
          .find(e => (e.textContent || e.href || "").toLowerCase().includes(kw));
        if (el) { el.scrollIntoView(); el.click(); }
      }, keyword);

      const newPage = await Promise.race([
        newPagePromise,
        new Promise((_, r) => setTimeout(() => r(null), 8000)),
      ]).catch(() => null);

      if (!newPage) return null;
      await newPage.waitForTimeout(2000);
      const resp = await newPage.waitForResponse(r => r.status() === 200, { timeout: 8000 }).catch(() => null);
      const buf = resp ? await resp.buffer().catch(() => null) : null;
      await newPage.close().catch(() => {});
      return buf;
    }

    const xmlBuf = await interceptarClick("xml").catch(() => null);
    if (xmlBuf && xmlBuf.length > 200) {
      const preview = xmlBuf.toString("utf8", 0, 10);
      if (preview.includes("<?") || preview.includes("<cfdi") || preview.includes("<Comprobante")) {
        xmlUrl = await subirArchivoR2(xmlBuf, `facturas/homedepot_${ts}.xml`, "application/xml");
        console.log("✅ XML subido:", xmlUrl);
      }
    }

    const pdfBuf = await interceptarClick("pdf").catch(() => null);
    if (pdfBuf && pdfBuf.length > 200 && pdfBuf.toString("latin1", 0, 4) === "%PDF") {
      pdfUrl = await subirArchivoR2(pdfBuf, `facturas/homedepot_${ts}.pdf`, "application/pdf");
      console.log("✅ PDF subido:", pdfUrl);
    }
  } catch (e) {
    console.log("⚠️ Error en descarga:", e.message);
  }

  return { xmlUrl, pdfUrl };
}

module.exports = { facturarHomeDepotMexico };
