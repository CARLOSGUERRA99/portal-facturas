// Orler / Sinaloa — facturacion.sinaloa.gob.mx (casetas de peaje del estado)
// Requiere LOGIN (cuenta ya registrada por el usuario) — credenciales SOLO
// por variables de entorno, nunca hardcoded: ORLER_SINALOA_USER / ORLER_SINALOA_PASS.
//
// Reconocimiento real (2026-07-27, cuenta real GPN, ticket real Caseta El
// Pisal folio 0944056):
//   1. /login → input[name="user"] + input[name="password"] → botón "INICIAR SESIÓN"
//      (los id tienen sufijos generados dinámicamente — usar name, no id).
//   2. Tras login, ir directo a /nuevafactura (ya autenticado por cookie de sesión).
//   3. Radio name="caseta": "Sí" (índice 0) revela el campo "Número de carril"
//      (name="carril") — con "No" (default) ese campo NO existe en el DOM.
//   4. Folio: input[name="folio"] ("Folio / Operación de Caja").
//   5. Fecha de Pago: input de solo-lectura que abre un datepicker Material
//      (mes actual por default) — hay que navegar con las flechas "<"/">" si
//      el mes del pago no es el mes mostrado, y hacer click en el día.
//   6. Importe: input[name="amount"].
//   7. Botón "BUSCAR". Si el folio no es válido TODAVÍA (timing — Orler dice
//      "Casetas de peaje: 5-6 días" desde el pago), aparece un modal "Alerta:
//      El folio no se encuentra con los datos proporcionados". CONFIRMADO en
//      vivo con datos reales y correctos — no es un bug de datos, es tiempo.
//
// ⚠️ Lo que sigue tras un "Buscar" EXITOSO (folio ya reconocido) NO se pudo
// verificar en vivo — el único ticket real disponible seguía dentro de la
// ventana de espera. Se implementa según las instrucciones que el propio
// portal muestra en pantalla ("Da clic en el botón facturar y después
// confirma los datos... tu factura se enviará por correo electrónico"), con
// selectores por texto (más tolerantes a cambios que un id). Debe
// reverificarse contra un folio real ya vencido antes de confiar en esta
// parte ciegamente.
const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");

const MESES = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];

function sumarDiasHabiles(fecha, n) {
  const d = new Date(fecha);
  let contados = 0;
  while (contados < n) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) contados++;
  }
  return d;
}

async function seleccionarFechaPago(page, fechaPagoStr) {
  // fechaPagoStr esperado "DD/MM/YYYY"
  const [ddStr, mmStr, yyyyStr] = String(fechaPagoStr).split(/[\/\-]/);
  const dd = parseInt(ddStr, 10), mm = parseInt(mmStr, 10), yyyy = parseInt(yyyyStr, 10);
  if (!dd || !mm || !yyyy) throw new Error(`Fecha de pago con formato inesperado: "${fechaPagoStr}" (se espera DD/MM/YYYY)`);

  const fechaEl = await page.evaluateHandle(() => Array.from(document.querySelectorAll('input')).find(i => (i.id || '').includes('FechadePago')));
  await fechaEl.asElement().click();
  await page.waitForTimeout(700);

  for (let intento = 0; intento < 30; intento++) {
    const encabezado = await page.evaluate(() => {
      const candidatos = Array.from(document.querySelectorAll('div,span,h1,h2,h3'));
      const m = candidatos.find(e => /^[a-záéíóú]+ de \d{4}$/i.test((e.textContent || '').trim()) && e.offsetParent !== null);
      return m ? m.textContent.trim() : null;
    });
    if (!encabezado) throw new Error("No se encontró el encabezado del calendario (mes/año)");
    const [nombreMes, , anioStr] = encabezado.split(" ");
    const mesActual = MESES.indexOf(nombreMes.toLowerCase()) + 1;
    const anioActual = parseInt(anioStr, 10);

    if (mesActual === mm && anioActual === yyyy) {
      const clicked = await page.evaluate((dia) => {
        const el = Array.from(document.querySelectorAll('button, td, div')).find(
          d => (d.textContent || '').trim() === String(dia) && d.offsetParent !== null
        );
        if (el) { el.click(); return true; }
        return false;
      }, dd);
      if (!clicked) throw new Error(`No se encontró el día ${dd} en el calendario de ${encabezado}`);
      await page.waitForTimeout(400);
      return;
    }

    const objetivoAnterior = (anioActual > yyyy) || (anioActual === yyyy && mesActual > mm);
    const flechaSel = objetivoAnterior ? 'prev' : 'next';
    const avanzo = await page.evaluate((dir) => {
      const botones = Array.from(document.querySelectorAll('button'));
      const el = dir === 'prev'
        ? botones.find(b => /prev|anterior|‹|</i.test(b.className + b.getAttribute('aria-label') || '') || b.querySelector('[class*="prev"]'))
        : botones.find(b => /next|siguiente|›|>/i.test(b.className + b.getAttribute('aria-label') || '') || b.querySelector('[class*="next"]'));
      if (el) { el.click(); return true; }
      return false;
    }, flechaSel);
    if (!avanzo) throw new Error(`No se pudo navegar el calendario hacia "${flechaSel}"`);
    await page.waitForTimeout(400);
  }
  throw new Error("No se pudo llegar al mes/año objetivo del datepicker tras 30 intentos");
}

