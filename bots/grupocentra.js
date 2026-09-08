// Grupo Centra — https://facturacion.grupocentra.mx/Karmi_FacturacionWeb
// (plataforma "Karmi"). Estaciones de Operadora Río Colorado y franquicias
// asociadas en Sonora/BC: San Luis RC, Sonoyta, Mexicali, Tijuana, Caborca,
// Hermosillo, Cajeme, etc. SIN captcha.
//
// Reconocimiento real (08-sep-2026, cuenta real GPN, tickets #320 y #343
// timbrados en vivo):
//   #320 E.S. 7870 SONOYTA, folio 7828808, $1,067.18 → factura 4292 serie GGW
//   #343 E.S. 8394 OBREGÓN Y CUAUHTEMOC, folio 4317853, $700.07 → 12163 GHW
//
// ⚠️ ES GENEXUS: todos los ids son autogenerados (A4, A12, A40…) y no tienen
// nombre semántico. Si el proveedor redespliega la app pueden CAMBIAR TODOS de
// golpe. Por eso cada paso valida que el elemento exista y aborta con un
// mensaje claro en vez de seguir a ciegas. Mapa confirmado el 08-sep-2026:
//   #M16 "Facturar GAS" (entrada)      #A4  RFC        #A1  Buscar
//   #A3 razón social  #A7 correo  #A71 régimen  #A117 CP   (los autollena el
//        portal al pulsar Buscar — GPN ya está dado de alta aquí)
//   #A15 Ciudad (select)  → recarga → #A14 Sucursal (select)
//   #A95_1 Gasolina (checkbox)  #A96_1 Aceites
//   #A12 No. Ticket   #A47 Fecha (DD/MM/AAAA)   #A48 Hora (HH:MM)
//   #A17 Cargar → llena #A18 combustible, #A19 litros, #A21 precio, #A23 importe
//   #A24 Agregar → mete la fila a la tabla y calcula #A26/#A27/#A28 (sub/IVA/total)
//   #A33 Forma de Pago (select)   #A45 Uso de CFDI (select)
//   #A40 Facturar → pantalla con title "Si/No" y el texto
//        "La Factura folio NNNN serie XXX se Genero Exitosamente"
//   #A60 Reimpresiones → #A4 folio + #A2 serie → "Consultar Factura" →
//        #A14 correo → clWDUtil.pfGetTraitement('A10',0)() → envía el CFDI
//
// ⚠️ LA HORA ES OBLIGATORIA. "Cargar" no encuentra el consumo sin ella, y no
// es un dato que los otros portales pidan — por eso hay prompt propio de OCR.
//
// ⚠️ LA SERIE ES POR ESTACIÓN, no correlativa global: Sonoyta emitió serie GGW
// folio 4292 y, minutos después, Obregón y Cuauhtémoc emitió serie GHW folio
// 12163. Buscar la factura de una estación con la serie de otra no encuentra
// nada — cuesta creer que no se timbró cuando sí. Hay que leer la serie del
// mensaje de éxito, no deducirla.
//
// ⚠️ El ticket dice "Tiene 3 dias para realizar su factura" pero el portal NO
// lo aplica: los dos tickets facturados tenían 8 y 9 días. No descartar un
// ticket por la fecha sin haberlo intentado.
//
// 🛑 PELIGRO DE DUPLICADO — este portal NO se protege solo. "Cargar" devuelve
// el consumo con normalidad AUNQUE ese ticket ya esté facturado (comprobado con
// el #320 después de timbrarlo), y "Facturar" volvería a emitir un CFDI. No hay
// ningún "ya ha sido facturado" que frene al bot, a diferencia de facturagas o
// enerser. Así que:
//   · NUNCA relanzar este bot sobre un ticket sin comprobar antes en la tabla
//     `facturas` si ya tiene UUID.
//   · Que "Cargar" traiga datos NO significa que el ticket esté sin facturar.
//     Me equivoqué razonando así al depurar el #343.
//   · Para saber si algo se timbró, la única señal fiable es el mensaje de
//     éxito con su folio Y SU SERIE; buscar en Reimpresiones con la serie de
//     otra estación no encuentra nada aunque la factura exista.
//
// Entrega: por CORREO. Los botones "Descargar XML/PDF" son _JSL() de GeneXus
// (no hay href), así que el camino confiable es Reimpresiones → enviar al
// buzón de captura y dejar que IMAP lo recoja.
const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");

