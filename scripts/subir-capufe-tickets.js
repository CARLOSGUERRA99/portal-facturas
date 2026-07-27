require('dotenv').config();
const fs = require('fs');
const db = require('../lib/db');
const { subirArchivoR2 } = require('../storage/r2');
const { procesarImagenTicket, buscarDuplicado } = require('../lib/vision');

const USER_ID = 1; // GPN Pinturas y Recubrimientos (cuenta real)
const IMGS = [
  'C:/Users/carlo/AppData/Local/Temp/claude/C--Users-carlo/bd061180-d7e6-4587-97d7-6edd69b553bc/scratchpad/imgs/capufe/capufe1.webp',
  'C:/Users/carlo/AppData/Local/Temp/claude/C--Users-carlo/bd061180-d7e6-4587-97d7-6edd69b553bc/scratchpad/imgs/capufe/capufe2.webp',
];

(async () => {
  for (const imgPath of IMGS) {
    console.log(`\n=== Procesando ${imgPath} ===`);
    const buf = fs.readFileSync(imgPath);

    const url = await subirArchivoR2(buf, `tickets/${USER_ID}_${Date.now()}.webp`, 'image/webp');
    console.log(`☁️ Imagen subida: ${url}`);

    const [ins] = await db.query(
      "INSERT INTO tickets (user_id, nombre_archivo, ruta_archivo, comercio, status, requiere_confirmacion) VALUES (?, ?, ?, ?, 'pendiente', 1)",
      [USER_ID, imgPath.split('/').pop(), url, 'Analizando…']
    );
    const ticketId = ins.insertId;
    console.log(`📥 Ticket #${ticketId} insertado`);

    let r;
    try {
      r = await procesarImagenTicket(buf, 'image/webp');
    } catch (e) {
      console.log(`❌ OCR falló: ${e.message}`);
      await db.query("UPDATE tickets SET status='error', error_msg=? WHERE id=?", [e.message, ticketId]);
      continue;
    }

    const { datosOCR, textoOCR, portalDetectado, confianza, camposDudosos, requiereConfirmacion, portalUrl } = r;
    console.log(`📋 Portal detectado: ${portalDetectado} | confianza: ${confianza} | dudosos: [${(camposDudosos||[]).join(',')}]`);
    console.log(`📋 datosOCR:`, JSON.stringify(datosOCR, null, 2));

    const dup = await buscarDuplicado(USER_ID, datosOCR, ticketId);
    if (dup) {
      console.log(`🚫 Duplicado del ticket #${dup.id}`);
      await db.query("UPDATE tickets SET status='error', error_msg=?, ocr_json=?, comercio=? WHERE id=?",
        [`duplicado: folio ${dup.folio} ya registrado — ticket #${dup.id}`, JSON.stringify(datosOCR), datosOCR.comercio || 'desconocido', ticketId]);
      continue;
    }

    await db.query(
      `UPDATE tickets SET ocr_text=?, ocr_json=?, comercio=?, portal_url=?, requiere_confirmacion=?, status='pendiente_confirmacion' WHERE id=?`,
      [textoOCR, JSON.stringify(datosOCR), datosOCR.comercio || 'desconocido', datosOCR.portalUrl || portalUrl || null, requiereConfirmacion, ticketId]
    );
    console.log(`✅ Ticket #${ticketId} actualizado con OCR real`);
  }
  process.exit(0);
})().catch(e => { console.error('💥 Error fatal:', e); process.exit(1); });
