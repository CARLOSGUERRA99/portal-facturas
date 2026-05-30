const puppeteer = require('puppeteer');
const Anthropic = require('@anthropic-ai/sdk');
const { subirArchivoR2 } = require('../storage/r2');

// Selectores de elementos interactivos. INCLUYE <a> (enlaces estilizados como
// botón — p.ej. SushiO #btn_facturar, Carl's Jr #btn_denviarpet) que la versión
// anterior ignoraba, causando bots que no encontraban el botón real.
const SEL_INTERACTIVOS = 'input, select, textarea, button, a, [role="button"], [onclick]';

// Extrae los elementos interactivos VISIBLES de la pantalla actual.
function extraerElementosScript() {
  return Array.from(document.querySelectorAll('input, select, textarea, button, a, [role="button"], [onclick]'))
    .filter(el => !!(el.offsetParent))
    .map(el => ({
      tag: el.tagName,
      type: el.getAttribute('type') || '',
      id: el.id || '',
      name: el.name || '',
      cls: (el.className || '').toString().slice(0, 40),
      placeholder: (el.getAttribute('placeholder') || '').substring(0, 40),
      formControl: el.getAttribute('formcontrolname') || el.getAttribute('ng-model') || '',
      onclick: el.getAttribute('onclick') ? el.getAttribute('onclick').slice(0, 60) : '',
      text: (el.textContent || el.value || '').trim().substring(0, 40),
    }))
    .filter(el => el.id || el.name || el.formControl || el.placeholder || el.onclick || (el.text && el.tag !== 'INPUT'))
    .slice(0, 40);
}

// Llena los inputs de texto/email de la pantalla actual con los datos provistos,
// usando heurística por id/name/placeholder. Devuelve cuántos llenó.
async function llenarCampos(page, datos) {
  return await page.evaluate((d) => {
    const hintOf = el => ((el.id || '') + ' ' + (el.name || '') + ' ' + (el.placeholder || '') + ' ' + (el.getAttribute('formcontrolname') || '')).toLowerCase();
    const inputs = Array.from(document.querySelectorAll('input, textarea'))
      .filter(el => el.offsetParent && !['hidden', 'checkbox', 'radio', 'submit', 'button', 'file'].includes((el.type || '').toLowerCase()));
    let n = 0;
    for (const el of inputs) {
      if (el.value && el.value.trim()) continue; // no pisar lo ya lleno
      const h = hintOf(el);
      let v = d.referencia;
      if (/rfc/.test(h)) v = d.rfc;
      else if (/correo|email|mail/.test(h)) v = d.email;
      else if (/total|importe|monto/.test(h)) v = d.total;
      else if (/folio/.test(h)) v = d.folio || d.referencia;
      else if (/fecha/.test(h)) v = d.fechaDMY;
      if (v == null || v === '') v = d.referencia || '0000000001';
      try {
        el.value = String(v);
        ['input', 'change', 'keyup', 'blur'].forEach(ev => el.dispatchEvent(new Event(ev, { bubbles: true })));
        n++;
      } catch {}
    }
    return n;
  }, datos);
}

// Hace click en el botón de avance (Siguiente/Facturar/Consultar/Buscar…), evitando
// los de retroceso/cancelar y los de GENERACIÓN final (para no emitir la factura
// durante el análisis). Devuelve el texto del botón clickeado o null.
async function clickAvanzar(page) {
  return await page.evaluate(() => {
    const txt = el => ((el.textContent || '') + ' ' + (el.value || '')).trim();
    const cand = Array.from(document.querySelectorAll('a, button, input[type="submit"], input[type="button"], [role="button"], .btn'))
      .filter(el => el.offsetParent);
    const malo = el => /anterior|regresar|cancelar|atr[aá]s|descargar\s+manual|inicio|ayuda|salir|cerrar/i.test(txt(el));
    const final = el => /generar|emitir|timbrar/i.test(txt(el)); // evitamos la emisión final
    const bueno = el => /siguiente|facturar|consultar|buscar|validar|continuar|aceptar|enviar/i.test(txt(el));
    const b = cand.find(el => bueno(el) && !malo(el) && !final(el));
    if (b) { b.click(); return txt(b).slice(0, 35); }
    return null;
  });
}

