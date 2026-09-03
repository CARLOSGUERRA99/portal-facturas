/**
 * Carl's Jr — ICR S.A. de C.V.  ·  Portal NUEVO: Egrid
 *
 * ⚠️ CAMBIO DE PLATAFORMA (agosto 2026)
 * ICR migró de RetailEDX (`retailedx.com/ICR4/`, formulario clásico con
 * #txt_ticket / #txt_cucfdi / #modalnotificacion) a Egrid
 * (`egridhub.com:6027/icr/autofactura`).
 *
 * RetailEDX sigue de pie, y ahí estuvo la trampa: no responde 404 ni "portal
 * mudado", responde «El ticket con el número X no esta completo y no tiene un
 * conector configurado» para referencias perfectamente válidas — porque le
 * quitaron el conector de ventas de ICR. El bot viejo clasificaba eso como
 * "esperar a que la sucursal sincronice" y reintentaba en vano (tickets #206 y
 * #274). No había nada que esperar: la venta ya no vive en esa plataforma.
 *
 * El portal nuevo es Next.js (App Router) + shadcn/ui — Radix para los combobox
 * y cmdk para sus listas — y usa Server Actions: TODOS los POST van a la misma
 * URL de la página, sin endpoints REST estables que llamar. Por eso se maneja
 * por DOM y no por API.
 *
 * MAPA DEL PORTAL (verificado en vivo el 2026-08-29)
 *   Paso 1 · Tickets
 *     input[name="infoTicket.0.referencia"]  (los ids son de React, tipo
 *     ":r5:-form-item" — cambian en cada render, no sirven como selector)
 *     botón "Validar" → modal [role=dialog] "Resultado de la validación":
 *       válido:   "OK · Número: … · Fecha: … · Total: $…"
 *       inválido: "El número de referencia no es valido"
 *     ⚠️ El botón "Continuar" del modal sigue habilitado aunque la referencia
 *        sea inválida: hay que leer el texto, no fiarse del botón.
 *   Paso 2 · Datos fiscales
 *     input[name="rfc"] + "Validar" → el portal rellena solo
 *     input[name="razonSocial"] y input[name="codigoPostal"] (readOnly) y pinta
 *     "RFC Validado". Después: input[name="correo"], los dos combobox
 *     (button[role=combobox] → [role=option][data-value="601"] / "G03"),
 *     el checkbox del aviso (button[role=checkbox]) y "Enviar".
 *   Paso 3 · Confirmar datos → tabla de repaso + botón "Facturar".
 *   Éxito  · "Factura generada exitosamente" + dos botones "Descargar".
 *
 * DESCARGA DE ARCHIVOS
 * El portal no sirve el PDF/XML por HTTP: los arma como Blob en JavaScript y
 * dispara un `<a download>.click()`. Un `page.on('response')` no ve nada. La
 * solución es hookear `HTMLAnchorElement.prototype.click` ANTES de cargar la
 * página: si el href es `blob:`, se lee el contenido dentro de la pestaña y se
 * devuelve en base64. Con el portal viejo esto se dio por imposible y se caía
 * siempre al rodeo de "que lo manden por correo y que el IMAP lo cache".
 */

const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");

const PORTAL_URL = "https://egridhub.com:6027/icr/autofactura";

// Node puro: page.waitForTimeout corre el setTimeout DENTRO del browser y
// revienta con "Requesting main frame too early!" durante las navegaciones.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Helpers de DOM ────────────────────────────────────────────────────────

// Los botones del portal no tienen id ni clase estable (Tailwind generado) y
// TODOS son type=submit, incluidos los numeritos "1"/"2"/"3" del stepper. Por
// eso se buscan por texto exacto.
async function clickPorTexto(page, texto, { obligatorio = true } = {}) {
  const ok = await page.evaluate((t) => {
    const rx = new RegExp("^\\s*" + t + "\\s*$", "i");
    const btn = Array.from(document.querySelectorAll("button, a"))
      .filter((b) => b.offsetParent !== null)
      .find((b) => rx.test(b.textContent || ""));
    if (!btn) return false;
    btn.click();
    return true;
  }, texto);
  if (!ok && obligatorio) throw new Error(`Carl's Jr: no encontré el botón "${texto}"`);
  return ok;
}

async function textoModal(page) {
  return page.evaluate(() => {
    const d = document.querySelector('[role="dialog"], [role="alertdialog"]');
    return d ? (d.innerText || "").replace(/\s+/g, " ").trim() : "";
  });
}

