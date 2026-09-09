// ORSAN Corporativo (estaciones Mobil) — https://mifactura.orsan.com.mx
// Angular + DevExtreme. SIN captcha, pero ⚠️ EXIGE CUENTA: sus únicas rutas
// públicas son #/login-form, #/create-account y #/reset-password — no hay
// "facturar sin registro" como en casi todos los demás portales. Las
// credenciales van en .env (ORSAN_USER / ORSAN_PASS), nunca en el código.
//
// Reconocimiento real (09-sep-2026, cuenta real GPN, ticket #341:
// Multiservicios Abasolo, EESS 7625, ticket 3448074, DV 909, $210.00):
//
//   1. #/login-form → input[type=email] + input[type=password] + submit.
//      Los ids de DevExtreme llevan un GUID que cambia en cada render, así que
//      TODO se localiza por type/clase/texto, nunca por id.
//   2. Al entrar salta un modal ("revise sus razones sociales") que tapa la
//      pantalla. Hay que cerrarlo o ningún click posterior llega.
//   3. Rutas de la app (sacadas del bundle main.js): /home, /bill,
//      /businessname, /howinvoice, /profile, /search, /tasks.
//      "Facturar Ticket" es #/bill; se entra directo.
//   4. En #/bill: el RFC ya viene seleccionado si la razón social está dada de
//      alta en "Razones Sociales" (#/businessname). Falta elegir "Uso de CFDI"
//      y uno de los dos modos de búsqueda:
//        · "Por Referencia"          → la Ref larga del pie del ticket
//        · "Estación + Ticket + DV"  → los tres por separado
//      El bot usa "Por Referencia", que es un solo dato.
//   5. BUSCAR TICKET llena la tabla (Referencia/Producto/Forma de pago/Precio/
//      Litros/Subtotal/IVA/Total) y habilita FACTURAR, que está deshabilitado
//      hasta que hay renglón.
//
// La "Ref" del ticket es compuesta: 00 + EESS(4) + 00000 + ticket(7) + DV(3).
// Para el #341: 00 7625 00000 3448074 909 → 007625000003448074909.
const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");

