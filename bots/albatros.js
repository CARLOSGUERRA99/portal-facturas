// Albatros Autobuses — grupoalbatros.net/facturacion/
//
// Reconocimiento real (12/08/2026, boleto real I7UB8C, Huatabampo→Peñasco,
// $1030, 10/08/2026):
//   · El portal NO está en albatrosautobuses.com: ese sitio solo enlaza a
//     https://grupoalbatros.net/facturacion/, que es donde vive el formulario.
//   · Sin CAPTCHA y sin login: todos los campos salen en la primera pantalla.
//   · Los datos fiscales se capturan a mano (no hay perfil guardado por RFC).
//   · El boleto y el importe van en campos con nombre de ARRAY —
//     input[name="boleto[]"] e input[name="importe[]"]— porque el portal
//     permite facturar varios boletos de una vez.
//
// ⚠️ QUÉ DATO ES EL BOLETO. El ticket imprime DOS códigos y solo uno vale:
//     I7UB8C     ← arriba del todo, junto a la palabra BOLETO. Es este.
//     S-BM6SQL4  ← "Vendido en: Huatabampo (Turno # S-BM6SQL4)". Es el TURNO
//                  de la taquilla, no el boleto.
//   El OCR guardaba el primero en `folio` y el segundo en `referencia`.
//
// ⚠️ PLAZO: el propio boleto dice "30 DIAS PARA FACTURAR".
const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");

const URL = "https://grupoalbatros.net/facturacion/";

