/**
 * Hook: valida JSON después de que Claude escribe un archivo.
 * Corre en PostToolUse → Write.
 * Si el archivo es .json en commerce/ o engine/, lo parsea y reporta.
 * Exit 0 = ok, no bloquea (PostToolUse no puede deshacer, solo avisa).
 */
const chunks = [];
process.stdin.on('data', d => chunks.push(d));
process.stdin.on('end', () => {
  let input;
  try {
    input = JSON.parse(chunks.join(''));
  } catch {
    process.exit(0); // si no hay stdin válido, ignorar
  }

  const filePath = (input.tool_input && input.tool_input.file_path) || '';
  const isJson = filePath.endsWith('.json');
  const isEngineFile = filePath.includes('commerce') || filePath.includes('engine');

  if (!isJson || !isEngineFile) process.exit(0);

  const fs = require('fs');
  const name = filePath.split(/[\\/]/).pop();

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    JSON.parse(content);
    console.log(`[HOOK] ✅ JSON válido — ${name}`);
  } catch (e) {
    // Aviso visible en consola — no bloquea porque ya se escribió
    console.error(`[HOOK] ❌ JSON INVÁLIDO en ${name}`);
    console.error(`[HOOK]    ${e.message}`);
    console.error(`[HOOK]    Corrige el archivo antes de hacer commit/push`);
  }

  process.exit(0);
});
