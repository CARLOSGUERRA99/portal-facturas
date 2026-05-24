const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");

// ── Helpers ───────────────────────────────────────────────────────────────

// fillInput: para inputs HTML estándar (click + ctrl+a + delete + type)
async function fillInput(page, selector, value) {
  await page.click(selector);
  await page.waitForTimeout(150);
  await page.keyboard.down("Control");
  await page.keyboard.press("a");
  await page.keyboard.up("Control");
  await page.keyboard.press("Delete");
  await page.waitForTimeout(80);
  await page.keyboard.type(String(value), { delay: 60 });
  await page.waitForTimeout(150);
  const actual = await page.$eval(selector, el => el.value).catch(() => "?");
  console.log(`📝 ${selector}: "${actual}"`);
}

// selectByText: para <select> nativos
async function selectByText(page, selector, keywords) {
  const found = await page.$eval(selector, (el, kws) => {
    const opt = Array.from(el.options).find(o =>
      kws.some(k => o.text.toLowerCase().includes(k.toLowerCase()))
    );
    if (!opt) return null;
    el.value = opt.value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("input",  { bubbles: true }));
    return opt.text;
  }, keywords);
  console.log(`📝 ${selector}: "${found || "NO ENCONTRADO"}"`);
  return !!found;
}

// fillReact: para inputs React controlados (Next.js + MUI) — sin IDs fijos.
// Busca el input por texto de label o placeholder y usa el native setter
// para que React detecte el onChange del componente controlado.
async function fillReact(page, labelOrPlaceholder, value) {
  const ok = await page.evaluate((lp, val) => {
    const normalize = s => s.toLowerCase().replace(':', '').trim();
    const lowerLp = normalize(lp);

    // 1. Por placeholder exacto
    let input = document.querySelector(`input[placeholder="${lp}"]`);

    // 2. Por label/p dentro de MuiFormControl
    if (!input) {
      const labels = document.querySelectorAll(
        'label, p.MuiFormLabel-root, .MuiInputLabel-root, p'
      );
      for (const lbl of labels) {
        if (normalize(lbl.textContent) === lowerLp) {
          const ctrl =
            lbl.closest('.MuiFormControl-root') ||
            lbl.parentElement?.parentElement;
          if (ctrl) input = ctrl.querySelector('input');
          if (input) break;
        }
      }
    }

    if (!input) return false;

    // React native setter — necesario para que React detecte el cambio
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    )?.set;
    if (nativeSetter) nativeSetter.call(input, val);
    else input.value = val;

    input.dispatchEvent(new Event('input',  { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur',   { bubbles: true }));
    return true;
  }, labelOrPlaceholder, String(value));

  console.log(`📝 React[${labelOrPlaceholder}]: ${ok ? `"${value}"` : 'NO ENCONTRADO'}`);
  return ok;
}

// fillReactNth: llena el N-ésimo input editable (0-based) usando native setter.
// Fallback cuando el label no se encuentra.
async function fillReactNth(page, nth, value) {
  await page.evaluate((n, val) => {
    const inputs = Array.from(document.querySelectorAll('input'))
      .filter(i => !i.disabled && !i.readOnly && i.type !== 'checkbox');
    const inp = inputs[n];
    if (!inp) return;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    )?.set;
    if (setter) setter.call(inp, val);
    else inp.value = val;
    inp.dispatchEvent(new Event('input',  { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    inp.dispatchEvent(new Event('blur',   { bubbles: true }));
  }, nth, String(value));
  console.log(`📝 React[nth=${nth}]: "${value}"`);
}

// selectMUI: para MUI Select (div[role="button"] que abre popover con li).
// Busca el select por texto del label superior, hace click, espera el menú
// y selecciona la opción cuyo texto contiene optionText.
async function selectMUI(page, labelText, optionText) {
  const clicked = await page.evaluate((lbl) => {
    const normalize = s => s.toLowerCase().replace(':', '').trim();
    const labels = document.querySelectorAll(
      'label, p, .MuiInputLabel-root, .MuiFormLabel-root'
    );
    for (const l of labels) {
      if (normalize(l.textContent).includes(normalize(lbl))) {
        const ctrl =
          l.closest('.MuiFormControl-root') ||
          l.parentElement?.parentElement;
        if (ctrl) {
          const sel = ctrl.querySelector('[role="button"], .MuiSelect-select');
          if (sel) { sel.click(); return true; }
        }
      }
    }
    return false;
  }, labelText);

  if (!clicked) {
    console.log(`⚠️ MUI Select "${labelText}": label no encontrado`);
    return false;
  }

  await page.waitForSelector(
    'ul[role="listbox"], .MuiMenu-list, [role="option"]',
    { visible: true, timeout: 5000 }
  );

  const selected = await page.evaluate((optText) => {
    const items = document.querySelectorAll(
      'ul[role="listbox"] li, .MuiMenu-list li, [role="option"]'
    );
    for (const item of items) {
      if (item.textContent.toLowerCase().includes(optText.toLowerCase())) {
        item.click();
        return item.textContent.trim();
      }
    }
    return null;
  }, optionText);

  await page.waitForTimeout(400);
  console.log(`📝 MUI Select[${labelText}]: "${selected || 'NO ENCONTRADO'}"`);
  return !!selected;
}

// clickSiguiente: espera que el botón SIGUIENTE esté habilitado y lo pulsa.
async function clickSiguiente(page, timeoutMs = 15000) {
  await page.waitForFunction(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const btn = btns.find(b =>
      b.textContent.trim().toUpperCase().includes('SIGUIENTE')
    );
    return btn && !btn.disabled;
  }, { timeout: timeoutMs });

  const clicked = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const btn = btns.find(b =>
      b.textContent.trim().toUpperCase().includes('SIGUIENTE')
    );
    if (btn && !btn.disabled) { btn.click(); return true; }
    return false;
  });

  if (!clicked) throw new Error("Panamá: botón SIGUIENTE no encontrado o deshabilitado");
  await page.waitForTimeout(1200);
}

// detectarCiudad: mapea el comercio del ticket a la opción del portal.
function detectarCiudad(comercio) {
  const c = (comercio || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, ''); // quitar acentos
  if (c.includes('mazatlan')) return 'Mazatlán';
  if (c.includes('culiacan')) return 'Culiacán';
  if (c.includes('mochis'))   return 'Los Mochis';
  if (c.includes('linea') || c.includes('online')) return 'Venta en Linea';
  return 'Culiacán'; // default
}

// ── Bot principal ─────────────────────────────────────────────────────────

async function facturarPanama({
  idFacturacion, total, comercio,
  rfc, razonSocial, regimenFiscal, usoCfdi, codigoPostal,
  ticketId,
}) {
  console.log("🤖 Iniciando bot Panamá Restaurante y Pastelería...");
  console.log(`   ID: ${idFacturacion} | Total: ${total} | RFC: ${rfc} | Comercio: ${comercio}`);

  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error("BROWSERLESS_TOKEN no definido");

  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true`,
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
  );
  await page.setExtraHTTPHeaders({ "Accept-Language": "es-MX,es;q=0.9,en;q=0.8" });

  const ts = ticketId || Date.now();
  async function screenshot(label) {
    try {
      const buf = await page.screenshot({ fullPage: false });
      const u = await subirArchivoR2(
        buf,
        `debug/panama_${ts}_${label}_${Date.now()}.png`,
        "image/png"
      );
      console.log(`📸 [${label}]: ${u}`);
    } catch {}
  }

  try {
    // ── PASO 0 — Cargar portal ────────────────────────────────────────────
    console.log("🌐 Cargando portal...");
    await page.goto("https://portalfacturacion.grupopanama.mx/", {
      waitUntil: "networkidle2",
      timeout: 30000,
    });
    await screenshot("p0_inicio");

    // ── PASO 1 — Click en "Generar Factura" ───────────────────────────────
    console.log("🖱️ Click en Generar Factura...");
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
      const btn = btns.find(b =>
        b.textContent.trim().toLowerCase().includes('generar factura')
      );
      if (btn) btn.click();
    });
    await page.waitForTimeout(1500);
    await screenshot("p1_generar_factura");

    // ── PASO 2 — Seleccionar ciudad (radio button) ────────────────────────
    const ciudad = detectarCiudad(comercio);
    console.log(`📍 Ciudad detectada: "${ciudad}" (comercio: "${comercio}")`);

    await page.waitForFunction(
      () => document.querySelectorAll('input[type="radio"]').length > 0,
      { timeout: 10000 }
    );

    const ciudadSel = await page.evaluate((targetCity) => {
      const normalize = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
      const target = normalize(targetCity);
      const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
      for (const radio of radios) {
        const wrapper =
          radio.closest('label') ||
          radio.closest('.MuiFormControlLabel-root') ||
          radio.parentElement?.parentElement;
        if (wrapper && normalize(wrapper.textContent).includes(target)) {
          radio.click();
          return wrapper.textContent.trim();
        }
      }
      // Fallback: primer radio (Culiacán)
      if (radios.length > 0) { radios[0].click(); return 'primer radio (fallback)'; }
      return null;
    }, ciudad);

    console.log(`✅ Ciudad seleccionada: "${ciudadSel}"`);
    await page.waitForTimeout(500);
    await screenshot("p2_ciudad");

    // ── PASO 3 — SIGUIENTE → Datos de ticket ─────────────────────────────
    console.log("➡️ Avanzando a Datos de ticket...");
    await clickSiguiente(page);
    await screenshot("p3_datos_ticket");

    // ── PASO 4 — Llenar ID de Facturación y Total ─────────────────────────
    console.log("📋 Llenando datos del ticket...");
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll('input'))
        .some(i => !i.disabled && !i.readOnly && i.type !== 'checkbox'),
      { timeout: 10000 }
    );

    // ID de Facturación — label text o primer input editable
    const idOk = await fillReact(page, "ID Facturación", String(idFacturacion).trim());
    if (!idOk) await fillReactNth(page, 0, String(idFacturacion).trim());

    await page.waitForTimeout(300);

    // Total de compra — label text o segundo input editable
    const totalOk = await fillReact(page, "Total de compra", parseFloat(total).toFixed(2));
    if (!totalOk) await fillReactNth(page, 1, parseFloat(total).toFixed(2));

    await screenshot("p4_ticket_llenado");

    // ── PASO 5 — Consultar ticket + validación AJAX ───────────────────────
    console.log("🔍 Consultando ticket...");
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const btn = btns.find(b =>
        b.textContent.trim().toLowerCase().includes('consultar ticket')
      );
      if (btn) btn.click();
    });
    await page.waitForTimeout(2500);

    const errorConsulta = await page.evaluate(() => {
      const body = document.body.innerText;
      if (/ya fue facturado|ya facturado|ya exist/i.test(body))              return 'YA_FACTURADO';
      if (/no encontrado|no existe|inv[aá]lido|incorrecto|no v[aá]lido/i.test(body)) return 'DATOS_INVALIDOS';
      return null;
    });
    await screenshot("p5_consulta_resultado");

    if (errorConsulta === 'YA_FACTURADO') {
      await browser.close();
      return { ok: false, error_code: 'ya_facturado', msg: 'Panamá: el ticket ya fue facturado' };
    }
    if (errorConsulta === 'DATOS_INVALIDOS') {
      await browser.close();
      return { ok: false, error_code: 'datos_invalidos', msg: 'Panamá: ID de facturación o total incorrecto' };
    }

    // Esperar que SIGUIENTE se habilite (ticket válido)
    console.log("⏳ Esperando validación del ticket...");
    await page.waitForFunction(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const btn = btns.find(b =>
        b.textContent.trim().toUpperCase().includes('SIGUIENTE')
      );
      return btn && !btn.disabled;
    }, { timeout: 15000 }).catch(() => {
      throw new Error('Panamá: SIGUIENTE no se habilitó — ticket inválido o sin respuesta');
    });

    // ── PASO 6 — SIGUIENTE → Datos de facturación ────────────────────────
    console.log("➡️ Avanzando a Datos de facturación...");
    await clickSiguiente(page);
    await screenshot("p6_datos_facturacion");

    // ── PASO 7 — RFC + Buscar cliente ─────────────────────────────────────
    console.log("🔍 Ingresando RFC...");
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll('input'))
        .some(i => !i.disabled && !i.readOnly && i.type !== 'checkbox'),
      { timeout: 10000 }
    );

    const rfcOk = await fillReact(page, "RFC", rfc);
    if (!rfcOk) await fillReactNth(page, 0, rfc);
    await page.waitForTimeout(400);

    console.log("🔍 Click en Buscar cliente...");
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const btn = btns.find(b =>
        b.textContent.trim().toLowerCase().includes('buscar cliente')
      );
      if (btn) btn.click();
    });
    await page.waitForTimeout(2500);

    const errorRfc = await page.evaluate(() => {
      const body = document.body.innerText;
      if (/rfc no registrado|rfc no encontrado|not found/i.test(body)) return true;
      return false;
    });
    if (errorRfc) {
      await screenshot("p7_error_rfc");
      await browser.close();
      return { ok: false, error_code: 'datos_invalidos', msg: `Panamá: RFC no encontrado (${rfc})` };
    }

    // Esperar que los datos fiscales se carguen (nombre fiscal con valor)
    console.log("⏳ Esperando carga de datos fiscales...");
    await page.waitForFunction(() => {
      const inputs = Array.from(document.querySelectorAll('input'));
      return inputs.some(i => i.value && i.value.length > 3 && !i.disabled);
    }, { timeout: 10000 }).catch(() => {
      console.log("⚠️ Timeout esperando datos fiscales, continuando...");
    });
    await screenshot("p7_datos_cargados");

    // ── PASO 8 — Forma de Pago → Efectivo (MUI Select) ───────────────────
    console.log("💵 Seleccionando Forma de Pago: Efectivo...");
    const fpOk = await selectMUI(page, "Forma Pago", "Efectivo");
    if (!fpOk) {
      // Fallback: buscar el MUI Select vacío y seleccionar Efectivo
      await page.evaluate(() => {
        const sels = document.querySelectorAll('[role="button"].MuiSelect-select, .MuiSelect-select');
        for (const sel of sels) {
          if (!sel.textContent.trim() || sel.textContent.trim() === '​') {
            sel.click();
            return;
          }
        }
      });
      await page.waitForTimeout(600);
      await page.evaluate(() => {
        const items = document.querySelectorAll('ul[role="listbox"] li, [role="option"]');
        for (const item of items) {
          if (item.textContent.toLowerCase().includes('efectivo')) {
            item.click();
            return;
          }
        }
      });
      console.log("📝 Forma de Pago (fallback): Efectivo");
    }
    await page.waitForTimeout(500);

    // ── PASO 9 — Correo ───────────────────────────────────────────────────
    console.log("📧 Ingresando correo...");
    const correoOk = await fillReact(page, "Correo", "buzonfacturas@serviciosga.site");
    if (!correoOk) {
      // Fallback: último input editable (el correo siempre es el último campo)
      await page.evaluate((val) => {
        const inputs = Array.from(document.querySelectorAll('input'))
          .filter(i => !i.disabled && !i.readOnly && i.type !== 'checkbox');
        const inp = inputs[inputs.length - 1];
        if (!inp) return;
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'value'
        )?.set;
        if (setter) setter.call(inp, val);
        else inp.value = val;
        inp.dispatchEvent(new Event('input',  { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        inp.dispatchEvent(new Event('blur',   { bubbles: true }));
      }, "buzonfacturas@serviciosga.site");
      console.log("📝 Correo (fallback): buzonfacturas@serviciosga.site");
    }
    await page.waitForTimeout(500);
    await screenshot("p8_facturacion_llenada");

    // ── PASO 10 — SIGUIENTE → Confirmación ───────────────────────────────
    console.log("➡️ Avanzando a Confirmación...");
    await clickSiguiente(page, 10000);

    await page.waitForFunction(
      () => /verif|confirm|datos correctos|facturar/i.test(document.body.innerText),
      { timeout: 10000 }
    ).catch(() => console.log("⚠️ Texto de confirmación no detectado, continuando..."));
    await screenshot("p9_confirmacion");

    // ── PASO 11 — FACTURAR — interceptar XML/PDF antes de hacer click ─────
    console.log("🧾 Emitiendo factura...");
    let xmlBuffer = null, pdfBuffer = null;

    page.on("response", async resp => {
      try {
        const ct  = resp.headers()["content-type"] || "";
        const url = resp.url().toLowerCase();
        if ((ct.includes("xml") || url.includes(".xml")) && !xmlBuffer) {
          const buf = await resp.buffer().catch(() => null);
          if (buf && buf.length > 200) {
            xmlBuffer = buf;
            console.log(`📄 XML interceptado: ${buf.length} bytes`);
          }
        }
        if ((ct.includes("pdf") || url.includes(".pdf")) && !pdfBuffer) {
          const buf = await resp.buffer().catch(() => null);
          if (buf && buf.length > 200) {
            pdfBuffer = buf;
            console.log(`📄 PDF interceptado: ${buf.length} bytes`);
          }
        }
      } catch {}
    });

    // Capturar posible nueva pestaña con los archivos
    const newPagePromise = new Promise(resolve => {
      browser.on("targetcreated", async target => {
        if (target.type() === "page") {
          const p = await target.page().catch(() => null);
          if (p) resolve(p);
        }
      });
      setTimeout(() => resolve(null), 15000);
    });

    // Click en FACTURAR (MuiButton-containedPrimary con CheckCircleIcon)
    const facturarClicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const btn = btns.find(b =>
        b.querySelector('[data-testid="CheckCircleIcon"]') ||
        b.textContent.trim().toUpperCase().includes('FACTURAR')
      );
      if (btn && !btn.disabled) { btn.click(); return true; }
      return false;
    });
    if (!facturarClicked) throw new Error("Panamá: botón FACTURAR no encontrado o deshabilitado");
    console.log("✅ Click en FACTURAR");

    await page.waitForTimeout(5000);
    await screenshot("p10_post_facturar");

    // ── PASO 12 — Descargar XML y PDF ─────────────────────────────────────
    const newTab = await newPagePromise;
    if (newTab) {
      console.log("🆕 Nueva pestaña detectada:", newTab.url?.());
      await newTab.waitForTimeout?.(2000).catch(() => {});
      try { await newTab.close(); } catch {}
    }

    // Si no capturamos nada por intercepción, intentar botones de descarga
    if (!xmlBuffer || !pdfBuffer) {
      console.log("🔗 Buscando botones de descarga XML/PDF...");
      await page.waitForTimeout(2000);

      const clickBtn = async (textMatch) => {
        return page.evaluate((txt) => {
          const btns = Array.from(document.querySelectorAll('button, a'));
          const btn = btns.find(b =>
            b.textContent.trim().toUpperCase().includes(txt)
          );
          if (btn) { btn.click(); return true; }
          return false;
        }, textMatch);
      };

      if (!xmlBuffer && await clickBtn("XML")) await page.waitForTimeout(2000);
      if (!pdfBuffer && await clickBtn("PDF")) await page.waitForTimeout(2000);
    }

    await screenshot("p11_descarga");

    // Subir a R2
    let xmlUrl = null, pdfUrl = null;

    if (xmlBuffer && xmlBuffer.length > 200) {
      const preview = xmlBuffer.toString("utf8", 0, 30);
      if (preview.includes("<?") || preview.includes("<cfdi") || preview.includes("<Comprobante")) {
        xmlUrl = await subirArchivoR2(xmlBuffer, `facturas/panama_${ts}.xml`, "application/xml");
        console.log("✅ XML subido:", xmlUrl);
      } else {
        console.log("⚠️ Buffer XML no parece CFDI — preview:", preview);
      }
    }
    if (pdfBuffer && pdfBuffer.length > 200) {
      pdfUrl = await subirArchivoR2(pdfBuffer, `facturas/panama_${ts}.pdf`, "application/pdf");
      console.log("✅ PDF subido:", pdfUrl);
    }

    await browser.close();

    if (!xmlUrl && !pdfUrl) {
      console.log("📧 Sin descarga directa — IMAP recogerá del correo");
      return { ok: true, procesandoCorreo: true };
    }

    console.log(`✅ Panamá OK — XML: ${xmlUrl} | PDF: ${pdfUrl}`);
    return { ok: true, xmlUrl, pdfUrl };

  } catch (err) {
    console.error("❌ Error en bot Panamá:", err.message);
    await screenshot("error").catch(() => {});
    try { await browser.close(); } catch {}
    return { ok: false, msg: err.message };
  }
}

module.exports = { facturarPanama };