const PORTAL = "https://mifactura.orsan.com.mx";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function facturarOrsan({ referencia, folio, estacion, dv, total, rfc, ticketId }) {
  // Si no viene la referencia larga pero sí sus partes, se arma.
  let ref = String(referencia || "").replace(/\D/g, "");
  if (!ref && estacion && folio && dv) {
    ref = `00${String(estacion).padStart(4, "0")}00000${String(folio).padStart(7, "0")}${String(dv).padStart(3, "0")}`;
  }
  if (!ref) {
    return { ok: false, error_code: "datos_invalidos", msg: 'ORSAN: falta la "Ref:" del ticket (o la terna estación + ticket + DV para armarla)' };
  }
  if (!process.env.ORSAN_USER || !process.env.ORSAN_PASS) {
    return { ok: false, error_code: "captcha", msg: "ORSAN: faltan ORSAN_USER / ORSAN_PASS. Este portal no permite facturar sin cuenta, así que sin credenciales no hay forma de automatizarlo." };
  }

  console.log("🤖 Iniciando bot ORSAN...");
  console.log(`   Referencia: ${ref} | Total: ${total ?? "?"}`);

  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error("BROWSERLESS_TOKEN no definido");
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true`,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000 });
  page.on("dialog", async (d) => { await d.accept().catch(() => {}); });

  let xmlBuf = null;
  page.on("response", async (resp) => {
    try {
      const ct = (resp.headers()["content-type"] || "").toLowerCase();
      if (/xml/.test(ct)) {
        const b = await resp.buffer();
        if (b && /<cfdi:Comprobante|<Comprobante/i.test(b.toString("utf8").slice(0, 2000))) xmlBuf = b;
      }
    } catch {}
  });

  const ts = ticketId || Date.now();
  async function screenshot(label) {
    try {
      const buf = await page.screenshot({ fullPage: true });
      const u = await subirArchivoR2(buf, `debug/orsan_${ts}_${label}_${Date.now()}.png`, "image/png");
      console.log(`📸 [${label}]: ${u}`);
    } catch {}
  }
  const texto = () => page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
  const cerrarModal = () => page.evaluate(() => {
    const b = Array.from(document.querySelectorAll("button,a,[role=button],.dx-button"))
      .filter((x) => x.offsetParent)
      .find((x) => /^\s*cerrar\s*$/i.test((x.textContent || "").trim()));
    if (b) { b.click(); return true; }
    return false;
  });

  try {
    console.log("🔐 Iniciando sesión...");
    await page.goto(`${PORTAL}/#/login-form`, { waitUntil: "networkidle2", timeout: 45000 });
    await sleep(6000);
    await page.evaluate((u, p) => {
      const set = (el, v) => {
        if (!el) return;
        const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        s.call(el, v);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new Event("blur", { bubbles: true }));
      };
      set(document.querySelector("input[type=email]"), u);
      set(document.querySelector("input[type=password]"), p);
    }, process.env.ORSAN_USER, process.env.ORSAN_PASS);
    await sleep(1500);
    await page.evaluate(() => {
      const b = document.querySelector("input[type=submit]")
        || Array.from(document.querySelectorAll("button,[role=button],.dx-button")).find((x) => /iniciar sesi/i.test(x.textContent || ""));
      if (b) b.click();
    });
    await sleep(12000);

    if (/login-form/.test(page.url())) {
      await screenshot("login_fallido");
      await browser.close();
      return { ok: false, error_code: "captcha", msg: "ORSAN: no se pudo iniciar sesión (revisar ORSAN_USER / ORSAN_PASS)" };
    }
    await cerrarModal();
    await sleep(4000);

    console.log("🎫 Facturar Ticket (#/bill)...");
    await page.goto(`${PORTAL}/#/bill`, { waitUntil: "networkidle2", timeout: 45000 });
    await sleep(9000);
    await cerrarModal();
    await sleep(3000);

    // Uso de CFDI: es un dx-select-box, no un <select> nativo. Se abre y se
    // elige la opción por texto de la lista desplegable.
    const usoOk = await page.evaluate(async () => {
      const espera = (ms) => new Promise((r) => setTimeout(r, ms));
      const cajas = Array.from(document.querySelectorAll(".dx-selectbox, .dx-dropdowneditor")).filter((x) => x.offsetParent);
      const caja = cajas.find((c) => /Uso de CFDI|Seleccione Uso/i.test((c.parentElement || c).innerText || ""));
      if (!caja) return false;
      const flecha = caja.querySelector(".dx-dropdowneditor-button, .dx-texteditor-buttons-container") || caja;
      flecha.click();
      await espera(1500);
      const op = Array.from(document.querySelectorAll(".dx-list-item, .dx-item-content"))
        .find((x) => /gastos en general/i.test(x.textContent || ""));
      if (!op) return false;
      op.click();
      return true;
    });
    console.log(`   Uso de CFDI: ${usoOk ? "Gastos en general" : "⚠️ no se pudo elegir"}`);
    await sleep(2500);

    // ⚠️ Se usa "Estación + Ticket + DV" y NO "Por Referencia". La Ref larga
    // impresa en el ticket (007625000003448074909) se mete entera en el campo
    // Referencia y el portal la marca como INVÁLIDA — sale el aspa roja de
    // validación y "No hay información disponible". Con los tres datos por
    // separado no hay ambigüedad posible. Comprobado con el #341.
    const partes = {
      estacion: String(estacion || "").replace(/\D/g, "") || (ref.length >= 21 ? ref.slice(2, 6) : ""),
      ticket: String(folio || "").replace(/\D/g, "") || (ref.length >= 21 ? ref.slice(11, 18) : ""),
      dv: String(dv || "").replace(/\D/g, "") || (ref.length >= 21 ? ref.slice(18) : ""),
    };
    if (!partes.estacion || !partes.ticket || !partes.dv) {
      await browser.close();
      return { ok: false, error_code: "datos_invalidos", msg: `ORSAN: hacen falta estación, ticket y DV por separado (la Ref larga sola no la acepta el portal). Se tenía: ${JSON.stringify(partes)}` };
    }
    console.log(`   Modo "Estación + Ticket + DV" → ${partes.estacion} / ${partes.ticket} / ${partes.dv}`);
    await page.evaluate(() => {
      const r = Array.from(document.querySelectorAll(".dx-radiobutton, [role=radio], input[type=radio]"))
        .find((x) => /Estaci[oó]n\s*\+\s*Ticket/i.test(((x.closest("div") || x).innerText || "")));
      if (r) (r.closest(".dx-radiobutton") || r).click();
    });
    await sleep(3500);

    // ⚠️ HAY QUE TECLEAR DE VERDAD. Poner el .value con el setter nativo y
    // disparar input/change deja el valor VISIBLE en pantalla pero DevExtreme
    // no se entera: su widget sigue creyendo que el campo está vacío y marca
    // los tres con el aspa roja de "requerido", así que BUSCAR TICKET no
    // encuentra nada. Con page.type() se generan eventos de teclado reales y
    // el widget sí actualiza su estado. (Comprobado con el #341: mismos
    // valores, mismo resultado en pantalla, distinto resultado real.)
    const cajas = await page.$$("input.dx-texteditor-input");
    const libres = [];
    for (const h of cajas) {
      const usable = await h.evaluate((e) => !!e.offsetParent && !e.readOnly && !String(e.value || "").trim());
      if (usable) libres.push(h);
    }
    if (libres.length < 3) {
      await screenshot("sin_campos_estacion_ticket_dv");
      await browser.close();
      return { ok: false, msg: `ORSAN: tras elegir "Estación + Ticket + DV" solo aparecieron ${libres.length} campos editables de los 3 esperados` };
    }
    // Ticket y Dígito Verificador son cajas de texto normales.
    for (const [i, valor] of [[1, partes.ticket], [2, partes.dv]]) {
      await libres[i].click({ clickCount: 3 });
      await page.keyboard.type(valor, { delay: 60 });
      await sleep(900);
    }

    // ⚠️ "Estación" NO es una caja de texto: es un desplegable ("Selecciona una
    // estación"). Teclear el número deja el campo en blanco y marcado como
    // requerido — hay que abrir la lista y pulsar el renglón. El número del
    // ticket (EESS 7625) aparece dentro del texto de la opción.
    await libres[0].click();
    await page.keyboard.type(partes.estacion, { delay: 80 });
    await sleep(2500);
    const estOk = await page.evaluate((num) => {
      const items = Array.from(document.querySelectorAll(".dx-list-item, .dx-item-content, .dx-dropdowneditor-overlay .dx-item"))
        .filter((x) => x.offsetParent);
      const op = items.find((x) => new RegExp(`(^|\\D)${num}(\\D|$)`).test(x.textContent || ""));
      if (!op) return items.slice(0, 8).map((x) => (x.textContent || "").trim().slice(0, 40));
      op.click();
      return true;
    }, partes.estacion);
    if (estOk !== true) {
      await screenshot("estacion_no_en_lista");
      await browser.close();
      return { ok: false, error_code: "datos_invalidos", msg: `ORSAN: la estación ${partes.estacion} no aparece en el desplegable del portal. Lo que ofrecía: ${JSON.stringify(estOk)}` };
    }
    await sleep(2000);

    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("button,[role=button],.dx-button"))
        .filter((x) => x.offsetParent)
        .find((x) => /buscar ticket/i.test(x.textContent || ""));
      if (b) b.click();
    });
    await sleep(10000);
    await screenshot("p1_post_buscar");

    let t = await texto();
    if (/No hay informaci[oó]n disponible/i.test(t)) {
      await browser.close();
      return { ok: false, error_code: "datos_invalidos", msg: `ORSAN: el portal no encontró la referencia ${ref}` };
    }
    const mTotal = t.match(/Total\s*\$?\s*([\d,]+\.\d{2})/i);
    const totalPortal = mTotal ? parseFloat(mTotal[1].replace(/,/g, "")) : 0;
    if (total && totalPortal && Math.abs(totalPortal - Number(total)) > 1) {
      await browser.close();
      return { ok: false, error_code: "datos_invalidos", msg: `ORSAN: el total del portal ($${totalPortal}) no coincide con el del ticket ($${total})` };
    }
    console.log(`   ✔ Ticket encontrado${totalPortal ? ` — $${totalPortal}` : ""}`);

    console.log("🧾 Facturando...");
    const pulsado = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("button,[role=button],.dx-button"))
        .filter((x) => x.offsetParent)
        .find((x) => /^\s*facturar\s*$/i.test((x.textContent || "").trim()));
      // El botón queda deshabilitado hasta que hay renglón en la tabla.
      if (!b || b.classList.contains("dx-state-disabled") || b.disabled) return false;
      b.click();
      return true;
    });
    if (!pulsado) {
      await screenshot("facturar_deshabilitado");
      await browser.close();
      return { ok: false, msg: "ORSAN: el botón FACTURAR seguía deshabilitado — el ticket no llegó a cargarse en la tabla" };
    }
    await sleep(15000);
    t = await texto();
    await screenshot("p2_post_facturar");

    if (/error|no se pudo|fall[oó]/i.test(t) && !/exito|generad|timbr/i.test(t)) {
      await browser.close();
      return { ok: false, msg: `ORSAN: el portal reportó un problema al timbrar. Pantalla: ${t.slice(0, 220)}` };
    }

    // El resultado sale en un modal: "Factura Guardada Correctamente" + folio
    // (ej. ECA-189501) + "Tu Factura se envió a tu correo electronico".
    const guardada = /Factura Guardada Correctamente/i.test(t);
    const folioFactura = (t.match(/Factura Guardada Correctamente\s*([A-Z]{2,4}-\d{4,9})/i) || [])[1] || null;
    if (!guardada) {
      await browser.close();
      return { ok: false, msg: `ORSAN: no apareció la confirmación de timbrado. Pantalla: ${t.slice(0, 220)}` };
    }
    console.log(`✅ Factura ${folioFactura || "(sin folio legible)"}`);

    for (let i = 0; i < 8 && !xmlBuf; i++) await sleep(2000);
    await browser.close();

    if (!xmlBuf) {
      return {
        ok: true,
        procesandoCorreo: true,
        msg: `ORSAN: factura ${folioFactura || ref} timbrada. El portal la mandó al correo de la cuenta (${process.env.ORSAN_USER}) y queda en "Consulta de Facturas" (#/search). NO reintentar: duplicaría el CFDI.`,
      };
    }
    const xmlUrl = await subirArchivoR2(xmlBuf, `facturas/orsan_${ts}_${ref}.xml`, "application/xml");
    console.log(`☁️ XML: ${xmlUrl}`);
    return { ok: true, xmlUrl, pdfUrl: null };
  } catch (e) {
    await screenshot("excepcion");
    await browser.close().catch(() => {});
    return { ok: false, msg: `ORSAN: ${e.message}` };
  }
}

module.exports = { facturarOrsan };
