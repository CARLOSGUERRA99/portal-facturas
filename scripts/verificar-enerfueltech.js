require('dotenv').config();
const Imap = require('imap');
const { simpleParser } = require('mailparser');
const { subirArchivoR2 } = require('../storage/r2');
const { extraerUUIDcfdi } = require('../lib/util');

const imap = new Imap({
  user: process.env.IMAP_USER,
  password: process.env.IMAP_PASS,
  host: process.env.IMAP_HOST,
  port: parseInt(process.env.IMAP_PORT) || 993,
  tls: true,
  tlsOptions: { rejectUnauthorized: false },
});

imap.once('ready', () => {
  imap.openBox('INBOX', false, (err) => {
    if (err) { console.error('❌', err.message); process.exit(1); }
    imap.search([['HEADER', 'FROM', 'enerfueltech.com']], (err2, uids) => {
      if (err2 || !uids.length) { console.error('❌ No se encontró correo de enerfueltech.com'); process.exit(1); }
      const uid = uids[uids.length - 1];
      console.log(`📨 UID encontrado: ${uid}`);
      const fetch = imap.fetch([uid], { bodies: '' });
      fetch.on('message', (msg) => {
        msg.on('body', (stream) => {
          simpleParser(stream, async (perr, parsed) => {
            if (perr) { console.error('❌', perr.message); process.exit(1); }
            console.log(`Asunto: "${parsed.subject}" | De: ${parsed.from.text}`);
            console.log(`Adjuntos: ${(parsed.attachments || []).length}`);
            let xmlBuf = null, pdfBuf = null;
            for (const att of (parsed.attachments || [])) {
              console.log(`  - ${att.filename} (${att.size} bytes, ${att.contentType})`);
              if (/\.xml$/i.test(att.filename) || att.contentType.includes('xml')) xmlBuf = att.content;
              if (/\.pdf$/i.test(att.filename) || att.contentType.includes('pdf')) pdfBuf = att.content;
            }
            if (!xmlBuf) { console.log('❌ Sin XML adjunto'); process.exit(1); }

            const uuid = extraerUUIDcfdi(xmlBuf);
            const xml = xmlBuf.toString('utf8');
            const total = (xml.match(/<(?:cfdi:)?Comprobante\b[^>]*\sTotal="([\d.]+)"/i) || [])[1];
            const rfcEmisor = (xml.match(/<(?:cfdi:)?Emisor[^>]*\sRfc="([^"]+)"/i) || [])[1];
            const rfcReceptor = (xml.match(/<(?:cfdi:)?Receptor[^>]*\sRfc="([^"]+)"/i) || [])[1];
            const fechaTimbrado = (xml.match(/FechaTimbrado="([^"]+)"/i) || [])[1];
            const folio = (xml.match(/\sFolio="([^"]+)"/i) || [])[1];
            const serie = (xml.match(/\sSerie="([^"]+)"/i) || [])[1];

            console.log('\n=== CFDI REAL ===');
            console.log('UUID:', uuid);
            console.log('Serie-Folio:', serie, folio);
            console.log('Total:', total);
            console.log('RFC Emisor:', rfcEmisor);
            console.log('RFC Receptor:', rfcReceptor);
            console.log('Fecha Timbrado:', fechaTimbrado);

            if (rfcReceptor !== 'GPR110128QD8') {
              console.log('❌ RFC receptor no es GPN. Abortando.');
              process.exit(1);
            }

            const xmlUrl = await subirArchivoR2(xmlBuf, `facturas/enerfueltech_${uuid}.xml`, 'application/xml');
            const pdfUrl = pdfBuf ? await subirArchivoR2(pdfBuf, `facturas/enerfueltech_${uuid}.pdf`, 'application/pdf') : null;
            console.log('\n☁️ XML:', xmlUrl);
            console.log('☁️ PDF:', pdfUrl);

            imap.end();
            process.exit(0);
          });
        });
      });
      fetch.once('error', (e) => { console.error('❌', e.message); process.exit(1); });
    });
  });
});
imap.once('error', (err) => { console.error('❌ IMAP error:', err.message); process.exit(1); });
imap.connect();
