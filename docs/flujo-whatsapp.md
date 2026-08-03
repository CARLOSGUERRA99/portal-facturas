# Facturación por WhatsApp — flujo propuesto

**Servicios Administrativos G&A · Timbra**
Documento de diseño, 03/08/2026. Escrito para revisar ANTES de construir.

---

## Lo que WhatsApp cambia y lo que no

Conviene decirlo primero porque condiciona todo lo demás.

**Cambia:** cómo llega el ticket. Hoy el residente entra al portal, se loguea y
sube una foto. Con WhatsApp le manda la foto a un número, como le manda una foto
a su esposa. Se acabó la fricción — y esa fricción es la razón real de que los
tickets se acumulen sin subir.

**No cambia:** cómo se factura. El CAPTCHA, los plazos de cada portal y los
formularios están del lado del comercio. Un portal bloqueado seguirá bloqueado
llegue el ticket por donde llegue.

Dicho de otro modo: WhatsApp resuelve el problema de **entrada**, que hoy es el
cuello de botella real. No toca el de **salida**.

---

## Requisito previo: la API de WhatsApp Business

No sirve WhatsApp normal ni WhatsApp Business de app. Hace falta la **Cloud API
de Meta**, y con ella tres cosas:

1. Una cuenta de Meta Business verificada.
2. Un número que NO esté dado de alta en la app de WhatsApp (se "quema" para la
   API; si el número ya tiene WhatsApp hay que darlo de baja antes).
3. Plantillas aprobadas por Meta para poder ESCRIBIR PRIMERO.

Ese punto 3 es el que más suele sorprender y condiciona el diseño:

> Fuera de una ventana de 24 horas desde el último mensaje del usuario, el
> negocio **solo** puede mandar plantillas aprobadas previamente. No se puede
> improvisar un "oye, tu factura ya salió" tres días después.

Por eso el flujo de abajo agrupa los avisos y usa plantillas fijas.

**Coste:** Meta cobra por conversación iniciada por el negocio (categoría
*utility*, en México del orden de $0.02–0.04 USD). Las que inicia el usuario son
gratis dentro de la ventana de 24h. Con 100 tickets al mes son céntimos: el
coste real sigue siendo el OCR (~$0.025 por ticket).

---

## Cómo se identifica al cliente

Este es el punto delicado del diseño multicliente, y hay que resolverlo bien
desde el principio.

Un número de teléfono **no** dice a qué cliente pertenece. Si Daniel Ávila y una
capturista de GPN mandan una foto al mismo número, el sistema tiene que saber
con qué RFC timbrar. Timbrar con el RFC equivocado no se corrige: ya vimos el
aviso de CAPUFE — *"una vez emitida la factura no se podrá remitir a un RFC
diferente ni corregir datos"*.

**Solución: alta previa del teléfono.** Se añade una tabla:

```sql
telefonos_autorizados
  telefono      VARCHAR(20) PRIMARY KEY   -- E.164: +526441234567
  cliente_id    INT NOT NULL              -- a qué contribuyente factura
  residente_id  INT NULL                  -- a quién se le imputa el gasto
  nombre        VARCHAR(100)
  activo        TINYINT(1) DEFAULT 1
```

Un número desconocido **no factura nada**. Recibe:

> No tengo este número dado de alta. Pídele a tu administrador que lo registre
> en el portal y vuelve a intentarlo.

Es deliberadamente cerrado: es preferible rechazar un ticket legítimo que
timbrar con el RFC de otro.

---

## El flujo, paso a paso

```
1. RECEPCIÓN
   El residente manda la foto al número de Timbra.
   → webhook POST /api/whatsapp/webhook
   → se comprueba el teléfono contra telefonos_autorizados
   → si no está: mensaje de rechazo y fin
   → si está: se descarga el archivo de la Media API de Meta y va a R2

2. ACUSE INMEDIATO  (< 3 segundos)
   "Recibido 📸 Lo estoy leyendo, te aviso en un minuto."
   Importante: se contesta ANTES de procesar. Si el usuario no ve respuesta
   rápida, reenvía la foto — y entonces hay que deduplicar.

3. OCR
   Se encola en la cola `vision`, la misma de siempre.
   Pasada 1 detecta portal · Pasada 2 extrae · Pasada 3 relee lo dudoso.

4. CONFIRMACIÓN — solo si hace falta
   Si la confianza es alta y el portal es conocido, NO se pregunta nada: se
   factura directo. Preguntar por costumbre convierte el bot en un formulario
   y mata la ventaja.
   Se pregunta solo cuando:
     · algún campo obligatorio salió dudoso;
     · la foto trae más de una compra (ticketsEnFoto > 1);
     · el importe supera un umbral que el cliente configure.

5. FACTURACIÓN
   Cola `bots` → el bot del portal. Sin cambios respecto a hoy.

6. ENTREGA
   Con el CFDI timbrado se manda el PDF por WhatsApp y el XML por correo.
   El XML pesa poco pero en el móvil no se puede hacer nada con él; el PDF es
   lo que la gente quiere ver. El XML es para la contabilidad.

7. LO QUE NO SALE
   Si el portal está bloqueado o falla, el residente NO recibe un error.
   Recibe "está en proceso" y el ticket cae en la bandeja de validación
   manual. Es la regla que ya rige en el portal y aquí vale igual.
```

