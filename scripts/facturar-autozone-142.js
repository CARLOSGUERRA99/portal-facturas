// Factura el ticket #142 (AutoZone de México, $648, 27/07/2026) con el bot real.
//
// ⚠️ ESTE SÍ FACTURA. Emite un CFDI de verdad. Autorizado explícitamente por
// Carlos el 02/08/2026: AutoZone no vence, ya ha emitido de meses anteriores.
//
// El ticket ya no existe en la BD (se borró en la limpieza del 01/08 y su
// historial se fue con él por ON DELETE CASCADE), así que los datos van a mano
// desde el respaldo `tickets-sin-factura-2026-08-01/INDICE.csv` y el perfil
// fiscal se lee de la BD para no hardcodear nada.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const db = require('../lib/db');
const { facturarAutoZone } = require('../bots/autozone');

// Del respaldo: 142,AutoZone de México,27/07/2026,648,07047995272072726,,error,Luis Miguel
const TICKET = {
  barcode: '07047995272072726',
  fecha: '2026-07-27',   // el bot acepta YYYY-MM-DD o DD/MM/YYYY
  total: 648,
  // El ticket dice VISADEBITO/VISADEBITO y XXXXXXXXXXXX9913 VISA.
  formaPago: 'VISA DEBITO',
};

(async () => {
  const [[u]] = await db.query(
    `SELECT rfc, razon_social, codigo_postal, regimen_fiscal, uso_cfdi, email,
            calle, num_ext, num_int, colonia, municipio, estado
       FROM users WHERE id = 1`
  );
  if (!u?.rfc) throw new Error('sin perfil fiscal en la BD');

  console.log(`🧾 Facturando ticket #142 — AutoZone, $${TICKET.total}, ${TICKET.fecha}`);
  console.log(`   RFC ${u.rfc} · ${u.razon_social} · CP ${u.codigo_postal} · rég ${u.regimen_fiscal} · uso ${u.uso_cfdi}\n`);

  const t0 = Date.now();
  const r = await facturarAutoZone({
    barcode: TICKET.barcode,
    folio: TICKET.barcode,
    fecha: TICKET.fecha,
    total: TICKET.total,
    formaPago: TICKET.formaPago,
    rfc: u.rfc,
    razonSocial: u.razon_social,
    codigoPostal: u.codigo_postal,
    regimenFiscal: u.regimen_fiscal,
    usoCfdi: u.uso_cfdi || 'G03',
    calle: u.calle, ext: u.num_ext, int: u.num_int,
    colonia: u.colonia, municipio: u.municipio, estado: u.estado,
    ticketId: 142,
  });

  console.log(`\n⏱️  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('RESULTADO:', JSON.stringify(r, null, 2));
  process.exit(0);
})().catch((e) => { console.error('❌', e.message, '\n', e.stack?.split('\n').slice(0, 4).join('\n')); process.exit(1); });
