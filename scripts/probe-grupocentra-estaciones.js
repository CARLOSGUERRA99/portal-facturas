// Probe de solo lectura: recorre TODAS las ciudades del selector #A15 del
// portal Karmi de Grupo Centra y vuelca TODAS las sucursales (#A14) de cada
// una. No escribe nada, no pulsa Cargar ni Facturar. Sirve para responder de
// forma definitiva "¿existe la estación NNNNN en el portal?".
require('dotenv').config();
const puppeteer = require('puppeteer');

const PORTAL_URL = 'https://facturacion.grupocentra.mx/Karmi_FacturacionWeb';
const RFC = process.env.RFC_PRUEBA || 'GPR110128QD8';
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true`,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1100 });
  page.on('dialog', async d => { await d.accept().catch(() => {}); });

  const opciones = id => page.evaluate(i => {
    const s = document.getElementById(i);
    return s ? Array.from(s.options).map(o => ({ value: o.value, text: o.text.trim() })) : null;
  }, id);

  const elegirValor = (id, value) => page.evaluate((i, v) => {
    const s = document.getElementById(i);
    if (!s) return false;
    s.value = v;
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, id, value);

  console.log('🌐 Abriendo', PORTAL_URL);
  const resp = await page.goto(PORTAL_URL, { waitUntil: 'networkidle2', timeout: 60000 });
  console.log('   HTTP', resp && resp.status(), '| url final:', page.url());
  await sleep(3500);

  const clickId = id => page.evaluate(i => { const e = document.getElementById(i); if (!e) return false; e.click(); return true; }, id);
  console.log('▶️  Facturar GAS (#M16):', await clickId('M16'));
  await sleep(5000);

  // RFC -> Buscar (el selector de ciudad solo se puebla despues)
  await page.evaluate((r) => {
    const e = document.getElementById('A4');
    if (e) { e.focus(); e.value = r; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); e.blur(); }
  }, RFC);
  await sleep(1200);
  await clickId('A1');
  await sleep(7000);
  console.log('   Razón social:', await page.evaluate(() => (document.getElementById('A3') || {}).value));

  const ciudades = (await opciones('A15')) || [];
  console.log(`\n🏙️  Ciudades en #A15: ${ciudades.length}`);
  console.log(JSON.stringify(ciudades, null, 1));

  const inventario = {};
  for (const c of ciudades) {
    if (!c.value || /SELECCIONE/i.test(c.text)) continue;
    await elegirValor('A15', c.value);
    await sleep(6000);
    const sucs = (await opciones('A14')) || [];
    inventario[c.text] = sucs.map(s => s.text).filter(t => t && !/SELECCIONE/i.test(t));
    console.log(`\n=== ${c.text} (${inventario[c.text].length}) ===`);
    inventario[c.text].forEach(s => console.log('   ', s));
  }

  const buscar = process.argv[2] || '7056';
  console.log(`\n🔎 Coincidencias con "${buscar}":`);
  let hits = 0;
  for (const [ciudad, sucs] of Object.entries(inventario)) {
    for (const s of sucs) {
      if (s.toLowerCase().includes(buscar.toLowerCase())) { console.log(`   ✅ ${ciudad} -> ${s}`); hits++; }
    }
  }
  if (!hits) console.log('   ❌ ninguna');

  console.log('\n🔎 Coincidencias con "COYOTE":');
  let h2 = 0;
  for (const [ciudad, sucs] of Object.entries(inventario)) {
    for (const s of sucs) {
      if (/coyote/i.test(s)) { console.log(`   ✅ ${ciudad} -> ${s}`); h2++; }
    }
  }
  if (!h2) console.log('   ❌ ninguna');

  require('fs').writeFileSync(
    process.env.SALIDA || 'C:\\Users\\carlo\\AppData\\Local\\Temp\\claude\\inventario-grupocentra.json',
    JSON.stringify(inventario, null, 1)
  );

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌ Error:', e.message); process.exit(1); });
