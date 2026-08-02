// Banco de pruebas del OCR.
//
// "Mejorar el OCR" sin medir es adivinar: se toca un prompt, parece que va
// mejor en un ticket y se rompe en otros tres sin que nadie se entere. Este
// script corre el pipeline REAL sobre un set fijo de fotos y compara contra las
// respuestas correctas, para poder decir si un cambio mejoró o empeoró.
//
// El set son fotos de tickets que YA fallaron en producción: es exactamente el
// caso difícil, no una muestra bonita.
//
// Uso:
//   node scripts/evaluar-ocr.js                    → corre todo el set
//   node scripts/evaluar-ocr.js igasfac            → solo los casos de ese portal
//   GUARDAR=1 node scripts/evaluar-ocr.js          → guarda el resultado como línea base
const fs = require('fs');
const path = require('path');
// Ruta explícita: dotenv busca el .env en el CWD, y este script se lanza desde
// cualquier sitio. Sin esto arranca sin ANTHROPIC_API_KEY y las 24 fotos fallan
// con "Could not resolve authentication method" — que parece un fallo del OCR
// pero es el .env que no se cargó.
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { procesarImagenTicket } = require('../lib/vision');

const SET = path.join(__dirname, '..', 'pruebas', 'ocr');
const BASE = path.join(SET, '_linea-base.json');

// Verdad de campo, sacada de leer las fotos a mano durante la sesión del
// 31/07-01/08. Cada entrada dice qué DEBE extraer el OCR y por qué falló antes.
const CASOS = require(path.join(SET, 'casos.json'));

const norm = (v) => v === null || v === undefined ? null : String(v).trim().toUpperCase().replace(/\s+/g, '');
const igual = (a, b) => {
  if (b === '*') return a !== null && a !== undefined && String(a).trim() !== '';
  if (b === null) return a === null || a === undefined;
  if (typeof b === 'number') return Math.abs(parseFloat(a) - b) < 0.01;
  return norm(a) === norm(b);
};

(async () => {
  // Acepta varios filtros separados por coma para poder re-correr SOLO los que
  // fallaron sin pagar otra pasada completa sobre los 24.
  const filtros = (process.argv[2] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const casos = CASOS.filter((c) => !filtros.length || filtros.some((f) => c.portalEsperado === f || c.archivo.includes(f)));
  if (!casos.length) { console.error('sin casos que coincidan'); process.exit(1); }

  console.log(`🔬 Evaluando el OCR sobre ${casos.length} ticket(s) reales\n`);
  const resultados = [];

  for (const caso of casos) {
    const ruta = path.join(SET, 'fotos', caso.archivo);
    if (!fs.existsSync(ruta)) { console.log(`⚠️ falta la foto ${caso.archivo}`); continue; }

    let salida;
    try {
      salida = await procesarImagenTicket(fs.readFileSync(ruta), caso.archivo.endsWith('.png') ? 'image/png' : 'image/jpeg');
    } catch (e) {
      console.log(`❌ ${caso.archivo}: el pipeline reventó — ${e.message.slice(0, 80)}`);
      resultados.push({ caso: caso.archivo, aciertos: 0, total: Object.keys(caso.esperado).length, fallos: ['EXCEPCIÓN'] });
      continue;
    }

    const d = salida.datosOCR || {};
    const fallos = [];
    let aciertos = 0;
    for (const [campo, esperado] of Object.entries(caso.esperado)) {
      // `portal` y `ticketsEnFoto` los decide el pipeline, no salen del JSON del
      // modelo: se leen de la salida, no de datosOCR.
      const obtenido = campo === 'portal' ? salida.portalDetectado
        : campo === 'ticketsEnFoto' ? salida.ticketsEnFoto
        : d[campo];
      if (igual(obtenido, esperado)) aciertos++;
      else fallos.push(`${campo}: esperaba "${esperado}" y salió "${obtenido ?? 'null'}"`);
    }

    const total = Object.keys(caso.esperado).length;
    const marca = aciertos === total ? '✅' : (aciertos === 0 ? '❌' : '⚠️');
    console.log(`${marca} ${caso.archivo.padEnd(42)} ${aciertos}/${total}`);
    fallos.forEach((f) => console.log(`     ${f}`));
    if (caso.porQueFallaba && aciertos < total) console.log(`     (fallo histórico: ${caso.porQueFallaba})`);
    resultados.push({ caso: caso.archivo, aciertos, total, fallos });
  }

  const aciertos = resultados.reduce((a, r) => a + r.aciertos, 0);
  const campos = resultados.reduce((a, r) => a + r.total, 0);
  const perfectos = resultados.filter((r) => r.aciertos === r.total).length;
  const pct = campos ? ((aciertos / campos) * 100).toFixed(1) : '0';

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`CAMPOS CORRECTOS : ${aciertos}/${campos}  (${pct}%)`);
  console.log(`TICKETS PERFECTOS: ${perfectos}/${resultados.length}`);

  // Solo tiene sentido comparar corridas del MISMO set: un subconjunto de casos
  // difíciles siempre puntúa peor y disparaba la alarma de regresión sin motivo.
  if (fs.existsSync(BASE) && !filtros.length) {
    const prev = JSON.parse(fs.readFileSync(BASE, 'utf8'));
    const dPct = parseFloat(pct) - parseFloat(prev.pct);
    const dPerf = perfectos - prev.perfectos;
    console.log(`\nvs línea base (${prev.fecha}): ${dPct >= 0 ? '+' : ''}${dPct.toFixed(1)}% campos · ${dPerf >= 0 ? '+' : ''}${dPerf} tickets perfectos`);
    // Un cambio que empeora hay que verlo, no descubrirlo semanas después.
    if (dPct < 0) console.log('⚠️ ESTE CAMBIO EMPEORÓ EL OCR');
  }

  // El resumen se pierde entre los logs del pipeline, y volver a correr para
  // releerlo cuesta otra pasada de Sonnet por ticket. Se deja en disco.
  const fallidos = resultados.filter((r) => r.aciertos < r.total);
  fs.writeFileSync(path.join(SET, '_ultimo-resultado.json'), JSON.stringify({ fecha: new Date().toISOString(), pct, perfectos, total: resultados.length, fallidos }, null, 1));
  if (fallidos.length) {
    console.log(`\nFALLAN ${fallidos.length}:`);
    fallidos.forEach((r) => console.log(`  · ${r.caso}\n      ${r.fallos.join('\n      ')}`));
  }

  if (process.env.GUARDAR === '1') {
    fs.writeFileSync(BASE, JSON.stringify({ fecha: new Date().toISOString().slice(0, 10), pct, perfectos, total: resultados.length, detalle: resultados }, null, 1));
    console.log(`\n💾 línea base guardada`);
  }
  console.log('═'.repeat(60));
  process.exit(0);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
