const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");
const unzipper = require("unzipper");

// ── Helpers (mismos que Benavides — misma plataforma RetailEDX) ───────────

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

// El portal EDX avisa de TODO por un único modal, #modalnotificacion. Ahí está
// siempre el motivo real; leerlo es la diferencia entre diagnosticar y adivinar.
async function leerNotificacion(page) {
  return page.evaluate(() => {
    const m = document.querySelector("#modalnotificacion");
    if (!m || m.offsetParent === null) return "";
    return (m.innerText || "")
      .replace(/\s+/g, " ")
      .replace(/^\s*×?\s*Notificaci[oó]n\s*/i, "")   // la X de cerrar y el título
      .replace(/\+?\s*Detalle\s*Aceptar\s*$/i, "")    // los botones del pie
      .trim();
  });
}

// Hace click en el botón "Siguiente"
async function clickSiguiente(page) {
  const clicked = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button, input[type='submit'], input[type='button'], a"));
    const btn = btns.find(b =>
      /siguiente/i.test((b.textContent || "") + (b.value || ""))
    );
    if (btn) { btn.click(); return true; }
    return false;
  });
  if (!clicked) throw new Error("Carl's Jr: botón Siguiente no encontrado");
  await page.waitForTimeout(5000);
}

// ── Bot principal ─────────────────────────────────────────────────────────

