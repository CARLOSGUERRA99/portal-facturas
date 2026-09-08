// Enerser — https://facturacion.enerser.com.mx/ (estaciones de Tijuana/BC:
// ESTACION GRUGAS "Otay Industrial", ESTACION DE SERVICIO PUERTA GRANDE
// "Tomas Aquino", etc.). Angular SPA, SIN captcha.
//
// Reconocimiento real (08-sep-2026, cuenta real GPN, tickets #335 y #338
// timbrados en vivo: referencias 099335237417FFA0 $1,500 y 1092619957771F6E
// $2,000):
//
//   1. Home → botón "Facturar sin registro" → /invitado/facturacion-lote.
//      Se puede entrar directo a esa URL (verificado), no hace falta el home.
//   2. Wizard de 4 pasos, con COLA DE TICKETS de hasta 20 por lote.
//   3. Paso 1: RFC (input[formcontrolname="rfc"]) → botón "Consultar".
//      ⚠️ Esto AUTOCOMPLETA razón social, CP, régimen y uso CFDI desde el SAT
//      — no hay que escribirlos y no conviene sobreescribirlos (para GPN salió
//      "GPN PINTURAS Y RECUBRIMIENTOS / 80140 / 601 / G03", todo correcto).
//   4. Paso 2: Referencia (input[aria-label="Referencia del ticket"]) →
//      "Agregar". La referencia es la del PIE del ticket
//      ("http://facturacion.enerser.com.mx/ Referencia: ..."), formato NetPay
//      estación(5) + nºticket + verificador(4) — ver PROMPT_NETPAY_REFERENCIA
//      en lib/vision.js.
//   5. ⚠️ CRÍTICO — "El servicio no está disponible, intente de nuevo" +
//      botón "Reintentar" NO es un error: es el estado NORMAL del primer
//      intento. Pasó en los DOS tickets, y en los dos el ticket apareció bien
//      al primer "Reintentar". Enerser consulta en vivo el servidor de cada
//      estación y ese backend tarda en despertar. Un bot que trate esa
//      pantalla como fallo nunca facturará nada aquí.
//   6. Paso 3: previsualización con Estación/Monto/Producto/Cantidad/Fecha
//      reales → se cruzan contra el ticket ANTES de timbrar.
//   7. Checkbox "Confirmo que los datos son correctos" → "Facturar" →
//      "Hemos generado tus facturas exitosamente".
//   8. Entrega: NO hay href directo a los archivos (los botones PDF/XML son
//      descargas de blob del SPA). Sí hay campo "Correo electrónico para envío
//      de facturas" → se manda al buzón de captura y lo recoge IMAP. Ese es el
//      camino confiable, igual que en facturagas.
const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");

const PORTAL_URL = "https://facturacion.enerser.com.mx/invitado/facturacion-lote";
const BUZON = process.env.IMAP_USER || "buzonfacturas@serviciosga.site";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Angular ignora el .value directo: hay que usar el setter nativo del
// prototipo y disparar input/change/blur para que el FormControl se entere.
const SET_NG = `function(el, v){
  const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  s.call(el, v);
  el.dispatchEvent(new Event('input',  { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new Event('blur',   { bubbles: true }));
}`;

