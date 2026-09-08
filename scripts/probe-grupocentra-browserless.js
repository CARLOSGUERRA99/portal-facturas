/**
 * Comprueba si el BLOQUEANTE de Browserless en Grupo Centra sigue vivo.
 *
 * El reconocimiento del 15/08/2026 (ver portales.json → grupocentra) dejó
 * anotado que al elegir la sucursal (#A14) la pestaña de Browserless moría con
 * "Requesting main frame too early" / "Session closed", de forma reproducible.
 * El 08-sep-2026 el flujo completo se hizo a mano en el navegador integrado y
 * funcionó, pero eso NO prueba nada sobre Browserless, que es lo que corre en
 * producción.
 *
 * Esta sonda llega SOLO hasta cargar el consumo. No pulsa "Agregar" ni
 * "Facturar", así que se puede correr las veces que haga falta sin timbrar
 * nada ni gastar un folio.
 *
 * Uso: node scripts/probe-grupocentra-browserless.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const puppeteer = require('puppeteer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Datos del ticket #320, ya facturado: sirven de sonda porque "Cargar" es
// idempotente (solo consulta) y sabemos exactamente qué debe devolver.
const RFC = 'GPR110128QD8';
const ESTACION = '7870';
const FOLIO = '7828808';
const FECHA = '30/08/2026';
const HORA = '20:31';

(async () => {
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}&stealth=true`,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1100 });
  page.on('dialog', async (d) => { console.log('  dialog:', d.message()); await d.accept().catch(() => {}); });
  page.on('error', (e) => console.log('  page error:', e.message));

  const escribir = (id, v) => page.evaluate((i, val) => {
    const e = document.getElementById(i);
    if (!e) return false;
    e.focus(); e.value = val;
    e.dispatchEvent(new Event('input', { bubbles: true }));
    e.dispatchEvent(new Event('change', { bubbles: true }));
    e.blur();
    return true;
  }, id, String(v));

  try {
    console.log('1. Abriendo portal...');
    await page.goto('https://facturacion.grupocentra.mx/Karmi_FacturacionWeb', { waitUntil: 'networkidle2', timeout: 45000 });
    await sleep(3500);

    console.log('2. Facturar GAS (#M16)...');
    await page.evaluate(() => document.getElementById('M16').click());
    await sleep(5500);

    console.log('3. RFC + Buscar...');
    await escribir('A4', RFC);
    await sleep(1200);
    await page.evaluate(() => document.getElementById('A1').click());
    await sleep(7000);
    const razon = await page.evaluate(() => (document.getElementById('A3') || {}).value);
    console.log('   razón social:', razon || '(vacía)');

    console.log('4. ⚠️ EL PASO QUE MATABA LA SESIÓN — Ciudad + Sucursal...');
    const ciudades = await page.evaluate(() => {
      const s = document.getElementById('A15');
      return Array.from(s.options).map((o) => o.text.trim()).filter((t) => t && !/SELECCIONE/i.test(t));
    });
    let sucursal = null, plaza = null;
    for (const c of ciudades) {
      await page.evaluate((nombre) => {
        const s = document.getElementById('A15');
        s.value = Array.from(s.options).find((o) => o.text.trim() === nombre).value;
        s.dispatchEvent(new Event('change', { bubbles: true }));
      }, c);
      await sleep(6000);
      sucursal = await page.evaluate((num) => {
        const s = document.getElementById('A14');
        if (!s) return null;
        const o = Array.from(s.options).find((x) => new RegExp('#' + num + '\\b').test(x.text));
        if (!o) return null;
        s.value = o.value;
        s.dispatchEvent(new Event('change', { bubbles: true }));
        return o.text;
      }, ESTACION);
      if (sucursal) { plaza = c; break; }
      console.log(`   ${c}: sin #${ESTACION}`);
    }
    if (!sucursal) throw new Error(`la estación #${ESTACION} no apareció en ninguna de las ${ciudades.length} plazas`);
    console.log(`   ✅ SOBREVIVIÓ. Plaza: ${plaza} | Sucursal: ${sucursal.slice(0, 55)}`);
    await sleep(6000);

    console.log('5. Cargar consumo (solo consulta, no factura)...');
    await page.evaluate(() => { const g = document.getElementById('A95_1'); if (g && !g.checked) g.click(); });
    await sleep(1500);
    await escribir('A12', FOLIO);
    await escribir('A47', FECHA);
    await escribir('A48', HORA);
    await sleep(1200);
    await page.evaluate(() => document.getElementById('A17').click());
    await sleep(9000);
    const datos = await page.evaluate(() => ({
      comb: (document.getElementById('A18') || {}).value,
      litros: (document.getElementById('A19') || {}).value,
      importe: (document.getElementById('A23') || {}).value,
    }));
    console.log('   consumo:', JSON.stringify(datos));

    console.log('\n' + '='.repeat(60));
    if (datos.importe) {
      console.log('✅ BROWSERLESS AGUANTA TODO EL FLUJO. El bloqueante de agosto ya no aplica.');
    } else {
      console.log('⚠️ Llegó al final sin caerse, pero "Cargar" no devolvió importe.');
      console.log('   (El ticket #320 ya está facturado; puede que por eso no lo devuelva.)');
    }
    console.log('='.repeat(60));
    await browser.close();
    process.exit(0);
  } catch (e) {
    console.log('\n' + '='.repeat(60));
    console.log('❌ FALLÓ:', e.message);
    if (/main frame too early|Session closed|Target closed|detached/i.test(e.message)) {
      console.log('   → Es EL MISMO bloqueante de agosto: Browserless no aguanta este portal.');
      console.log('   → bots/grupocentra.js no sirve en producción tal cual; hay que');
      console.log('     facturar estos tickets a mano o buscar otra vía.');
    }
    console.log('='.repeat(60));
    await browser.close().catch(() => {});
    process.exit(1);
  }
})();
