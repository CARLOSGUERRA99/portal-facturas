// Autopista Tijuana–Tecate (Grupo IDEAL) — "Kiosco Facturación"
// https://www.facturaciontij-tkt.com.mx/facturacion — Angular Material, sin login.
//
// ⚠️ NO ES PINFRA. El ticket #393 llevaba semanas fallando con «"Tijuana-Tecate"
// no está entre sus 26 autopistas» porque el OCR lo dedujo como PINFRA por ser
// una caseta. Es de Grupo IDEAL y tiene portal propio.
//
// ⚠️ PLAZO CORTO — mirarlo ANTES de nada. El propio portal avisa: "Solo se
// podrán emitir facturas (CFDI) de los tickets por peaje durante el mes en
// curso y el primer día natural del siguiente mes". Un ticket de septiembre
// muere el 1 de octubre, no a los 30 días.
//
// Reconocimiento en vivo del 13-sep-2026 con el ticket #393. Lo que se midió:
//
//  - ⚠️ LOS DOS DESPLEGABLES NO SE LLAMAN COMO UNO ESPERA. El que dice
//    "Entronque" es la AUTOPISTA (TIJUANA - TECATE / PASO DEL AGUILA /
//    ESPERANZAS / PASO DEL AGUILA BIS) y el que dice "Carril" es el código de
//    carril (1001A, 1009A, 1010B…). Los dos están impresos en el ticket: la
//    autopista en el encabezado y el carril en "Carril:". El segundo se puebla
//    por AJAX al elegir el primero, así que hay que esperar entre uno y otro.
//
//  - ⚠️ "Cantidad pagada" pide el MONTO SIN DECIMALES (el propio campo lo dice).
//    168, no 168.00 — con decimales no encuentra el ticket.
//
//  - Fecha-Hora en un solo campo, formato DD/MM/YYYY HH:MM:SS.
//
//  - "Agregar ticket" NO factura: mete el cruce en una tabla y saca el aviso
//    "Ticket agregado, puede agregar mas tickets". Recién entonces aparece la
//    sección "Datos de Facturación" y se habilita el botón "Facturar".
//    La fila tiene un botón "delete" para soltarla si algo falla a medias.
//
//  - Los ids son de Angular Material (mat-input-N) y son POSICIONALES: si el
//    portal añade un campo, se corren todos. Por eso aquí los controles se
//    buscan por su <mat-label>, no por id.
const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");

const URL_PORTAL = "https://www.facturaciontij-tkt.com.mx/facturacion";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// DD/MM/YYYY + HH:MM:SS → "07/09/2026 14:28:33"
function fechaHoraPortal(fecha, hora) {
  const s = String(fecha || "").trim();
  let dmy = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (!dmy) {
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!iso) return null;
    dmy = [null, iso[3], iso[2], iso[1]];
  }
  const h = String(hora || "").match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!h) return null;
  return `${dmy[1]}/${dmy[2]}/${dmy[3]} ${String(h[1]).padStart(2, "0")}:${h[2]}:${h[3] || "00"}`;
}

