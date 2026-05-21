/**
 * action: click
 * Hace click en un selector. Espera que sea visible primero.
 *
 * Params: { selector, timeout? }
 */
async function click(page, params) {
  const { selector, timeout = 15000 } = params;
  if (!selector) throw new Error('[click] selector requerido');
  await page.waitForSelector(selector, { visible: true, timeout });
  await page.click(selector);
}

module.exports = { click };
