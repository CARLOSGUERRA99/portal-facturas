/**
 * G500 Network / Servicio Gastur — g500facturagas.azurewebsites.net
 *
 * Es la MISMA plataforma ControlGAS® que app.facturagas.net (bots/facturagas.js),
 * pero otro despliegue y con dos diferencias que obligan a un bot aparte:
 *   · Requiere INICIAR SESIÓN (facturagas.net usa "Facturación sin Usuario").
 *   · La estación NO se busca por autocompletado: viene fija en la URL como
 *     ?PermisoCRE=PL/10942/EXP/ES/2015 y el combo queda deshabilitado.
 * Credenciales por entorno: G500_USER / G500_PASS / G500_PERMISO_CRE.
 *
 * MAPA (verificado en vivo el 2026-09-08)
 *   Portada  → #mailUser + #pwdUser + botón "Ingresar"
 *   Menú     → "Nueva factura" lleva a /facturar.aspx
 *   Captura  → #noTran (*Folio) + #webId (*WebID) + botón "Agregar Ticket"
 *              La estación es un RadComboBox de Telerik ya resuelto por la URL:
 *              texto "PL/10942/EXP/ES/2015: SERVICIO GASTUR, S.A. DE C.V.".
 *
 * ⚠️ PLAZO CORTÍSIMO: el ticket impreso dice "TICKET FACTURABLE DENTRO DE LAS
 *    72 HRs". No son 30 días ni fin de mes — tres días y se acabó. Si el portal
 *    responde "No se encuentra el ticket ingresado" con folio y WebID correctos,
 *    lo más probable es que ya se haya pasado ese plazo.
 *
 * El propio control de estación publica las reglas de validación del portal:
 *   folio  ^([0-9]{3,12})$      webId  ^([0-9]{5}|[0-9]{8})$
 * Se comprueban aquí antes de abrir el navegador, para no gastar una sesión de
 * Browserless en un dato que el portal va a rechazar de todos modos.
 */

