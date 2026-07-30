// CAFFENIO — facturaciondrive.caffenio.com (plataforma de Servicios
// Administrativos OSLO, S.A. de C.V., usada por los ~381 drives de CAFFENIO).
//
// Reconocimiento real (2026-07-30, portal en vivo):
//   - La home solo muestra el login de "MI CAFFENIO". El flujo SIN CUENTA vive
//     en la ruta directa /ticket: el enlace "Factura sin cuenta MI CAFFENIO"
//     apunta ahí, pero hacerle click (ni por JS ni sintético) no navega de forma
//     confiable — este bot va DIRECTO a /ticket.
//   - NO hay CAPTCHA en ningún punto del flujo (verificado en la home y en
//     /ticket: sin iframes de recaptcha/turnstile, sin nodos [class*=captcha],
//     y la palabra "captcha" no aparece en el HTML).
//   - Formulario de /ticket, tres campos obligatorios:
//       input[name="folio"]           (type=number, ej. "12345")
//       input[name="codFacturacion"]  (type=number, ej. "12345678" — 8 dígitos)
//       input[placeholder="Seleccione..."]  → autocomplete del "Drive"
//     y el botón "Buscar ticket".
//   - El Drive es un autocomplete con 381 opciones (todas las sucursales del
//     país, con prefijo "Caffenio "). Hay que escribir para filtrar y luego
//     hacer click en el <li>/[role=option] real; asignar el valor no basta.
//   - VENTANA: el portal avisa "podrás facturar tu compra dentro de los 30 días
//     naturales según la fecha impresa en tu ticket". Fuera de eso el folio ya
//     no existe para el portal.
//   - El portal valida folio+codFacturacion+drive EN CONJUNTO. Si algo no
//     coincide responde "No se encontró orden con la información capturada."
//     sin generar nada — probar un drive equivocado es inocuo.
//
// ⚠️ ESTADO: flujo de búsqueda verificado en vivo contra el portal real, pero el
// cierre E2E (datos fiscales → timbrado → XML/PDF) NO está verificado todavía,
// porque el único ticket real disponible (#145) tiene el folio y el código de
// facturación ILEGIBLES en la foto (el OCR los marcó dudosos: se lee "2116b11",
// con la "b" ambigua entre 6/8/0, y el código con 7 dígitos donde el portal
// espera 8). Se probaron los 2 únicos drives de Cd. Obregón y ambos
// respondieron "No se encontró orden". Falta una foto más nítida del ticket
// para cerrar el ciclo y confirmar los pasos posteriores.
const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");

const URL_TICKET = "https://facturaciondrive.caffenio.com/ticket";

async function seleccionarDrive(page, nombreDrive) {
  const inp = await page.$('input[placeholder="Seleccione..."]');
  if (!inp) return false;
  await inp.click({ clickCount: 3 });
  // Se escribe sin el prefijo "Caffenio " para que el filtro del autocomplete
  // encuentre la sucursal por su nombre distintivo.
  await page.keyboard.type(String(nombreDrive).replace(/^caffenio\s+/i, ""), { delay: 45 });
  await page.waitForTimeout(1800);
  const h = await page.evaluateHandle((n) => {
    const objetivo = n.toLowerCase().replace(/^caffenio\s+/, "");
    const opts = Array.from(document.querySelectorAll("[role=option], li"));
    return opts.find(o => o.textContent.trim().toLowerCase() === n.toLowerCase())
        || opts.find(o => o.textContent.trim().toLowerCase().includes(objetivo))
        || null;
  }, nombreDrive);
  const el = h.asElement();
  if (!el) return false;
  await el.click();
  await page.waitForTimeout(800);
  return true;
}

