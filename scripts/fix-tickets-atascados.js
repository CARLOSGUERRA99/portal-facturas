/**
 * Limpia los tickets atascados con datos incorrectos — para reintentos infinitos.
 * #88, #91 AutoZone: folio corto, necesitan código de barras.
 * #92 FG: folio dudoso, necesita verificación.
 * #95 ARCO: vencido definitivamente (26 abril, 2 días límite).
 * #87 TUFESA: falta campo origen (ciudad).
 * Uso: node scripts/fix-tickets-atascados.js
 */
require('dotenv').config();
const mysql = require('mysql2/promise');

async function main() {
  const db = await mysql.createConnection({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, port: parseInt(process.env.DB_PORT),
    database: process.env.DB_DATABASE, ssl: { rejectUnauthorized: false },
  });
  console.log('Conectado ✅\n');

  const fixes = [
    {
      id: 88, msg: 'Necesita el CÓDIGO DE BARRAS completo (número largo bajo el código de barras, ~20 dígitos). El folio corto 755971 no funciona en AutoZone.',
      razon: 'AutoZone #88: folio corto → necesita barcode',
    },
    {
      id: 91, msg: 'Necesita el CÓDIGO DE BARRAS completo (número largo bajo el código de barras, ~20 dígitos). El folio corto 601738 no funciona en AutoZone.',
      razon: 'AutoZone #91: folio corto → necesita barcode',
    },
    {
      id: 92, msg: 'Datos inválidos — el portal rechaza el folio 570188-741630-840459. Verifica el folio, caja (4), no. ticket (717072) y fecha (06/05/2026) en el ticket físico.',
      razon: 'FG #92: portal rechaza folio/caja/fecha → verificar ticket físico',
    },
    {
      id: 95, msg: 'Ticket VENCIDO — fue emitido el 26/04/2026 y BuzonFacturas solo permite facturar dentro de los primeros 2 días. No es posible facturar automáticamente.',
      razon: 'ARCO #95: vencido (26 abril)',
    },
    {
      id: 87, msg: 'Falta la CIUDAD DE ORIGEN del boleto TUFESA. Edita el ticket y agrega el origen (ciudad de partida del viaje) para que el bot pueda facturar.',
      razon: 'TUFESA #87: falta origen/ciudad',
    },
  ];

  for (const f of fixes) {
    const [r] = await db.query(
      "UPDATE tickets SET status='error', error_msg=?, reintento_programado=NULL WHERE id=?",
      [f.msg, f.id]
    );
    console.log(`✅ #${f.id} — ${f.razon} (${r.affectedRows} fila)`);
  }

  console.log('\n✅ Listo — todos los reintentos detenidos, mensajes de error claros puestos.');
  await db.end();
}
main().catch(e => { console.error('❌', e.message); process.exit(1); });
