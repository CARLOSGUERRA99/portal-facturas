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
  folio, fecha, hora, estacion, ciudad, comercio, total, formaPago,
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
  const WS = `wss://production-sfo.browserless.io?token=${token}&stealth=true`;
  // `browser` y `page` son `let` A PROPOSITO: el barrido de plazas agota la
  // sesion de Browserless y hay que reconectar entera (ver reconectar()).
  let browser = await puppeteer.connect({ browserWSEndpoint: WS });
  let page = await browser.newPage();
  const prepararPagina = async () => {
    await page.setViewport({ width: 1280, height: 1100 });
    page.on("dialog", async (d) => { await d.accept().catch(() => {}); });
  };
  await prepararPagina();

  // 🛑 Reconexion COMPLETA, no page.close()+newPage() ni page.goto().
  // Comprobado el 11-sep-2026 con el ticket #386: tras recorrer las 15 plazas,
  // la sesion de Browserless queda inservible y CUALQUIER operacion posterior
  // tira "Requesting main frame too early!". Se probo y NO basta con:
  //   · page.goto(PORTAL_URL) de nuevo      → mismo error
  //   · page.close() + browser.newPage()    → mismo error
  // Lo unico que funciona es cerrar el browser y volver a conectar. Este es el
  // "bloqueante de Browserless" que quedo anotado como no resuelto: no era el
  // select de sucursal (#A14) en si, era la racha de postbacks del barrido.
  async function reconectar() {
    await browser.close().catch(() => {});
    browser = await puppeteer.connect({ browserWSEndpoint: WS });
    page = await browser.newPage();
    await prepararPagina();
  }

  const ts = ticketId || Date.now();
  async function screenshot(label) {
    try {
      const buf = await page.screenshot({ fullPage: true });
      const u = await subirArchivoR2(buf, `debug/grupocentra_${ts}_${label}_${Date.now()}.png`, "image/png");
      console.log(`📸 [${label}]: ${u}`);
    } catch {}
  }
  // Devuelve "" en vez de reventar si la pagina esta navegando justo en ese
  // instante: en GeneXus cada boton provoca un postback y leer el DOM en mitad
  // del cambio tiraba todo el bot con "Execution context was destroyed".
  const texto = () =>
    page.evaluate(() => document.body.innerText.replace(/\s+/g, " ")).catch(() => "");
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

  // Se pone en true en la linea inmediatamente anterior al click que EMITE
  // (#A40). Desde ese instante NINGUN camino —tampoco el catch— puede devolver
  // reintentar_despues ni un {ok:false} sin error_code: este portal no se
  // protege de duplicados (ver cabecera), asi que el reintento de medianoche
  // entraria, "Cargar" traeria el consumo como si nada y se emitiria un SEGUNDO
  // CFDI al mismo ticket, que luego hay que cancelar ante el SAT.
  let timbradoDisparado = false;
  // Folio Y serie del mensaje de exito: la unica prueba fiable de que se timbro
  // y lo unico con lo que se recupera la factura despues (Reimpresiones exige
  // los dos, y la serie es por estacion). Viven fuera del try para que el catch
  // pueda distinguir "ya timbrado" de "no llego a timbrarse".
  let folioFactura = null;
  let serieFactura = null;

  // Abre "Facturar GAS" y deja los datos fiscales cargados. Se llama una vez al
  // principio y OTRA VEZ antes de elegir la sucursal por nombre: ver el aviso
  // sobre "Requesting main frame too early" mas abajo.
  async function abrirFormulario() {
    await page.goto(PORTAL_URL, { waitUntil: "networkidle2", timeout: 45000 });
    await sleep(3500);
    if (!(await clickId("M16"))) return { err: 'Grupo Centra: no apareció el botón "Facturar GAS" (#M16) — el portal pudo haber cambiado sus ids de GeneXus' };
    await sleep(5000);
    await escribir("A4", rfc);
    await sleep(1200);
    await clickId("A1");
    await sleep(7000);
    const r = await valor("A3");
    if (!r) return { err: `Grupo Centra: el portal no tiene registrado el RFC ${rfc} (no autocompletó la razón social). Hay que darlo de alta con "Registrate aqui..." una vez.`, code: "datos_invalidos" };
    return { razon: r };
  }

  try {
    console.log("📋 RFC → Buscar...");
    const apertura = await abrirFormulario();
    if (apertura.err) {
      await screenshot(apertura.code ? "rfc_sin_datos" : "sin_boton_facturar_gas");
      await browser.close();
      return { ok: false, ...(apertura.code ? { error_code: apertura.code } : {}), msg: apertura.err };
    }
    console.log(`   Receptor: ${apertura.razon}`);

    // La sucursal solo se puede elegir tras cargar su ciudad. Si el ticket no
    // dice la ciudad se recorren todas hasta encontrar la estación.
    //
    // ⚠️ NO SE PUEDE BUSCAR SOLO POR "#NNNNN". El rótulo de la sucursal tiene
    // la forma "NOMBRE - PERMISO #NUM - (DIRECCION)", pero en varias estaciones
    // el portal deja el número VACÍO y el rótulo queda literalmente "... # -".
    // Comprobado el 11-sep-2026 recorriendo las 15 plazas: CABORCA tiene cinco
    // así (CALABAZAS, COYOTE, DORADO, SANTA CECILIA, TUCANES) y también están
    // PROGRESO (Hermosillo), NOGALES INTERNACIONAL y UNIVERSIDAD (Tecate). Con
    // esas, buscar por número no falla por "la estación no existe": es que el
    // portal no imprime el número, así que NINGÚN patrón numérico puede
    // acertar. Por eso hay un segundo intento por NOMBRE contra el comercio del
    // ticket ("E.S. 07056 EL COYOTE" → sucursal "COYOTE" de CABORCA).
    //
    // ⚠️ Y EL NÚMERO VA SIN CEROS A LA IZQUIERDA. El ticket imprime
    // "E.S. 07056" pero el portal lista "#7056"; buscar "#07056" no encuentra
    // nada. Se prueban las dos formas.
    const estacionSinCeros = estacionNum.replace(/^0+/, "") || estacionNum;
    // Nombre = lo que va antes del primer " - ". Se normaliza sin acentos para
    // poder compararlo con el comercio del ticket.
    // \p{M} = marcas combinantes. Se escribe asi, y no con un rango literal de
    // caracteres combinantes, para que el fichero siga siendo ASCII puro en esta
    // linea: un rango literal es invisible en el editor y cualquier reencoding
    // lo destroza en silencio.
    const norm = (s) => String(s || "").normalize("NFD").replace(/\p{M}/gu, "").toUpperCase();
    const comercioNorm = norm(comercio);

    const ciudades = ciudad
      ? [ciudad]
      : await page.evaluate(() => {
          const s = document.getElementById("A15");
          return s ? Array.from(s.options).map((o) => o.text.trim()).filter((t) => t && !/SELECCIONE/i.test(t)) : [];
        });

    let sucursal = null;
    let ciudadElegida = null;
    // Candidatas por nombre. Se recogen TODAS antes de elegir ninguna: si dos
    // plazas distintas tuvieran una sucursal con el mismo nombre, adivinar
    // sería emitir un CFDI contra la estación equivocada. Ante la duda, aborta.
    const porNombre = [];

    for (const c of ciudades) {
      const elegida = await elegir("A15", `^${c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
      if (!elegida) continue;
      await sleep(6000);

      // 1º intento: por número de estación (sin y con ceros a la izquierda).
      sucursal = await elegir("A14", `#${estacionSinCeros}\\b`);
      if (!sucursal && estacionSinCeros !== estacionNum) {
        sucursal = await elegir("A14", `#${estacionNum}\\b`);
      }
      if (sucursal) { ciudadElegida = elegida; break; }

      // 2º intento (se decide al final): por nombre de la sucursal.
      const opts = await page.evaluate(() => {
        const s = document.getElementById("A14");
        return s ? Array.from(s.options).map((o) => ({ value: o.value, text: o.text.trim() })) : [];
      });
      for (const o of opts) {
        if (!o.text || /SELECCIONE/i.test(o.text)) continue;
        const nombre = norm(o.text.split(" - ")[0]).trim();
        // Se exige palabra completa para que "DORADO" no case con "EL DORADITO"
        // ni "COYOTE" dentro de otra palabra.
        if (nombre.length >= 4 && new RegExp(`(^|[^A-Z0-9])${nombre.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Z0-9]|$)`).test(comercioNorm)) {
          porNombre.push({ ciudad: elegida, value: o.value, text: o.text });
        }
      }
    }

    if (!sucursal && porNombre.length === 1) {
      const cand = porNombre[0];
      console.log(`   Estación #${estacionNum} sin número en el portal; localizada por nombre: ${cand.text.slice(0, 60)}`);
      // 🛑 RECONEXIÓN ANTES DE SEGUIR (ver reconectar()): un barrido largo deja
      // la sesión de Browserless muerta y el siguiente postback reventaría con
      // "Requesting main frame too early!".
      //
      // Excepción: si sólo se recorrió UNA plaza (porque el ticket traía la
      // ciudad), no hubo ráfaga de postbacks, la sesión está sana y esa plaza
      // ya es la que está seleccionada — se elige la sucursal y punto. Esto
      // ahorra ~40 s y una reconexión en el camino bueno.
      if (ciudades.length > 1) {
        await reconectar();
        const re = await abrirFormulario();
        if (re.err) {
          await screenshot("recarga_fallida");
          await browser.close();
          return { ok: false, ...(re.code ? { error_code: re.code } : {}), msg: re.err };
        }
        await elegir("A15", `^${cand.ciudad.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
        await sleep(7000);
      }
      // Tras recargar, los `value` del <select> pueden renumerarse: se vuelve a
      // localizar por el RÓTULO exacto, que sí es estable.
      const ok = await page.evaluate((t) => {
        const s = document.getElementById("A14");
        if (!s) return null;
        const o = Array.from(s.options).find((x) => x.text.trim() === t);
        if (!o) return null;
        s.value = o.value;
        s.dispatchEvent(new Event("change", { bubbles: true }));
        return o.text;
      }, cand.text);
      if (ok) { sucursal = ok; ciudadElegida = cand.ciudad; }
    }

    if (!sucursal) {
      await screenshot("sin_sucursal");
      await browser.close();
      const detalle = porNombre.length > 1
        ? ` Hay ${porNombre.length} sucursales cuyo nombre encaja con "${comercio}" (${porNombre.map((p) => `${p.ciudad}/${p.text.split(" - ")[0]}`).join(", ")}) y no se puede adivinar cuál: hay que pasar la ciudad en el ticket.`
        : ` Ni por número (#${estacionSinCeros}) ni por nombre a partir del comercio "${comercio || "(vacío)"}".`;
      return { ok: false, error_code: "datos_invalidos", msg: `Grupo Centra: la estación #${estacionNum} no aparece en ninguna ciudad del portal.${detalle}` };
    }
    console.log(`   Ciudad: ${ciudadElegida} | Sucursal: ${sucursal.slice(0, 60)}`);
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
    // ⚠️ ESTE CLICK NAVEGA. Sin esperar la navegacion, el page.evaluate que
    // sigue revienta con "Execution context was destroyed" — y el click YA
    // salio, asi que la factura queda emitida mientras el bot reporta
    // excepcion. Es la peor combinacion posible en ESTE portal, que (ver
    // cabecera) no se protege de duplicados: invita a reintentar y a emitir
    // un segundo CFDI. Paso con el ticket #353 el 11-sep-2026.
    timbradoDisparado = true;
    const [, clicFacturar] = await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }).catch(() => {}),
      // Si el evaluate DEL PROPIO CLICK muere con "Execution context was
      // destroyed" es justamente porque el click ya salio y navego (le paso al
      // #353). Sin este catch esa excepcion se lleva por delante el bucle que
      // lee folio y serie: la factura se emite bien y el bot la entrega como
      // timbrado_sin_archivos, o sea revision manual en CADA factura buena.
      // Con el catch, `false` significa una sola cosa: #A40 no estaba en el DOM.
      clickId("A40").catch(() => true),
    ]);
    // clickId devuelve false si #A40 no esta en el DOM (GeneXus renumera todos
    // los ids si el proveedor redespliega). Entonces no salio ninguna peticion
    // de timbrado, y este es el ULTIMO punto donde se puede reintentar sin
    // riesgo. Dar por pulsado un boton sin comprobar que existia fue el bug que
    // dejo los tickets #349 y #356 dados por facturados con cero facturas en el
    // portal.
    if (!clicFacturar) {
      timbradoDisparado = false;
      await screenshot("sin_boton_facturar");
      await browser.close();
      return { ok: false, error_code: "reintentar_despues", msg: 'Grupo Centra: no apareció el botón "Facturar" (#A40) — NO SE EMITIÓ NADA (los ids de GeneXus pudieron cambiar)' };
    }
    let exito = "";
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      await sleep(2500);
      const t = await texto();
      // Gener[oó]: la unica transcripcion que existe del mensaje (portales.json,
      // reconocimiento del 08-sep) esta escrita sin acentos, igual que el resto
      // de esa nota, asi que no consta si el portal pinta "Genero" o "Generó".
      // Apostar por el sin-tilde ahora cuesta caro: si no casa ya no se
      // reintenta —se devuelve timbrado_sin_archivos— y cada factura bien
      // emitida acabaria en revision manual. Aceptar las dos formas no afloja la
      // prueba: se siguen exigiendo folio Y serie. redco.js hace lo mismo.
      const m = t.match(/La Factura folio\s+(\S+)\s+serie\s+(\S+)\s+se Gener[oó] Exitosamente/i);
      if (m) { exito = t; folioFactura = m[1]; serieFactura = m[2]; break; }
      if (/error|no se pudo|fall/i.test(t) && !/NECESITAS AYUDA/i.test(t)) break;
    }
    await screenshot("p2_post_facturar");
    if (!exito) {
      // 🛑 Aqui el click de "Facturar" YA SALIO: que no hayamos leido el mensaje
      // de exito no significa que no se haya timbrado (pudo tardar mas de 60 s,
      // cambiar el texto o quedarse el bot en otra pantalla). Este return no
      // llevaba error_code, o sea que caia en el error generico y el sistema lo
      // reintentaba a medianoche; en ESTE portal eso no es hipotetico: no hay
      // ningun "ya ha sido facturado" que frene al bot, "Cargar" vuelve a traer
      // el consumo y se emite un SEGUNDO CFDI al mismo ticket.
      // timbrado_sin_archivos es el unico codigo correcto: no reintenta jamas y
      // deja el ticket a la vista de una persona, que es quien puede comprobar
      // si la factura existe.
      const pantalla = (await texto()).slice(0, 220);
      await browser.close();
      return {
        ok: false,
        error_code: "timbrado_sin_archivos",
        msg: `Grupo Centra: el click de "Facturar" SÍ salió pero el portal no confirmó el timbrado en 60 s — EL CFDI PUEDE EXISTIR YA. NO RELANZAR el bot: este portal deja emitir dos veces el mismo ticket sin avisar. Comprobar a mano (estación #${estacionNum}, ticket ${folio}, ${fecha} ${hora}) y, si existe, bajarla de Reimpresiones con su folio Y SU SERIE y asociarla con scripts/asociar-cfdi.js. Pantalla: ${pantalla}`,
      };
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
    // Misma duda de acento que en el mensaje de timbrado. Aqui equivocarse solo
    // degrada el mensaje (se devuelve ok:true igual, con folio y serie), pero no
    // hay motivo para arriesgar un "no se confirmo el envio" que no es cierto.
    const enviado = /correo fue enviado con [eé]xito/i.test(await texto());
    await screenshot("p3_post_envio");
    await browser.close();

    // folioGenerado es el campo que lib/facturacion.js conserva en error_msg al
    // pasar a procesando_correo. Sin el, si el correo no llega, la factura es
    // IRRECUPERABLE: Reimpresiones pide folio Y serie, y la serie es por
    // estacion (buscar con la de otra no encuentra nada aunque el CFDI exista).
    const rastro = `${folioFactura} serie ${serieFactura}`;
    if (!enviado) {
      console.log("⚠️ Timbrada pero no se confirmó el envío por correo");
      return { ok: true, procesandoCorreo: true, folioGenerado: rastro, msg: `Grupo Centra: CFDI timbrado (folio ${folioFactura} serie ${serieFactura}); el envío al buzón no se confirmó — NO RELANZAR el bot (emitiría un duplicado): reenviarlo desde Reimpresiones con esos datos` };
    }
    return { ok: true, procesandoCorreo: true, folioGenerado: rastro };
  } catch (e) {
    await screenshot("excepcion");
    await browser.close().catch(() => {});
    // El catch tambien cuenta: devolver aqui un {ok:false} pelado lo mandaba al
    // error generico, que reintenta a medianoche. Si la excepcion salto despues
    // del click de #A40 —y "Execution context was destroyed" salta justo por
    // eso, porque el click navego— ese reintento emite el duplicado.
    if (folioFactura) {
      // Timbrado CONFIRMADO (leimos folio y serie): la excepcion es del paso de
      // Reimpresiones/envio, que pudo salir igual. Se deja en procesando_correo
      // con el rastro para recuperarla a mano si el correo no llega.
      return {
        ok: true,
        procesandoCorreo: true,
        folioGenerado: `${folioFactura} serie ${serieFactura}`,
        msg: `Grupo Centra: el CFDI folio ${folioFactura} serie ${serieFactura} YA ESTÁ TIMBRADO; falló el paso de envío al buzón (${e.message}). NO RELANZAR el bot: reenviar la factura desde Reimpresiones con ese folio y esa serie.`,
      };
    }
    if (timbradoDisparado) {
      return {
        ok: false,
        error_code: "timbrado_sin_archivos",
        msg: `Grupo Centra: el click de "Facturar" ya había salido cuando falló el bot (${e.message}) — EL CFDI PUEDE EXISTIR YA. NO RELANZAR: el portal no avisa de duplicados y emitiría un segundo CFDI. Comprobar antes a mano si la factura del ticket ${folio} (estación #${estacionNum}, ${fecha} ${hora}) existe.`,
      };
    }
    return { ok: false, error_code: "reintentar_despues", msg: `Grupo Centra: ${e.message} — falló antes de pulsar "Facturar", NO SE EMITIÓ NADA` };
  }
}

module.exports = { facturarGrupoCentra };
