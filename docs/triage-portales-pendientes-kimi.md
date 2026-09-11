# Triage de portales atorados

Clasificación de los 12 portales reportados, hecha únicamente a partir del snapshot HTML estático proporcionado. **No se escribió ni ejecutó código de automatización; no se llenó ningún formulario.**

Leyenda:

- ✅ **Candidato bueno**: formulario público simple (referencia/folio + RFC). Vale la pena reintentar con el agente automático.  
- 🔐 **Requiere cuenta**: pide login/registro; necesitamos credenciales que no tenemos.  
- 🛡️ **Protegido/sin formulario visible**: splash de carga, anti-bot, JS pesado o página vacía; no se ve formulario en HTML crudo.  
- ❓ **Sin snapshot**: no se proporcionó contenido; no se puede clasificar.  
- 🚧 **Bloqueado por backend**: la landing es simple, pero el portal real está caído/en mantenimiento.

---

## 1. http://lasconchas.facturacionestacion.com — ✅ Candidato bueno

Muestra un formulario de facturación con selects de Estado, Régimen fiscal, Uso CFDI y Medio de pago, más botón “Buscar”. No pide login en el HTML. Parece el típico flujo de gasolinera: datos del ticket + datos fiscales. **Recomendación: reintentar alta con el agente.**

---

## 2. https://kfc.com.mx/es/facturacion.html — 🚧 Bloqueado por backend

La landing es simple (“Ingresa tu folio…”), pero el link real de facturación apunta a `https://facturacion.prb.com.mx/`. Según `CLAUDE.md`, ese portal está en mantenimiento (`facturacion.prb.com.mx:444`). Hasta que PRB no vuelva, no importa qué tan simple sea la landing.

---

## 3. http://facturacion.sinaloa.gob.mx — 🔐 Requiere cuenta

Landing oficial de Gobierno del Estado de Sinaloa. Pide **Crear Cuenta / Iniciar Sesión** y menciona casetas de peaje Orler con 5-6 días de espera. **No es como PINFRA** (`bots/pinfra.js`), que es un flujo de invitado con RFC + correo ya asociado; aquí se requiere una cuenta de ciudadano. Necesitaríamos credenciales.

---

## 4. //facturacion.sinaloa.gob.mx (Caseta Las Brisas) — 🔐 Requiere cuenta

Mismo dominio y plataforma que el anterior. La URL solo difiere en la caseta, pero el portal sigue siendo el de Sinaloa con login obligatorio.

---

## 5. https://factura.enerfueltech.com/ — 🔐 Requiere cuenta / sesión

El HTML solo muestra “Validando Sesión” y es una app Blazor/MudBlazor. No hay formulario visible en el HTML crudo; parece redirigir a login si no hay sesión. Necesita credenciales.

---

## 6. http://facturacion.enerser.com.mx/ — 🛡️ Protegido / sin formulario visible

El snapshot solo dice “ESTABLECIENDO CONEXIÓN…” con un spinner. Probablemente es una página de carga, anti-bot o JS pesado que no renderiza formulario sin ejecutar scripts. No se puede clasificar como candidato bueno con la información disponible.

---

## 7. http://gruponvera.facturaciones-facion.com/ — ❓ Sin snapshot

No se proporcionó contenido. No se puede clasificar.

---

## 8. www.grupomaba.com — ❓ Sin snapshot

No se proporcionó contenido. No se puede clasificar.

---

## 9. www.svgasolineras.com — ❓ Sin snapshot

No se proporcionó contenido. No se puede clasificar.

---

## 10. www.controlnet.com.mx — ❓ Sin snapshot

No se proporcionó contenido. No se puede clasificar.

---

## 11. www.1gasfac.com.mx — ❓ Sin snapshot

No se proporcionó contenido. No se puede clasificar.

---

## 12. www.puentecoloradofacturacion.com.mx — ❓ Sin snapshot

No se proporcionó contenido. No se puede clasificar.

---

## Comparación con PINFRA

`bots/pinfra.js` resuelve una caseta de peaje **sin login**: solo RFC + correo ya dado de alta en el portal, y luego folio/carril/caseta.  
Los dos portales de `facturacion.sinaloa.gob.mx` son el caso opuesto: requieren cuenta de ciudadano y tienen un tiempo de espera de 5-6 días. **No se puede reutilizar la estrategia de PINFRA**; hay que tratarlos como portales con autenticación.

---

## Recomendación general

- Reintentar primero con el agente: **lasconchas.facturacionestacion.com**.
- Esperar/desbloquear externamente: **KFC / PRB**.
- Necesitan credenciales de cliente antes de cualquier intento: **Sinaloa (ambos)** y **Enerfueltech**.
- Para los 5 sin snapshot, bajar el HTML con `/web <url>` y re-clasificar.
