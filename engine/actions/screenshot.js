const { subirArchivoR2 } = require('../../storage/r2');

/**
 * action: screenshot
 * Toma screenshot y sube a R2 en debug/{portal}_{ticketId}_{name}.png
 *
 * Params: { name }
 * Context: ticketId, portal
 */
async function screenshot(page, params, context) {
  const { name } = params;
  try {
    const buf = await page.screenshot({ fullPage: false });
    const key = `debug/${context.portal}_${context.ticketId}_${name}_${Date.now()}.png`;
    await subirArchivoR2(buf, key, 'image/png');
  } catch {
    // screenshot nunca debe romper el flujo
  }
}

module.exports = { screenshot };
