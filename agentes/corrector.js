const Anthropic = require('@anthropic-ai/sdk');

// Recibe el bot con errores + screenshots del fallo + análisis original
// Devuelve { codigo } con el código corregido
async function corregirBot({ codigoBot, errores = [], advertencias = [], testLive = null, analisisJson, nombrePortal }) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const content = [];

  // Incluir screenshots del live test si existen (máx 3)
  const screenshotUrls = analisisJson?._screenshots || [];
  for (const ss of screenshotUrls.slice(0, 3)) {
    try {
      const resp = await fetch(ss.url);
      if (!resp.ok) continue;
      const buf = Buffer.from(await resp.arrayBuffer());
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: buf.toString('base64') } });
    } catch {}
  }

  const errorResumen = [
    errores.length ? `Errores críticos:\n${errores.map(e => `- ${e}`).join('\n')}` : '',
    advertencias.length ? `Advertencias:\n${advertencias.map(a => `- ${a}`).join('\n')}` : '',
    testLive?.error ? `Error en ejecución live:\n${testLive.error}` : '',
    testLive?.resultado ? `Resultado live:\n${JSON.stringify(testLive.resultado, null, 2)}` : '',
  ].filter(Boolean).join('\n\n');

  const prompt = `Eres experto en Puppeteer para portales CFDI mexicanos. El siguiente bot falló en validación.

## Portal: ${nombrePortal}

## Análisis original del portal:
${JSON.stringify(analisisJson, null, 2)}

## Problemas encontrados:
${errorResumen}

## Código actual del bot con errores:
\`\`\`javascript
${codigoBot}
\`\`\`

Corrige TODOS los errores listados. Presta especial atención a:
- Selectores CSS incorrectos (usa los del análisis)
- Falta de imports (puppeteer, subirArchivoR2)
- Retornos estándar faltantes ({ ok: true/false })
- Email buzonfacturas@serviciosga.site si falta
- browser.close() en el bloque catch
- module.exports al final

Responde SOLO con el código JavaScript completo corregido, sin markdown, sin explicaciones.`;

  content.push({ type: 'text', text: prompt });

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8000,
    messages: [{ role: 'user', content }],
  });

  let codigo = response.content[0].text;
  codigo = codigo
    .replace(/^```javascript\n?/m, '')
    .replace(/^```js\n?/m, '')
    .replace(/^```\n?/m, '')
    .replace(/\n?```$/m, '')
    .trim();

  console.log(`✅ [Corrector] Código corregido: ${codigo.length} chars`);
  return { codigo };
}

module.exports = { corregirBot };