async function facturarAlbatros({
  folio, boleto, total,
  rfc, razonSocial, regimenFiscal, usoCfdi, codigoPostal,
  calle, colonia, municipio, estado, email,
  ticketId,
}) {
  const numBoleto = String(boleto || folio || "").trim();
  if (!numBoleto) {
    return { ok: false, error_code: "datos_invalidos", msg: "Albatros: falta el número de boleto (el código de arriba del ticket, junto a la palabra BOLETO)" };
  }

  console.log("🤖 Albatros Autobuses");
  console.log(`   Boleto: ${numBoleto} | Total: ${total} | RFC: ${rfc}`);

  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error("BROWSERLESS_TOKEN no definido");

  let browser;
  try {
    browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  } catch (e) {
    return { ok: false, msg: `Albatros: no se pudo conectar al browser — ${e.message}` };
  }

  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 950 });
  page.on("dialog", async (d) => { console.log("🔔 Dialog:", d.message()); await d.accept().catch(() => {}); });

  const ts = ticketId || Date.now();
  const snap = async (etq) => {
    try {
      const u = await subirArchivoR2(await page.screenshot({ fullPage: false }), `debug/albatros_${ts}_${etq}_${Date.now()}.png`, "image/png");
      console.log(`📸 [${etq}]: ${u}`);
    } catch {}
  };

  // Asigna el valor y avisa al framework. No se usa click+type porque los
  // campos van en un formulario largo y el foco salta al hacer scroll.
  const poner = (sel, v) => page.evaluate((s, val) => {
    const e = document.querySelector(s);
    if (!e) return false;
    e.value = val;
    ["input", "change", "keyup", "blur"].forEach((ev) => e.dispatchEvent(new Event(ev, { bubbles: true })));
    return true;
  }, sel, String(v ?? ""));

  // Elige la opción de un <select> por código o por texto.
  const elegir = (sel, candidatos) => page.evaluate((s, cands) => {
    const el = document.querySelector(s);
    if (!el) return null;
    for (const c of cands.filter(Boolean)) {
      const o = Array.from(el.options).find((x) =>
        x.value === String(c) || new RegExp(`\\b${String(c).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(x.textContent));
      if (o) {
        el.value = o.value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return o.textContent.trim();
      }
    }
    return null;
  }, sel, candidatos);

  try {
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 40000 });
    await page.waitForSelector("#rfc", { timeout: 20000 });
    await page.waitForTimeout(1500);

    await elegir("#FactVersion", ["4.0"]);
    const reg = await elegir("#regFiscRec", [regimenFiscal || "601"]);
    const uso = await elegir("#UsoCFDI", [usoCfdi || "G03", "Gastos en general"]);
    const pago = await elegir("#forma_pago", ["01", "Efectivo"]);
    console.log(`   régimen: ${reg} | uso: ${uso} | forma de pago: ${pago}`);
    if (!reg) { await snap("sin_regimen"); await browser.close();
      return { ok: false, error_code: "datos_invalidos", msg: `Albatros: el portal no ofrece el régimen fiscal ${regimenFiscal}` }; }

    await poner("#rfc", rfc);
    await poner("#razonsocial", razonSocial);
    await poner("#domicilio", [calle, colonia].filter(Boolean).join(" "));
    await poner("#localidad", [municipio, estado].filter(Boolean).join(", "));
    await poner("#codpos", codigoPostal);
    await poner("#email", email || "buzonfacturas@serviciosga.site");
    await poner("#emailopc", "buzonfacturas@serviciosga.site");

    // Campos de array: se localizan por name, no por id (el id lleva corchetes).
    await page.evaluate((b, imp) => {
      const set = (sel, v) => {
        const e = document.querySelector(sel);
        if (!e) return;
        e.value = v;
        ["input", "change", "keyup", "blur"].forEach((ev) => e.dispatchEvent(new Event(ev, { bubbles: true })));
      };
      set('input[name="boleto[]"]', b);
      set('input[name="importe[]"]', imp);
    }, numBoleto, String(total));

    await snap("form_lleno");

    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("button, input[type=submit], a"))
        .find((x) => /^\s*siguiente\s*$/i.test((x.textContent || x.value || "")) && x.offsetParent);
      if (b) b.click();
    });
    await page.waitForTimeout(8000);
    await snap("tras_siguiente");

    const r = await page.evaluate(() => ({
      url: location.href,
      texto: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 900),
      avisos: Array.from(document.querySelectorAll(".alert, .error, .invalid-feedback, [class*=danger], .swal2-html-container"))
        .filter((e) => e.offsetParent !== null).map((e) => e.textContent.trim().replace(/\s+/g, " ")).filter(Boolean).slice(0, 5),
      botones: [...new Set(Array.from(document.querySelectorAll("button, input[type=submit], a"))
        .filter((e) => e.offsetParent !== null).map((e) => (e.textContent || e.value || "").trim()).filter((t) => t && t.length < 40))],
      enlaces: Array.from(document.querySelectorAll("a")).map((a) => a.href).filter((h) => /\.xml|\.pdf/i.test(h)),
    }));

    console.log(`   → ${r.url}`);
    if (r.avisos.length) console.log(`   avisos: ${r.avisos.join(" | ")}`);
    console.log(`   botones: ${r.botones.join(" · ")}`);

    // Lo que dice el portal manda; nunca se inventa el motivo.
    const t = r.texto;
    if (/ya (fue|est[aá]) facturad|ya se factur|previamente facturad/i.test(t)) {
      await browser.close();
      return { ok: false, error_code: "ya_facturado", msg: `Albatros: el boleto ${numBoleto} ya fue facturado` };
    }
    if (/no (se )?(encontr|existe)|no v[aá]lido|inv[aá]lid/i.test(t)) {
      await snap("no_encontrado");
      await browser.close();
      return { ok: false, error_code: "datos_invalidos", msg: `Albatros: el portal no reconoce el boleto ${numBoleto}${r.avisos.length ? ` — "${r.avisos[0]}"` : ""}` };
    }
    if (/30 d[ií]as|venci|fuera de plazo|caduc/i.test(r.avisos.join(" "))) {
      await browser.close();
      return { ok: false, error_code: "ticket_vencido", msg: `Albatros: fuera del plazo de 30 días — "${r.avisos[0]}"`, email_contacto: "facturacion@albatrosautobuses.com" };
    }

    // ⚠️ "Siguiente" NO factura: lleva a paso2fact.php, una pantalla de
    //    confirmación con su propio botón "Facturar". La primera versión daba
    //    ok:true aquí porque el texto de la página contenía la palabra "correo"
    //    — y no se había timbrado nada todavía.
    const hayConfirmar = r.botones.some((b) => /^\s*facturar\s*$/i.test(b));
    if (hayConfirmar) {
      console.log("   ➡️ pantalla de confirmación — pulsando Facturar...");
      await page.evaluate(() => {
        const b = Array.from(document.querySelectorAll("button, input[type=submit], a"))
          .find((x) => /^\s*facturar\s*$/i.test((x.textContent || x.value || "")) && x.offsetParent);
        if (b) b.click();
      });
      await page.waitForTimeout(15000);
      await snap("tras_facturar");

      const f = await page.evaluate(() => ({
        url: location.href,
        texto: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 900),
        enlaces: Array.from(document.querySelectorAll("a")).map((a) => a.href).filter((h) => /\.xml|\.pdf/i.test(h)),
        avisos: Array.from(document.querySelectorAll(".alert, .error, [class*=danger]"))
          .filter((e) => e.offsetParent !== null).map((e) => e.textContent.trim().replace(/\s+/g, " ")).filter(Boolean).slice(0, 4),
      }));
      console.log(`   → ${f.url}`);
      if (f.avisos.length) console.log(`   avisos: ${f.avisos.join(" | ")}`);

      if (f.enlaces.length) {
        await browser.close();
        return { ok: true, xmlUrl: f.enlaces.find((h) => /\.xml/i.test(h)) || null, pdfUrl: f.enlaces.find((h) => /\.pdf/i.test(h)) || null };
      }
      if (/factura.*(generad|emitid|timbrad)|se envi|enviad[ao] a su correo|gracias/i.test(f.texto)) {
        await browser.close();
        return { ok: true, procesandoCorreo: true };
      }
      await browser.close();
      return {
        ok: false,
        error_code: "reintentar_despues",
        msg: `Albatros: se pulsó Facturar y el portal no confirmó el timbrado${f.avisos.length ? ` — "${f.avisos.join(" | ")}"` : ""}. Hay captura en R2.`,
      };
    }

    if (r.enlaces.length) {
      await browser.close();
      return { ok: true, xmlUrl: r.enlaces.find((h) => /\.xml/i.test(h)) || null, pdfUrl: r.enlaces.find((h) => /\.pdf/i.test(h)) || null };
    }

    await snap("estado_desconocido");
    await browser.close();
    return {
      ok: false,
      error_code: "reintentar_despues",
      msg: `Albatros: el portal no confirmó ni rechazó${r.avisos.length ? ` — "${r.avisos.join(" | ")}"` : " y no mostró ningún aviso"}. Hay captura en R2.`,
    };
  } catch (e) {
    await snap("excepcion").catch(() => {});
    await browser.close().catch(() => {});
    return { ok: false, msg: `Albatros: ${e.message}` };
  }
}

module.exports = { facturarAlbatros };
