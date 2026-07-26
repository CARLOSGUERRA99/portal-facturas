/**
 * Prueba del fix de "Validar Ticket" OXXO. Llena el form, hace click en el
 * commandLink real (#form:validarTicket) y reporta el resultado de la VALIDACIÓN.
 * NO genera factura ni envía correo — se detiene justo después de validar.
 * Uso: node scripts/test-oxxo-validar.js <folio> <idVenta> <total> <fechaDMY>
 */
require('dotenv').config();
const puppeteer = require('puppeteer');

const URL = 'https://www4.oxxo.com:9443/facturacionElectronica-web/views/layout/inicio.do';
const [,, folio = '464651', venta = '10OBR50ONG2', total = '57.00', fecha = '09/05/2025'] = process.argv;

async function main() {
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}`,
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);

  const posts = [];
  const oxxoResponses = [];
  const consoleErrs = [];
  page.on('request', r => { if (r.method() === 'POST') posts.push(r.url()); });
  page.on('response', async (res) => {
    const u = res.url();
    if (/oxxo\.com/i.test(u) && res.request().method() === 'POST') {
      let body = '';
      try { body = (await res.text()).slice(0, 600); } catch {}
      oxxoResponses.push({ url: u.slice(0, 80), status: res.status(), body });
    }
  });
  page.on('console', m => { if (m.type() === 'error') consoleErrs.push(m.text().slice(0, 120)); });
  page.on('pageerror', e => consoleErrs.push('PAGEERROR: ' + e.message.slice(0, 120)));

  console.log(`🌐 OXXO | folio=${folio} idVenta=${venta} total=${total} fecha=${fecha}`);
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 45000 });
  try {
    await page.waitForSelector('.ui-dialog-titlebar-close', { timeout: 5000 });
    await page.evaluate(() => document.querySelectorAll('.ui-dialog-titlebar-close').forEach(b => b.click()));
    await page.waitForTimeout(500);
  } catch {}

  // Fecha (inyección directa)
  await page.click('#form\\:fecha_input').catch(()=>{});
  await page.waitForTimeout(300);
  await page.evaluate((f) => {
    const i = document.querySelector('#form\\:fecha_input');
    if (i) { i.removeAttribute('readonly'); i.value = f; ['input','change','blur'].forEach(ev => i.dispatchEvent(new Event(ev,{bubbles:true}))); }
  }, fecha);
  await page.keyboard.press('Escape').catch(()=>{});

  for (const [sel, val] of [['folio', folio], ['venta', venta], ['total', total]]) {
    await page.click(`#form\\:${sel}`, { clickCount: 3 }).catch(()=>{});
    await page.type(`#form\\:${sel}`, val, { delay: 40 }).catch(()=>{});
  }
  await page.waitForTimeout(400);

  // Verificar valor real de los campos antes de validar (¿se registraron en JSF?)
  const valores = await page.evaluate(() => ({
    fecha: document.querySelector('#form\\:fecha_input')?.value,
    folio: document.querySelector('#form\\:folio')?.value,
    venta: document.querySelector('#form\\:venta')?.value,
    total: document.querySelector('#form\\:total')?.value,
    onclick: document.querySelector('#form\\:validarTicket')?.getAttribute('onclick')?.slice(0, 250),
  }));
  console.log('   valores en form:', JSON.stringify(valores));

  const postsAntes = posts.length;
  console.log('🖱️  Click en #form:validarTicket (page.click — mouse real) ...');
  // Intento 1: click real de puppeteer (eventos de mouse confiables)
  await page.click('#form\\:validarTicket').catch(async () => {
    // Intento 2: element.click() vía evaluate
    await page.evaluate(() => {
      const link = document.querySelector('#form\\:validarTicket');
      if (link) link.click();
    });
  });
  await page.waitForTimeout(3000);
  console.log(`   POSTs nuevos: ${posts.slice(postsAntes).map(u => u.slice(0,70)).join('\n      ')}`);
  console.log('   Respuestas POST de oxxo.com:');
  for (const r of oxxoResponses) console.log(`      [${r.status}] ${r.url}\n        body: ${r.body.replace(/\s+/g,' ').slice(0,400)}`);

  // ── Réplica EXACTA de la detección nueva del hook validarTicket ──
  await Promise.race([
    page.waitForFunction(() => { const b = document.querySelector('#form\\:continuar'); return b && !b.disabled; }, { timeout: 25000 }),
    page.waitForFunction(() => { const g = document.querySelector('.ui-growl-item .ui-growl-title'); return g && (g.textContent||'').trim().length > 3; }, { timeout: 25000 }),
  ]).catch(() => {});
  await page.waitForTimeout(500);

  const estado = await page.evaluate(() => {
    const cont  = document.querySelector('#form\\:continuar');
    const growl = document.querySelector('.ui-growl-item .ui-growl-title');
    return {
      continuarOk: !!(cont && !cont.disabled),
      growlMsg: growl ? (growl.textContent||'').trim() : '',
    };
  });

  let resultadoValidacion;
  const reason = estado.growlMsg;
  if (estado.continuarOk) resultadoValidacion = 'continuar';
  else if (/facturado previamente|facturado con anterioridad|ya.*facturad/i.test(reason)) resultadoValidacion = 'ya_facturado';
  else if (estado.growlMsg) resultadoValidacion = 'folio_no_disponible';
  else resultadoValidacion = 'timeout (throw)';

  console.log('\n▶️  growl capturado (.ui-growl-title):', estado.growlMsg || '(vacío)');
  console.log('   continuar habilitado:', estado.continuarOk);
  console.log('   ➜ resultadoValidacion =', resultadoValidacion);

  await browser.close();
  console.log('\n✅ Test terminado — NO se generó factura.');
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