// Se inyecta en la página: localiza controles por el texto de su <mat-label> y
// escribe con el setter nativo + eventos, que es lo que Angular escucha.
const HELPERS = `
  window.__k = {
    campo(etiqueta) {
      const norm = (s) => (s || '').normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase();
      const objetivo = norm(etiqueta);
      for (const w of document.querySelectorAll('.mat-form-field')) {
        const l = w.querySelector('mat-label, label');
        if (!l) continue;
        if (norm(l.innerText).startsWith(objetivo)) {
          const c = w.querySelector('input, select, textarea');
          if (c && c.offsetParent) return c;
        }
      }
      return null;
    },
    set(el, v) {
      const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    },
    // Elige una opcion por TEXTO o por VALUE. Hacen falta las dos vias: en
    // "Entronque"/"Carril" el dato del ticket es el texto (TIJUANA - TECATE,
    // 1009A) y el value es un id interno (2001, 112); en "Uso de CFDI" es al
    // reves — el value es G03 y el texto "Gastos en general.", asi que buscar
    // solo por texto lo dejaba sin seleccionar.
    opcionPorTexto(el, texto) {
      const norm = (s) => (s || '').normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase().replace(/\\s+/g, ' ').trim();
      const q = norm(texto);
      const ops = Array.from(el.options);
      const o = ops.find((x) => norm(x.text) === q)
             || ops.find((x) => norm(x.value) === q)
             || ops.find((x) => norm(x.text).includes(q))
             || ops.find((x) => norm(x.value).includes(q));
      if (!o) return null;
      window.__k.set(el, o.value);
      return o.text.trim();
    },
    boton(texto) {
      const re = new RegExp(texto, 'i');
      return Array.from(document.querySelectorAll('button')).find((b) => b.offsetParent && re.test(b.innerText || '')) || null;
    },
    // ⚠️ Hay que mirar TAMBIEN los mat-dialog: el acuse de exito ("Factura
    // generada correctamente") sale en un MODAL, no en el snackbar. Mirando
    // solo snackbar/mat-error el bot daba por fallida una factura ya emitida
    // — falso negativo, que es casi tan malo como el falso positivo: deja el
    // ticket en error y el siguiente intento emitiria un duplicado.
    avisos() {
      return Array.from(document.querySelectorAll(
        '[role=alert], .mat-snack-bar-container, mat-error, .mat-error, mat-dialog-container, .mat-dialog-container, [role=dialog]'))
        .map((e) => (e.innerText || '').trim().slice(0, 300)).filter(Boolean);
    },
  };
`;

