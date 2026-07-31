// Extrae el texto de la Constancia de Situación Fiscal (PDF) sin depender de
// poppler ni de librerías externas.
//
// Detalle que importa: la CSF trae streams de IMAGEN (DCTDecode, el logo del
// SAT) mezclados con los de texto (FlateDecode). Inflar todo a ciegas mete
// bytes de JPEG en el resultado y sale ruido binario — hay que mirar el
// diccionario que precede a cada stream y saltarse los de imagen.
//
// Uso: node scripts/leer-csf.js <ruta.pdf>
const fs = require('fs');
const zlib = require('zlib');

const ruta = process.argv[2];
if (!ruta) { console.error('uso: node scripts/leer-csf.js <ruta.pdf>'); process.exit(1); }

const b = fs.readFileSync(ruta);
const trozos = [];
let i = 0;

while (true) {
  const a = b.indexOf(Buffer.from('stream'), i);
  if (a < 0) break;

  // Diccionario del objeto: los ~400 bytes anteriores a "stream".
  const dic = b.slice(Math.max(0, a - 400), a).toString('latin1');
  let ini = a + 6;
  while (b[ini] === 13 || b[ini] === 10) ini++;
  const fin = b.indexOf(Buffer.from('endstream'), ini);
  if (fin < 0) break;

  const esImagen = /DCTDecode|JPXDecode|CCITTFaxDecode|\/Subtype\s*\/Image/.test(dic);
  if (!esImagen && /FlateDecode/.test(dic)) {
    try { trozos.push(zlib.inflateSync(b.slice(ini, fin)).toString('latin1')); } catch {}
  }
  i = fin + 9;
}

// De los operadores de texto (Tj y TJ) solo interesan los literales entre
// paréntesis; el resto son coordenadas y ajustes de kerning.
const reLiteral = new RegExp('\\((?:\\\\.|[^()\\\\])*\\)', 'g');
const salida = [];
for (const t of trozos) {
  for (const bloque of t.split(/\bBT\b/).slice(1)) {
    const texto = bloque.split(/\bET\b/)[0];
    const piezas = [...texto.matchAll(reLiteral)]
      .map((m) => m[0].slice(1, -1).replace(/\\([()\\])/g, '$1'))
      .filter((s) => s.trim());
    if (piezas.length) salida.push(piezas.join(''));
  }
}

const plano = salida.join('\n').replace(/[ \t]+/g, ' ').trim();
console.log(plano || '(no se encontró texto: el PDF podría ser un escaneo sin capa de texto)');
