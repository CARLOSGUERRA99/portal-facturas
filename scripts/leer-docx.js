/**
 * Extrae el texto de archivos .docx (sin dependencias extra, usa unzipper).
 * Uso: node scripts/leer-docx.js "ruta1.docx" "ruta2.docx" ...
 */
const unzipper = require('unzipper');

async function leer(file) {
  const dir = await unzipper.Open.file(file);
  const docXml = dir.files.find(f => f.path === 'word/document.xml');
  if (!docXml) return '(sin word/document.xml)';
  let xml = (await docXml.buffer()).toString('utf8');
  xml = xml.replace(/<w:tab\/>/g, '\t').replace(/<\/w:p>/g, '\n').replace(/<w:br\/?>/g, '\n');
  let t = xml.replace(/<[^>]+>/g, '');
  t = t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (m, n) => String.fromCharCode(n));
  t = t.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim();
  // contar imágenes (screenshots) embebidas
  const imgs = dir.files.filter(f => /word\/media\//.test(f.path)).length;
  return { texto: t, imagenes: imgs };
}

(async () => {
  const files = process.argv.slice(2);
  for (const f of files) {
    console.log('\n\n████████████████████████████████████████████████████');
    console.log('ARCHIVO:', f);
    console.log('████████████████████████████████████████████████████');
    try {
      const r = await leer(f);
      console.log(`(${r.texto.length} chars de texto, ${r.imagenes} imágenes embebidas)\n`);
      console.log(r.texto);
    } catch (e) {
      console.log('❌ Error:', e.message);
    }
  }
  process.exit(0);
})();