async function facturarTijuanaTecate({
  folio, carril, autopista, comercio,
  fecha, fechaPago, hora,
  total, importe,
  rfc, razonSocial, codigoPostal, regimenFiscal, usoCfdi,
  emailEntrega, ticketId, dryRun,
}) {
  console.log("🤖 Iniciando bot Tijuana–Tecate (Kiosco Grupo IDEAL)...");

  // ⚠️ El folio va TAL CUAL, con sus ceros a la izquierda (0000360201): así se
  // probó a mano y así lo aceptó el portal. La tabla luego lo muestra sin ellos,
  // pero eso es cosa suya — quitárselos nosotros es pedirle otro ticket.
  const folioLimpio = String(folio || "").replace(/[^0-9]/g, "");
  const carrilLimpio = String(carril || "").trim().toUpperCase();
  const fh = fechaHoraPortal(fecha || fechaPago, hora);
  // ⚠️ El portal pide el monto SIN DECIMALES.
  const monto = Math.round(parseFloat(total != null ? total : importe));
  // El ticket imprime la autopista en el encabezado; el select la llama "Entronque".
  const via = String(autopista || comercio || "TIJUANA - TECATE").toUpperCase();
  const seco = dryRun || process.env.TIJTKT_DRY_RUN || null;

  console.log(`   Folio: ${folioLimpio} | Carril: ${carrilLimpio} | ${fh} | $${monto} | Vía: ${via}${seco ? ` | 🧪 DRY RUN (${seco})` : ""}`);

  const faltan = [];
  if (!folioLimpio) faltan.push("folio");
  if (!carrilLimpio) faltan.push("carril");
  if (!fh) faltan.push("fecha+hora");
  if (!Number.isFinite(monto) || monto <= 0) faltan.push("total");
  if (faltan.length) {
    return { ok: false, error_code: "datos_invalidos", msg: `Tijuana-Tecate: el portal pide autopista, carril, folio, fecha-hora y monto; falta(n): ${faltan.join(", ")}.` };
  }
  if (!rfc) return { ok: false, error_code: "datos_invalidos", msg: "Tijuana-Tecate: falta el RFC del receptor" };

  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error("BROWSERLESS_TOKEN no definido");
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true`,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 950 });

  let ultimoDialog = null;
  page.on("dialog", async (d) => {
    ultimoDialog = d.message();
    console.log(`💬 ALERT: "${d.message()}"`);
    try { await d.accept(); } catch {}
  });

  const ts = ticketId || Date.now();
  async function screenshot(label) {
    try {
      const buf = await page.screenshot({ fullPage: true });
      const u = await subirArchivoR2(buf, `debug/tijuanatecate_${ts}_${label}_${Date.now()}.png`, "image/png");
      console.log(`📸 [${label}]: ${u}`);
    } catch {}
  }

  async function soltarTicket() {
    try {
      await page.evaluate(() => { const b = window.__k.boton("^\\s*delete\\s*$"); if (b) b.click(); });
      await sleep(2500);
      console.log("   ↩️ Ticket soltado de la tabla");
    } catch {}
  }

  // ⚠️ El portal abre DOS modales encima del formulario ("Bienvenido…" y "Aviso
  // Importante 1"). Mientras estén abiertos tapan los campos y los clicks se
  // pierden sin error: el bot rellena, pulsa "Agregar ticket" y no pasa nada.
  // Se cierran en bucle porque el segundo solo aparece al cerrar el primero.
  async function cerrarModales() {
    for (let i = 0; i < 4; i++) {
      const cerro = await page.evaluate(() => {
        const b = Array.from(document.querySelectorAll("button, .close, [aria-label=Close]"))
          .find((x) => x.offsetParent && /^\s*(cerrar|close|×|✕|x)\s*$/i.test((x.innerText || x.getAttribute("aria-label") || "").trim()));
        if (!b) return false;
        b.click();
        return true;
      });
      if (!cerro) break;
      await sleep(1200);
    }
    const quedan = await page.evaluate(() =>
      document.querySelectorAll(".modal.show, .modal-backdrop, [role=dialog]").length);
    if (quedan) console.log(`   ⚠️ Siguen ${quedan} capas de modal abiertas`);
  }

  try {
    console.log("🌐 Cargando Kiosco Facturación...");
    await page.goto(URL_PORTAL, { waitUntil: "networkidle2", timeout: 60000 });
    await page.evaluate(HELPERS);
    await sleep(2000);

    await cerrarModales();
    await screenshot("p1_cargado");

    // ── PASO 1 — Agregar el ticket ───────────────────────────────────────
    const sel = await page.evaluate((d) => {
      const k = window.__k;
      const eEnt = k.campo("Entronque");
      if (!eEnt) return { err: "no apareció el select de Entronque" };
      const via = k.opcionPorTexto(eEnt, d.via);
      if (!via) return { err: `la autopista "${d.via}" no está entre las opciones: ${Array.from(eEnt.options).map((o) => o.text).join(" | ")}` };
      return { via };
    }, { via });
    if (sel.err) { await screenshot("error_entronque"); await browser.close(); return { ok: false, error_code: "datos_invalidos", msg: `Tijuana-Tecate: ${sel.err}` }; }
    console.log(`   Entronque (autopista): ${sel.via}`);

    await sleep(3000); // el select de Carril se puebla por AJAX

    const paso1 = await page.evaluate((d) => {
      const k = window.__k;
      const eCar = k.campo("Carril");
      if (!eCar) return { err: "no apareció el select de Carril" };
      const car = k.opcionPorTexto(eCar, d.carril);
      if (!car) return { err: `el carril "${d.carril}" no está entre los de esta autopista: ${Array.from(eCar.options).map((o) => o.text).join(" | ")}` };
      const eFol = k.campo("Folio"), eFH = k.campo("Fecha-Hora"), eCant = k.campo("Cantidad pagada");
      if (!eFol || !eFH || !eCant) return { err: "faltan campos de Folio / Fecha-Hora / Cantidad" };
      k.set(eFol, d.folio);
      k.set(eFH, d.fh);
      k.set(eCant, String(d.monto));
      return { carril: car, leido: { folio: eFol.value, fechaHora: eFH.value, cantidad: eCant.value } };
    }, { carril: carrilLimpio, folio: folioLimpio, fh, monto });
    if (paso1.err) { await screenshot("error_paso1"); await browser.close(); return { ok: false, error_code: "datos_invalidos", msg: `Tijuana-Tecate: ${paso1.err}` }; }
    console.log(`   Carril: ${paso1.carril} | ${JSON.stringify(paso1.leido)}`);
    await screenshot("p2_lleno");

    await page.evaluate(() => { const b = window.__k.boton("agregar ticket"); if (b) b.click(); });
    await sleep(7000);
    await screenshot("p3_agregado");

    // ⚠️ El folio se MANDA con ceros a la izquierda (0000360201) pero la tabla
    // lo PINTA sin ellos (360201). Comparar la cadena tal cual da un falso
    // negativo: el ticket sí se agregó y el bot lo daba por fallido.
    // ⚠️ DOS TRAMPAS EN LA COMPROBACIÓN, las dos dieron falso negativo:
    //  1. La lista de tickets NO es un <table>: Angular Material la pinta con
    //     divs (mat-row / role=row), así que querySelectorAll('table tr') sale
    //     siempre vacío aunque la fila esté ahí.
    //  2. El folio se MANDA con ceros a la izquierda (0000360201) pero se PINTA
    //     sin ellos (360201).
    // La señal más limpia es que aparezca la sección "Datos de Facturación":
    // el portal solo la muestra cuando ya hay al menos un ticket en la lista.
    const tras = await page.evaluate((fol) => {
      const sinCeros = String(fol).replace(/^0+/, "");
      const cuerpo = document.body.innerText || "";
      const filas = Array.from(document.querySelectorAll("mat-row, [role=row], tr, .mat-row"))
        .map((r) => r.innerText || "");
      return {
        avisos: window.__k.avisos(),
        enFilas: filas.some((t) => t.includes(fol) || t.includes(sinCeros)),
        enTexto: cuerpo.includes(sinCeros),
        hayFacturacion: !!window.__k.campo("RFC"),
      };
    }, folioLimpio);

    if (!tras.hayFacturacion || !(tras.enFilas || tras.enTexto)) {
      await screenshot("error_no_agregado");
      await browser.close();
      const av = tras.avisos.join(" · ") || ultimoDialog || "(sin aviso)";
      return {
        ok: false,
        error_code: "datos_invalidos",
        msg: `Tijuana-Tecate: el portal no agregó el ticket ${folioLimpio} (enFilas=${tras.enFilas}, enTexto=${tras.enTexto}, datosFacturacion=${tras.hayFacturacion}). Aviso: ${av}`,
      };
    }
    console.log(`✅ Ticket agregado — ${tras.avisos.join(" · ")}`);

    if (seco === "agregado") {
      await soltarTicket();
      await browser.close();
      console.log("🧪 DRY RUN agregado — ticket encontrado y soltado; no se facturó nada.");
      return { ok: false, error_code: "dry_run", msg: `Tijuana-Tecate dry run: ticket ${folioLimpio} encontrado y agregado.`, _leido: paso1.leido };
    }

    // ── PASO 2 — Datos de facturación ────────────────────────────────────
    const correo = emailEntrega || process.env.IMAP_USER || "buzonfacturas@serviciosga.site";
    const cp = String(codigoPostal || "").replace(/\D/g, "").slice(0, 5);
    const regimen = String(regimenFiscal || "601").match(/\d{3}/)?.[0] || "601";
    const uso = String(usoCfdi || "G03").toUpperCase().match(/[A-Z]\d{2}/)?.[0] || "G03";
    console.log(`📋 Datos de facturación — RFC ${rfc} | CP ${cp} | Régimen ${regimen} | Uso ${uso} | Entrega ${correo}`);

    const fiscales = await page.evaluate((d) => {
      const k = window.__k;
      const faltan = [];
      const put = (etq, val) => { const e = k.campo(etq); if (!e) { faltan.push(etq); return null; } k.set(e, val); return e.value; };
      const leido = {
        email: put("Email", d.correo),
        razon: put("Nombre o Raz", d.razonSocial),
        cp: put("Código Postal", d.cp),
        rfc: put("RFC", d.rfc),
      };
      const eReg = k.campo("Regimen fiscal") || k.campo("Régimen fiscal");
      if (eReg) k.opcionPorTexto(eReg, d.regimen); else faltan.push("Regimen fiscal");
      const eUso = k.campo("Uso de CFDI");
      if (eUso) k.opcionPorTexto(eUso, d.uso); else faltan.push("Uso de CFDI");
      leido.regimen = eReg ? eReg.value : null;
      leido.uso = eUso ? eUso.value : null;
      return { faltan, leido };
    }, { correo, razonSocial, cp, rfc, regimen, uso });

    if (fiscales.faltan.length) {
      await screenshot("error_fiscales");
      await soltarTicket();
      await browser.close();
      return { ok: false, msg: `Tijuana-Tecate: faltaron campos de facturación: ${fiscales.faltan.join(", ")}` };
    }
    console.log(`   Confirmado en pantalla: ${JSON.stringify(fiscales.leido)}`);
    await sleep(1200);
    await screenshot("p4_fiscales");

    if (seco) {
      await soltarTicket();
      await browser.close();
      console.log('🧪 DRY RUN — todo listo hasta "Facturar"; no se emite nada.');
      return { ok: false, error_code: "dry_run", msg: `Tijuana-Tecate dry run: ticket ${folioLimpio} listo para facturar.`, _fiscales: fiscales.leido };
    }

    // ── PASO 3 — Facturar ────────────────────────────────────────────────
    const puedo = await page.evaluate(() => { const b = window.__k.boton("facturar"); return b ? !b.disabled : null; });
    if (!puedo) {
      await screenshot("error_facturar_deshabilitado");
      await soltarTicket();
      await browser.close();
      return { ok: false, msg: `Tijuana-Tecate: el botón "Facturar" sigue deshabilitado — el portal no dio por buenos los datos.` };
    }

    console.log('🧾 Pulsando "Facturar" (EMISIÓN REAL)...');
    await page.evaluate(() => { const b = window.__k.boton("facturar"); b.click(); });
    await sleep(15000);
    await screenshot("p5_post_emision");

    const fin = await page.evaluate(() => ({
      avisos: window.__k.avisos(),
      texto: document.body.innerText.replace(/\s+/g, " ").slice(0, 900),
      sigueElBoton: (() => { const b = window.__k.boton("facturar"); return !!(b && !b.disabled); })(),
    }));
    const uuid = (fin.texto.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) || [])[0] || null;
    await browser.close();

    console.log(`   Avisos del portal: ${fin.avisos.join(" · ") || "(ninguno)"}`);

    // Acuse explícito, nunca por texto suelto de la página: el aviso del plazo
    // ("Solo se podrán emitir facturas…") está impreso SIEMPRE y un regex laxo
    // lo tomaría por éxito, que es el falso positivo que ya costó un ticket
    // en FIARUM y casi otro en Puente Colorado.
    // El acuse literal es "Factura generada correctamente", dentro de un modal
    // que además ofrece PDF y XML. Se busca en los avisos Y en el texto de la
    // página, pero con una frase EXACTA: el cartel del plazo ("Solo se podrán
    // emitir facturas…") está impreso siempre y un regex laxo lo tomaría por
    // éxito.
    const acuse = fin.avisos.join(" · ");
    const reExito = /factura\s+generada\s+correctamente|factura(s)?\s+(generad|emitid|timbrad|enviad)[ao]s?\b/i;
    const exito = !!uuid || reExito.test(acuse) || reExito.test(fin.texto);
    if (!exito) {
      return { ok: false, msg: `Tijuana-Tecate: tras pulsar "Facturar" el ticket ${folioLimpio} no dio acuse. NO se da por facturado. Avisos: ${acuse || "(ninguno)"} | Texto: ${fin.texto.slice(0, 200)}` };
    }

    console.log(`📧 Facturado — el CFDI llega al correo de entrega (IMAP)${uuid ? ` | UUID: ${uuid}` : ""}`);
    return { ok: true, procesandoCorreo: true, folioGenerado: folioLimpio, ...(uuid ? { uuid } : {}), _acuse: acuse };
  } catch (e) {
    console.error("❌ Error en bot Tijuana-Tecate:", e.message);
    await screenshot("error").catch(() => {});
    await soltarTicket().catch(() => {});
    await browser.close().catch(() => {});
    return { ok: false, msg: `Tijuana-Tecate: ${e.message}` };
  }
}

module.exports = { facturarTijuanaTecate };
