Analiza el portal de facturación que te acabo de mostrar (screenshot o URL) y extrae toda la información necesaria para automatizarlo con Puppeteer.

Lee primero `portales/portales.json` para entender el formato esperado y los portales que ya tenemos.

Responde con este JSON exacto (sin texto extra):

```json
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
  "notas": "comportamientos especiales, popups, redirecciones, AJAX, etc."
}
```

Después de dar el JSON, añade una sección **"Similitud con portales existentes"** indicando si este portal se parece a alguno ya implementado (OXXO/JSF, BuzonFacturas/ASP.NET, Gasmaz/NexusFuel) y en qué porcentaje podríamos reusar código.
