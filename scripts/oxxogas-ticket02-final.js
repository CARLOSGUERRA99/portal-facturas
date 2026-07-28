require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

async function seleccionarPagoEnFila(page, folio, textoOpcion) {
  for (let intento = 0; intento < 4; intento++) {
    const widgetHandle = await page.evaluateHandle((folio) => {
      const row = Array.from(document.querySelectorAll('tr')).find(tr => tr.textContent.includes(folio));
      if (!row) return null;
      return row.querySelector('.select2-selection, .select2, select');
    }, folio);
    const widgetEl = widgetHandle.asElement();
    if (widgetEl) {
      await widgetEl.click();
      await page.waitForTimeout(900);
      const opcionHandle = await page.evaluateHandle((textoOpcion) => {
        const opts = Array.from(document.querySelectorAll('.select2-results__option, li[role="option"]'));
        return opts.find(el => new RegExp(textoOpcion, 'i').test(el.textContent)) || null;
      }, textoOpcion);
      const opcionEl = opcionHandle.asElement();
      if (opcionEl) {
        await opcionEl.click();
        await page.waitForTimeout(700);
        return true;
      }
    }
    await page.waitForTimeout(1200);
  }
  return false;
}

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

  const resp = await page.goto('https://facturacion.oxxogas.com/', { waitUntil: 'networkidle2', timeout: 30000 });
  const bodyInicial = await page.evaluate(() => document.body.innerText.slice(0, 200));
  const sesionValida = !/iniciar sesi[oó]n/i.test(bodyInicial) || /Hola/i.test(bodyInicial);
  console.log('Status:', resp.status(), '| ¿Sesión válida?:', sesionValida);
  if (!sesionValida) {
    console.log('❌ La sesión ya no es válida al arrancar. Abortando.');
    await browser.close();
    process.exit(2);
  }

  const facturarHandle = await page.evaluateHandle(() =>
    Array.from(document.querySelectorAll('a')).find(a => a.textContent.trim() === 'ACCEDER A FACTURAR') || null
  );
  const facturarEl = facturarHandle.asElement();
  if (!facturarEl) { console.log('❌ No se encontró el enlace Facturar (posible bloqueo)'); await browser.close(); process.exit(2); }
  await facturarEl.click();
  await page.waitForTimeout(2500);

  const yaEnCarrito = await page.evaluate(() => document.body.innerText.includes('7540670'));
  console.log('¿Ticket ya en el carrito?:', yaEnCarrito);

  if (!yaEnCarrito) {
    console.log('➡️ Re-agregando el ticket desde cero...');
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

  const confirmaCarrito = await page.evaluate(() => document.body.innerText.includes('7540670'));
  console.log('¿Ticket confirmado en el carrito?:', confirmaCarrito);
  if (!confirmaCarrito) {
    console.log('❌ No se pudo agregar/confirmar el ticket en el carrito.');
    const bufX = await page.screenshot({ fullPage: true });
    console.log('📸', await subirArchivoR2(bufX, `debug/oxxogas_t02_falla_carrito_${Date.now()}.png`, 'image/png'));
    await browser.close();
    process.exit(1);
  }

  console.log('➡️ Seleccionando Forma de Pago: Tarjeta De Débito...');
  const pagoOk = await seleccionarPagoEnFila(page, '7540670', 'tarjeta de d[eé]bito');
  console.log('¿Forma de pago seleccionada?:', pagoOk);

  const buf1 = await page.screenshot({ fullPage: true });
  console.log('📸 antes de Facturar Tickets:', await subirArchivoR2(buf1, `debug/oxxogas_t02_antes_${Date.now()}.png`, 'image/png'));

  if (!pagoOk) {
    console.log('❌ No se pudo seleccionar la forma de pago. No se hará click en Facturar Tickets.');
    await browser.close();
    process.exit(1);
  }

  console.log('➡️ Click FACTURAR TICKETS (emisión real)...');
  const facturarTicketsHandle = await page.evaluateHandle(() =>
    Array.from(document.querySelectorAll('button')).find(x => /facturar tickets/i.test(x.textContent || '')) || null
  );
  const facturarTicketsEl = facturarTicketsHandle.asElement();
  if (!facturarTicketsEl) { console.log('❌ No se encontró el botón Facturar Tickets'); await browser.close(); process.exit(1); }
  await facturarTicketsEl.click();
  await page.waitForTimeout(6000);

  const bodyFinal = await page.evaluate(() => document.body.innerText.slice(0, 2500));
  console.log('\nBODY FINAL:\n', bodyFinal);

  const buf2 = await page.screenshot({ fullPage: true });
  console.log('📸 resultado:', await subirArchivoR2(buf2, `debug/oxxogas_t02_resultado_${Date.now()}.png`, 'image/png'));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
