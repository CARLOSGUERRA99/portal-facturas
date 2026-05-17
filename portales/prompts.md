# Biblioteca de prompts — portal-facturas

Prompts probados y optimizados para el sistema de facturación automática.
Usar siempre con el contexto de CLAUDE.md y portales.json adjuntos.

---

## 1. Análisis de portal nuevo (screenshot → JSON de campos)

Usar cuando llegue un portal desconocido. Adjuntar screenshot del portal.

```
Analiza este screenshot de un portal de facturación mexicano.
Necesito automatizarlo con Puppeteer.

Responde SOLO este JSON:
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
  "notas": "comportamientos especiales, popups, redirecciones, AJAX, etc."
}
```

---

## 2. Generación de bot nuevo (JSON de análisis → bot .js)

Usar después del análisis. Adjuntar: JSON del análisis + código de gasmaz.js como referencia.

```
Eres experto en Puppeteer y portales de facturación mexicanos SAT.

Tengo un sistema de facturación automática. Aquí está el bot de referencia (gasmaz.js):
[ADJUNTAR gasmaz.js]

Aquí está el análisis del nuevo portal:
[ADJUNTAR JSON del análisis]

Datos que recibirá el bot:
- rfc, razonSocial, regimenFiscal, usoCfdi
- [campos específicos del ticket según el portal]
- ticketId (para nombrar archivos en R2)

Genera el bot siguiendo EXACTAMENTE esta estructura:
- Función async principal que recibe un objeto con los datos
- Conecta a Browserless: wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}&stealth=true
- Helpers fillInput y selectByText (cópialos de gasmaz.js)
- Screenshots en cada paso con subirArchivoR2
- Retorna { ok: true, xmlUrl, pdfUrl } | { ok: true, procesandoCorreo: true } | { ok: false, msg }
- Email de captura: buzonfacturas@serviciosga.site
- Datos fijos: regimenFiscal 601, usoCfdi G03

Responde SOLO con el código JavaScript listo para guardar.
El archivo se llamará: [nombre-comercio].js
```

---

## 3. Diagnóstico de bot fallido (screenshots de error → causa + fix)

Usar cuando un bot falla en producción. Adjuntar screenshots de debug guardados en R2.

```
Este bot de facturación falló. Aquí están los screenshots de cada paso:
[ADJUNTAR screenshots: paso1_cargado.png, paso2_campos.png, ..., error_final.png]

Logs del error:
[PEGAR logs de Railway]

Portal: [nombre]
Paso donde falló: [paso X de Y]
Error: [mensaje de error]

Analiza qué salió mal y dame:
1. Causa probable (selector cambió, timeout, modal inesperado, AJAX no esperado, etc.)
2. Fix concreto (línea de código a cambiar, selector correcto, tiempo de espera a agregar)
3. Si el portal cambió su diseño, qué selectores nuevos usar
```

---

## 4. OCR — Detección de portal (Haiku, Pasada 1)

Este es el prompt activo en server.js para detección con Haiku.

```
Identifica el tipo de ticket de compra. Responde SOLO este JSON:
{
  "portal": "oxxo" | "arco" | "gasmaz" | "farmaciaguadalajara" | "desconocido",
  "confianza": número del 0 al 100,
  "urlQR": "URL completa si hay un QR de facturación, o null",
  "comercio": "nombre del comercio"
}
- "oxxo": si ves logo/nombre OXXO, o texto "Fol_Vta:" e "ID="
- "arco": si ves ARCO o referencia a buzonfacturas.com
- "gasmaz": si ves GASMAZ, NexusFuel, o URL nexusfuel.mx
- "farmaciaguadalajara": si ves Farmacias Guadalajara, Fragua, o URL farmaciasguadalajara.com
- "desconocido": cualquier otro caso
```

---

## 5. OCR — Extracción OXXO (Sonnet, Pasada 2)

