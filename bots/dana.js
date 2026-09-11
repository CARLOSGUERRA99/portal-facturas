const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");

// Bot Dana Comida Mexicana — SoftRestaurant (AutoFactura), variante con IDs propios:
//   #unicCode (Código facturación) · #folio (Folio) · #RFC · button.btn-success "Facturar"
// Misma familia que SushiO pero distintos selectores (por eso bot dedicado).

async function fillInput(page, selector, value) {
  await page.click(selector);
  await page.waitForTimeout(120);
  await page.keyboard.down("Control"); await page.keyboard.press("a"); await page.keyboard.up("Control");
  await page.keyboard.press("Delete");
  await page.waitForTimeout(60);
  await page.keyboard.type(String(value), { delay: 50 });
  await page.waitForTimeout(120);
}

// Detección de estado por el texto visible (vencido / ya facturado / inválido).
async function detectarEstado(page) {
  return await page.evaluate(() => {
    const t = document.body.innerText || "";
    if (/se\s+venci[oó]|venci[oó]\s+el|vencid[ao]|caduc(ó|o|ad[ao])|expir(ó|o|ad[ao])|fuera\s+de\s+(tiempo|plazo)|ya\s+no\s+(se\s+)?puede[ns]?\s+factur/i.test(t)) return "vencido";
    if (/ya\s+(fue|est[aá]|ha\s+sido)\s+(facturad|generad)|ya\s+facturad|cfdi\s+ya|comprobante\s+ya\s+generad|factura\s+ya\s+(generad|emitid)/i.test(t)) return "ya_facturado";
    if (/no\s+(se\s+)?(encontr[oó]|existe)|ticket\s+inv[aá]lido|datos\s+(incorrectos|no\s+v[aá]lidos)|no\s+v[aá]lido|c[oó]digo.*(incorrect|inv[aá]lid)|sin\s+resultados/i.test(t)) return "invalido";
    return null;
  }).catch(() => null);
}

async function extraerEmailContacto(page) {
  return await page.evaluate(() => {
    const link = document.querySelector('a[href^="mailto:"]');
    if (link) return link.href.replace("mailto:", "").split("?")[0].trim().toLowerCase();
    const m = (document.body.innerText || "").match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/);
    return m ? m[0].toLowerCase() : null;
  }).catch(() => null);
}

