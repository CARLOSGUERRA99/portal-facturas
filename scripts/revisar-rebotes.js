/**
 * Busca en el buzón los correos devueltos ("Undelivered Mail Returned to
 * Sender") y desmarca los tickets cuya solicitud NUNCA llegó al comercio.
 *
 * ⚠️ POR QUÉ HACE FALTA: `solicitud_correo_enviada = 1` solo significa que
 * Brevo ACEPTÓ el mensaje, no que se haya entregado. Si el comercio rechaza la
 * dirección, el rebote llega al buzón y el ticket se queda marcado como
 * "solicitud enviada" para siempre: parece que estamos esperando respuesta
 * cuando en realidad nadie recibió nada.
 *
 * Caso real que motivó el script (09-sep-2026): las solicitudes del ticket #310
 * iban a "atencionyservicioS@bajagas.com" y rebotaban con
 * "550 5.4.1 Recipient address rejected: Access denied" — dos veces, en días
 * distintos. El ticket impreso decía "atencionyservicio@bajagas.com", SIN la S.
 * Una letra de más tenía parado un cobro y nada lo delataba.
 *
 * Uso:
 *   node scripts/revisar-rebotes.js            → solo informa
 *   node scripts/revisar-rebotes.js --aplicar  → desmarca los tickets afectados
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Imap = require('imap');
const { simpleParser } = require('mailparser');
const db = require('../lib/db');

const APLICAR = process.argv.includes('--aplicar');
const DIAS = parseInt(process.env.DIAS_ATRAS || '30', 10);

const imap = new Imap({
  user: process.env.IMAP_USER,
  password: process.env.IMAP_PASS,
  host: process.env.IMAP_HOST,
  port: parseInt(process.env.IMAP_PORT) || 993,
  tls: true,
  tlsOptions: { rejectUnauthorized: false },
});

const rebotes = [];

imap.once('ready', () => {
  imap.openBox('INBOX', true, (err) => {
    if (err) { console.error('❌', err.message); process.exit(1); }
    const desde = new Date(Date.now() - DIAS * 864e5);
    imap.search([['SINCE', desde]], (e2, uids) => {
      if (e2 || !uids || !uids.length) { console.log('Sin correos en el periodo.'); imap.end(); return; }
      const f = imap.fetch(uids, { bodies: '' });
      let pendientes = uids.length;
      f.on('message', (msg) => {
        let raw = '';
        msg.on('body', (s) => s.on('data', (d) => { raw += d.toString('utf8'); }));
        msg.once('end', async () => {
          try {
            const p = await simpleParser(raw);
            const asunto = p.subject || '';
            if (/Undelivered|Returned to Sender|Delivery Status Notification|Mail delivery failed/i.test(asunto)) {
              const cuerpo = (p.text || '').replace(/\s+/g, ' ');
              // El destinatario que falló viene entre <> en el cuerpo del rebote.
              const dirs = [...new Set((cuerpo.match(/<([^>\s]+@[^>\s]+)>/g) || []).map((x) => x.slice(1, -1).toLowerCase()))]
                .filter((d) => !d.includes('mailer-daemon') && !d.includes(String(process.env.IMAP_USER || '').toLowerCase()));
              const motivo = (cuerpo.match(/(said:.{0,150}|Diagnostic-Code:.{0,150}|5\d\d[\s-]\d\.\d\.\d.{0,120})/i) || [])[1] || '(sin motivo legible)';
              rebotes.push({ fecha: p.date, dirs, motivo: motivo.trim().slice(0, 160) });
            }
          } catch {}
          if (--pendientes === 0) imap.end();
        });
      });
      f.once('error', () => imap.end());
    });
  });
});

imap.once('error', (e) => { console.error('IMAP:', e.message); process.exit(1); });

imap.once('end', async () => {
  if (!rebotes.length) { console.log(`\n✅ Sin correos devueltos en los últimos ${DIAS} días.`); process.exit(0); }

  console.log(`\n⚠️ ${rebotes.length} correo(s) devuelto(s) en ${DIAS} días:\n`);
  const afectados = new Map();
  for (const r of rebotes) {
    console.log(`  ${String(r.fecha).slice(4, 21)}  →  ${r.dirs.join(', ') || '(destinatario no legible)'}`);
    console.log(`     ${r.motivo}`);
    for (const d of r.dirs) {
      const [tk] = await db.query(
        'SELECT id, comercio, solicitud_correo_enviada FROM tickets WHERE LOWER(email_contacto) = ?',
        [d]
      );
      for (const t of tk) afectados.set(t.id, { ...t, dir: d, motivo: r.motivo });
    }
  }

  if (!afectados.size) {
    console.log('\n(ningún ticket tiene hoy esa dirección de contacto — puede que ya se haya corregido)');
    process.exit(0);
  }

  console.log(`\n=== ${afectados.size} ticket(s) cuya solicitud NO llegó ===`);
  for (const t of afectados.values()) {
    console.log(`  #${t.id} ${String(t.comercio).slice(0, 40)} → ${t.dir}${t.solicitud_correo_enviada ? ' (marcado como ENVIADA)' : ''}`);
  }

  if (!APLICAR) {
    console.log('\n(informativo; corre con --aplicar para desmarcarlos y que vuelvan a aparecer como pendientes de solicitud)');
    process.exit(0);
  }

  for (const t of afectados.values()) {
    await db.query(
      'UPDATE tickets SET solicitud_correo_enviada = 0, solicitud_correo_error = ? WHERE id = ?',
      [`El correo a ${t.dir} fue DEVUELTO: ${t.motivo}`.slice(0, 500), t.id]
    );
    console.log(`  #${t.id} desmarcado — hay que corregir la dirección y volver a enviar`);
  }
  process.exit(0);
});

imap.connect();