```
Extrae estos datos del ticket OXXO. Responde SOLO JSON sin texto adicional:
{
  "comercio": "OXXO",
  "fecha": "DD/MM/YYYY",
  "folio": "SOLO dígitos después de Fol_Vta: — corrige O→0 S→5 I→1 T→1",
  "idVenta": "código después de ID= — corrige O→0 S→5 I→1 en posiciones 0,1,5,6 — formato 2dig+3let+2dig+alfanum+1dig",
  "total": número sin signos,
  "portal": "oxxo",
  "ok": true
}
```

---

## 6. OCR — Extracción ARCO/BuzonFacturas (Sonnet, Pasada 2)

```
Extrae estos datos del ticket ARCO/BuzonFacturas. Responde SOLO JSON sin texto adicional:
{
  "comercio": "nombre exacto de la gasolinera ARCO",
  "fecha": "DD/MM/YYYY",
  "codigoTicket": "número de barcode o código grande impreso para facturación",
  "total": número sin signos,
  "portal": "arco",
  "ok": true
}
```

---

## 7. OCR — Extracción Gasmaz/NexusFuel (Sonnet, Pasada 2)

```
Extrae estos datos del ticket GASMAZ/NexusFuel. Responde SOLO JSON sin texto adicional:
{
  "comercio": "nombre de la gasolinera",
  "fecha": "DD/MM/YYYY",
  "referencia": "número de referencia grande (primer número prominente del ticket)",
  "folio": "número de ticket o folio",
  "total": número sin signos,
  "portalUrl": "URL COMPLETA del QR de facturación (debe incluir nexusfuel.mx), o null",
  "portal": "gasmaz",
  "ok": true
}
```

---

## 8. OCR — Extracción Farmacias Guadalajara (Sonnet, Pasada 2)

```
Extrae estos datos del ticket de Farmacias Guadalajara. Responde SOLO JSON sin texto adicional:
{
  "comercio": "Farmacias Guadalajara",
  "fecha": "YYYY-MM-DD",
  "folioFactura": "número de folio formato XXXXXX-XXXXXX-X (con guiones)",
  "caja": "número de caja",
  "fechaCompra": "fecha de compra en formato YYYY-MM-DD",
  "noTicket": "número de ticket",
  "total": número sin signos,
  "portal": "farmaciaguadalajara",
  "ok": true
}
```

---

## 9. OCR — Extracción portal desconocido (Sonnet, Pasada 2)

```
Extrae los datos que puedas de este ticket. Responde SOLO JSON sin texto adicional:
{
  "comercio": "nombre del comercio",
  "fecha": "DD/MM/YYYY",
  "folio": "número de folio o ticket, o null",
  "total": número sin signos,
  "portalUrl": "URL de QR de facturación si aparece, o null",
  "portal": "desconocido",
  "ok": true
}
```

---

## 10. Cuestionario de portal nuevo (para usuario del portal)

Este texto se muestra al usuario cuando se detecta un comercio sin portal configurado.

```
Cuéntanos cómo facturas en [NOMBRE_COMERCIO] para que podamos automatizarlo:

1. ¿Es la primera vez que facturas aquí? (Sí / No, ya facturé antes / Facturo seguido aquí)

2. ¿Cómo accedes al portal de facturación? 
   (Escaneando el QR del ticket / Entrando a una página web / Otro)

3. Describe los pasos que sigues normalmente, lo más detallado posible:
   Ejemplo: "Entro a la página, pongo el número del ticket, luego mi RFC, 
   selecciono uso de CFDI y descargo el PDF"

4. ¿Tienes el link del portal? (opcional) _______________

5. ¿Qué datos te piden en el portal? 
   (marcar todos los que aplican)
   □ Número de ticket / folio
   □ Fecha de compra  
   □ Total / importe
   □ Código de barras
   □ RFC
   □ Razón social
   □ Código postal
   □ Otro: ___________

Tus respuestas nos ayudan a configurar este portal en 24-48 horas.
```

---

## Notas de uso

- Siempre adjuntar `CLAUDE.md` al inicio de una sesión nueva para dar contexto del proyecto.
- Para generar un bot, adjuntar también `portales/portales.json` y el bot de referencia más similar.
- Los prompts de OCR (4-9) están implementados en `server.js` — no modificar sin actualizar aquí.
- Actualizar `portales.json` cada vez que un bot nuevo llega a producción.
