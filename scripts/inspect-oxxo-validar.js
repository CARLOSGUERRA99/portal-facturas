/**
 * Inspección read-only del botón "Validar Ticket" del portal OXXO.
 * NO hace click en Validar ni envía nada — solo llena el form e inspecciona el DOM.
 * Uso: node scripts/inspect-oxxo-validar.js
 */
require('dotenv').config();
const puppeteer = require('puppeteer');

const URL = 'https://www4.oxxo.com:9443/facturacionElectronica-web/views/layout/inicio.do';
// Datos del ticket #101 (solo para llevar el form al mismo estado que el bot)
const DATA = { fecha: '09/05/2025', folio: '464651', venta: '10OBR50ONG2', total: '57.00' };

async function main() {
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}`,
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);

  console.log('🌐 Navegando a OXXO...');
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 45000 });

  // Cerrar popup
  try {
    await page.waitForSelector('.ui-dialog-titlebar-close', { timeout: 5000 });
    await page.evaluate(() => document.querySelectorAll('.ui-dialog-titlebar-close').forEach(b => b.click()));
    await page.waitForTimeout(500);
  } catch {}

  console.log('✍️  Llenando form (sin validar)...');
  // Fecha
  try {
    await page.click('#form\\:fecha_input');
    await page.waitForTimeout(400);
    await page.evaluate((f) => {
      const i = document.querySelector('#form\\:fecha_input');
      if (i) { i.removeAttribute('readonly'); i.value = f; ['input','change','blur'].forEach(ev => i.dispatchEvent(new Event(ev,{bubbles:true}))); }
    }, DATA.fecha);
    await page.keyboard.press('Escape');
  } catch (e) { console.log('  fecha:', e.message); }

  for (const [sel, val] of [['folio', DATA.folio], ['venta', DATA.venta], ['total', DATA.total]]) {
    try {
      await page.click(`#form\\:${sel}`, { clickCount: 3 });
      await page.type(`#form\\:${sel}`, val, { delay: 40 });
    } catch (e) { console.log(` ${sel}:`, e.message); }
  }
  await page.waitForTimeout(500);

  console.log('\n🔎 INSPECCIÓN — elementos que contienen "validar":');
  const info = await page.evaluate(() => {
    const out = { matches: [], continuar: null, allButtons: [] };
    const norm = t => (t || '').replace(/\s+/g, ' ').trim();

    // Cualquier elemento cuyo texto/valor contenga "validar"
    const all = Array.from(document.querySelectorAll('*'));
    for (const el of all) {
      const txt = norm(el.textContent);
      const val = norm(el.value);
      const hay = /validar/i.test(txt) && txt.length < 60;
      const hayVal = /validar/i.test(val);
      if (hay || hayVal) {
        out.matches.push({
          tag: el.tagName,
          id: el.id || null,
          cls: el.className || null,
          type: el.type || null,
          text: txt.slice(0, 50),
          value: val.slice(0, 50) || null,
          onclick: el.getAttribute('onclick') ? el.getAttribute('onclick').slice(0, 120) : null,
          disabled: el.disabled || el.getAttribute('disabled') !== null || null,
          outer: el.outerHTML.slice(0, 200),
        });
      }
    }

    // Botón continuar (target del waitFor de éxito)
    const cont = document.querySelector('#form\\:continuar');
    if (cont) out.continuar = { id: cont.id, disabled: cont.disabled, cls: cont.className, outer: cont.outerHTML.slice(0, 200) };

    // Inventario de botones/links/submits con su id+texto
    const btns = Array.from(document.querySelectorAll('button, a[onclick], input[type="submit"], input[type="button"]'));
    out.allButtons = btns.map(b => ({ tag: b.tagName, id: b.id || null, text: norm(b.textContent).slice(0, 40) || norm(b.value).slice(0, 40), type: b.type || null })).slice(0, 40);

    return out;
  });

  console.log('\n── Coincidencias "validar" ──');
  console.log(JSON.stringify(info.matches, null, 2));
  console.log('\n── #form:continuar ──');
  console.log(JSON.stringify(info.continuar, null, 2));
  console.log('\n── Inventario botones/links ──');
  console.log(JSON.stringify(info.allButtons, null, 2));

  await browser.close();
  console.log('\n✅ Inspección terminada (no se envió nada al portal).');
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