const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function facturarG500({ folio, webId, total, rfc, usoCfdi, ticketId }) {
  const user = process.env.G500_USER;
  const pass = process.env.G500_PASS;
  const permiso = process.env.G500_PERMISO_CRE;

  console.log("🤖 Iniciando bot G500 (ControlGAS)...");
  console.log(`   Folio: ${folio} | WebID: ${webId} | Total: ${total} | RFC: ${rfc}`);

  if (!user || !pass) {
    return { ok: false, msg: "G500: faltan credenciales G500_USER / G500_PASS en el entorno" };
  }
  if (!permiso) {
    return { ok: false, msg: "G500: falta G500_PERMISO_CRE en el entorno (identifica la estación en la URL)" };
  }

  const folioStr = String(folio || "").trim();
  const webIdStr = String(webId || "").trim();
  const faltan = [];
  if (!/^[0-9]{3,12}$/.test(folioStr)) faltan.push(`folio "${folioStr}" (el portal pide 3 a 12 dígitos)`);
  if (!/^([0-9]{5}|[0-9]{8})$/.test(webIdStr)) faltan.push(`WebID "${webIdStr}" (el portal pide exactamente 5 u 8 dígitos)`);
  if (faltan.length) {
    return {
      ok: false, error_code: "datos_invalidos",
      msg: `G500: ${faltan.join(" y ")}. Ambos vienen impresos en el ticket como "FOLIO :" y "WEB ID :".`,
    };
  }

  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error("BROWSERLESS_TOKEN no definido");

  let browser;
  try {
    browser = await puppeteer.connect({
      browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true`,
    });
  } catch (e) {
    return { ok: false, msg: `G500: no se pudo conectar al browser — ${e.message}` };
  }

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  let ultimoDialog = null;
  page.on("dialog", async (d) => {
    ultimoDialog = d.message();
    console.log(`💬 ALERT: "${d.message()}"`);
    try { await d.accept(); } catch {}
  });

  const ts = ticketId || Date.now();
  async function screenshot(label) {
    try {
      const buf = await page.screenshot({ fullPage: false });
      const u = await subirArchivoR2(buf, `debug/g500_${ts}_${label}_${Date.now()}.png`, "image/png");
      console.log(`📸 [${label}]: ${u}`);
    } catch {}
  }
  const fallo = async (label, error_code, msg) => {
    await screenshot(label).catch(() => {});
    try { await browser.close(); } catch {}
    return { ok: false, error_code, msg };
  };

  try {
    const url = `https://g500facturagas.azurewebsites.net/?PermisoCRE=${permiso}&seccion=`;
    console.log("🌐 Cargando portal...");
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 40000 });
    await sleep(3500);

    // ── Login ─────────────────────────────────────────────────────────────
    await page.waitForSelector("#mailUser", { visible: true, timeout: 20000 });
    await page.click("#mailUser"); await page.keyboard.type(user, { delay: 35 });
    await page.click("#pwdUser");  await page.keyboard.type(pass, { delay: 35 });
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("button,input[type=submit],a"))
        .find((x) => /^\s*ingresar\s*$/i.test(x.textContent || x.value || ""));
      if (b) b.click();
    });
    await sleep(7000);

    const logueado = await page.evaluate(() => /nueva factura/i.test(document.body.innerText || ""));
    if (!logueado) {
      return await fallo("p1_login", "reintentar_despues",
        `G500: no se pudo iniciar sesión con ${user}${ultimoDialog ? ` — "${ultimoDialog}"` : ""}. Revisa G500_USER/G500_PASS.`);
    }
    console.log("   ✔️ Sesión iniciada");

    // ── Nueva factura ─────────────────────────────────────────────────────
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("a,button,div[onclick]"))
        .filter((x) => x.offsetParent)
        .find((x) => /^\s*nueva factura\s*$/i.test((x.textContent || "").trim()));
      if (b) b.click();
    });
    await sleep(6000);
    await page.waitForSelector("#noTran", { visible: true, timeout: 20000 });

    // La estación la fija el PermisoCRE de la URL; se confirma cuál quedó para
    // que quede en el log a qué razón social se está facturando.
    const estacion = await page.evaluate(() =>
      document.querySelector("#ctl00_mainContent_rstation_Input")?.value || "");
    console.log(`   ✔️ Estación: ${estacion}`);

    await page.click("#noTran"); await page.keyboard.type(folioStr, { delay: 45 });
    await page.click("#webId");  await page.keyboard.type(webIdStr, { delay: 45 });
    await sleep(400);
    await screenshot("p2_datos_ticket");

    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("button,input[type=submit],input[type=button],a"))
        .find((x) => /agregar ticket/i.test(x.textContent || x.value || "") && x.offsetParent);
      if (b) b.click();
    });
    await sleep(7000);

    const texto = await page.evaluate(() => document.body.innerText || "");

    if (/no se encuentra el ticket/i.test(texto)) {
      return await fallo("p2_ticket_no_encontrado", "datos_invalidos",
        `G500: el portal no encuentra el ticket (folio ${folioStr}, WebID ${webIdStr}) en la estación "${estacion}". `
        + `Los dos datos cumplen el formato que el portal exige, así que lo más probable es que se haya pasado el plazo: `
        + `el ticket dice "FACTURABLE DENTRO DE LAS 72 HRs".`);
    }
    if (/ya (fue|est[aá]) facturad|previamente facturad/i.test(texto)) {
      return await fallo("p2_ya_facturado", "ya_facturado",
        `G500: el folio ${folioStr} ya estaba facturado. El CFDI existe: se puede bajar desde "Mis facturas" en el portal.`);
    }
    console.log("   ✔️ Ticket agregado");
    await screenshot("p3_ticket_agregado");

    // "Continuar" lleva a la pantalla de selección de cliente.
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("button,input[type=submit],input[type=button],a"))
        .find((x) => /^\s*(continuar|siguiente)\s*$/i.test((x.textContent || x.value || "").trim()) && x.offsetParent);
      if (b) b.click();
    });
    await sleep(7000);

    // ── Selección de cliente ──────────────────────────────────────────────
    // ⚠️ La cuenta tiene MÁS DE UN cliente dado de alta (GPN Pinturas
    // GPR110128QD8 y General Paint del Noroeste GPN000829S72): hay que pulsar
    // en LA FILA cuyo RFC coincide, nunca la primera de la tabla, o se timbra
    // a nombre de la empresa equivocada. El enlace de la fila dice "FACTURAR";
    // "Seleccionar" es solo el título de la columna.
    const textoCliente = await page.evaluate(() => document.body.innerText || "");
    if (/seleccione un cliente/i.test(textoCliente)) {
      const elegido = await page.evaluate((rfcBuscado) => {
        const filas = Array.from(document.querySelectorAll("tr"));
        const fila = filas.find((f) => (f.innerText || "").toUpperCase().includes(String(rfcBuscado).toUpperCase()));
        if (!fila) return null;
        const btn = Array.from(fila.querySelectorAll("a,button,input[type=button],input[type=submit]"))
          .find((b) => /facturar|seleccionar/i.test(b.textContent || b.value || ""));
        if (!btn) return null;
        btn.click();
        return (fila.innerText || "").replace(/\s+/g, " ").slice(0, 90);
      }, rfc);
      if (!elegido) {
        return await fallo("p4_sin_cliente", "reintentar_despues",
          `G500: el portal pidió elegir cliente y no encontré una fila con el RFC ${rfc}. Puede que falte darlo de alta en "Datos fiscales" del portal.`);
      }
      console.log(`   ✔️ Cliente elegido: ${elegido}`);
      await sleep(7000);
    }
    await screenshot("p4_tras_cliente");

    // ── Uso del CFDI ──────────────────────────────────────────────────────
    // Es un <select> nativo y es OBLIGATORIO: mientras no se elija, el botón
    // de generar no hace nada (por eso el intento anterior reportaba "sin
    // botón de facturar" estando ya en la pantalla correcta).
    const usoElegido = await page.evaluate((codigo) => {
      const sel = Array.from(document.querySelectorAll("select"))
        .find((s) => Array.from(s.options).some((o) => /uso del cfdi|gastos en general/i.test(o.text)) ||
                     /uso.*cfdi/i.test(s.id + s.name));
      if (!sel) return null;
      const opt = Array.from(sel.options).find((o) => new RegExp("\\b" + codigo + "\\b", "i").test(o.text) || o.value === codigo)
               || (codigo === "G03" ? Array.from(sel.options).find((o) => /gastos en general/i.test(o.text)) : null);
      if (!opt) return null;
      sel.value = opt.value;
      ["input", "change"].forEach((ev) => sel.dispatchEvent(new Event(ev, { bubbles: true })));
      return opt.text.trim().slice(0, 45);
    }, String(usoCfdi || "G03").toUpperCase());
    console.log(`   ${usoElegido ? `✔️ Uso CFDI: ${usoElegido}` : "⚠️ no se pudo elegir el Uso CFDI"}`);
    if (!usoElegido) {
      return await fallo("p4_sin_uso_cfdi", "reintentar_despues",
        `G500: no se pudo seleccionar el Uso de CFDI ${usoCfdi || "G03"} en la pantalla de Generar Factura.`);
    }
    await sleep(1500);

    // ── Facturar ──────────────────────────────────────────────────────────
    const pulsado = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("button,input[type=submit],input[type=button],a"))
        .find((x) => /^\s*(facturar|generar factura|timbrar|continuar)\s*$/i.test((x.textContent || x.value || "").trim()) && x.offsetParent);
      if (b) { b.click(); return (b.textContent || b.value || "").trim(); }
      return null;
    });
    console.log(`   ${pulsado ? `✔️ Pulsado "${pulsado}"` : "⚠️ sin botón de facturar en pantalla"}`);
    await sleep(10000);
    await screenshot("p5_resultado");
    const textoFinal = await page.evaluate(() => document.body.innerText || "");

    if (/factura.*(generad|emitid|exitos|timbrad)|descargar|xml/i.test(textoFinal)) {
      console.log("✅ Factura generada en el portal");
      await browser.close();
      // El portal manda el CFDI por correo; el job de IMAP lo recoge.
      return { ok: true, procesandoCorreo: true };
    }

    await browser.close();
    return {
      ok: false, error_code: "reintentar_despues",
      msg: `G500: el ticket se agregó y se eligió el cliente, pero no se confirmó la emisión. `
         + `${pulsado ? `Se pulsó "${pulsado}". ` : ""}Pantalla: ${textoFinal.replace(/\s+/g, " ").slice(0, 250)}`,
    };

  } catch (err) {
    console.error("❌ Error en bot G500:", err.message);
    await screenshot("error").catch(() => {});
    try { await browser.close(); } catch {}
    return { ok: false, msg: `G500: ${err.message}${ultimoDialog ? ` (alert: "${ultimoDialog}")` : ""}` };
  }
}

module.exports = { facturarG500 };