---

## Conversación de ejemplo

Caso real reproducido: Daniel Ávila manda una caseta de CAPUFE.

```
[10:42] Daniel  📷 (foto del ticket de caseta)

[10:42] Timbra  Recibido 📸
                Lo estoy leyendo, te aviso en un minuto.

        ── el sistema, por dentro ──
        · teléfono +526441234567 → cliente #2 DANIEL ALEJANDRO GUERRA AVILA
        · foto → R2 · ticket #201 creado
        · Pasada 1: portal capufe (99 pts)
        · Pasada 2: código K8KP KTZB HKSF 7WMV HQ · $114 · confianza alta
        · sin campos dudosos → no se pregunta nada
        · a la cola de bots

[10:43] Timbra  ✅ Listo
                CAPUFE · Plaza Esperanza
                $114.00 · 01/08/2026

                Tu factura ya está timbrada.
                Te mando el PDF y el XML va a tu correo.

                📄 factura-FNPE-74324519.pdf
```

Y cuando el OCR no las tiene todas consigo:

```
[11:15] Ana     📷 (foto de un ticket arrugado)

[11:15] Timbra  Recibido 📸

[11:16] Timbra  Leí esto, ¿lo confirmas?

                Gasolinera:  PABA
                Importe:     $1,500.00
                Fecha:       31/07/2026
                Folio:       0310-00823049-00759353

                1️⃣ Todo correcto
                2️⃣ El importe está mal
                3️⃣ Mejor mando otra foto

[11:16] Ana     1

[11:17] Timbra  ✅ Listo — factura en camino.
```

Y el caso de la foto con dos tickets, que hoy ya detectamos:

```
[12:03] Luis    📷 (dos tickets en la misma foto)

[12:03] Timbra  Recibido 📸
                Veo 2 tickets en esta foto. Registré el primero
                (Grupo Inmo, $1,000.00).

                Mándame el segundo en otra foto para no confundirlos 🙏
```

---

## Lo que hay que construir

Ordenado por dependencia, no por dificultad.

| # | Pieza | Notas |
|---|---|---|
| 1 | Cuenta Meta Business + número + plantillas | Trámite, no código. Es el camino crítico: la aprobación tarda días |
| 2 | Tabla `telefonos_autorizados` + alta desde el panel | Sin esto no se puede facturar con seguridad |
| 3 | `POST /api/whatsapp/webhook` | Verificación de firma `X-Hub-Signature-256`. Contestar **200 en menos de 5 s** o Meta reintenta |
| 4 | Descarga de la Media API | La URL del archivo caduca y exige el token: hay que bajarla al momento y subirla a R2 |
| 5 | Puente con la cola `vision` | Es reusar lo que ya existe: el ticket entra igual que desde el portal |
| 6 | Máquina de estados de la conversación | Solo hace falta si se pregunta. Estado en Redis con caducidad de 24h, que es la ventana de Meta |
| 7 | Envío del PDF | Subir el media a Meta y mandarlo por su id |
| 8 | Deduplicación | Meta reintenta los webhooks: guardar el `message.id` y descartar repetidos. Sin esto, un reintento factura dos veces |

**Lo que NO hay que construir:** el OCR, los bots, la deduplicación de tickets,
el registro de CFDI y la bandeja manual ya están y no se tocan. WhatsApp es una
puerta de entrada nueva a la misma casa.

---

## Riesgos, dichos de frente

**El reintento de Meta.** Si el webhook no contesta 200 rápido, Meta reenvía el
mismo mensaje. Sin deduplicación por `message.id` eso son dos tickets y
potencialmente dos facturas. Es el fallo más probable de todos y el más caro.

**La ventana de 24 horas.** Si un ticket tarda más de un día en resolverse —y
los bloqueados tardan— el aviso ya no puede ser un mensaje libre: tiene que ser
plantilla aprobada. Hay que preverlo desde el diseño, no descubrirlo en
producción.

**La calidad de las fotos.** En el portal la gente sube desde la galería; por
WhatsApp dispara al vuelo. El banco de OCR está en 98.5% con fotos ya
razonables — conviene volver a medirlo con las primeras 20 de WhatsApp antes de
sacar conclusiones.

**El número es la identidad.** Si alguien manda un ticket desde el teléfono de
otro, se factura al RFC del dueño del número. Por eso el alta previa es
obligatoria y por eso un número desconocido no factura.

---

## Sugerencia de orden

1. Arrancar el trámite de Meta **ya**: es lo único que no depende de nosotros y
   lo que más tarda.
2. Mientras tanto, `telefonos_autorizados` y su alta en el panel.
3. Webhook + Media API + puente con la cola, con un solo número de prueba (el
   tuyo).
4. Probar con 10 tickets reales antes de darle el número a ningún cliente.
5. Abrirlo a Daniel Ávila —un cliente, un teléfono— antes que a GPN, que tiene
   varias capturistas y multiplica los casos raros.