async function facturarCaffenio(datos = {}) {
  console.log("🤖 Iniciando bot CAFFENIO...");
  const { folio, ticketId } = datos;
  // El OCR nombra el código de facturación de varias formas según el prompt que
  // se haya usado, y el drive puede venir como sucursal o como el propio
  // comercio ("CAFFENIO <sucursal>") — se aceptan todos los alias.
  const codFacturacion = datos.codFacturacion || datos.codigoFacturacion || datos.referencia || datos.codigoTicket;
  const drive = datos.drive || datos.sucursal || datos.origen || datos.comercio;
  console.log(`   Folio: ${folio} | Cód. facturación: ${codFacturacion} | Drive: ${drive}`);

  const faltan = [!folio && "folio", !codFacturacion && "código de facturación", !drive && "drive/sucursal"].filter(Boolean);
  if (faltan.length) {
    return {
      ok: false,
      error_code: "datos_invalidos",
      msg: `CAFFENIO: falta ${faltan.join(" y ")} — el portal exige folio + código de facturación + drive juntos. Hay que capturarlos a mano desde la foto del ticket.`,
    };
  }

  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error("BROWSERLESS_TOKEN no definido");
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true`,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1000 });
  page.on("dialog", async d => { console.log("🔔 Dialog:", d.message()); await d.accept().catch(() => {}); });

  const ts = ticketId || Date.now();
  async function screenshot(label) {
    try {
      const buf = await page.screenshot({ fullPage: true });
      const u = await subirArchivoR2(buf, `debug/caffenio_${ts}_${label}_${Date.now()}.png`, "image/png");
      console.log(`📸 [${label}]: ${u}`);
    } catch {}
  }

  try {
    await page.goto(URL_TICKET, { waitUntil: "networkidle2", timeout: 30000 });
    await page.waitForTimeout(3000);
    await page.waitForSelector('input[name="folio"]', { timeout: 15000 });

    await page.click('input[name="folio"]');
    await page.keyboard.type(String(folio), { delay: 45 });
    await page.click('input[name="codFacturacion"]');
    await page.keyboard.type(String(codFacturacion), { delay: 45 });

    const driveOk = await seleccionarDrive(page, drive);
    if (!driveOk) {
      await screenshot("p1_sin_drive");
      await browser.close();
      return { ok: false, error_code: "datos_invalidos", msg: `CAFFENIO: el drive "${drive}" no aparece en el autocomplete del portal` };
    }
    await screenshot("p1_form_lleno");

    const btn = await page.evaluateHandle(() =>
      Array.from(document.querySelectorAll("button")).find(b => /buscar ticket/i.test(b.textContent || "")) || null
    );
    const btnEl = btn.asElement();
    if (!btnEl) throw new Error("no se encontró el botón 'Buscar ticket'");
    await btnEl.click();
    await page.waitForTimeout(6000);
    await screenshot("p2_post_buscar");

    const texto = await page.evaluate(() => document.body.innerText);

    if (/no se encontr[oó] orden/i.test(texto)) {
      await browser.close();
      return {
        ok: false,
        error_code: "datos_invalidos",
        msg: `CAFFENIO: "No se encontró orden con la información capturada" — folio ${folio}, código ${codFacturacion}, drive "${drive}". El portal valida los tres juntos; revisar que el folio/código estén bien leídos y que el ticket no tenga más de 30 días naturales.`,
      };
    }
    if (/ya (fue|ha sido) facturad|previamente facturad/i.test(texto)) {
      await browser.close();
      return { ok: false, error_code: "ya_facturado", msg: `CAFFENIO: el folio ${folio} ya había sido facturado` };
    }
    if (/30 d[ií]as|venci|fuera de|caduc/i.test(texto) && !/dentro de los 30 d[ií]as naturales/i.test(texto)) {
      await browser.close();
      return { ok: false, error_code: "ticket_vencido", msg: `CAFFENIO: el ticket está fuera de la ventana de 30 días naturales` };
    }

    // ⚠️ A partir de aquí el flujo NO está verificado en vivo (nunca se logró
    // pasar la búsqueda con un ticket real legible). Se devuelve un error
    // explícito en vez de fingir un éxito: es preferible que el ticket quede
    // para revisión manual que reportar una factura que no existe.
    await screenshot("p3_ticket_encontrado_flujo_no_verificado");
    await browser.close();
    return {
      ok: false,
      msg: `CAFFENIO: el ticket SÍ se encontró, pero el resto del flujo (datos fiscales → timbrado → descarga) aún no está implementado ni verificado en vivo. Revisar el screenshot p3 para completar el bot. Texto: ${texto.slice(0, 300)}`,
    };

  } catch (err) {
    console.error("❌ Error en bot CAFFENIO:", err.message);
    await screenshot("error").catch(() => {});
    await browser.close().catch(() => {});
    return { ok: false, msg: `CAFFENIO: ${err.message}` };
  }
}

module.exports = { facturarCaffenio };
