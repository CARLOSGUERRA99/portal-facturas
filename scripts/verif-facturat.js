/**
 * verificar-facturat.js — comprueba EN VIVO los selectores y la logica que
 * acaba de escribirse en bots/facturat.js, SIN TIMBRAR.
 *
 * Llega como mucho al '+' (que es una CONSULTA) y a comprobar que el boton
 * "Generar Factura" existe. NUNCA lo pulsa.
 *
 * Para no probar una copia distinta de la que se despliega, SEL, REGIMENES y
 * plano() se sacan del propio bots/facturat.js.
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

const RUTA_BOT = "C:/Users/carlo/portal-facturas/bots/facturat.js";
const fuente = fs.readFileSync(RUTA_BOT, "utf8");
const trozo = (re) => { const m = fuente.match(re); if (!m) throw new Error("no se pudo extraer del bot: " + re); return m[0]; };
// eslint-disable-next-line no-eval
const SEL = eval("(" + trozo(/const SEL = \{[\s\S]*?\n\};/).replace(/^const SEL = /, "").replace(/;$/, "") + ")");
// eslint-disable-next-line no-eval
const REGIMENES = eval("(" + trozo(/const REGIMENES = \{[\s\S]*?\n\};/).replace(/^const REGIMENES = /, "").replace(/;$/, "") + ")");
// eslint-disable-next-line no-eval
const plano = eval("(" + trozo(/const plano = \(s\) =>[^\n]*/).replace(/^const plano = /, "").replace(/;$/, "") + ")");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => parseFloat(String(v).replace(/[^0-9.\-]/g, ""));

// Ticket #362 real
const D = {
  base: "https://autofacturat.com.mx/FacturacionChurchsChicken/",
  nombre: "GPN PINTURAS Y RECUBRIMIENTOS",
  rfc: "GPR110128QD8",
  correo: "buzonfacturas@serviciosga.site",
  cp: "80140",
  folio: "271404",
  total: (330.01).toFixed(2),
  uso: "G03",
  regimen: "601",
};

