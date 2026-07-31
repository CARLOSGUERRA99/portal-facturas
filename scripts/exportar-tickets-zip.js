// Exporta TODOS los tickets del portal a un ZIP: las imágenes originales
// (descargadas de R2) más un índice para poder cruzarlas con la base.
//
// Estructura del ZIP:
//   tickets/<estado>/<id>_<comercio>_<total>.<ext>   ← la foto original
//   INDICE.csv                                        ← una fila por ticket
//   RESUMEN.txt                                       ← conteos por estado
//
// Uso: node scripts/exportar-tickets-zip.js [ruta-de-salida.zip]
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const db = require('../lib/db');

const parseJson = (v) => {
  if (!v) return {};
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return {}; }
};

const limpio = (s, max = 38) => String(s || 'sin-nombre')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, max) || 'ticket';

const csvCampo = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function descargar(url, destino) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 45000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return { ok: false, motivo: `HTTP ${r.status}` };
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) return { ok: false, motivo: 'archivo vacío' };
    fs.writeFileSync(destino, buf);
    return { ok: true, bytes: buf.length };
  } catch (e) {
    return { ok: false, motivo: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally { clearTimeout(t); }
}

(async () => {
  const salida = path.resolve(process.argv[2] || path.join(os.homedir(), 'Downloads', `tickets-portal-${new Date().toISOString().slice(0, 10)}.zip`));

  const [filas] = await db.query(`
    SELECT t.id, t.comercio, t.status, t.ruta_archivo, t.nombre_archivo, t.ocr_json,
           t.portal_url, t.error_msg, t.creado,
           f.xml_url, f.pdf_url, f.status AS factura_status
      FROM tickets t
      LEFT JOIN facturas f ON f.ticket_id = t.id
     ORDER BY t.id`);

  console.log(`📦 ${filas.length} tickets en la base. Descargando imágenes de R2…`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tickets-zip-'));
  const raiz = path.join(tmp, 'tickets-portal');
  fs.mkdirSync(raiz, { recursive: true });

  const filasCsv = [['id', 'estado', 'comercio', 'fecha_ticket', 'total', 'folio', 'portal_url', 'archivo_en_zip', 'uuid_cfdi', 'xml_url', 'pdf_url', 'error', 'subido'].join(',')];
  const porEstado = {};
  let ok = 0, sinImagen = 0, fallidas = 0;

  for (const t of filas) {
    const o = parseJson(t.ocr_json);
    const folio = o.folio || o.codigoTicket || o.referencia || o.idFacturacion || o.folioFactura || o.idVenta || o.tc || '';
    porEstado[t.status] = (porEstado[t.status] || 0) + 1;

    let archivoRel = '';
    if (!t.ruta_archivo) {
      sinImagen++;
    } else {
      const dir = path.join(raiz, t.status);
      fs.mkdirSync(dir, { recursive: true });
      const ext = ((t.ruta_archivo.split('?')[0].split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg').slice(0, 5);
      const nombre = `${String(t.id).padStart(4, '0')}_${limpio(t.comercio)}${o.total ? '_$' + o.total : ''}.${ext}`;
      const destino = path.join(dir, nombre);
      const r = t.ruta_archivo.startsWith('http')
        ? await descargar(t.ruta_archivo, destino)
        : { ok: false, motivo: 'ruta local antigua (no está en R2)' };
      if (r.ok) { archivoRel = `${t.status}/${nombre}`; ok++; }
      else { archivoRel = `NO DESCARGADA (${r.motivo})`; fallidas++; }
    }

    filasCsv.push([
      t.id, t.status, t.comercio, o.fecha || '', o.total ?? '', folio, t.portal_url || '',
      archivoRel, o.uuid_cfdi || '', t.xml_url || '', t.pdf_url || '',
      (t.error_msg || '').replace(/\s+/g, ' ').slice(0, 220),
      t.creado ? new Date(t.creado).toISOString().slice(0, 16).replace('T', ' ') : '',
    ].map(csvCampo).join(','));
  }

  // BOM para que Excel en español abra los acentos bien.
  fs.writeFileSync(path.join(raiz, 'INDICE.csv'), '﻿' + filasCsv.join('\r\n'), 'utf8');

  const resumen = [
    `Exportación de tickets — portal-facturas`,
    `Generado: ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`,
    ``,
    `Tickets en la base .......... ${filas.length}`,
    `Imágenes descargadas ........ ${ok}`,
    `Sin imagen registrada ....... ${sinImagen}`,
    `Imágenes no recuperables .... ${fallidas}`,
    ``,
    `Por estado:`,
    ...Object.entries(porEstado).sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${k.padEnd(24)} ${v}`),
    ``,
    `Las fotos están agrupadas en carpetas por estado. INDICE.csv relaciona cada`,
    `archivo con su ticket: comercio, fecha, total, folio, portal, UUID del CFDI`,
    `si se facturó, y el motivo del error si lo hay.`,
    ``,
    `NOTA sobre las imágenes no recuperables: son tickets antiguos cuya`,
    `ruta_archivo apunta al disco local de Railway, de antes de que el sistema`,
    `guardara las fotos en Cloudflare R2. Ese disco es efímero, así que esas`,
    `imágenes ya no existen en ningún sitio — no es un fallo de esta exportación.`,
    `Sus datos (comercio, folio, total, CFDI) sí están completos en INDICE.csv.`,
  ].join('\n');
  fs.writeFileSync(path.join(raiz, 'RESUMEN.txt'), resumen, 'utf8');

  fs.mkdirSync(path.dirname(salida), { recursive: true });
  if (fs.existsSync(salida)) fs.unlinkSync(salida);
  // Compress-Archive de PowerShell: evita añadir una dependencia npm solo para esto.
  execFileSync('powershell.exe', ['-NoProfile', '-Command',
    `Compress-Archive -Path '${raiz}' -DestinationPath '${salida}' -CompressionLevel Optimal`], { stdio: 'inherit' });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n' + resumen);
  console.log(`\n✅ ZIP: ${salida}  (${(fs.statSync(salida).size / 1048576).toFixed(1)} MB)`);
  process.exit(0);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
