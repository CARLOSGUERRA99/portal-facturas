// IGasFac — www.igasfac.com.mx
//
// Portal con CUENTA: requiere login previo (credenciales solo por variables de
// entorno IGAS_USER / IGAS_PASS, nunca en código).
//
// Reconocimiento real (2026-07-29, cuenta real, ticket folio
// 0637-00475232-00093301). Los cuatro detalles que cuestan sangre:
//
//   1. #Input_Folio lleva `data-mask="folioWeb"`. page.keyboard.type() y
//      element.value = ... NO funcionan: la máscara los ignora y el campo se
//      queda vacío o a medias. Hay que pulsar DÍGITO A DÍGITO con
//      page.keyboard.press() y una pausa entre cada uno.
//
//   2. Hay DOS botones "Agregar": el de la pantalla, que abre el modal, y el
//      del propio modal, que confirma. Son iguales de texto, así que el
//      segundo se busca recorriendo la lista AL REVÉS.
//
//   3. El botón que guarda los Datos Fiscales NO es descendiente de su
//      formulario: se asocia con el atributo HTML `form=`. No hay selector CSS
//      que lo alcance desde el form, así que se localiza por
//      `button.form.id === 'submitModificarDatosFiscales'`.
//
//   4. La Forma de Pago se RESETEA en cada solicitud nueva, así que hay que
//      seleccionarla y confirmarla SIEMPRE, aunque la cuenta ya la tenga
//      guardada de una vez anterior.
//
// Entrega: el portal NO descarga el CFDI en pantalla, lo manda por correo. El
// bot devuelve procesandoCorreo:true y el CFDI lo recoge el flujo de IMAP.
//
// ⚠️ Rechazo conocido CFDI40147: es un desfase entre el PAC (SmartWeb) y la
// lista masiva del SAT, NO un dato mal puesto. Se resuelve solo en 2-3 días;
// reintentar entonces con el mismo folio.
const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");

const URL_LOGIN = "https://www.igasfac.com.mx/Identity/Account/Login?ReturnUrl=%2F";
const FORMAS_PAGO = { tarjeta: "28", debito: "28", credito: "04", efectivo: "01" };

