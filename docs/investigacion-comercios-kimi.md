# Investigación de comercios candidatos a automatización
## portal-facturas — Notas de reconocimiento (solo investigación, sin bots)

> ⚠️ **Restricción:** Este documento es únicamente investigación de escritorio. No se ejecutó ningún bot, no se hicieron peticiones de facturación reales y no se modificó código de `bots/`, `engine/`, `agentes/` ni `commerce/`.

---

## Resumen ejecutivo (ordenado de menor a mayor dificultad estimada)

| # | Comercio | Portal real confirmado / sospechado | Dificultad estimada |
|---|----------|-------------------------------------|---------------------|
| 1 | Autopista Cuota Caseta El Pisal / Las Brisas (Sinaloa) | `http://facturacion.sinaloa.gob.mx` | Fácil–Medio |
| 2 | Casa Ley | `https://facturacion.casaley.com.mx` (por confirmar en vivo) | Medio |
| 3 | La Parisina (Grupo Parisina) | Desconocido / dentro de `laparisina.com.mx` | Medio |
| 4 | Puente Colorado (Caseta San Luis Río Colorado) | `www.puentecoloradofacturacion.com.mx` | Medio–Difícil |
| 5 | KFC Santa Ana (Tijuana) | Posiblemente `https://facturacion.prb.com.mx/` (NO `kfolistensmx.com`) | Medio–Difícil |
| 6 | KFC (portal genérico) | `https://kfc.com.mx/es/facturacion.html` redirige a `facturacion.prb.com.mx` | Difícil (portal en mantenimiento / PRB) |

---

## 1. Autopista de Cuota Caseta El Pisal (Sinaloa) y 2. Autopista de Cuota Las Brisas — Culiacán (Caseta 59)

> **Nota:** Ambos usan el **mismo portal gubernamental**. El análisis es común; al final se indica la única diferencia esperada.

### URL real del portal
- `http://facturacion.sinaloa.gob.mx` (confirmada por el usuario; contenido inspeccionado).

### ¿Qué pide el formulario?
El sitio mostró en portada:
- Sección **"¿Cómo registrarse en el portal?"** → requiere **crear cuenta** previa (`/registro`).
- Sección **"Si has facturado recientemente"** → **iniciar sesión** (`/login`).
- Trámites facturables: **casetas de peaje de la empresa Orler**, ingresos estatales, folios preelaborados, operaciones en línea.
- Tiempos de espera post-pago publicados:
  - Casetas de peaje: **5–6 días**.
  - Operaciones de caja: inmediato.
  - Folio preelaborado: 2–3 días.
  - En línea: 3 días.

Campos esperados (portal de gobierno estatal, patrón habitual):
1. **Registro / login** previo (correo + contraseña).
2. Para casetas: **folio del pago / ticket de caseta**, selección del **tramo / caseta** (aquí es donde difieren El Pisal vs. Las Brisas), **RFC**, **uso CFDI**, **código postal**, **correo electrónico**.
3. Posible **CAPTCHA** al login o al generar (no se confirmó tipo desde el HTML proporcionado; en portales gubernamentales mexicanos suele ser reCAPTCHA v2 o imagen).

### Tecnología aparente
- HTML estático / posiblemente framework de gobierno (Ciudadano Digital / Zendesk para ayuda). No se observaron señales claras de React/Angular en el fragmento proporcionado.

### ¿Propio o whitelabel?
- **Portal propio del Gobierno del Estado de Sinaloa.** No es whitelabel comercial. La plataforma subyacente podría ser un motor compartido entre trámites estatales, pero para facturación de peaje no es una plataforma multi-comercio como `mefacturo.com`.

### Diferencia entre El Pisal y Las Brisas
- El flujo es **idéntico salvo un campo de selección de caseta / tramo** en el formulario de facturación (ej. "Caseta El Pisal" vs. "Caseta 59 Las Brisas"). Si el portal pide elegir la caseta de un catálogo, un solo bot podría cubrir ambas pasando el parámetro correspondiente.

### Dificultad estimada
- **Fácil–Medio.** El portal parece informativo y estructurado. La principal complicación es el **registro previo obligatorio**, el **retardo de 5–6 días** para facturar peajes y posibles horarios de mantenimiento de gobierno. No parece tener CAPTCHA agresivo, pero hay que confirmar en las pantallas internas `/login` y `/registro`.

---

## 3. Casa Ley

