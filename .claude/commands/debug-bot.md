Diagnostica por qué falló este bot de facturación y dame el fix exacto.

Antes de analizar, lee el archivo del bot correspondiente en `bots/` para tener el código completo en contexto.

Con los screenshots de R2 y/o los logs de Railway que te estoy pasando, responde:

## 1. Paso donde falló
Indica exactamente en qué paso del flujo se detuvo (ej: "Paso 4 — esperando #selVoucherUse").

## 2. Causa probable
Categoriza el error:
- **Selector inválido** — el portal cambió el ID/clase del elemento
- **Timeout** — el elemento no apareció en el tiempo esperado
- **Modal inesperado** — apareció un popup no manejado
- **AJAX no esperado** — opciones que cargan dinámicamente sin espera
- **Navegación inesperada** — el portal redirigió a una URL no contemplada
- **Portal caído** — el sitio no responde
- **Datos incorrectos** — el portal rechazó RFC, folio u otro campo

## 3. Fix concreto
Dame el código exacto a cambiar: archivo, número de línea aproximado, código anterior vs código nuevo. Si el selector cambió, dame el nuevo selector CSS correcto.

## 4. ¿Requiere intervención manual?
Indica si este ticket específico se puede reprocesar automáticamente con el fix, o si necesita que el admin lo facture a mano esta vez.
