require('dotenv').config();
const fs = require('fs');
const db = require('../lib/db');
const { subirArchivoR2 } = require('../storage/r2');

const USER_ID = 1; // GPN Pinturas y Recubrimientos
const RFC_GPN = 'GPR110128QD8';
const TICKET_IMG = 'C:/Users/carlo/AppData/Local/Temp/claude/C--Users-carlo/bd061180-d7e6-4587-97d7-6edd69b553bc/scratchpad/nuevos_tickets/03_grupo_inmo.jpg';

const REG = {
  comercio: 'GRUPO INMO SA DE CV',
  portal: 'enerfueltech',
  portalUrl: 'https://factura.enerfueltech.com',
  fecha: '24/07/2026',
  referencia: '049847152458CE1',
  folio: '715245',
  total: 1000.00,
  uuidEsperado: '13dd225d-07ad-472e-b5ef-3e7101e8b10e',
  xmlUrl: 'https://pub-4d0fb2c51f724fb9a56066f6d7cbfb71.r2.dev/facturas/enerfueltech_13dd225d-07ad-472e-b5ef-3e7101e8b10e.xml',
  pdfUrl: 'https://pub-4d0fb2c51f724fb9a56066f6d7cbfb71.r2.dev/facturas/enerfueltech_13dd225d-07ad-472e-b5ef-3e7101e8b10e.pdf',
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
  console.log('=== Reconciliando Enerfuel Tech (Grupo Inmo) ===');
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

  let rutaArchivo = null;
  if (fs.existsSync(TICKET_IMG)) {
    const buf = fs.readFileSync(TICKET_IMG);
    rutaArchivo = await subirArchivoR2(buf, `tickets/${USER_ID}_enerfueltech_${Date.now()}.jpg`, 'image/jpeg');
    console.log(`☁️ Foto subida: ${rutaArchivo}`);
  } else {
    console.log('⚠️ No se encontró la foto original — ticket quedará sin imagen');
  }

  const ocrJson = {
    comercio: REG.comercio, fecha: REG.fecha, folio: REG.folio, referencia: REG.referencia,
    total: REG.total, portalUrl: REG.portalUrl, portal: REG.portal, confianza: 'alta',
    campos_dudosos: [], ok: true, uuid_cfdi: verif.uuid, _reconciliado: true,
    _nota: 'Facturado vía script de verificación directa contra el portal; reconciliado a la BD tras confirmar XML real en R2.',
  };

  const [insTicket] = await db.query(
    `INSERT INTO tickets (user_id, nombre_archivo, ruta_archivo, ocr_json, comercio, status, portal_url, requiere_confirmacion, creado)
     VALUES (?, ?, ?, ?, ?, 'procesado', ?, 0, ?)`,
    [USER_ID, 'grupo_inmo.jpg', rutaArchivo, JSON.stringify(ocrJson), REG.comercio, REG.portalUrl, fechaISO(REG.fecha)]
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
