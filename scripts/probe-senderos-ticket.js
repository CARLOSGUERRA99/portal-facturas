/**
 * Prueba SOLO LECTURA contra /Catalogos/obtenerTicket (GET, no factura nada)
 * para dar con la combinacion correcta del ticket #350 (KFC Durango).
 *
 * El OCR trajo DOS numeros: Ticket 217 y "No. Ticket Unico" 80. Es la trampa
 * de "los dos folios" del proyecto: hay que probar cual acepta el portal.
 *
 * Uso: node scripts/probe-senderos-ticket.js
 */
const https = require('https');

const BASE = 'https://apifacturasestrellablanca.amsintegra.com.mx/main';

const getJson = (u) => new Promise((res) => {
  https.get(u, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122',
      Accept: 'application/json',
      Origin: 'https://facturafranquicias.lossenderos.com.mx',
    },
  }, (r) => {
    let d = '';
    r.on('data', (c) => { d += c; });
    r.on("end", () => res({ status: r.statusCode, body: d }));
  }).on('error', (e) => res({ status: 'ERR', body: e.message }));
});

const obtenerTicket = (p) => {
  const q = new URLSearchParams({
    noComprobante: '', noTr: '', precio: p.precio, claveTicket: 'CONSUMO',
    franquicia: p.franquicia, noTicket: p.noTicket, sucursal: p.sucursal, fechaVenta: p.fechaVenta,
  });
  return getJson(`${BASE}/Catalogos/obtenerTicket/GEB?tipo=1&${q}`);
};

(async () => {
  console.log('████ CATALOGOS (solo lectura)');
  for (const r of ['franquicias', 'sucursal_KFC', 'sucursal_SUS']) {
    const x = await getJson(`${BASE}/catalogos/XML/empresa/GEB/${r}`);
    console.log(`\n--- ${r}:`, x.status, x.body);
  }

  console.log('\n\n████ MATRIZ DEL TICKET #350 — KFC, sucursal 1434');
  const noTickets = ['217', '80', '0217', '00217', '080'];
  const fechas = ['2026-09-04', '2026-09-03', '2026-09-05'];
  const precios = ['149', '149.00'];

  for (const noTicket of noTickets) {
    for (const fechaVenta of fechas) {
      for (const precio of precios) {
        const r = await obtenerTicket({ franquicia: 'KFC', sucursal: '1434', noTicket, fechaVenta, precio });
        const j = (() => { try { return JSON.parse(r.body); } catch (_) { return null; } })();
        const ok = j && j.isSuccess;
        const marca = ok ? '✅ ENCONTRADO' : `   ${j ? j.errorCode + ' ' + j.error : r.body.slice(0, 80)}`;
        console.log(`noTicket=${noTicket.padEnd(6)} fecha=${fechaVenta} precio=${precio.padEnd(7)} → ${marca}`);
        if (ok) console.log('   DATA:', r.body);
      }
    }
  }

  // ¿La sucursal correcta es otra? El OCR dijo "KFC CENTRAL DURANGO" y el
  // catalogo dice "1434 - KFC DURANGO". Se prueba el ticket en todas.
  console.log('\n\n████ ¿Estara en otra sucursal? (noTicket=217, 2026-09-04, 149)');
  const suc = await getJson(`${BASE}/catalogos/XML/empresa/GEB/sucursal_KFC`);
  const claves = (JSON.parse(suc.body).data || []).map((s) => s.Clave);
  for (const sucursal of claves) {
    const r = await obtenerTicket({ franquicia: 'KFC', sucursal, noTicket: '217', fechaVenta: '2026-09-04', precio: '149' });
    const j = (() => { try { return JSON.parse(r.body); } catch (_) { return null; } })();
    if (j && j.isSuccess) console.log(`✅ sucursal ${sucursal} →`, r.body);
  }
  console.log('(sin salida = no aparecio en ninguna)');
})();
