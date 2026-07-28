require('dotenv').config();
const db = require('../lib/db');
const { subirArchivoR2 } = require('../storage/r2');

const USER_ID = 1;
const RFC_GPN = 'GPR110128QD8';

const REG = {
  comercio: 'RAMCAL',
  portal: 'ramcal',
  portalUrl: 'http://ramcal.no-ip.net:8082/bajatufactura/',
  fecha: '27/07/2026',
  referencia: '0201801651',
  folio: 'P275856',
  codigo: '01292742361',
  total: 1330.20,
  uuidEsperado: '5d97edeb-df6a-4fe9-a99c-18f453f4cc14',
  xmlUrl: 'https://pub-4d0fb2c51f724fb9a56066f6d7cbfb71.r2.dev/facturas/ramcal_5d97edeb-df6a-4fe9-a99c-18f453f4cc14.xml',
  pdfUrl: 'https://pub-4d0fb2c51f724fb9a56066f6d7cbfb71.r2.dev/facturas/ramcal_5d97edeb-df6a-4fe9-a99c-18f453f4cc14.pdf',
};

async function verificarXML() {
  const resp = await fetch(REG.xmlUrl);
  if (!resp.ok) throw new Error(`No se pudo descargar XML (${resp.status})`);
  const xml = await resp.text();
  const uuid = (xml.match(/UUID="([^"]+)"/i) || [])[1];
  const total = (xml.match(/<(?:cfdi:)?Comprobante\b[^>]*\sTotal="([\d.]+)"/i) || [])[1];
  const rfcReceptor = (xml.match(/<(?:cfdi:)?Receptor[^>]*\sRfc="([^"]+)"/i) || [])[1];
  const cp = (xml.match(/DomicilioFiscalReceptor="([^"]+)"/i) || [])[1];
  if (!uuid || uuid.toLowerCase() !== REG.uuidEsperado.toLowerCase()) throw new Error(`UUID no coincide: ${uuid}`);
  if (rfcReceptor !== RFC_GPN) throw new Error(`RFC receptor no es GPN: ${rfcReceptor}`);
  if (Math.abs(parseFloat(total) - REG.total) > 0.01) throw new Error(`Total no coincide: ${total}`);
  return { uuid, total: parseFloat(total), rfcReceptor, cp };
}

function fechaISO(f) {
  const [d, m, y] = f.split('/');
  return `${y}-${m}-${d} 12:00:00`;
}

(async () => {
  console.log('=== Reconciliando RAMCAL ===');
  const verif = await verificarXML();
  console.log(`✅ XML verificado: UUID=${verif.uuid} Total=${verif.total} RFC receptor=${verif.rfcReceptor} CP receptor=${verif.cp}`);

  const [existentes] = await db.query(
    "SELECT id FROM tickets WHERE comercio = ? AND ocr_json LIKE ?",
    [REG.comercio, `%${REG.uuidEsperado}%`]
  );
  if (existentes.length) {
    console.log(`⏭️ Ya existe (ticket #${existentes[0].id}) — se omite`);
    process.exit(0);
  }

  const ocrJson = {
    comercio: REG.comercio, fecha: REG.fecha, folio: REG.folio, referencia: REG.referencia,
    codigo: REG.codigo, total: REG.total, portalUrl: REG.portalUrl, portal: REG.portal, confianza: 'alta',
    campos_dudosos: [], ok: true, uuid_cfdi: verif.uuid, _reconciliado: true,
    _nota: 'Facturado vía script de verificación directa contra el portal; reconciliado a la BD tras confirmar XML real en R2. Domicilio fiscal corregido en el portal (SONORA 85080 -> SINALOA 80140 real) antes de facturar.',
  };

  const [insTicket] = await db.query(
    `INSERT INTO tickets (user_id, nombre_archivo, ruta_archivo, ocr_json, comercio, status, portal_url, requiere_confirmacion, creado)
     VALUES (?, ?, ?, ?, ?, 'procesado', ?, 0, ?)`,
    [USER_ID, 'ramcal.jpg', null, JSON.stringify(ocrJson), REG.comercio, REG.portalUrl, fechaISO(REG.fecha)]
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
