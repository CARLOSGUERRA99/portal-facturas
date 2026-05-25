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
    f.includes('factura') ||
    f.includes('pade.mx') ||      // Rendichicas y Caffenio
    f.includes('e-facturate') ||  // Benavides (plataforma RetailEDX)
    f.includes('retailedx')       // Carl's Jr (plataforma RetailEDX)
  );
}

// Extrae XML y PDF (incluyendo ZIPs) de los adjuntos de un correo ya parseado
async function extraerAdjuntos(parsed) {
  let xmlBuffer = null, pdfBuffer = null;
  const attachments = parsed.attachments || [];

  console.log(`📎 Adjuntos (${attachments.length}):`, attachments.map(a => ({ filename: a.filename, ct: a.contentType, size: a.content?.length })));

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

// Busca en el inbox correos CFDI sin leer desde los últimos 60 minutos.
// imap.search() devuelve UIDs (no sequence numbers). Se usa imap.fetch() (UID-based)
// en lugar de imap.seq.fetch() para evitar "Invalid messageset" cuando los
// sequence numbers no coinciden con los UIDs tras expunge/delete en el buzón.
async function esperarFacturaPorCorreo(ticketCode, timeoutMs = 120000, expectedComercio = null) {
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

        const since = new Date(Date.now() - 60 * 60 * 1000);
        const buscar = (cb) => imap.search(['UNSEEN', ['SINCE', since]], cb);

        buscar((err, uids) => {
          if (err || !uids?.length) {
            setTimeout(() => {
              buscar((err2, uids2) => {
                if (err2 || !uids2?.length) {
                  clearTimeout(timer);
                  imap.end();
                  return reject(new Error('No se encontró correo de factura'));
                }
                procesarCorreos(imap, uids2, ticketCode, timer, resolve, reject, expectedComercio);
              });
            }, 15000);
            return;
          }
          procesarCorreos(imap, uids, ticketCode, timer, resolve, reject, expectedComercio);
        });
      });
    });

    imap.once('error', (err) => { clearTimeout(timer); reject(err); });
    imap.connect();
  });
}

async function procesarCorreos(imap, uids, ticketCode, timer, resolve, reject, expectedComercio = null) {
  console.log(`📨 Correos sin leer encontrados: ${uids.length} (UIDs: ${uids.join(', ')})`);

  // Usar imap.fetch() (UID-based) — imap.search() devuelve UIDs, no seq numbers.
  // imap.seq.fetch() causaba "Invalid messageset" cuando UID != seq number.
  const fetch = imap.fetch(uids, { bodies: '', markSeen: false });
  const mensajes = [];
  let pendientes = uids.length;

  fetch.on('message', (msg, seqno) => {
    // Capturar el UID real desde los atributos del mensaje
    let uid = null;
    msg.on('attributes', (attrs) => { uid = attrs.uid; });

    msg.on('body', (stream) => {
      simpleParser(stream, async (err, parsed) => {
        pendientes--;
        if (err) {
          console.log(`⚠️ IMAP simpleParser error (seqno ${seqno}):`, err.message);
        } else {
          mensajes.push({ parsed, uid: uid ?? seqno });
        }

        if (pendientes > 0) return;

        // Todos los mensajes recolectados — ordenar por fecha DESC (más nuevo primero)
        // para evitar agarrar un correo CFDI antiguo antes que el recién llegado.
        mensajes.sort((a, b) => {
          const da = a.parsed.date ? new Date(a.parsed.date) : new Date(0);
          const db2 = b.parsed.date ? new Date(b.parsed.date) : new Date(0);
          return db2 - da;
        });

        let encontrado = null;

        for (const { parsed, uid: msgUid } of mensajes) {
          const from    = parsed.from?.text || '';
          const subject = parsed.subject || '';
          console.log(`📧 Correo: "${subject}" | De: ${from} | UID: ${msgUid}`);

          if (!esCFDI(subject, from)) {
            console.log(`   ↳ Ignorado (no es CFDI)`);
            continue;
          }

          const { xmlBuffer, pdfBuffer } = await extraerAdjuntos(parsed);

          if (xmlBuffer || pdfBuffer) {
            // Filtrar por comercio para evitar cruzar facturas entre tickets.
            // Los portales de plataformas propias (e-facturate, retailedx, pade.mx)
            // envían desde dominios que no mencionan el comercio — no aplicar filtro.
            const platformDomains = ['e-facturate', 'retailedx', 'pade.mx'];
            const fromPlatform = platformDomains.some(d => from.toLowerCase().includes(d));
            if (expectedComercio && !fromPlatform) {
              const keywords = expectedComercio.toLowerCase()
                .split(/[\s,./]+/)
                .filter(w => w.length >= 3 && !['s.a', 'de', 'c.v', 'sab', 'del', 'los'].includes(w));
              const hayMatch = keywords.some(kw =>
                subject.toLowerCase().includes(kw) || from.toLowerCase().includes(kw)
              );
              if (!hayMatch) {
                console.log(`   ↳ ⚠️ Correo no menciona "${expectedComercio}" — es de otro comercio, ignorando`);
                continue;
              }
            }
            console.log(`   ↳ ✅ Archivos extraídos — XML: ${!!xmlBuffer} | PDF: ${!!pdfBuffer}`);
            encontrado = { xmlBuffer, pdfBuffer, subject, uid: msgUid };
            break;
          } else {
            console.log(`   ↳ ⚠️ Correo CFDI sin adjuntos XML/PDF`);
          }
        }

        if (!encontrado) {
          clearTimeout(timer);
          imap.end();
          return reject(new Error('No se encontró correo de factura entre los disponibles'));
        }

        // Marcar como leído usando UID (no seq number)
        await new Promise((res) => {
          imap.addFlags([encontrado.uid], ['\\Seen'], (flagErr) => {
            if (flagErr) console.log(`⚠️ No se pudo marcar como leído (UID ${encontrado.uid}):`, flagErr.message);
            else console.log(`📭 Correo marcado como leído (UID: ${encontrado.uid})`);
            res();
          });
        });

        clearTimeout(timer);
        imap.end();
        resolve({ xmlBuffer: encontrado.xmlBuffer, pdfBuffer: encontrado.pdfBuffer, subject: encontrado.subject });
      });
    });
  });

  fetch.once('error', (err) => {
    console.log(`⚠️ IMAP fetch error:`, err.message);
    clearTimeout(timer); imap.end(); reject(err);
  });
}

module.exports = { esperarFacturaPorCorreo };
