Revisa el estado completo del sistema de facturación y presenta un resumen ejecutivo.

Usa los MCP tools disponibles en este orden:

1. **`estado_sistema`** — tickets por status, atascados, errores recientes, portales pendientes

2. **`logs_railway`** (limite: 100) — logs recientes de Railway. Filtra por:
   - `[ENGINE]` → ver qué portales están corriendo por el engine
   - `[ENGINE FALLBACK]` → excepción en engine que cayó a legacy (requiere atención)
   - `[LEGACY]` → portales corriendo por bot legacy (normal mientras no estén migrados)
   - `error` → cualquier error no capturado

3. **`estado_r2`** — confirma que el storage de archivos está operativo

4. Lee `commerce/` para listar portales en el engine y su estado:
   - Qué portales tienen `flow.json` (engine activo)
   - Compara con la tabla de portales en `CLAUDE.md`

---

Presenta el resultado así:

## ✅ Funcionando bien
- Portales con engine activo y sin errores recientes
- Tickets procesados exitosamente
- R2 y IMAP operativos

## ⚠️ Necesita atención
- Portales con `[ENGINE FALLBACK]` reciente (engine crasheó → legacy tomó control)
- Tickets en `procesando_correo` por más de 30 min
- Portales pendientes sin bot ni engine configurado

## ❌ Roto o bloqueado
- Tickets atascados en `facturando` por más de 30 min
- Errores repetidos del mismo portal
- R2 o IMAP caídos

## 📋 Acciones recomendadas
Para cada problema, indica exactamente qué hacer:
- Qué endpoint llamar para reprocesar tickets atascados
- Qué archivo corregir si hay un selector roto
- Si hay `[ENGINE FALLBACK]` repetido: qué función de `hooks.js` revisar y con qué screenshot de debug

---

**Si hay tickets atascados**, indica el comando exacto:
`POST /api/tickets/{id}/facturar` o MCP tool `reprocesar_ticket` con el ticket_id.
