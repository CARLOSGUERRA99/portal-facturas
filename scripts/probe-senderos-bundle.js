/**
 * Descarga el bundle JS de facturafranquicias.lossenderos.com.mx y de
 * factura.estrellablanca.com.mx y los compara, para confirmar si son la MISMA
 * plataforma (AMS Integra) y sacar la URL base de la API + endpoints.
 *
 * Uso: node scripts/probe-senderos-bundle.js
 */
const https = require('https');

const get = (u) => new Promise((res, rej) => {
  https.get(u, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122' } }, (r) => {
    let d = '';
    r.on('data', (c) => { d += c; });
    r.on('end', () => res(d));
  }).on('error', rej);
});

const RUIDO = /w3\.org|reactjs|fb\.me|schema\.org|googleapis|gstatic|cloudflare|jquery\.com|npmjs|unpkg|json-schema|mozilla/i;

function analizar(nombre, js) {
  console.log(`\n████ ${nombre} — bundle ${js.length} bytes`);
  const urls = [...new Set(js.match(/https?:\/\/[a-zA-Z0-9._\-/:]+/g) || [])].filter((u) => !RUIDO.test(u));
  console.log('URLS:', JSON.stringify(urls.slice(0, 40), null, 1));

  const eps = [...new Set(js.match(/["'`]\/?[Aa]pi\/[A-Za-z0-9_\-/{}.$]+/g) || [])];
  console.log('ENDPOINTS /api/:', JSON.stringify(eps.slice(0, 60), null, 1));

  for (const k of ['REACT_APP', 'baseURL', 'Franquicia', 'Sucursal', 'NoTicket', 'FechaVenta',
    'regimenFiscal', 'usoCfdi', 'RegimenFiscal', 'UsoCfdi', 'timbrar', 'Timbrar', 'GenerarFactura']) {
    let i = js.indexOf(k);
    if (i < 0) { console.log('---', k, '→ NO APARECE'); continue; }
    console.log('---', k, '@', i, '→', JSON.stringify(js.slice(Math.max(0, i - 200), i + 300)));
  }
  return js;
}

(async () => {
  const a = analizar('SENDEROS', await get('https://facturafranquicias.lossenderos.com.mx/static/js/main.985e18a5.js'));
  const b = analizar('ESTRELLABLANCA', await get('https://factura.estrellablanca.com.mx/static/js/main.6af642ef.js'));

  // Comparacion cruda: cuanto del bundle de uno aparece literal en el otro.
  console.log('\n████ COMPARACION');
  console.log('len senderos', a.length, '| len eb', b.length, '| ratio', (a.length / b.length).toFixed(4));
  let iguales = 0;
  const trozo = 2000;
  for (let i = 0; i + trozo < a.length; i += trozo * 10) {
    if (b.includes(a.substr(i, trozo))) iguales++;
  }
  const total = Math.floor(a.length / (trozo * 10));
  console.log(`trozos de ${trozo}B de SENDEROS presentes literalmente en EB: ${iguales}/${total}`);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
