// Grupo CADISA "AutoFacturas RADEC" — la MISMA aplicación ASP.NET desplegada
// una vez por gasolinera, cada una en su propio DDNS:
//   rindemas.dyndns.org           SAN ÁNGEL   ES11321
//   rindemas2.dyndns.org:84       ABASTOS     ES11913
//   rindemas3.dyndns.org:85       CALZADA     ES04353
//   rindemas4.dyndns.org          REVOLUCIÓN  ES05566
//   rindemas5.dyndns.org:86       SAN KISSTOLO ES04310
//   rindemas6.dyndns.org:88       CEUS        ES14676
//   palov966facturas.ddns.net     PALO VERDE  ES9666
//   radecsalcido.dyndns.org       SUPER SERVICIO SALCIDO (Sonoyta, Son.) ES1821
// El catálogo de las seis "rindemas" está en www.rindemas.mx; las de otros
// dueños (Palo Verde, Salcido) publican el suyo en su propia web. SIN captcha.
// El de Salcido sale del <a> de www.gruposalcido.com.mx (el sitio impreso en el
// ticket) y es el único HTTPS del catálogo.
//
// ⚠️ NO todas las estaciones permiten el alta por web. Salcido pinta
// #btnAltaEmpresa con disabled="disabled" desde el servidor: hay que estar ya
// registrado ("SOLICITE SU FACTURA EN OFICINA … SI USTED YA SE ENCUENTRA
// REGISTRADO O UTILICE NUESTRA PAGINA", dice su propio ticket).
//
// Reconocimiento real (08-sep-2026, cuenta real GPN, dos tickets timbrados en
// vivo):
//   #323 San Kisstolo, folio 5032700 codigo 2259, $2,500.00 → factura SK123797
//   #340 Palo Verde,   folio 3846065 codigo 5459, $1,090.05 → factura Ai176479
//
// Flujo (ids idénticos en todos los despliegues):
//   1. autofactura.aspx → #txtRFC + #btnValidarRFC.
//   2. Si el RFC no está dado de alta EN ESA ESTACIÓN aparece "NO SE ENCONTRO
//      CLIENTE CON ESE RFC" y un #btnAltaEmpresa. El alta es solo de datos
//      fiscales del receptor (razón social, dirección, colonia, municipio,
//      estado, CP, régimen, RFC, email) — NO crea usuario ni contraseña.
//      ⚠️ Cada estación lleva su propio padrón: estar dado de alta en una NO
//      sirve para las demás.
//   3. Si ya está dado de alta, muestra la ficha para revisar y #btnDatosCorrectosContinuar
//      (o #btnDatosIncorrectosModificar). ⚠️ Los datos guardados pueden estar
//      MAL: en Palo Verde GPN tenía municipio "cajeme" (Sonora) siendo de
//      Culiacán, Sinaloa. Conviene corregirlos antes de timbrar — es la misma
//      clase de descuadre que provocó el rechazo CFDI40148 en LUGASA.
//   4. #txtNumMov (Folio del ticket) + #txtCodigoTicket (el "Codigo:" corto,
//      3-4 dígitos, NO el FolioCV) → #btnAgregarTicket, que pinta el renglón
//      con cantidad/producto/importe para cruzar contra el ticket.
//   5. #ddFormaPago + #ddUsoCFDi → #btnRealizarFactura → barra "Procesando por
//      favor espere..." → "SU FACTURA ES LA Factura: XXNNNNNN".
//
// ⚠️ LA FORMA DE PAGO TIENE QUE COINCIDIR CON LA QUE REGISTRÓ LA ESTACIÓN, no
// con la del voucher bancario. Los dos tickets traían voucher de tarjeta de
// débito, y elegir "Tarjeta de débito" devolvió "Atención Favor de Revisar la
// Forma de Pago ! Not valid!" en ambos. Los dos decían "VENTA DE CONTADO" en
// el ticket y con "Efectivo" timbraron a la primera. Por eso el bot intenta lo
// que dice el ticket y, si el portal lo rechaza, reintenta con Efectivo.
//
// Entrega: el PDF queda en una URL estable y predecible
//   {base}/FE-PDF/{YYYYMM}/{RFC_EMISOR}_S{SERIE}_{FOLIO8}_{RFC_RECEPTOR}.pdf
// que además aparece como src del <iframe> de la pantalla final. El XML NO
// tiene URL: solo sale por el postback de #btnXML, así que se captura de la
// respuesta HTTP. El portal manda además el CFDI al correo de la ficha del
// cliente (para GPN, carlosguerra@grupogpn.com) — NO al buzón de captura, así
// que no se puede depender de IMAP aquí.
const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Catálogo de despliegues conocidos. Se resuelve por número de estación o por
// nombre; si el ticket trae su propia URL, esa manda.
const ESTACIONES = [
  { base: "http://rindemas.dyndns.org", num: "11321", nombre: "SAN ANGEL" },
  { base: "http://rindemas2.dyndns.org:84", num: "11913", nombre: "ABASTOS" },
  { base: "http://rindemas3.dyndns.org:85", num: "04353", nombre: "CALZADA" },
  { base: "http://rindemas4.dyndns.org", num: "05566", nombre: "REVOLUCION" },
  { base: "http://rindemas5.dyndns.org:86", num: "04310", nombre: "SAN KISSTOLO" },
  { base: "http://rindemas6.dyndns.org:88", num: "14676", nombre: "CEUS" },
  { base: "http://palov966facturas.ddns.net", num: "9666", nombre: "PALO VERDE" },
  // Grupo Salcido (Sonoyta, Sonora). El ticket imprime www.gruposalcido.com.mx y
  // esa web publica el DDNS real (verificado en vivo 11-sep-2026: la portada del
  // portal dice "SUPER SERVICIO SALCIDO (SERV. SALCIDO) — Sonoyta, Sonora —
  // Tel.: 6515121091", los mismos datos que el ticket). Ojo: es HTTPS, no HTTP.
  { base: "https://radecsalcido.dyndns.org", num: "1821", nombre: "SALCIDO" },
];

