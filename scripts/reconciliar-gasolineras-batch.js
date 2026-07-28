/**
 * Reconcilia contra la BD real 5 facturas de gasolineras que ya fueron
 * emitidas y verificadas (XML+PDF reales confirmados en R2 bajo facturas/)
 * pero procesadas fuera del pipeline normal de la app (scripts de
 * verificación directa contra el portal, no /upload-ticket), por lo que
 * nunca quedó una fila en tickets/facturas.
 *
 * Antes de insertar, vuelve a descargar cada XML real desde R2 y confirma
 * UUID/Total/RFC receptor contra lo esperado — no confía solo en lo
 * verificado en sesiones anteriores.
 *
 * Uso: node scripts/reconciliar-gasolineras-batch.js
 */
require('dotenv').config();
const fs = require('fs');
const db = require('../lib/db');
const { subirArchivoR2 } = require('../storage/r2');

const USER_ID = 1; // GPN Pinturas y Recubrimientos (carlosguerra@grupogpn.com)
const RFC_GPN = 'GPR110128QD8';
const GASOLINERAS_DIR = 'C:/Users/carlo/AppData/Local/Temp/claude/C--Users-carlo/bd061180-d7e6-4587-97d7-6edd69b553bc/scratchpad/gasolineras/gasolineras';

const REGISTROS = [
  {
    slug: 'erfc',
    ticketImg: `${GASOLINERAS_DIR}/11_natalia_maria_del_carmen_timilpan_ERFC_erfc.com.mx_IDW.jpeg`,
    comercio: 'NATALIA MA DEL CARMEN FLORES ARCINIEGA SA DE CV',
    portal: 'erfc',
    portalUrl: 'https://erfc.com.mx',
    fecha: '24/07/2026',
    referencia: '0000757351',
    total: 1399.94,
    uuidEsperado: 'd958b600-ae9e-4bea-bf11-cfbd4b810629',
    xmlUrl: 'https://pub-4d0fb2c51f724fb9a56066f6d7cbfb71.r2.dev/facturas/erfc_d958b600-ae9e-4bea-bf11-cfbd4b810629.xml',
    pdfUrl: 'https://pub-4d0fb2c51f724fb9a56066f6d7cbfb71.r2.dev/facturas/erfc_d958b600-ae9e-4bea-bf11-cfbd4b810629.pdf',
  },
  {
    slug: 'petrofigues_brujasI',
    ticketImg: `${GASOLINERAS_DIR}/16_gonzer_brujas_I_apaseo_grande_PETROFIGUES_petrofigues.com.jpeg`,
    comercio: 'GASOLINERA OPERADORA GONZER (BRUJAS I)',
    portal: 'petrofigues',
    portalUrl: 'https://petrofigues.facturacionestacion.com',
    fecha: '22/07/2026',
    referencia: '13697',
    folio: '13697-1-1067336-0495',
    total: 1000.00,
    uuidEsperado: 'A5D8262F-72B6-4FE3-A659-E98182D98A32',
    xmlUrl: 'https://pub-4d0fb2c51f724fb9a56066f6d7cbfb71.r2.dev/facturas/petrofigues_A5D8262F-72B6-4FE3-A659-E98182D98A32.xml',
    pdfUrl: 'https://pub-4d0fb2c51f724fb9a56066f6d7cbfb71.r2.dev/facturas/petrofigues_A5D8262F-72B6-4FE3-A659-E98182D98A32.pdf',
  },
  {
    slug: 'petrofigues_brujasII',
    ticketImg: `${GASOLINERAS_DIR}/13_gonzer_brujas_II_apaseo_grande_PETROFIGUES_petrofigues.com.jpeg`,
    comercio: 'GASOLINERA OPERADORA GONZER (BRUJAS II)',
    portal: 'petrofigues',
    portalUrl: 'https://petrofigues.facturacionestacion.com',
    fecha: '22/07/2026',
    referencia: '13698',
    folio: '13698-3-1381230-6793',
    total: 1000.00,
    uuidEsperado: '9B830B5F-BB4D-45D1-B6A8-0CFEFFE5936E',
    xmlUrl: 'https://pub-4d0fb2c51f724fb9a56066f6d7cbfb71.r2.dev/facturas/petrofigues_9B830B5F-BB4D-45D1-B6A8-0CFEFFE5936E.xml',
    pdfUrl: 'https://pub-4d0fb2c51f724fb9a56066f6d7cbfb71.r2.dev/facturas/petrofigues_9B830B5F-BB4D-45D1-B6A8-0CFEFFE5936E.pdf',
  },
  {
    slug: 'gashr',
    ticketImg: `${GASOLINERAS_DIR}/05_autoservicio_gashr_tonala_grupogashr.com.mx.jpeg`,
    comercio: 'AUTOSERVICIO GASHR SA DE CV',
    portal: 'gashr',
    portalUrl: 'https://valerogdl.facturacionestacion.com',
    fecha: '25/07/2026',
    folio: '1929725',
    referencia: '6060',
    total: 399.00,
    uuidEsperado: 'ffcf5d81-9f9a-4302-91f6-07cafa66631c',
    xmlUrl: 'https://pub-4d0fb2c51f724fb9a56066f6d7cbfb71.r2.dev/facturas/gashr_ffcf5d81-9f9a-4302-91f6-07cafa66631c.xml',
    pdfUrl: 'https://pub-4d0fb2c51f724fb9a56066f6d7cbfb71.r2.dev/facturas/gashr_ffcf5d81-9f9a-4302-91f6-07cafa66631c.pdf',
  },
  {
    slug: 'facturagas',
    ticketImg: `${GASOLINERAS_DIR}/04_suministros_energeticos_zapopan_FACTURAGAS_app.facturagas.net.jpeg`,
    comercio: 'SUMINISTROS ENERGETICOS DE CALIDAD',
    portal: 'facturagas',
    portalUrl: 'https://app.facturagas.net',
    fecha: '25/07/2026',
    folio: '2025730',
    total: 1500.00,
    uuidEsperado: '6e804707-4143-44d7-877e-5f69e3a2b290',
    xmlUrl: 'https://pub-4d0fb2c51f724fb9a56066f6d7cbfb71.r2.dev/facturas/facturagas_6e804707-4143-44d7-877e-5f69e3a2b290.xml',
    pdfUrl: 'https://pub-4d0fb2c51f724fb9a56066f6d7cbfb71.r2.dev/facturas/facturagas_6e804707-4143-44d7-877e-5f69e3a2b290.pdf',
  },
];

