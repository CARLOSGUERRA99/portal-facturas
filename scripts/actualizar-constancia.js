/**
 * Sube una Constancia de Situación Fiscal nueva a R2 y la deja como la vigente
 * para un RFC, en `users` Y en `clientes` a la vez.
 *
 * Por qué las dos tablas: `lib/solicitud-correo.js` lee `constancia_url` con un
 * COALESCE(clientes, users) — si solo se actualiza una, la solicitud por correo
 * puede seguir adjuntando la vieja sin que nada falle ni avise. La constancia es
 * lo que el comercio usa para emitir el CFDI: adjuntar una desactualizada es
 * pedir una factura con datos viejos.
 *
 * La anterior NO se borra de R2 a propósito: el nombre lleva timestamp, así que
 * queda el histórico y se puede volver atrás si el SAT reexpide.
 *
 * Uso:
 *   node scripts/actualizar-constancia.js <rutaPdf> [rfc]
 *   node scripts/actualizar-constancia.js "C:\\Users\\carlo\\Downloads\\Csf_GPR110128QD8.pdf"
 *
 * Si no se pasa el RFC, se saca del nombre del archivo (Csf_<RFC>.pdf), que es
 * como lo descarga el portal del SAT.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const db = require('../lib/db');
const { subirArchivoR2 } = require('../storage/r2');

const RUTA = process.argv[2];
let RFC = (process.argv[3] || '').toUpperCase();

(async () => {
  if (!RUTA || !fs.existsSync(RUTA)) {
    console.error('Uso: node scripts/actualizar-constancia.js <rutaPdf> [rfc]');
    process.exit(1);
  }
  if (!RFC) {
    const m = path.basename(RUTA).match(/([A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3})/i);
    RFC = m ? m[1].toUpperCase() : '';
  }
  if (!RFC) {
    console.error('❌ No se pudo deducir el RFC del nombre del archivo; pásalo como segundo argumento.');
    process.exit(1);
  }

  const buf = fs.readFileSync(RUTA);
  const esPdf = buf.slice(0, 5).toString('latin1') === '%PDF-';
  if (!esPdf) {
    console.error('❌ El archivo no es un PDF (no empieza con %PDF-). No se sube nada.');
    process.exit(2);
  }
  console.log(`📄 ${path.basename(RUTA)} — ${buf.length} bytes — RFC ${RFC}`);

  const [[antesU]] = await db.query('SELECT id, constancia_url FROM users WHERE rfc = ? LIMIT 1', [RFC]);
  const [[antesC]] = await db.query('SELECT id, constancia_url FROM clientes WHERE rfc = ? LIMIT 1', [RFC]);
  if (!antesU && !antesC) {
    console.error(`❌ No hay ningún usuario ni cliente con el RFC ${RFC}.`);
    process.exit(3);
  }
  console.log(`   anterior: ${antesC?.constancia_url || antesU?.constancia_url || '(ninguna)'}`);

  const key = `constancias/${RFC}_${Date.now()}.pdf`;
  const url = await subirArchivoR2(buf, key, 'application/pdf');
  console.log(`☁️ ${url}`);

  const [ru] = await db.query('UPDATE users SET constancia_url = ? WHERE rfc = ?', [url, RFC]);
  const [rc] = await db.query('UPDATE clientes SET constancia_url = ? WHERE rfc = ?', [url, RFC]).catch(() => [{ affectedRows: 0 }]);
  console.log(`✅ users actualizados: ${ru.affectedRows} · clientes actualizados: ${rc.affectedRows}`);
  console.log('   A partir de ahora las solicitudes por correo adjuntan ESTA constancia.');
  process.exit(0);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
