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
    const fetch = imap.fetch([44], { bodies: '' }); // "Comprobante Fiscal Digital" — mibuzon.com.mx
    fetch.on('message', (msg) => {
      msg.on('body', (stream) => {
        simpleParser(stream, async (err, parsed) => {
          if (err) { console.error(err); process.exit(1); }
          console.log('Asunto:', parsed.subject);
          console.log('De:', parsed.from?.text);
          fs.writeFileSync('C:/Users/carlo/AppData/Local/Temp/claude/C--Users-carlo/bd061180-d7e6-4587-97d7-6edd69b553bc/scratchpad/erfc_email.html', parsed.html || parsed.textAsHtml || '(sin html)');
          console.log('HTML guardado, longitud:', (parsed.html || '').length);
          imap.end();
        });
      });
    });
    fetch.once('error', (err) => { console.error(err); process.exit(1); });
  });
});
imap.once('error', (err) => { console.error(err); process.exit(1); });
imap.connect();
