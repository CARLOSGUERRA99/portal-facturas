/**
 * Lee del bundle el flujo exacto: que parametros manda obtenerTicket, en que
 * paso se dispara la PREfactura (isGenerarCFDI="0") y en cual el TIMBRADO
 * (isGenerarCFDI="1"), y como se rotulan los botones de cada paso.
 *
 * Uso: node scripts/probe-senderos-flujo.js
 */
const https = require('https');

const get = (u) => new Promise((res, rej) => {
  https.get(u, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122' } }, (r) => {
    let d = '';
    r.on('data', (c) => { d += c; });
    r.on('end', () => res(d));
  }).on('error', rej);
});

function ventana(js, aguja, antes, despues, etiqueta) {
  const i = js.indexOf(aguja);
  console.log(`\n████ ${etiqueta || aguja} @ ${i}`);
  if (i < 0) return console.log('   NO APARECE');
  console.log(JSON.stringify(js.slice(Math.max(0, i - antes), i + despues)));
}

(async () => {
  const js = await get('https://facturafranquicias.lossenderos.com.mx/static/js/main.985e18a5.js');

  // 1) Que se manda a obtenerTicket (el objeto que va a URLSearchParams).
  ventana(js, '/Catalogos/obtenerTicket/GEB?tipo=', 2600, 900, 'obtenerTicket — params');

  // 2) Donde se pone isGenerarCFDI a "1" (el timbrado de verdad).
  let i = js.indexOf('isGenerarCFDI="1"');
  if (i < 0) i = js.indexOf('isGenerarCFDI=\"1\"');
  console.log('\n████ isGenerarCFDI="1" @', i);
  if (i >= 0) console.log(JSON.stringify(js.slice(i - 1200, i + 1200)));

  // 3) El manejador del timbrado (FacturasTimbradas) y el boton que lo dispara.
  ventana(js, 'FacturasTimbradas', 2200, 1800, 'timbrado — FacturasTimbradas');

  // 4) Rotulos de botones por paso.
  for (const t of ['"Facturar"', '"Siguiente"', '"Regresar"', '"Generar', '"Descargar', 'Confirmar', '"A\\xf1adir ticket"', 'Anadir']) {
    const idxs = [];
    let k = js.indexOf(t);
    while (k >= 0 && idxs.length < 4) { idxs.push(k); k = js.indexOf(t, k + 1); }
    console.log(`\n--- rotulo ${t} → ${idxs.length} ocurrencias en ${idxs.join(',')}`);
    idxs.slice(0, 2).forEach((x) => console.log('   ', JSON.stringify(js.slice(Math.max(0, x - 500), x + 400))));
  }

  // 5) Pasos del wizard.
  ventana(js, 'handleStep("generar")', 1400, 700, 'handleStep generar');
  ventana(js, '"datosFiscales"===', 900, 1400, 'render por paso');
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
