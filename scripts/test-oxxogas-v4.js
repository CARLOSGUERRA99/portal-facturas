require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

(async () => {
  const ciSession = process.env.OXXOGAS_CI_SESSION;
  const incapSes117 = process.env.OXXOGAS_INCAP_SES_117;
  const incapSes363 = process.env.OXXOGAS_INCAP_SES_363;
  const visidIncap = process.env.OXXOGAS_VISID_INCAP;
  if (!ciSession) { console.error('❌ Falta OXXOGAS_CI_SESSION'); process.exit(1); }

  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1100 });
  page.on('dialog', async d => { console.log('🔔 Dialog:', d.message()); await d.accept().catch(() => {}); });

  const cookies = [{ name: 'ci_sessions', value: ciSession, domain: 'facturacion.oxxogas.com', path: '/' }];
  if (incapSes117) cookies.push({ name: 'incap_ses_117_3020163', value: incapSes117, domain: '.oxxogas.com', path: '/' });
  if (incapSes363) cookies.push({ name: 'incap_ses_363_3020163', value: incapSes363, domain: '.oxxogas.com', path: '/' });
  if (visidIncap) cookies.push({ name: 'visid_incap_3020163', value: visidIncap, domain: '.oxxogas.com', path: '/' });
  await page.setCookie(...cookies);

  await page.goto('https://facturacion.oxxogas.com/', { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForTimeout(2000);
  const facturarHandle = await page.evaluateHandle(() =>
    Array.from(document.querySelectorAll('a')).find(a => a.textContent.trim() === 'ACCEDER A FACTURAR') || null
  );
  await facturarHandle.asElement().click();
  await page.waitForTimeout(2500);

  const yaEnTabla = await page.evaluate(() => document.body.innerText.includes('7540670'));
  console.log('¿El folio ya está en la tabla de tickets a facturar?:', yaEnTabla);

  if (!yaEnTabla) {
    await page.select('#rfc', '2186617');
    await page.waitForTimeout(1200);
    await page.select('#regimen_fiscal', '601');
    await page.waitForTimeout(500);
    await page.select('#usocfdi', 'G03');
    await page.waitForTimeout(500);
    await page.select('#estacion', 'E10482');
    await page.waitForTimeout(500);
    const ticketInput = await page.$('#ticket');
    await ticketInput.click({ clickCount: 3 });
    await page.keyboard.type('7540670', { delay: 30 });
    const montoInput = await page.$('#monto');
    await montoInput.click({ clickCount: 3 });
    await page.keyboard.type('800.00', { delay: 30 });
    await page.waitForTimeout(300);
    await page.click('#agregar_tickets');
    await page.waitForTimeout(3500);
  }

  const bodyChk = await page.evaluate(() => document.body.innerText);
  console.log('¿Folio en tabla ahora?:', bodyChk.includes('7540670'));

  // Localizar la fila y su select de pago de forma robusta (reintentando la búsqueda)
  let pagoEl = null;
  for (let i = 0; i < 5 && !pagoEl; i++) {
    const h = await page.evaluateHandle(() => {
      const rows = Array.from(document.querySelectorAll('tr'));
      const row = rows.find(tr => tr.textContent.includes('7540670'));
      return row ? row.querySelector('select, .select2, .select2-selection') : null;
    });
    pagoEl = h.asElement();
    if (!pagoEl) await page.waitForTimeout(1000);
  }
  if (!pagoEl) {
    console.log('❌ No se encontró el selector de pago tras varios intentos');
    const buf0 = await page.screenshot({ fullPage: true });
    console.log('📸 debug:', await subirArchivoR2(buf0, `debug/oxxogas_v4_nopago_${Date.now()}.png`, 'image/png'));
    await browser.close();
    process.exit(1);
  }

  console.log('➡️ Click en selector de Tipo de Pago...');
  await pagoEl.click();
  await page.waitForTimeout(1000);

  const opciones = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.select2-results__option, li[role="option"]')).map(el => el.textContent.trim())
  );
  console.log('Opciones visibles:', JSON.stringify(opciones));

  const opcionHandle = await page.evaluateHandle(() => {
    const opts = Array.from(document.querySelectorAll('.select2-results__option, li[role="option"]'));
    return opts.find(el => /tarjeta de d[eé]bito/i.test(el.textContent)) || null;
  });
  const opcionEl = opcionHandle.asElement();
  if (opcionEl) {
    await opcionEl.click();
    await page.waitForTimeout(800);
    console.log('✅ Tipo de pago seleccionado');
  } else {
    console.log('⚠️ No apareció lista select2 — puede que ya sea un <select> nativo simple');
  }

  const buf1 = await page.screenshot({ fullPage: true });
  console.log('📸 antes de Facturar Tickets:', await subirArchivoR2(buf1, `debug/oxxogas_v4_antes_${Date.now()}.png`, 'image/png'));

  console.log('➡️ Click FACTURAR TICKETS (emisión real)...');
  const facturarTicketsHandle = await page.evaluateHandle(() =>
    Array.from(document.querySelectorAll('button')).find(x => /facturar tickets/i.test(x.textContent || '')) || null
  );
  const facturarTicketsEl = facturarTicketsHandle.asElement();
  if (facturarTicketsEl) await facturarTicketsEl.click();
  await page.waitForTimeout(6000);

  const bodyFinal = await page.evaluate(() => document.body.innerText.slice(0, 2500));
  console.log('\nBODY FINAL:\n', bodyFinal);

  const buf2 = await page.screenshot({ fullPage: true });
  console.log('📸 resultado:', await subirArchivoR2(buf2, `debug/oxxogas_v4_resultado_${Date.now()}.png`, 'image/png'));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