// Combobox de shadcn: el botón abre una lista cmdk. Las opciones son divs con
// [role=option][data-value]. Un .click() sobre la opción sí dispara onSelect.
async function seleccionarCombo(page, etiqueta, valor, nombre) {
  const abierto = await page.evaluate((et) => {
    const btn = Array.from(document.querySelectorAll('button[role="combobox"]'))
      .find((b) => new RegExp(et, "i").test(b.textContent || ""));
    if (!btn) return false;
    btn.click();
    return true;
  }, etiqueta);
  if (!abierto) throw new Error(`Carl's Jr: no encontré el selector de ${nombre}`);

  await sleep(800);

  const elegido = await page.evaluate((val) => {
    const ops = Array.from(document.querySelectorAll('[role="option"]'));
    const v = String(val).toLowerCase();
    let op = ops.find((o) => (o.getAttribute("data-value") || "").toLowerCase() === v);
    if (!op) op = ops.find((o) => (o.textContent || "").trim().toLowerCase().startsWith(v));
    if (!op) return null;
    op.click();
    return (op.textContent || "").trim().slice(0, 60);
  }, valor);

  if (!elegido) throw new Error(`Carl's Jr: la opción "${valor}" no aparece en ${nombre}`);
  await sleep(500);
  console.log(`   ✔️ ${nombre}: ${elegido}`);
  return elegido;
}

// ── Bot principal ─────────────────────────────────────────────────────────

