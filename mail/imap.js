const Imap = require('imap');
const { simpleParser } = require('mailparser');
const unzipper = require('unzipper');

async function esperarFacturaPorCorreo(ticketCode, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user: process.env.IMAP_USER,
      password: process.env.IMAP_PASS,
      host: process.env.IMAP_HOST,
      port: parseInt(process.env.IMAP_PORT) || 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
    });

    const timeout = setTimeout(() => {
      imap.end();
      reject(new Error('Timeout esperando correo de factura'));
    }, timeoutMs);

    imap.once('ready', () => {
      imap.openBox('INBOX', false, (err, box) => {
        if (err) { clearTimeout(timeout); imap.end(); return reject(err); }

        const since = new Date(Date.now() - 10 * 60 * 1000);
        imap.search(['UNSEEN', ['SINCE', since]], (err, uids) => {
          if (err || !uids || !uids.length) {
            setTimeout(() => {
              imap.search(['UNSEEN', ['SINCE', since]], (err2, uids2) => {
                if (err2 || !uids2 || !uids2.length) {
                  clearTimeout(timeout);
                  imap.end();
                  return reject(new Error('No se encontró correo de factura'));
                }
                procesarCorreos(imap, uids2, ticketCode, timeout, resolve, reject);
              });
            }, 15000);
            return;
          }
          procesarCorreos(imap, uids, ticketCode, timeout, resolve, reject);
        });
      });
    });

    imap.once('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    imap.connect();
  });
}

async function procesarCorreos(imap, uids, ticketCode, timeout, resolve, reject) {
  const fetch = imap.fetch(uids, { bodies: '' });
  let encontrado = false;

  fetch.on('message', (msg) => {
    msg.on('body', (stream) => {
      simpleParser(stream, async (err, parsed) => {
        if (err || encontrado) return;

        const from = parsed.from?.text || '';
        const subject = parsed.subject || '';
        if (!from.includes('buzonfacturas') && !subject.toLowerCase().includes('factura')) return;

        const attachments = parsed.attachments || [];
        let xmlBuffer = null, pdfBuffer = null;

        for (const att of attachments) {
          if (att.filename?.endsWith('.zip') || att.contentType?.includes('zip')) {
            try {
              const zip = await unzipper.Open.buffer(att.content);
              for (const file of zip.files) {
                if (file.path.endsWith('.xml')) xmlBuffer = await file.buffer();
                if (file.path.endsWith('.pdf')) pdfBuffer = await file.buffer();
              }
            } catch (e) {
              console.log('⚠️ Error descomprimiendo ZIP:', e.message);
            }
          } else if (att.filename?.endsWith('.xml') || att.contentType?.includes('xml')) {
            xmlBuffer = att.content;
          } else if (att.filename?.endsWith('.pdf') || att.contentType?.includes('pdf')) {
            pdfBuffer = att.content;
          }
        }

        if (xmlBuffer || pdfBuffer) {
          encontrado = true;
          clearTimeout(timeout);
          imap.end();
          resolve({ xmlBuffer, pdfBuffer });
        }
      });
    });
  });

  fetch.once('error', (err) => {
    clearTimeout(timeout);
    imap.end();
    reject(err);
  });
}

module.exports = { esperarFacturaPorCorreo };
