require('dotenv').config();
const db = require('../lib/db');
const { subirArchivoR2 } = require('../storage/r2');

const USER_ID = 1;
const RFC_GPN = 'GPR110128QD8';

const REG = {
  comercio: 'OXXO GAS Galerías BJX León',
  portal: 'oxxogas',
  portalUrl: 'https://facturacion.oxxogas.com',
  fecha: '27/07/2026',
  folio: '7540670',
  total: 800.00,
  uuidEsperado: 'd9edf987-788b-4f71-97cb-2ccc55d449af',
  xmlUrl: 'https://pub-4d0fb2c51f724fb9a56066f6d7cbfb71.r2.dev/facturas/oxxogas_d9edf987-788b-4f71-97cb-2ccc55d449af.xml',
  pdfUrl: 'https://pub-4d0fb2c51f724fb9a56066f6d7cbfb71.r2.dev/facturas/oxxogas_d9edf987-788b-4f71-97cb-2ccc55d449af.pdf',
};

async function verificarXML() {
  const resp = await fetch(REG.xmlUrl);
  if (!resp.ok) throw new Error(`No se pudo descargar XML (${resp.status})`);
  const xml = await resp.text();
  const uuid = (xml.match(/UUID="([^"]+)"/i) || [])[1];
  const total = (xml.match(/<(?:cfdi:)?Comprobante\b[^>]*\sTotal="([\d.]+)"/i) || [])[1];
  const rfcReceptor = (xml.match(/<(?:cfdi:)?Receptor[^>]*\sRfc="([^"]+)"/i) || [])[1];
  if (!uuid || uuid.toLowerCase() !== REG.uuidEsperado.toLowerCase()) throw new Error(`UUID no coincide: ${uuid}`);
  if (rfcReceptor !== RFC_GPN) throw new Error(`RFC receptor no es GPN: ${rfcReceptor}`);
  if (Math.abs(parseFloat(total) - REG.total) > 0.01) throw new Error(`Total no coincide: ${total}`);
  return { uuid, total: parseFloat(total), rfcReceptor };
}

function fechaISO(f) {
  const [d, m, y] = f.split('/');
  return `${y}-${m}-${d} 12:00:00`;
}

(async () => {
  console.log('=== Reconciliando OXXO GAS ticket 02 (Galerías BJX León) ===');
  const verif = await verificarXML();
  console.log(`✅ XML verificado: UUID=${verif.uuid} Total=${verif.total} RFC receptor=${verif.rfcReceptor}`);

  const [existentes] = await db.query(
    "SELECT id FROM tickets WHERE comercio = ? AND ocr_json LIKE ?",
    [REG.comercio, `%${REG.uuidEsperado}%`]
  );
  if (existentes.length) {
    console.log(`⏭️ Ya existe (ticket #${existentes[0].id}) — se omite`);
    process.exit(0);
  }

  const ocrJson = {
    comercio: REG.comercio, fecha: REG.fecha, folio: REG.folio, total: REG.total,
    portalUrl: REG.portalUrl, portal: REG.portal, confianza: 'alta', campos_dudosos: [], ok: true,
    uuid_cfdi: verif.uuid, _reconciliado: true,
    _nota: 'Facturado con sesión inyectada manualmente por el usuario (no autónomo) — reconciliado tras confirmar XML real en R2.',
  };

  const [insTicket] = await db.query(
    `INSERT INTO tickets (user_id, nombre_archivo, ruta_archivo, ocr_json, comercio, status, portal_url, requiere_confirmacion, creado)
     VALUES (?, ?, ?, ?, ?, 'procesado', ?, 0, ?)`,
    [USER_ID, 'oxxogas_galerias_bjx.jpg', null, JSON.stringify(ocrJson), REG.comercio, REG.portalUrl, fechaISO(REG.fecha)]
  );
  const ticketId = insTicket.insertId;
  console.log(`📥 Ticket #${ticketId} insertado`);

  await db.query(
    "INSERT INTO facturas (user_id, ticket_id, comercio, xml_url, pdf_url, status) VALUES (?, ?, ?, ?, ?, 'completado')",
    [USER_ID, ticketId, REG.comercio.slice(0, 50), REG.xmlUrl, REG.pdfUrl]
  );
  console.log(`✅ Factura insertada para ticket #${ticketId}`);
  process.exit(0);
})().catch(e => { console.error('💥 Error:', e.message); process.exit(1); });
