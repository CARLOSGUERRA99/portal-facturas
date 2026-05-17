const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const path = require("path");

async function analizarPortal({ screenshotBase64, mimeType, url, notas }) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const portalesJson = fs.readFileSync(
    path.join(__dirname, "../portales/portales.json"),
    "utf8"
  );

  const textoContexto = [
    url ? `URL del portal: ${url}` : "",
    notas ? `Notas del usuario: ${notas}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const prompt = `Eres experto en portales de facturación electrónica mexicanos y automatización con Puppeteer.

Analiza este portal de facturación y extrae toda la información necesaria para automatizarlo.

Portales ya implementados (referencia para similitud):
${portalesJson}

${textoContexto}

Responde SOLO con este JSON (sin texto adicional, sin markdown):
{
  "nombre": "nombre del portal o empresa",
  "tecnologia": "JSF|Angular|React|ASP.NET|otro",
  "flujo": "single-page|multi-step",
  "captcha": false,
  "campos": [
    {
      "nombre": "nombre descriptivo",
      "selector": "#id o .clase o input[name='x']",
      "tipo": "input|select|datepicker|checkbox|button",
      "requerido": true,
      "notas": "comportamiento especial si aplica"
    }
  ],
  "pasos": ["descripción paso 1", "paso 2", "..."],
  "detectar_exito": "selector o texto que indica factura generada",
  "detectar_error": "selector o texto que indica error",
  "casos_especiales": ["ticket vencido", "ya facturado", "etc"],
  "notas": "comportamientos especiales, popups, redirecciones, AJAX, etc.",
  "similitud_portales": {
    "mas_similar": "oxxo|arco|gasmaz|farmaciaguadalajara|ninguno",
    "porcentaje_reuso": 0,
    "razon": "por qué se parece o diferencia"
  }
}`;

  const content = [];

  if (screenshotBase64) {
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: mimeType || "image/png",
        data: screenshotBase64,
      },
    });
  }

  content.push({ type: "text", text: prompt });

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2000,
    messages: [{ role: "user", content }],
  });

  const text = response.content[0].text
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();

  return JSON.parse(text);
}

module.exports = { analizarPortal };
