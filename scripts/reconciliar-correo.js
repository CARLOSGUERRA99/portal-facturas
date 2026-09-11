// Reconciliador GENÉRICO de facturas que llegan por correo.
//
// Sustituye a los scripts de un solo uso (recuperar-arco.js tenía un mapa fijo
// de total→ticket, había que editarlo cada vez). Este recorre el buzón, lee el
// XML adjunto de cada correo y lo empareja con los tickets que quedaron
// esperando el CFDI (los que tienen procesando_correo_desde y siguen sin
// factura), usando el TOTAL del CFDI como llave.
//
// Reglas de seguridad, todas obligatorias antes de tocar la BD:
//   · el RFC receptor del XML debe ser el de GPN;
//   · el total del CFDI debe cuadrar con el total leído del ticket (±0.01);
//   · el ticket no debe tener ya una factura registrada.
// Si algo no cuadra se informa y NO se escribe nada: es preferible dejarlo
// pendiente que registrar una factura que no corresponde.
require('dotenv').config();
const Imap = require('imap');
const { simpleParser } = require('mailparser');
const db = require('../lib/db');
const { subirArchivoR2 } = require('../storage/r2');
const { extraerUUIDcfdi } = require('../lib/util');

const RFC_GPN = 'GPR110128QD8';
const DIAS_ATRAS = parseInt(process.env.DIAS_ATRAS || '7', 10);
// --emisor-ok 340,412 → salta la comprobación de que el nombre del emisor se
// parezca al comercio, SOLO en esos tickets. Ver el comentario junto a la
// comprobación. Todo lo demás (RFC receptor, total, UUID) se sigue exigiendo.
const EMISOR_OK = (() => {
  const i = process.argv.indexOf('--emisor-ok');
  if (i < 0) return [];
  return String(process.argv[i + 1] || '').split(',').map((n) => parseInt(n, 10)).filter(Boolean);
})();

// ── Marca del ticket → razón social con la que timbra ─────────────────────────
// Muchas cadenas emiten a nombre de una sociedad que no contiene la marca. Sin
// esta tabla, la comprobación de parecido rechaza SIEMPRE sus CFDI y el ticket
// se queda colgado aunque la factura esté en el buzón. Cada línea debe salir de
// un CFDI real ya visto, nunca de una suposición: emparejar de más es peor que
// emparejar de menos, porque le pega a un ticket la factura de otro.
//   [ palabra que aparece en el comercio del ticket , trozo de la razón social ]
const ALIAS_EMISOR = [
  ['CAFFENIO', 'SERVICIOS ADMINISTRATIVOS OSLO'], // visto en el #363 (UUID D8C5E0E3…)
  ['BROKINNI', 'OPREVI'],                          // visto en el #356 (UUID 37dc26cc…)
  ['CARL', 'ICR'],                                 // Carl's Jr corporativo
  ['CARL', 'STAR LAGUNA'],                         // Carl's Jr franquicia A-Losa (#367)
  ['KFC', 'PREMIUM RESTAURANT BRANDS'],            // visto en el #364, portal PRB
  ['KFC', 'LOS SENDEROS'],                         // KFC de franquicia Senderos (#350)
  ['SUSHIITTO', 'LOS SENDEROS'],
  ['SUPER VOY', 'LOS SENDEROS'],                   // #368 y #370
  ['SALA DE ESPERA', 'COMERCIAL CAMIONERA'],       // #361
  ['EXPRESO FUTURA', 'FUTURA SIENTE'],             // #354 y #369
  ['CHURCH', 'SUBMARINOS DE VALLARTA'],            // #362
  ['SEVILLA PALACE', 'ELSEAN'],                    // #375 y #376
  ['LOS NARANJOS', 'ELSEAN'],
  ['PIONEROS', 'SERVICIO PIONEROS'],               // #360
];

const parseJson = (v) => {
  if (!v) return {};
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return {}; }
};

