require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

const FOLIO = '18132905202621000068200100084801077';

const dump = () => {
  const vis = el => el.offsetParent !== null;
  const inputs = Array.from(document.querySelectorAll('input,select,textarea')).filter(vis).map(i => ({ id: i.id || null, name: i.name || null, ph: i.placeholder || null, type: i.type || null, fc: i.getAttribute('formcontrolname') || null }));
  const botones = Array.from(document.querySelectorAll('button,a,input[type=submit],input[type=button],[role=button],.btn')).filter(vis).map(b => ({ id: b.id || null, cls: (b.className || '').toString().slice(0, 28), text: (b.textContent || b.value || '').trim().slice(0, 28) })).filter(b => b.text && b.text.length < 28);
  return { inputs: inputs.slice(0, 25), botones: botones.slice(0, 22), txt: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 250) };
};

const clickExacto = async (page, texto) => page.evaluate((t) => {
  const els = Array.from(document.querySelectorAll('button,a,input[type=submit],input[type=button],[role=button],.btn')).filter(e => e.offsetParent);
  const el = els.find(e => (e.textContent || e.value || '').trim().toUpperCase() === t.toUpperCase());
  if (el) { el.click(); return true; }
  return false;
}, texto);

(async () => {
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto('https://www.e7-eleven.com.mx/facturacion/KPortalExterno/', { waitUntil: 'networkidle2', timeout: 40000 });
  await page.waitForTimeout(3500);

  console.log('>> FACTURA EXPRESS:', await clickExacto(page, 'FACTURA EXPRESS'));
  await page.waitForTimeout(4500);
  console.log('shot1:', await subirArchivoR2(await page.screenshot(), `debug/p7e_express_${Date.now()}.png`, 'image/png'));
  console.log('FORM EXPRESS:', JSON.stringify(await page.evaluate(dump), null, 1));

  // Llenar el folio en el campo nuevo (no login) y AGREGAR TICKET
  const lleno = await page.evaluate((folio) => {
    const inp = Array.from(document.querySelectorAll('input')).find(i => i.offsetParent && i.id !== 'rfc' && i.id !== 'password' && ['text', 'number', '', 'search', 'tel'].includes((i.type || '').toLowerCase()));
    if (!inp) return null;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter ? setter.call(inp, folio) : (inp.value = folio);
    ['input', 'change', 'keyup', 'blur'].forEach(ev => inp.dispatchEvent(new Event(ev, { bubbles: true })));
    return inp.id || inp.getAttribute('formcontrolname') || inp.placeholder || 'sin-id';
  }, FOLIO);
  console.log('\n>> folio llenado en:', lleno);
  console.log('>> AGREGAR TICKET:', await clickExacto(page, 'AGREGAR TICKET'));
  await page.waitForTimeout(5500);
  console.log('shot2:', await subirArchivoR2(await page.screenshot(), `debug/p7e_agregado_${Date.now()}.png`, 'image/png'));
  console.log('TRAS AGREGAR:', JSON.stringify(await page.evaluate(dump), null, 1));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