async function facturarIGasFac(datos = {}) {
  const folio = String(datos.folio || datos.folioWeb || datos.codigoTicket || "").replace(/\D/g, "");
  const formaPago = FORMAS_PAGO[String(datos.formaPago || "tarjeta").toLowerCase()] || "28";
  const ticketId = datos.ticketId;

  console.log("🤖 Iniciando bot IGasFac...");
  console.log(`   Folio: ${folio} (${folio.length} dígitos) | Forma de pago: ${formaPago}`);

  const user = process.env.IGAS_USER;
  const pass = process.env.IGAS_PASS;
  if (!user || !pass) {
    return { ok: false, error_code: "datos_invalidos", msg: "IGasFac: faltan IGAS_USER / IGAS_PASS en el entorno" };
  }
  if (!folio) {
    return { ok: false, error_code: "datos_invalidos", msg: "IGasFac: el ticket no trae folio" };
  }

  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}&stealth=true`,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on("dialog", async (d) => { console.log("🔔", d.message()); await d.accept().catch(() => {}); });

  const ts = ticketId || Date.now();
  const shot = async (label) => {
    try {
      const u = await subirArchivoR2(await page.screenshot({ fullPage: true }), `debug/igasfac_${ts}_${label}_${Date.now()}.png`, "image/png");
      console.log(`📸 [${label}]: ${u}`);
    } catch {}
  };
  const texto = () => page.evaluate(() => document.body.innerText).catch(() => "");

  try {
    console.log("🌐 Login...");
    await page.goto(URL_LOGIN, { waitUntil: "load", timeout: 30000 });
    await page.waitForSelector("#Input_Email", { timeout: 15000 });
    await page.click("#Input_Email"); await page.keyboard.type(user, { delay: 20 });
    await page.click("#Input_Password"); await page.keyboard.type(pass, { delay: 20 });
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("button")).find((x) => /iniciar sesi[oó]n/i.test(x.textContent || ""));
      if (b) b.click();
    });

    // Espera condicional: el login tarda a veces más de 2 s y un sleep fijo da
    // falsos negativos.
    let dentro = false;
    for (let i = 0; i < 15 && !dentro; i++) {
      await page.waitForTimeout(1000);
      dentro = await page.evaluate(() => !document.querySelector("#Input_Password")).catch(() => false);
    }
    if (!dentro) {
      await shot("login_fallido");
      await browser.close();
      return { ok: false, error_code: "datos_invalidos", msg: "IGasFac: no se pudo iniciar sesión — revisar IGAS_USER / IGAS_PASS" };
    }
    console.log("✅ Sesión iniciada");

    // ── Nueva Factura → Agregar → modal del folio ──────────────────────────
    // Tras el login se cae en "Consulta de facturas", que NO tiene el botón
    // "Agregar": primero hay que entrar a "Nueva Factura". Saltarse este paso
    // hacía que el bot esperara 12 s por un #Input_Folio que no existía.
    await page.waitForTimeout(1500);
    const irNueva = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("button, a")).find((x) => /nueva factura/i.test(x.textContent || ""));
      if (b) { b.click(); return true; }
      return false;
    });
    if (!irNueva) {
      await shot("sin_nueva_factura");
      await browser.close();
      return { ok: false, msg: "IGasFac: no apareció el botón 'Nueva Factura' tras el login" };
    }
    await page.waitForTimeout(3000);

    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("button")).find((x) => x.textContent.trim() === "Agregar");
      if (b) b.click();
    });
    await page.waitForTimeout(1500);
    await page.waitForSelector("#Input_Folio", { visible: true, timeout: 15000 });

    const campo = await page.$("#Input_Folio");
    await campo.click({ clickCount: 3 });
    await page.waitForTimeout(300);
    // Dígito a dígito: la máscara del campo descarta cualquier otra forma.
    for (const d of folio) {
      await page.keyboard.press(d);
      await page.waitForTimeout(70);
    }
    await page.waitForTimeout(1500);

    const escrito = await page.evaluate(() => document.querySelector("#Input_Folio")?.value || "");
    console.log(`   folio en el campo: "${escrito}"`);
    if (escrito.replace(/\D/g, "").length !== folio.length) {
      await shot("folio_incompleto");
      await browser.close();
      return {
        ok: false, error_code: "datos_invalidos",
        msg: `IGasFac: la máscara del portal solo aceptó "${escrito}" de los ${folio.length} dígitos del folio ${folio}. El folio que pide es el "Folio Web" largo del ticket, no el folio corto.`,
      };
    }

    // El segundo "Agregar" (el del modal) se busca al revés: hay dos botones
    // con el mismo texto y el de la pantalla es el primero.
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("button")).reverse().find((x) => x.textContent.trim() === "Agregar");
      if (b) b.click();
    });
    await page.waitForTimeout(2500);

    const trasAgregar = await texto();
    if (/no (se encontr|existe)|inv[aá]lid|incorrect/i.test(trasAgregar)) {
      await shot("folio_rechazado");
      await browser.close();
      return { ok: false, error_code: "datos_invalidos", msg: `IGasFac: el portal rechazó el folio ${folio} — ${(trasAgregar.match(/[^\n]*(?:no se encontr|inv[aá]lid|incorrect)[^\n]*/i) || [""])[0].trim().slice(0, 120)}` };
    }
    if (/ya (fue|ha sido) facturad|previamente facturad/i.test(trasAgregar)) {
      await browser.close();
      return { ok: false, error_code: "ya_facturado", msg: `IGasFac: el folio ${folio} ya estaba facturado` };
    }

    // ── Forma de pago (se resetea en cada solicitud: siempre hay que ponerla) ──
    console.log("➡️ Forma de pago y datos fiscales...");
    await page.select("#ClaveFormaPago", formaPago);
    await page.waitForTimeout(400);

    const nav = page.waitForNavigation({ waitUntil: "load", timeout: 12000 }).then(() => "ok").catch(() => "timeout");
    await page.evaluate(() => {
      // El botón se asocia a su form por el atributo `form=`, no por jerarquía:
      // ningún selector CSS lo alcanza desde el formulario.
      const btn = Array.from(document.querySelectorAll("button")).find((b) => b.form && b.form.id === "submitModificarDatosFiscales");
      if (btn) btn.click();
    });
    await nav;
    await page.waitForTimeout(1500);

    const antesEnviar = await texto();
    if (/seleccione forma de pago/i.test(antesEnviar)) {
      await shot("forma_pago_no_guardada");
      await browser.close();
      return { ok: false, msg: "IGasFac: la forma de pago no quedó guardada — se aborta antes de enviar la solicitud" };
    }

    // ── Enviar ────────────────────────────────────────────────────────────
    console.log("📨 Enviando solicitud...");
    const nav2 = page.waitForNavigation({ waitUntil: "load", timeout: 18000 }).then(() => "ok").catch(() => "timeout");
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("button, a")).find((x) => /enviar solicitud/i.test(x.textContent || ""));
      if (b) b.click();
    });
    await nav2;
    await page.waitForTimeout(2500);
    await shot("resultado");

    const final = await texto();

    // CFDI40147 = desfase PAC↔SAT, no un dato mal puesto. Se distingue para no
    // mandar a nadie a "revisar los datos" cuando no hay nada que revisar.
    if (/CFDI40147/i.test(final)) {
      await browser.close();
      // `reintentar_despues` y no `datos_invalidos`: el dato está bien y el
      // rechazo se cura solo, así que lo correcto es que el sistema lo
      // reagende, no que mande al usuario a corregir algo que no está mal.
      return {
        ok: false, error_code: "reintentar_despues",
        msg: "IGasFac: rechazo CFDI40147 del PAC (SmartWeb) — dice que el DomicilioFiscalReceptor no aparece en la lista de RFC del SAT. NO es un dato mal capturado: el CP 80140 está verificado contra la Constancia oficial. Es un desfase entre el PAC y la lista masiva del SAT, que se resuelve solo en 2-3 días. Reintentar entonces con el mismo folio.",
      };
    }
    if (/error|no fue posible|falló/i.test(final) && !/enviad|correo|solicitud recibida/i.test(final)) {
      await browser.close();
      return { ok: false, msg: `IGasFac: el portal devolvió un error — ${final.replace(/\s+/g, " ").slice(0, 220)}` };
    }

    console.log("✅ Solicitud enviada — el CFDI llega por correo");
    await browser.close();
    return { ok: true, procesandoCorreo: true };

  } catch (err) {
    console.error("❌ Error en bot IGasFac:", err.message);
    await shot("error").catch(() => {});
    await browser.close().catch(() => {});
    return { ok: false, msg: `IGasFac: ${err.message}` };
  }
}

module.exports = { facturarIGasFac };