(async () => {
  // 1) Tickets que esperan CFDI por correo y todavía no tienen factura.
  // ⚠️ Se consideran TODOS los tickets sin factura, no solo los que están
  // esperando correo. El filtro anterior exigía
  // `procesando_correo_desde IS NOT NULL`, y eso dejaba fuera a los tickets que
  // nunca pasaron por un bot (los que fueron al agente, o los que el usuario
  // pidió a mano al comercio). Pasó de verdad: los CFDI de PETROLIFEROS LA
  // TERRITORIAL ($724.98) y SERVICIO EFIGAS ($477.38) llevaban días en el buzón
  // sin que nadie los reclamara, porque sus tickets no tenían esa marca.
  //
  // Abrir el criterio es seguro porque más abajo se verifica, antes de escribir
  // nada: que el CFDI no esté ya registrado en otro ticket, que el RFC receptor
  // sea el nuestro, que el total cuadre al céntimo, y que el nombre del emisor
  // se parezca al comercio del ticket.
  const [pendientes] = await db.query(`
    SELECT t.id, t.comercio, t.ocr_json, t.user_id, t.status
      FROM tickets t
      LEFT JOIN facturas f ON f.ticket_id = t.id
     WHERE f.id IS NULL
       AND t.status <> 'procesado'
     ORDER BY t.id`);

  const objetivos = pendientes.map((t) => {
    const o = parseJson(t.ocr_json);
    return { id: t.id, userId: t.user_id, comercio: t.comercio, total: parseFloat(o.total), ocr: o };
  }).filter((t) => !isNaN(t.total));

  console.log(`📋 ${objetivos.length} ticket(s) esperando CFDI por correo:`);
  for (const t of objetivos) console.log(`   #${t.id} $${t.total} — ${String(t.comercio).slice(0, 45)}`);
  if (!objetivos.length) { console.log('nada que reconciliar'); process.exit(0); }

  // 2) Recorrer el buzón.
  const imap = new Imap({
    user: process.env.IMAP_USER, password: process.env.IMAP_PASS,
    host: process.env.IMAP_HOST, port: parseInt(process.env.IMAP_PORT) || 993,
    tls: true, tlsOptions: { rejectUnauthorized: false },
    // ⚠️ Sin timeouts, node-imap se queda esperando PARA SIEMPRE si el servidor
    // no responde: este script se quedó colgado 70 minutos sin fallar ni
    // terminar. Con esto revienta rápido y se puede reintentar.
    connTimeout: 20000,
    authTimeout: 20000,
    keepalive: false,
  });

  // Cinturón y tirantes: si por lo que sea el flujo se atasca a medio fetch,
  // se corta el proceso en vez de dejar un zombi consumiendo recursos.
  const guillotina = setTimeout(() => {
    console.error('⏱️ tiempo máximo excedido (5 min) — se aborta');
    try { imap.end(); } catch {}
    process.exit(3);
  }, 5 * 60 * 1000);
  guillotina.unref?.();

  imap.once('ready', () => {
    imap.openBox('INBOX', false, (err) => {
      if (err) { console.error('❌', err.message); process.exit(1); }
      const desde = new Date(Date.now() - DIAS_ATRAS * 86400000);
      imap.search([['SINCE', desde]], (e2, uids) => {
        if (e2 || !uids?.length) { console.log('sin correos en la ventana'); imap.end(); return; }
        console.log(`\n📨 revisando ${uids.length} correo(s) de los últimos ${DIAS_ATRAS} días…`);

        const f = imap.fetch(uids, { bodies: '', markSeen: false });
        let pend = uids.length;
        const correos = [];
        f.on('message', (msg) => {
          let uid = null;
          msg.on('attributes', (a) => { uid = a.uid; });
          msg.on('body', (stream) => {
            simpleParser(stream, async (pe, parsed) => {
              pend--;
              if (!pe) correos.push({ uid, parsed });
              if (pend > 0) return;

              let n = 0;
              const usados = new Set();
              for (const { uid, parsed } of correos) {
                const xmlAtt = (parsed.attachments || []).find((a) => /\.xml$/i.test(a.filename || ''));
                if (!xmlAtt) continue;
                const pdfAtt = (parsed.attachments || []).find((a) => /\.pdf$/i.test(a.filename || ''));
                const xml = xmlAtt.content.toString('utf8');
                const total = (xml.match(/<(?:cfdi:)?Comprobante\b[^>]*\sTotal="([\d.]+)"/i) || [])[1];
                const rfcReceptor = (xml.match(/<(?:cfdi:)?Receptor[^>]*\sRfc="([^"]+)"/i) || [])[1];
                const nombreEmisor = (xml.match(/<(?:cfdi:)?Emisor[^>]*\sNombre="([^"]{0,80})"/i) || [])[1] || '';
                if (!total) continue;
                if (rfcReceptor !== RFC_GPN) continue;

                const cand = objetivos.find((t) => !usados.has(t.id) && Math.abs(t.total - parseFloat(total)) <= 0.01);
                if (!cand) continue;

                // ⚠️ Emparejar SOLO por importe puede robarle el CFDI a otro
                // ticket: pasó de verdad con el UUID 6e804707, que se asignó a
                // la vez al #125 y al #169, ambos de $1,500. Antes de escribir
                // hay que comprobar que ese CFDI no esté ya registrado, y que
                // el emisor tenga algo que ver con el comercio del ticket.
                const uuidPrev = (extraerUUIDcfdi(xmlAtt.content) || '').toLowerCase();
                const [yaUsado] = await db.query('SELECT ticket_id FROM facturas WHERE xml_url LIKE ?', [`%${uuidPrev}%`]);
                if (yaUsado.length) { console.log(`   ⏭️ CFDI ${uuidPrev} ya está en el ticket #${yaUsado[0].ticket_id}`); continue; }

                // El nombre del emisor debe parecerse al comercio del ticket.
                // Es la última defensa contra pegarle a un ticket la factura de
                // otro comercio que casualmente costó lo mismo.
                //
                // Da falsos positivos cuando la gasolinera factura a nombre de
                // su DUEÑO y el ticket trae la marca: Palo Verde (#340) emite
                // como "JUAN PEDRO RODRIGUEZ VAZQUEZ" y el ticket dice "PEMEX
                // Palo Verde". Para esos casos existe --emisor-ok, que salta
                // SOLO esta comprobación y solo en los tickets que se nombren:
                // el RFC del receptor, el total y el UUID se siguen exigiendo.
                // Usarlo únicamente con prueba independiente de que la factura
                // es de ese ticket (p.ej. haberla timbrado uno mismo).
                // Antes de dar por bueno el parecido, se consulta la tabla de
                // razones sociales conocidas: hay cadenas que facturan a nombre
                // de una sociedad que no lleva la marca por ningún lado, y sin
                // esto TODAS sus facturas se quedaban fuera para siempre.
                const palabras = String(cand.comercio || '').toUpperCase().split(/[^A-ZÁÉÍÓÚÑ]+/).filter((p) => p.length > 4);
                const emisorUp = nombreEmisor.toUpperCase();
                const comercioUp = String(cand.comercio || '').toUpperCase();
                const aliasOk = ALIAS_EMISOR.some(([marca, razon]) =>
                  comercioUp.includes(marca) && emisorUp.includes(razon));
                if (aliasOk) {
                  console.log(`   🏷️ alias conocido: "${nombreEmisor.slice(0, 40)}" es la razón social de "${cand.comercio}"`);
                }
                if (!aliasOk && palabras.length && !palabras.some((p) => emisorUp.includes(p))) {
                  if (EMISOR_OK.includes(cand.id)) {
                    console.log(`   🔓 --emisor-ok: se acepta "${nombreEmisor.slice(0, 40)}" para el ticket #${cand.id} pese a no parecerse al comercio`);
                  } else {
                    console.log(`   ⚠️ $${total}: el emisor "${nombreEmisor.slice(0, 40)}" no se parece al comercio del ticket #${cand.id} ("${String(cand.comercio).slice(0, 40)}") — se omite por seguridad`);
                    continue;
                  }
                }

                const uuid = (extraerUUIDcfdi(xmlAtt.content) || '').toLowerCase();
                if (!uuid) { console.log(`   ⚠️ correo UID ${uid} ($${total}) sin UUID legible — se omite`); continue; }

                const [ya] = await db.query('SELECT id FROM facturas WHERE ticket_id=?', [cand.id]);
                if (ya.length) { usados.add(cand.id); continue; }

                console.log(`\n➡️ UID ${uid} → ticket #${cand.id} | $${total} | ${nombreEmisor.slice(0, 50)}`);
                const xmlUrl = await subirArchivoR2(xmlAtt.content, `facturas/${uuid}.xml`, 'application/xml');
                const pdfUrl = pdfAtt ? await subirArchivoR2(pdfAtt.content, `facturas/${uuid}.pdf`, 'application/pdf') : null;
                console.log(`   ✅ UUID ${uuid}`);

                const ocr = cand.ocr;
                ocr.uuid_cfdi = uuid;
                await db.query(
                  "UPDATE tickets SET status='procesado', error_msg=NULL, reintento_programado=NULL, ocr_json=? WHERE id=?",
                  [JSON.stringify(ocr), cand.id]
                );
                await db.query(
                  "INSERT INTO facturas (user_id, ticket_id, comercio, xml_url, pdf_url, status) VALUES (?,?,?,?,?,'completado')",
                  [cand.userId, cand.id, String(cand.comercio || nombreEmisor || 'Comercio').slice(0, 50), xmlUrl, pdfUrl]
                );
                await new Promise((r) => imap.addFlags([uid], ['\\Seen'], () => r()));
                console.log(`   💾 ticket #${cand.id} → procesado + factura registrada`);
                usados.add(cand.id);
                n++;
              }

              const faltan = objetivos.filter((t) => !usados.has(t.id));
              console.log(`\n=== ${n} factura(s) reconciliada(s) ===`);
              if (faltan.length) console.log('sigue(n) sin correo: ' + faltan.map((t) => `#${t.id} ($${t.total})`).join(', '));
              imap.end();
            });
          });
        });
        f.once('error', (er) => { console.error(er.message); imap.end(); });
      });
    });
  });
  imap.once('error', (e) => { console.error('❌ IMAP', e.message); process.exit(1); });
  imap.once('end', () => process.exit(0));
  imap.connect();
})();
