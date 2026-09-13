// Corrige campos sueltos del ocr_json de un ticket, cuando el OCR se equivoca
// en un dato que ya verificamos contra el portal.
//
// No es para parchear a ciegas: la regla es corregir SOLO lo que el portal
// confirmó. Caso real: el ticket #390 imprime el folio 0524080 y el OCR guardó
// 052080 (un dígito menos) incluso tras la Pasada 3 de relectura dirigida; el
// portal de qrplus encontró el cruce con 0524080, así que ese es el bueno.
//
// Uso:
//   node scripts/_corregir-ocr.js 390 folio=0524080
//   node scripts/_corregir-ocr.js 390 folio=0524080 carril=4 hora=17:07:45
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const db = require('../lib/db');

(async () => {
  const [idArg, ...pares] = process.argv.slice(2);
  const id = Number(idArg);
  if (!id || !pares.length) { console.log('uso: node scripts/_corregir-ocr.js <id> campo=valor [campo=valor...]'); process.exit(1); }

  const [[t]] = await db.query('SELECT id, comercio, ocr_json FROM tickets WHERE id = ?', [id]);
  if (!t) { console.log(`No existe el ticket #${id}`); process.exit(1); }

  let ocr = {};
  try { ocr = JSON.parse(t.ocr_json || '{}'); } catch { console.log('ocr_json ilegible'); process.exit(1); }

  console.log(`#${id} ${t.comercio}`);
  for (const p of pares) {
    const i = p.indexOf('=');
    if (i < 1) { console.log(`  ignorado: "${p}"`); continue; }
    const campo = p.slice(0, i), valor = p.slice(i + 1);
    console.log(`  ${campo}: ${JSON.stringify(ocr[campo])} → ${JSON.stringify(valor)}`);
    ocr[campo] = valor;
  }
  // Si tocamos un campo, deja de ser una lectura "dudosa" heredada.
  if (Array.isArray(ocr.campos_dudosos)) {
    ocr.campos_dudosos = ocr.campos_dudosos.filter((c) => !pares.some((p) => p.startsWith(`${c}=`)));
  }

  await db.query('UPDATE tickets SET ocr_json = ? WHERE id = ?', [JSON.stringify(ocr), id]);
  console.log('  ✅ ocr_json actualizado');
  process.exit(0);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
