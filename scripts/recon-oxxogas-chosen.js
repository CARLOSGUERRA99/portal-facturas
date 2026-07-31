// Reconocimiento del widget que decora #rfc en el formulario de OXXO GAS.
// Hipótesis a comprobar: page.select() nativo no notifica a Chosen/Angular, por
// eso el AJAX que puebla #regimen_fiscal nunca se dispara.
require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const cookies = [{ name: 'ci_sessions', value: process.env.OXXOGAS_CI_SESSION, domain: 'facturacion.oxxogas.com', path: '/' }];
  for (const [n, v] of [
    ['incap_ses_363_3020163', process.env.OXXOGAS_INCAP_SES_363],
    ['incap_ses_396_3020163', process.env.OXXOGAS_INCAP_SES_396],
  ]) { if (v) cookies.push({ name: n, value: v, domain: '.oxxogas.com', path: '/' }); }

  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}&stealth=true`,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('dialog', async (d) => { console.log('🔔', d.message()); await d.accept().catch(() => {}); });
  page.on('request', (r) => { if (/regimen|rfc|catalogo/i.test(r.url()) && r.url().includes('oxxogas')) console.log('   📤', r.method(), r.url().slice(0, 110)); });
  await page.setCookie(...cookies);

  await page.goto('https://facturacion.oxxogas.com/facturacion/facturar', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('#rfc', { timeout: 15000 });

  const info = await page.evaluate(() => {
    const r = document.querySelector('#rfc');
    const g = document.querySelector('#regimen_fiscal');
    const chosenIds = Array.from(document.querySelectorAll('.chosen-container')).map((c) => c.id || c.className);
    return {
      libs: { jquery: !!(window.jQuery || window.$), chosen: !!(window.jQuery && window.jQuery.fn && window.jQuery.fn.chosen), angular: !!window.angular },
      rfc: { tag: r.tagName, multiple: r.multiple, clases: r.className, oculto: getComputedStyle(r).display, padre: r.parentElement.className, ngModel: r.getAttribute('ng-model'), onchange: r.getAttribute('onchange'), opciones: r.options.length },
      regimen: { opciones: g ? g.options.length : null, clases: g ? g.className : null, ngModel: g ? g.getAttribute('ng-model') : null },
      chosenContainers: chosenIds,
      hermanoDeRfc: r.nextElementSibling ? r.nextElementSibling.className : null,
    };
  });
  console.log('=== ESTRUCTURA ===');
  console.log(JSON.stringify(info, null, 1));

  // Prueba A: seleccionar con page.select() nativo y ver si #regimen_fiscal se puebla.
  const val = await page.evaluate(() => {
    const o = Array.from(document.querySelector('#rfc').options).find((x) => x.text.includes('GPR110128QD8'));
    return o ? o.value : null;
  });
  console.log(`\n=== PRUEBA A: page.select('#rfc','${val}') ===`);
  await page.select('#rfc', val);
  await dormir(4000);
  console.log('   opciones en #regimen_fiscal:', await page.evaluate(() => document.querySelector('#regimen_fiscal')?.options.length));

  // Prueba B: notificar por jQuery (change + chosen:updated) y ver si reacciona.
  console.log('\n=== PRUEBA B: jQuery trigger change/chosen:updated ===');
  await page.evaluate((v) => {
    const $ = window.jQuery || window.$;
    const el = document.querySelector('#rfc');
    el.value = v;
    if ($) $(el).val(v).trigger('chosen:updated').trigger('change');
    else el.dispatchEvent(new Event('change', { bubbles: true }));
  }, val);
  await dormir(4000);
  console.log('   opciones en #regimen_fiscal:', await page.evaluate(() => document.querySelector('#regimen_fiscal')?.options.length));

  // Prueba C: clic sintético REAL sobre el widget Chosen.
  console.log('\n=== PRUEBA C: clic sintético sobre el widget ===');
  const cont = await page.$('#rfc_chosen') || await page.$('.chosen-container');
  if (cont) {
    await cont.click();
    await dormir(1200);
    const items = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.chosen-results li')).map((li) => ({ t: li.textContent.trim().slice(0, 40), c: li.className }))
    );
    console.log('   opciones visibles en el dropdown:', JSON.stringify(items.slice(0, 8)));
    const h = await page.evaluateHandle(() =>
      Array.from(document.querySelectorAll('.chosen-results li')).find((li) => li.textContent.includes('GPR110128QD8')) || null
    );
    const el = h.asElement();
    if (el) { await el.click(); await dormir(4000); }
    console.log('   tras clic → opciones en #regimen_fiscal:', await page.evaluate(() => document.querySelector('#regimen_fiscal')?.options.length));
    console.log('   valor de #rfc:', await page.evaluate(() => document.querySelector('#rfc')?.value));
  } else {
    console.log('   ❌ no hay contenedor .chosen-container');
  }

  console.log('📸', await subirArchivoR2(await page.screenshot(), `debug/oxxogas_chosen_recon_${Date.now()}.png`, 'image/png'));
  await browser.close();
  process.exit(0);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