async function facturarCarlsJr({
  referencia, folio, total,
  rfc, razonSocial, regimenFiscal, usoCfdi,
  ticketId
}) {
  // El campo del portal se llama "ticket" pero el valor es la REFERENCIA del ticket
  const codigoPortal = String(referencia || folio || "").trim();

  console.log("🤖 Iniciando bot Carl's Jr (ICR S.A. de C.V.)...");
  console.log(`   Referencia: ${codigoPortal} | Total: ${total} | RFC: ${rfc}`);

  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error("BROWSERLESS_TOKEN no definido");

  let browser;
  try {
    browser = await puppeteer.connect({
      browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true`,
    });
  } catch (e) {
    return { ok: false, msg: `Carl's Jr: no se pudo conectar al browser — ${e.message}` };
  }

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
      const u = await subirArchivoR2(buf, `debug/carljr_${ts}_${label}_${Date.now()}.png`, "image/png");
      console.log(`📸 [${label}]: ${u}`);
    } catch {}
  }

  try {
    // ── PASO 1 — Cargar portal ────────────────────────────────────────────
    console.log("🌐 Cargando portal Carl's Jr...");
    await page.goto("https://retailedx.com/ICR4/", { waitUntil: "load", timeout: 30000 });
    await screenshot("p1_cargado");

    // Si hay pantalla de bienvenida con "Genere su factura aquí", hacer click
    const btnGenerar = await page.$('a[href*="factura"], button, input[type="button"], input[type="submit"]');
    const tieneFormulario = await page.$('#txt_ticket');
    if (!tieneFormulario) {
      console.log("🖱️ Click en 'Genere su factura aquí'...");
      await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a, button, input[type="button"], input[type="submit"]'));
        const btn = links.find(el =>
          /genere|factura|generar|iniciar/i.test((el.textContent || el.value || ''))
        );
        if (btn) btn.click();
      });
      await page.waitForTimeout(3000);
    }
    await page.waitForSelector("#txt_ticket", { timeout: 15000 });

    // ── PASO 2 — Ingresar referencia y RFC (ICR4 no tiene campo total en paso 1) ──
    await fillInput(page, "#txt_ticket",     codigoPortal);
    await fillInput(page, "#txt_rfccliente", rfc);
    await screenshot("p2_ticket_llenado");

    // ── PASO 3 — Siguiente → Datos Fiscales ──────────────────────────────
    console.log("➡️ Avanzando a Datos Fiscales...");
    await clickSiguiente(page);

    // Esperar a que el portal reaccione (puede ser lento en validar la referencia)
    await page.waitForTimeout(2000);
    await screenshot("p3_post_siguiente");

    // ── Caso: la factura YA estaba generada ───────────────────────────────
    // El portal ICR muestra un modal "Ya ha sido generada su factura!" con
    // "Enviar a:" + botón Enviar y "Descargar XML + PDF". Recuperamos la factura
    // existente (igual de útil cuando el usuario ya facturó a mano) en vez de
    // fallar o quedarnos esperando el formulario fiscal → timeout.
    const yaGenerada = await page.evaluate(() =>
      /ya ha sido generada|ya fue generada|generada su factura|factura.*ya.*generad/i.test(document.body.innerText || "")
    );
    if (yaGenerada) {
      console.log("ℹ️ Carl's Jr: factura ya generada — enviándola por correo para captura IMAP...");
      await screenshot("ya_generada");
      // El modal de factura existente tiene "Enviar a:" → input #txt_dcorreopet y
      // botón Enviar #btn_denviarpet (onclick DescargarArchivoPet). El portal envía
      // PDF+XML por correo y el IMAP los captura. La descarga directa (#btn_dxmlpet)
      // es un blob JS que Puppeteer no puede interceptar, por eso usamos el correo.
      const llenado = await page.evaluate((correo) => {
        const inp = document.querySelector("#txt_dcorreopet");
        if (!inp) return false;
        inp.value = correo;
        ["input", "change", "keyup"].forEach(ev => inp.dispatchEvent(new Event(ev, { bubbles: true })));
        return true;
      }, "buzonfacturas@serviciosga.site");
      console.log(`📧 Campo correo (#txt_dcorreopet) llenado: ${llenado}`);
      await page.waitForTimeout(600);
      const enviado = await page.evaluate(() => {
        const b = document.querySelector("#btn_denviarpet");
        if (b) { b.click(); return true; }
        return false;
      });
      console.log(`📨 Click Enviar (#btn_denviarpet): ${enviado}`);
      await page.waitForTimeout(4000);
      await screenshot("ya_generada_enviado");
      await browser.close();
      return { ok: true, procesandoCorreo: true };
    }

    // Detectar SOLO los casos que de verdad significan "no hay nada que llenar"
    // (referencia ya facturada, o inexistente) — estos sí paran de inmediato.
    // El escaneo GENÉRICO de .alert/.error se movió a DESPUÉS de intentar llenar
    // Uso CFDI/Régimen Fiscal (ver más abajo): cuando ICR ya tiene un perfil
    // guardado para el RFC pero con esos dos campos vacíos ("Ninguno"), el
    // portal pinta un aviso de "formulario incompleto" apenas se carga la
    // pantalla — ANTES de que el bot alcance a llenarlos. Si se revisaba aquí,
    // el bot se rendía sin intentar completar el formulario (bug real
    // encontrado en producción, 2026-07-27, ticket #117).
    // El aviso del portal manda sobre cualquier heurística sobre el body: es el
    // portal diciendo con sus palabras qué le pasa a ESTE ticket.
    const aviso = await leerNotificacion(page);
    if (aviso) console.log(`📢 Aviso del portal: ${aviso}`);

    const errTemprano = await page.evaluate((av) => {
      const body = av || document.body.innerText;
      if (/ya fue facturado|ya facturado|factura.*ya.*generada/i.test(body)) return "YA_FACTURADO";
      // ⚠️ Lo de abajo es del PORTAL, no nuestro: el ticket existe (EDX repite su
      //    número) pero la sucursal no ha subido la venta completa a la
      //    plataforma. Nada que corregir de nuestro lado — hay que esperar a que
      //    ICR sincronice, o reclamar en tienda. Visto en el ticket #206.
      if (/no est[aá] completo|conector configurado|sin conector/i.test(body)) return "PORTAL_INCOMPLETO";
      if (/no encontrado|no existe|ticket inv|referencia.*inv|inv.*referencia|no se encontr/i.test(body)) return "DATOS_INVALIDOS";
      return null;
    }, aviso);

    if (errTemprano === "YA_FACTURADO") {
      await browser.close();
      return { ok: false, error_code: "ya_facturado", msg: "Carl's Jr: la referencia ya fue facturada" };
    }
    if (errTemprano === "PORTAL_INCOMPLETO") {
      await screenshot("portal_incompleto");
      await browser.close();
      return {
        ok: false,
        error_code: "reintentar_despues",
        msg: `Carl's Jr: el portal aún no tiene la venta completa de esta referencia — "${aviso}". Es una sincronización pendiente de la sucursal, no un dato mal capturado. Ojo: solo hay 30 días desde la fecha del ticket para facturar.`,
      };
    }
    if (errTemprano) {
      await browser.close();
      return { ok: false, error_code: "datos_invalidos", msg: `Carl's Jr: ${aviso || errTemprano}` };
    }

    // Esperar paso 2 (campo Uso CFDI) — si no aparece, capturar pantalla y reportar
    const cfdiInput = await page.waitForSelector("#txt_cucfdi", { visible: true, timeout: 20000 })
      .catch(async () => {
        await screenshot("p3_cucfdi_timeout");
        // Capturar texto actual de la página para diagnóstico
        const pageText = await page.evaluate(() => document.body.innerText.slice(0, 500));
        console.log(`⚠️ #txt_cucfdi no apareció. Texto en pantalla: ${pageText}`);
        return null;
      });
    if (!cfdiInput) {
      // ⚠️ NO inventar el motivo. Este catch decía "referencia no encontrada o
      //    datos del ticket inválidos" y era mentira: en el #206 la referencia
      //    era correcta y el campo existía (0x0, tapado por el modal). Seis
      //    reintentos culpando al usuario de un problema del portal.
      const avisoTarde = (await leerNotificacion(page)) || aviso;
      await browser.close();
      return {
        ok: false,
        error_code: "reintentar_despues",
        msg: avisoTarde
          ? `Carl's Jr: ${avisoTarde}`
          : "Carl's Jr: el portal no avanzó a Datos Fiscales y no dio ningún aviso. Sin motivo confirmado — hay captura en R2.",
      };
    }
    await screenshot("p3_datos_fiscales");

    // ── PASO 4 — Llenar datos fiscales ────────────────────────────────────
    // Uso CFDI — typeahead jQuery UI (igual que Benavides)
    const cfdiCode = String(usoCfdi || "G03").toUpperCase();
    console.log(`📋 Uso CFDI: ${cfdiCode}`);
    await page.click("#txt_cucfdi", { clickCount: 3 });
    await page.type("#txt_cucfdi", cfdiCode, { delay: 80 });
    await page.waitForTimeout(1500);
    const cfdiClicked = await page.evaluate((code) => {
      for (const s of [".ui-autocomplete .ui-menu-item", ".ui-autocomplete li"]) {
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

    // Régimen Fiscal
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

    // Correo
    await page.evaluate(() => {
      const inp = document.querySelector("#txt_ccorreo");
      if (!inp) return;
      inp.value = "buzonfacturas@serviciosga.site";
      inp.dispatchEvent(new Event("input",  { bubbles: true }));
      inp.dispatchEvent(new Event("change", { bubbles: true }));
    });
    console.log("📧 Correo: buzonfacturas@serviciosga.site");
    await screenshot("p4_datos_fiscales_llenados");

    // Ahora sí, escaneo genérico de errores — DESPUÉS de haber llenado Uso
    // CFDI/Régimen/Correo. Si el portal sigue quejándose con estos campos ya
    // completos, es un error real (no el aviso de "formulario incompleto").
    const errGenerico = await page.evaluate(() => {
      const alertas = document.querySelectorAll('.alert, .error, .mensaje-error, [class*="error"], [class*="alert"], .ui-state-error');
      for (const el of alertas) {
        if (el.offsetParent === null) continue; // ignora alertas ocultas/desmontadas
        const txt = (el.textContent || '').trim();
        if (txt.length > 5 && txt.length < 300) return txt;
      }
      return null;
    });
    if (errGenerico) {
      await screenshot("p4_error_persistente");
      await browser.close();
      return { ok: false, error_code: "datos_invalidos", msg: `Carl's Jr: ERROR_PORTAL: ${errGenerico}` };
    }

    // ── PASO 5 — Siguiente → Confirmar Datos ─────────────────────────────
    console.log("➡️ Avanzando a Confirmar Datos...");
    await clickSiguiente(page);

    await page.waitForFunction(
      () => /COMPROBANTE FISCAL|Confirmar Datos|Verifica los datos/i.test(document.body.textContent),
      { timeout: 20000 }
    );
    await screenshot("p5_confirmar");

    // ── PASO 6 — Siguiente → Generar factura ─────────────────────────────
    console.log("🧾 Generando factura...");
    await clickSiguiente(page);

    await page.waitForFunction(
      () => /Descargar Factura|exitosamente|Enhorabuena/i.test(document.body.textContent) ||
            document.querySelector("#btn_dxmlpdf") !== null,
      { timeout: 30000 }
    );
    await screenshot("p6_descarga");

    // Cerrar modal "La factura se generó exitosamente — Haga clic en Aceptar"
    const modalAceptado = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, input[type='button'], input[type='submit']"));
      const btn = btns.find(b => /aceptar/i.test((b.textContent || b.value || "")));
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (modalAceptado) {
      console.log("✅ Modal de confirmación aceptado");
      await page.waitForTimeout(1500);
    }

    // ── PASO 7 — Descargar ZIP (PDF + XML) ───────────────────────────────
    console.log("📥 Descargando ZIP...");

    const zipPromise = new Promise(resolve => {
      page.on("response", async resp => {
        try {
          const ct  = resp.headers()["content-type"] || "";
          const url = resp.url();
          if (ct.includes("zip") || ct.includes("octet-stream") || url.toLowerCase().includes(".zip")) {
            const buf = await resp.buffer().catch(() => null);
            if (buf && buf.length > 100) resolve(buf);
          }
        } catch {}
      });
      setTimeout(() => resolve(null), 10000);
    });

    // Intentar por ID (#btn_dxmlpdf — Benavides), luego por texto (ICR4)
    const clicDescarga = await page.evaluate(() => {
      const porId = document.querySelector("#btn_dxmlpdf");
      if (porId) { porId.click(); return "id"; }
      const all = Array.from(document.querySelectorAll("a, button, input[type='button']"));
      const porTexto = all.find(el =>
        /descargar\s+pdf\s*\+\s*xml|pdf\s*\+\s*xml/i.test(el.textContent || el.value || "")
      );
      if (porTexto) { porTexto.click(); return "texto"; }
      return null;
    });
    if (clicDescarga) {
      console.log(`✅ Click en Descargar PDF+XML (${clicDescarga})`);
    }

    const zipBuffer = await zipPromise;

    if (zipBuffer) {
      console.log(`📦 ZIP recibido: ${zipBuffer.length} bytes — extrayendo...`);
      let pdfBuf = null, xmlBuf = null;
      try {
        const dir = await unzipper.Open.buffer(zipBuffer);
        for (const file of dir.files) {
          const content = await file.buffer();
          if (file.path.toLowerCase().endsWith(".pdf")) pdfBuf = content;
          else if (file.path.toLowerCase().endsWith(".xml")) xmlBuf = content;
        }
      } catch (e) {
        console.log("⚠️ Error extrayendo ZIP:", e.message);
      }

      const pdfUrl = pdfBuf
        ? await subirArchivoR2(pdfBuf, `facturas/carljr_${ts}.pdf`, "application/pdf")
        : null;
      const xmlUrl = xmlBuf
        ? await subirArchivoR2(xmlBuf, `facturas/carljr_${ts}.xml`, "application/xml")
        : null;

      await browser.close();

      if (!pdfUrl && !xmlUrl) {
        console.log("⚠️ ZIP vacío — fallback IMAP");
        return { ok: true, procesandoCorreo: true };
      }
      console.log(`✅ Carl's Jr OK — PDF: ${pdfUrl} | XML: ${xmlUrl}`);
      return { ok: true, xmlUrl, pdfUrl };
    }

    // Fallback IMAP: enviar por correo
    console.log("📧 Sin descarga directa — enviando por correo (IMAP)...");
    await page.evaluate(() => {
      const inp = document.querySelector("#txt_dcorreo");
      if (inp) {
        inp.value = "buzonfacturas@serviciosga.site";
        inp.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    const btnEnviar = await page.$("#btn_denviar");
    if (btnEnviar) await btnEnviar.click();
    await page.waitForTimeout(2000);

    await browser.close();
    return { ok: true, procesandoCorreo: true };

  } catch (err) {
    console.error("❌ Error en bot Carl's Jr:", err.message);
    await screenshot("error").catch(() => {});
    try { await browser.close(); } catch {}
    return { ok: false, msg: err.message };
  }
}

module.exports = { facturarCarlsJr };
