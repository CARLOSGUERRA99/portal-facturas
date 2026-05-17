Revisa el estado actual del sistema de facturación consultando la base de datos y los archivos del proyecto.

Ejecuta estas consultas y acciones en orden:

1. **Tickets por status** — cuenta cuántos hay en cada estado (pendiente_confirmacion, facturando, completado, error, procesando_correo)

2. **Tickets atascados** — tickets en `procesando_correo` o `facturando` con más de 30 minutos sin actualizar

3. **Errores recientes** — últimos 5 tickets con status `error`, muestra comercio y mensaje de error del ocr_json

4. **Portales pendientes** — comercios en la tabla `portales_pendientes` que aún no tienen bot configurado, con su cuestionario si existe

5. **Bots activos** — lista los archivos en `bots/` y su estado según `portales/portales.json`

Presenta el resultado como un resumen ejecutivo con:
- ✅ Lo que está funcionando bien
- ⚠️ Lo que necesita atención
- ❌ Lo que está roto o bloqueado
- 📋 Acción recomendada para cada problema

Si hay tickets atascados, indica exactamente qué endpoint llamar para reprocesarlos.
