const Imap = require('imap');
const { simpleParser } = require('mailparser');
const unzipper = require('unzipper');

// Acepta cualquier correo que parezca un CFDI/factura
function esCFDI(subject, from) {
  const s = (subject || '').toLowerCase();
  const f = (from || '').toLowerCase();
  return (
    s.includes('comprobante') ||
    s.includes('fiscal') ||
    s.includes('cfdi') ||
    s.includes('factura') ||
    s.includes('adrwe') ||
    s.includes('nexusfuel') ||
    s.includes('oxxo') ||
    s.includes('arco') ||
    s.includes('gasmaz') ||
    f.includes('buzonfacturas') ||
    f.includes('noreply') ||
    f.includes('no-responder') ||
    f.includes('factura')
  );
}

// Extrae XML y PDF (incluyendo ZIPs) de los adjuntos de un correo ya parseado
async function extraerAdjuntos(parsed) {
  let xmlBuffer = null, pdfBuffer = null;
  const attachments = parsed.attachments || [];

  console.log(`📎 Adjuntos (${attachments.length}):`, attachments.map(a => a.filename || a.contentType));

  for (const att of attachments) {
    const isZip = att.filename?.endsWith('.zip') || att.contentType?.includes('zip');
    if (isZip) {
      try {
        const zip = await unzipper.Open.buffer(att.content);
        for (const file of zip.files) {
          if (file.path.endsWith('.xml') && !xmlBuffer) xmlBuffer = await file.buffer();
          if (file.path.endsWith('.pdf') && !pdfBuffer) pdfBuffer = await file.buffer();
        }
      } catch (e) {
        console.log('⚠️ Error descomprimiendo ZIP:', e.message);
      }
    } else if ((att.filename?.endsWith('.xml') || att.contentType?.includes('xml')) && !xmlBuffer) {
      xmlBuffer = att.content;
    } else if ((att.filename?.endsWith('.pdf') || att.contentType?.includes('pdf')) && !pdfBuffer) {
      pdfBuffer = att.content;
    }
  }
  return { xmlBuffer, pdfBuffer };
}

// Busca en el inbox correos CFDI sin leer desde los últimos 60 minutos
// ticketCode se acepta para futuro uso (matching por referencia interna)
async function esperarFacturaPorCorreo(ticketCode, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user:     process.env.IMAP_USER,
      password: process.env.IMAP_PASS,
      host:     process.env.IMAP_HOST,
      port:     parseInt(process.env.IMAP_PORT) || 993,
      tls:      true,
      tlsOptions: { rejectUnauthorized: false },
    });

    const timer = setTimeout(() => {
      imap.end();
      reject(new Error('Timeout esperando correo de factura'));
    }, timeoutMs);

    imap.once('ready', () => {
      imap.openBox('INBOX', false, (err) => {
        if (err) { clearTimeout(timer); imap.end(); return reject(err); }

        // Buscar correos de los últimos 60 min (ventana amplia)
        const since = new Date(Date.now() - 60 * 60 * 1000);

        const buscar = (cb) => imap.search(['UNSEEN', ['SINCE', since]], cb);

        buscar((err, uids) => {
          if (err || !uids?.length) {
            // Reintentar una vez después de 15s
            setTimeout(() => {
              buscar((err2, uids2) => {
                if (err2 || !uids2?.length) {
                  clearTimeout(timer);
                  imap.end();
                  return reject(new Error('No se encontró correo de factura'));
                }
                procesarCorreos(imap, uids2, ticketCode, timer, resolve, reject);
              });
            }, 15000);
            return;
          }
          procesarCorreos(imap, uids, ticketCode, timer, resolve, reject);
        });
      });
    });

    imap.once('error', (err) => { clearTimeout(timer); reject(err); });
    imap.connect();
  });
}

async function procesarCorreos(imap, uids, ticketCode, timer, resolve, reject) {
  console.log(`📨 Correos sin leer encontrados: ${uids.length} (UIDs: ${uids.join(', ')})`);

  const fetch = imap.fetch(uids, { bodies: '' });
  const resultados = [];
  let pendientes = uids.length;

  fetch.on('message', (msg) => {
    msg.on('body', (stream) => {
      simpleParser(stream, async (err, parsed) => {
        pendientes--;
        if (err) {
          if (!pendientes && !resultados.length) {
            clearTimeout(timer); imap.end();
            reject(new Error('Error parseando correos'));
          }
          return;
        }

        const from    = parsed.from?.text || '';
        const subject = parsed.subject || '';
        console.log(`📧 Correo: "${subject}" | De: ${from}`);

        if (!esCFDI(subject, from)) {
          console.log(`   ↳ Ignorado (no es CFDI)`);
          if (!pendientes && !resultados.length) {
            clearTimeout(timer); imap.end();
            reject(new Error('No se encontró correo de factura entre los disponibles'));
          }
          return;
        }

        const { xmlBuffer, pdfBuffer } = await extraerAdjuntos(parsed);

        if (xmlBuffer || pdfBuffer) {
          console.log(`   ↳ ✅ Archivos extraídos — XML: ${!!xmlBuffer} | PDF: ${!!pdfBuffer}`);
          resultados.push({ xmlBuffer, pdfBuffer });
        } else {
          console.log(`   ↳ ⚠️ Correo CFDI sin adjuntos XML/PDF`);
        }

        if (!pendientes) {
          clearTimeout(timer);
          imap.end();
          if (resultados.length) {
            resolve(resultados[0]);
          } else {
            reject(new Error('Correo(s) de factura encontrado(s) pero sin archivos adjuntos'));
          }
        }
      });
    });
  });

  fetch.once('error', (err) => {
    clearTimeout(timer); imap.end(); reject(err);
  });
}

module.exports = { esperarFacturaPorCorreo };