async function facturarOrler({ carril, folio, fechaPago, importe, ticketId }) {
  console.log("🤖 Iniciando bot Orler / Sinaloa (casetas de peaje)...");
  console.log(`   Carril: ${carril} | Folio: ${folio} | Fecha pago: ${fechaPago} | Importe: ${importe}`);

  const user = process.env.ORLER_SINALOA_USER;
  const pass = process.env.ORLER_SINALOA_PASS;
  if (!user || !pass) {
    return { ok: false, msg: "Orler: faltan credenciales ORLER_SINALOA_USER/ORLER_SINALOA_PASS en el entorno" };
  }

  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error("BROWSERLESS_TOKEN no definido");
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true`,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");

  const ts = ticketId || Date.now();
  async function screenshot(label) {
    try {
      const buf = await page.screenshot({ fullPage: true });
      const u = await subirArchivoR2(buf, `debug/orler_${ts}_${label}_${Date.now()}.png`, "image/png");
      console.log(`📸 [${label}]: ${u}`);
    } catch {}
  }

  page.on("dialog", async d => { console.log("🔔 Dialog:", d.message()); await d.accept().catch(() => {}); });

  try {
    console.log("🌐 Cargando login...");
    await page.goto("https://facturacion.sinaloa.gob.mx/login", { waitUntil: "load", timeout: 30000 });
    await page.waitForSelector('input[name="user"]', { timeout: 15000 });
    await page.click('input[name="user"]'); await page.keyboard.type(user, { delay: 25 });
    await page.click('input[name="password"]'); await page.keyboard.type(pass, { delay: 25 });
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("button")).find(x => /iniciar sesi[oó]n/i.test(x.textContent || ""));
      if (b) b.click();
    });
    await page.waitForTimeout(3000);

    const loginOk = await page.evaluate(() => !/BIENVENIDO/i.test(document.body.innerText || ""));
    if (!loginOk) {
      await screenshot("login_fallido");
      await browser.close();
      return { ok: false, msg: "Orler: no se pudo iniciar sesión — revisa ORLER_SINALOA_USER/PASS" };
    }
    console.log("✅ Sesión iniciada");
    await screenshot("p1_post_login");

    console.log("➡️ Yendo a Nueva Factura...");
    await page.goto("https://facturacion.sinaloa.gob.mx/nuevafactura", { waitUntil: "load", timeout: 20000 });
    await page.waitForSelector('input[name="caseta"]', { timeout: 15000 });

    const radios = await page.$$('input[name="caseta"]');
    await radios[0].click(); // "Sí"
    await page.waitForTimeout(700);

    await page.click('input[name="carril"]');
    await page.keyboard.type(String(carril), { delay: 25 });

    await page.click('input[name="folio"]');
    await page.keyboard.type(String(folio), { delay: 25 });

    console.log("📅 Seleccionando fecha de pago en el calendario...");
    await seleccionarFechaPago(page, fechaPago);

    await page.click('input[name="amount"]');
    await page.keyboard.type(parseFloat(importe).toFixed(2), { delay: 25 });
    await screenshot("p2_form_listo");

    console.log("🔍 Click BUSCAR...");
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("button")).find(x => /^buscar$/i.test((x.textContent || "").trim()));
      if (b) b.click();
    });
    await page.waitForTimeout(3000);
    await screenshot("p3_resultado_buscar");

    const alerta = await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll("div,p,span")).find(e => /el folio no se encuentra/i.test(e.textContent || ""));
      return el ? el.textContent.trim() : null;
    });

    if (alerta) {
      // Cerrar el modal si sigue abierto (no afecta el resultado, solo limpieza)
      await page.evaluate(() => {
        const b = Array.from(document.querySelectorAll("button")).find(x => /aceptar/i.test(x.textContent || ""));
        if (b) b.click();
      }).catch(() => {});
      await browser.close();

      const [dd, mm, yyyy] = String(fechaPago).split(/[\/\-]/).map(Number);
      const fechaPagoDate = new Date(yyyy, mm - 1, dd);
      const min5 = sumarDiasHabiles(fechaPagoDate, 5);
      const min6 = sumarDiasHabiles(fechaPagoDate, 6);
      const fmt = d => d.toLocaleDateString("es-MX", { day: "2-digit", month: "2-digit", year: "numeric" });
      return {
        ok: false,
        error_code: "reintentar_despues",
        msg: `Orler: el portal aún no reconoce el folio ${folio} — probablemente por timing (casetas de peaje: 5-6 días hábiles desde el pago). Ventana estimada de disponibilidad: entre ${fmt(min5)} y ${fmt(min6)}.`,
      };
    }

    // ── A partir de aquí: SIN VERIFICAR en vivo (ver nota al inicio del archivo) ──
    console.log("🧾 Folio reconocido — buscando botón Facturar (flujo NO verificado en vivo)...");
    const facturarClicked = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("button, a")).find(x => /^facturar$/i.test((x.textContent || "").trim()));
      if (b) { b.click(); return true; }
      return false;
    });
    if (!facturarClicked) {
      await screenshot("p4_sin_boton_facturar");
      await browser.close();
      return { ok: false, msg: "Orler: folio reconocido pero no se encontró el botón 'Facturar' — revisar screenshot p4_sin_boton_facturar (selector no confirmado)" };
    }
    await page.waitForTimeout(1500);
    await screenshot("p4_post_facturar_click");

    const confirmarClicked = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("button")).find(x => /confirmar/i.test(x.textContent || ""));
      if (b) { b.click(); return true; }
      return false;
    });
    console.log(`   Click confirmar: ${confirmarClicked}`);
    await page.waitForTimeout(2500);
    await screenshot("p5_post_confirmar");

    const textoFinal = await page.evaluate(() => document.body.innerText);
    await browser.close();

    if (/correo electr[oó]nico/i.test(textoFinal)) {
      console.log("✅ Orler — factura solicitada, se enviará por correo (IMAP la recogerá)");
      return { ok: true, procesandoCorreo: true };
    }
    return { ok: false, msg: `Orler: no se confirmó el envío tras Facturar/Confirmar. Texto: ${textoFinal.slice(0, 300)}` };

  } catch (err) {
    console.error("❌ Error en bot Orler:", err.message);
    await screenshot("error").catch(() => {});
    await browser.close().catch(() => {});
    return { ok: false, msg: `Orler: ${err.message}` };
  }
}

module.exports = { facturarOrler };
