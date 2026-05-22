/**
 * action: goto
 * Navega a una URL y espera a que la red esté idle.
 *
 * Params: { url }
 */
async function goto(page, params) {
  const { url } = params;
  if (!url) throw new Error('[goto] url requerida');
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'networkidle2' });
      return;
    } catch (err) {
      if (attempt === 2 || !err.message.includes('ERR_NAME_NOT_RESOLVED')) throw err;
      console.log(`[goto] DNS no resolvió (intento ${attempt}) — reintentando en 3s...`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

module.exports = { goto };
