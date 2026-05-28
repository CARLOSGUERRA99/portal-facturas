/**
 * Inspecciona un portal de facturación y extrae:
 *  - Título de la página
 *  - Todos los inputs con sus atributos
 *  - Todos los selects con sus opciones
 *  - Todos los botones
 *  - Tecnología detectada
 *
 * Uso: node scripts/inspect-portal.js <URL> [wait_ms]
 * Ejemplo: node scripts/inspect-portal.js https://autozone.cdc.origon.cloud/facturacion/autozone 5000
 */

require('dotenv').config();
const puppeteer = require('puppeteer');

const url    = process.argv[2];
const waitMs = parseInt(process.argv[3] || '4000');

if (!url) {
  console.error('❌ Uso: node scripts/inspect-portal.js <URL> [wait_ms]');
  process.exit(1);
}

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) { console.error('❌ BROWSERLESS_TOKEN no definido'); process.exit(1); }

  console.log(`🌐 Inspeccionando: ${url}`);
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true`,
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8' });

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
  } catch (e) {
    console.log('⚠️ goto error (continuando):', e.message);
  }
  await page.waitForTimeout(waitMs);

  const info = await page.evaluate(() => {
    // Tecnología
    const tech = [];
    if (window.ng || document.querySelector('[ng-app],[ng-controller],[data-ng-app]')) tech.push('AngularJS');
    if (window.angular && window.angular.version?.major >= 2) tech.push('Angular2+');
    if (window.__NEXT_DATA__) tech.push('Next.js');
    if (window.React || document.querySelector('[data-reactroot]')) tech.push('React');
    if (window.Vue) tech.push('Vue');
    if (window.$ && window.$.fn?.jquery) tech.push(`jQuery ${window.$.fn.jquery}`);
    if (document.querySelector('form[id*="form"][id*=":"]')) tech.push('PrimeFaces/JSF');
    if (document.querySelector('.ui-widget')) tech.push('jQuery UI');
    if (document.querySelector('.MuiButton-root')) tech.push('Material UI');
    if (document.querySelector('[class*="angular"]')) tech.push('Angular (class hint)');

    // Título
    const title = document.title;
    const h1 = document.querySelector('h1')?.innerText || '';
    const bodyText = document.body?.innerText?.substring(0, 500) || '';

    // Inputs
    const inputs = Array.from(document.querySelectorAll('input')).map(el => ({
      id: el.id,
      name: el.name,
      type: el.type,
      placeholder: el.placeholder,
      value: el.value?.substring(0, 50),
      class: el.className?.substring(0, 80),
      'aria-label': el.getAttribute('aria-label'),
      'ng-model': el.getAttribute('ng-model'),
      'formcontrolname': el.getAttribute('formcontrolname'),
      visible: el.offsetParent !== null,
      disabled: el.disabled,
      required: el.required,
    }));

    // Selects
    const selects = Array.from(document.querySelectorAll('select')).map(el => ({
      id: el.id,
      name: el.name,
      class: el.className?.substring(0, 60),
      options: Array.from(el.options).map(o => `${o.value}: ${o.text.trim()}`).slice(0, 15),
    }));

    // Botones
    const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], a.btn, a[class*="button"]')).map(el => ({
      tag: el.tagName,
      id: el.id,
      type: el.type,
      text: (el.textContent || el.value || '').trim().substring(0, 60),
      class: el.className?.substring(0, 80),
      href: el.href?.substring(0, 100) || null,
      disabled: el.disabled,
      visible: el.offsetParent !== null,
    }));

    // Labels
    const labels = Array.from(document.querySelectorAll('label')).map(el => ({
      for: el.htmlFor,
      text: el.innerText?.trim().substring(0, 60),
    }));

    // Forms
    const forms = Array.from(document.querySelectorAll('form')).map(el => ({
      id: el.id,
      action: el.action?.substring(0, 100),
      method: el.method,
      class: el.className?.substring(0, 60),
    }));

    return { title, h1, bodyText, tech, inputs, selects, buttons, labels, forms };
  });

  console.log('\n========== PORTAL INSPECTION ==========');
  console.log(`📋 Título: ${info.title}`);
  console.log(`📋 H1: ${info.h1}`);
  console.log(`🔧 Tecnología: ${info.tech.join(', ') || 'No detectada'}`);
  console.log(`📄 Body (primeros 500 chars):\n${info.bodyText}`);

  console.log(`\n📝 Inputs (${info.inputs.length}):`);
  info.inputs.forEach((inp, i) => {
    console.log(`  [${i}] id="${inp.id}" name="${inp.name}" type="${inp.type}" placeholder="${inp.placeholder}" ` +
      `fc="${inp.formcontrolname}" ng="${inp['ng-model']}" visible=${inp.visible} disabled=${inp.disabled}`);
  });

  console.log(`\n🔽 Selects (${info.selects.length}):`);
  info.selects.forEach((sel, i) => {
    console.log(`  [${i}] id="${sel.id}" name="${sel.name}"`);
    sel.options.forEach(o => console.log(`       - ${o}`));
  });

  console.log(`\n🏷️ Labels (${info.labels.length}):`);
  info.labels.forEach((lbl, i) => {
    console.log(`  [${i}] for="${lbl.for}" text="${lbl.text}"`);
  });

  console.log(`\n🖱️ Botones (${info.buttons.length}):`);
  info.buttons.forEach((btn, i) => {
    console.log(`  [${i}] <${btn.tag}> id="${btn.id}" text="${btn.text}" visible=${btn.visible} disabled=${btn.disabled}`);
  });

  console.log(`\n📋 Forms (${info.forms.length}):`);
  info.forms.forEach((f, i) => {
    console.log(`  [${i}] id="${f.id}" action="${f.action}" method="${f.method}"`);
  });

  // Screenshot
  const { subirArchivoR2 } = require('../storage/r2');
  const buf = await page.screenshot({ fullPage: true });
  const slug = url.replace(/[^a-z0-9]/gi, '_').substring(0, 40);
  const r2url = await subirArchivoR2(buf, `debug/inspect_${slug}_${Date.now()}.png`, 'image/png').catch(() => null);
  console.log(`\n📸 Screenshot: ${r2url || '(error subiendo)'}`);

  await browser.close();
  console.log('\n✅ Listo');
})();
