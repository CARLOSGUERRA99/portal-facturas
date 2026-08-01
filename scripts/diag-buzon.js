// Diagnóstico del buzón: qué CFDI hay realmente y a qué totales corresponden.
// Sirve para distinguir "el correo no ha llegado" de "llegó pero el
// emparejamiento por importe no lo reconoce".
require('dotenv').config();
const Imap = require('imap');
const { simpleParser } = require('mailparser');
const db = require('../lib/db');
const { extraerUUIDcfdi } = require('../lib/util');

const imap = new Imap({
  user: process.env.IMAP_USER, password: process.env.IMAP_PASS,
  host: process.env.IMAP_HOST, port: parseInt(process.env.IMAP_PORT) || 993,
  tls: true, tlsOptions: { rejectUnauthorized: false },
  connTimeout: 20000, authTimeout: 20000, keepalive: false,
});
setTimeout(() => { console.error('⏱️ corte a los 4 min'); process.exit(3); }, 4 * 60 * 1000).unref?.();

imap.once('ready', () => {
  imap.openBox('INBOX', true, (err) => {
    if (err) { console.error('❌', err.message); process.exit(1); }
    const desde = new Date(Date.now() - 3 * 86400000);
    imap.search([['SINCE', desde]], (e2, uids) => {
      if (e2 || !uids?.length) { console.log('sin correos'); imap.end(); return; }
      console.log(`📨 ${uids.length} correo(s) en 3 días\n`);
      const f = imap.fetch(uids, { bodies: '', markSeen: false });
      let pend = uids.length; const filas = [];
      f.on('message', (msg) => {
        msg.on('body', (stream) => {
          simpleParser(stream, async (pe, p) => {
            pend--;
            if (!pe) {
              const xml = (p.attachments || []).find(a => /\.xml$/i.test(a.filename || ''));
              const fila = { fecha: p.date, de: (p.from?.text || '').slice(0, 40), asunto: (p.subject || '').slice(0, 50) };
              if (xml) {
                const s = xml.content.toString('utf8');
                fila.total = (s.match(/<(?:cfdi:)?Comprobante\b[^>]*\sTotal="([\d.]+)"/i) || [])[1];
                fila.emisor = ((s.match(/<(?:cfdi:)?Emisor[^>]*\sNombre="([^"]{0,40})"/i) || [])[1] || '');
                fila.rfcRec = (s.match(/<(?:cfdi:)?Receptor[^>]*\sRfc="([^"]+)"/i) || [])[1];
                fila.uuid = (extraerUUIDcfdi(xml.content) || '').slice(0, 8);
              }
              filas.push(fila);
            }
            if (pend > 0) return;

            filas.sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
            console.log('CON CFDI ADJUNTO:');
            for (const r of filas.filter(x => x.total)) {
              const [[ya]] = await db.query('SELECT ticket_id FROM facturas WHERE xml_url LIKE ?', [`%${r.uuid}%`]).then(x => [x[0] ? [x[0]] : [null]]).catch(() => [[null]]);
              console.log(`  $${String(r.total).padEnd(10)} ${r.emisor.padEnd(38)} ${r.rfcRec}  ${r.uuid}  ${ya ? '→ ticket #' + ya.ticket_id : '⚠️ SIN ASIGNAR'}`);
            }
            const sin = filas.filter(x => !x.total);
            console.log(`\nSIN CFDI (${sin.length}):`);
            sin.slice(0, 12).forEach(r => console.log(`  ${r.de.padEnd(42)} ${r.asunto}`));
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
