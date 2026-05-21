/**
 * Valida que los selectores de Gasmaz existen en el portal real.
 * Uso: node scripts/validate-selectors-gasmaz.js
 *
 * Abre el portal, verifica selectores de página 1 en vivo,
 * y reporta cuáles de página 2+ requieren flujo para aparecer.
 */
require('dotenv').config();
const puppeteer = require('puppeteer');
const selectors = require('../commerce/gasmaz/selectors.json');
const config    = require('../commerce/gasmaz/config.json');

const OK   = (name, sel) => console.log(`[SELECTOR][OK]   ${name.padEnd(20)} → ${sel}`);
const FAIL = (name, sel, motivo) => console.error(`[SELECTOR][FAIL] ${name.padEnd(20)} → ${sel}  (${motivo})`);
const INFO = (msg) => console.log(`[SELECTOR][INFO] ${msg}`);

// Selectores visibles en página 1 (sin interacción)
const PAGINA_1 = ['referencia', 'folio', 'total', 'rfc', 'btnBuscar'];

// Selectores que aparecen en página 2 (después de btnBuscar con datos válidos)
const PAGINA_2 = ['razonSocial', 'email', 'regimen', 'usoCfdi', 'formaPago'];

// Selectores que aparecen en página 3 (después de facturar)
const PAGINA_3 = ['divDescarga', 'divDocumentos'];

async function verificarSelector(page, name, sel, { visible = true } = {}) {
  if (!sel) {
    INFO(`${name} — selector es null (definido como no aplicable)`);
    return 'null';
  }
  try {
    await page.waitForSelector(sel, { visible, timeout: 5000 });
    OK(name, sel);
    return 'ok';
  } catch {
    // Intentar sin visible (puede estar en DOM pero oculto)
    try {
      const existe = await page.$(sel);
      if (existe) {
        console.warn(`[SELECTOR][WARN] ${name.padEnd(20)} → ${sel}  (existe en DOM pero NO visible)`);
        return 'hidden';
      }
    } catch {}
    FAIL(name, sel, 'no encontrado en DOM');
    return 'fail';
  }
}

async function main() {
  if (!process.env.BROWSERLESS_TOKEN) {
    console.error('❌ BROWSERLESS_TOKEN no configurado en .env');
    process.exit(1);
  }

  console.log('\n══════════════════════════════════════════════');
  console.log('  VALIDADOR DE SELECTORES — GASMAZ');
  console.log(`  Portal: ${config.url_base}`);
  console.log('══════════════════════════════════════════════\n');

  const token = process.env.BROWSERLESS_TOKEN;
  const stealth = config.stealth ? '&stealth=true' : '';
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}${stealth}`,
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(15000);

  const resultados = { ok: 0, fail: 0, hidden: 0, null: 0 };

  try {
    // ── Página 1 ──────────────────────────────────────────────────────────
    console.log(`\n📄 Cargando portal: ${config.url_base}`);
    await page.goto(config.url_base, { waitUntil: 'networkidle2', timeout: 30000 });
    console.log('✅ Portal cargado\n');

    console.log('── Selectores PÁGINA 1 (visibles al cargar) ──');
    for (const name of PAGINA_1) {
      const sel = selectors[name];
      const r = await verificarSelector(page, name, sel);
      resultados[r]++;
    }

    // ── Página 2 (advertencia — no enviamos datos reales) ─────────────────
    console.log('\n── Selectores PÁGINA 2 (requieren flujo — verificación DOM) ──');
    INFO('No se enviarán datos reales. Verificando si existen en DOM (pueden estar ocultos).');
    for (const name of PAGINA_2) {
      const sel = selectors[name];
      const r = await verificarSelector(page, name, sel, { visible: false });
      resultados[r]++;
    }

    // ── Página 3 ──────────────────────────────────────────────────────────
    console.log('\n── Selectores PÁGINA 3 (post-facturación — solo DOM) ──');
    INFO('Estos aparecen solo tras facturar exitosamente.');
    for (const name of PAGINA_3) {
      const sel = selectors[name];
      const r = await verificarSelector(page, name, sel, { visible: false });
      resultados[r]++;
    }

    // ── Selectores null ───────────────────────────────────────────────────
    console.log('\n── Selectores definidos como null ──');
    for (const [name, sel] of Object.entries(selectors)) {
      if (sel === null) {
        INFO(`${name} — null (sin selector fijo, manejado por hook)`);
        resultados['null']++;
      }
    }

    // ── Resumen ───────────────────────────────────────────────────────────
    console.log('\n══════════════════════════════════════════════');
    console.log('  RESUMEN');
    console.log('══════════════════════════════════════════════');
    console.log(`  ✅ OK:      ${resultados.ok}`);
    console.log(`  ⚠️  Ocultos: ${resultados.hidden}  (en DOM pero no visibles — esperado para pág 2/3)`);
    console.log(`  ❌ FAIL:    ${resultados.fail}  ← ESTOS ROMPERÁN EL ENGINE`);
    console.log(`  ➖ Null:    ${resultados.null}  (manejados por hooks)`);

    if (resultados.fail > 0) {
      console.error('\n❌ Hay selectores rotos. Corrígelos en commerce/gasmaz/selectors.json antes de correr el test.');
      process.exit(1);
    } else {
      console.log('\n✅ Todos los selectores de página 1 están OK. Listo para el test completo.');
    }

  } catch (err) {
    console.error('\n💥 Error inesperado:', err.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main();
