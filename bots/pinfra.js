// PINFRA — pinfrafacturacion.com.mx (casetas de Promotora y Operadora de
// Infraestructura). Cubre Santa Ana-Altar y las otras 26 autopistas suyas.
//
// Reconocimiento real (12/08/2026, tickets #208 y #210 de Concesionaria Santa
// Ana-Altar, y timbrado verificado del #210: transacción 200034835413, $139).
//
// ── ENTRADA ────────────────────────────────────────────────────────────────
// No hay registro ni contraseña: se entra con RFC + un correo YA ASOCIADO a
// ese RFC en el portal, y él solo carga los datos fiscales. Ojo: NO vale
// cualquier correo. Con buzonfacturas@serviciosga.site contesta "RFC o Correo
// Incorrectos"; con carlosguerra@grupogpn.com entra. Por eso se usa el correo
// del usuario del ticket, no una constante.
//
// ── LAS CUATRO TRAMPAS, todas medidas ──────────────────────────────────────
// 1. FECHAS EN DOS FORMATOS DISTINTOS EN EL MISMO PORTAL:
//        Facturar/GenerarFactura    → M/D/YYYY   (8/2/2026 = 2 de agosto)
//        Consultar/GenerarConsultas → D/M/YYYY   (01/07/2026 = 1 de julio)
//    Mandando 02/08/2026 al primero, el portal contestó "solo tickets con
//    fecha menor a 30 días" y en la URL se leía Fecha=2026-02-08: lo había
//    entendido como 8 de febrero.
// 2. NO SE PUEDE click+type: #Fecha abre un datepicker que tapa los demás
//    campos, así que los clics siguientes caen en el calendario y NumeroId,
//    Consecutivo y Total se quedan vacíos. Hay que asignar value y disparar
//    los eventos.
// 3. EL BOTÓN DE CONFIRMAR SE LLAMA IGUAL QUE OTRO. Tras "Facturar" sale un
//    aviso pidiendo el Uso del CFDI cuyo botón es #modal-uso-cdfi
//    button#Facturar — mismo id y mismo texto que el "Facturar" de la tabla.
//    Buscarlo por texto coge el de fuera y solo reabre el aviso: parece que
//    falla cuando en realidad no se ha pulsado nada. Y ese aviso NO lleva
//    clase .modal ni role=dialog, así que buscarlo así devuelve cero.
// 4. EL RESULTADO VIENE EN LA QUERY STRING (MensajeError / MensajeSuccess).
//    Es mucho más fiable que raspar la pantalla — se lee de ahí.
//
// ── FLUJO ──────────────────────────────────────────────────────────────────
// Entrar → GenerarFactura → elegir caseta → Método 1 → "Agregar Ticket"
// (reversible: hay "Liberar Ticket Seleccionado") → "Facturar" → elegir uso
// CFDI → confirmar. El CFDI se entrega desde Consultar Facturas, y se manda al
// buzón para que lo recoja el IMAP.
const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");

const BASE = "https://www.pinfrafacturacion.com.mx";
const BUZON = "buzonfacturas@serviciosga.site";

// El campo "Máquina" del portal lista los carriles con cero delante (01B, 02B,
// 06A…) y el ticket los imprime sin él ("CARRIL:2B"). Se normaliza.
function normalizarCarril(c) {
  const s = String(c || "").trim().toUpperCase().replace(/\s+/g, "");
  if (!s) return "";
  const m = s.match(/^(\d{1,2})([A-Z]?)$/);
  return m ? m[1].padStart(2, "0") + m[2] : s;
}

// El FOLIO del ticket viene como "2-0000983716": lo de antes del guion es el
// Número Id (máx. 7) y lo de después el Consecutivo (máx. 10).
function partirFolio(folio) {
  const s = String(folio || "").trim();
  const m = s.match(/^(\w{1,7})\s*-\s*(\w{1,10})$/);
  if (m) return { numeroId: m[1], consecutivo: m[2] };
  return { numeroId: "", consecutivo: s };
}

// El portal espera M/D/YYYY en el formulario de facturación.
function fechaUS(f) {
  const s = String(f || "").trim();
  let d, mes, a;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) { [a, mes, d] = s.slice(0, 10).split("-"); }
  else { const p = s.split(/[\/\-]/); if (p.length !== 3) return ""; [d, mes, a] = p; }
  return `${Number(mes)}/${Number(d)}/${a}`;
}

