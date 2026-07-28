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
  await page.setViewport({ width: 1280, height: 1000 });
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
  await page.waitForTimeout(3000);

  console.log('➡️ Click en el select2 "Seleccione un Tipo de Pago" (fila del ticket)...');
  const pagoWidgetHandle = await page.evaluateHandle(() => {
    const row = Array.from(document.querySelectorAll('tr')).find(tr => tr.textContent.includes('7540670'));
    if (!row) return null;
    return row.querySelector('.select2, select');
  });
  const pagoWidgetEl = pagoWidgetHandle.asElement();
  if (!pagoWidgetEl) { console.log('❌ No se encontró el widget de pago en la fila'); await browser.close(); process.exit(1); }
  await pagoWidgetEl.click();
  await page.waitForTimeout(800);

  const opcionesPago = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.select2-results__option, li[role="option"], .dropdown-menu li')).map(el => el.textContent.trim())
  );
  console.log('Opciones de pago visibles tras click:', JSON.stringify(opcionesPago, null, 2));

  const opcionHandle = await page.evaluateHandle(() => {
    const opts = Array.from(document.querySelectorAll('.select2-results__option, li[role="option"]'));
    return opts.find(el => /tarjeta de d[eé]bito/i.test(el.textContent)) || null;
  });
  const opcionEl = opcionHandle.asElement();
  if (opcionEl) {
    console.log('➡️ Click en "Tarjeta De Débito"...');
    await opcionEl.click();
    await page.waitForTimeout(800);
  } else {
    console.log('⚠️ No se encontró la opción como .select2-results__option — probando select nativo directo');
    const nativeSelectId = await page.evaluate(() => {
      const row = Array.from(document.querySelectorAll('tr')).find(tr => tr.textContent.includes('7540670'));
      const sel = row ? row.querySelector('select') : null;
      return sel ? sel.id : null;
    });
    console.log('Select nativo en la fila:', nativeSelectId);
    if (nativeSelectId) {
      const val = await page.evaluate((id) => {
        const el = document.getElementById(id);
        const opt = Array.from(el.options).find(o => /tarjeta de d[eé]bito/i.test(o.text));
        return opt ? opt.value : null;
      }, nativeSelectId);
      if (val) await page.select(`#${nativeSelectId}`, val);
    }
  }
  await page.waitForTimeout(500);

  const buf1 = await page.screenshot({ fullPage: true });
  console.log('📸 antes de Facturar Tickets:', await subirArchivoR2(buf1, `debug/oxxogas_v3_antes_facturar_${Date.now()}.png`, 'image/png'));

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
  console.log('📸 resultado:', await subirArchivoR2(buf2, `debug/oxxogas_v3_resultado_${Date.now()}.png`, 'image/png'));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