function fechaDDMMAAAA_a_ISO(f) {
  const [d, m, y] = f.split('/');
  return `${y}-${m}-${d}`;
}

async function verificarXML(reg) {
  const resp = await fetch(reg.xmlUrl);
  if (!resp.ok) throw new Error(`No se pudo descargar XML (${resp.status}): ${reg.xmlUrl}`);
  const xml = await resp.text();

  const uuid = (xml.match(/UUID="([^"]+)"/i) || [])[1];
  const totalM = (xml.match(/<(?:cfdi:)?Comprobante\b[^>]*\sTotal="([\d.]+)"/i) || [])[1];
  const rfcReceptor = (xml.match(/<(?:cfdi:)?Receptor[^>]*\sRfc="([^"]+)"/i) || [])[1];

  if (!uuid) throw new Error('XML sin UUID — no es un CFDI timbrado real');
  if (uuid.toLowerCase() !== reg.uuidEsperado.toLowerCase()) {
    throw new Error(`UUID no coincide: esperado ${reg.uuidEsperado}, XML real tiene ${uuid}`);
  }
  if (rfcReceptor !== RFC_GPN) {
    throw new Error(`RFC receptor no es GPN: "${rfcReceptor}"`);
  }
  const totalReal = parseFloat(totalM);
  if (Math.abs(totalReal - reg.total) > 0.01) {
    throw new Error(`Total no coincide: esperado ${reg.total}, XML real tiene ${totalReal}`);
  }

  return { uuid, total: totalReal, rfcReceptor };
}

