// TopGas Gasolineras — https://btf.topgas.kernotek.mx/bajatufactura/
// (plataforma "Kernotek / bajatufactura"). Estaciones de Grupo Seca
// Gasolineras en Guanajuato y alrededores. SIN captcha.
//
// Reconocimiento real (08-sep-2026, cuenta real GPN, ticket #339 timbrado en
// vivo: estación 91 SUR, código 42186738658, $989.14 → factura SUA93802,
// UUID 0149a366-87f9-473d-a60c-cfd3f122eccc):
//
//   1. www.topgasmexico.com NO es el portal: el de facturación real es
//      btf.topgas.kernotek.mx/bajatufactura/ ("Público en general").
//   2. Pantalla 1 — Estación. El <input name="estacion"> parece autocompletado
//      libre pero NO lo es: solo acepta el ID. Mandar "91 - SUR" (la etiqueta
//      que muestra) devuelve "Error: Estación inválida"; hay que mandar "91".
//      El catálogo completo viene en el atributo data-estaciones del propio
//      input, como JSON [{label,id,nombre}], así que se puede resolver el
//      número desde el nombre sin pedir nada al servidor.
//   3. Pantalla 2 — menú: "Descargar Factura" / "Generación de Factura"
//      (#btn_facturar) / "Generación de Factura Clientes".
//   4. Pantalla 3 — RFC (#rfc, form #search_codigo) → lista "CLIENTES
//      ENCONTRADOS" → hay que pulsar el "Seleccionar" de la fila.
//   5. Pantalla 4 — Código (<input name="codigo[]">). ⚠️ ES EL "CODIGO" DEL
//      PIE DEL TICKET, no el número de TRANSACCION: el ticket #339 traía
//      TRANSACCION 0200280439 y CODIGO 42186738658, y el portal quiere el
//      segundo. El campo valida al perder el foco y pinta el importe al lado;
//      es un array, así que admite varios consumos en una misma factura.
//   6. Pantalla 5 — confirmación con el detalle real (fecha, transacción,
//      productos, total) para cruzar contra el ticket, + "Cuenta de pago
//      (4 últimos dígitos)" (#cuentapago) y "Uso de CFDI" (#usocfdi, ya viene
//      en G03) → #btn_facturar.
//   7. Pantalla 6 — "Factura: SUA93802 ... Total: $989.14" y un botón
//      Descargar que es un POST con factura=<folio>&downloadzip=true y
//      devuelve un ZIP con PDF+XML. Eso SÍ lo ve page.on('response') (no es
//      un blob), que es como se recupera el CFDI.
//
// ⚠️ El CFDI también se manda al correo registrado del cliente EN EL PORTAL
// (para GPN: carlosguerra@grupogpn.com), no al buzón de captura. Por eso el
// bot baja el ZIP: si dependiera del correo, el CFDI nunca entraría por IMAP.
//
// ⚠️ Ventana: el ticket avisa "cuenta con 3 días después de fin de mes para
// facturar". Es más holgada que la de otros portales, pero no es indefinida.
const puppeteer = require("puppeteer");
// unzipper ya es dependencia del proyecto (la usa el flujo de IMAP), así que
// no hace falta meter adm-zip solo para esto.
const unzipper = require("unzipper");
const { subirArchivoR2 } = require("../storage/r2");

