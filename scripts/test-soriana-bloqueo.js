// Simula el flujo real del worker (sin colas) para confirmar que un ticket
// real de Soriana queda bloqueado correctamente: OCR real -> comercio
// detectado -> esComercioBloqueado -> status='error' con mensaje claro.
require('dotenv').config();
const fs = require('fs');
const db = require('../lib/db');
const { subirArchivoR2 } = require('../storage/r2');
const { procesarImagenTicket } = require('../lib/vision');
const { esComercioBloqueado, crearNotificacion } = require('../lib/util');

const USER_ID = 1;
const IMG = 'C:/Users/carlo/AppData/Local/Temp/claude/C--Users-carlo/bd061180-d7e6-4587-97d7-6edd69b553bc/scratchpad/imgs/line1348_img1.webp'; // Soriana real

(async () => {
  const buf = fs.readFileSync(IMG);
  const url = await subirArchivoR2(buf, `tickets/${USER_ID}_${Date.now()}.webp`, 'image/webp');
  const [ins] = await db.query(
    "INSERT INTO tickets (user_id, nombre_archivo, ruta_archivo, comercio, status, requiere_confirmacion) VALUES (?, ?, ?, ?, 'pendiente', 1)",
    [USER_ID, 'soriana.webp', url, 'Analizando…']
  );
  const ticketId = ins.insertId;
  console.log(`📥 Ticket #${ticketId} insertado`);

  const r = await procesarImagenTicket(buf, 'image/webp');
  console.log('📋 Portal detectado:', r.portalDetectado, '| comercio:', r.datosOCR.comercio);

  const bloqueado = esComercioBloqueado(r.datosOCR.comercio);
  console.log('🛑 esComercioBloqueado:', bloqueado);

  if (bloqueado) {
    const msg = `${r.datosOCR.comercio} no se puede facturar de forma automática: su portal bloquea el acceso automatizado (protección anti-bots) y por eso no está soportado. Solicita esta factura directamente en el sitio del comercio.`;
    await db.query("UPDATE tickets SET status='error', error_msg=?, ocr_json=?, comercio=? WHERE id=?",
      [msg, JSON.stringify(r.datosOCR), r.datosOCR.comercio, ticketId]);
    await crearNotificacion(USER_ID, 'factura_error', msg);
    console.log('✅ Ticket marcado error con mensaje de bloqueo');
  } else {
    console.log('❌ NO se detectó como bloqueado — revisar comercio extraído');
  }

  const [[t]] = await db.query('SELECT id, comercio, status, error_msg FROM tickets WHERE id=?', [ticketId]);
  console.log('\n=== ESTADO FINAL DEL TICKET ===');
  console.log(JSON.stringify(t, null, 2));
  process.exit(0);
})().catch(e => { console.error('💥', e); process.exit(1); });
