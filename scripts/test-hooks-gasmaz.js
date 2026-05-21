/**
 * Prueba hooks individuales de Gasmaz en aislamiento.
 * Uso: node scripts/test-hooks-gasmaz.js <hook>
 *
 * Hooks disponibles:
 *   seleccionarRegimen   — requiere estar en página 2 (llena folio+rfc primero)
 *   seleccionarCfdi      — requiere que regimen ya esté seleccionado
 *   seleccionarFormaPago — requiere estar en página 2
 *   clickFacturar        — requiere que todos los campos estén llenos
 *   descargarArchivos    — requiere estar en pantalla de descarga (post-facturar)
 *
 * Ejemplos:
 *   RFC="TU_RFC" FOLIO="12345" TOTAL="500.00" node scripts/test-hooks-gasmaz.js seleccionarRegimen
 *   RFC="TU_RFC" FOLIO="12345" TOTAL="500.00" node scripts/test-hooks-gasmaz.js descargarArchivos
 */
require('dotenv').config();
const puppeteer = require('puppeteer');
const path = require('path');
const { buildContext } = require('../engine/runner');
const config    = require('../commerce/gasmaz/config.json');
const selectors = require('../commerce/gasmaz/selectors.json');
const hooks     = require('../commerce/gasmaz/hooks');

const HOOK = process.argv[2];
const HOOKS_DISPONIBLES = Object.keys(hooks);

const PAYLOAD = {
  portal:        'gasmaz',
  ticketId:      'HOOKTEST-' + Date.now(),
  folio:         process.env.FOLIO          || 'REEMPLAZAR',
  total:         process.env.TOTAL          || 'REEMPLAZAR',
  fecha:         process.env.FECHA          || new Date().toISOString().split('T')[0],
  rfc:           process.env.RFC            || 'REEMPLAZAR',
  razonSocial:   process.env.RAZON_SOCIAL   || 'PRUEBA SA DE CV',
  regimenFiscal: process.env.REGIMEN        || '626',
  usoCfdi:       process.env.USO_CFDI       || 'G03',
  codigoPostal:  process.env.CP             || '80140',
  portalUrl:     process.env.PORTAL_URL     || null,
};

// Qué pasos ejecutar antes del hook para llegar al estado correcto
const SETUP = {
  seleccionarRegimen:   'pagina2',
  seleccionarCfdi:      'pagina2_con_regimen',
  seleccionarFormaPago: 'pagina2',
  clickFacturar:        'pagina2_completa',
  descargarArchivos:    'manual', // requiere que ya estés en pantalla de descarga
  descargarExistente:   'manual',
};

async function irAPagina1(page, url) {
  console.log(`\n→ Navegando a ${url}`);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForSelector(selectors.referencia, { visible: true, timeout: 15000 });
  console.log('✅ Página 1 cargada');
}

async function llenarPagina1YAvanzar(page, ctx) {
  const fill = async (sel, val) => {
    await page.waitForSelector(sel, { visible: true });
    await page.click(sel);
    await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
    await page.keyboard.press('Delete');
    await page.keyboard.type(String(val), { delay: 50 });
  };

  console.log('→ Llenando página 1...');
  await fill(selectors.referencia, ctx.folio);
  await fill(selectors.folio,      ctx.folio);
  await fill(selectors.total,      ctx.totalDecimal);
  await fill(selectors.rfc,        ctx.rfc);
  console.log('→ Click Buscar...');
  await page.click(selectors.btnBuscar);

  console.log('→ Esperando página 2 (campo razonSocial)...');
  await page.waitForSelector(selectors.razonSocial, { visible: true, timeout: 20000 });
  console.log('✅ Página 2 lista');
}

async function llenarPagina2Base(page, ctx) {
  const fill = async (sel, val) => {
    await page.waitForSelector(sel, { visible: true });
    await page.click(sel);
    await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
    await page.keyboard.press('Delete');
    await page.keyboard.type(String(val), { delay: 50 });
  };
  await fill(selectors.razonSocial, ctx.razonSocial);
  await fill(selectors.email, ctx.email);
  console.log('✅ razonSocial + email llenados');
}

