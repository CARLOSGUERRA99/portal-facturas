/**
 * Mapea gen.jsp de facturacion.prb.com.mx:444 (KFC, ticket #364) SIN facturar:
 * saca los modales encadenados y, sobre todo, cual es el boton que timbra.
 *
 * Uso: node scripts/probe-prb-gen.js
 */
const https = require('https');

const FOLIO = '0593101192624086'; // ticket #364, KFC El Refugio, 28/08/2026, $199

const get = (u) => new Promise((res) => {
  const o = new URL(u);
  https.get({
    hostname: o.hostname, port: o.port || 443, path: o.pathname + o.search,
    rejectUnauthorized: false,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122', Referer: 'https://facturacion.prb.com.mx:444/index.jsp' },
  }, (r) => {
    let d = '';
    r.on('data', (c) => { d += c; });
    r.on('end', () => res(d));
  }).on('error', (e) => res('ERR ' + e.message));
});

const ventana = (s, aguja, antes, despues, etq) => {
  const i = s.indexOf(aguja);
  console.log(`\n████ ${etq || aguja} @ ${i}`);
  if (i < 0) return console.log('   NO APARECE');
  console.log(s.slice(Math.max(0, i - antes), i + despues).replace(/\n\s*\n/g, '\n'));
};

(async () => {
  const h = await get(`https://facturacion.prb.com.mx:444/gen.jsp?txtFolio=${FOLIO}&txtEmail=&txtRFC=&amount=&date=`);
  console.log('gen.jsp len', h.length);

  // Catalogo de regimen del receptor y de forma de pago.
  for (const id of ['cmbRecReg', 'cmbPaymentMethod', 'txtEntity']) {
    const i = h.indexOf(`id = '${id}'`) >= 0 ? h.indexOf(`id = '${id}'`) : h.indexOf(`id="${id}"`);
    console.log(`\n████ <select ${id}> opciones:`);
    if (i < 0) { console.log('   no encontrado'); continue; }
    const fin = h.indexOf('</select>', i);
    console.log(h.slice(i, fin).replace(/\s+/g, ' ').slice(0, 2200));
  }

  // Los modales encadenados: btnSend → openDivClient → divOpenConfMail → ???
  ventana(h, 'divOpenConfMail', 2500, 2500, 'modal de confirmacion de correo');
  ventana(h, 'txtChkMail', 2600, 2600, 'zona txtChkMail');

  console.log('\n\n████ FUNCIONES CLAVE DEL scripts_20220106.js');
  const js = await get('https://facturacion.prb.com.mx:444/scripts_20220106.js');
  for (const f of ['function openDivClient', 'function divOpenConfMail', 'function preloadTicketAmount',
    'function generaFactura', 'function genFactura', 'function sendFactura', 'function retDivClient']) {
    ventana(js, f, 0, 2400, f);
  }
  console.log('\n████ .jsp que aparecen en el JS:', JSON.stringify([...new Set(js.match(/[A-Za-z0-9_]+\.jsp/g) || [])]));
})();
