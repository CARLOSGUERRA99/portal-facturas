// Da de alta en el sistema los CFDI que llegaron al buzón y NO tienen ticket.
//
// Caso real que lo motiva (02/08/2026): el CFDI de AutoZone que se acababa de
// emitir (ticket #142, $648) no tenía ticket al que engancharse, porque ese
// ticket se había borrado en la limpieza de julio. Sin este script la factura
// se queda en el correo, fuera del sistema.
//
// De paso, este script es el que aclara si un CFDI del buzón está o no
// registrado: mirar solo el correo lleva a creer que hay facturas sueltas
// cuando en realidad ya tienen su ticket. Comprobarlo contra la BD es el punto.
//
// A diferencia de scripts/registrar-cfdi-manual.js, que BUSCA un ticket
// existente, este CREA el ticket a partir del propio CFDI: el XML timbrado ya
// trae emisor, total y fecha, que es justo lo que el OCR habría extraído.
//
// Comprobaciones antes de escribir nada (es dinero y son datos fiscales):
//   · el RFC receptor tiene que ser el de GPN;
//   · el UUID no puede estar ya registrado en `facturas`;
//   · sin XML no se registra: el PDF solo no es prueba de timbrado.
//
// Uso:
//   node scripts/registrar-cfdi-huerfano.js            → solo informa
//   node scripts/registrar-cfdi-huerfano.js --aplicar  → registra de verdad
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Imap = require('imap');
const { simpleParser } = require('mailparser');
const db = require('../lib/db');
const { subirArchivoR2 } = require('../storage/r2');

const APLICAR = process.argv.includes('--aplicar');
const HORAS = Number(process.env.HORAS || 72);
// El residente se puede fijar con RESIDENTE=<id>; por defecto GASOLINAS (11),
// que es el genérico para cargas de combustible.
const RESIDENTE = Number(process.env.RESIDENTE || 11);

const atrib = (xml, re) => (xml.match(re) || [])[1] || null;

function leerCFDI(xml) {
  return {
    uuid: atrib(xml, /UUID="([^"]+)"/i),
    total: parseFloat(atrib(xml, /\sTotal="([^"]+)"/) || '0'),
    fecha: atrib(xml, /\sFecha="([^"]+)"/),
    folio: atrib(xml, /\sFolio="([^"]+)"/),
    emisorRfc: atrib(xml, /<cfdi:Emisor[^>]*\sRfc="([^"]+)"/i),
    emisorNombre: atrib(xml, /<cfdi:Emisor[^>]*\sNombre="([^"]+)"/i),
    receptorRfc: atrib(xml, /<cfdi:Receptor[^>]*\sRfc="([^"]+)"/i),
  };
}

function recogerDelBuzon() {
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user: process.env.IMAP_USER, password: process.env.IMAP_PASS,
      host: process.env.IMAP_HOST, port: Number(process.env.IMAP_PORT || 993),
      tls: true, tlsOptions: { rejectUnauthorized: false },
      connTimeout: 20000, authTimeout: 20000,
    });
    // Corte duro: un script de IMAP sin reloj ya se colgó 70 minutos una vez.
    const corte = setTimeout(() => { try { imap.end(); } catch {} reject(new Error('IMAP sin respuesta en 120s')); }, 120000);
    const encontrados = [];

    imap.once('ready', () => {
      imap.openBox('INBOX', true, (err) => {
        if (err) { clearTimeout(corte); return reject(err); }
        imap.search([['SINCE', new Date(Date.now() - HORAS * 3600e3)]], (e, uids) => {
          if (e) { clearTimeout(corte); return reject(e); }
          if (!uids.length) { clearTimeout(corte); imap.end(); return resolve([]); }
          const f = imap.fetch(uids, { bodies: '' });
          const pend = [];
          f.on('message', (msg) => {
            pend.push(new Promise((res) => {
              msg.on('body', (stream) => simpleParser(stream, (er, mail) => {
                if (er) return res();
                const adj = mail.attachments || [];
                const xml = adj.find(a => /\.xml$/i.test(a.filename || ''));
                const pdf = adj.find(a => /\.pdf$/i.test(a.filename || ''));
                if (xml) encontrados.push({ xml, pdf, fechaCorreo: mail.date, asunto: mail.subject });
                res();
              }));
            }));
          });
          f.once('end', async () => { await Promise.all(pend); clearTimeout(corte); imap.end(); resolve(encontrados); });
        });
      });
    });
    imap.once('error', (er) => { clearTimeout(corte); reject(er); });
    imap.connect();
  });
}