### URL real del portal
- La URL más probable es `https://facturacion.casaley.com.mx` o similar bajo `casaley.com.mx`.
- **No confirmada en vivo** en este análisis: el ticket no traía URL y no se pudo inspeccionar el HTML.

### ¿Qué pide el formulario?
Típico de supermercados grandes en México:
- **Folio / ticket de compra** (número de ticket o código de barras).
- **RFC**.
- **Uso CFDI**.
- **Código postal** (para el receptor).
- **Correo electrónico**.
- Posible CAPTCHA (reCAPTCHA v2 es común en cadenas grandes).
- Generalmente es un **formulario de un solo paso** o dos pasos (datos + confirmación).

### Tecnología aparente
- Desconocida sin inspección directa. Cadenas grandes suelen usar soluciones propias o plataformas como **Edicom**, **Comprobase**, **RetailEDX** o un portal interno en ASP.NET/PHP.

### ¿Propio o whitelabel?
- Probablemente **portal propio de Casa Ley** o implementado por un proveedor de facturación masiva (p. ej. Edicom). No parece ser el mismo motor que `mefacturo.com`.

### Dificultad estimada
- **Medio.** Supermercados grandes suelen tener portales estables, pero la variedad de formatos de ticket (ticket largo, código de barras, folio corto vs. largo) puede complicar el OCR. El volumen potencial es alto, por lo que vale la pena.

---

## 4. La Parisina (Grupo Parisina S.A. de C.V.)

### URL real del portal
- Sitio corporativo: `http://www.laparisina.com.mx/` (contenido inspeccionado: portada vacía / sin información visible de facturación en el fragmento proporcionado).
- El link de facturación **no apareció en la portada** entregada; probablemente está en:
  - Pie de página (`/facturacion`, `/facturacion-electronica`, `/cfdi`).
  - Menú de "Servicios" o "Atención al cliente".
- URL candidatas a verificar: `http://www.laparisina.com.mx/facturacion`, `http://www.laparisina.com.mx/facturacion-electronica`, `https://facturacion.laparisina.com.mx`.

### ¿Qué pide el formulario?
Sin acceso al link real, se estima para panificadora/tienda de retail:
- **Folio / ticket** (o código de ticket impreso).
- **RFC**.
- **Uso CFDI**.
- **Correo electrónico**.
- Posible **código postal**.
- CAPTCHA: posible pero no seguro.

### Tecnología aparente
- El sitio principal parece HTML clásico / posiblemente generado por un constructor. No se observaron frameworks modernos en el fragmento.

### ¿Propio o whitelabel?
- Desconocido hasta encontrar el portal real. Panificadoras medianas suelen contratar plataformas como **Finkok**, **Edicom**, **Comprobase** o **mefacturo.com**. Si el dominio de facturación es distinto al corporativo, es señal de whitelabel.

### Dificultad estimada
- **Medio.** Depende totalmente de encontrar el portal correcto. Si usa una plataforma conocida, la dificultad puede bajar a **Fácil–Medio** reutilizando patrones. Si es un portal artesanal, sube a **Medio–Difícil**.

---

## 5. Puente Colorado — Caseta San Luis Río Colorado (peaje / autopista)

### URL real del portal
- `www.puentecoloradofacturacion.com.mx` (proporcionada por el usuario; **no inspeccionada directamente**).

### ¿Qué pide el formulario?
Patrón habitual de portales de peaje privados en México:
- **Número de folio / tag / recibo de pago** (el ticket de caseta).
- **Placas** (muy común en peajes).
- **RFC**.
- **Uso CFDI**.
- **Correo electrónico**.
- **Código postal**.
- Posible CAPTCHA.
- Posible **registro previo** o login.

### Tecnología aparente
- Desconocida sin inspección. Portales de concesionarias suelen ser **PHP clásico, ASP.NET o soluciones de facturación tercerizadas**.

### ¿Propio o whitelabel?
- Probablemente **portal propio o de la concesionaria**. No se reporta que comparta motor con otros peajes.

### Dificultad estimada
- **Medio–Difícil.** Nunca se ha intentado, no hay datos de estructura y los portales de peajes suelen tener variaciones de formulario, tiempos de espera y a veces requieren datos difíciles de leer en el OCR (placas, tag, folio largo). Sin embargo, el volumen puede justificar el esfuerzo si la concesionaria procesa muchos tránsitos.

---

