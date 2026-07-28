require('dotenv').config();
const Imap = require('imap');
const { simpleParser } = require('mailparser');

const imap = new Imap({
  user: process.env.IMAP_USER,
  password: process.env.IMAP_PASS,
  host: process.env.IMAP_HOST,
  port: parseInt(process.env.IMAP_PORT) || 993,
  tls: true,
  tlsOptions: { rejectUnauthorized: false },
});

imap.once('ready', () => {
  imap.openBox('INBOX', true, (err, box) => {
    if (err) { console.error('❌', err.message); process.exit(1); }
    console.log(`📬 INBOX total mensajes: ${box.messages.total}`);

    const since = new Date(Date.now() - 48 * 60 * 60 * 1000); // últimas 48h
    imap.search([['SINCE', since]], (err2, uids) => {
      if (err2) { console.error('❌', err2.message); process.exit(1); }
      if (!uids || !uids.length) {
        console.log('No hay correos en las últimas 48h.');
        imap.end();
        return;
      }
      console.log(`\n📨 Correos de las últimas 48h: ${uids.length} (UIDs: ${uids.join(', ')})\n`);

      const fetch = imap.fetch(uids, { bodies: '', markSeen: false });
      let pendientes = uids.length;
      const resultados = [];

      fetch.on('message', (msg) => {
        let seen = false;
        msg.on('attributes', (attrs) => { seen = (attrs.flags || []).includes('\\Seen'); });
        msg.on('body', (stream) => {
          simpleParser(stream, (perr, parsed) => {
            pendientes--;
            if (!perr) {
              resultados.push({
                from: parsed.from?.text || '?',
                subject: parsed.subject || '(sin asunto)',
                date: parsed.date,
                leido: seen,
                numAdjuntos: (parsed.attachments || []).length,
              });
            }
            if (pendientes === 0) {
              resultados.sort((a, b) => new Date(a.date) - new Date(b.date));
              resultados.forEach(r => {
                console.log(`${r.leido ? '✔️ leído' : '🆕 NO LEÍDO'} | ${r.date?.toISOString()} | De: ${r.from} | Asunto: "${r.subject}" | Adjuntos: ${r.numAdjuntos}`);
              });
              imap.end();
            }
          });
        });
      });
      fetch.once('error', (e) => { console.error('❌ fetch error', e.message); imap.end(); });
    });
  });
});

imap.once('error', (err) => { console.error('❌ IMAP error:', err.message); process.exit(1); });
imap.once('end', () => process.exit(0));
imap.connect();
