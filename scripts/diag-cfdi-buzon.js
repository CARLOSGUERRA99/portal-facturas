/**
 * Lista TODOS los CFDI que hay en el buzón y dice, uno por uno, por qué no se
 * asociaron a un ticket. Es la herramienta de "me llegaron facturas y el sistema
 * no las ve".
 *
 * reconciliar-correo.js es deliberadamente conservador: empareja por importe
 * exacto y además exige que el emisor se parezca al comercio del ticket. Cuando
 * no asocia nada no dice cuál de las dos condiciones falló, y sin eso no se sabe
 * si el problema es un alias que falta, un importe que el OCR leyó mal, o que la
 * factura sencillamente es de otro ticket.
 *
 * Aquí NO se escribe nada en la base de datos. Solo se mira.
 *
 * Uso:
 *   node scripts/diag-cfdi-buzon.js [dias]     (por defecto 14)
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Imap = require('imap');
const { simpleParser } = require('mailparser');
const db = require('../lib/db');

const DIAS = parseInt(process.argv[2], 10) || 14;
const RFC_GPN = process.env.RFC_RECEPTOR || 'GPR110128QD8';

const campo = (xml, re) => (xml.match(re) || [])[1] || null;

(async () => {
  // Todos los tickets que todavía no tienen factura, sin filtrar por estado:
  // un ticket en 'error' también puede tener su CFDI esperando en el correo.
  // El total NO es una columna: vive dentro de ocr_json, igual que en
  // reconciliar-correo.js. Buscarlo como columna falla con "Unknown column".
  const [filas] = await db.query(
    `SELECT t.id, t.comercio, t.status, t.ocr_json
       FROM tickets t
      WHERE NOT EXISTS (SELECT 1 FROM facturas f WHERE f.ticket_id = t.id)
      ORDER BY t.id`
  );
  const pendientes = filas.map((t) => {
    let total = NaN;
    try { total = parseFloat(JSON.parse(t.ocr_json || '{}').total); } catch {}
    return { id: t.id, comercio: t.comercio, status: t.status, total };
  }).filter((t) => Number.isFinite(t.total));
  const [yaUsados] = await db.query('SELECT ticket_id, xml_url FROM facturas');
  const uuidsUsados = new Set(
    yaUsados.map((f) => (String(f.xml_url || '').match(/([0-9a-f-]{36})/i) || [])[1]).filter(Boolean).map((u) => u.toLowerCase())
  );

  console.log(`📋 ${pendientes.length} ticket(s) sin factura · ${uuidsUsados.size} CFDI ya registrados\n`);

  const imap = new Imap({
    user: process.env.IMAP_USER,
    password: process.env.IMAP_PASS,
    host: process.env.IMAP_HOST,
    port: parseInt(process.env.IMAP_PORT, 10) || 993,
    tls: true,
    tlsOptions: { rejectUnauthorized: false },
  });

  const desde = new Date(Date.now() - DIAS * 864e5);
  const encontrados = [];

  await new Promise((resolve, reject) => {
    imap.once('ready', () => {
      imap.openBox('INBOX', true, (err) => {
        if (err) return reject(err);
        imap.search([['SINCE', desde]], (e, uids) => {
          if (e) return reject(e);
          if (!uids.length) { imap.end(); return resolve(); }
          const f = imap.fetch(uids, { bodies: '', struct: true });
          const tareas = [];
          f.on('message', (msg) => {
            tareas.push(new Promise((res) => {
              let buf = '';
              msg.on('body', (s) => s.on('data', (d) => { buf += d.toString('utf8'); }));
              msg.once('end', async () => {
                try {
                  const mail = await simpleParser(buf);
                  for (const att of mail.attachments || []) {
                    const nombre = String(att.filename || '');
                    const cont = att.content.toString('utf8');
                    if (!/cfdi:Comprobante/i.test(cont)) continue;
                    encontrados.push({
                      de: (mail.from?.text || '').slice(0, 45),
                      fecha: mail.date,
                      nombre,
                      uuid: (campo(cont, /UUID="([^"]+)"/i) || '').toLowerCase(),
                      total: parseFloat(campo(cont, /[\s"]Total="([^"]+)"/) || '0'),
                      emisor: campo(cont, /Emisor[^>]*Nombre="([^"]+)"/) || '',
                      emisorRfc: campo(cont, /Emisor[^>]*Rfc="([^"]+)"/) || '',
                      receptor: campo(cont, /Receptor[^>]*Rfc="([^"]+)"/) || '',
                    });
                  }
                } catch {}
                res();
              });
            }));
          });
          f.once('end', async () => { await Promise.all(tareas); imap.end(); resolve(); });
        });
      });
    });
    imap.once('error', reject);
    imap.connect();
  });

  console.log(`📨 ${encontrados.length} CFDI encontrados en los últimos ${DIAS} días:\n`);

  for (const c of encontrados) {
    const yaEsta = uuidsUsados.has(c.uuid);
    const otroRfc = c.receptor && c.receptor.toUpperCase() !== RFC_GPN;
    const candidatos = pendientes.filter((t) => Math.abs(Number(t.total) - c.total) <= 0.01);

    let veredicto;
    if (yaEsta) veredicto = '✔️ ya registrado';
    else if (otroRfc) veredicto = `⏭️ receptor ${c.receptor} (no es ${RFC_GPN})`;
    else if (!candidatos.length) veredicto = `❌ NINGÚN ticket pendiente vale $${c.total}`;
    else {
      const lista = candidatos.map((t) => `#${t.id} ${String(t.comercio).slice(0, 28)}`).join(' | ');
      veredicto = `🎯 ENCAJA POR IMPORTE con ${lista}`;
    }

    console.log(`$${String(c.total).padEnd(9)} ${c.emisor.slice(0, 32).padEnd(32)} ${veredicto}`);
    if (!yaEsta && !otroRfc && candidatos.length) {
      console.log(`      UUID ${c.uuid} · de ${c.de}`);
      console.log(`      → node scripts/reconciliar-correo.js --emisor-ok ${candidatos.map((t) => t.id).join(',')}`);
    }
  }

  const sinPareja = pendientes.filter((t) => !encontrados.some((c) => Math.abs(Number(t.total) - c.total) <= 0.01));
  console.log(`\n📭 ${sinPareja.length} ticket(s) sin ningún CFDI del mismo importe en el buzón:`);
  console.log('   ' + sinPareja.map((t) => `#${t.id} ($${t.total})`).join(', '));
  process.exit(0);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
