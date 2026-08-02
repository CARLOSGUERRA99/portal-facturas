// Verifica en el buzón que llegó el CFDI de AutoZone del ticket #142.
//
// El portal dijo "Se generó y envió correctamente el documento" y mostró el
// folio 995272, pero eso es lo que dice la PANTALLA. La prueba de verdad es el
// XML timbrado en el correo: sin él no hay factura que valga.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Imap = require('imap');
const { simpleParser } = require('mailparser');

const imap = new Imap({
  user: process.env.IMAP_USER,
  password: process.env.IMAP_PASS,
  host: process.env.IMAP_HOST,
  port: Number(process.env.IMAP_PORT || 993),
  tls: true,
  tlsOptions: { rejectUnauthorized: false },
  connTimeout: 20000,
  authTimeout: 20000,
});

// Corte duro: en una sesión anterior un script de IMAP se quedó 70 minutos
// colgado sin timeout. Nunca más sin reloj.
const corte = setTimeout(() => { console.log('⏱️ 90s sin respuesta — se corta'); process.exit(1); }, 90000);

imap.once('ready', () => {
  imap.openBox('INBOX', true, (err) => {
    if (err) { console.error('❌', err.message); process.exit(1); }
    // Solo lo de hoy: la factura se emitió hace minutos.
    imap.search([['SINCE', new Date(Date.now() - 6 * 3600e3)]], (e, uids) => {
      if (e) { console.error('❌', e.message); process.exit(1); }
      if (!uids.length) { console.log('buzón sin correos en las últimas 6 horas'); clearTimeout(corte); imap.end(); return; }

      console.log(`${uids.length} correo(s) recientes — buscando el de AutoZone…\n`);
      const f = imap.fetch(uids, { bodies: '' });
      const pendientes = [];
      f.on('message', (msg) => {
        pendientes.push(new Promise((res) => {
          msg.on('body', (stream) => {
            simpleParser(stream, (err, mail) => {
              if (err) return res();
              const asunto = mail.subject || '';
              const de = (mail.from && mail.from.text) || '';
              const adj = (mail.attachments || []).map(a => a.filename || '');
              const pinta = /autozone|origon|interfactura|995272/i.test(asunto + ' ' + de + ' ' + adj.join(' '));
              if (pinta || adj.some(n => /\.xml$/i.test(n))) {
                console.log(`📧 ${mail.date ? mail.date.toISOString().slice(0, 16).replace('T', ' ') : '?'}  de: ${de}`);
                console.log(`   asunto: ${asunto}`);
                console.log(`   adjuntos: ${adj.join(', ') || '(ninguno)'}`);
                const xml = (mail.attachments || []).find(a => /\.xml$/i.test(a.filename || ''));
                if (xml) {
                  const t = xml.content.toString('utf8');
                  const uuid = (t.match(/UUID="([^"]+)"/) || [])[1];
                  const total = (t.match(/\sTotal="([^"]+)"/) || [])[1];
                  const emisor = (t.match(/<cfdi:Emisor[^>]*Nombre="([^"]+)"/) || [])[1];
                  const receptor = (t.match(/<cfdi:Receptor[^>]*Rfc="([^"]+)"/) || [])[1];
                  console.log(`   ✅ XML → UUID ${uuid} | Total ${total} | emisor ${emisor} | receptor ${receptor}`);
                }
                console.log('');
              }
              res();
            });
          });
        }));
      });
      f.once('end', async () => { await Promise.all(pendientes); clearTimeout(corte); imap.end(); });
    });
  });
});

imap.once('error', (e) => { console.error('❌ IMAP:', e.message); process.exit(1); });
imap.once('end', () => process.exit(0));
imap.connect();