async function facturarDana({ referencia, folio, total, rfc, razonSocial, regimenFiscal, usoCfdi,
                              codigoPostal, emailEntrega, ticketId, portalUrl }) {
  const codigoUnico = String(referencia || folio || "").trim();
  const folioStr = String(folio || referencia || "").trim();

  console.log("🤖 Iniciando bot Dana (SoftRestaurant)...");
  console.log(`   Código: ${codigoUnico} | Folio: ${folioStr} | RFC: ${rfc}`);

  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error("BROWSERLESS_TOKEN no definido");

  let browser;
  try {
    browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  } catch (e) {
    return { ok: false, msg: `Dana: no se pudo conectar al browser — ${e.message}` };
  }

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");
  await page.setExtraHTTPHeaders({ "Accept-Language": "es-MX,es;q=0.9,en;q=0.8" });

  const ts = ticketId || Date.now();
  const snap = async (label) => {
    try {
      const buf = await page.screenshot({ fullPage: false });
      const u = await subirArchivoR2(buf, `debug/dana_${ts}_${label}_${Date.now()}.png`, "image/png");
      console.log(`📸 [${label}]: ${u}`);
    } catch {}
  };

  // Se pone en true en cuanto sale el click que EMITE la factura. A partir de
  // ese instante ningun camino puede devolver un error reintentable: el
  // reintento de medianoche emitiria un segundo CFDI al mismo ticket.
  let timbradoDisparado = false;

  try {
    const url = portalUrl || "https://facturacion.softrestaurant.com/DANACOMIDAMEXICANA";
    console.log(`🌐 Cargando portal Dana: ${url}`);
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    await page.waitForTimeout(2500);
    await snap("p0_inicio");

    let emailContacto = await extraerEmailContacto(page);
    console.log(`📧 Email contacto del portal: ${emailContacto}`);

    // ── Llenar formulario: Código facturación + Folio + RFC ──────────────────
    await page.waitForSelector("#unicCode", { visible: true, timeout: 15000 });
    await fillInput(page, "#unicCode", codigoUnico);
    const hayFolio = await page.$("#folio").catch(() => null);
    if (hayFolio) await fillInput(page, "#folio", folioStr);
    await fillInput(page, "#RFC", rfc);
    await snap("p1_formulario");

    // ── Click "Facturar" (button.btn-success) ────────────────────────────────
    console.log("🖱️ Click en Facturar...");
    const clicOk = await page.evaluate(() => {
      const cand = Array.from(document.querySelectorAll("button, a, input[type='submit'], .btn"));
      const btn = cand.find(b => /^facturar$/i.test((b.textContent || b.value || "").trim()))
        || cand.find(b => /facturar/i.test((b.textContent || b.value || "")) && !/consultar|regresar|buscar/i.test((b.textContent || b.value || "")));
      if (btn) { btn.click(); return true; }
      return false;
    });

    if (!clicOk) {
      await page.waitForTimeout(1200);
      const estadoSinBoton = await detectarEstado(page);
      await snap(`error_sin_boton_${estadoSinBoton || "desconocido"}`);
      emailContacto = (await extraerEmailContacto(page)) || emailContacto;
      await browser.close();
      if (estadoSinBoton === "ya_facturado") return { ok: false, error_code: "ya_facturado", msg: "Dana: el ticket ya fue facturado" };
      if (estadoSinBoton === "invalido") return { ok: false, error_code: "datos_invalidos", msg: "Dana: ticket no encontrado o datos incorrectos" };
      return { ok: false, error_code: "ticket_vencido", email_contacto: emailContacto, permite_solicitud_correo: true,
        msg: estadoSinBoton === "vencido" ? "El plazo para facturar este ticket en Dana ha vencido — solicítalo por correo" : "Dana no permitió facturar en línea — solicita la factura por correo" };
    }

    // ── Detectar resultado (polling) ─────────────────────────────────────────
    let caso = "timeout";
    for (let i = 0; i < 30; i++) {
      // ⚠️ Algunos tenants de SoftRestaurant abren un modal informativo
      // ("Facturación electrónica CFDI 4.0 … Aceptar") ENCIMA del formulario ya
      // cargado. El bot se quedaba esperando el paso 2 mientras el paso 2 ya
      // estaba ahí, solo que tapado, y acababa en "timeout esperando respuesta
      // del portal" — que parece portal caído y no lo es. Visto en vivo con
      // mefacturo.com/chayitocentro (ticket #349).
      await page.evaluate(() => {
        const b = Array.from(document.querySelectorAll("button, a, input[type=button], .swal2-confirm"))
          .filter((x) => x.offsetParent)
          .find((x) => /^\s*(aceptar|entendido|de acuerdo|continuar)\s*$/i.test((x.textContent || x.value || "").trim()));
        if (b) b.click();
      }).catch(() => {});

      const estado = await detectarEstado(page);
      if (estado) { caso = estado; break; }
      const hayPaso2 = await page.evaluate(() => {
        // Se acepta cualquier campo de correo visible: cada tenant le pone un
        // id distinto, y fiarse de una lista corta dejaba fuera a los nuevos.
        const cands = Array.from(document.querySelectorAll("input"));
        return cands.some((el) => {
          if (!el.offsetParent) return false;
          const pista = `${el.id} ${el.name} ${el.placeholder} ${el.type}`.toLowerCase();
          return /mail|correo/.test(pista);
        });
      }).catch(() => false);
      if (hayPaso2) { caso = "paso2"; break; }
      await page.waitForTimeout(500);
    }
    await snap(`p2_${caso}`);
    console.log(`   Resultado: ${caso}`);

    if (caso === "vencido") {
      emailContacto = (await extraerEmailContacto(page)) || emailContacto;
      await browser.close();
      return { ok: false, error_code: "ticket_vencido", email_contacto: emailContacto, permite_solicitud_correo: true, msg: "El plazo para facturar este ticket en Dana ha vencido" };
    }
    if (caso === "ya_facturado") { await browser.close(); return { ok: false, error_code: "ya_facturado", msg: "Dana: el ticket ya fue facturado" }; }
    if (caso === "invalido")     { await browser.close(); return { ok: false, error_code: "datos_invalidos", msg: "Dana: ticket no encontrado o datos incorrectos" }; }
    if (caso === "timeout")      { await browser.close(); return { ok: false, error_code: "timeout", msg: "Dana: timeout esperando respuesta del portal" }; }

    // ── PASO 2 — Datos fiscales y timbrado ───────────────────────────────────
    //
    // ⚠️ AQUÍ VIVÍA EL PEOR BUG QUE HA TENIDO ESTE PROYECTO. La versión anterior
    // buscaba un botón con /facturar|generar|emitir|timbrar|continuar/, no lo
    // encontraba (en esta pantalla los botones se llaman "Guardar" y
    // "Siguiente »"), no avisaba de que no había encontrado nada, esperaba 30s
    // un texto de éxito que nunca podía llegar y terminaba en:
    //
    //     if (!generado) return { ok: true, procesandoCorreo: true };
    //
    // Es decir: declaraba TIMBRADO un ticket en el que no se había pulsado ni un
    // botón. Los tickets #349 y #356 quedaron dados por facturados con CERO
    // facturas en el portal. Un falso positivo así no se descubre hasta que
    // vence el plazo del portal y la factura ya es irrecuperable.
    //
    // Regla que sustituye a aquello, y que NO se debe relajar:
    //   · ok:true SOLO si vimos la pantalla de descarga (UUID/folio/enlaces).
    //   · Si no llegamos a pulsar el "Facturar" final → error controlado
    //     (`reintentar_despues`): no se emitió nada, reintentar es seguro.
    //   · Si SÍ lo pulsamos y luego perdimos el hilo → procesandoCorreo con un
    //     mensaje que grita "no relanzar": puede haberse emitido, y reintentar
    //     duplicaría el CFDI.
    //
    // ── El flujo real del wizard (mapeado en vivo en brokinnibistrot) ────────
    //   1. Modal informativo "Facturación electrónica CFDI 4.0 … Aceptar".
    //   2. Modal "Nuevo Cliente – Datos Fiscales" si el RFC no está en el
    //      catálogo de ESE tenant (cada restaurante tiene el suyo).
    //   3. Pestaña Cliente → "Siguiente »" → pestaña Previsualizar.
    //   4. "Facturar" → modal "¿Estás seguro…?" → "Aceptar" → NAVEGA a
    //      /Invoice/DownloadFiles con los enlaces DownLoadXML / DownLoadPDF.
    //
    // ⚠️ TRAMPA DEL PORTAL: el <select id="ListTaxRegimes"> llega VACÍO del
    // servidor (`<select id="ListTaxRegimes"></select>`, cero <option>). No es
    // que tarde: no los manda. Hay que escribir el hidden #TaxRegime a mano y
    // solo entonces llamar a GetProofuse(), que es quien rellena el catálogo de
    // Uso de CFDI dentro de #ProofUseView (#usecode + hidden #UseCode).
    console.log("✅ Ticket válido — completando datos fiscales...");
    await page.waitForTimeout(1200);

    const correoPortal = emailEntrega || "buzonfacturas@serviciosga.site";

    // Cierra el modal informativo de CFDI 4.0 si sigue encima.
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("button, a, input[type=button]"))
        .filter((x) => x.offsetParent)
        .find((x) => /^\s*(aceptar|entendido|de acuerdo)\s*$/i.test((x.textContent || x.value || "").trim()));
      if (b) b.click();
    }).catch(() => {});
    await page.waitForTimeout(800);

    const esWizard = await page.evaluate(() =>
      !!document.getElementById("TaxRegime") || !!document.getElementById("ListTaxRegimes")
    ).catch(() => false);

    if (esWizard) {
      console.log("🧭 Wizard SoftRestaurant (Cliente → Previsualizar)");

      // ── Modal "Nuevo Cliente – Datos Fiscales" ────────────────────────────
      const hayModalCliente = await page.evaluate(() => {
        const n = document.getElementById("Name");
        return !!(n && n.offsetParent);
      }).catch(() => false);

      if (hayModalCliente) {
        console.log("👤 Alta de cliente nuevo en este tenant...");
        const datosOk = await page.evaluate(
          (d) => {
            const set = (id, v) => {
              const e = document.getElementById(id);
              if (!e || v == null || v === "") return false;
              e.focus();
              e.value = String(v);
              ["input", "change", "keyup", "blur"].forEach((ev) => e.dispatchEvent(new Event(ev, { bubbles: true })));
              return e.value === String(v);
            };
            // Régimen: el <select> viene vacío del servidor → se inyecta la
            // opción y se escribe el hidden que es lo que de verdad se envía.
            const lt = document.getElementById("ListTaxRegimes");
            if (lt) {
              if (!Array.from(lt.options).some((o) => o.value === d.regimen)) {
                const o = document.createElement("option");
                o.value = d.regimen;
                o.text = d.regimen;
                lt.appendChild(o);
              }
              lt.value = d.regimen;
              lt.dispatchEvent(new Event("change", { bubbles: true }));
            }
            const tr = document.getElementById("TaxRegime");
            if (tr) tr.value = d.regimen;

            return {
              rfc: set("RFC", d.rfc),
              nombre: set("Name", d.razonSocial),
              correo: set("Email", d.correo),
              cp: set("CustomerAddress_Code", d.cp),
              regimen: tr ? tr.value : null,
            };
          },
          { rfc, razonSocial, correo: correoPortal, cp: String(codigoPostal || ""), regimen: String(regimenFiscal || "601") }
        );
        console.log("   Campos:", JSON.stringify(datosOk));

        if (!datosOk.nombre || !datosOk.cp) {
          await snap("error_datos_cliente");
          await browser.close();
          return {
            ok: false,
            error_code: "datos_invalidos",
            msg: `Dana/SoftRestaurant: faltan datos fiscales del receptor para dar de alta el cliente (razón social: ${razonSocial || "vacía"}, C.P.: ${codigoPostal || "vacío"}). No se emitió nada.`,
          };
        }

        // Uso de CFDI: solo existe después de llamar a GetProofuse().
        await page.evaluate(() => { if (typeof GetProofuse === "function") GetProofuse(); }).catch(() => {});
        const hayUso = await page
          .waitForFunction(() => {
            const s = document.getElementById("usecode");
            return !!(s && s.options.length > 1);
          }, { timeout: 20000 })
          .then(() => true)
          .catch(() => false);

        if (!hayUso) {
          await snap("error_sin_usocfdi");
          await browser.close();
          return { ok: false, error_code: "reintentar_despues", msg: "Dana/SoftRestaurant: el portal no cargó el catálogo de Uso de CFDI. No se emitió nada." };
        }

        const usoPuesto = await page.evaluate((uso) => {
          const s = document.getElementById("usecode");
          const opt = Array.from(s.options).find((o) => o.value === uso) || Array.from(s.options).find((o) => o.value === "G03");
          if (!opt) return null;
          s.value = opt.value;
          s.dispatchEvent(new Event("change", { bubbles: true }));
          const h = document.getElementById("UseCode");
          if (h) h.value = opt.value;
          return opt.value;
        }, String(usoCfdi || "G03"));
        console.log(`   Uso CFDI: ${usoPuesto}`);
        await snap("p3_datos_fiscales");

        const guardado = await page.evaluate(() => {
          const b = Array.from(document.querySelectorAll("button, a, input[type=button], input[type=submit]"))
            .filter((x) => x.offsetParent)
            .find((x) => /^\s*guardar\s*$/i.test((x.textContent || x.value || "").trim()));
          if (!b) return false;
          b.click();
          return true;
        });
        if (!guardado) {
          await snap("error_sin_guardar");
          await browser.close();
          return { ok: false, error_code: "reintentar_despues", msg: "Dana/SoftRestaurant: no apareció el botón Guardar del alta de cliente. No se emitió nada." };
        }

        // El modal se cierra solo cuando el alta fue aceptada; si sigue abierto
        // es que el portal rechazó algún dato y NO hay que seguir adelante.
        const modalCerrado = await page
          .waitForFunction(() => {
            const n = document.getElementById("Name");
            return !n || !n.offsetParent;
          }, { timeout: 25000 })
          .then(() => true)
          .catch(() => false);

        if (!modalCerrado) {
          const motivo = await page.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 240)).catch(() => "");
          await snap("error_alta_cliente_rechazada");
          await browser.close();
          return { ok: false, error_code: "datos_invalidos", msg: `Dana/SoftRestaurant: el portal rechazó el alta del receptor. No se emitió nada. Pantalla: ${motivo}` };
        }
        console.log("   ✅ Cliente dado de alta");
      }

      // ── Cliente → Previsualizar ───────────────────────────────────────────
      await page.waitForTimeout(1200);
      const avanzo = await page.evaluate(() => {
        const b = Array.from(document.querySelectorAll("button, a, input[type=button], input[type=submit]"))
          .filter((x) => x.offsetParent)
          .find((x) => /siguiente/i.test((x.textContent || x.value || "")));
        if (!b) return false;
        b.click();
        return true;
      });
      if (!avanzo) {
        await snap("error_sin_siguiente");
        await browser.close();
        return { ok: false, error_code: "reintentar_despues", msg: "Dana/SoftRestaurant: no apareció el botón 'Siguiente »' del wizard. No se emitió nada." };
      }

      const enPrevisualizar = await page
        .waitForFunction(() => {
          const t = (document.body.innerText || "");
          const hayBoton = Array.from(document.querySelectorAll("button, a, input[type=button], input[type=submit]"))
            .some((x) => x.offsetParent && /^\s*facturar\s*$/i.test((x.textContent || x.value || "").trim()));
          return hayBoton && /previsualizar/i.test(t);
        }, { timeout: 30000 })
        .then(() => true)
        .catch(() => false);

      if (!enPrevisualizar) {
        await snap("error_sin_previsualizar");
        await browser.close();
        return { ok: false, error_code: "reintentar_despues", msg: "Dana/SoftRestaurant: el wizard no llegó a la pantalla de previsualización. No se emitió nada." };
      }
      await snap("p4_previsualizar");

      // ── EL CLICK QUE EMITE ────────────────────────────────────────────────
      // A partir de aquí `timbradoDisparado` queda en true y NINGÚN camino
      // puede devolver un error reintentable: la factura puede existir ya.
      console.log("🧾 Facturar → confirmar...");
      await page.evaluate(() => {
        const b = Array.from(document.querySelectorAll("button, a, input[type=button], input[type=submit]"))
          .filter((x) => x.offsetParent)
          .find((x) => /^\s*facturar\s*$/i.test((x.textContent || x.value || "").trim()));
        if (b) b.click();
      });

      const hayConfirmacion = await page
        .waitForFunction(() =>
          Array.from(document.querySelectorAll("button, a, input[type=button]"))
            .some((x) => x.offsetParent && /^\s*aceptar\s*$/i.test((x.textContent || x.value || "").trim()))
          && /seguro|confirmar|deseas generar/i.test(document.body.innerText || ""), { timeout: 15000 })
        .then(() => true)
        .catch(() => false);

      if (!hayConfirmacion) {
        await snap("error_sin_confirmacion");
        await browser.close();
        return { ok: false, error_code: "reintentar_despues", msg: "Dana/SoftRestaurant: no apareció el modal de confirmación tras pulsar Facturar. No se emitió nada." };
      }

      // El "Aceptar" del modal NAVEGA a /Invoice/DownloadFiles. Sin el
      // waitForNavigation, el evaluate siguiente muere con "Execution context
      // was destroyed" y el catch devolvería un error reintentable sobre una
      // factura que YA se emitió — la receta exacta del CFDI duplicado.
      timbradoDisparado = true;
      await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle2", timeout: 90000 }).catch(() => {}),
        page.evaluate(() => {
          const bs = Array.from(document.querySelectorAll("button, a, input[type=button]"))
            .filter((x) => x.offsetParent && /^\s*aceptar\s*$/i.test((x.textContent || x.value || "").trim()));
          if (bs.length) bs[bs.length - 1].click();
        }),
      ]);

      await page.waitForFunction(
        () => /ya puedes descargar|descargar tu factura/i.test(document.body.innerText || "")
          || /DownloadFiles/i.test(location.href),
        { timeout: 90000 }
      ).catch(() => {});
      await page.waitForTimeout(1500);
      await snap("p5_resultado_final");

      const res = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll("a[href]"));
        const xml = links.find((a) => /DownLoadXML/i.test(a.href));
        const pdf = links.find((a) => /DownLoadPDF/i.test(a.href));
        const mUuid = (location.href + " " + document.body.innerHTML).match(/uuid=([0-9a-f-]{36})/i);
        const mFolio = (document.body.innerText || "").match(/Folio\s+([A-Z0-9-]+)/i);
        return {
          xml: xml ? xml.href : null,
          pdf: pdf ? pdf.href : null,
          uuid: mUuid ? mUuid[1] : null,
          folio: mFolio ? mFolio[1] : null,
          url: location.href,
          texto: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 200),
        };
      }).catch(() => ({}));

      // Prueba de que se timbró: un UUID o los enlaces de descarga del portal.
      if (!res.uuid && !res.xml) {
        await browser.close();
        console.log(`⚠️ Sin evidencia de timbrado en pantalla: ${res.texto || "(sin texto)"}`);
        return {
          ok: true,
          procesandoCorreo: true,
          msg: `Dana/SoftRestaurant: se pulsó el Facturar final pero la pantalla de descarga no apareció. NO RELANZAR este ticket sin comprobar antes en el portal (Consultar comprobantes → RFC ${rfc}): la factura puede estar emitida y un reintento crearía un CFDI duplicado.`,
        };
      }

      console.log(`✅ Timbrado — UUID ${res.uuid} folio ${res.folio}`);

      // Los enlaces llevan un token firmado y de un solo uso: hay que bajarlos
      // dentro de la sesión del navegador, no desde Node.
      const bajar = async (url) => {
        if (!url) return null;
        const d = await page.evaluate(async (u) => {
          try {
            const r = await fetch(u, { credentials: "include" });
            const b = await r.arrayBuffer();
            return { ok: r.ok, bytes: Array.from(new Uint8Array(b)) };
          } catch (e) { return { error: e.message }; }
        }, url).catch(() => null);
        if (!d || !d.ok || !d.bytes || !d.bytes.length) return null;
        return Buffer.from(d.bytes);
      };

      const bufXml = await bajar(res.xml);
      const bufPdf = await bajar(res.pdf);
      const base = res.uuid || `dana_${ts}`;
      let xmlUrl = null, pdfUrl = null;
      try { if (bufXml) xmlUrl = await subirArchivoR2(bufXml, `facturas/${base}.xml`, "application/xml"); } catch {}
      try { if (bufPdf) pdfUrl = await subirArchivoR2(bufPdf, `facturas/${base}.pdf`, "application/pdf"); } catch {}
      await browser.close();

      if (xmlUrl || pdfUrl) {
        console.log(`✅ Dana OK — XML: ${xmlUrl} | PDF: ${pdfUrl}`);
        return { ok: true, xmlUrl, pdfUrl, uuid: res.uuid };
      }
      // Se timbró de verdad (hay UUID) pero no se pudo bajar el archivo: el
      // portal también lo manda al correo de entrega, así que IMAP lo recoge.
      return {
        ok: true,
        procesandoCorreo: true,
        uuid: res.uuid,
        msg: `Dana/SoftRestaurant: CFDI ${res.uuid} emitido; la descarga directa falló y se espera por correo. NO RELANZAR.`,
      };
    }

    // ── Variante antigua (formulario simple de una sola pantalla) ────────────
    await page.evaluate((correo) => {
      const campos = Array.from(document.querySelectorAll("input"))
        .filter((el) => el.offsetParent && /mail|correo/i.test(`${el.id} ${el.name} ${el.placeholder} ${el.type}`));
      for (const inp of campos) {
        inp.value = correo;
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        inp.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }, correoPortal);

    if (regimenFiscal) {
      await page.evaluate((reg) => {
        const sel = document.querySelector("#RegimenFiscal, #Regimen, select[name*='regimen']");
        if (!sel) return;
        for (const opt of sel.options) {
          if (opt.value === reg || opt.text.includes(reg)) { sel.value = opt.value; sel.dispatchEvent(new Event("change", { bubbles: true })); return; }
        }
      }, String(regimenFiscal));
    }
    await snap("p3_datos_fiscales");

    console.log("🧾 Generando factura...");
    const clicGenerar = await page.evaluate(() => {
      const cand = Array.from(document.querySelectorAll("button, a, input[type='submit'], .btn")).filter((x) => x.offsetParent);
      const btn = cand.find((b) => /facturar|generar|emitir|timbrar/i.test((b.textContent || b.value || "")) && !/consultar|regresar|buscar/i.test((b.textContent || b.value || "")));
      if (!btn) return false;
      btn.click();
      return true;
    });

    // Si el botón no existe, NO se emitió nada: error reintentable, nunca
    // `procesandoCorreo`. Este era exactamente el camino del falso positivo.
    if (!clicGenerar) {
      const pantalla = await page.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 240)).catch(() => "");
      await snap("error_sin_boton_generar");
      await browser.close();
      return { ok: false, error_code: "reintentar_despues", msg: `Dana: no se encontró el botón para generar la factura. NO se emitió nada. Pantalla: ${pantalla}` };
    }
    timbradoDisparado = true;

    const generado = await page.waitForFunction(
      () => /factura\s+generada|ya puedes descargar|exitosamente|\.xml|\.pdf|ya ha sido generada/i.test(document.body.innerText),
      { timeout: 45000 }
    ).then(() => true).catch(() => false);
    await snap("p4_resultado_final");

    const xmlUrl = await page.evaluate(() => { const a = Array.from(document.querySelectorAll("a[href]")).find(a => /\.xml(\?|$)|DownLoadXML|descargar.*xml|xml.*descargar/i.test(a.href + " " + a.textContent)); return a?.href || null; }).catch(() => null);
    const pdfUrl = await page.evaluate(() => { const a = Array.from(document.querySelectorAll("a[href]")).find(a => /\.pdf(\?|$)|DownLoadPDF|descargar.*pdf|pdf.*descargar/i.test(a.href + " " + a.textContent)); return a?.href || null; }).catch(() => null);
    await browser.close();

    if (xmlUrl || pdfUrl) { console.log(`✅ Dana OK — XML: ${xmlUrl} | PDF: ${pdfUrl}`); return { ok: true, xmlUrl, pdfUrl }; }
    if (!generado) {
      return { ok: true, procesandoCorreo: true, msg: `Dana: se pulsó generar pero el portal no confirmó en pantalla. NO RELANZAR sin comprobar antes en el portal: la factura puede estar emitida.` };
    }
    console.log("📧 Sin descarga directa — fallback IMAP");
    return { ok: true, procesandoCorreo: true };

  } catch (err) {
    console.error("❌ Error en bot Dana:", err.message);
    await snap("error").catch(() => {});
    try { await browser.close(); } catch {}
    // Si la excepcion salto DESPUES del click que emite, devolver un error
    // seria peor que no devolver nada: la cola reintentaria y duplicaria el
    // CFDI. "Execution context was destroyed" es justo eso — el click navego.
    if (timbradoDisparado) {
      return {
        ok: true,
        procesandoCorreo: true,
        msg: `Dana/SoftRestaurant: el click de facturar ya habia salido cuando fallo el bot (${err.message}). NO RELANZAR: comprobar primero en el portal (Consultar comprobantes → RFC ${rfc}) si el CFDI ya existe.`,
      };
    }
    return { ok: false, error_code: "reintentar_despues", msg: `Dana: ${err.message} (no se emitio nada)` };
  }
}

module.exports = { facturarDana };
