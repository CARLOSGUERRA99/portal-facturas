// Abre los correos de buzonfacturas.com y lee el TOTAL real del XML adjunto
// para saber a qué ticket ARCO corresponde cada uno.
require('dotenv').config();
const Imap = require('imap');
const { simpleParser } = require('mailparser');
const { extraerUUIDcfdi } = require('../lib/util');

const imap = new Imap({
  user: process.env.IMAP_USER, password: process.env.IMAP_PASS,
  host: process.env.IMAP_HOST, port: parseInt(process.env.IMAP_PORT) || 993,
  tls: true, tlsOptions: { rejectUnauthorized: false },
});

imap.once('ready', () => {
  imap.openBox('INBOX', true, (err) => {
    if (err) { console.error('❌', err.message); process.exit(1); }
    imap.search([['HEADER', 'FROM', 'buzonfacturas.com']], (e2, uids) => {
      if (e2 || !uids?.length) { console.log('❌ sin correos de buzonfacturas.com'); imap.end(); return; }
      console.log(`📨 ${uids.length} correo(s) de buzonfacturas.com: UIDs ${uids.join(', ')}\n`);
      const f = imap.fetch(uids, { bodies: '', markSeen: false });
      let pend = uids.length;
      f.on('message', (msg) => {
        let uid = null;
        msg.on('attributes', a => { uid = a.uid; });
        msg.on('body', (stream) => {
          simpleParser(stream, (pe, parsed) => {
            pend--;
            if (!pe) {
              const xmlAtt = (parsed.attachments || []).find(a => /\.xml$/i.test(a.filename || ''));
              console.log(`--- UID ${uid} | ${parsed.date?.toISOString()} | "${parsed.subject}"`);
              if (xmlAtt) {
                const xml = xmlAtt.content.toString('utf8');
                const total = (xml.match(/<(?:cfdi:)?Comprobante\b[^>]*\sTotal="([\d.]+)"/i) || [])[1];
                const uuid = extraerUUIDcfdi(xmlAtt.content);
                const rfcEmisor = (xml.match(/<(?:cfdi:)?Emisor[^>]*\sRfc="([^"]+)"/i) || [])[1];
                const nombreEmisor = (xml.match(/<(?:cfdi:)?Emisor[^>]*\sNombre="([^"]{0,70})"/i) || [])[1];
                const rfcReceptor = (xml.match(/<(?:cfdi:)?Receptor[^>]*\sRfc="([^"]+)"/i) || [])[1];
                console.log(`    TOTAL: $${total} | UUID: ${uuid}`);
                console.log(`    Emisor: ${rfcEmisor} — ${nombreEmisor}`);
                console.log(`    Receptor: ${rfcReceptor}`);
                const mapa = { '1517.89': 129, '1465.98': 148, '2033.16': 154 };
                const t = mapa[total];
                console.log(`    → ${t ? `✅ corresponde al ticket #${t}` : '⚠️ no coincide con ningún ticket ARCO pendiente'}`);
              } else {
                console.log('    ❌ sin XML adjunto');
              }
              console.log('');
            }
            if (pend === 0) imap.end();
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
