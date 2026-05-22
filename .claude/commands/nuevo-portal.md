Analiza el portal de facturación que te acabo de mostrar (screenshot o URL) y extrae toda la
información necesaria para automatizarlo.

Lee primero `CLAUDE.md` para entender la arquitectura actual (engine declarativo + bots legacy).

Responde con este JSON exacto (sin texto extra):

```json
{
  "nombre": "nombre del portal o empresa",
  "url": "URL del portal",
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
  "notas": "comportamientos especiales, AJAX, popups, redirecciones, iframes, etc."
}
```

Después del JSON, añade dos secciones:

**"Similitud con portales existentes"**
Indica si este portal se parece a alguno ya implementado (NexusFuel/RAMSA, OXXO/JSF,
BuzonFacturas/ASP.NET) y en qué porcentaje podríamos reusar código.

**"Recomendación: Engine o Legacy"**
- **Engine** si: formulario estándar, flujo lineal, selects comunes, descarga directa de XML/PDF
- **Legacy** si: estado complejo entre páginas, iframes, CAPTCHAs, lógica muy dinámica

Explica la recomendación en 2 oraciones. Si es engine, indica qué portal de `commerce/`
usar como plantilla base.
