const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");

// sleep en Node.js puro — NO usa el main frame del browser (inmune a navegaciones)
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── CapSolver ────────────────────────────────────────────────────────────────
async function resolverCaptcha(imgBase64) {
  const apiKey = process.env.CAPSOLVER_API_KEY;
  if (!apiKey) throw new Error("CAPSOLVER_API_KEY no definida");
  const c = await fetch("https://api.capsolver.com/createTask", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey: apiKey, task: { type: "ImageToTextTask", body: imgBase64 } }),
  }).then(r => r.json());
  if (c.errorId) throw new Error(`CapSolver create: ${c.errorCode}`);
  for (let i = 0; i < 15; i++) {
    await sleep(2000);
    const res = await fetch("https://api.capsolver.com/getTaskResult", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: apiKey, taskId: c.taskId }),
    }).then(r => r.json());
    if (res.status === "ready") {
      const sol = (res.solution?.text || "").trim();
      if (!sol) throw new Error("CapSolver sin texto");
      console.log(`🔓 CAPTCHA resuelto: "${sol}"`);
      return sol;
    }
    if (res.errorId) throw new Error(`CapSolver result: ${res.errorCode}`);
  }
  throw new Error("CapSolver timeout 30s");
}

// ── Recuperar factura existente vía endpoints REST ───────────────────────────
// Los endpoints son públicos (solo requieren folio/uuid). Abre su PROPIA conexión
// Browserless limpia — el alert "ya facturado" del flujo principal compromete todo
// el target, así que un browser nuevo garantiza un contexto sano.
//   1. findLastCfdi?noTicket={folio}  → {cfdiDisponible, uuid}
//   2. descargaCfdiXml?uuid={uuid}    → {xml: "<?xml...", ...}
//   3. descargaCfdiPdf?uuid={uuid}    → {b64Pdf: "JVBER...", folio, ...}
async function recuperarFacturaExistente(folioVal, ts) {
  const token = process.env.BROWSERLESS_TOKEN;
  let browser;
  try {
    browser = await puppeteer.connect({
      browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true`,
    });
  } catch (e) { console.log("   ⚠️ recuperar: no conectó —", e.message); return null; }

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36");
    page.on("dialog", async d => { try { await d.accept(); } catch {} });

    // Capturar los bodies de las respuestas de los endpoints de descarga.
    // Importante: usar fetch() directo dentro de evaluate cuelga el target en este
    // portal; en cambio, dejar que el propio Angular dispare las requests (vía
    // clicks) y leer las responses con page.on('response') SÍ funciona.
    const bodies = {};
    page.on("response", async resp => {
      const u = resp.url();
      if (/findLastCfdi|descargaCfdiXml|descargaCfdiPdf/i.test(u)) {
        const key = /findLastCfdi/i.test(u) ? "findLast" : /Xml/i.test(u) ? "xml" : "pdf";
        try { bodies[key] = await resp.text(); } catch {}
      }
    });

    await page.goto("https://www.e7-eleven.com.mx/facturacion/KPortalExterno/", { waitUntil: "load", timeout: 35000 });
    await sleep(2500);

    // 1. CONSULTA FACTURA
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("button,a,.btn")).find(e => e.offsetParent && /consulta\s*factura/i.test(e.textContent || ""));
      if (b) b.click();
    });
    await sleep(3500);

    // 2. Escribir folio en #noTicket
    await page.waitForSelector("#noTicket", { visible: true, timeout: 8000 }).catch(() => {});
    await page.focus("#noTicket").catch(() => {});
    await sleep(200);
    await page.keyboard.type(folioVal, { delay: 25 });
    await sleep(500);

    // 3. CONSULTAR (neutralizar submit nativo) → dispara findLastCfdi
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("button,a,.btn,input[type=submit]")).find(e => e.offsetParent && /consultar/i.test(e.textContent || e.value || ""));
      if (b) { if (b.type === "submit") b.setAttribute("type", "button"); b.click(); }
    });
    // Esperar a que aparezca la pantalla de descarga
    await page.waitForFunction(() => /descargar xml|descargue sus/i.test(document.body.innerText || ""), { timeout: 20000 }).catch(() => {});
    await sleep(1500);
    console.log("   findLast:", (bodies.findLast || "").slice(0, 120));

    // 4. Click Descargar XML → dispara descargaCfdiXml
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("a,button")).find(e => /descargar\s*xml/i.test(e.textContent || ""));
      if (b) b.click();
    });
    await sleep(3500);

    // 5. Click Descargar PDF → dispara descargaCfdiPdf
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("a,button")).find(e => /descargar\s*pdf/i.test(e.textContent || ""));
      if (b) b.click();
    });
    await sleep(3500);

    // Parsear bodies y subir a R2
    let xmlJson = null, pdfJson = null;
    try { xmlJson = JSON.parse(bodies.xml || "null"); } catch {}
    try { pdfJson = JSON.parse(bodies.pdf || "null"); } catch {}

    let xmlUrl = null, pdfUrl = null, uuid = null;
    try { const fl = JSON.parse(bodies.findLast || "null"); uuid = fl?.uuid || null; } catch {}

    const stamp = `${ts}_${Date.now()}`;
    const xmlStr = (xmlJson && typeof xmlJson.xml === "string" && xmlJson.xml.trim().startsWith("<")) ? xmlJson.xml
                 : (xmlJson && typeof xmlJson.interpretado === "string" ? xmlJson.interpretado : null);
    if (xmlStr) {
      try {
        xmlUrl = await subirArchivoR2(Buffer.from(xmlStr, "utf8"), `tickets/7e_${stamp}.xml`, "application/xml");
        console.log(`   ☁️ XML subido: ${xmlUrl}`);
      } catch (e) { console.log("   ⚠️ subir XML:", e.message); }
    }
    const b64 = pdfJson && typeof pdfJson.b64Pdf === "string" ? pdfJson.b64Pdf : null;
    if (b64) {
      try {
        pdfUrl = await subirArchivoR2(Buffer.from(b64, "base64"), `tickets/7e_${stamp}.pdf`, "application/pdf");
        console.log(`   ☁️ PDF subido: ${pdfUrl}`);
      } catch (e) { console.log("   ⚠️ subir PDF:", e.message); }
    }
    if (!xmlUrl && !pdfUrl) { console.log("   ⚠️ No se obtuvo XML ni PDF"); return null; }
    return { uuid, xmlUrl, pdfUrl, folio: pdfJson?.folio || xmlJson?.folio || null };
  } catch (e) {
    console.log("   ⚠️ recuperar error:", e.message);
    return null;
  } finally {
    try { await browser.close(); } catch {}
  }
}

// ── Bot principal ─────────────────────────────────────────────────────────────
async function facturar7Eleven({ folio, referencia, total, rfc, razonSocial,
  regimenFiscal, usoCfdi, codigoPostal, ticketId }) {

  const folioVal = String(folio || referencia || "").trim();
  console.log("🤖 7-Eleven | Folio:", folioVal, `(${folioVal.length} díg.) | RFC:`, rfc);
  if (folioVal.length !== 35)
    console.log(`⚠️  Folio tiene ${folioVal.length} dígitos — se esperan 35`);

  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) {
    console.error("❌ BROWSERLESS_TOKEN no definido");
    return { ok: false, msg: "7-Eleven: BROWSERLESS_TOKEN no definido" };
  }

  let browser;
  console.log("🔌 Conectando a Browserless...");
  try {
    browser = await puppeteer.connect({
      browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true`,
    });
    console.log("✅ Conectado a Browserless");
  } catch (e) {
    console.error("❌ Error conectando a Browserless:", e.message);
    return { ok: false, msg: `7-Eleven: no se pudo conectar — ${e.message}` };
  }

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36");
  await page.setExtraHTTPHeaders({ "Accept-Language": "es-MX,es;q=0.9" });

  // ── CRÍTICO: handler de diálogos ───────────────────────────────────────────
  // El portal usa AngularJS con $window.alert() para validaciones ("Ticket
  // facturado anteriormente", "Debe ingresar el número de Ticket", etc.).
  // Un alert() nativo SIN handler BLOQUEA el hilo del browser → Browserless
  // mata la pestaña → "Session closed" / "Target closed" / "frame detached".
  // Capturamos el mensaje (nos dice el resultado) y aceptamos para no colgar.
  let ultimoDialog = null;
  const dialogs = [];
  page.on("dialog", async (d) => {
    const msg = d.message();
    ultimoDialog = msg;
    dialogs.push(msg);
    console.log(`💬 ALERT: "${msg}"`);
    try { await d.accept(); } catch {}
  });

  const ts = ticketId || Date.now();
  const snap = async (label) => {
    try {
      const buf = await page.screenshot({ fullPage: false });
      const u = await subirArchivoR2(buf, `debug/7e_${ts}_${label}_${Date.now()}.png`, "image/png");
      console.log(`📸 [${label}]: ${u}`);
    } catch {}
  };

  // Setter Angular-safe (dispara input/change/blur para que AngularJS lo capte)
  const setField = (sel, val) => page.evaluate((s, v) => {
    const el = document.querySelector(s);
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter ? setter.call(el, v) : (el.value = v);
    ["input", "change", "blur"].forEach(ev => el.dispatchEvent(new Event(ev, { bubbles: true })));
    return true;
  }, sel, String(val)).catch(() => false);

  // Click neutralizando el submit nativo: el botón es <button type="submit"
  // ng-click="..."> dentro de <form method="get"> sin action. El submit nativo
  // recarga la página (GET con query). Cambiamos type→button para ejecutar SOLO
  // el handler AngularJS (AJAX), sin recarga.
  const clickAngular = (regex) => page.evaluate((rx) => {
    const re = new RegExp(rx, "i");
    const btn = Array.from(document.querySelectorAll("button,a,.btn,input[type=submit],input[type=button]"))
      .find(e => e.offsetParent && re.test((e.textContent || e.value || "").trim()));
    if (!btn) return false;
    if (btn.tagName === "BUTTON" || btn.type === "submit") btn.setAttribute("type", "button");
    btn.click();
    return true;
  }, regex).catch(() => false);

  // Capturar CAPTCHA desde dentro del browser (misma sesión → sin CORS)
  const capturarCaptchaBase64 = async () => page.evaluate(async () => {
    const img = document.querySelector("img#Kaptcha")
      || document.querySelector("img[src*='Kaptcha']")
      || document.querySelector("img[src*='aptcha']")
      || Array.from(document.querySelectorAll("img")).find(i =>
          i.offsetParent && i.naturalWidth >= 80 && i.naturalWidth <= 350
          && i.naturalHeight >= 20 && i.naturalHeight <= 120
          && !/(logo|icon|reload|banner)/i.test(i.src));
    if (!img || !img.src) return null;
    try {
      const resp = await fetch(img.src, { credentials: "include", cache: "no-store" });
      if (!resp.ok) return null;
      const blob = await resp.blob();
      return await new Promise(res => {
        const r = new FileReader();
        r.onload = () => res(r.result.split(",")[1] || null);
        r.readAsDataURL(blob);
      });
    } catch { return null; }
  }).catch(() => null);

  // Clasifica el mensaje de un alert del portal en un resultado controlado
  const clasificarAlert = (msg) => {
    if (!msg) return null;
    const m = msg.toLowerCase();
    if (/facturad[oa]\s+anterior|ya\s+(fue|ha\s+sido|est[aá])\s+facturad|ya\s+existe.*factura/.test(m)) return "ya_facturado";
    if (/fuera de tiempo|venci|plazo|caduc|expir/.test(m)) return "vencido";
    if (/no.*(existe|encontr|v[aá]lid|registr)|inv[aá]lid|incorrect|no.*disponible/.test(m)) return "invalido";
    if (/debe ingresar|requerid|obligatori|complet/.test(m)) return "campo_faltante";
    return null;
  };

  try {
    // ── 1. Cargar portal ────────────────────────────────────────────────────
    await page.goto("https://www.e7-eleven.com.mx/facturacion/KPortalExterno/",
      { waitUntil: "load", timeout: 45000 });
    await sleep(3000);

    // ── 2. Click FACTURA EXPRESS ────────────────────────────────────────────
    const okExpress = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button,a,.btn"))
        .find(e => e.offsetParent && (e.textContent || "").trim().toUpperCase() === "FACTURA EXPRESS");
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (!okExpress) {
      await snap("err_noexpress");
      await browser.close();
      return { ok: false, msg: "7-Eleven: no se encontró FACTURA EXPRESS" };
    }
    await sleep(4000);
    await page.waitForSelector('input[name="noTicket"]', { visible: true, timeout: 12000 }).catch(() => {});
    await snap("p1_form");
    console.log("✅ Formulario visible");

    // ── 3. Escribir el No. de Ticket con keyboard.type() ───────────────────
    // AngularJS necesita eventos de teclado reales para actualizar ng-model.
    await page.focus('input[name="noTicket"]');
    await sleep(300);
    await page.evaluate(() => {
      const el = document.querySelector('input[name="noTicket"]');
      if (!el) return;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      setter ? setter.call(el, "") : (el.value = "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.keyboard.type(folioVal, { delay: 30 });
    await sleep(1000);
    await snap("p2_ticket_escrito");

    // ── 4. Click "Agregar Ticket" → dispara addRow() (AJAX a verificaTicketWS2)
    // NO hay navegación. El resultado llega por: (a) un alert (ya facturado /
    // inválido / etc.) capturado por el dialog handler, o (b) una fila nueva
    // en la tabla de tickets.
    console.log("🖱️  Agregar Ticket (addRow AJAX)...");
    ultimoDialog = null;
    const clickAgregar = await clickAngular("agregar\\s*ticket");
    console.log("   click:", clickAgregar);

    // Esperar a que el AJAX resuelva: o aparece alert, o se llena la tabla
    let resultadoAgregar = "timeout";
    for (let i = 0; i < 24; i++) {   // hasta 12s
      await sleep(500);
      // ¿Hubo alert?
      const cls = clasificarAlert(ultimoDialog);
      if (cls === "ya_facturado") { resultadoAgregar = "ya_facturado"; break; }
      if (cls === "vencido")      { resultadoAgregar = "vencido"; break; }
      if (cls === "invalido")     { resultadoAgregar = "invalido"; break; }
      if (cls === "campo_faltante") { resultadoAgregar = "campo_faltante"; break; }
      // ¿Se agregó a la tabla de tickets? (la tabla con header "Monto Facturable")
      const enTabla = await page.evaluate((folio) => {
        const tablas = Array.from(document.querySelectorAll("table"));
        for (const t of tablas) {
          const head = (t.querySelector("thead")?.innerText || t.tHead?.innerText || "").toLowerCase();
          if (!/monto|ticket|tienda/.test(head)) continue;
          const filas = Array.from(t.querySelectorAll("tbody tr"))
            .filter(r => r.textContent.replace(/\s/g, "").length > 8);
          if (filas.some(r => r.textContent.includes(folio.slice(-10)) || /\$\s*\d|\d{2,}/.test(r.textContent))) return true;
          if (filas.length > 0) return true;
        }
        return false;
      }, folioVal).catch(() => false);
      if (enTabla) { resultadoAgregar = "agregado"; break; }
    }
    await snap("p3_tras_agregar");
    console.log("   Resultado Agregar:", resultadoAgregar, ultimoDialog ? `(alert: "${ultimoDialog}")` : "");

    if (resultadoAgregar === "ya_facturado") {
      // El ticket ya fue facturado → NO es error: recuperamos la factura existente
      // vía los endpoints REST (findLastCfdi → descargaCfdiXml/Pdf).
      console.log("♻️  Ticket ya facturado — recuperando factura existente...");
      await browser.close();   // liberar la sesión rota antes de abrir una limpia
      const rec = await recuperarFacturaExistente(folioVal, ts);
      if (rec && (rec.xmlUrl || rec.pdfUrl)) {
        console.log(`✅ Factura recuperada — UUID: ${rec.uuid} | folio: ${rec.folio}`);
        return { ok: true, xmlUrl: rec.xmlUrl, pdfUrl: rec.pdfUrl, yaExistia: true };
      }
      return { ok: false, error_code: "ya_facturado", msg: `7-Eleven: ${ultimoDialog || "ticket ya facturado"} (no se pudo recuperar el CFDI)` };
    }
    if (resultadoAgregar === "vencido") {
      await browser.close();
      return { ok: false, error_code: "ticket_vencido", msg: `7-Eleven: ${ultimoDialog || "plazo vencido"}` };
    }
    if (resultadoAgregar === "invalido" || resultadoAgregar === "campo_faltante") {
      await browser.close();
      return { ok: false, error_code: "datos_invalidos", msg: `7-Eleven: ${ultimoDialog || "ticket no válido (verifica el folio de 35 dígitos)"}` };
    }
    if (resultadoAgregar !== "agregado") {
      await snap("err_no_se_agrego");
      const txt = await page.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 300)).catch(() => "");
      await browser.close();
      return { ok: false, msg: `7-Eleven: el ticket no se agregó (sin alert ni fila). Texto: ${txt.slice(0, 150)}` };
    }
    console.log("✅ Ticket agregado a la tabla");

    // ── 5. Llenar formulario — orden confirmado por el usuario ────────────────
    // RFC + Razón + Régimen → esperar 5s (CFDI carga vía AJAX) → CFDI + CP + email + fpago
    await page.waitForSelector("#rfcCliente", { visible: true, timeout: 8000 }).catch(() => {});
    const paso1 = await page.evaluate((d) => {
      const set = (el, val) => {
        if (!el) return false;
        const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
        s ? s.call(el, val) : (el.value = val);
        ["input", "change", "blur"].forEach(ev => el.dispatchEvent(new Event(ev, { bubbles: true })));
        return true;
      };
      const res = {};
      res.rfc   = set(document.querySelector("#rfcCliente"), d.rfc);
      res.razon = set(document.querySelector("#razon"), d.razonSocial || "");
      const selReg = document.querySelector("#regimenFiscalReceptor");
      if (selReg) {
        for (const o of selReg.options) {
          if (o.value === d.regimenFiscal || o.text.includes("General de Ley")) {
            selReg.value = o.value; selReg.dispatchEvent(new Event("change", { bubbles: true }));
            res.regimen = true; break;
          }
        }
      }
      return res;
    }, { rfc, razonSocial, regimenFiscal: String(regimenFiscal || "601") });
    console.log("📋 Paso 1 (RFC+Razón+Régimen):", JSON.stringify(paso1));

    console.log("   ⏳ Esperando 5s para que cargue CFDI...");
    await sleep(5000);

    const paso2 = await page.evaluate((d) => {
      const set = (el, val) => {
        if (!el) return false;
        const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
        s ? s.call(el, val) : (el.value = val);
        ["input", "change", "blur"].forEach(ev => el.dispatchEvent(new Event(ev, { bubbles: true })));
        return true;
      };
      const res = {};
      const selCfdi = document.querySelector("#usoCfdi");
      if (selCfdi) {
        for (const o of selCfdi.options) {
          if (o.value.includes(d.usoCfdi) || o.text.includes("Gastos en general")) {
            selCfdi.value = o.value; selCfdi.dispatchEvent(new Event("change", { bubbles: true }));
            res.cfdi = true; break;
          }
        }
        if (!res.cfdi) res.cfdiOpts = selCfdi.options.length;
      }
      res.cp    = set(document.querySelector("#cp"), d.codigoPostal || "");
      res.email = set(document.querySelector("#emailInput"), "buzonfacturas@serviciosga.site");
      res.fpago = set(document.querySelector("#formaPagoAux"), "Efectivo");
      return res;
    }, { usoCfdi: usoCfdi || "G03", codigoPostal: codigoPostal || "" });
    console.log("📋 Paso 2 (CFDI+CP+email+fpago):", JSON.stringify(paso2));
    await sleep(800);
    await snap("p4_form_completo");

    // ── 6. Loop CAPTCHA + FACTURAR (hasta 3 intentos) ──────────────────────
    for (let intento = 1; intento <= 3; intento++) {
      console.log(`🔐 CAPTCHA intento ${intento}/3...`);
      await page.waitForSelector("img#Kaptcha, img[src*='aptcha']", { visible: true, timeout: 8000 }).catch(() => {});

      const base64 = await capturarCaptchaBase64();
      if (!base64) {
        console.log("   ⚠️  No se pudo capturar imagen del CAPTCHA — recargando");
        await page.evaluate(() => document.querySelector("img#reload, img[id*='reload']")?.click()).catch(() => {});
        await sleep(2000);
        continue;
      }
      try {
        const buf = Buffer.from(base64, "base64");
        const u = await subirArchivoR2(buf, `debug/7e_${ts}_captcha_${intento}_${Date.now()}.jpg`, "image/jpeg");
        console.log(`   CAPTCHA imagen: ${u}`);
      } catch {}

      let sol;
      try { sol = await resolverCaptcha(base64); }
      catch (e) {
        console.log(`   CapSolver falló: ${e.message}`);
        await page.evaluate(() => document.querySelector("img#reload, img[id*='reload']")?.click()).catch(() => {});
        await sleep(2500);
        continue;
      }

      await page.focus("#captcha").catch(() => {});
      await setField("#captcha", "");
      await page.keyboard.type(sol, { delay: 50 });
      await sleep(400);
      await snap(`p5_captcha_${intento}`);

      // Click FACTURAR (mismo tratamiento: neutralizar submit nativo)
      console.log("🧾 FACTURAR...");
      ultimoDialog = null;
      const clickFact = await clickAngular("^facturar$");
      console.log("   click FACTURAR:", clickFact);

      // Esperar resultado: alert (éxito/error) o aparición de enlaces de descarga
      let facResult = "timeout";
      for (let i = 0; i < 30; i++) {   // hasta 15s
        await sleep(500);
        if (ultimoDialog) {
          const m = ultimoDialog.toLowerCase();
          if (/captcha|c[oó]digo.*(incorrect|inv[aá]lid)|texto.*imagen/.test(m)) { facResult = "captcha_malo"; break; }
          if (/correo|enviad|gener|exitos|factura.*list|descarg/.test(m))       { facResult = "exito"; break; }
          if (clasificarAlert(ultimoDialog) === "ya_facturado")                  { facResult = "ya_facturado"; break; }
          facResult = "alert_otro"; break;
        }
        const links = await page.evaluate(() => ({
          xml: Array.from(document.querySelectorAll("a[href]")).find(a => /\.xml/i.test(a.href))?.href || null,
          pdf: Array.from(document.querySelectorAll("a[href]")).find(a => /\.pdf/i.test(a.href))?.href || null,
        })).catch(() => ({ xml: null, pdf: null }));
        if (links.xml || links.pdf) { facResult = "descarga"; break; }
      }
      await snap(`p6_resultado_${intento}`);
      console.log("   Resultado FACTURAR:", facResult, ultimoDialog ? `(alert: "${ultimoDialog}")` : "");

      if (facResult === "captcha_malo") {
        console.log("   CAPTCHA incorrecto — recargando y reintentando...");
        await page.evaluate(() => document.querySelector("img#reload, img[id*='reload']")?.click()).catch(() => {});
        await sleep(2500);
        continue;
      }
      if (facResult === "ya_facturado") {
        await browser.close();
        return { ok: false, error_code: "ya_facturado", msg: `7-Eleven: ${ultimoDialog}` };
      }
      if (facResult === "descarga" || facResult === "exito") {
        // Factura generada. Obtenemos el XML/PDF reales vía los endpoints REST
        // (findLastCfdi → descargaCfdiXml/Pdf), igual que en el flujo de recuperación.
        console.log("✅ Factura generada — descargando CFDI vía REST...");
        await sleep(1500);
        await browser.close();   // cerrar la sesión principal antes de recuperar
        const rec = await recuperarFacturaExistente(folioVal, ts);
        if (rec && (rec.xmlUrl || rec.pdfUrl)) {
          console.log(`✅ OK — UUID: ${rec.uuid} | XML: ${rec.xmlUrl} | PDF: ${rec.pdfUrl}`);
          return { ok: true, xmlUrl: rec.xmlUrl, pdfUrl: rec.pdfUrl };
        }
        // No disponible aún por REST → llegará por correo (IMAP la captura)
        console.log("✅ Factura generada — llegará por correo");
        return { ok: true, procesandoCorreo: true };
      }
      // alert_otro o timeout → reintentar el captcha por si acaso
      console.log("   Resultado no concluyente, reintentando...");
      await page.evaluate(() => document.querySelector("img#reload, img[id*='reload']")?.click()).catch(() => {});
      await sleep(2000);
    }

    await snap("err_captcha_agotado");
    await browser.close();
    return { ok: false, error_code: "captcha", msg: "7-Eleven: no se pudo completar la facturación en 3 intentos de CAPTCHA" };

  } catch (err) {
    console.error("❌ Error en bot 7-Eleven:", err.message);
    await snap("error").catch(() => {});
    try { await browser.close(); } catch {}
    return { ok: false, msg: err.message };
  }
}

module.exports = { facturar7Eleven };
