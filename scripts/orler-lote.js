require('dotenv').config();
const { facturarOrler } = require('../bots/orler');

// Los 5 tickets de Sinaloa/Orler pendientes (el #140 / folio 0944056 ya quedó
// timbrado en la prueba anterior → factura 24203273).
const TICKETS = [
  { ticketId: 139, carril: '5907', folio: '0343989', fechaPago: '24/07/2026', importe: '101.00', caseta: '59 - Las Brisas' },
  { ticketId: 141, carril: '1501', folio: '2860513', fechaPago: '24/07/2026', importe: '107.00', caseta: '15 - PSM' },
  { ticketId: 136, carril: '5908', folio: '0280313', fechaPago: '27/07/2026', importe: '101.00', caseta: '59 - Las Brisas' },
  { ticketId: 137, carril: '1503', folio: '3017725', fechaPago: '27/07/2026', importe: '107.00', caseta: '15 - PSM' },
  { ticketId: 138, carril: '5805', folio: '2292960', fechaPago: '27/07/2026', importe: '101.00', caseta: '585 - PISAL' },
];

(async () => {
  const resultados = [];
  for (const t of TICKETS) {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`Ticket #${t.ticketId} — ${t.caseta} | carril ${t.carril} | folio ${t.folio} | $${t.importe}`);
    console.log('='.repeat(70));
    try {
      const r = await facturarOrler(t);
      resultados.push({ ...t, resultado: r });
      console.log(`→ ${r.ok ? '✅ OK' : '❌ ' + (r.error_code || '') + ' ' + (r.msg || '')}`);
    } catch (e) {
      resultados.push({ ...t, resultado: { ok: false, msg: e.message } });
      console.log(`→ 💥 excepción: ${e.message}`);
    }
    // Pausa entre facturas para no saturar el portal del gobierno
    await new Promise(r => setTimeout(r, 4000));
  }

  console.log(`\n\n${'#'.repeat(70)}`);
  console.log('RESUMEN DEL LOTE');
  console.log('#'.repeat(70));
  for (const r of resultados) {
    const est = r.resultado.ok ? '✅ TIMBRADA' : `❌ ${r.resultado.error_code || 'fallo'}`;
    console.log(`#${r.ticketId} folio ${r.folio} $${r.importe} → ${est}`);
    if (!r.resultado.ok) console.log(`     ${(r.resultado.msg || '').slice(0, 160)}`);
  }
  process.exit(0);
})();