const PORTAL_URL = "https://facturacion.grupocentra.mx/Karmi_FacturacionWeb";
const BUZON = process.env.IMAP_USER || "buzonfacturas@serviciosga.site";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function facturarGrupoCentra({
  folio, fecha, hora, estacion, ciudad, total, formaPago,
  rfc, usoCfdi, ticketId,
}) {
  const faltan = [];
  if (!String(folio || "").trim()) faltan.push("folio del ticket");
  if (!String(fecha || "").trim()) faltan.push("fecha del ticket (DD/MM/AAAA)");
  if (!String(hora || "").trim()) faltan.push("hora del ticket (HH:MM) — este portal no encuentra el consumo sin ella");
  if (!String(estacion || "").trim()) faltan.push("número de estación (el 'E.S. ####' del encabezado)");
  if (!rfc) faltan.push("RFC del receptor");
  if (faltan.length) {
    return { ok: false, error_code: "datos_invalidos", msg: `Grupo Centra: faltan datos del ticket — ${faltan.join(", ")}` };
  }

  const estacionNum = String(estacion).replace(/\D/g, "");
  console.log("🤖 Iniciando bot Grupo Centra (Karmi)...");
  console.log(`   Estación: ${estacionNum} | Folio: ${folio} | ${fecha} ${hora} | Total: ${total ?? "?"}`);

  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error("BROWSERLESS_TOKEN no definido");
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true`,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1100 });
  page.on("dialog", async (d) => { await d.accept().catch(() => {}); });

  const ts = ticketId || Date.now();
  async function screenshot(label) {
    try {
      const buf = await page.screenshot({ fullPage: true });
      const u = await subirArchivoR2(buf, `debug/grupocentra_${ts}_${label}_${Date.now()}.png`, "image/png");
      console.log(`📸 [${label}]: ${u}`);
    } catch {}
  }
  const texto = () => page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
  const valor = (id) => page.evaluate((i) => { const e = document.getElementById(i); return e ? e.value : null; }, id);
  const clickId = (id) => page.evaluate((i) => { const e = document.getElementById(i); if (!e) return false; e.click(); return true; }, id);
  // GeneXus ignora el .value pelado en algunos campos; se dispara input/change
  // y ademas blur, que es lo que detona sus validaciones de servidor.
  const escribir = (id, v) =>
    page.evaluate((i, val) => {
      const e = document.getElementById(i);
      if (!e) return false;
      e.focus(); e.value = val;
      e.dispatchEvent(new Event("input", { bubbles: true }));
      e.dispatchEvent(new Event("change", { bubbles: true }));
      e.blur();
      return true;
    }, id, String(v));
  const elegir = (id, patron) =>
    page.evaluate((i, p) => {
      const s = document.getElementById(i);
      if (!s) return null;
      const o = Array.from(s.options).find((x) => new RegExp(p, "i").test(x.text));
      if (!o) return null;
      s.value = o.value;
      s.dispatchEvent(new Event("change", { bubbles: true }));
      return o.text;
    }, id, patron);

  try {
    await page.goto(PORTAL_URL, { waitUntil: "networkidle2", timeout: 45000 });
    await sleep(3500);
    if (!(await clickId("M16"))) {
      await screenshot("sin_boton_facturar_gas");
      await browser.close();
      return { ok: false, msg: 'Grupo Centra: no apareció el botón "Facturar GAS" (#M16) — el portal pudo haber cambiado sus ids de GeneXus' };
    }
    await sleep(5000);

    console.log("📋 RFC → Buscar...");
    await escribir("A4", rfc);
    await sleep(1200);
    await clickId("A1");
    await sleep(7000);

    const razon = await valor("A3");
    if (!razon) {
      await screenshot("rfc_sin_datos");
      await browser.close();
      return { ok: false, error_code: "datos_invalidos", msg: `Grupo Centra: el portal no tiene registrado el RFC ${rfc} (no autocompletó la razón social). Hay que darlo de alta con "Registrate aqui..." una vez.` };
    }
    console.log(`   Receptor: ${razon}`);

    // La sucursal solo se puede elegir tras cargar su ciudad. Si el ticket no
    // dice la ciudad se recorren todas hasta encontrar el número de estación.
    const ciudades = ciudad
      ? [ciudad]
      : await page.evaluate(() => {
          const s = document.getElementById("A15");
          return s ? Array.from(s.options).map((o) => o.text.trim()).filter((t) => t && !/SELECCIONE/i.test(t)) : [];
        });

    let sucursal = null;
    for (const c of ciudades) {
      const elegida = await elegir("A15", `^${c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
      if (!elegida) continue;
      await sleep(6000);
      sucursal = await elegir("A14", `#${estacionNum}\\b`);
      if (sucursal) { console.log(`   Ciudad: ${elegida} | Sucursal: ${sucursal.slice(0, 60)}`); break; }
    }
    if (!sucursal) {
      await screenshot("sin_sucursal");
      await browser.close();
      return { ok: false, error_code: "datos_invalidos", msg: `Grupo Centra: la estación #${estacionNum} no aparece en ninguna ciudad del portal` };
    }
    await sleep(6000);

    console.log("🎫 Cargando consumo...");
    await page.evaluate(() => { const g = document.getElementById("A95_1"); if (g && !g.checked) g.click(); });
    await sleep(1500);
    await escribir("A12", folio);
    await escribir("A47", fecha);
    await escribir("A48", hora);
    await sleep(1200);
    await clickId("A17");
    await sleep(9000);

    const importe = await valor("A23");
    if (!importe) {
      await screenshot("cargar_sin_resultado");
      await browser.close();
      return { ok: false, error_code: "datos_invalidos", msg: `Grupo Centra: el portal no encontró el consumo (folio ${folio}, ${fecha} ${hora}, estación #${estacionNum}). Revisar sobre todo la HORA, que debe ser la impresa en el ticket.` };
    }
    const importeNum = parseFloat(String(importe).replace(/[^0-9.]/g, ""));
    console.log(`   Cargado: ${await valor("A18")} ${await valor("A19")} L = $${importeNum}`);
    if (total && Math.abs(importeNum - Number(total)) > 1) {
      await browser.close();
      return { ok: false, error_code: "datos_invalidos", msg: `Grupo Centra: el importe del portal ($${importeNum}) no coincide con el del ticket ($${total})` };
    }

    await clickId("A24");
    await sleep(8000);
    await elegir("A33", /credito/i.test(String(formaPago)) ? "credito" : /efectivo/i.test(String(formaPago)) ? "efectivo" : "debito");
    await sleep(4000);
    await elegir("A45", /^0?3$|G03|gastos/i.test(String(usoCfdi || "G03")) ? "gastos en general" : "gastos en general");
    await sleep(4000);
    console.log(`   Total a facturar: ${await valor("A28")}`);
    await screenshot("p1_previo_facturar");

    console.log("🧾 Facturando...");
    await clickId("A40");
    let exito = "";
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      await sleep(2500);
      const t = await texto();
      const m = t.match(/La Factura folio\s+(\S+)\s+serie\s+(\S+)\s+se Genero Exitosamente/i);
      if (m) { exito = t; var folioFactura = m[1], serieFactura = m[2]; break; }
      if (/error|no se pudo|fall/i.test(t) && !/NECESITAS AYUDA/i.test(t)) break;
    }
    await screenshot("p2_post_facturar");
    if (!exito) {
      await browser.close();
      return { ok: false, msg: `Grupo Centra: no se confirmó el timbrado. Pantalla: ${(await texto()).slice(0, 220)}` };
    }
    console.log(`✅ Factura ${folioFactura} serie ${serieFactura}`);

    // Reimpresiones → enviar el CFDI al buzón para que lo recoja IMAP.
    console.log(`📧 Enviando CFDI a ${BUZON}...`);
    await page.goto(PORTAL_URL, { waitUntil: "networkidle2", timeout: 45000 });
    await sleep(4000);
    await clickId("M16");
    await sleep(5500);
    await clickId("A60");
    await sleep(6000);
    await escribir("A4", folioFactura);
    await escribir("A2", serieFactura);
    await sleep(1000);
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("*")).find((x) => /^Consultar Factura$/i.test((x.textContent || "").trim()) && x.children.length === 0);
      if (b) (b.closest("[onclick],button,a,input") || b).click();
    });
    await sleep(8000);
    await escribir("A14", BUZON);
    await sleep(1000);
    await page.evaluate(() => { try { clWDUtil.pfGetTraitement("A10", 0, undefined)(); } catch (e) {} });
    await sleep(9000);
    const enviado = /correo fue enviado con exito/i.test(await texto());
    await screenshot("p3_post_envio");
    await browser.close();

    if (!enviado) {
      console.log("⚠️ Timbrada pero no se confirmó el envío por correo");
      return { ok: true, procesandoCorreo: true, msg: `Grupo Centra: CFDI timbrado (folio ${folioFactura} serie ${serieFactura}); el envío al buzón no se confirmó — se puede reenviar desde Reimpresiones con esos datos` };
    }
    return { ok: true, procesandoCorreo: true };
  } catch (e) {
    await screenshot("excepcion");
    await browser.close().catch(() => {});
    return { ok: false, msg: `Grupo Centra: ${e.message}` };
  }
}

module.exports = { facturarGrupoCentra };