// Acepta screenshotBase64 (análisis desde imagen) o portalUrl (Puppeteer interactivo).
async function analizarPortal({ screenshotBase64, mimeType, url, notas, portalUrl, comercioNombre, datosReales }) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const urlFinal = portalUrl || url;
  const nombreFinal = comercioNombre || 'portal';

  const portalesRef = 'Portales existentes de referencia: OXXO (JSF/PrimeFaces), ARCO/BuzonFacturas (multi-step), Gasmaz/NexusFuel (ASP.NET 2 pasos), Farmacias Guadalajara (Angular), SushiO/mefacturo (SoftRestaurant, botón Facturar es <a id="btn_facturar">), Carl\'s Jr/ICR (RetailEDX, modal "ya generada" con #txt_dcorreopet + #btn_denviarpet).';

  // Datos para recorrer el flujo. Reales del ticket si los hay; si no, de prueba.
  const datos = {
    rfc: 'XAXX010101000', razonSocial: 'PUBLICO EN GENERAL',
    referencia: '0000000001', folio: '0000000001', total: '100.00',
    fechaDMY: new Date().toLocaleDateString('es-MX'), email: 'buzonfacturas@serviciosga.site',
    ...(datosReales || {}),
  };

  const pantallas = [];     // [{ paso, elementos, bodyText, screenshotUrl, screenshotBase64 }]
  let tecnologiaDetectada = 'desconocida';

  if (screenshotBase64) {
    // Modo imagen única (compatibilidad): una sola "pantalla".
    pantallas.push({ paso: 0, elementos: [], bodyText: '', screenshotBase64, screenshotMime: mimeType || 'image/png' });
  } else if (urlFinal) {
    const token = process.env.BROWSERLESS_TOKEN;
    if (!token) throw new Error('BROWSERLESS_TOKEN no definido');
    const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8' });

    try {
      console.log(`🔍 [Analizador] Cargando portal: ${urlFinal}`);
      await page.goto(urlFinal, { waitUntil: 'networkidle2', timeout: 30000 });
      await page.waitForTimeout(2000);

      tecnologiaDetectada = await page.evaluate(() => {
        const ng = document.querySelector('[ng-version]');
        if (ng) return `Angular ${ng.getAttribute('ng-version') || ''}`.trim();
        if (window.angular) return 'AngularJS';
        if (window.React || document.querySelector('[data-reactroot]')) return 'React';
        if (window.__NEXT_DATA__) return 'Next.js';
        if (window.PrimeFaces) return 'JSF/PrimeFaces';
        if (window.jQuery) return 'jQuery';
        return 'HTML/JS clásico';
      });

      // ── Recorrido interactivo: hasta 4 pantallas ──────────────────────────
      const MAX_PASOS = 4;
      let bodyAnterior = '';
      for (let paso = 0; paso < MAX_PASOS; paso++) {
        const elementos = await page.evaluate(extraerElementosScript).catch(() => []);
        const bodyText = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 800)).catch(() => '');
        const buf = await page.screenshot({ fullPage: false }).catch(() => null);
        let screenshotUrl = null, screenshotBase64Local = null;
        if (buf) {
          screenshotBase64Local = buf.toString('base64');
          screenshotUrl = await subirArchivoR2(buf, `agentes/${nombreFinal}_p${paso}_${Date.now()}.png`, 'image/png').catch(() => null);
        }
        pantallas.push({ paso, elementos, bodyText, screenshotUrl, screenshotBase64: screenshotBase64Local, screenshotMime: 'image/png' });
        console.log(`📸 [Analizador] Pantalla ${paso}: ${elementos.length} elementos — ${screenshotUrl || '(sin url)'}`);

        if (paso === MAX_PASOS - 1) break;

        // Llenar campos y avanzar para descubrir la siguiente pantalla / modal.
        const nLlenos = await llenarCampos(page, datos).catch(() => 0);
        await page.waitForTimeout(400);
        const avanzo = await clickAvanzar(page).catch(() => null);
        if (!avanzo) { console.log(`⏹️ [Analizador] Sin botón de avance en paso ${paso} — fin del recorrido`); break; }
        console.log(`➡️ [Analizador] Paso ${paso}: llené ${nLlenos} campos, click en "${avanzo}"`);
        await page.waitForTimeout(4500); // dejar que cargue la siguiente pantalla/modal/AJAX

        // ¿Cambió la pantalla? Si el texto es casi idéntico, no avanzó → terminamos.
        const bodyNuevo = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 800)).catch(() => '');
        if (bodyNuevo && bodyNuevo === bodyAnterior) { console.log('⏹️ [Analizador] La pantalla no cambió — fin del recorrido'); break; }
        bodyAnterior = bodyText;
      }
      await browser.close();
    } catch (err) {
      try { await browser.close(); } catch {}
      if (!pantallas.length) throw new Error(`No se pudo cargar el portal: ${err.message}`);
      console.log(`⚠️ [Analizador] Recorrido interrumpido (${err.message}) — analizo lo capturado`);
    }
  }

  // ── Construir el inventario multi-pantalla para Claude ──────────────────────
  const inventario = pantallas.map(p =>
    `--- PANTALLA ${p.paso} ---\nTexto: ${(p.bodyText || '').slice(0, 400)}\nElementos: ${JSON.stringify(p.elementos || [])}`
  ).join('\n\n');

  const prompt = `Eres experto en portales de facturación electrónica mexicanos y automatización con Puppeteer.

Recorrí el portal "${nombreFinal}" de forma interactiva (llenando campos y avanzando), capturando el DOM REAL de cada pantalla. Usa estos datos reales (NO inventes selectores: usa los IDs/names/clases que aparecen abajo).

URL: ${urlFinal || '(imagen)'}
Tecnología detectada: ${tecnologiaDetectada}
${notas ? `Notas: ${notas}\n` : ''}
${portalesRef}

INVENTARIO DE PANTALLAS (DOM real capturado):
${inventario || '(solo imagen)'}

Responde SOLO con este JSON (sin markdown):
{
  "nombre": "nombre del portal o empresa",
  "tecnologia": "${tecnologiaDetectada}",
  "flujo": "single-page|multi-step",
  "captcha": false,
  "stealth_recomendado": false,
  "campos": [
    { "nombre": "campo", "selector": "#idReal", "tipo": "input|select|datepicker|checkbox|button", "pantalla": 0, "requerido": true, "notas": "" }
  ],
  "selectores": { "nombreCampo": "#selectorRealExacto", "botonAvanzar": "#...", "botonFacturar": "#...", "botonDescargar": "#...", "campoCorreo": "#...", "botonEnviarCorreo": "#..." },
  "pasos": ["paso 1 con su acción y selector", "paso 2", "..."],
  "detectar_exito": "selector o texto que indica factura generada",
  "detectar_error": "selector o texto de error / ya facturado / vencido",
  "casos_especiales": ["ticket vencido", "ya facturado", "descarga directa", "envío por correo"],
  "notas": "popups, modales, AJAX, dropdowns encadenados, si el botón es <a> en vez de <button>, etc.",
  "similitud_portales": { "mas_similar": "oxxo|arco|gasmaz|sushito|carljr|ninguno", "porcentaje_reuso": 0, "razon": "" }
}`;

  const content = [];
  // Adjuntar hasta 3 screenshots clave (primera, intermedia, última)
  const conImagen = pantallas.filter(p => p.screenshotBase64);
  const elegidas = conImagen.length <= 3 ? conImagen : [conImagen[0], conImagen[Math.floor(conImagen.length / 2)], conImagen[conImagen.length - 1]];
  for (const p of elegidas) {
    content.push({ type: 'image', source: { type: 'base64', media_type: p.screenshotMime || 'image/png', data: p.screenshotBase64 } });
  }
  content.push({ type: 'text', text: prompt });

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 6000,
    messages: [{ role: 'user', content }],
  });

  let text = response.content[0].text
    .replace(/^```json\n?/m, '').replace(/^```\n?/m, '').replace(/\n?```$/m, '').trim();

  let analisis;
  try {
    analisis = JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*/);
    if (match) {
      try {
        let partial = match[0];
        const opens = (partial.match(/\{/g) || []).length - (partial.match(/\}/g) || []).length;
        const arrOpens = (partial.match(/\[/g) || []).length - (partial.match(/\]/g) || []).length;
        partial += ']'.repeat(Math.max(0, arrOpens)) + '}'.repeat(Math.max(0, opens));
        analisis = JSON.parse(partial);
      } catch {
        throw new Error(`Respuesta del analizador no es JSON válido: ${text.substring(0, 200)}`);
      }
    } else {
      throw new Error(`Respuesta del analizador no es JSON válido: ${text.substring(0, 200)}`);
    }
  }

  analisis._url = urlFinal;
  analisis._screenshots = pantallas.filter(p => p.screenshotUrl).map(p => ({ label: `p${p.paso}`, url: p.screenshotUrl }));
  analisis._pantallas = pantallas.length;
  console.log(`✅ [Analizador] Completado — ${pantallas.length} pantallas, similar a: ${analisis.similitud_portales?.mas_similar || '?'}`);
  return analisis;
}

module.exports = { analizarPortal };