async function facturarCarlsJr({
  referencia, folio, total,
  rfc, razonSocial, regimenFiscal, usoCfdi,
  email, ticketId,
}) {
  // La referencia es la clave del ticket en el portal. El OCR a veces la parte
  // con un espacio (ticket #273: "5701643921 2051") porque en el papel viene
  // separada — el portal la quiere corrida.
  const codigoPortal = String(referencia || folio || "").replace(/\s+/g, "").trim();
  const regimen = String(regimenFiscal || "601").trim();
  const uso = String(usoCfdi || "G03").trim();
  // El correo va al buzón del sistema a propósito: si la captura del blob
  // fallara, el CFDI llega igual por correo y el job de IMAP lo levanta.
  const correo = email || "buzonfacturas@serviciosga.site";

  console.log("🤖 Iniciando bot Carl's Jr (ICR — portal Egrid)...");
  console.log(`   Referencia: ${codigoPortal} | Total ticket: ${total} | RFC: ${rfc}`);

  if (!codigoPortal) {
    return { ok: false, error_code: "datos_invalidos", msg: "Carl's Jr: no hay referencia que capturar" };
  }

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

  // Regla de oro del proyecto: un alert() sin handler congela el hilo del
  // browser y Browserless mata la pestaña con errores que no tienen nada que
  // ver ("Target closed", "Session closed").
  let ultimoDialog = null;
  page.on("dialog", async (d) => {
    ultimoDialog = d.message();
    console.log(`💬 ALERT: "${d.message()}"`);
    try { await d.accept(); } catch {}
  });

  // Captura de los blobs de descarga (ver cabecera del archivo).
  await page.evaluateOnNewDocument(() => {
    window.__descargas = [];
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      try {
        if (this.href && this.href.startsWith("blob:")) {
          const name = this.download || "";
          fetch(this.href)
            .then((r) => r.blob())
            .then((b) => new Promise((res) => {
              const fr = new FileReader();
              fr.onload = () => res(fr.result);
              fr.readAsDataURL(b);
            }))
            .then((dataUrl) => window.__descargas.push({ name, dataUrl }))
            .catch((e) => window.__descargas.push({ name, error: String(e) }));
          return; // no dejamos que el navegador intente bajarlo de verdad
        }
      } catch {}
      return origClick.apply(this, arguments);
    };
  });

  const ts = ticketId || Date.now();
  async function screenshot(label) {
    try {
      const buf = await page.screenshot({ fullPage: false });
      const u = await subirArchivoR2(buf, `debug/carljr_${ts}_${label}_${Date.now()}.png`, "image/png");
      console.log(`📸 [${label}]: ${u}`);
    } catch {}
  }
  const fallo = async (label, error_code, msg) => {
    await screenshot(label).catch(() => {});
    try { await browser.close(); } catch {}
    return { ok: false, error_code, msg };
  };

  try {
    // ── PASO 1 — Referencia del ticket ────────────────────────────────────
    console.log("🌐 Cargando portal Egrid...");
    await page.goto(PORTAL_URL, { waitUntil: "networkidle2", timeout: 45000 });

    const SEL_REF = 'input[name="infoTicket.0.referencia"]';
    await page.waitForSelector(SEL_REF, { visible: true, timeout: 20000 });

    await page.click(SEL_REF);
    await page.keyboard.type(codigoPortal, { delay: 50 });
    const capturado = await page.$eval(SEL_REF, (el) => el.value);
    console.log(`📝 Referencia capturada: "${capturado}"`);
    if (capturado.replace(/\s+/g, "") !== codigoPortal) {
      return await fallo("p1_captura", "reintentar_despues",
        `Carl's Jr: el campo quedó con "${capturado}" en vez de "${codigoPortal}"`);
    }

    await clickPorTexto(page, "Validar");
    console.log("⏳ Validando referencia...");

    await page.waitForFunction(
      () => /Resultado de la validaci[oó]n/i.test(document.body.innerText || ""),
      { timeout: 30000 }
    ).catch(() => null);

    const modal = await textoModal(page);
    console.log(`📢 Portal dice: ${modal || "(sin modal)"}`);

    if (!modal) {
      return await fallo("p1_sin_modal", "reintentar_despues",
        "Carl's Jr: el portal no respondió a la validación de la referencia. Hay captura en R2.");
    }
    // El portal confirma con un "OK" y las líneas Número/Fecha/Total. Cualquier
    // otra cosa es su explicación de por qué no se puede: se devuelve tal cual,
    // sin traducirla ni adivinar (el bot viejo inventaba motivos y le echaba la
    // culpa al usuario de fallas del portal).
    if (!/\bOK\b/.test(modal)) {
      const yaFacturado = /ya (fue |ha sido )?facturad|factura.*generada/i.test(modal);
      const invalida = /no es v[aá]lid|no existe|no encontrad/i.test(modal);
      return await fallo(
        "p1_rechazado",
        yaFacturado ? "ya_facturado" : invalida ? "datos_invalidos" : "reintentar_despues",
        `Carl's Jr: ${modal.replace(/^Detalle de tickets Resultado de la validaci[oó]n de tickets\s*/i, "")}`
      );
    }

    // Cotejo de importe: la referencia manda (es la llave de la venta), pero si
    // el total no cuadra hay que dejarlo escrito — puede ser OCR de otro ticket.
    const totalPortal = (modal.match(/Total:\s*\$?([\d,]+\.?\d*)/i) || [])[1];
    if (totalPortal && total) {
      const dif = Math.abs(Number(String(totalPortal).replace(/,/g, "")) - Number(total));
      if (dif > 0.5) {
        console.log(`⚠️ El portal dice $${totalPortal} y el ticket leído dice $${total} — se factura lo que dice el portal.`);
      }
    }

    await clickPorTexto(page, "Continuar");
    await sleep(2500);

    // ── PASO 2 — RFC ──────────────────────────────────────────────────────
    console.log("🧾 Paso 2 — datos fiscales...");
    await page.waitForSelector('input[name="rfc"]', { visible: true, timeout: 20000 });
    await page.click('input[name="rfc"]');
    await page.keyboard.type(String(rfc), { delay: 50 });
    await clickPorTexto(page, "Validar");
    console.log("⏳ Validando RFC...");

    // El portal considera validado el RFC cuando rellena solo la razón social.
    const rfcOk = await page.waitForFunction(
      () => {
        const rs = document.querySelector('input[name="razonSocial"]');
        return rs && rs.value && rs.value.trim().length > 2;
      },
      { timeout: 30000 }
    ).catch(() => null);

    if (!rfcOk) {
      const avisoRfc = (await textoModal(page)) || ultimoDialog || "";
      return await fallo("p2_rfc", "reintentar_despues",
        `Carl's Jr: el portal no validó el RFC ${rfc}${avisoRfc ? ` — "${avisoRfc}"` : " y no dio motivo"}.`);
    }

    const fiscales = await page.evaluate(() => ({
      razonSocial: document.querySelector('input[name="razonSocial"]')?.value,
      cp: document.querySelector('input[name="codigoPostal"]')?.value,
    }));
    console.log(`   ✔️ RFC validado — ${fiscales.razonSocial} · CP ${fiscales.cp}`);

    // ── PASO 2b — Correo, régimen, uso de CFDI y aviso ────────────────────
    await page.click('input[name="correo"]');
    await page.keyboard.type(correo, { delay: 30 });
    console.log(`   ✔️ Correo: ${correo}`);

    await seleccionarCombo(page, "Régimen Fiscal", regimen, "Régimen Fiscal");
    await seleccionarCombo(page, "Uso de CFDI", uso, "Uso de CFDI");

    await page.evaluate(() => {
      const cb = document.querySelector('button[role="checkbox"]');
      if (cb && cb.getAttribute("aria-checked") !== "true") cb.click();
    });
    await sleep(400);
    const avisoOk = await page.evaluate(() =>
      document.querySelector('button[role="checkbox"]')?.getAttribute("aria-checked") === "true");
    console.log(`   ✔️ Aviso de privacidad aceptado: ${avisoOk}`);
    if (!avisoOk) {
      return await fallo("p2_aviso", "reintentar_despues", "Carl's Jr: no se pudo marcar el aviso de privacidad");
    }

    await screenshot("p2_datos_fiscales");
    await clickPorTexto(page, "Enviar");
    await sleep(2500);

    // ── PASO 3 — Confirmar y facturar ─────────────────────────────────────
    const enConfirmacion = await page.waitForFunction(
      () => /Verifique que sus datos|Confirmar datos|Datos Fiscales/i.test(document.body.innerText || "") &&
        Array.from(document.querySelectorAll("button")).some((b) => /^\s*Facturar\s*$/i.test(b.textContent || "")),
      { timeout: 30000 }
    ).catch(() => null);

    if (!enConfirmacion) {
      const aviso2 = (await textoModal(page)) || ultimoDialog || "";
      return await fallo("p3_no_llego", "reintentar_despues",
        `Carl's Jr: el portal no avanzó a Confirmar datos${aviso2 ? ` — "${aviso2}"` : " y no dio motivo"}. Hay captura en R2.`);
    }
    await screenshot("p3_confirmar");

    console.log("🧾 Timbrando...");
    await clickPorTexto(page, "Facturar");

    const exito = await page.waitForFunction(
      () => /Factura generada exitosamente|generada correctamente/i.test(document.body.innerText || ""),
      { timeout: 90000 }   // el timbrado del PAC puede tardar
    ).catch(() => null);

    if (!exito) {
      const aviso3 = (await textoModal(page)) || ultimoDialog || "";
      return await fallo("p4_sin_exito", "reintentar_despues",
        `Carl's Jr: no apareció la confirmación de timbrado${aviso3 ? ` — "${aviso3}"` : ""}. Ojo: puede haberse generado igual; revisar la captura en R2 antes de reintentar.`);
    }
    console.log("✅ Factura generada en el portal");
    await screenshot("p4_exito");

    // ── PASO 4 — Bajar PDF y XML (blobs) ──────────────────────────────────
    console.log("📥 Descargando PDF y XML...");
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button"))
        .filter((b) => /^\s*Descargar\s*$/i.test(b.textContent || "") && b.offsetParent !== null);
      btns.forEach((b, i) => setTimeout(() => b.click(), i * 1200));
      return btns.length;
    });

    let descargas = [];
    for (let i = 0; i < 20; i++) {
      await sleep(1000);
      descargas = await page.evaluate(() => window.__descargas || []);
      if (descargas.filter((d) => d.dataUrl).length >= 2) break;
    }
    console.log(`   Capturadas ${descargas.length} descargas: ${descargas.map((d) => d.name || "?").join(", ")}`);

    let xmlBuf = null, pdfBuf = null;
    for (const d of descargas) {
      if (!d.dataUrl) continue;
      const buf = Buffer.from(d.dataUrl.split(",")[1] || "", "base64");
      if (buf.length < 100) continue;
      // El nombre puede venir vacío; el contenido nunca miente.
      const cabecera = buf.slice(0, 8).toString("latin1");
      if (cabecera.startsWith("%PDF") || /\.pdf$/i.test(d.name)) pdfBuf = buf;
      else if (cabecera.includes("<?xml") || /\.xml$/i.test(d.name)) xmlBuf = buf;
    }

    if (xmlBuf || pdfBuf) {
      const marca = `${ts}_${Date.now()}`;
      const xmlUrl = xmlBuf ? await subirArchivoR2(xmlBuf, `facturas/carljr_${marca}.xml`, "application/xml") : null;
      const pdfUrl = pdfBuf ? await subirArchivoR2(pdfBuf, `facturas/carljr_${marca}.pdf`, "application/pdf") : null;
      await browser.close();
      console.log(`✅ Carl's Jr OK — XML: ${xmlUrl} | PDF: ${pdfUrl}`);
      return { ok: true, xmlUrl, pdfUrl };
    }

    // La factura SÍ se generó; solo no pudimos capturar los blobs. El portal ya
    // la mandó al correo del sistema, así que el job de IMAP la recoge.
    console.log("📧 Sin captura de archivos — queda en manos del correo (IMAP)");
    await screenshot("p4_sin_descarga");
    await browser.close();
    return { ok: true, procesandoCorreo: true };

  } catch (err) {
    console.error("❌ Error en bot Carl's Jr:", err.message);
    await screenshot("error").catch(() => {});
    try { await browser.close(); } catch {}
    return { ok: false, msg: `Carl's Jr: ${err.message}${ultimoDialog ? ` (alert: "${ultimoDialog}")` : ""}` };
  }
}

module.exports = { facturarCarlsJr };
