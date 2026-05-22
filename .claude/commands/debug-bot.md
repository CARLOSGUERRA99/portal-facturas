Diagnostica por qué falló este ticket de facturación y dame el fix exacto.

Antes de analizar, determina si falló el ENGINE o el bot LEGACY:
- Si los logs de Railway muestran `[ENGINE][portal]` → es fallo del engine
- Si muestran `[LEGACY][portal]` o no tienen prefijo `[ENGINE]` → es fallo del bot legacy
- Si muestran `[ENGINE FALLBACK][portal]` → el engine crasheó con excepción y cayó a legacy

Lee el código correspondiente:
- Engine: `engine/runner.js`, `commerce/{portal}/flow.json`, `commerce/{portal}/hooks.js`
- Legacy: `bots/{portal}.js`

---

## 1. Diagnóstico inicial

Con los logs de Railway y/o screenshots de R2 que te paso, identifica:

**Si es ENGINE:**
- ¿Qué step del flow.json falló? (número de step + action)
- ¿Qué error_code retornó? (`timeout | ya_facturado | datos_invalidos | captcha | portal_caido | descarga_fallida | hook_error | desconocido`)
- URL del screenshot de debug: `debug/{portal}_{ticketId}_ERROR_step{N}_{action}_{ts}.png`

**Si es LEGACY:**
- ¿En qué línea aproximada falló? (buscar en el stack trace o screenshot)
- ¿Qué selector dejó de funcionar o qué timeout expiró?

---

## 2. Causa probable

Categoriza el error:

| Categoría | Señales |
|---|---|
| **Selector inválido** | `waitFor timeout` en un selector que antes funcionaba |
| **AJAX no esperado** | Select con opciones vacías, `options.length === 1` |
| **Modal/popup inesperado** | Screenshot muestra overlay antes del formulario |
| **Portal caído** | `ERR_NAME_NOT_RESOLVED` o `net::ERR_CONNECTION` |
| **Datos incorrectos** | Portal muestra mensaje de error tras buscar folio |
| **Ya facturado** | Portal muestra sección de descarga antes del formulario paso 2 |
| **Bug en hook** | `[ENGINE FALLBACK]` con stack trace de `hooks.js` |
| **Timeout de descarga** | `hook_error` o `descarga_fallida` después de generar la factura |

---

## 3. Fix concreto

**Para ENGINE:** indica el archivo y cambio exacto:
- `commerce/{portal}/selectors.json` — selector anterior vs nuevo
- `commerce/{portal}/flow.json` — step a modificar (número + action completa)
- `commerce/{portal}/hooks.js` — función a corregir con código antes/después

**Para LEGACY:** indica archivo, número de línea aproximado, código anterior vs nuevo.

Si el fix es en `hooks.js` o `flow.json`, el cambio se despliega automáticamente al hacer push.
Si el fix es en `selectors.json`, verifica primero con `scripts/validate-selectors-{portal}.js`.

---

## 4. ¿El ticket se puede reprocesar?

- Si el error fue `portal_caido` o `timeout` → sí, reprocesar cuando el portal esté estable
- Si fue `ya_facturado` → buscar los archivos en R2 (`facturas/{portal}_{ticketId}.*`)
- Si fue `datos_invalidos` → necesita corrección manual del folio/total antes de reprocesar
- Si fue `descarga_fallida` → la factura SÍ se generó, buscarla en el correo IMAP o pedir al portal

Para reprocesar: llamar `POST /api/tickets/{id}/facturar` o usar el MCP tool `reprocesar_ticket`.
