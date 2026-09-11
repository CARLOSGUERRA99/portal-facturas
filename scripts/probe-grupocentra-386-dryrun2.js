// Ensayo 2 del ticket #386: el barrido de las 15 plazas deja la PESTAÑA
// inservible ("Requesting main frame too early!"), y ni siquiera un page.goto
// la recupera. Aquí se prueba la salida real: cerrar esa pestaña y abrir UNA
// NUEVA para la fase de selección.
//
// 🛑 NO TIMBRA. Termina en "Cargar" (#A17), la pantalla ANTERIOR a "Facturar"
// (#A40). No pulsa #A24 ni #A40.
require('dotenv').config();
const puppeteer = require('puppeteer');

const PORTAL_URL = 'https://facturacion.grupocentra.mx/Karmi_FacturacionWeb';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const T = { estacion: '07056', comercio: 'E.S. 07056 EL COYOTE', folio: '217218', fecha: '08/09/2026', hora: '10:40', total: 602.44, rfc: 'GPR110128QD8', ciudad: process.env.CIUDAD || null };

(async () => {
  let browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}&stealth=true`,
  });

  let page = await browser.newPage();
  const prep = async (p) => {
    await p.setViewport({ width: 1280, height: 1100 });
    p.on('dialog', async d => { await d.accept().catch(() => {}); });
  };
  await prep(page);

  const valor = id => page.evaluate(i => { const e = document.getElementById(i); return e ? e.value : null; }, id);
  const clickId = id => page.evaluate(i => { const e = document.getElementById(i); if (!e) return false; e.click(); return true; }, id);
  const escribir = (id, v) => page.evaluate((i, val) => {
    const e = document.getElementById(i);
    if (!e) return false;
    e.focus(); e.value = val;
    e.dispatchEvent(new Event('input', { bubbles: true }));
    e.dispatchEvent(new Event('change', { bubbles: true }));
    e.blur();
    return true;
  }, id, String(v));
  const elegir = (id, patron) => page.evaluate((i, p) => {
    const s = document.getElementById(i);
    if (!s) return null;
    const o = Array.from(s.options).find(x => new RegExp(p, 'i').test(x.text));
    if (!o) return null;
    s.value = o.value;
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return o.text;
  }, id, patron);

  async function abrirFormulario() {
    await page.goto(PORTAL_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(3500);
    await clickId('M16');
    await sleep(5000);
    await escribir('A4', T.rfc);
    await sleep(1200);
    await clickId('A1');
    await sleep(7000);
    return valor('A3');
  }

  console.log('Receptor:', await abrirFormulario());

  const estacionNum = String(T.estacion).replace(/\D/g, '');
  const estacionSinCeros = estacionNum.replace(/^0+/, '') || estacionNum;
  const norm = s => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toUpperCase();
  const comercioNorm = norm(T.comercio);
  const esc = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const ciudades = T.ciudad ? [T.ciudad] : await page.evaluate(() => {
    const s = document.getElementById('A15');
    return s ? Array.from(s.options).map(o => o.text.trim()).filter(t => t && !/SELECCIONE/i.test(t)) : [];
  });
  console.log('Plazas a recorrer:', ciudades.length);

  let sucursal = null, ciudadElegida = null;
  const porNombre = [];
  for (const c of ciudades) {
    const elegida = await elegir('A15', `^${esc(c)}$`);
    if (!elegida) continue;
    await sleep(6000);
    sucursal = await elegir('A14', `#${estacionSinCeros}\\b`);
    if (!sucursal && estacionSinCeros !== estacionNum) sucursal = await elegir('A14', `#${estacionNum}\\b`);
    if (sucursal) { ciudadElegida = elegida; break; }
    const opts = await page.evaluate(() => {
      const s = document.getElementById('A14');
      return s ? Array.from(s.options).map(o => o.text.trim()) : [];
    });
    for (const t of opts) {
      if (!t || /SELECCIONE/i.test(t)) continue;
      const nombre = norm(t.split(' - ')[0]).trim();
      if (nombre.length >= 4 && new RegExp(`(^|[^A-Z0-9])${esc(nombre)}([^A-Z0-9]|$)`).test(comercioNorm)) {
        porNombre.push({ ciudad: elegida, text: t });
      }
    }
  }
  console.log('\nCandidatas por nombre:', JSON.stringify(porNombre));

  if (!sucursal && porNombre.length === 1) {
    const cand = porNombre[0];
    if (ciudades.length > 1) {
      console.log('🔄 La SESION entera de Browserless muere con el barrido: reconectando de cero...');
      await browser.close().catch(() => {});
      browser = await puppeteer.connect({
        browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}&stealth=true`,
      });
      page = await browser.newPage();
      await prep(page);
      console.log('   Receptor (pestaña nueva):', await abrirFormulario());
      await elegir('A15', `^${esc(cand.ciudad)}$`);
      await sleep(7000);
    } else {
      console.log('⏩ Una sola plaza recorrida: sesion sana, se elige sin reconectar.');
    }
    const ok = await page.evaluate(t => {
      const s = document.getElementById('A14');
      if (!s) return null;
      const o = Array.from(s.options).find(x => x.text.trim() === t);
      if (!o) return null;
      s.value = o.value;
      s.dispatchEvent(new Event('change', { bubbles: true }));
      return o.text;
    }, cand.text);
    if (ok) { sucursal = ok; ciudadElegida = cand.ciudad; }
  }

  if (!sucursal) { console.log('❌ SIN SUCURSAL'); await browser.close(); process.exit(1); }
  console.log(`\n✅ Ciudad: ${ciudadElegida} | Sucursal: ${sucursal}`);
  await sleep(6000);
  console.log('Empresa (#A41):', await valor('A41'), '| Dirección (#A13):', await valor('A13'));

  await page.evaluate(() => { const g = document.getElementById('A95_1'); if (g && !g.checked) g.click(); });
  await sleep(1500);
  await escribir('A12', T.folio);
  await escribir('A47', T.fecha);
  await escribir('A48', T.hora);
  await sleep(1500);
  await clickId('A17');
  await sleep(10000);
  const importe = await valor('A23');
  console.log(`\nCargar → ${await valor('A18')} | ${await valor('A19')} L | ${await valor('A21')} | importe ${importe}`);
  const n = parseFloat(String(importe || '').replace(/[^0-9.]/g, ''));
  console.log(`Coincide con el ticket ($${T.total}): ${Math.abs(n - T.total) <= 1 ? 'SI' : 'NO'}`);
  console.log('\n🛑 PARADA DELIBERADA antes de Agregar (#A24) y Facturar (#A40).');
  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌ Error:', e.message); process.exit(1); });
