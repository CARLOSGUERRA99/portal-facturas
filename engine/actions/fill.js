/**
 * action: fill
 * Llena un input con el valor dado.
 *
 * Params: { selector, value, strategy?, delay? }
 *
 * strategy:
 *   "keyboard"  — Ctrl+A → Delete → keyboard.type (default, funciona en 80% de casos)
 *   "angular"   — Angular setter via Object.getOwnPropertyDescriptor + dispatchEvent
 *   "angularjs" — AngularJS: click → seleccionar → type → dispatchEvent input+change
 *   "js"        — Asignación directa .value + dispatchEvent change (último recurso)
 */
async function fill(page, params) {
  const { selector, value, strategy = 'keyboard', delay = 60 } = params;
  if (!selector) throw new Error('[fill] selector requerido');
  if (value === undefined || value === null) throw new Error('[fill] value requerido');

  const val = String(value);

  await page.waitForSelector(selector, { visible: true, timeout: 15000 });

  switch (strategy) {
    case 'keyboard':
      await page.click(selector);
      await page.keyboard.down('Control');
      await page.keyboard.press('a');
      await page.keyboard.up('Control');
      await page.keyboard.press('Delete');
      await page.keyboard.type(val, { delay });
      break;

    case 'angular':
      await page.$eval(selector, (el, v) => {
        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (nativeSetter) nativeSetter.call(el, v);
        else el.value = v;
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, val);
      break;

    case 'angularjs':
      await page.click(selector, { clickCount: 3 });
      await page.keyboard.press('Delete');
      await page.keyboard.type(val, { delay });
      await page.$eval(selector, el => {
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
      break;

    case 'js':
      await page.$eval(selector, (el, v) => {
        el.value = v;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, val);
      break;

    default:
      throw new Error(`[fill] strategy desconocida: ${strategy}`);
  }
}

module.exports = { fill };
