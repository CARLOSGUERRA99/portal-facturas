// Respalda y borra los tickets que se quedaron SIN factura.
//
// El borrado es irreversible, así que antes deja constancia de todo:
//   · un CSV con cada ticket, sus datos y el motivo por el que no se facturó
//   · un ZIP con las fotos, para poder facturarlos a mano después si hace falta
//
// La foto es lo único que no se puede reconstruir, y es justo lo que se
// necesita para ir al portal a mano. Por eso se guarda ANTES de tocar la BD.
//
// Uso:
//   node scripts/respaldar-y-borrar-sin-factura.js            → solo respalda e informa
//   node scripts/respaldar-y-borrar-sin-factura.js --borrar   → respalda y borra
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const db = require('../lib/db');

const BORRAR = process.argv.includes('--borrar');
const parseJson = (v) => { if (!v) return {}; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return {}; } };
const limpio = (s, max = 38) => String(s || 'ticket').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, max) || 'ticket';
const csv = (v) => { const s = v == null ? '' : String(v); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

(async () => {
  const [filas] = await db.query(`
    SELECT t.id, t.comercio, t.status, t.error_msg, t.portal_url, t.ruta_archivo,
           t.ocr_json, t.creado, t.residente_id, r.nombre AS residente
      FROM tickets t
      LEFT JOIN facturas f ON f.ticket_id = t.id AND f.xml_url IS NOT NULL
      LEFT JOIN residentes r ON r.id = t.residente_id
     WHERE f.id IS NULL
     ORDER BY t.id`);

  if (!filas.length) { console.log('✅ no hay tickets sin factura'); process.exit(0); }

  const sello = new Date().toISOString().slice(0, 10);
  const salida = path.join(os.homedir(), 'Downloads', `tickets-sin-factura-${sello}.zip`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sin-factura-'));
  const raiz = path.join(tmp, `tickets-sin-factura-${sello}`);
  fs.mkdirSync(path.join(raiz, 'fotos'), { recursive: true });

  const cab = ['id', 'comercio', 'fecha_ticket', 'total', 'folio', 'portal', 'estado', 'residente', 'motivo', 'foto'];
  const lineas = [cab.join(',')];
  let conFoto = 0, total = 0;

  console.log(`📦 respaldando ${filas.length} ticket(s) sin factura…\n`);
  for (const t of filas) {
    const o = parseJson(t.ocr_json);
    const folio = o.folio || o.codigoTicket || o.referencia || o.folioFactura || o.idVenta || '';
    total += parseFloat(o.total) || 0;

    let foto = '';
    if (t.ruta_archivo && /^https?:\/\//i.test(t.ruta_archivo)) {
      const ext = (t.ruta_archivo.split('?')[0].split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'jpg';
      const nombre = `${String(t.id).padStart(4, '0')}_${limpio(t.comercio)}.${ext}`;
      try {
        const r = await fetch(t.ruta_archivo);
        if (r.ok) { fs.writeFileSync(path.join(raiz, 'fotos', nombre), Buffer.from(await r.arrayBuffer())); foto = `fotos/${nombre}`; conFoto++; }
      } catch {}
    }

    lineas.push([t.id, t.comercio, o.fecha || '', o.total ?? '', folio,
      t.portal_url || o.portalUrl || '', t.status, t.residente || '',
      (t.error_msg || '').replace(/\s+/g, ' ').slice(0, 300), foto].map(csv).join(','));
  }

  fs.writeFileSync(path.join(raiz, 'INDICE.csv'), '﻿' + lineas.join('\r\n'), 'utf8');
  fs.writeFileSync(path.join(raiz, 'LEEME.txt'), [
    `Tickets que se quedaron SIN factura — ${sello}`,
    ``,
    `Son ${filas.length} tickets por un total de $${total.toFixed(2)}.`,
    `${conFoto} conservan su foto en la carpeta fotos/.`,
    ``,
    `INDICE.csv trae, por cada uno: comercio, fecha, importe, folio, portal y el`,
    `motivo exacto por el que no se pudo facturar.`,
    ``,
    `Con la foto y el folio se puede ir al portal del comercio a facturar a mano.`,
    `Este respaldo se generó JUSTO ANTES de borrarlos del sistema.`,
  ].join('\n'), 'utf8');

  fs.mkdirSync(path.dirname(salida), { recursive: true });
  if (fs.existsSync(salida)) fs.unlinkSync(salida);
  execFileSync('powershell.exe', ['-NoProfile', '-Command',
    `Compress-Archive -Path '${raiz}' -DestinationPath '${salida}' -CompressionLevel Optimal`], { stdio: 'inherit' });
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(`✅ respaldo: ${salida} (${(fs.statSync(salida).size / 1048576).toFixed(1)} MB)`);
  console.log(`   ${filas.length} tickets · $${total.toFixed(2)} · ${conFoto} con foto`);

  if (!BORRAR) { console.log('\n(no se borró nada — ejecuta con --borrar para hacerlo)'); process.exit(0); }

  const ids = filas.map((t) => t.id);
  await db.query(`DELETE FROM facturas WHERE ticket_id IN (${ids.map(() => '?').join(',')})`, ids);
  const [r] = await db.query(`DELETE FROM tickets WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
  console.log(`\n🗑️ ${r.affectedRows} ticket(s) borrado(s)`);

  const [[c]] = await db.query(`SELECT
    (SELECT COUNT(*) FROM tickets) AS tickets,
    (SELECT COUNT(DISTINCT xml_url) FROM facturas WHERE xml_url IS NOT NULL) AS cfdi`);
  console.log(`📊 quedan ${c.tickets} tickets, todos con factura · ${c.cfdi} CFDI`);
  process.exit(0);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