async function facturarPinfra({
  folio, numeroId, consecutivo, carril, caseta, autopista,
  fecha, hora, total,
  rfc, email, ticketId,
}) {
  const part = partirFolio(folio);
  const nId = String(numeroId || part.numeroId || "").trim();
  const cons = String(consecutivo || part.consecutivo || "").trim();
  const maq = normalizarCarril(carril);
  const fUS = fechaUS(fecha);
  const nombreCaseta = String(autopista || caseta || "").trim();

  const faltan = [];
  if (!cons) faltan.push("consecutivo (la parte del FOLIO tras el guion)");
  if (!maq) faltan.push("carril (la línea CARRIL: del ticket)");
  if (!fUS) faltan.push("fecha");
  if (!hora) faltan.push("hora (el portal la exige, viene junto a la fecha)");
  if (!nombreCaseta) faltan.push("nombre de la autopista o caseta");
  if (faltan.length) {
    return { ok: false, error_code: "datos_invalidos", msg: `PINFRA: faltan datos del ticket — ${faltan.join(", ")}` };
  }
  if (!email) {
    return { ok: false, error_code: "datos_invalidos", msg: "PINFRA: hace falta el correo con el que este RFC está dado de alta en el portal (no vale cualquiera)" };
  }

  console.log("🤖 PINFRA");
  console.log(`   ${nombreCaseta} · Nº Id ${nId || "(vacío)"} · consec ${cons} · máquina ${maq} · ${fUS} ${hora} · $${total}`);

  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error("BROWSERLESS_TOKEN no definido");

  let browser;
  try {
    browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  } catch (e) {
    return { ok: false, msg: `PINFRA: no se pudo conectar al browser — ${e.message}` };
  }

  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000 });
  page.on("dialog", async (d) => { console.log("🔔 Dialog:", d.message()); await d.accept().catch(() => {}); });

  const ts = ticketId || Date.now();
  const snap = async (etq) => {
    try {
      const u = await subirArchivoR2(await page.screenshot({ fullPage: false }), `debug/pinfra_${ts}_${etq}_${Date.now()}.png`, "image/png");
      console.log(`📸 [${etq}]: ${u}`);
    } catch {}
  };

  // Trampa 2: asignar value y avisar, nunca teclear.
  const poner = (sel, v) => page.evaluate((s, val) => {
    const e = document.querySelector(s);
    if (!e) return false;
    e.value = val;
    ["input", "change", "keyup", "blur"].forEach((ev) => e.dispatchEvent(new Event(ev, { bubbles: true })));
    return true;
  }, sel, String(v ?? ""));

  // Trampa 4: el portal contesta por la query string.
  const mensajeUrl = async () => {
    const u = new URL(await page.url());
    const err = u.searchParams.get("MensajeError");
    const ok = u.searchParams.get("MensajeSuccess");
    return { err: err ? decodeURIComponent(err) : null, ok: ok ? decodeURIComponent(ok) : null };
  };

  try {
    // ── Entrar ──────────────────────────────────────────────────────────────
    await page.goto(`${BASE}/`, { waitUntil: "load", timeout: 35000 });
    await page.waitForSelector("input#rfc", { timeout: 15000 });
    await page.type("input#rfc", rfc, { delay: 30 });
    await page.type("input#correo", email, { delay: 30 });
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("button, input[type=submit], a")).find((x) => /ingresar/i.test(x.textContent || x.value || ""));
      if (b) b.click();
    });
    await page.waitForTimeout(5500);

    const malLogin = await page.evaluate(() => /RFC o Correo Incorrectos/i.test(document.body.innerText || ""));
    if (malLogin) {
      await snap("login_rechazado");
      await browser.close();
      return {
        ok: false,
        error_code: "datos_invalidos",
        msg: `PINFRA: el portal rechaza la pareja RFC ${rfc} + ${email} ("RFC o Correo Incorrectos"). El correo tiene que ser uno ya asociado a ese RFC en el portal.`,
      };
    }

    // ── Formulario ──────────────────────────────────────────────────────────
    await page.goto(`${BASE}/Facturar/GenerarFactura`, { waitUntil: "load", timeout: 30000 });
    await page.waitForSelector("#cmbCaseta", { timeout: 20000 });
    await page.waitForTimeout(2000);

    const cas = await page.evaluate((nom) => {
      const s = document.querySelector("#cmbCaseta");
      const norm = (t) => t.toUpperCase().replace(/[^A-Z0-9]/g, "");
      const buscado = norm(nom);
      const o = Array.from(s.options).find((x) => {
        const v = norm(x.textContent);
        return v && (v.includes(buscado) || buscado.includes(v));
      });
      if (!o) return { lista: Array.from(s.options).map((x) => x.textContent.trim()).slice(1) };
      s.value = o.value;
      s.dispatchEvent(new Event("change", { bubbles: true }));
      return { elegida: o.textContent.trim(), value: o.value };
    }, nombreCaseta);

    if (!cas.elegida) {
      await snap("sin_caseta");
      await browser.close();
      return { ok: false, error_code: "datos_invalidos", msg: `PINFRA: "${nombreCaseta}" no está entre sus ${cas.lista.length} autopistas. Puede que esta caseta sea de otra concesionaria.` };
    }
    console.log(`   caseta: ${cas.elegida}`);
    await page.waitForTimeout(3500);   // el desplegable de máquinas se llena por AJAX

    await poner("#Fecha", fUS);
    await poner("#NumeroId", nId);
    await poner("#consecutivo", cons);
    await poner("#total", Number(total).toFixed(2));
    await poner("#hora", hora);

    const maqOk = await page.evaluate((m) => {
      const s = document.querySelector("#CarrilId");
      const o = Array.from(s.options).find((x) => x.textContent.trim().toUpperCase() === m);
      if (!o) return { lista: Array.from(s.options).map((x) => x.textContent.trim()) };
      s.value = o.value;
      s.dispatchEvent(new Event("change", { bubbles: true }));
      return { elegida: o.textContent.trim() };
    }, maq);
    if (!maqOk.elegida) {
      await snap("sin_maquina");
      await browser.close();
      return { ok: false, error_code: "datos_invalidos", msg: `PINFRA: el carril ${maq} no existe en esta caseta (hay: ${(maqOk.lista || []).filter((x) => /\d/.test(x)).join(", ")})` };
    }
    await snap("form_lleno");

    // ── Agregar Ticket ──────────────────────────────────────────────────────
    await page.evaluate(() => {
      const b = document.querySelector("#btnMetodo1") ||
        Array.from(document.querySelectorAll("button")).find((x) => /agregar\s*ticket/i.test(x.textContent || ""));
      if (b) b.click();
    });
    await page.waitForTimeout(7000);

    const m1 = await mensajeUrl();
    if (m1.err) {
      console.log(`   portal: ${m1.err}`);
      await snap("agregar_rechazado");
      await browser.close();
      if (/ya fue facturad/i.test(m1.err)) return { ok: false, error_code: "ya_facturado", msg: `PINFRA: ${m1.err}` };
      if (/30 d[ií]as|fecha menor/i.test(m1.err)) return { ok: false, error_code: "ticket_vencido", msg: `PINFRA: ${m1.err}`, email_contacto: "facturacion@pinfra.com.mx" };
      return { ok: false, error_code: "datos_invalidos", msg: `PINFRA: ${m1.err}` };
    }
    console.log(`   ${m1.ok || "ticket agregado"}`);

    // ── Facturar → uso de CFDI → confirmar ──────────────────────────────────
    await page.evaluate(() => {
      document.querySelectorAll("table input[type=checkbox], table input[type=radio]").forEach((c) => { if (!c.checked) c.click(); });
    });
    await page.waitForTimeout(700);
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("button, input[type=submit], a"))
        .find((x) => /^\s*facturar\s*$/i.test(x.textContent || x.value || "") && x.offsetParent);
      if (b) b.click();
    });
    await page.waitForTimeout(4000);

    const uso = await page.evaluate(() => {
      const s = document.querySelector("#ClaveCDFI");
      if (!s) return null;
      const o = Array.from(s.options).find((x) => /^\s*G03/i.test(x.textContent));
      if (!o) return null;
      s.value = o.value;
      s.dispatchEvent(new Event("change", { bubbles: true }));
      return o.textContent.trim();
    });
    if (!uso) {
      await snap("sin_uso_cfdi");
      await browser.close();
      return { ok: false, error_code: "reintentar_despues", msg: "PINFRA: el ticket quedó AGREGADO pero no apareció el aviso del Uso de CFDI. Está reservado en 'Tickets por Facturar' — se puede terminar a mano o liberar." };
    }
    console.log(`   uso CFDI: ${uso}`);
    await page.waitForTimeout(1200);

    // Trampa 3: anclado al contenedor, nunca por texto.
    const confirmado = await page.evaluate(() => {
      const b = document.querySelector("#modal-uso-cdfi button#Facturar");
      if (!b || b.offsetParent === null) return false;
      b.click();
      return true;
    });
    if (!confirmado) {
      await snap("sin_boton_confirmar");
      await browser.close();
      return { ok: false, error_code: "reintentar_despues", msg: "PINFRA: no se encontró #modal-uso-cdfi button#Facturar. El ticket sigue AGREGADO y reservado en el portal." };
    }
    await page.waitForTimeout(15000);
    await snap("tras_confirmar");

    // ── Comprobar que existe de verdad y mandarlo al buzón ──────────────────
    // Trampa 1: aquí la fecha va en D/M/YYYY, y una fecha futura devuelve vacío.
    const hoy = new Date();
    const dd = (n) => String(n).padStart(2, "0");
    const desde = `01/${dd(hoy.getMonth() + 1)}/${hoy.getFullYear()}`;
    const hasta = `${dd(hoy.getDate())}/${dd(hoy.getMonth() + 1)}/${hoy.getFullYear()}`;

    await page.goto(`${BASE}/Consultar/GenerarConsultas`, { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(3500);
    await poner("#txtDe", desde);
    await poner("#txtA", hasta);
    await page.waitForTimeout(700);
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("button, input[type=submit], a")).find((x) => /buscar/i.test(x.textContent || x.value || "") && x.offsetParent);
      if (b) b.click();
    });
    await page.waitForTimeout(11000);

    const emitida = await page.evaluate((imp) => {
      const filas = Array.from(document.querySelectorAll("table tr"))
        .map((t) => ({ txt: t.innerText.replace(/\s+/g, " ").trim(), tr: t }))
        .filter((f) => /Facturado/i.test(f.txt) && f.txt.includes(imp));
      if (!filas.length) return null;
      const ultima = filas[filas.length - 1];
      const tx = (ultima.txt.match(/^(\d{6,})/) || [])[1] || null;
      return { texto: ultima.txt, transaccion: tx };
    }, String(Number(total)));

    if (!emitida) {
      await snap("sin_confirmar_en_consulta");
      await browser.close();
      return { ok: false, error_code: "reintentar_despues", msg: `PINFRA: se confirmó el uso de CFDI pero la factura de $${total} no aparece todavía en Consultar Facturas. Puede ser demora del timbrado — revisar antes de reintentar, para no duplicar.` };
    }
    console.log(`   ✅ ${emitida.texto}`);

    // El destino es un campo de PÁGINA (#Correo), no de la fila: primero se
    // pone y luego se pulsa el icono de enviar de esa fila.
    await poner("#Correo", BUZON);
    await page.waitForTimeout(800);
    const enviado = await page.evaluate((tx) => {
      const f = Array.from(document.querySelectorAll("table tr")).find((t) => t.innerText.includes(tx));
      const b = f?.querySelector("#btnSendEmail");
      if (!b) return false;
      b.click();
      return true;
    }, emitida.transaccion || String(Number(total)));
    console.log(`   correo al buzón: ${enviado ? "enviado" : "no se encontró el botón"}`);
    await page.waitForTimeout(8000);
    await snap("enviado");
    await browser.close();

    if (!enviado) {
      return { ok: false, error_code: "reintentar_despues", msg: `PINFRA: la factura SÍ se timbró (transacción ${emitida.transaccion || "?"}) pero no se pudo mandar al buzón. Descargarla a mano desde Consultar Facturas.` };
    }
    return { ok: true, procesandoCorreo: true };
  } catch (e) {
    await snap("excepcion").catch(() => {});
    await browser.close().catch(() => {});
    return { ok: false, msg: `PINFRA: ${e.message}` };
  }
}

module.exports = { facturarPinfra, normalizarCarril, partirFolio, fechaUS };
