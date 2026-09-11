const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");

// Bot TUFESA — el formulario real vive en ventas.tufesa.com.mx (ASP.NET/jQuery),
// embebido vía iframe en tufesa.com.mx/facturacion. Flujo (Boletos de viaje):
//   CboTipoFact=Pasaje → #txtCod (folio) + #cboOrigen (ciudad) + #TxtFch (fecha)
//   + #txtRfc + #TxtCorreo/#txtCorroborarCorreo → #btnEnviar "SOLICITAR" → factura por correo.

async function fillInput(page, selector, value) {
  await page.click(selector).catch(() => {});
  await page.waitForTimeout(100);
  await page.evaluate((sel) => { const e = document.querySelector(sel); if (e) e.value = ""; }, selector);
  await page.type(selector, String(value), { delay: 50 }).catch(() => {});
  await page.waitForTimeout(100);
}

async function facturarTufesa({ folio, referencia, fecha, origen, rfc, ticketId }) {
  const folioVal = String(folio || referencia || "").trim();

  console.log("🤖 Iniciando bot TUFESA...");
  console.log(`   Folio: ${folioVal} | Origen: ${origen || "?"} | Fecha: ${fecha || "?"} | RFC: ${rfc}`);

  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error("BROWSERLESS_TOKEN no definido");

  let browser;
  try {
    browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  } catch (e) {
    return { ok: false, msg: `TUFESA: no se pudo conectar al browser — ${e.message}` };
  }

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");
  await page.setExtraHTTPHeaders({ "Accept-Language": "es-MX,es;q=0.9,en;q=0.8" });

  const ts = ticketId || Date.now();
  const snap = async (label) => {
    try {
      const buf = await page.screenshot({ fullPage: false });
      const u = await subirArchivoR2(buf, `debug/tufesa_${ts}_${label}_${Date.now()}.png`, "image/png");
      console.log(`📸 [${label}]: ${u}`);
    } catch {}
  };

  // Se pone en true en la línea inmediatamente anterior al click de SOLICITAR.
  // Desde ese instante la solicitud puede haber entrado, así que ningún camino
  // —ni siquiera el catch— puede devolver un error reintentable: el reintento de
  // medianoche pediría un SEGUNDO CFDI del mismo boleto y habría que cancelarlo
  // ante el SAT.
  let timbradoDisparado = false;

  try {
    console.log("🌐 Cargando portal TUFESA (SolicitarFactura.aspx)...");
    await page.goto("https://ventas.tufesa.com.mx/apw3/tufesa_es/SolicitarFactura.aspx", { waitUntil: "networkidle2", timeout: 35000 });
    await page.waitForTimeout(2500);
    await snap("p0_inicio");

    // ── Seleccionar "Boletos de viaje" (postback ASP.NET revela los campos) ──
    await page.waitForSelector("#CboTipoFact", { visible: true, timeout: 15000 });
    await page.select("#CboTipoFact", "Pasaje");
    await page.waitForTimeout(4500);
    await snap("p1_pasaje");

    const hayFolio = await page.waitForSelector("#txtCod", { visible: true, timeout: 10000 }).catch(() => null);
    if (!hayFolio) {
      await snap("error_sin_form");
      await browser.close();
      return { ok: false, msg: "TUFESA: no aparecieron los campos de facturación tras elegir el tipo" };
    }

    // ── Llenar campos ────────────────────────────────────────────────────────
    await fillInput(page, "#txtCod", folioVal);

    // Ciudad de origen (select) — fuzzy match contra el origen del ticket
    if (origen) {
      await page.evaluate((origenStr) => {
        const sel = document.querySelector("#cboOrigen");
        if (!sel) return;
        const norm = s => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
        const o = Array.from(sel.options).find(opt => norm(opt.text).includes(norm(origenStr)) || (norm(origenStr).length > 3 && norm(origenStr).includes(norm(opt.text))));
        if (o) { sel.value = o.value; sel.dispatchEvent(new Event("change", { bubbles: true })); }
      }, String(origen));
    }

    // Fecha (formato del ticket; ASP.NET suele aceptar DD/MM/YYYY)
    if (fecha) {
      await page.evaluate((f) => {
        const el = document.querySelector("#TxtFch");
        if (el) { el.removeAttribute("readonly"); el.value = f; ["input", "change", "blur"].forEach(ev => el.dispatchEvent(new Event(ev, { bubbles: true }))); }
      }, String(fecha));
    }

    await fillInput(page, "#txtRfc", rfc);
    await page.evaluate(() => {
      for (const id of ["#TxtCorreo", "#txtCorroborarCorreo"]) {
        const el = document.querySelector(id);
        if (el) { el.value = "buzonfacturas@serviciosga.site"; ["input", "change", "blur"].forEach(ev => el.dispatchEvent(new Event(ev, { bubbles: true }))); }
      }
    });
    await snap("p2_llenado");

    // ── Click SOLICITAR (ESTE ES EL CLICK QUE TIMBRA) ────────────────────────
    // Comprobar el botón ANTES evita esperar en balde la navegación del postback
    // cuando la pantalla ni siquiera lo tiene.
    if (!(await page.$("#btnEnviar"))) {
      await snap("error_sin_boton_enviar");
      await browser.close();
      return { ok: false, error_code: "reintentar_despues", msg: "TUFESA: no apareció el botón SOLICITAR (#btnEnviar). NO se emitió nada." };
    }

    console.log("🖱️ Click en SOLICITAR...");
    const urlAntes = page.url();
    // La pantalla de ANTES es la vara de medir del acuse: el mensaje de éxito de
    // TUFESA comparte palabras con el formulario vacío ("Correo electrónico" es la
    // etiqueta de #TxtCorreo), así que solo cuenta como prueba lo que aparece
    // DESPUÉS del click y no estaba ya ahí.
    const textoAntes = await page.evaluate(() => (document.body.innerText || "")).catch(() => null);

    // El postback de ASP.NET puede navegar: sin el waitForNavigation el evaluate
    // siguiente muere con "Execution context was destroyed", la excepción sube al
    // catch y el catch pedía reintento sobre una solicitud que YA había salido.
    timbradoDisparado = true;
    const [, clicEnviar] = await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 45000 }).catch(() => {}),
      // El evaluate DEVUELVE si encontró el botón. Antes hacía `if (b) b.click()`
      // y se tragaba el caso de no encontrarlo: el bot seguía hasta el return de
      // éxito y daba el boleto por facturado sin haber pulsado nada — así
      // quedaron dos tickets dados por facturados con cero facturas en el portal.
      page.evaluate(() => {
        const b = document.querySelector("#btnEnviar");
        if (!b) return false;
        b.click();
        return true;
      }),
    ]);

    if (!clicEnviar) {
      // El botón desapareció entre la comprobación y el click: no se envió nada,
      // así que el reintento es seguro y la bandera tiene que volver atrás.
      timbradoDisparado = false;
      await snap("error_sin_boton_enviar");
      await browser.close();
      return { ok: false, error_code: "reintentar_despues", msg: "TUFESA: no se pudo pulsar SOLICITAR (#btnEnviar desapareció). NO se emitió nada." };
    }

    await page.waitForTimeout(6000);
    await snap("p3_resultado");

    const body = await page.evaluate(() => (document.body.innerText || ""));
    if (/ya\s+(fue|est[aá]|ha\s+sido)\s+facturad|ya\s+facturad/i.test(body)) {
      await browser.close();
      return { ok: false, error_code: "ya_facturado", msg: "TUFESA: el boleto ya fue facturado" };
    }
    if (/no\s+(se\s+)?(encontr[oó]|existe)|no\s+v[aá]lid|incorrect|verifi|sin\s+resultado/i.test(body) &&
        !/enviad|correo electr|exitos|solicitud.*recib/i.test(body)) {
      await browser.close();
      return { ok: false, error_code: "datos_invalidos", msg: "TUFESA: boleto no encontrado — verifica folio, origen, fecha y RFC" };
    }

    // ── Señal POSITIVA de emisión ────────────────────────────────────────────
    // El ok:true de aquí abajo era el camino POR DEFECTO: se llegaba a él sin
    // haber comprobado nada, solo por no haber caído en una rama de error. "No
    // encontré la palabra error" no es prueba de que TUFESA aceptara la
    // solicitud; hace falta ver el acuse en pantalla (texto de éxito, folio/UUID,
    // enlace de descarga) o el salto a una pantalla de resultado.
    //
    // Las palabras del acuse son las que este repo tiene registradas para TUFESA
    // (docs/conocimiento-portales.json → mensaje_exito
    // /enviad|correo electr|exitos|solicitud.*recib/i), las mismas que la rama de
    // datos_invalidos de arriba usa para no confundir un acuse con un error. NO se
    // recortan a un fraseo más estrecho: exigir "solicitud … enviada" EN ESE ORDEN
    // rechazaba "Se ha enviado su factura al correo electrónico" y habría marcado
    // como fallidas facturas que SÍ salieron — el reverso exacto del bug original.
    const urlDespues = page.url();
    // `necesitaBase`: palabras que el formulario vacío TAMBIÉN puede llevar, así
    // que solo prueban algo si se pudo leer la pantalla anterior y no estaban ahí.
    // El UUID es el único que el formulario no puede tener por sí solo.
    const PATRONES_ACUSE = [
      { re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, necesitaBase: false }, // UUID / folio fiscal
      { re: /[^\n]{0,70}(enviad[oa]s?|envi[oó]|env[ií]o)[^\n]{0,70}/i, necesitaBase: true },
      { re: /[^\n]{0,70}(exitos|[eé]xito|recibid[oa]s?|generad[oa]s?|registrad[oa]s?|procesad[oa]s?)[^\n]{0,70}/i, necesitaBase: true },
      { re: /[^\n]{0,70}correo\s+electr[oó]nic[oa][^\n]{0,70}/i, necesitaBase: true },
      // Ojo con este: la etiqueta "Folio:" del formulario seguida de cualquier
      // palabra de 5 letras ya casa, porque /i hace que [A-Z0-9-] acepte minúsculas.
      { re: /folio\s*(fiscal|de\s+factura)?\s*[:#]\s*[A-Z0-9-]{5,}/i, necesitaBase: true },
      { re: /gracias[^.\n]{0,60}solicitud/i, necesitaBase: true },
    ];
    // Un patrón que YA casaba ANTES del click no prueba nada: es texto del propio
    // formulario, no el acuse. Sin este filtro la etiqueta "Correo electrónico"
    // de #TxtCorreo daría por buena una factura que nunca salió.
    let senalExito = null;
    for (const { re, necesitaBase } of PATRONES_ACUSE) {
      if (necesitaBase && (textoAntes === null || re.test(textoAntes))) continue;
      const m = body.match(re);
      if (m) { senalExito = m[0].trim().replace(/\s+/g, " "); break; }
    }
    if (!senalExito) {
      // Un `a[href*=".pdf"]` a secas daba por emitida la factura con el
      // "aviso de privacidad.pdf" del pie: el enlace tiene que oler a CFDI.
      const enlace = await page.evaluate(() => {
        const a = Array.from(document.querySelectorAll("a[href]")).find((x) =>
          /\.xml(\?|$)/i.test(x.href) ||
          x.hasAttribute("download") ||
          (/\.pdf(\?|$)/i.test(x.href) && /factura|cfdi|comprobante|descarg/i.test(`${x.textContent} ${x.href}`)));
        return a ? a.getAttribute("href") : null;
      }).catch(() => null);
      if (enlace) senalExito = `enlace de descarga: ${enlace}`;
    }

    // El postback de ASP.NET responde en la MISMA URL, así que comparar urls casi
    // nunca detecta el acuse; que el formulario haya desaparecido sí lo detecta:
    // significa que el portal pintó la pantalla de resultado en su lugar.
    const formularioSigueEnPie = !!(await page.$("#btnEnviar"));
    const cambioPantalla = urlDespues !== urlAntes || !formularioSigueEnPie;

    if (!senalExito && !cambioPantalla) {
      const pantalla = body.replace(/\s+/g, " ").slice(0, 240);
      await snap("error_sin_confirmacion");
      await browser.close();
      // Ojo: el click SÍ salió, así que la solicitud puede haber entrado. Un
      // error reintentable aquí pediría un segundo CFDI del mismo boleto; por eso
      // va un código que NO reintenta y deja el ticket a la vista de una persona.
      return {
        ok: false,
        error_code: "timbrado_sin_archivos",
        msg: `TUFESA: se pulsó SOLICITAR pero la pantalla no confirmó la emisión. NO RELANZAR: comprobar antes en el portal / en el correo si el CFDI ya existe. Pantalla: ${pantalla}`,
      };
    }

    // Éxito confirmado: la factura se envía al correo → IMAP la captura
    const prueba = senalExito
      || (urlDespues !== urlAntes ? `pantalla de resultado ${urlDespues}` : "el formulario dio paso a la pantalla de resultado");
    console.log(`✅ TUFESA: solicitud confirmada (${prueba}) — factura por correo (IMAP)`);
    await browser.close();
    return { ok: true, procesandoCorreo: true, msg: `TUFESA: solicitud aceptada — ${prueba}. La factura llega por correo (IMAP).` };

  } catch (err) {
    console.error("❌ Error en bot TUFESA:", err.message);
    await snap("error").catch(() => {});
    try { await browser.close(); } catch {}
    // Si la excepción saltó DESPUÉS del click que emite, devolver un error sería
    // peor que no devolver nada: la cola reintentaría a medianoche y TUFESA
    // timbraría un segundo CFDI del mismo boleto. "Execution context was
    // destroyed" es justo eso — el postback del botón navegó.
    if (timbradoDisparado) {
      return {
        ok: true,
        procesandoCorreo: true,
        msg: `TUFESA: el click de SOLICITAR ya había salido cuando falló el bot (${err.message}). NO RELANZAR: comprobar antes en el portal / en el buzón si el CFDI ya existe.`,
      };
    }
    // Antes de pulsar SOLICITAR no se emitió nada: aquí el reintento es lo correcto,
    // pero explícito — un {ok:false} sin error_code reintenta igual y oculta el motivo.
    return { ok: false, error_code: "reintentar_despues", msg: `TUFESA: falló antes de enviar la solicitud (${err.message}). No se emitió nada.` };
  }
}

module.exports = { facturarTufesa };
