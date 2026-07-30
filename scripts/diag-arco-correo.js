// Diagnóstico de raíz: ¿por qué los tickets ARCO quedan en procesandoCorreo y
// nunca concilian? Revisa TODO el buzón (leídos y no leídos) buscando los
// montos/códigos de los 3 tickets afectados.
require('dotenv').config();
const Imap = require('imap');
const { simpleParser } = require('mailparser');

const OBJETIVOS = [
  { ticket: 129, total: 1517.89, codigo: '12848F03128' },
  { ticket: 148, total: 1465.98, codigo: '10351806054' },
  { ticket: 154, total: 2033.16, codigo: '037502A2A3E' },
];

const imap = new Imap({
  user: process.env.IMAP_USER, password: process.env.IMAP_PASS,
  host: process.env.IMAP_HOST, port: parseInt(process.env.IMAP_PORT) || 993,
  tls: true, tlsOptions: { rejectUnauthorized: false },
});

imap.once('ready', () => {
  imap.openBox('INBOX', true, (err, box) => {
    if (err) { console.error('❌', err.message); process.exit(1); }
    console.log(`📬 INBOX: ${box.messages.total} mensajes en total\n`);

    const since = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    imap.search([['SINCE', since]], (e2, uids) => {
      if (e2 || !uids?.length) { console.log('sin correos en 5 días'); imap.end(); return; }
      console.log(`Analizando ${uids.length} correos de los últimos 5 días...\n`);
      const f = imap.fetch(uids, { bodies: '', markSeen: false });
      let pend = uids.length;
      const todos = [];
      f.on('message', (msg) => {
        let flags = [];
        msg.on('attributes', a => { flags = a.flags || []; });
        msg.on('body', (stream) => {
          simpleParser(stream, (pe, parsed) => {
            pend--;
            if (!pe) {
              const adj = (parsed.attachments || []).map(a => `${a.filename}(${a.size}b)`);
              const cuerpo = ((parsed.text || '') + ' ' + (parsed.html || '')).slice(0, 20000);
              todos.push({
                from: parsed.from?.text || '?', subject: parsed.subject || '',
                date: parsed.date, leido: flags.includes('\\Seen'), adj, cuerpo,
              });
            }
            if (pend > 0) return;

            todos.sort((a, b) => new Date(a.date) - new Date(b.date));
            console.log('=== TODOS LOS CORREOS (5 días) ===');
            for (const c of todos) {
              console.log(`${c.leido ? '✔' : '🆕'} ${c.date?.toISOString().slice(0,16)} | ${c.from.slice(0,45)} | "${(c.subject||'').slice(0,55)}" | adj:[${c.adj.join(',')}]`);
            }

            console.log('\n=== ¿HAY CORREO PARA CADA TICKET ARCO? ===');
            for (const o of OBJETIVOS) {
              const porMonto = todos.filter(c => c.cuerpo.includes(String(o.total)) || c.cuerpo.includes(String(o.total).replace('.', ',')));
              const porCodigo = todos.filter(c => c.cuerpo.includes(o.codigo) || (c.subject || '').includes(o.codigo));
              console.log(`\n#${o.ticket} — total $${o.total} / código ${o.codigo}`);
              console.log(`   correos que mencionan el monto : ${porMonto.length}`);
              console.log(`   correos que mencionan el código: ${porCodigo.length}`);
              for (const c of [...new Set([...porMonto, ...porCodigo])]) {
                console.log(`     → ${c.from.slice(0,40)} | "${(c.subject||'').slice(0,50)}" | adj:[${c.adj.join(',')}]`);
              }
              if (!porMonto.length && !porCodigo.length) console.log('     ❌ NINGÚN correo menciona este ticket');
            }

            // ¿Hay correos de dominios ARCO / buzonfacturas que esCFDI ignoraría?
            console.log('\n=== Correos de posible origen ARCO/BuzonFacturas ===');
            const arcoish = todos.filter(c => /arco|buzonfactura|pilarica|enermar|insurgentes|multiservicios/i.test(c.from + ' ' + c.subject));
            console.log(arcoish.length ? arcoish.map(c => `   ${c.from} | "${c.subject}" | adj:[${c.adj.join(',')}]`).join('\n') : '   ❌ ninguno');

            imap.end();
          });
        });
      });
      f.once('error', (er) => { console.error('fetch err', er.message); imap.end(); });
    });
  });
});
imap.once('error', (e) => { console.error('❌ IMAP', e.message); process.exit(1); });
imap.once('end', () => process.exit(0));
imap.connect();
