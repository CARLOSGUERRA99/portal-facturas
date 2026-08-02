// Quita de la detección los portales DUPLICADOS que dejó el agente.
//
// ⚠️ EL PROBLEMA: cuando un ticket llega con un portal que la detección no
// conocía (ver scripts/sincronizar-deteccion-bots.js), el agente lo da de alta
// con una clave derivada del NOMBRE DEL COMERCIO — "autozonedemexico",
// "allegrocaffezonadoradatxutxufo" — aunque ya existiera la clave canónica
// "autozone" o "allegro" con su bot escrito y verificado a mano.
//
// Resultado: dos entradas para el mismo portal, y la Pasada 1 puede elegir la
// equivocada. Medido el 02/08/2026 con el banco de OCR: el ticket de AutoZone
// se detectó como "autozonedemexico" (el bot viejo generado por el agente) en
// vez de "autozone" (el bot que acabo de arreglar y con el que se emitió el
// CFDI real). Enrutar al bot equivocado = factura que no sale.
//
// El routing de bots/index.js usa las claves CORTAS, así que la canónica es esa
// — salvo en littlecaesars, donde la corta es la que se quedó sin bot.
//
// No se borra ningún archivo de bots/: solo se quita la entrada duplicada de la
// detección. Si algún día hace falta, el router dinámico por slug sigue ahí.
//
// Uso: node scripts/deduplicar-portales.js [--aplicar]
const fs = require('fs');
const path = require('path');

const RUTA = path.join(__dirname, '..', 'portales', 'portales.json');
const APLICAR = process.argv.includes('--aplicar');

// { clave que SE VA : clave que SE QUEDA }
const FUSIONAR = {
  autozonedemexico: 'autozone',
  elcaporalrestaurantecampestre: 'elcaporal',
  allegrocaffezonadoradatxutxufo: 'allegro',
  littlecaesars: 'littlecaesarsnavojoa',   // aquí la corta es la que no tiene bot
};

const j = JSON.parse(fs.readFileSync(RUTA, 'utf8'));
let cambios = 0;

for (const [sobra, queda] of Object.entries(FUSIONAR)) {
  const a = j.portales[sobra];
  const b = j.portales[queda];
  if (!a) { console.log(`⏭️  ${sobra} ya no estaba`); continue; }
  if (!b) { console.log(`⚠️  ${queda} no existe — NO se toca ${sobra}`); continue; }

  // Antes de tirar la entrada, se rescata lo que aporte: comercios y pistas de
  // detección que la canónica no tuviera. Perder una pista es perder tickets.
  const dA = a.deteccion || {}, dB = b.deteccion || {};
  const unir = (x = [], y = []) => [...new Set([...x, ...y])];
  b.deteccion = {
    ...dB,
    por_texto_ocr: unir(dB.por_texto_ocr, dA.por_texto_ocr),
    por_comercio: unir(dB.por_comercio, dA.por_comercio),
    por_url_qr: unir(dB.por_url_qr, dA.por_url_qr),
  };
  b.comercios = unir(b.comercios, a.comercios);
  if (!b.bot && a.bot) b.bot = a.bot;
  if (b.estado === 'pendiente' && a.estado === 'activo') b.estado = 'activo';

  delete j.portales[sobra];
  console.log(`🔗 ${sobra} → fusionado en "${queda}" (bot ${b.bot})`);
  cambios++;
}

if (!cambios) { console.log('\nsin duplicados'); process.exit(0); }
if (!APLICAR) { console.log(`\n${cambios} fusión(es) — usa --aplicar para escribirlas`); process.exit(0); }

j.actualizado = new Date().toISOString().slice(0, 10);
fs.writeFileSync(RUTA, JSON.stringify(j, null, 2));
console.log(`\n${cambios} fusión(es). La detección conoce ${Object.keys(j.portales).length} portales, sin duplicados.`);