function resolverBase({ portalUrl, estacion, comercio }) {
  const url = String(portalUrl || "");
  // Si el ticket trae directamente el DDNS del portal, se usa tal cual.
  const m = url.match(/^(https?:\/\/[^/]+)/i);
  if (m && /dyndns|ddns/i.test(m[1])) return m[1];
  const num = String(estacion || "").replace(/\D/g, "");
  if (num) {
    const e = ESTACIONES.find((x) => x.num.replace(/^0+/, "") === num.replace(/^0+/, ""));
    if (e) return e.base;
  }
  const t = `${comercio || ""} ${url}`.toUpperCase();
  const e = ESTACIONES.find((x) => t.includes(x.nombre));
  return e ? e.base : null;
}

async function facturarCadisa({
  folio, codigo, estacion, comercio, portalUrl, total, formaPago,
  rfc, razonSocial, codigoPostal, regimenFiscal, calle, ext, int: interior, colonia, municipio, estado, email, emailEntrega,
  ticketId,
}) {
  // El pipeline entrega calle / num_ext / num_int por separado (lib/facturacion.js),
  // pero este portal tiene UN solo campo "Dirección".
  const direccion = [calle, ext, interior ? `INT. ${interior}` : ""].filter(Boolean).join(" ").trim();
  const faltan = [];
  if (!String(folio || "").trim()) faltan.push('folio del ticket (la línea "Folio:")');
  if (!String(codigo || "").trim()) faltan.push('código del ticket (la línea "Codigo:", 3-4 dígitos — NO el FolioCV)');
  if (!rfc) faltan.push("RFC del receptor");
  if (faltan.length) {
    return { ok: false, error_code: "datos_invalidos", msg: `CADISA/RADEC: faltan datos — ${faltan.join(", ")}` };
  }

  const base = resolverBase({ portalUrl, estacion, comercio });
  if (!base) {
    return { ok: false, error_code: "datos_invalidos", msg: `CADISA/RADEC: no se pudo resolver el portal de la estación (${estacion || comercio || "sin dato"}). Cada gasolinera tiene su propio DDNS.` };
  }
  const PORTAL = `${base}/facturas/autofactura.aspx`;
  console.log("🤖 Iniciando bot CADISA/RADEC...");
  console.log(`   Portal: ${PORTAL}`);
  console.log(`   Folio: ${folio} | Código: ${codigo} | Total: ${total ?? "?"}`);

  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error("BROWSERLESS_TOKEN no definido");
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true`,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1000 });
  page.on("dialog", async (d) => { await d.accept().catch(() => {}); });

  let xmlBuf = null;
  page.on("response", async (resp) => {
    try {
      const ct = (resp.headers()["content-type"] || "").toLowerCase();
      const cd = (resp.headers()["content-disposition"] || "").toLowerCase();
      if (/xml/.test(ct) || /\.xml/.test(cd)) {
        const b = await resp.buffer();
        if (b && /<cfdi:Comprobante|<Comprobante/i.test(b.toString("utf8").slice(0, 2000))) xmlBuf = b;
      }
    } catch {}
  });

  const ts = ticketId || Date.now();
  async function screenshot(label) {
    try {
      const buf = await page.screenshot({ fullPage: true });
      const u = await subirArchivoR2(buf, `debug/cadisa_${ts}_${label}_${Date.now()}.png`, "image/png");
      console.log(`📸 [${label}]: ${u}`);
    } catch {}
  }
  const texto = () => page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
  const existe = (id) => page.evaluate((i) => !!document.getElementById(i), id);
  // Ojo: clickId() devuelve true aunque el boton este disabled (el .click() de un
  // input deshabilitado no hace nada y no lanza), asi que hay que preguntarlo
  // aparte. Ver el caso de SALCIDO mas abajo.
  const deshabilitado = (id) => page.evaluate((i) => {
    const e = document.getElementById(i);
    return !!e && (e.disabled === true || e.getAttribute("disabled") !== null);
  }, id);
  const clickId = (id) => page.evaluate((i) => { const e = document.getElementById(i); if (!e) return false; e.click(); return true; }, id);
  const escribir = (id, v) => page.evaluate((i, val) => {
    const e = document.getElementById(i);
    if (!e) return false;
    e.focus(); e.value = String(val);
    e.dispatchEvent(new Event("input", { bubbles: true }));
    e.dispatchEvent(new Event("change", { bubbles: true }));
    e.dispatchEvent(new Event("blur", { bubbles: true }));
    return true;
  }, id, v);
  const elegir = (id, patron) => page.evaluate((i, p) => {
    const s = document.getElementById(i);
    if (!s) return null;
    const o = Array.from(s.options).find((x) => new RegExp(p, "i").test(x.text));
    if (!o) return null;
    s.value = o.value;
    s.dispatchEvent(new Event("change", { bubbles: true }));
    return o.text;
  }, id, patron);
  // La pantalla final tarda: hay una barra de progreso real ("73% Procesando").
  async function esperarProceso(maxMs = 60000) {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      await sleep(2500);
      if (!/Procesando por favor espere/i.test(await texto())) return;
    }
  }

  // Se pone en true en cuanto sale el click que EMITE la factura. A partir de
  // ese instante ningun camino puede devolver un error reintentable: el
  // reintento de medianoche timbraria un SEGUNDO CFDI al mismo ticket.
  let timbradoDisparado = false;

  try {
    await page.goto(PORTAL, { waitUntil: "networkidle2", timeout: 45000 });
    await page.waitForSelector("#txtRFC", { timeout: 25000 });

    console.log("📋 RFC...");
    await escribir("txtRFC", rfc);
    await sleep(1000);
    await clickId("btnValidarRFC");
    await sleep(7000);

    if (await existe("btnAltaEmpresa")) {
      // No todas las estaciones dejan darse de alta desde la web. SALCIDO
      // (ES 1821, Sonoyta) devuelve el boton con disabled="disabled" y
      // class="aspNetDisabled" desde el SERVIDOR — es a proposito: el ticket
      // dice "SOLICITE SU FACTURA EN OFICINA … SI USTED YA SE ENCUENTRA
      // REGISTRADO O UTILICE NUESTRA PAGINA PARA FACTURARSE USTED MISMO". El
      // padron se da de alta en la estacion, no aqui. Sin esta comprobacion el
      // bot "pulsaba" el boton (clickId devuelve true igual), no pasaba nada y
      // el error que salia era el generico "no se llegó al formulario del
      // ticket", que no dice a nadie que hay que ir a darse de alta.
      if (await deshabilitado("btnAltaEmpresa")) {
        await screenshot("alta_deshabilitada");
        await browser.close();
        return {
          ok: false,
          error_code: "datos_invalidos",
          msg: `CADISA/RADEC: el RFC ${rfc} no está dado de alta en esta estación (${comercio || estacion || base}) y ESTA estación tiene el alta por web deshabilitada (${PORTAL}). Hay que registrar al cliente en la gasolinera (tel. del ticket) antes de poder autofacturar; el bot no puede darlo de alta solo.`,
        };
      }
      console.log("   RFC no registrado en esta estación — dándolo de alta...");
      await clickId("btnAltaEmpresa");
      await sleep(7000);
      await escribir("CRazonSocial", razonSocial || "");
      await escribir("CDireccion", direccion);
      await escribir("CColonia", colonia || "");
      await escribir("CCiudad", municipio || "");
      await elegir("CEstado", `^${String(estado || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
      await escribir("CCodigoPostal", codigoPostal || "");
      await elegir("ddRegimenFiscal", `^${String(regimenFiscal || "601")}`);
      await escribir("CRFC", rfc);
      // El CFDI tiene que llegar al BUZON DE CAPTURA, no al correo del
      // residente: si va a otro lado, la factura se emite y el ticket se
      // queda esperando. Paso con Casa Ley y La Parisina.
      await escribir("CEmail", emailEntrega || email || "");
      await sleep(1500);
      await clickId("btnDatosCorrectosContinuar");
      await sleep(9000);
    } else if (await existe("CCiudad")) {
      // Ficha existente: se corrige lo que esté mal antes de seguir (ver
      // cabecera — en Palo Verde el municipio decía "cajeme").
      const arreglos = await page.evaluate((mun, dir, correo) => {
        const cambios = [];
        const set = (id, val) => {
          const e = document.getElementById(id);
          if (!e || !val) return;
          if (String(e.value).trim().toUpperCase() === String(val).trim().toUpperCase()) return;
          cambios.push(`${id}: "${e.value}" → "${val}"`);
          e.focus(); e.value = val;
          e.dispatchEvent(new Event("input", { bubbles: true }));
          e.dispatchEvent(new Event("change", { bubbles: true }));
          e.dispatchEvent(new Event("blur", { bubbles: true }));
        };
        set("CCiudad", mun);
        set("CDireccion", dir);
        // Se corrige tambien el correo de la ficha: si quedo el del residente,
        // el CFDI se va a un buzon que el sistema no lee y el ticket se queda
        // esperando para siempre aunque la factura exista.
        set("CEmail", correo);
        return cambios;
      }, municipio || "", direccion, emailEntrega || "");
      if (arreglos.length) console.log(`   Datos fiscales corregidos → ${arreglos.join(" | ")}`);
      await sleep(1500);
      await clickId("btnDatosCorrectosContinuar");
      await sleep(9000);
    }

    if (!(await existe("txtNumMov"))) {
      await screenshot("sin_form_ticket");
      await browser.close();
      return { ok: false, msg: `CADISA/RADEC: no se llegó al formulario del ticket. Pantalla: ${(await texto()).slice(0, 200)}` };
    }

    console.log("🎫 Agregando ticket...");
    await escribir("txtNumMov", folio);
    await escribir("txtCodigoTicket", codigo);
    await sleep(800);
    await clickId("btnAgregarTicket");
    await sleep(9000);

    let t = await texto();
    const mTotal = t.match(/Total\s*\$\s*([\d,]+\.?\d*)/i);
    const totalPortal = mTotal ? parseFloat(mTotal[1].replace(/,/g, "")) : 0;
    if (!totalPortal) {
      await screenshot("ticket_no_cargo");
      await browser.close();
      if (/ya (ha sido |fue )?facturad/i.test(t)) return { ok: true, procesandoCorreo: true };
      return { ok: false, error_code: "datos_invalidos", msg: `CADISA/RADEC: el portal no cargó el consumo (folio ${folio}, código ${codigo}). Revisar que el código sea el de la línea "Codigo:" y no el FolioCV.` };
    }
    if (total && Math.abs(totalPortal - Number(total)) > 1) {
      await browser.close();
      return { ok: false, error_code: "datos_invalidos", msg: `CADISA/RADEC: el total del portal ($${totalPortal}) no coincide con el del ticket ($${total})` };
    }
    console.log(`   ✔ Total verificado: $${totalPortal}`);

    await elegir("ddUsoCFDi", "Gastos en general");
    // Ver cabecera: la forma de pago debe ser la que registró la estación. Se
    // intenta la del ticket y, si el portal la rechaza, se cae a Efectivo.
    const intentos = [];
    if (/credito|crédito/i.test(String(formaPago))) intentos.push("Tarjeta de cr[ée]dito");
    else if (/debito|débito|tarjeta/i.test(String(formaPago))) intentos.push("Tarjeta de d[ée]bito");
    if (!intentos.includes("^Efectivo$")) intentos.push("^Efectivo$");

    let exito = null;
    for (const patron of intentos) {
      const elegida = await elegir("ddFormaPago", patron);
      if (!elegida) continue;
      console.log(`🧾 Facturando con forma de pago "${elegida}"...`);
      await sleep(1500);
      // #btnRealizarFactura es un postback de ASP.NET: NAVEGA. Sin envolverlo en
      // el waitForNavigation, el texto() de abajo moria con "Execution context
      // was destroyed", la excepcion subia al catch y el catch pedia reintento
      // sobre una factura que ya podia estar timbrada — asi nace el duplicado.
      timbradoDisparado = true;
      const [, seDisparo] = await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle2", timeout: 90000 }).catch(() => {}),
        // Si el postback destruye el contexto antes de que vuelva el evaluate, el
        // click YA salio: eso cuenta como disparado.
        clickId("btnRealizarFactura").catch(() => true),
      ]);
      if (!seDisparo) {
        // clickId devuelve false cuando el boton no estaba en la pantalla: no se
        // envio nada. Se deshace la marca (si no, el ticket quedaria esperando a
        // una persona sin haberse pulsado nada) y se pide reintento.
        timbradoDisparado = false;
        await screenshot("sin_boton_realizar_factura");
        await browser.close();
        return { ok: false, error_code: "reintentar_despues", msg: `CADISA/RADEC: no apareció el botón "Realizar Factura" (folio ${folio}). NO se emitió nada.` };
      }
      await sleep(6000);
      await esperarProceso();
      t = await texto();
      if (/SU FACTURA ES LA/i.test(t)) { exito = t; break; }
      if (/Revisar la Forma de Pago/i.test(t)) {
        console.log("   ⚠️ el portal rechazó esa forma de pago — probando la siguiente");
        const cerroAviso = await page.evaluate(() => {
          const ok = Array.from(document.querySelectorAll("button,a,input")).find((e) => e.offsetParent && /^OK$/i.test((e.textContent || e.value || "").trim()));
          if (!ok) return false;
          ok.click();
          return true;
        });
        // Si el aviso no se cerro, el siguiente intento pulsa sobre un modal
        // abierto y no llega a enviar: mejor saberlo en el log que deducirlo.
        if (!cerroAviso) console.log("   ⚠️ no se encontró el OK del aviso; el siguiente intento puede no llegar a enviarse");
        await sleep(2500);
        continue;
      }
      break;
    }
    await screenshot("post_facturar");

    if (!exito) {
      await browser.close();
      // Esto devolvia {ok:false} SIN error_code aunque el click de "Realizar
      // Factura" ya hubiera salido: caia en el error generico, que reintenta a
      // medianoche y timbra un SEGUNDO CFDI al mismo ticket (hay que cancelarlo
      // ante el SAT). Con el click fuera no sabemos si la factura existe, asi
      // que se deja a la vista de una persona y NO se reintenta nunca.
      if (timbradoDisparado) {
        return {
          ok: false,
          error_code: "timbrado_sin_archivos",
          msg: `CADISA/RADEC: se pulsó "Realizar Factura" (folio ${folio}, código ${codigo}, $${totalPortal}) y la pantalla no confirmó el timbrado. NO RELANZAR: comprobar antes en ${PORTAL} si el CFDI ya existe. Pantalla: ${String(t).slice(-220)}`,
        };
      }
      // Aqui no se llego a pulsar nada (ninguna forma de pago del catalogo
      // coincidio con los patrones), asi que reintentar es seguro.
      return { ok: false, error_code: "reintentar_despues", msg: `CADISA/RADEC: no se llegó a pulsar "Realizar Factura" — ninguna forma de pago del catálogo coincidió. NO se emitió nada. Pantalla: ${String(t).slice(-220)}` };
    }
    const folioFactura = (exito.match(/Factura:\s*(\S+)/i) || [])[1] || null;
    const pdfUrl = await page.evaluate(() => {
      const f = Array.from(document.querySelectorAll("iframe")).map((x) => x.src).find((s) => /\.pdf/i.test(s || ""));
      return f || null;
    });
    console.log(`✅ Factura ${folioFactura}${pdfUrl ? ` — PDF ${pdfUrl}` : ""}`);

    console.log("⬇️ Pidiendo el XML...");
    xmlBuf = null;
    // El postback de btnXML tambien navega: si mata el contexto, el evaluate
    // RECHAZA y esa excepcion se llevaba al catch una factura YA confirmada en
    // pantalla, que acababa saliendo como "procesandoCorreo" sin folio ni PDF —
    // el peor desenlace para un CFDI que existe. El XML no se pierde por esto:
    // lo recoge el page.on("response") de arriba, no el valor del evaluate.
    await page.evaluate(() => { try { __doPostBack("btnXML", ""); } catch (e) {} }).catch(() => {});
    for (let i = 0; i < 10 && !xmlBuf; i++) await sleep(1800);
    // Mismo motivo: Browserless corta la sesion por su cuenta, y un close que
    // falla no puede tirar a la basura un timbrado ya confirmado (aqui el XML
    // puede estar ya descargado en xmlBuf).
    await browser.close().catch(() => {});

    if (!xmlBuf) {
      // Aqui el exito ya esta CONFIRMADO en pantalla ("SU FACTURA ES LA"): el
      // CFDI existe. Con "reintentar_despues" el sistema volvia cada noche y
      // emitia un duplicado por el mismo ticket. Solo falta el archivo, asi que
      // el ticket se queda a la vista de una persona y no se reintenta.
      return {
        ok: false,
        error_code: "timbrado_sin_archivos",
        msg: `CADISA/RADEC: la factura ${folioFactura} SÍ se timbró por $${totalPortal}${pdfUrl ? ` (PDF: ${pdfUrl})` : ""}, pero no se pudo capturar el XML. NO reintentar el bot (duplicaría el CFDI): el portal también lo envió por correo a ${email || "el correo de la ficha"}.`,
      };
    }
    const xmlUrl = await subirArchivoR2(xmlBuf, `facturas/cadisa_${ts}_${folioFactura}.xml`, "application/xml");
    console.log(`☁️ XML: ${xmlUrl}`);
    return { ok: true, xmlUrl, pdfUrl: pdfUrl || null };
  } catch (e) {
    await screenshot("excepcion");
    await browser.close().catch(() => {});
    // Si la excepcion salto DESPUES del click que emite, devolver un error
    // reintentable —o un {ok:false} pelado, que cae en el generico— haria que la
    // cola de medianoche timbrara el mismo ticket otra vez. "Execution context
    // was destroyed" es justo ese caso: el postback ya habia navegado.
    if (timbradoDisparado) {
      return {
        ok: true,
        procesandoCorreo: true,
        msg: `CADISA/RADEC: el click de "Realizar Factura" ya había salido cuando falló el bot (${e.message}). NO RELANZAR: comprobar antes en ${PORTAL} si el CFDI ya existe; el portal también lo manda por correo a ${emailEntrega || email || "el correo de la ficha"}.`,
      };
    }
    return { ok: false, error_code: "reintentar_despues", msg: `CADISA/RADEC: ${e.message}. NO se emitió nada.` };
  }
}

module.exports = { facturarCadisa, ESTACIONES };
