/**
 * action: waitFor
 * Espera a que un selector sea visible en la página.
 *
 * Params: { selector, timeout?, retries? }
 */
async function waitFor(page, params) {
  const { selector, timeout = 15000, retries = 0 } = params;
  if (!selector) throw new Error('[waitFor] selector requerido');

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await page.waitForSelector(selector, { visible: true, timeout });
      return;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`[waitFor] Selector no apareció: ${selector} — ${lastError.message}`);
}

module.exports = { waitFor };
