require('dotenv').config();
const Imap = require('imap');
const { simpleParser } = require('mailparser');
const fs = require('fs');

const imap = new Imap({
  user: process.env.IMAP_USER,
  password: process.env.IMAP_PASS,
  host: process.env.IMAP_HOST,
  port: parseInt(process.env.IMAP_PORT) || 993,
  tls: true,
  tlsOptions: { rejectUnauthorized: false },
});

imap.once('ready', () => {
  imap.openBox('INBOX', true, (err) => {
    if (err) { console.error(err); process.exit(1); }
    const fetch = imap.fetch([45], { bodies: '' });
    fetch.on('message', (msg) => {
      msg.on('body', (stream) => {
        simpleParser(stream, async (err, parsed) => {
          if (err) { console.error(err); process.exit(1); }
          console.log('Asunto:', parsed.subject);
          for (const att of parsed.attachments || []) {
            console.log('Adjunto:', att.filename, att.contentType, att.content.length, 'bytes');
            const outPath = `C:/Users/carlo/AppData/Local/Temp/claude/C--Users-carlo/bd061180-d7e6-4587-97d7-6edd69b553bc/scratchpad/${att.filename}`;
            fs.writeFileSync(outPath, att.content);
            console.log('Guardado en:', outPath);
          }
          imap.end();
        });
      });
    });
    fetch.once('error', (err) => { console.error(err); process.exit(1); });
  });
});
imap.once('error', (err) => { console.error(err); process.exit(1); });
imap.connect();