async function facturarEnerser({ referencia, folio, total, rfc, ticketId }) {
  const ref = String(referencia || folio || "").trim().toUpperCase();
  if (!ref) {
    return { ok: false, error_code: "datos_invalidos", msg: "Enerser: falta la referencia del pie del ticket (la que va bajo 'facturacion.enerser.com.mx/')" };
  }
  if (!rfc) {
    return { ok: false, error_code: "datos_invalidos", msg: "Enerser: falta el RFC del receptor" };
  }

  console.log("🤖 Iniciando bot Enerser...");
  console.log(`   Referencia: ${ref} | RFC: ${rfc} | Total esperado: ${total ?? "?"}`);

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
      const u = await subirArchivoR2(buf, `debug/enerser_${ts}_${label}_${Date.now()}.png`, "image/png");
      console.log(`📸 [${label}]: ${u}`);
    } catch {}
  }
  const texto = () => page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
  const clickBoton = (re) =>
    page.evaluate((patron) => {
      const b = Array.from(document.querySelectorAll("button")).find((x) => new RegExp(patron, "i").test((x.textContent || "").trim()));
      if (b) { b.click(); return true; }
      return false;
    }, re);
  // Espera a que el SPA deje de decir "Consultando..." en vez de dormir a ciegas.
  async function esperarConsulta(maxMs = 32000) {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      await sleep(1800);
      if (!/Consultando\.\.\./.test(await texto())) return;
    }
  }

  try {
    await page.goto(PORTAL_URL, { waitUntil: "networkidle2", timeout: 45000 });
    await page.waitForSelector('input[formcontrolname="rfc"]', { timeout: 25000 });

    console.log("📋 RFC → Consultar (autocompleta datos fiscales del SAT)...");
    await page.evaluate(`(${SET_NG})(document.querySelector('input[formcontrolname="rfc"]'), ${JSON.stringify(rfc)})`);
    await sleep(700);
    await clickBoton("consultar");
    await sleep(5000);

    const razon = await page.evaluate(() => {
      const el = document.querySelector('input[formcontrolname="name"]');
      return el ? el.value : "";
    });
    if (!razon) {
      await screenshot("rfc_sin_datos");
      await browser.close();
      return { ok: false, error_code: "datos_invalidos", msg: `Enerser: el portal no reconoció el RFC ${rfc} (no autocompletó la razón social)` };
    }
    console.log(`   Receptor: ${razon}`);

    console.log(`🎫 Agregando referencia ${ref}...`);
    await page.evaluate(`(${SET_NG})(document.querySelector('input[aria-label="Referencia del ticket"]'), ${JSON.stringify(ref)})`);
    await sleep(700);
    await clickBoton("^agregar$");
    await esperarConsulta();

    // Ver cabecera, punto 5: el "servicio no disponible" es el primer intento
    // normal, no un fallo. Se reintenta varias veces antes de rendirse.
    for (let intento = 1; intento <= 6; intento++) {
      if (!/no est[aá] disponible/i.test(await texto())) break;
      console.log(`   ⏳ "El servicio no está disponible" — Reintentar (${intento}/6)...`);
      if (!(await clickBoton("reintentar"))) break;
      await esperarConsulta();
    }

    let t = await texto();
    await screenshot("p1_post_agregar");

    if (/no est[aá] disponible/i.test(t)) {
      await browser.close();
      return { ok: false, error_code: "reintentar_despues", msg: `Enerser: el servidor de la estación no respondió tras 6 reintentos ("El servicio no está disponible"). La referencia ${ref} es correcta; hay que reintentar más tarde.` };
    }
    if (/ya (ha sido |fue )?facturad/i.test(t)) {
      await browser.close();
      return { ok: true, procesandoCorreo: true };
    }
    if (/no (se )?(encontr|existe)|referencia inv[aá]lida|no v[aá]lid/i.test(t)) {
      await browser.close();
      return { ok: false, error_code: "datos_invalidos", msg: `Enerser: la referencia ${ref} no fue reconocida por el portal` };
    }
    if (/mes natural|fuera de|vencid|caduc/i.test(t) && !/Previsualizaci/i.test(t)) {
      await browser.close();
      return { ok: false, error_code: "ticket_vencido", msg: "Enerser: el consumo ya no se puede facturar (solo dentro del mes natural de la carga)" };
    }
    if (!/Previsualizaci[oó]n de datos/i.test(t)) {
      await browser.close();
      return { ok: false, msg: `Enerser: no se llegó a la previsualización. Pantalla: ${t.slice(0, 220)}` };
    }

    // Cruce del monto contra el ticket antes de timbrar: si el portal trae otra
    // venta, mejor abortar que emitir un CFDI que no corresponde.
    const montoPortal = (t.match(/Monto\s*\$?([\d,]+\.?\d*)/i) || [])[1];
    if (total && montoPortal) {
      const p = parseFloat(String(montoPortal).replace(/,/g, ""));
      if (Math.abs(p - Number(total)) > 1) {
        await browser.close();
        return { ok: false, error_code: "datos_invalidos", msg: `Enerser: el monto del portal ($${p}) no coincide con el del ticket ($${total}) para la referencia ${ref}` };
      }
      console.log(`   ✔ Monto verificado: $${p}`);
    }

    console.log("🧾 Confirmando y timbrando...");
    await page.evaluate(() => {
      const cb = document.querySelector('input[type=checkbox]');
      if (cb && !cb.checked) cb.click();
    });
    await sleep(800);
    await clickBoton("^facturar$");

    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      await sleep(2500);
      if (/exitosamente|error/i.test(await texto())) break;
    }
    t = await texto();
    await screenshot("p2_post_facturar");

    if (!/generado tus facturas exitosamente/i.test(t)) {
      await browser.close();
      return { ok: false, msg: `Enerser: no se confirmó el timbrado. Pantalla: ${t.slice(0, 220)}` };
    }
    console.log("✅ Factura generada");

    // No hay href a los archivos (son blobs del SPA); el camino confiable es
    // pedirle al portal que la mande al buzón y dejar que IMAP la recoja.
    console.log(`📧 Enviando CFDI a ${BUZON}...`);
    await page.evaluate(`(${SET_NG})(document.querySelector('input[aria-label="Correo electrónico para envío de facturas"]'), ${JSON.stringify(BUZON)})`);
    await sleep(800);
    await clickBoton("^enviar$");
    const t1 = Date.now();
    while (Date.now() - t1 < 25000) {
      await sleep(2000);
      if (/enviad/i.test(await texto())) break;
    }
    const enviado = /Facturas enviadas correctamente/i.test(await texto());
    await screenshot("p3_post_envio");
    await browser.close();

    if (!enviado) {
      // La factura YA existe en el SAT — no es un fallo de facturación. Se
      // reporta como procesandoCorreo igual: reintentar timbraría un duplicado.
      console.log("⚠️ La factura se generó pero no se confirmó el envío por correo");
      return { ok: true, procesandoCorreo: true, msg: "Enerser: CFDI timbrado; el envío al buzón no se confirmó — si no llega, descargarlo del portal" };
    }
    return { ok: true, procesandoCorreo: true };
  } catch (e) {
    await screenshot("excepcion");
    await browser.close().catch(() => {});
    return { ok: false, msg: `Enerser: ${e.message}` };
  }
}

module.exports = { facturarEnerser };
