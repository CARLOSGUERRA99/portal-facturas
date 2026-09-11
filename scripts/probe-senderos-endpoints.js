/**
 * Saca del bundle de SENDEROS todos los endpoints de la API de AMS Integra y el
 * cuerpo que se manda al facturar, sin tocar el portal.
 *
 * Uso: node scripts/probe-senderos-endpoints.js
 */
const https = require('https');

const get = (u) => new Promise((res, rej) => {
  https.get(u, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122' } }, (r) => {
    let d = '';
    r.on('data', (c) => { d += c; });
    r.on('end', () => res(d));
  }).on('error', rej);
});

(async () => {
  const js = await get('https://facturafranquicias.lossenderos.com.mx/static/js/main.985e18a5.js');

  // La base de la API se guarda en una variable corta (dt). Los endpoints se
  // arman con .concat(dt,"/...") en este build.
  const eps = [...new Set((js.match(/concat\([a-zA-Z$_]{1,3},"\/[A-Za-z0-9_\-/?=&{}.]+/g) || [])
    .map((s) => s.replace(/^concat\([a-zA-Z$_]{1,3},"/, '')))];
  console.log('████ ENDPOINTS (concat base + ruta):');
  eps.forEach((e) => console.log('   ', e));

  // Nombres de las thunks redux: dan el mapa del flujo.
  const thunks = [...new Set(js.match(/"steps\/[A-Za-z]+"/g) || [])];
  console.log('\n████ THUNKS REDUX:', thunks.join(' '));

  console.log('\n████ CONTEXTO DE CADA ENDPOINT');
  const re = /concat\([a-zA-Z$_]{1,3},"\/[A-Za-z0-9_\-/?=&{}.]+/g;
  let m; const vistos = new Set();
  while ((m = re.exec(js)) !== null) {
    const ruta = m[0].replace(/^concat\([a-zA-Z$_]{1,3},"/, '');
    if (vistos.has(ruta)) continue;
    vistos.add(ruta);
    console.log(`\n--- ${ruta}`);
    console.log(JSON.stringify(js.slice(Math.max(0, m.index - 420), m.index + 420)));
  }

  // El cuerpo que se manda a facturar: se arma alrededor de idEmpresa:"GEB".
  console.log('\n████ CUERPO DE FACTURACION (idEmpresa GEB)');
  let i = js.indexOf('idEmpresa:"GEB"');
  while (i >= 0) {
    console.log('\n@', i, JSON.stringify(js.slice(Math.max(0, i - 900), i + 1600)));
    i = js.indexOf('idEmpresa:"GEB"', i + 1);
  }
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