const PORTAL_URL = "https://btf.topgas.kernotek.mx/bajatufactura/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function facturarTopGas({
  codigo, folio, estacion, estacionNombre, total, cuentaPago, rfc, ticketId,
}) {
  const cod = String(codigo || folio || "").replace(/\D/g, "");
  if (!cod) {
    return { ok: false, error_code: "datos_invalidos", msg: 'TopGas: falta el "CODIGO" del pie del ticket (el que va bajo "SI DESEA DESCARGAR SU COMPROBANTE"), que NO es el número de TRANSACCION' };
  }
  if (!rfc) return { ok: false, error_code: "datos_invalidos", msg: "TopGas: falta el RFC del receptor" };

  console.log("🤖 Iniciando bot TopGas...");
  console.log(`   Código: ${cod} | Estación: ${estacion || estacionNombre || "?"} | Total: ${total ?? "?"}`);

  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error("BROWSERLESS_TOKEN no definido");
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true`,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1000 });
  page.on("dialog", async (d) => { await d.accept().catch(() => {}); });

  // El ZIP llega como respuesta HTTP normal (no blob), así que se puede leer
  // del propio Response sin hooks en la página.
  let zipBuf = null;
  page.on("response", async (resp) => {
    try {
      const ct = (resp.headers()["content-type"] || "").toLowerCase();
      const cd = (resp.headers()["content-disposition"] || "").toLowerCase();
      if (/zip|octet-stream/.test(ct) || /\.zip/.test(cd)) {
        const b = await resp.buffer();
        if (b && b.length > 200) zipBuf = b;
      }
    } catch {}
  });

  const ts = ticketId || Date.now();
  async function screenshot(label) {
    try {
      const buf = await page.screenshot({ fullPage: true });
      const u = await subirArchivoR2(buf, `debug/topgas_${ts}_${label}_${Date.now()}.png`, "image/png");
      console.log(`📸 [${label}]: ${u}`);
    } catch {}
  }
  const texto = () => page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));

  try {
    await page.goto(PORTAL_URL, { waitUntil: "networkidle2", timeout: 45000 });
    await page.waitForSelector("#tags", { timeout: 25000 });

    // El catálogo de estaciones viene embebido en data-estaciones. Se resuelve
    // el ID a partir del número o del nombre impreso en el ticket. Mandar la
    // etiqueta completa da "Estación inválida" — solo vale el id.
    const estId = await page.evaluate((num, nombre) => {
      const raw = document.getElementById("tags").getAttribute("data-estaciones") || "[]";
      let lista = [];
      try { lista = JSON.parse(raw); } catch { return null; }
      const n = String(num || "").replace(/\D/g, "");
      if (n) { const x = lista.find((e) => String(e.id) === n); if (x) return x.id; }
      if (nombre) {
        const t = String(nombre).toUpperCase();
        const x = lista.find((e) => t.includes(String(e.nombre).toUpperCase()));
        if (x) return x.id;
      }
      return null;
    }, estacion, estacionNombre || "");
    if (!estId) {
      await browser.close();
      return { ok: false, error_code: "datos_invalidos", msg: `TopGas: no se pudo identificar la estación (${estacion || estacionNombre || "sin dato"}) en el catálogo del portal` };
    }
    console.log(`   Estación resuelta: ${estId}`);

    await page.evaluate((id) => {
      const e = document.getElementById("tags");
      e.value = String(id);
      e.dispatchEvent(new Event("input", { bubbles: true }));
      e.dispatchEvent(new Event("change", { bubbles: true }));
      document.getElementById("estacion_val").submit();
    }, estId);
    await sleep(6000);

    let t = await texto();
    if (/Estaci[oó]n inv[aá]lida/i.test(t)) {
      await browser.close();
      return { ok: false, error_code: "datos_invalidos", msg: `TopGas: el portal rechazó la estación ${estId}` };
    }

    console.log("📋 Generación de Factura → RFC...");
    await page.evaluate(() => { const b = document.getElementById("btn_facturar"); if (b) b.click(); });
    await sleep(2500);
    await page.evaluate((r) => {
      const e = document.getElementById("rfc");
      e.focus(); e.value = r;
      e.dispatchEvent(new Event("input", { bubbles: true }));
      e.dispatchEvent(new Event("change", { bubbles: true }));
      const f = Array.from(document.querySelectorAll("form")).find((x) => x.id === "search_codigo");
      f.querySelector("[name=btn_submit_codigo]").click();
    }, rfc);
    await sleep(8000);

    t = await texto();
    if (!/CLIENTES ENCONTRADOS/i.test(t)) {
      await screenshot("rfc_sin_cliente");
      await browser.close();
      return { ok: false, error_code: "datos_invalidos", msg: `TopGas: el RFC ${rfc} no está dado de alta en la estación ${estId}. Hay que registrarlo una vez en el portal.` };
    }
    const sel = await page.evaluate((r) => {
      const clave = String(r).replace(/-/g, "").toUpperCase();
      const tr = Array.from(document.querySelectorAll("tr")).find((x) => (x.innerText || "").replace(/[-\s]/g, "").toUpperCase().includes(clave));
      if (!tr) return false;
      const el = tr.querySelector("a,button,input[type=button],input[type=submit],img");
      if (!el) return false;
      el.click();
      return true;
    }, rfc);
    if (!sel) {
      await browser.close();
      return { ok: false, error_code: "datos_invalidos", msg: `TopGas: ${rfc} no apareció en la lista de clientes` };
    }
    await sleep(8000);

    console.log(`🎫 Código ${cod}...`);
    await page.evaluate((c) => {
      const e = document.querySelector('input[name="codigo[]"]');
      e.focus(); e.value = c;
      e.dispatchEvent(new Event("input", { bubbles: true }));
      e.dispatchEvent(new Event("change", { bubbles: true }));
      e.dispatchEvent(new Event("blur", { bubbles: true }));
    }, cod);
    await sleep(6000);

    t = await texto();
    const mTotal = t.match(/Total:\s*\$\s*([\d,]+\.?\d*)/i);
    const totalPortal = mTotal ? parseFloat(mTotal[1].replace(/,/g, "")) : 0;
    if (!totalPortal) {
      await screenshot("codigo_sin_importe");
      await browser.close();
      return { ok: false, error_code: "datos_invalidos", msg: `TopGas: el código ${cod} no devolvió importe — puede estar mal leído o ya facturado` };
    }
    if (total && Math.abs(totalPortal - Number(total)) > 1) {
      await browser.close();
      return { ok: false, error_code: "datos_invalidos", msg: `TopGas: el importe del portal ($${totalPortal}) no coincide con el del ticket ($${total})` };
    }
    console.log(`   ✔ Importe verificado: $${totalPortal}`);

    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 45000 }).catch(() => {}),
      page.evaluate(() => { const b = document.getElementById("submit"); if (b) b.click(); }),
    ]);
    await sleep(3000);
    await screenshot("p1_confirmacion");

    // Cuenta de pago y uso de CFDI (el portal ya trae G03 por defecto).
    await page.evaluate((cta) => {
      const e = document.getElementById("cuentapago");
      if (e && cta) {
        e.focus(); e.value = String(cta).replace(/\D/g, "").slice(-4);
        e.dispatchEvent(new Event("input", { bubbles: true }));
        e.dispatchEvent(new Event("change", { bubbles: true }));
      }
      const u = document.getElementById("usocfdi");
      if (u) {
        const o = Array.from(u.options).find((x) => /GASTOS EN GENERAL/i.test(x.text));
        if (o) { u.value = o.value; u.dispatchEvent(new Event("change", { bubbles: true })); }
      }
    }, cuentaPago || "");
    await sleep(2500);

    console.log("🧾 Facturando...");
    // ⚠️ Este click NAVEGA. Sin esperar la navegación, el page.evaluate que
    // sigue revienta con "Execution context was destroyed" — y como el click
    // YA salió, la factura queda emitida mientras el bot reporta excepción,
    // que es la peor combinación posible (invita a reintentar y duplicar).
    // Pasó con el #331 en la primera corrida.
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }).catch(() => {}),
      page.evaluate(() => { const b = document.getElementById("btn_facturar"); if (b) b.click(); }),
    ]);
    await sleep(4000);
    t = await texto();
    await screenshot("p2_post_facturar");

    // CCHYP108 es un rechazo del SAT por datos de LA ESTACIÓN, no nuestros: el
    // RFC con el que timbra no coincide con el que la CRE tiene registrado para
    // su NumeroPermiso. Reintentar no sirve de nada por muchas veces que se
    // haga — lo tiene que corregir la gasolinera. Se marca como ticket que hay
    // que pedir por correo, con el contacto que el propio ticket imprime.
    // Confirmado con el #331 (estación 2556 LIBRAMIENTO, permiso PL/2556).
    if (/CCHYP108|no corresponde con el RFC/i.test(t)) {
      await browser.close();
      return {
        ok: false,
        error_code: "ticket_vencido",
        email_contacto: "auxiliar5@topgasmexico.com",
        msg: "TopGas: el SAT rechaza el timbrado por un problema de la ESTACIÓN (CCHYP108: el RFC con el que emite no coincide con el registrado en su permiso CRE). No es un dato del ticket y no se arregla reintentando — hay que pedir la factura al comercio.",
      };
    }
    const mFolio = t.match(/Factura:\s*(\S+)/i);
    if (!mFolio) {
      await browser.close();
      return { ok: false, msg: `TopGas: no se confirmó el timbrado. Pantalla: ${t.slice(0, 220)}` };
    }
    const folioFactura = mFolio[1];
    // El hash de la URL de descarga trae el UUID en base64 — se aprovecha,
    // porque si la descarga del ZIP fallara al menos queda constancia de cuál
    // es el CFDI emitido y no hay que adivinarlo después.
    let uuid = null;
    try {
      const h = (page.url().match(/hash=([^&#]+)/) || [])[1];
      if (h) {
        const plano = Buffer.from(decodeURIComponent(h), "base64").toString("utf8");
        uuid = (plano.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) || [])[0] || null;
      }
    } catch {}
    console.log(`✅ Factura ${folioFactura}${uuid ? ` — UUID ${uuid}` : ""}`);

    console.log("⬇️ Bajando ZIP con PDF+XML...");
    zipBuf = null;
    await page.evaluate(() => { const b = document.getElementById("pdf_dwn"); if (b) b.click(); });
    for (let i = 0; i < 12 && !zipBuf; i++) await sleep(2000);
    await browser.close();

    if (!zipBuf) {
      return {
        ok: false,
        error_code: "reintentar_despues",
        msg: `TopGas: la factura ${folioFactura}${uuid ? ` (UUID ${uuid})` : ""} SÍ se timbró por $${totalPortal}, pero no se pudo bajar el ZIP. NO reintentar el bot (duplicaría el CFDI): bajarla del portal con "Descargar Factura" y asociarla con scripts/asociar-cfdi.js.`,
      };
    }

    const dir = await unzipper.Open.buffer(zipBuf);
    let xmlUrl = null, pdfUrl = null;
    for (const entry of dir.files) {
      const nombre = String(entry.path || "").toLowerCase();
      if (!/\.(xml|pdf)$/.test(nombre)) continue;
      const buf = await entry.buffer();
      if (nombre.endsWith(".xml")) xmlUrl = await subirArchivoR2(buf, `facturas/topgas_${ts}_${folioFactura}.xml`, "application/xml");
      else pdfUrl = await subirArchivoR2(buf, `facturas/topgas_${ts}_${folioFactura}.pdf`, "application/pdf");
    }
    if (!xmlUrl) {
      return { ok: false, error_code: "reintentar_despues", msg: `TopGas: factura ${folioFactura} timbrada, pero el ZIP no traía XML. NO reintentar; bajarla del portal.` };
    }
    console.log(`☁️ XML: ${xmlUrl}`);
    return { ok: true, xmlUrl, pdfUrl };
  } catch (e) {
    await screenshot("excepcion");
    await browser.close().catch(() => {});
    return { ok: false, msg: `TopGas: ${e.message}` };
  }
}

module.exports = { facturarTopGas };