(async () => {
  console.log(`🔎 Buscando CFDI en el buzón (últimas ${HORAS}h)…\n`);
  const correos = await recogerDelBuzon();
  if (!correos.length) { console.log('sin adjuntos XML'); process.exit(0); }

  let nuevos = 0;
  for (const c of correos) {
    const texto = c.xml.content.toString('utf8');
    const d = leerCFDI(texto);

    if (!d.uuid) { console.log(`⏭️  ${c.xml.filename}: sin UUID (¿no es un CFDI timbrado?)`); continue; }

    // ⚠️ El receptor se busca entre TODOS los clientes, no solo GPN.
    //
    // Este script nació cuando el portal era de un único RFC y comparaba contra
    // GPR110128QD8 a pelo. Con la cartera multicliente eso descarta facturas
    // legítimas: pasó con el CFDI de CAPUFE de Daniel Ávila, que llegó bien al
    // buzón y el script lo tiró con "no es de GPN".
    const [[cliente]] = await db.query(
      'SELECT id, nombre FROM clientes WHERE rfc = ?', [d.receptorRfc]);
    if (!cliente) { console.log(`⏭️  ${d.uuid}: receptor ${d.receptorRfc} no es de ningún cliente dado de alta`); continue; }

    const [ya] = await db.query(
      "SELECT f.id, f.ticket_id FROM facturas f WHERE f.xml_url LIKE ? LIMIT 1", [`%${d.uuid}%`]
    );
    if (ya.length) { console.log(`⏭️  ${d.emisorNombre} $${d.total} — ya registrado (ticket #${ya[0].ticket_id})`); continue; }

    // El login al que colgar el ticket es uno del cliente que corresponda.
    const [[dueno]] = await db.query(
      'SELECT id FROM users WHERE cliente_id = ? ORDER BY id LIMIT 1', [cliente.id]);
    const userId = dueno ? dueno.id : 1;

    // Si YA existe un ticket de ese cliente, sin factura y por el mismo importe,
    // la factura se engancha a ÉL en vez de crear uno nuevo: el ticket ya lo
    // subió el residente y duplicarlo ensucia su historial.
    const [[existente]] = await db.query(
      `SELECT t.id FROM tickets t
         LEFT JOIN facturas f ON f.ticket_id = t.id
        WHERE t.user_id = ? AND f.id IS NULL
          AND ABS(CAST(JSON_UNQUOTE(JSON_EXTRACT(t.ocr_json,'$.total')) AS DECIMAL(12,2)) - ?) < 0.01
        ORDER BY t.id DESC LIMIT 1`,
      [userId, d.total]
    );

    console.log(`🆕 ${d.emisorNombre}  $${d.total}  ${String(d.fecha).slice(0, 10)}  folio ${d.folio || '—'}`);
    console.log(`    cliente: ${cliente.nombre} · UUID ${d.uuid}`);
    if (existente) console.log(`    ↳ se enganchará al ticket #${existente.id} que ya existe`);
    nuevos++;
    if (!APLICAR) { console.log('    (simulación — usa --aplicar para registrarlo)\n'); continue; }

    // El XML timbrado ES la fuente de verdad: de él salen comercio, total y
    // fecha, exactamente los campos que el OCR habría sacado del ticket.
    const ocr = {
      comercio: d.emisorNombre,
      total: d.total,
      fecha: String(d.fecha || '').slice(0, 10),
      folio: d.folio || null,
      uuid: d.uuid,
      origen: 'cfdi-buzon',
      nota: 'Registrado desde el CFDI del buzón: el ticket no estaba en el sistema.',
    };

    let ticketId;
    if (existente) {
      ticketId = existente.id;
      // Se completa el OCR con lo que dice el XML timbrado, que manda sobre lo
      // que se leyó de la foto, y se marca como procesado.
      const [[t]] = await db.query('SELECT ocr_json FROM tickets WHERE id = ?', [ticketId]);
      const previo = typeof t.ocr_json === 'object' ? (t.ocr_json || {}) : JSON.parse(t.ocr_json || '{}');
      await db.query(
        "UPDATE tickets SET status = 'procesado', error_msg = NULL, requiere_confirmacion = 0, ocr_json = ? WHERE id = ?",
        [JSON.stringify({ ...previo, uuid: d.uuid, comercio: previo.comercio || d.emisorNombre }), ticketId]
      );
    } else {
      const [ins] = await db.query(
        `INSERT INTO tickets (user_id, comercio, status, ocr_json, residente_id,
                              nombre_archivo, requiere_confirmacion, creado)
         VALUES (?, ?, 'procesado', ?, ?, ?, 0, ?)`,
        [userId, d.emisorNombre, JSON.stringify(ocr), RESIDENTE,
         `cfdi_${d.uuid.slice(0, 8)}.xml`, new Date(d.fecha || Date.now())]
      );
      ticketId = ins.insertId;
    }

    const base = `facturas/${d.uuid}`;
    const xmlUrl = await subirArchivoR2(c.xml.content, `${base}.xml`, 'application/xml');
    const pdfUrl = c.pdf ? await subirArchivoR2(c.pdf.content, `${base}.pdf`, 'application/pdf') : null;

    await db.query(
      `INSERT INTO facturas (user_id, ticket_id, comercio, xml_url, pdf_url, status)
       VALUES (?, ?, ?, ?, ?, 'completado')`,
      [userId, ticketId, d.emisorNombre, xmlUrl, pdfUrl]
    );
    console.log(`    ✅ ${existente ? 'factura enganchada al' : 'ticket + factura creados en el'} ticket #${ticketId}\n`);
  }

  console.log(`\n${nuevos} CFDI sin ticket ${APLICAR ? 'registrados' : 'encontrados (simulación)'}.`);
  process.exit(0);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
