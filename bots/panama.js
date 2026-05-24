const puppeteer = require("puppeteer");
const { subirArchivoR2 } = require("../storage/r2");

// ── Helpers ───────────────────────────────────────────────────────────────

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

    // 3. Por type="email" (campo Correo en portales Next.js)
    if (!input && (lowerLp.includes('correo') || lowerLp.includes('email') || lowerLp.includes('mail'))) {
      const emailInputs = Array.from(document.querySelectorAll('input[type="email"]'));
      if (emailInputs.length === 1) {
        input = emailInputs[0];
      } else if (emailInputs.length > 1) {
        for (const ei of emailInputs) {
          const ctrl = ei.closest('.MuiFormControl-root') || ei.parentElement?.parentElement;
          if (ctrl && normalize(ctrl.textContent).includes(lowerLp)) {
            input = ei;
            break;
          }
        }
        if (!input) input = emailInputs[emailInputs.length - 1]; // último email input como fallback
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

// selectMUI: para MUI Select en portales Next.js + MUI v5.
// Estrategia 1: búsqueda por label. Si falla → estrategia 2: prueba cada select
// hasta encontrar el que contiene la opción buscada (cierra con Escape los incorrectos).
async function selectMUI(page, labelText, optionText) {
  console.log(`🎯 selectMUI: buscando "${labelText}" → "${optionText}"`);

  // Esperar y hacer click en las opciones del listbox abierto. Retorna el texto seleccionado o null.
  async function elegirOpcion() {
    // MUI v5 anima la apertura — esperar a que los <li> existan
    await page.waitForFunction(
      () => document.querySelectorAll('ul[role="listbox"] li, [role="option"], .MuiMenuItem-root').length > 0,
      { timeout: 3000 }
    ).catch(() => {});

    const handles = await page.$$('ul[role="listbox"] li, [role="option"], .MuiMenuItem-root');
    const texts   = await Promise.all(handles.map(h => h.evaluate(el => el.textContent.trim()).catch(() => '')));

    for (let i = 0; i < handles.length; i++) {
      if (texts[i].toLowerCase().includes(optionText.toLowerCase())) {
        await handles[i].click();
        await page.waitForTimeout(500);
        return texts[i];
      }
    }
    return null; // opción no encontrada en este listbox
  }

  // ── Estrategia 1: búsqueda por label ─────────────────────────────────────
  const selectHandle = await page.evaluateHandle((lbl) => {
    const normalize = s => s.toLowerCase().replace(':', '').trim();
    const lowerLp   = normalize(lbl);

    // 1a. Buscar en elementos típicos de label
    const labelEls = document.querySelectorAll(
      'label, p, span, .MuiFormLabel-root, .MuiInputLabel-root, legend'
    );
    for (const l of labelEls) {
      if (l.children.length > 3) continue; // saltar contenedores grandes
      const txt = normalize(l.textContent);
      if (!txt.includes(lowerLp)) continue;
      const ctrl = l.closest('.MuiFormControl-root') || l.parentElement;
      if (ctrl) {
        const sel = ctrl.querySelector(
          '[role="combobox"], [role="button"], .MuiSelect-select'
        );
        if (sel) return sel;
      }
    }

    // 1b. Recorrer todos los .MuiFormControl-root y comparar su texto interno
    for (const ctrl of document.querySelectorAll('.MuiFormControl-root')) {
      for (const child of ctrl.querySelectorAll('label, p, span, legend')) {
        if (child.children.length > 2) continue;
        if (normalize(child.textContent).includes(lowerLp)) {
          const sel = ctrl.querySelector('[role="combobox"], [role="button"], .MuiSelect-select');
          if (sel) return sel;
        }
      }
    }

    return null;
  }, labelText);

  const selectEl = selectHandle ? selectHandle.asElement() : null;

  if (selectEl) {
    await selectEl.scrollIntoView().catch(() => {});
    await selectEl.click();
    await page.waitForSelector('ul[role="listbox"]', { visible: true, timeout: 5000 }).catch(() => {});
    const chosen = await elegirOpcion();
    if (chosen) {
      console.log(`📝 MUI Select["${labelText}"]: seleccionado "${chosen}"`);
      return true;
    }
    // Listbox apareció pero opción no encontrada — cerrar
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(300);
  }

  // ── Estrategia 2: probar cada select hasta encontrar el correcto ──────────
  console.log(`⚠️ selectMUI: label "${labelText}" no hallado — probando cada select`);

  const allSelects = await page.$$('.MuiSelect-select, [role="combobox"]');
  for (const sel of allSelects) {
    const isDisabled = await sel.evaluate(el =>
      el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled')
    ).catch(() => false);
    if (isDisabled) continue;

    // Scroll y click
    await sel.evaluate(el => el.scrollIntoView({ block: 'center' })).catch(() => {});
    await sel.click();

    const appeared = await page.waitForSelector('ul[role="listbox"]', { visible: true, timeout: 3000 })
      .then(() => true).catch(() => false);

    if (!appeared) continue;

    const chosen = await elegirOpcion();
    if (chosen) {
      console.log(`📝 MUI Select["${labelText}"]: seleccionado "${chosen}" (fallback por opciones)`);
      return true;
    }

    // Opción no estaba en este select — cerrar y probar siguiente
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(400);
  }

  console.log(`❌ selectMUI: "${optionText}" no encontrado en ningún select de la página`);
  return false;
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

  // Obtener handle real para el click
  const btnHandle = await page.evaluateHandle(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    return btns.find(b =>
      b.textContent.trim().toUpperCase().includes('SIGUIENTE') && !b.disabled
    );
  });
  const el = btnHandle ? btnHandle.asElement() : null;
  if (el) {
    await el.click();
  } else {
    throw new Error("Panamá: botón SIGUIENTE no encontrado o deshabilitado");
  }
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
  if (!token) {
    console.error("❌ BROWSERLESS_TOKEN no definido");
    return { ok: false, msg: "BROWSERLESS_TOKEN no definido" };
  }

  // ── Conexión Browserless — en su propio try-catch ─────────────────────
  let browser;
  try {
    browser = await puppeteer.connect({
      browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true`,
    });
    console.log("✅ Browserless conectado");
  } catch (connErr) {
    console.error("❌ Panamá: Error conectando a Browserless:", connErr.message);
    return { ok: false, msg: `Browserless connection failed: ${connErr.message}` };
  }

  let page;
  try {
    page = await browser.newPage();
  } catch (pageErr) {
    console.error("❌ Panamá: Error abriendo página:", pageErr.message);
    try { await browser.close(); } catch {}
    return { ok: false, msg: `newPage failed: ${pageErr.message}` };
  }

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
    } catch (e) {
      console.log(`⚠️ screenshot fallido [${label}]: ${e.message}`);
    }
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
    const gfHandle = await page.evaluateHandle(() => {
      const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
      return btns.find(b => b.textContent.trim().toLowerCase().includes('generar factura')) || null;
    });
    const gfEl = gfHandle ? gfHandle.asElement() : null;
    if (gfEl) {
      await gfEl.click();
    } else {
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
        const btn = btns.find(b => b.textContent.trim().toLowerCase().includes('generar factura'));
        if (btn) btn.click();
      });
    }
    await page.waitForTimeout(800);
    await screenshot("p1_generar_factura");

    // ── PASO 1b — SIGUIENTE (selección de operación → Lugar de consumo) ──
    // "Generar Factura" solo selecciona la tarjeta; SIGUIENTE avanza al paso real.
    console.log("➡️ Click SIGUIENTE para avanzar a Lugar de consumo...");
    await clickSiguiente(page, 8000);

    // ── PASO 2 — Seleccionar ciudad (radio button) ────────────────────────
    const ciudad = detectarCiudad(comercio);
    console.log(`📍 Ciudad detectada: "${ciudad}" (comercio: "${comercio}")`);

    await page.waitForFunction(
      () => document.querySelectorAll('input[type="radio"]').length > 0,
      { timeout: 10000 }
    );

    // Loguear radios disponibles para debugging
    const radioLabels = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('input[type="radio"]')).map(r => {
        const w = r.closest('label') || r.closest('.MuiFormControlLabel-root') || r.parentElement?.parentElement;
        return w ? w.textContent.trim() : '(sin label)';
      });
    });
    console.log(`   → Radio buttons disponibles: [${radioLabels.join(' | ')}]`);

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

    // Log inputs disponibles para debugging
    const inputsInfo = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input'))
        .filter(i => !i.disabled && !i.readOnly && i.type !== 'checkbox')
        .map(i => `[placeholder="${i.placeholder || ''}"]`)
    );
    console.log(`   → Inputs editables: ${inputsInfo.join(', ')}`);

    const idOk = await fillReact(page, "ID Facturación", String(idFacturacion).trim());
    if (!idOk) await fillReactNth(page, 0, String(idFacturacion).trim());

    await page.waitForTimeout(300);

    const totalStr = parseFloat(total).toFixed(2);
    const totalOk = await fillReact(page, "Total de compra", totalStr);
    if (!totalOk) await fillReactNth(page, 1, totalStr);

    await screenshot("p4_ticket_llenado");

    // ── PASO 5 — Consultar ticket + validación AJAX ───────────────────────
    console.log("🔍 Consultando ticket...");
    const ctHandle = await page.evaluateHandle(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      return btns.find(b => b.textContent.trim().toLowerCase().includes('consultar ticket')) || null;
    });
    const ctEl = ctHandle ? ctHandle.asElement() : null;
    if (ctEl) {
      await ctEl.click();
    } else {
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const btn = btns.find(b => b.textContent.trim().toLowerCase().includes('consultar ticket'));
        if (btn) btn.click();
      });
    }
    await page.waitForTimeout(2500);

    const errorConsulta = await page.evaluate(() => {
      const body = document.body.innerText;
      if (/ya fue facturado|ya facturado|ya exist/i.test(body))                       return 'YA_FACTURADO';
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
      const btn = btns.find(b => b.textContent.trim().toUpperCase().includes('SIGUIENTE'));
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
    const bcHandle = await page.evaluateHandle(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      return btns.find(b => b.textContent.trim().toLowerCase().includes('buscar cliente')) || null;
    });
    const bcEl = bcHandle ? bcHandle.asElement() : null;
    if (bcEl) {
      await bcEl.click();
    } else {
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const btn = btns.find(b => b.textContent.trim().toLowerCase().includes('buscar cliente'));
        if (btn) btn.click();
      });
    }
    await page.waitForTimeout(2500);

    const errorRfc = await page.evaluate(() => {
      const body = document.body.innerText;
      return /rfc no registrado|rfc no encontrado|not found/i.test(body);
    });
    if (errorRfc) {
      await screenshot("p7_error_rfc");
      await browser.close();
      return { ok: false, error_code: 'datos_invalidos', msg: `Panamá: RFC no encontrado (${rfc})` };
    }

    // Esperar que los datos fiscales se carguen
    console.log("⏳ Esperando carga de datos fiscales...");
    await page.waitForFunction(() => {
      const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'));
      return inputs.some(i => i.value && i.value.length > 5 && !i.disabled && !i.readOnly);
    }, { timeout: 12000 }).catch(() => {
      console.log("⚠️ Timeout esperando datos fiscales, continuando...");
    });
    // Pausa extra para que React termine de renderizar todos los selects (régimen, CFDI)
    await page.waitForTimeout(1000);
    await screenshot("p7_datos_cargados");

    // ── PASO 7b — Actualizar Régimen fiscal ──────────────────────────────────
    // La SAT puede cargar un régimen distinto al del perfil del cliente.
    if (regimenFiscal) {
      console.log(`🏛️ Actualizando Régimen fiscal: ${regimenFiscal}...`);
      await selectMUI(page, "Régimen fiscal", String(regimenFiscal));
      // Esperar a que React actualice el DOM antes de buscar el siguiente select
      await page.waitForTimeout(600);
    }

    // ── PASO 8 — Forma de Pago → Efectivo (MUI Select) ───────────────────
    console.log("💵 Seleccionando Forma de Pago: Efectivo...");
    await selectMUI(page, "Forma Pago", "Efectivo");
    await page.waitForTimeout(600);

    // ── PASO 9 — Correo ───────────────────────────────────────────────────
    console.log("📧 Ingresando correo...");
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(400);

    const correoOk = await fillReact(page, "Correo", "buzonfacturas@serviciosga.site");
    if (!correoOk) {
      // Fallback: último input editable visible
      await page.evaluate((val) => {
        const inputs = Array.from(document.querySelectorAll('input'))
          .filter(i => !i.disabled && !i.readOnly && i.type !== 'checkbox');
        const inp = inputs[inputs.length - 1];
        if (!inp) return;
        inp.scrollIntoView({ block: 'center' });
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
    await page.waitForTimeout(600);
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

    // Capturar posible nueva pestaña
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
    const facturarHandle = await page.evaluateHandle(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      return btns.find(b =>
        b.querySelector('[data-testid="CheckCircleIcon"]') ||
        b.textContent.trim().toUpperCase().includes('FACTURAR')
      ) || null;
    });
    const facturarEl = facturarHandle ? facturarHandle.asElement() : null;
    if (!facturarEl) throw new Error("Panamá: botón FACTURAR no encontrado");

    const isDisabled = await facturarEl.evaluate(el => el.disabled);
    if (isDisabled) throw new Error("Panamá: botón FACTURAR está deshabilitado");

    await facturarEl.click();
    console.log("✅ Click en FACTURAR");

    await page.waitForTimeout(5000);
    await screenshot("p10_post_facturar");

    // ── PASO 12 — Descargar XML y PDF desde la pantalla de éxito ─────────
    // Estrategia: fetch() desde el browser context con las cookies de sesión activas.
    // Los links "Descargar XML/PDF" son <a> que apuntan a URLs de descarga del portal.
    // Si el href no está disponible, usamos waitForResponse + click.
    console.log("🔗 Descargando XML y PDF de la pantalla de éxito...");
    await page.waitForTimeout(1500);

    // Cerrar nueva pestaña si se abrió (algunos portales abren los archivos en nueva tab)
    const newTab = await newPagePromise;
    if (newTab) {
      console.log("🆕 Nueva pestaña detectada:", newTab.url?.());
      try { await newTab.close(); } catch {}
    }

    // Helper: descarga un archivo por keyword de texto en <a> o <button>
    async function descargarArchivo(keyword, tipoMime) {
      // 1. Intentar obtener href del link y hacer fetch desde el navegador (más confiable)
      const fileUrl = await page.evaluate((kw) => {
        const links = Array.from(document.querySelectorAll('a'));
        const link = links.find(l => l.textContent.toLowerCase().includes(kw.toLowerCase()));
        if (link && link.href && !link.href.startsWith('javascript') && link.href !== '#') {
          return link.href;
        }
        return null;
      }, keyword).catch(() => null);

      if (fileUrl) {
        console.log(`   → URL encontrada para ${keyword}: ${fileUrl}`);
        const bytes = await page.evaluate(async (url) => {
          try {
            const r = await fetch(url, { credentials: 'include' });
            if (!r.ok) return null;
            return [...new Uint8Array(await r.arrayBuffer())];
          } catch { return null; }
        }, fileUrl).catch(() => null);
        if (bytes && bytes.length > 200) {
          console.log(`📄 ${keyword} descargado vía fetch: ${bytes.length} bytes`);
          return Buffer.from(bytes);
        }
      }

      // 2. Click en el link/botón + interceptar respuesta HTTP
      console.log(`   → Intentando click + intercepción para ${keyword}...`);
      const isXml = tipoMime.includes('xml');
      const respPromise = page.waitForResponse(resp => {
        const ct = (resp.headers()['content-type'] || '').toLowerCase();
        const u  = resp.url().toLowerCase();
        return isXml
          ? (ct.includes('xml') || u.includes('.xml'))
          : (ct.includes('pdf') || u.includes('.pdf'));
      }, { timeout: 8000 }).catch(() => null);

      await page.evaluate((kw) => {
        const el = Array.from(document.querySelectorAll('a, button'))
          .find(e => e.textContent.toLowerCase().includes(kw.toLowerCase()));
        if (el) el.click();
      }, keyword).catch(() => {});

      const resp = await respPromise;
      if (resp) {
        const buf = await resp.buffer().catch(() => null);
        if (buf && buf.length > 200) {
          console.log(`📄 ${keyword} interceptado: ${buf.length} bytes`);
          return buf;
        }
      }

      return null;
    }

    // Descargar XML
    if (!xmlBuffer) {
      xmlBuffer = await descargarArchivo('descargar xml', 'application/xml').catch(() => null)
               || await descargarArchivo('xml', 'application/xml').catch(() => null);
    }

    // Descargar PDF
    if (!pdfBuffer) {
      pdfBuffer = await descargarArchivo('descargar pdf', 'application/pdf').catch(() => null)
               || await descargarArchivo('pdf', 'application/pdf').catch(() => null);
    }

    await screenshot("p11_descarga");

    // Subir a R2
    let xmlUrl = null, pdfUrl = null;

    if (xmlBuffer && xmlBuffer.length > 200) {
      const preview = xmlBuffer.toString("utf8", 0, 50);
      if (preview.includes("<?") || preview.includes("<cfdi") || preview.includes("<Comprobante")) {
        xmlUrl = await subirArchivoR2(xmlBuffer, `facturas/panama_${ts}.xml`, "application/xml");
        console.log("✅ XML subido:", xmlUrl);
      } else {
        console.log("⚠️ Buffer XML no parece CFDI — preview:", preview.substring(0, 30));
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
