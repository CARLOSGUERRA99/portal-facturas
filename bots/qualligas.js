const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");

/**
 * QualliGas — estacion.qualligas.com/{numeroEstacion}
 *
 * Plataforma multi-estación: QualliGas es solo el proveedor del software; cada
 * gasolinera vive bajo su número de estación en la MISMA URL. El número sale
 * impreso en el ticket como "ES: 13920" y otra vez en el pie
 * ("estacion.qualligas.com/13920").
 *
 * ⚠️ HACEN FALTA DOS DATOS DEL TICKET, NO UNO. El portal pide "Ticket" **y**
 * "Web ID", y sin el Web ID el ticket no se puede agregar. Los dos están
 * impresos juntos al final del ticket:
 *       TICKET: 860670
 *       WEB ID: 0927
 * El OCR solo capturaba el primero, así que el bot moría sin saber por qué.
 * Es la trampa de "los dos folios" otra vez, en su versión más barata: el dato
 * estaba en la foto desde el principio.
 *
 * ⚠️ LOS SELECTS LLEGAN VACÍOS Y NO ES QUE TARDEN. #regimenFiscal y #usoCfdi
 * salen del servidor con CERO <option>. Los puebla getRegimenFiscal(rfc, sel),
 * una función del propio portal que consulta /{estacion}/factura/regimenFiscal
 * con el RFC. Hasta que no se llama, no hay catálogo que elegir. Y ojo: la
 * llamada a fetchReceptor() que dispara el campo Email BORRA nombre/RFC/CP, así
 * que hay que rellenarlos DESPUÉS de que carguen los catálogos, no antes.
 *
 * ⚠️ PLAZO: "FACTURA EN LINEA SOLO EL MISMO MES DE COMPRA" (impreso en el
 * ticket). No son 30 días: es el mes natural. Un ticket del 28 de un mes tiene
 * 3 días de vida, no un mes. Se comprueba ANTES de abrir el navegador.
 *
 * CAPTCHA: imagen de 150x120 en #captcha-img, servida en
 * /service/captcha/captcha/{captchaId}.pn — necesita la cookie de sesión, así
 * que hay que leerla desde dentro de la página (canvas → dataURL), no con un
 * fetch desde Node. Se resuelve con CapSolver ImageToTextTask, igual que el de
 * 7-Eleven.
 *
 * ⚠️ EL CORREO DE CONTACTO NO SE CONSTRUYE. El portal publica un mailto de la
 * estación, y en la 13920 es facturacion13920@gmail.com — que PARECE un patrón
 * (`facturacion{estacion}@gmail.com`) y no lo es. Esa dirección ni siquiera
 * existe: la solicitud del ticket #357 salió ahí y Gmail la rechazó con "The
 * email account that you tried to reach does not exist". Un correo inventado no
 * falla de forma ruidosa — sale, rebota en silencio, y el ticket se queda
 * esperando una respuesta que nunca va a llegar. Se usa solo el mailto que la
 * página publique de verdad, y si no hay ninguno se devuelve null.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function resolverCaptcha(imgBase64) {
  const apiKey = process.env.CAPSOLVER_API_KEY;
  if (!apiKey) throw new Error("CAPSOLVER_API_KEY no definida");
  const c = await fetch("https://api.capsolver.com/createTask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey: apiKey, task: { type: "ImageToTextTask", module: "common", body: imgBase64, case: true } }),
  }).then((r) => r.json());
  if (c.errorId) throw new Error(`CapSolver: ${c.errorCode || c.errorDescription}`);
  // ImageToTextTask es SÍNCRONO: createTask ya trae la solución.
  const sol = (c.solution?.text || c.solution?.answers?.[0] || "").trim();
  if (!sol) throw new Error("CapSolver no devolvió texto");
  console.log(`🔓 CAPTCHA: "${sol}"`);
  return sol;
}

// El número de estación puede venir en la URL del portal o en el texto del
// ticket ("ES: 13920"). Nunca se inventa: sin él no hay portal al que ir.
function sacarEstacion({ portalUrl, urlEstacion, ocr_text, estacion }) {
  if (estacion && /^\d{3,6}$/.test(String(estacion).trim())) return String(estacion).trim();
  for (const u of [portalUrl, urlEstacion]) {
    const m = String(u || "").match(/qualligas\.com\/(\d{3,6})/i);
    if (m) return m[1];
  }
  const m2 = String(ocr_text || "").match(/\bES:\s*(\d{3,6})\b/i);
  if (m2) return m2[1];
  const m3 = String(ocr_text || "").match(/qualligas\.com\/(\d{3,6})/i);
  return m3 ? m3[1] : null;
}

// "SOLO EL MISMO MES DE COMPRA": se compara mes y año, no una ventana de días.
function fueraDePlazo(fecha) {
  if (!fecha) return false;
  const m = String(fecha).match(/(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})/);
  if (!m) return false;
  const mesTicket = parseInt(m[2], 10), anioTicket = parseInt(m[3], 10);
  const hoy = new Date();
  return !(mesTicket === hoy.getMonth() + 1 && anioTicket === hoy.getFullYear());
}

async function facturarQualligas(datos) {
  const {
    rfc, razonSocial, regimenFiscal, usoCfdi, codigoPostal, emailEntrega,
    folio, referencia, webId, total, fecha, ticketId,
  } = datos;

  const estacion = sacarEstacion(datos);
  const numTicket = String(folio || referencia || "").trim();
  // El Web ID son 4 dígitos y puede haberse leído como `webId`, `digSeguro` o
  // quedar suelto en el texto del ticket.
  const web = String(
    webId || datos.digSeguro ||
    (String(datos.ocr_text || "").match(/WEB\s*ID[:\s]*([0-9]{3,6})/i) || [])[1] || ""
  ).trim();
  const correo = emailEntrega || "buzonfacturas@serviciosga.site";

  console.log("🤖 QualliGas...");
  console.log(`   Estación: ${estacion} | Ticket: ${numTicket} | Web ID: ${web || "(falta)"}`);

  if (!estacion) {
    return { ok: false, error_code: "datos_invalidos", msg: "QualliGas: no se pudo determinar el número de estación (viene en el ticket como 'ES: 13920' y en el pie como estacion.qualligas.com/13920)." };
  }
  if (!numTicket) {
    return { ok: false, error_code: "datos_invalidos", msg: "QualliGas: falta el número de ticket." };
  }
  if (!web) {
    return {
      ok: false, error_code: "datos_invalidos",
      msg: `QualliGas: falta el WEB ID. El portal pide DOS datos del ticket, "Ticket" y "Web ID", y sin el segundo no deja agregarlo. Está impreso al final del ticket, justo debajo del número: "WEB ID: 0927". Revísalo en la foto.`,
    };
  }
  if (fueraDePlazo(fecha)) {
    return {
      ok: false, error_code: "ticket_vencido",
      email_contacto: null, permite_solicitud_correo: true,
      msg: `QualliGas: el ticket es del ${fecha} y el portal solo factura DENTRO DEL MISMO MES NATURAL de la compra ("FACTURA EN LINEA SOLO EL MISMO MES DE COMPRA", impreso en el ticket). Hay que pedirla por correo a la estación.`,
    };
  }

  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error("BROWSERLESS_TOKEN no definido");
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true`,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000 });
  // Sin esto, un alert() del portal cuelga el hilo y Browserless mata la pestaña.
  page.on("dialog", async (d) => { console.log("💬", d.message()); await d.accept().catch(() => {}); });

  const ts = ticketId || Date.now();
  const shot = async (etiqueta) => {
    try {
      const buf = await page.screenshot({ fullPage: false });
      console.log(`📸 ${await subirArchivoR2(buf, `debug/qualligas_${ts}_${etiqueta}_${Date.now()}.png`, "image/png")}`);
    } catch {}
  };

  let timbradoDisparado = false;
  // Se rellena con el mailto que publique el portal; nunca se construye.
  let correoEstacion = null;
  try {
    // ⚠️ IR DIRECTO A /13920 NO FUNCIONA: el portal responde 200 y devuelve la
    // PORTADA, no el formulario de esa estación. La ruta con número solo existe
    // como resultado del POST de la home, así que hay que pasar por ella:
    // escribir el número en #estacion y pulsar ACEPTAR.
    console.log(`🌐 https://estacion.qualligas.com → estación ${estacion}`);
    await page.goto("https://estacion.qualligas.com/", { waitUntil: "networkidle2", timeout: 45000 });
    await page.waitForSelector("#estacion", { visible: true, timeout: 20000 });

    await page.click("#estacion");
    await page.keyboard.type(String(estacion), { delay: 60 });
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 45000 }).catch(() => {}),
      page.evaluate(() => {
        const b = Array.from(document.querySelectorAll("button, a, input[type=submit], input[type=button]"))
          .filter((x) => x.offsetParent)
          .find((x) => /^\s*aceptar\s*$/i.test((x.textContent || x.value || "").trim()));
        if (b) b.click();
        else document.getElementById("estacion").form.submit();
      }),
    ]);

    const hayForm = await page.waitForSelector("#rfc", { timeout: 25000 }).then(() => true).catch(() => false);
    await shot("p0_inicio");
    if (!hayForm) {
      const pantalla = await page.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 220)).catch(() => "");
      await browser.close();
      return { ok: false, error_code: "datos_invalidos", msg: `QualliGas: el portal no abrió el formulario de la estación ${estacion} — ¿es correcto el número? Pantalla: ${pantalla}` };
    }

    // ⚠️ EL CORREO NO SE INVENTA. Antes se construia como
    // `facturacion${estacion}@gmail.com` porque asi era el de la 13920. Es un
    // patron, no un dato: la solicitud del #357 salio a esa direccion y Gmail
    // la rechazo con "The email account that you tried to reach does not
    // exist". Un correo inventado no falla ruidosamente: sale, rebota, y el
    // ticket se queda esperando una respuesta que nunca va a llegar. Ahora
    // solo se usa el mailto que el portal publique de verdad, y si no publica
    // ninguno se devuelve null (el sistema pedira la direccion a una persona).
    correoEstacion = await page.evaluate(() => {
      const a = document.querySelector('a[href^="mailto:"]');
      return a ? a.href.replace(/^mailto:/i, "").split("?")[0].trim().toLowerCase() : null;
    }).catch(() => null);
    console.log(`   Correo publicado por el portal: ${correoEstacion || "(ninguno)"}`);

    const nombreEstacion = await page.evaluate(() =>
      ((document.body.innerText || "").match(/\d{3,6}\s*-\s*([^\n]{5,80})/) || [])[1] || null
    ).catch(() => null);
    console.log(`   Estación: ${nombreEstacion || "(sin nombre)"}`);

    // Paso 1 — el correo dispara fetchReceptor(), que BORRA nombre/RFC/CP.
    await page.evaluate((c) => {
      const e = document.getElementById("email");
      e.focus(); e.value = c;
      ["input", "change", "keyup", "blur"].forEach((x) => e.dispatchEvent(new Event(x, { bubbles: true })));
      if (window.jQuery) window.jQuery(e).trigger("change").trigger("blur");
    }, correo);
    await sleep(4000);

    // Paso 2 — poblar los catálogos con la función del propio portal.
    await page.evaluate((r, reg) => {
      if (typeof window.getRegimenFiscal === "function") window.getRegimenFiscal(r, reg);
    }, rfc, String(regimenFiscal || "601"));

    const hayCatalogo = await page.waitForFunction(
      () => document.getElementById("regimenFiscal")?.options.length > 1,
      { timeout: 25000 }
    ).then(() => true).catch(() => false);

    if (!hayCatalogo) {
      await shot("error_sin_catalogo");
      await browser.close();
      return { ok: false, error_code: "reintentar_despues", msg: "QualliGas: el portal no cargó el catálogo de Régimen Fiscal. No se emitió nada." };
    }

    // Paso 3 — ahora sí, el resto de los campos (después del borrado).
    const puestos = await page.evaluate((d) => {
      const nat = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      const set = (id, v) => {
        const e = document.getElementById(id);
        if (!e) return null;
        e.focus(); nat.call(e, String(v));
        ["input", "keyup"].forEach((x) => e.dispatchEvent(new Event(x, { bubbles: true })));
        return e.value;
      };
      const sel = (id, v) => {
        const s = document.getElementById(id);
        if (!s) return null;
        const o = Array.from(s.options).find((x) => x.value === v);
        if (o) { s.value = o.value; if (window.jQuery) window.jQuery(s).trigger("change"); }
        return s.value;
      };
      const r = {
        nombre: set("nombre", d.razonSocial),
        rfc: set("rfc", d.rfc),
        cp: set("cp", d.cp),
        ticket: set("ticket", d.ticket),
        web: set("digSeguro", d.web),
        regimen: sel("regimenFiscal", d.regimen),
      };
      const ag = document.getElementById("agreement");
      if (ag && !ag.checked) ag.click();
      r.acepta = ag ? ag.checked : null;
      return r;
    }, { razonSocial, rfc, cp: String(codigoPostal || ""), ticket: numTicket, web, regimen: String(regimenFiscal || "601") });

    // El Uso de CFDI depende del régimen: se elige DESPUÉS y se comprueba.
    await sleep(2500);
    const uso = await page.evaluate((u) => {
      const s = document.getElementById("usoCfdi");
      const o = Array.from(s.options).find((x) => x.value === u) || Array.from(s.options).find((x) => x.value === "G03");
      if (!o) return null;
      s.value = o.value;
      if (window.jQuery) window.jQuery(s).trigger("change");
      return s.value;
    }, String(usoCfdi || "G03"));
    console.log(`   Campos: ${JSON.stringify({ ...puestos, uso })}`);
    await shot("p1_formulario");

    if (!puestos.nombre || !puestos.rfc || !puestos.cp || !uso) {
      await shot("error_campos");
      await browser.close();
      return { ok: false, error_code: "reintentar_despues", msg: `QualliGas: no se pudieron rellenar los datos fiscales (${JSON.stringify({ ...puestos, uso })}). No se emitió nada.` };
    }

    // Paso 4 — agregar el ticket. El portal responde en la tabla si lo acepta.
    await page.evaluate(() => document.getElementById("add-ticket")?.click());
    await sleep(6000);
    const estadoTicket = await page.evaluate(() =>
      Array.from(document.querySelectorAll("table tr")).map((r) => (r.innerText || "").replace(/\s+/g, " ").trim()).filter(Boolean).join(" | ")
    ).catch(() => "");
    console.log(`   Tabla: ${estadoTicket.slice(0, 180)}`);
    await shot("p2_ticket_agregado");

    if (/ya\s+(fue|est[aá]|ha\s+sido)\s+facturad|ya\s+facturad|cuenta\s+con\s+factura/i.test(estadoTicket)) {
      await browser.close();
      return { ok: false, error_code: "ya_facturado", msg: `QualliGas: el portal dice que el ticket ${numTicket} ya fue facturado. ${estadoTicket.slice(0, 160)}` };
    }
    if (!/disponible\s+para\s+solicitar\s+factura/i.test(estadoTicket)) {
      await browser.close();
      if (/venci|fuera\s+de\s+(tiempo|plazo)|caduc/i.test(estadoTicket)) {
        return { ok: false, error_code: "ticket_vencido", email_contacto: correoEstacion, permite_solicitud_correo: true, msg: `QualliGas: ${estadoTicket.slice(0, 200)}` };
      }
      return { ok: false, error_code: "datos_invalidos", msg: `QualliGas: el portal no aceptó el ticket ${numTicket} / Web ID ${web}. Respuesta: ${estadoTicket.slice(0, 200) || "(sin mensaje)"}` };
    }

    // Paso 5 — Facturar abre el captcha.
    await page.evaluate(() => document.getElementById("facturar")?.click());
    const hayCaptcha = await page.waitForFunction(
      () => { const i = document.getElementById("captcha-img"); return !!(i && i.complete && i.naturalWidth > 0); },
      { timeout: 20000 }
    ).then(() => true).catch(() => false);

    if (!hayCaptcha) {
      const pantalla = await page.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 200)).catch(() => "");
      await shot("error_sin_captcha");
      await browser.close();
      return { ok: false, error_code: "reintentar_despues", msg: `QualliGas: no apareció el captcha tras pulsar Facturar. No se emitió nada. Pantalla: ${pantalla}` };
    }

    // ── El captcha, con reintentos ───────────────────────────────────────────
    //
    // ⚠️ EL CAPTCHA DISTINGUE MAYÚSCULAS Y CAPSOLVER SE EQUIVOCA EN ELLAS. En la
    // primera corrida en vivo la imagen decía "38x6yP" y CapSolver devolvió
    // "38x6yp": el portal contestó "Captcha Incorrecto" y NO se emitió nada.
    // Por eso se pide `case: true` y, sobre todo, por eso hay reintentos: el
    // portal trae un botón de recarga que sirve una imagen nueva.
    //
    // ⚠️ Y AQUÍ ESTABA EL FALSO POSITIVO, EN ESTE MISMO BOT: se daba por bueno
    // el ACEPTAR sin comprobar que el modal se hubiera cerrado, se leía la
    // pantalla 3 s después —cuando el aviso rojo ya se había desvanecido— y se
    // devolvía procesandoCorreo sobre una factura inexistente. La prueba de que
    // el captcha pasó no es que no se vea un error: es que EL MODAL SE CIERRE.
    let captchaAceptado = false;
    const INTENTOS_CAPTCHA = 6;
    for (let intento = 1; intento <= INTENTOS_CAPTCHA && !captchaAceptado; intento++) {
      if (intento > 1) {
        // Recargar para pedir una imagen nueva: insistir con la misma no sirve
        // de nada, y algunas salen mucho más legibles que otras.
        await page.evaluate(() => {
          const boton = Array.from(document.querySelectorAll("button, a, img, i, span"))
            .filter((x) => x.offsetParent)
            .find((x) => /refresh|recarg|actualiz|nuevo/i.test(`${x.id} ${x.className} ${x.title} ${x.getAttribute("onclick") || ""}`));
          if (boton) { boton.click(); return; }
          const i = document.getElementById("captcha-img");
          if (i) i.src = i.src.split("?")[0] + "?r=" + Date.now();
        }).catch(() => {});
        // ⚠️ Sin esperar a que la imagen NUEVA termine de cargar, el canvas sale
        // vacío (naturalWidth 0) y el bucle se cortaba en el primer reintento:
        // pedía 3 intentos y hacía 1.
        await page.waitForFunction(() => {
          const i = document.getElementById("captcha-img");
          return !!(i && i.complete && i.naturalWidth > 0);
        }, { timeout: 15000 }).catch(() => {});
        await sleep(700);
      }

      // La imagen necesita la cookie de sesión: se lee desde DENTRO de la
      // página. Un fetch desde Node contra esa URL devuelve 0 bytes.
      //
      // Se alterna entre la imagen CRUDA y una binarizada+ampliada. Ninguna de
      // las dos gana siempre: la binarización limpia las motas pero también
      // engorda la raya diagonal que tacha los glifos, y en algunas imágenes
      // eso empeora la lectura. Probadas por separado, CapSolver falló los dos
      // primeros captchas con cruda y los cuatro siguientes con binarizada; por
      // eso se turnan en vez de elegir una.
      const preprocesar = intento % 2 === 0;
      const b64 = await page.evaluate((binarizar) => {
        const img = document.getElementById("captcha-img");
        if (!img || !img.naturalWidth) return null;
        const esc = binarizar ? 3 : 1; // ampliar ayuda al OCR con glifos pequeños
        const c = document.createElement("canvas");
        c.width = img.naturalWidth * esc; c.height = img.naturalHeight * esc;
        const ctx = c.getContext("2d");
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, 0, 0, c.width, c.height);
        if (!binarizar) return c.toDataURL("image/png").split(",")[1];
        const d = ctx.getImageData(0, 0, c.width, c.height);
        const p = d.data;
        for (let i = 0; i < p.length; i += 4) {
          const gris = 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2];
          const v = gris < 128 ? 0 : 255;
          p[i] = p[i + 1] = p[i + 2] = v;
          p[i + 3] = 255;
        }
        ctx.putImageData(d, 0, 0);
        return c.toDataURL("image/png").split(",")[1];
      }, preprocesar);
      if (!b64) {
        console.log(`   ⚠️ la imagen del captcha no cargó (intento ${intento}/${INTENTOS_CAPTCHA})`);
        continue;
      }

      let solucion;
      try {
        solucion = await resolverCaptcha(b64);
      } catch (e) {
        await shot("error_capsolver");
        await browser.close();
        return { ok: false, error_code: "captcha", msg: `QualliGas: no se pudo resolver el captcha (${e.message}). No se emitió nada.` };
      }

      await page.evaluate((s) => {
        const e = document.getElementById("captchaInput");
        e.focus(); e.value = s;
        ["input", "change", "keyup"].forEach((x) => e.dispatchEvent(new Event(x, { bubbles: true })));
      }, solucion);
      await shot(`p3_captcha_${intento}`);

      // ── EL CLICK QUE PUEDE EMITIR ─────────────────────────────────────────
      const pulsado = await page.evaluate(() => {
        const b = Array.from(document.querySelectorAll("button, a, input[type=button], input[type=submit]"))
          .filter((x) => x.offsetParent)
          .find((x) => /^\s*aceptar\s*$/i.test((x.textContent || x.value || "").trim()));
        if (!b) return false;
        b.click();
        return true;
      });
      if (!pulsado) {
        await shot("error_sin_aceptar");
        await browser.close();
        return { ok: false, error_code: "reintentar_despues", msg: "QualliGas: no apareció el botón ACEPTAR del captcha. No se emitió nada." };
      }

      // Prueba de aceptación: el modal se cierra. Mientras siga abierto, el
      // captcha fue rechazado y NO se emitió nada — reintentar es seguro.
      captchaAceptado = await page.waitForFunction(
        () => {
          const i = document.getElementById("captchaInput");
          return !i || !i.offsetParent;
        }, { timeout: 25000 }
      ).then(() => true).catch(() => false);

      if (!captchaAceptado) {
        const aviso = await page.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 120)).catch(() => "");
        console.log(`   ⚠️ Captcha rechazado (intento ${intento}/${INTENTOS_CAPTCHA}): ${aviso.slice(0, 80)}`);
      }
    }

    if (!captchaAceptado) {
      await shot("error_captcha_rechazado");
      await browser.close();
      // Nada emitido: el portal nunca aceptó el captcha.
      //
      // Se devuelve `captcha` y NO `reintentar_despues` a propósito. Medido en
      // vivo sobre el ticket #357: CapSolver falló los 10 captchas que se le
      // dieron, con imagen cruda y binarizada, en dos corridas. No es mala
      // suerte: este captcha lleva una raya diagonal gruesa encima de glifos
      // manuscritos y distingue mayúsculas. `reintentar_despues` lo mandaría al
      // portal cada noche para siempre, quemando créditos de CapSolver sin
      // ninguna posibilidad de acertar. `captcha` para los reintentos y avisa de
      // que hay que facturarlo a mano, que es lo que de verdad toca.
      return {
        ok: false,
        error_code: "captcha",
        email_contacto: correoEstacion,
        msg: `QualliGas: el captcha de imagen no se puede resolver de forma automática (CapSolver falló ${INTENTOS_CAPTCHA} de ${INTENTOS_CAPTCHA}). NO se emitió nada. Para facturarlo a mano en estacion.qualligas.com → estación ${estacion}: Ticket ${numTicket}, Web ID ${web}, correo ${correo}. Plazo: hasta el último día del mes de la compra.`,
      };
    }
    timbradoDisparado = true;

    await page.waitForFunction(
      () => /factura\s+(generada|emitida|timbrada)|descarg|\.xml|\.pdf|captcha\s+(incorrect|inv)|error/i.test(document.body.innerText || ""),
      { timeout: 90000 }
    ).catch(() => {});
    await sleep(3000);
    await shot("p4_resultado");

    const res = await page.evaluate(() => ({
      texto: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 400),
      xml: (Array.from(document.querySelectorAll("a[href]")).find((a) => /\.xml|xml/i.test(a.href + a.textContent)) || {}).href || null,
      pdf: (Array.from(document.querySelectorAll("a[href]")).find((a) => /\.pdf|pdf/i.test(a.href + a.textContent)) || {}).href || null,
      uuid: ((document.body.innerHTML || "").match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) || [])[0] || null,
    })).catch(() => ({}));

    // Captcha mal resuelto: NO se emitió nada, así que reintentar es seguro y
    // además es lo correcto (CapSolver acierta la mayoría de las veces).
    if (/captcha\s+(incorrect|inv[aá]lid|err)/i.test(res.texto || "")) {
      await browser.close();
      return { ok: false, error_code: "reintentar_despues", msg: `QualliGas: el portal rechazó el captcha. No se emitió nada; reintentar es seguro. ${(res.texto || "").slice(0, 160)}` };
    }

    const bajar = async (u) => {
      if (!u) return null;
      const d = await page.evaluate(async (x) => {
        try {
          const r = await fetch(x, { credentials: "include" });
          const b = await r.arrayBuffer();
          return { ok: r.ok, bytes: Array.from(new Uint8Array(b)) };
        } catch (e) { return { error: e.message }; }
      }, u).catch(() => null);
      return d && d.ok && d.bytes?.length ? Buffer.from(d.bytes) : null;
    };
    const bufXml = await bajar(res.xml);
    const bufPdf = await bajar(res.pdf);
    await browser.close();

    const base = res.uuid || `qualligas_${ts}`;
    let xmlUrl = null, pdfUrl = null;
    try { if (bufXml) xmlUrl = await subirArchivoR2(bufXml, `facturas/${base}.xml`, "application/xml"); } catch {}
    try { if (bufPdf) pdfUrl = await subirArchivoR2(bufPdf, `facturas/${base}.pdf`, "application/pdf"); } catch {}

    if (xmlUrl || pdfUrl) {
      console.log(`✅ QualliGas OK — ${xmlUrl || pdfUrl}`);
      return { ok: true, xmlUrl, pdfUrl, uuid: res.uuid };
    }

    // Sin archivos: el portal también manda el CFDI al correo capturado, así que
    // IMAP lo recoge. Nunca se devuelve un error reintentable aquí: el click de
    // Aceptar ya salió y un reintento emitiría un segundo CFDI.
    return {
      ok: true, procesandoCorreo: true, uuid: res.uuid,
      msg: `QualliGas: se envió la solicitud (captcha aceptado)${res.uuid ? `, CFDI ${res.uuid}` : ""}. NO RELANZAR sin comprobar antes en ${`estacion.qualligas.com/${estacion}`} → DESCARGAR: puede estar ya emitido. Pantalla: ${(res.texto || "").slice(0, 160)}`,
    };
  } catch (err) {
    console.error("❌ QualliGas:", err.message);
    await shot("error").catch(() => {});
    try { await browser.close(); } catch {}
    if (timbradoDisparado) {
      return {
        ok: true, procesandoCorreo: true,
        msg: `QualliGas: el bot falló (${err.message}) DESPUÉS de pulsar Aceptar en el captcha. NO RELANZAR: comprobar primero en estacion.qualligas.com/${estacion} → DESCARGAR si el CFDI ya existe.`,
      };
    }
    return { ok: false, error_code: "reintentar_despues", msg: `QualliGas: ${err.message} (no se emitió nada)` };
  }
}

module.exports = { facturarQualligas };