async function main() {
  console.log(`=== Reconciliando ${REGISTROS.length} facturas de gasolineras contra la BD real ===\n`);

  for (const reg of REGISTROS) {
    console.log(`\n--- ${reg.slug} (${reg.comercio}) ---`);

    // 1) Verificar el XML real en R2 antes de tocar la BD
    let verif;
    try {
      verif = await verificarXML(reg);
      console.log(`✅ XML verificado: UUID=${verif.uuid} Total=${verif.total} RFC receptor=${verif.rfcReceptor}`);
    } catch (e) {
      console.log(`❌ Verificación de XML falló, NO se toca la BD para este registro: ${e.message}`);
      continue;
    }

    // 2) Evitar duplicar si ya se corrió antes (idempotente por folio/referencia+comercio)
    const [existentes] = await db.query(
      "SELECT id FROM tickets WHERE comercio = ? AND ocr_json LIKE ?",
      [reg.comercio, `%${reg.uuidEsperado}%`]
    );
    if (existentes.length) {
      console.log(`⏭️ Ya existe un ticket reconciliado para este UUID (id=${existentes[0].id}) — se omite`);
      continue;
    }

    // 3) Subir la foto real del ticket a R2 (para que el detalle del ticket la muestre)
    let rutaArchivo = null;
    if (fs.existsSync(reg.ticketImg)) {
      const buf = fs.readFileSync(reg.ticketImg);
      rutaArchivo = await subirArchivoR2(buf, `tickets/${USER_ID}_${reg.slug}_${Date.now()}.jpeg`, 'image/jpeg');
      console.log(`☁️ Foto del ticket subida: ${rutaArchivo}`);
    } else {
      console.log(`⚠️ No se encontró la foto original (${reg.ticketImg}) — ticket quedará sin imagen`);
    }

    // 4) Insertar ticket ya resuelto
    const ocrJson = {
      comercio: reg.comercio,
      fecha: reg.fecha,
      folio: reg.folio || null,
      referencia: reg.referencia || null,
      total: reg.total,
      portalUrl: reg.portalUrl,
      portal: reg.portal,
      confianza: 'alta',
      campos_dudosos: [],
      ok: true,
      uuid_cfdi: verif.uuid,
      _reconciliado: true,
      _nota: 'Facturado vía script de verificación directa contra el portal; reconciliado a la BD tras confirmar XML real en R2.',
    };

    const [insTicket] = await db.query(
      `INSERT INTO tickets (user_id, nombre_archivo, ruta_archivo, ocr_json, comercio, status, portal_url, requiere_confirmacion, creado)
       VALUES (?, ?, ?, ?, ?, 'procesado', ?, 0, ?)`,
      [
        USER_ID,
        reg.ticketImg.split('/').pop(),
        rutaArchivo,
        JSON.stringify(ocrJson),
        reg.comercio,
        reg.portalUrl,
        `${fechaDDMMAAAA_a_ISO(reg.fecha)} 12:00:00`,
      ]
    );
    const ticketId = insTicket.insertId;
    console.log(`📥 Ticket #${ticketId} insertado (status=procesado)`);

    // 5) Insertar factura con los archivos reales ya existentes en R2
    await db.query(
      "INSERT INTO facturas (user_id, ticket_id, comercio, xml_url, pdf_url, status) VALUES (?, ?, ?, ?, ?, 'completado')",
      [USER_ID, ticketId, reg.comercio.slice(0, 50), reg.xmlUrl, reg.pdfUrl]
    );
    console.log(`✅ Factura insertada para ticket #${ticketId} — UUID ${verif.uuid}`);
  }

  console.log('\n=== Reconciliación terminada ===');
  process.exit(0);
}

main().catch(e => { console.error('💥 Error fatal:', e); process.exit(1); });
