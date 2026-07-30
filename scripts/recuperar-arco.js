// Recupera y reconcilia las facturas ARCO que sí llegaron al buzón pero el
// filtro anti-cruce descartaba (ver fix en mail/imap.js). Verifica UUID/Total/
// RFC contra el ticket antes de tocar la BD, y marca el correo como leído solo
// si se reconcilió de verdad.
require('dotenv').config();
const Imap = require('imap');
const { simpleParser } = require('mailparser');
const db = require('../lib/db');
const { subirArchivoR2 } = require('../storage/r2');
const { extraerUUIDcfdi } = require('../lib/util');

const USER_ID = 1;
const RFC_GPN = 'GPR110128QD8';
// total del CFDI → ticket al que pertenece (verificado en diag-arco-xml.js)
const MAPA = { '1517.89': 129, '2033.16': 154, '1465.98': 148 };

const imap = new Imap({
  user: process.env.IMAP_USER, password: process.env.IMAP_PASS,
  host: process.env.IMAP_HOST, port: parseInt(process.env.IMAP_PORT) || 993,
  tls: true, tlsOptions: { rejectUnauthorized: false },
});

imap.once('ready', () => {
  imap.openBox('INBOX', false, (err) => {
    if (err) { console.error('❌', err.message); process.exit(1); }
    imap.search([['HEADER', 'FROM', 'buzonfacturas.com']], async (e2, uids) => {
      if (e2 || !uids?.length) { console.log('sin correos'); imap.end(); return; }
      const f = imap.fetch(uids, { bodies: '', markSeen: false });
      let pend = uids.length;
      const pendientes = [];
      f.on('message', (msg) => {
        let uid = null;
        msg.on('attributes', a => { uid = a.uid; });
        msg.on('body', (stream) => {
          simpleParser(stream, async (pe, parsed) => {
            pend--;
            if (!pe) pendientes.push({ uid, parsed });
            if (pend > 0) return;

            let n = 0;
            for (const { uid, parsed } of pendientes) {
              const xmlAtt = (parsed.attachments || []).find(a => /\.xml$/i.test(a.filename || ''));
              const pdfAtt = (parsed.attachments || []).find(a => /\.pdf$/i.test(a.filename || ''));
              if (!xmlAtt) continue;
              const xml = xmlAtt.content.toString('utf8');
              const total = (xml.match(/<(?:cfdi:)?Comprobante\b[^>]*\sTotal="([\d.]+)"/i) || [])[1];
              const ticketId = MAPA[total];
              if (!ticketId) continue;

              const uuid = (extraerUUIDcfdi(xmlAtt.content) || '').toLowerCase();
              const rfcReceptor = (xml.match(/<(?:cfdi:)?Receptor[^>]*\sRfc="([^"]+)"/i) || [])[1];
              const nombreEmisor = (xml.match(/<(?:cfdi:)?Emisor[^>]*\sNombre="([^"]{0,80})"/i) || [])[1];
              console.log(`\n➡️ UID ${uid} → ticket #${ticketId} | $${total} | ${nombreEmisor}`);

              if (rfcReceptor !== RFC_GPN) { console.log('   ❌ receptor no es GPN'); continue; }

              const [[t]] = await db.query('SELECT ocr_json, comercio FROM tickets WHERE id=?', [ticketId]);
              if (!t) { console.log('   ❌ ticket no existe'); continue; }
              const ocr = JSON.parse(t.ocr_json || '{}');
              if (ocr.total && Math.abs(parseFloat(ocr.total) - parseFloat(total)) > 0.01) {
                console.log(`   ❌ total CFDI ${total} != total ticket ${ocr.total}`); continue;
              }
              const [ya] = await db.query('SELECT id FROM facturas WHERE ticket_id=?', [ticketId]);
              if (ya.length) { console.log('   ⏭️ ya tiene factura'); continue; }

              const xmlUrl = await subirArchivoR2(xmlAtt.content, `facturas/${uuid}.xml`, 'application/xml');
              const pdfUrl = pdfAtt ? await subirArchivoR2(pdfAtt.content, `facturas/${uuid}.pdf`, 'application/pdf') : null;
              console.log(`   ✅ UUID ${uuid}`);
              console.log(`   ☁️ ${xmlUrl}`);

              ocr.uuid_cfdi = uuid;
              ocr._nota = 'Factura recuperada del buzón: había llegado pero el filtro anti-cruce la descartaba porque buzonfacturas.com no menciona el comercio en el asunto (fix en mail/imap.js).';
              await db.query("UPDATE tickets SET status='procesado', error_msg=NULL, reintento_programado=NULL, ocr_json=? WHERE id=?", [JSON.stringify(ocr), ticketId]);
              await db.query("INSERT INTO facturas (user_id, ticket_id, comercio, xml_url, pdf_url, status) VALUES (?,?,?,?,?,'completado')",
                [USER_ID, ticketId, (t.comercio || nombreEmisor || 'ARCO').slice(0, 50), xmlUrl, pdfUrl]);
              await new Promise(r => imap.addFlags([uid], ['\\Seen'], () => r()));
              console.log(`   💾 ticket #${ticketId} → procesado + factura insertada + correo marcado leído`);
              n++;
            }
            console.log(`\n=== ${n} factura(s) ARCO recuperada(s) ===`);
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
