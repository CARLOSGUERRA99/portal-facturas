// RedCo — plataforma "facturaenlinea.aspx" de la ALIANZA GASOLINERA REDCO.
// (IIS 10 / ASP.NET 4.0 + DevExpress. Sin login, sin captcha, un solo paso
// visible.)
//
// ⚠️ ESTE BOT NO ES DE UNA GASOLINERA: ES DE UNA PLATAFORMA COMPARTIDA.
// gruporedco.com/acceso-facturacion.html publica un mapeo JS de ~18 grupos
// gasolineros, y CADA UNO tiene SU PROPIA instancia del MISMO
// facturaenlinea.aspx, en su propio host DDNS y su propio puerto. Confirmados
// en el reconocimiento del 11-sep-2026:
//     REDMAX        http://facturasproneg.dynu.net:8000
//     SEVAFUSA      http://sevafusa.fortiddns.com:8081
//     JEZAM         http://jezam.dnsalias.net:8082
//     LOS ARRIEROS  http://losarrieros.dynalias.net:8083
//     HORIZON       http://horizoncongreso.bounceme.net:8092   ← ticket #371
// Por eso el bot NO fija un host: acepta la base por parámetro (baseUrl /
// portalUrl / urlEstacion), y si no la tiene la RESUELVE leyendo ese mapeo.
// Está escrito para cubrir los tickets futuros de los otros 17 grupos, no solo
// el de Horizon.
//
// ⚠️ TRAMPA DEL PUERTO (la que costó el reconocimiento): las DOS URLs
// PUBLICADAS OFICIALMENTE PARA HORIZON ESTÁN CAÍDAS. La web de Grupo Horizon
// enlaza a 201.140.99.157:698 y el mapeo de RedCo a …bounceme.net:82; las dos
// dan conexión rechazada. Los tres nombres apuntan al MISMO host: es un DDNS
// doméstico con el puerto móvil, y el que responde hoy (HTTP 200) es el 8092.
// Conclusión de diseño: el puerto que venga de cualquier fuente es solo una
// PISTA. El bot PRUEBA UNA LISTA de puertos contra el host y se queda con el
// primero que sirva el formulario. Fijar un puerto aquí es garantizar que este
// bot deje de funcionar el día que el router del dueño reasigne el NAT.
//
// ── CAMPOS (verificados en vivo en el HTML de Horizon, HTTP 200) ────────────
//   #ASPxFormLayout1_Txt_RFC_I               RFC
//   #ASPxFormLayout1_Txt_FolioFacturacion_I  Folio de Facturación
//   #ASPxFormLayout1_Txt_Importe_I           Importe (validación de cliente
//                                            "Valor no válido")
//   #ASPxFormLayout1_Btn_Facturar_I          botón Facturar
// El sufijo "_I" es DevExpress: es el <input> real dentro del control. Por eso
// aquí NO se pone .value — se TECLEA de verdad (click + keyboard.type) y se
// verifica que el valor quedó puesto. Con .value el campo se ve lleno y el
// framework lo sigue creyendo vacío. Mismo toolkit que bots/gasolineros.js,
// que es la referencia de código de este archivo (no de cobertura: es otro
// sitio y otro flujo).
//
// ── LO QUE NO SE PUDO CONFIRMAR (y aquí queda DEFENSIVO, no adivinado) ─────
// (1) NO SE ENVIÓ EL FORMULARIO. No se sabe qué hay después de "Facturar":
//     puede que timbre de una y ofrezca descarga, puede que abra un SEGUNDO
//     PASO pidiendo razón social / CP / régimen / uso de CFDI / correo, o que
//     entregue solo por correo. El bot detecta los tres casos y no asume
//     ninguno: si aparecen campos nuevos los llena por rótulo, si aparecen
//     enlaces XML/PDF los baja, y si no hay ni una cosa ni la otra devuelve
//     procesandoCorreo o un reintentar_despues que dice explícitamente que
//     puede haberse emitido. PENDIENTE DE VERIFICAR EN VIVO.
// (2) NO SE SABE CUÁL DE LOS DOS DATOS DEL OCR ES EL "Folio de Facturación":
//     el ticket #371 trae folio=52675 y referencia=62CDC36. Es la trampa de
//     "los dos folios" ya documentada en el proyecto (IGasFac, NetPay,
//     NexusFuel: cuando dos números parecen el folio, casi siempre vale el
//     otro). El bot PRUEBA LOS DOS: primero el alfanumérico (62CDC36 — en
//     estos portales el "folio de facturación" suele ser el código con letras,
//     no el consecutivo de la impresora) y, si el portal lo rechaza SIN haber
//     emitido nada, reintenta con el numérico y lo deja escrito en el log.
//     PENDIENTE DE VERIFICAR EN VIVO cuál es el bueno.
// (3) El mapeo JS de gruporedco.com se lee con un parser heurístico: se
//     confirmó que la página existe y qué hosts publica, pero NO la forma
//     exacta del objeto JS. Si el parser no saca nada, cae al mapa semilla de
//     abajo, y siempre se puede forzar con baseUrl/portalUrl. PENDIENTE DE
//     VERIFICAR EN VIVO.
// (4) Los correos de facturación propios de Horizon no se pudieron verificar.
//     El único correo CONFIRMADO es el de la alianza:
//     atencionclientes@gruporedco.com — es el que se devuelve como
//     email_contacto para que el sistema reclame la factura por correo.
//
// 🛑 Sobre duplicados: no se sabe si este portal frena un folio ya facturado.
// Mientras no se compruebe, el bot trata "no se confirmó nada" como
// reintentar_despues CON AVISO, nunca como "no pasó nada": ver la nota del
// click que navega más abajo.
