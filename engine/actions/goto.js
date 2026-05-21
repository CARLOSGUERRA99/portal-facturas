/**
 * action: goto
 * Navega a una URL y espera a que la red esté idle.
 *
 * Params: { url }
 */
async function goto(page, params) {
  const { url } = params;
  if (!url) throw new Error('[goto] url requerida');
  await page.goto(url, { waitUntil: 'networkidle2' });
}

module.exports = { goto };
