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
  await page.waitForTimeout(2500);
  // Cerrar el modal de confirmación "Realizado"
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim() === 'Cerrar Ventana');
    if (b) b.click();
  });
  await page.waitForTimeout(1000);

  console.log('➡️ Seleccionando Tipo de Pago: Tarjeta De Débito...');
  const pagoInfo = await page.evaluate(() => {
    const sels = Array.from(document.querySelectorAll('select'));
    const s = sels.find(x => Array.from(x.options).some(o => /tarjeta de d[eé]bito/i.test(o.text)));
    if (!s) return null;
    const opt = Array.from(s.options).find(o => /tarjeta de d[eé]bito/i.test(o.text));
    return { id: s.id, value: opt ? opt.value : null };
  });
  console.log('Select de tipo de pago:', JSON.stringify(pagoInfo));
  if (pagoInfo && pagoInfo.id) {
    await page.select(`#${pagoInfo.id}`, pagoInfo.value);
  }
  await page.waitForTimeout(500);

  const buf1 = await page.screenshot({ fullPage: true });
  console.log('📸 antes de Facturar Tickets:', await subirArchivoR2(buf1, `debug/oxxogas_antes_facturar_final_${Date.now()}.png`, 'image/png'));

  console.log('➡️ Click FACTURAR TICKETS (emisión real)...');
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(x => /facturar tickets/i.test(x.textContent || ''));
    if (b) b.click();
  });
  await page.waitForTimeout(5000);

  const bodyFinal = await page.evaluate(() => document.body.innerText.slice(0, 2000));
  console.log('\nBODY FINAL:\n', bodyFinal);

  const buf2 = await page.screenshot({ fullPage: true });
  console.log('📸 resultado:', await subirArchivoR2(buf2, `debug/oxxogas_resultado_final_${Date.now()}.png`, 'image/png'));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
