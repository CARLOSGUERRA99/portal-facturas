// Verificación del ticket #386 (E.S. 07056 EL COYOTE) en el portal Karmi de
// Grupo Centra.
//
// 🛑 ESTE SCRIPT NO TIMBRA. Llega hasta "Cargar" (#A17), que es la pantalla
// ANTERIOR a "Facturar" (#A40), y para. NO pulsa #A40 ni #A24 bajo ningún
// concepto. Sirve solo para demostrar que la sucursal COYOTE de CABORCA es la
// estación 07056 y que el consumo del ticket existe en el portal.
require('dotenv').config();
const puppeteer = require('puppeteer');

const PORTAL_URL = 'https://facturacion.grupocentra.mx/Karmi_FacturacionWeb';
const RFC = 'GPR110128QD8';
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true`,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1100 });
  page.on('dialog', async d => { console.log('   💬 dialog:', d.message()); await d.accept().catch(() => {}); });

  const clickId = id => page.evaluate(i => { const e = document.getElementById(i); if (!e) return false; e.click(); return true; }, id);
  const valor = id => page.evaluate(i => { const e = document.getElementById(i); return e ? e.value : null; }, id);
  const escribir = (id, v) => page.evaluate((i, val) => {
    const e = document.getElementById(i);
    if (!e) return false;
    e.focus(); e.value = val;
    e.dispatchEvent(new Event('input', { bubbles: true }));
    e.dispatchEvent(new Event('change', { bubbles: true }));
    e.blur();
    return true;
  }, id, String(v));
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

  await page.goto(PORTAL_URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(3500);
  await clickId('M16');
  await sleep(5000);

  await escribir('A4', RFC);
  await sleep(1200);
  await clickId('A1');
  await sleep(7000);
  console.log('Receptor:', await valor('A3'), '| régimen', await valor('A71'), '| CP', await valor('A117'), '| correo', await valor('A7'));

  // CABORCA
  const ciudades = await opciones('A15');
  const cab = ciudades.find(c => /^CABORCA$/i.test(c.text));
  console.log('\nCiudad CABORCA value =', cab && cab.value);
  await elegirValor('A15', cab.value);
  await sleep(7000);

  const sucs = await opciones('A14');
  console.log('\nSucursales de CABORCA (con VALUE interno):');
  console.log(JSON.stringify(sucs, null, 1));

  const coyote = sucs.find(s => /coyote/i.test(s.text));
  console.log('\n>>> COYOTE:', JSON.stringify(coyote));
  await elegirValor('A14', coyote.value);
  await sleep(8000);

  console.log('Empresa (#A41):', await valor('A41'));
  console.log('Dirección (#A13):', await valor('A13'));

  // Gasolina + datos del ticket #386
  await page.evaluate(() => { const g = document.getElementById('A95_1'); if (g && !g.checked) g.click(); });
  await sleep(1500);
  await escribir('A12', '217218');
  await escribir('A47', '08/09/2026');
  await escribir('A48', '10:40');
  await sleep(1500);

  console.log('\n▶️  Cargar (#A17) — LECTURA, no emite nada...');
  await clickId('A17');
  await sleep(10000);

  console.log('Combustible (#A18):', await valor('A18'));
  console.log('Litros      (#A19):', await valor('A19'));
  console.log('Precio      (#A21):', await valor('A21'));
  console.log('Importe     (#A23):', await valor('A23'));
  const txt = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 1200)).catch(() => '');
  console.log('\nPantalla:', txt);

  console.log('\n🛑 PARADA DELIBERADA: no se pulsa Agregar (#A24) ni Facturar (#A40).');
  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌ Error:', e.message); process.exit(1); });