## 6. KFC Santa Ana (Tijuana) y portal genérico KFC

### URLs involucradas
1. `www.kfolistensmx.com` — en un ticket de KFC Santa Ana.
2. `https://kfc.com.mx/es/facturacion.html` — intento automático previo con timeout de 90s.
3. `https://facturacion.prb.com.mx/` — link real que aparece en el footer de `kfc.com.mx/es/facturacion.html`.

### Hallazgo clave
El contenido inspeccionado de `https://kfc.com.mx/es/facturacion.html` muestra en el footer un link de **"Facturación"** que apunta a:

```text
https://facturacion.prb.com.mx/
```

Esto indica que **la URL correcta de facturación de KFC México es `facturacion.prb.com.mx`, no `kfc.com.mx/es/facturacion.html`**. El intento previo con timeout de 90s probablemente falló porque la página de KFC es solo un *landing* informativo que no procesa la factura.

### ¿Qué es `kfolistensmx.com`?
- El nombre sugiere un portal de **encuestas de satisfacción** ("listen" = escucha al cliente), típico de franquicias.
- **No parece ser un portal de facturación.** Es muy probable que sea el sitio donde se ingresa el folio del ticket para una encuesta y, en algunos casos, redirige o muestra un link a facturación.
- **Cuidado:** si es un portal multi-franquicia, podría agrupar KFC, Pizza Hut u otros bajo el mismo operador/franquiciatario. Sin inspección directa no se puede confirmar si ofrece facturación.

### ¿Qué pide el formulario?
Basado en el patrón PRB (Proveedor de Facturación Electrónica para restaurantes):
- **Folio del ticket / código de facturación**.
- **RFC**.
- **Uso CFDI**.
- **Correo electrónico**.
- **Código postal**.
- Posible CAPTCHA.
- Posible **registro** previo.

### Tecnología aparente
- `kfc.com.mx` parece un sitio corporativo moderno (probablemente React/Next.js o similar).
- `facturacion.prb.com.mx` es el portal de facturación tercerizado; sin inspección directa no se sabe su stack, pero PRB suele usar aplicaciones web robustas (Java/.NET/PHP).

### ¿Propio o whitelabel?
- **Whitelabel / plataforma de facturación PRB.** El mismo proveedor (`prb.com.mx`) probablemente factura para KFC y otras cadenas de restaurantes en México. Si se confirma que PRB es una plataforma compartida, un bot para KFC podría adaptarse a otras marcas que usen el mismo backend.

### Estado actual
- Según `CLAUDE.md`, el portal `facturacion.prb.com.mx:444` estaba en **MANTENIMIENTO**. Esto explica los timeouts.
- Antes de construir un bot, hay que verificar que el portal haya salido de mantenimiento y cuál es su URL exacta de producción (`facturacion.prb.com.mx` sin puerto, o con otro puerto).

### Dificultad estimada
- **Medio–Difícil** para KFC Santa Ana (hay que descartar `kfolistensmx.com` y apuntar a PRB; además, el portal estuvo en mantenimiento).
- **Difícil** para el intento genérico contra `kfc.com.mx/es/facturacion.html`, porque esa URL no factura realmente.

---

## Recomendaciones de prioridad

1. **Autopista Sinaloa (El Pisal / Las Brisas)** — Baja dificultad, portal conocido y estable. Vale la pena si hay volumen de tickets de estas casetas.
2. **Casa Ley** — Medio. Cadena grande; si se confirma el portal, el impacto es alto.
3. **La Parisina** — Medio. Primero encontrar el link real de facturación.
4. **Puente Colorado** — Medio–Difícil. Requiere exploración inicial, pero es un nicho de peaje que puede repetirse.
5. **KFC Santa Ana** — Medio–Difícil. Depende de que PRB esté activo; `kfolistensmx.com` no parece ser el portal correcto.
6. **KFC genérico vía `kfc.com.mx/es/facturacion.html`** — Difícil / incorrecto. Esa URL no factura; hay que apuntar a PRB.

---

## Notas metodológicas

- No se ejecutó ningún código de automatización.
- Las URLs sin inspección directa están marcadas como "por confirmar en vivo".
- Para los portales gubernamentales se recomienda respetar horarios de disponibilidad y tiempos de espera post-pago.
- Para KFC se recomienda no invertir en `kfolistensmx.com` hasta confirmar que efectivamente ofrece facturación; lo más probable es que sea solo encuestas.
