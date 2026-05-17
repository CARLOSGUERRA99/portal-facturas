const puppeteer = require('puppeteer');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const { subirArchivoR2 } = require('../storage/r2');

// Acepta screenshotBase64 (análisis desde imagen ya tomada) o portalUrl (Puppeteer lo visita)
async function analizarPortal({ screenshotBase64, mimeType, url, notas, portalUrl, comercioNombre }) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Compatibilidad: si usan el API anterior (screenshotBase64) lo respetamos
  const urlFinal = portalUrl || url;
  const nombreFinal = comercioNombre || 'portal';

  const portalesJson = fs.readFileSync(path.join(__dirname, '../portales/portales.json'), 'utf8');

  let imagenBase64 = screenshotBase64;
  let imagenMime = mimeType || 'image/png';
  const screenshots = [];

  // Si no hay screenshot provisto, visitar el portal con Puppeteer
  if (!imagenBase64 && urlFinal) {
    const token = process.env.BROWSERLESS_TOKEN;
    if (!token) throw new Error('BROWSERLESS_TOKEN no definido');

    const browser = await puppeteer.connect({
      browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true`,
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8' });

    try {
      console.log(`🔍 [Analizador] Cargando portal: ${urlFinal}`);
      await page.goto(urlFinal, { waitUntil: 'networkidle2', timeout: 30000 });
      await page.waitForTimeout(2000);

      // Detectar tecnología antes del screenshot
      const tecnologiaDetectada = await page.evaluate(() => {
        const ngVer = document.querySelector('[ng-version]');
        if (ngVer) return `Angular ${ngVer.getAttribute('ng-version') || ''}`.trim();
        if (window.angular) return 'AngularJS';
        if (window.React) return 'React';
        if (window.__NEXT_DATA__) return 'Next.js';
        if (window.jQuery) return 'jQuery';
        return 'HTML/JS clásico';
      });

      // Extraer elementos interactivos visibles para contexto adicional
      const elementos = await page.evaluate(() =>
        Array.from(document.querySelectorAll('input, select, textarea, button, [role="button"]'))
          .filter(el => !!(el.offsetParent))
          .map(el => ({
            tag: el.tagName,
            type: el.getAttribute('type') || '',
            id: el.id || '',
            name: el.name || '',
            placeholder: el.getAttribute('placeholder') || '',
            formControl: el.getAttribute('formcontrolname') || el.getAttribute('ng-model') || '',
            text: el.textContent?.trim().substring(0, 60) || '',
            disabled: el.disabled || false,
          }))
      );

      const buf = await page.screenshot({ fullPage: false });
      imagenBase64 = buf.toString('base64');
      imagenMime = 'image/png';

      // Subir a R2 para debug
      const debugUrl = await subirArchivoR2(buf, `agentes/${nombreFinal}_inicial_${Date.now()}.png`, 'image/png');
      screenshots.push({ label: 'inicial', url: debugUrl });
      console.log(`📸 [Analizador] Screenshot: ${debugUrl}`);

      // Enriquecer notas con datos detectados por JS
      notas = [
        notas || '',
        `Tecnología JS detectada: ${tecnologiaDetectada}`,
        `Elementos visibles: ${JSON.stringify(elementos)}`,
      ].filter(Boolean).join('\n');

      await browser.close();
    } catch (err) {
      try { await browser.close(); } catch {}
      throw new Error(`No se pudo cargar el portal: ${err.message}`);
    }
  }

  // Construir prompt para Claude
  const textoContexto = [
    urlFinal ? `URL del portal: ${urlFinal}` : '',
    notas ? `Contexto adicional:\n${notas}` : '',
  ].filter(Boolean).join('\n');

  const prompt = `Eres experto en portales de facturación electrónica mexicanos y automatización con Puppeteer.

Analiza este portal de facturación y extrae toda la información necesaria para automatizarlo.

Portales ya implementados (referencia para similitud):
${portalesJson}

${textoContexto}

Responde SOLO con este JSON (sin texto adicional, sin markdown):
{
  "nombre": "nombre del portal o empresa",
  "tecnologia": "JSF|Angular|React|ASP.NET|jQuery|otro",
  "flujo": "single-page|multi-step",
  "captcha": false,
  "tiene_turnstile": false,
  "stealth_recomendado": false,
  "campos": [
    {
      "nombre": "nombre descriptivo del campo",
      "selector": "#id o .clase o input[name='x']",
      "tipo": "input|select|datepicker|checkbox|button",
      "requerido": true,
      "notas": "comportamiento especial si aplica"
    }
  ],
  "selectores": { "nombreCampo": "selector_css_exacto" },
  "pasos": ["descripción paso 1", "paso 2", "..."],
  "detectar_exito": "selector o texto que indica factura generada",
  "detectar_error": "selector o texto que indica error",
  "casos_especiales": ["ticket vencido", "ya facturado", "etc"],
  "notas": "comportamientos especiales: popups, redirecciones, AJAX, dropdowns encadenados, etc.",
  "similitud_portales": {
    "mas_similar": "oxxo|arco|gasmaz|farmaciaguadalajara|ninguno",
    "porcentaje_reuso": 0,
    "razon": "por qué se parece o diferencia"
  }
}`;

  const content = [];
  if (imagenBase64) {
    content.push({ type: 'image', source: { type: 'base64', media_type: imagenMime, data: imagenBase64 } });
  }
  content.push({ type: 'text', text: prompt });

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    messages: [{ role: 'user', content }],
  });

  const text = response.content[0].text
    .replace(/^```json\n?/m, '')
    .replace(/^```\n?/m, '')
    .replace(/\n?```$/m, '')
    .trim();

  const analisis = JSON.parse(text);
  analisis._url = urlFinal;
  analisis._screenshots = screenshots;

  console.log(`✅ [Analizador] Completado — similar a: ${analisis.similitud_portales?.mas_similar || '?'}`);
  return analisis;
}

module.exports = { analizarPortal };