async function main() {
  if (!HOOK) {
    console.error(`\n❌ Especifica el hook a probar.\n`);
    console.error(`Uso: node scripts/test-hooks-gasmaz.js <hook>\n`);
    console.error(`Hooks disponibles:\n  ${HOOKS_DISPONIBLES.join('\n  ')}\n`);
    process.exit(1);
  }
  if (!hooks[HOOK]) {
    console.error(`\n❌ Hook "${HOOK}" no existe en commerce/gasmaz/hooks.js`);
    console.error(`Disponibles: ${HOOKS_DISPONIBLES.join(', ')}\n`);
    process.exit(1);
  }
  if (!process.env.BROWSERLESS_TOKEN) {
    console.error('❌ BROWSERLESS_TOKEN no configurado'); process.exit(1);
  }
  if (PAYLOAD.folio === 'REEMPLAZAR' || PAYLOAD.rfc === 'REEMPLAZAR') {
    console.error('❌ Configura RFC, FOLIO y TOTAL antes de correr hooks');
    console.error('   RFC="X" FOLIO="Y" TOTAL="Z" node scripts/test-hooks-gasmaz.js ' + HOOK);
    process.exit(1);
  }

  console.log(`\n══════════════════════════════════════════════`);
  console.log(`  TEST HOOK AISLADO: ${HOOK}`);
  console.log(`  Setup requerido:   ${SETUP[HOOK] || 'ninguno'}`);
  console.log(`══════════════════════════════════════════════\n`);

  const ctx = buildContext(PAYLOAD, config, selectors);

  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true`,
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);

  try {
    const setup = SETUP[HOOK];

    if (setup === 'manual') {
      console.log('⚠️  Este hook requiere estar en la pantalla correcta manualmente.');
      console.log('   No se puede navegar automáticamente hasta ese punto.');
      console.log('   Usa el test completo (test-gasmaz.js) para llegar ahí.');
      await browser.close();
      process.exit(0);
    }

    // Navegar y preparar el estado necesario
    await irAPagina1(page, ctx.url);

    if (['pagina2', 'pagina2_con_regimen', 'pagina2_completa'].includes(setup)) {
      await llenarPagina1YAvanzar(page, ctx);
    }
    if (['pagina2_con_regimen', 'pagina2_completa'].includes(setup)) {
      await llenarPagina2Base(page, ctx);
      console.log('→ Ejecutando seleccionarRegimen primero (prerequisito)...');
      await hooks.seleccionarRegimen(page, ctx);
      console.log('✅ Régimen seleccionado');
    }
    if (setup === 'pagina2_completa') {
      console.log('→ Ejecutando seleccionarCfdi (prerequisito)...');
      await hooks.seleccionarCfdi(page, ctx);
      console.log('✅ CFDI seleccionado');
      await hooks.seleccionarFormaPago(page, ctx);
      console.log('✅ Forma de pago seleccionada');
    }

    // ── Ejecutar el hook pedido ──────────────────────────────────────────
    console.log(`\n🔧 Ejecutando hook: ${HOOK}()\n`);
    const t0 = Date.now();
    const resultado = await hooks[HOOK](page, ctx);
    const ms = Date.now() - t0;

    console.log(`\n══════════════════════════════════════════════`);
    console.log(`  RESULTADO (${ms}ms)`);
    console.log(`══════════════════════════════════════════════`);
    if (resultado) {
      console.log(JSON.stringify(resultado, null, 2));
    } else {
      console.log('(hook retornó void — continuaría al siguiente step del flow)');
    }

  } catch (err) {
    console.error(`\n❌ Error en hook "${HOOK}": ${err.message}`);
    console.error(err.stack);
    // Screenshot de error
    try {
      const buf = await page.screenshot({ fullPage: false });
      const { subirArchivoR2 } = require('../storage/r2');
      const key = `debug/gasmaz_HOOKTEST_${HOOK}_ERROR_${Date.now()}.png`;
      const url = await subirArchivoR2(buf, key, 'image/png');
      console.error(`📸 Screenshot de error: ${url}`);
    } catch {}
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main();