(async () => {
  console.log("SEL extraido del bot:", JSON.stringify(SEL, null, 1));
  console.log("plano('Adquisición ÁÉ') =", plano("Adquisición  ÁÉ"));
  console.log("REGIMENES['601'] =", REGIMENES["601"]);

  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}&stealth=true`,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1100 });
  page.on("dialog", async (d) => { console.log("DIALOG:", JSON.stringify(d.message())); await d.accept().catch(() => {}); });
  const feedbackAjax = [];
  page.on("response", async (res) => {
    if (!/IBehaviorListener|IFormSubmitListener/.test(res.url())) return;
    let body = ""; try { body = await res.text(); } catch { return; }
    const re = /<li class="feedbackPanel(\w+)">\s*<span[^>]*>([^<]*)</g;
    let m; while ((m = re.exec(body))) { const msg = (m[2] || "").trim(); if (msg) { feedbackAjax.push({ nivel: m[1], msg }); console.log(`  AJAX feedback ${m[1]}: ${msg}`); } }
  });

  async function esperarAjax(maxMs = 25000) {
    const t0 = Date.now(); let previo = null, estables = 0;
    while (Date.now() - t0 < maxMs) {
      await sleep(600);
      const ocupado = await page.evaluate(() => {
        try { if (window.Wicket && window.Wicket.Ajax && typeof window.Wicket.Ajax.isBusy === "function") return !!window.Wicket.Ajax.isBusy(); } catch {}
        const veil = document.getElementById("veil");
        if (veil && veil.offsetParent !== null) return true;
        const ind = document.querySelector(".wicket-ajax-indicator, .wicket-ajax-indicator-visible, #ajax-indicator");
        return !!(ind && ind.offsetParent !== null);
      }).catch(() => false);
      if (ocupado) { estables = 0; continue; }
      const firma = await page.evaluate(() => (document.body ? `${document.body.innerHTML.length}|${document.body.innerText.replace(/\s+/g, " ").slice(0, 2500)}` : "")).catch(() => "");
      if (firma && firma === previo) { estables++; if (estables >= 2) return; } else { previo = firma; estables = 0; }
    }
  }

  async function teclear(sel, valor, etiqueta) {
    const h = await page.$(sel);
    if (!h) { console.log(`  !! NO EXISTE ${etiqueta} (${sel})`); return null; }
    await h.click({ clickCount: 3 });
    await page.keyboard.press("Backspace").catch(() => {});
    await page.keyboard.type(String(valor), { delay: 45 });
    const puesto = await page.$eval(sel, (e) => e.value).catch(() => null);
    console.log(`  ${puesto === String(valor) ? "OK " : "!! "}${etiqueta} = ${JSON.stringify(valor)} -> ${JSON.stringify(puesto)}`);
    return puesto;
  }

  async function elegirPorTexto(sel, patron, etiqueta) {
    const opciones = await page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return null;
      return Array.from(el.options).map((o) => ({ value: o.value, text: (o.text || "").replace(/\s+/g, " ").trim() }));
    }, sel).catch(() => null);
    if (!opciones) { console.log(`  !! NO EXISTE el select ${etiqueta}`); return { ok: false }; }
    const op = opciones.find((o) => o.value !== "" && patron.test(plano(o.text)));
    if (!op) { console.log(`  !! ${etiqueta}: ninguna opcion casa con ${patron}`); return { ok: false, opciones }; }
    await page.select(sel, op.value).catch(() => {});
    await page.evaluate((s) => { const e = document.querySelector(s); if (e) e.dispatchEvent(new Event("change", { bubbles: true })); }, sel).catch(() => {});
    await esperarAjax(8000);
    const elegido = await page.evaluate((s) => { const e = document.querySelector(s); return e && e.options[e.selectedIndex] ? e.options[e.selectedIndex].text.trim() : null; }, sel).catch(() => null);
    console.log(`  OK ${etiqueta} -> ${JSON.stringify(elegido)} (value ${op.value})`);
    return { ok: true, texto: elegido };
  }

  const leerPantalla = () => page.evaluate((sel) => {
    const lim = (s) => (s || "").replace(/\s+/g, " ").trim();
    const valor = (s) => { const e = document.querySelector(s); return e ? e.value : null; };
    const totales = {};
    Array.from(document.querySelectorAll("#fact-totales tr")).forEach((tr) => {
      const c = tr.querySelectorAll("td");
      if (c.length >= 2) totales[lim(c[0].innerText)] = lim(c[1].innerText);
    });
    return {
      url: location.href,
      feedback: Array.from(document.querySelectorAll(".feedbackPanel li")).map((li) => ({
        nivel: (String(li.className || "").match(/feedbackPanel(\w+)/) || ["", ""])[1],
        msg: lim(li.innerText),
      })).filter((f) => f.msg),
      productos: Array.from(document.querySelectorAll("#fact-productos tbody tr")).map((tr) => lim(tr.innerText)).filter(Boolean),
      totales,
      campos: {
        nombre: valor(sel.nombre), rfc: valor(sel.rfc), email: valor(sel.email),
        cp: valor(sel.cp), folio: valor(sel.folio), total: valor(sel.total),
      },
      descargas: Array.from(document.querySelectorAll("#descarga-Docto a"))
        .map((a) => ({ id: a.id || null, href: a.getAttribute("href") ? a.href : null, texto: lim(a.textContent) }))
        .filter((a) => a.href),
      uuid: ((document.body.innerHTML || "").match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) || [])[0] || null,
      contacto: ((document.body.innerText || "").match(/correo:\s*([\w.+-]+@[\w.-]+)/i) || [])[1] || null,
      texto: lim(document.body.innerText).slice(0, 300),
    };
  }, SEL);

  try {
    console.log("\n1) goto login?0");
    await page.goto(D.base + "login?0", { waitUntil: "networkidle2", timeout: 60000 });
    await esperarAjax(10000);
    console.log("   url:", page.url());

    let hayForm = await page.$(SEL.rfc).then((h) => !!h).catch(() => false);
    console.log("   ¿formulario ya visible?", hayForm);

    if (!hayForm) {
      console.log("\n2) click enlace invitado (reporta si lo encontro)");
      const invitado = await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {}),
        page.evaluate(() => {
          const a = Array.from(document.querySelectorAll("a, button, input[type=submit], input[type=button]"))
            .find((e) => /factura\s*al\s*instante|sin\s*registro/i.test(e.textContent || e.value || "")
              || /lblQuickInvoice/.test(e.getAttribute("onclick") || ""));
          if (!a) return false;
          a.click();
          return true;
        }),
      ]).then((r) => r[1]);
      console.log("   invitado:", invitado);
      await esperarAjax(20000);
      hayForm = await page.$(SEL.rfc).then((h) => !!h).catch(() => false);
    }
    if (!hayForm) {
      console.log("\n2b) plan B: panel publico bookmarkable");
      await page.goto(D.base + "wicket/bookmarkable/com.descargat.view.page.QuickCFDiPanel", { waitUntil: "networkidle2", timeout: 60000 });
      await esperarAjax(15000);
      hayForm = await page.$(SEL.rfc).then((h) => !!h).catch(() => false);
    }
    console.log("   FORMULARIO:", hayForm, "| url:", page.url());
    if (!hayForm) throw new Error("no se llego al formulario");

    const p0 = await leerPantalla();
    console.log("   contacto del pie:", p0.contacto);

    console.log("\n3) capturando datos");
    await teclear(SEL.nombre, D.nombre, "Nombre");
    await teclear(SEL.rfc, D.rfc, "RFC");
    await teclear(SEL.email, D.correo, "Correo");
    await page.evaluate(() => document.activeElement && document.activeElement.blur()).catch(() => {});
    await esperarAjax(10000);
    await teclear(SEL.cp, D.cp, "CP");
    await teclear(SEL.folio, D.folio, "Numero Ticket");
    await teclear(SEL.total, D.total, "Total (txtReservationId)");
    await page.evaluate(() => document.activeElement && document.activeElement.blur()).catch(() => {});
    await esperarAjax(8000);

    const rUso = await elegirPorTexto(SEL.uso, new RegExp(`^${D.uso.toLowerCase().replace(/[^a-z0-9]/g, "")}[.\\s]`), `Uso CFDI ${D.uso}`);
    const rReg = await elegirPorTexto(SEL.regimen, REGIMENES[D.regimen], `Regimen ${D.regimen}`);

    const antes = await leerPantalla();
    console.log("\n   RELECTURA de campos:", JSON.stringify(antes.campos));
    const mal = [];
    if (plano(antes.campos.rfc) !== plano(D.rfc)) mal.push("rfc");
    if (String(antes.campos.folio || "") !== D.folio) mal.push("folio");
    if (num(antes.campos.total) !== num(D.total)) mal.push("total");
    if (plano(antes.campos.email) !== plano(D.correo)) mal.push("email");
    console.log("   campos que no cuadran:", mal.length ? mal.join(", ") : "(ninguno)");

    console.log("\n4) click en '+' (CONSULTA, no emite)");
    const consulta = await page.evaluate(() => {
      const img = Array.from(document.querySelectorAll("img.boton-chico"))
        .find((i) => /queryContainer-addImage/.test(i.getAttribute("onclick") || ""));
      if (!img) return { pulsado: false, motivo: "no se encontro el '+'" };
      if (/generar\s*factura/i.test(img.title || "") || /btnExecute/.test(img.getAttribute("onclick") || "")) {
        return { pulsado: false, motivo: "ABORTADO: el localizado era el de emitir" };
      }
      img.click();
      return { pulsado: true, id: img.id || null };
    });
    console.log("   ->", JSON.stringify(consulta));
    await esperarAjax(30000);
    await sleep(1500);

    const previa = await leerPantalla();
    console.log("\n5) PREVISUALIZACION");
    console.log("   feedback DOM :", JSON.stringify(previa.feedback));
    console.log("   feedback AJAX:", JSON.stringify(feedbackAjax));
    console.log("   productos    :", JSON.stringify(previa.productos));
    console.log("   totales      :", JSON.stringify(previa.totales));
    const claveTotal = Object.keys(previa.totales || {}).find((k) => plano(k) === "total");
    const totalPortal = claveTotal ? num(previa.totales[claveTotal]) : NaN;
    console.log(`   total portal = ${totalPortal} | ticket = ${num(D.total)} | cuadra: ${Math.abs(totalPortal - num(D.total)) <= 0.02}`);
    console.log("   descargas (deben ser 0 aqui):", JSON.stringify(previa.descargas));

    const hayBoton = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("img.boton-chico"))
        .find((i) => /generar\s*factura/i.test(i.title || "") || /form-btnExecute/.test(i.getAttribute("onclick") || ""));
      return b ? { encontrado: true, id: b.id, title: b.title } : { encontrado: false };
    });
    console.log("\n6) boton que EMITE (localizado, NO pulsado):", JSON.stringify(hayBoton));

    fs.writeFileSync(path.join(__dirname, "..", ".probe-facturat", "verif_previa.txt"), await page.evaluate(() => document.body.innerText));
    try { await page.screenshot({ path: path.join(__dirname, "..", ".probe-facturat", "verif_previa.png"), fullPage: true }); } catch {}
    console.log("\n=== ALTO. No se pulsa 'Generar Factura'. ===");
  } catch (e) {
    console.error("X", e.message);
  }
  await browser.close();
  process.exit(0);
})();
