require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

async function seleccionarChosenEnFila(page, folio, regexTexto) {
  // El widget "Forma de Pago" de cada fila es un <select> nativo simple
  // (sin decoración Chosen, a diferencia de RFC/Régimen/Uso CFDI) — se
  // ubica y se usa directo con page.select(), sin simular apertura de
  // dropdown alguno.
  const info = await page.evaluate((folio) => {
    const row = Array.from(document.querySelectorAll('tr')).find(tr => tr.textContent.includes(folio));
    if (!row) return { error: 'fila no encontrada' };
    const sel = row.querySelector('select');
    if (!sel) return { error: 'select no encontrado en la fila', rowHTML: row.outerHTML.slice(0, 800) };
    const opt = Array.from(sel.options).find(o => new RegExp('tarjeta de d[eé]bito', 'i').test(o.text));
    return { id: sel.id, name: sel.name, value: opt ? opt.value : null, opciones: Array.from(sel.options).map(o => o.text) };
  }, folio);
  console.log('   info select fila:', JSON.stringify(info));
  if (info.error || !info.name || info.value === null) return { ok: false, motivo: 'no se pudo ubicar el select o la opción', info };

  await page.select(`select[name="${info.name}"]`, info.value);
  await page.waitForTimeout(800);
  // El <select> de la fila puede ser reemplazado por texto estático justo
  // tras seleccionar (la UI ya no lo necesita) — no depender de volver a
  // consultarlo; confirmar por el placeholder "Seleccione un Tipo de Pago"
  // ya no estando presente.
  const siguePlaceholder = await page.evaluate(() => document.body.innerText.includes('Seleccione un Tipo de Pago'));
  return { ok: !siguePlaceholder, siguePlaceholder, valorAsignado: info.value };
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
  await page.waitForTimeout(3500); // espera extra por si aparece el modal de confirmar teléfono/aviso
  const bodyInicial = await page.evaluate(() => document.body.innerText.slice(0, 200));
  const sesionValida = /Hola/i.test(bodyInicial);
  console.log('Status:', resp.status(), '| ¿Sesión válida?:', sesionValida);
  if (!sesionValida) { console.log('❌ Sesión inválida al arrancar.'); await browser.close(); process.exit(2); }

  // Cerrar cualquier modal bloqueante (Aviso Importante / confirmar teléfono) si aparece
  const modalCerrado = await page.evaluate(() => {
    const modal = document.querySelector('.modal.show, .modal.in, .modal[style*="display: block"]');
    if (!modal) return 'sin modal';
    const btn = Array.from(modal.querySelectorAll('button')).find(b => /ahora no|rechazar|cerrar/i.test(b.textContent || ''));
    if (btn) { btn.click(); return 'cerrado: ' + btn.textContent.trim(); }
    return 'modal presente sin botón reconocible';
  });
  console.log('Estado de modal al arrancar:', modalCerrado);
  await page.waitForTimeout(1500);

  let facturarHandle = await page.evaluateHandle(() =>
    Array.from(document.querySelectorAll('a')).find(a => a.textContent.trim() === 'ACCEDER A FACTURAR') || null
  );
  let facturarEl = facturarHandle.asElement();
  if (!facturarEl) {
    console.log('⚠️ No apareció a la primera — reintentando tras 2s más...');
    await page.waitForTimeout(2000);
    facturarHandle = await page.evaluateHandle(() =>
      Array.from(document.querySelectorAll('a')).find(a => a.textContent.trim() === 'ACCEDER A FACTURAR') || null
    );
    facturarEl = facturarHandle.asElement();
  }
  if (!facturarEl) {
    console.log('❌ No se encontró el enlace Facturar tras reintentar.');
    const bufFail = await page.screenshot({ fullPage: true });
    console.log('📸 fallo:', await subirArchivoR2(bufFail, `debug/oxxogas_v2_nofacturar_${Date.now()}.png`, 'image/png'));
    await browser.close();
    process.exit(2);
  }
  await facturarEl.hover();
  await page.waitForTimeout(300);
  await facturarEl.click();
  await page.waitForTimeout(2500);

  let confirmaCarrito = false;
  for (let intento = 1; intento <= 2 && !confirmaCarrito; intento++) {
    console.log(`➡️ Agregando ticket (intento ${intento}): Galerias BJX, folio 7540670, $800.00...`);
    await page.select('#rfc', '2186617');
    await page.waitForTimeout(1200);
    await page.select('#regimen_fiscal', '601');
    await page.waitForTimeout(500);
    await page.select('#usocfdi', 'G03');
    await page.waitForTimeout(500);
    await page.select('#estacion', 'E10482');
    await page.waitForTimeout(500);
    const ticketInput = await page.$('#ticket');
    await ticketInput.hover();
    await ticketInput.click({ clickCount: 3 });
    await page.keyboard.type('7540670', { delay: 30 });
    const montoInput = await page.$('#monto');
    await montoInput.hover();
    await montoInput.click({ clickCount: 3 });
    await page.keyboard.type('800.00', { delay: 30 });
    await page.waitForTimeout(300);
    const agregarBtn = await page.$('#agregar_tickets');
    await agregarBtn.hover();
    await page.waitForTimeout(300);
    await agregarBtn.click();
    await page.waitForTimeout(3500);
    confirmaCarrito = await page.evaluate(() => document.body.innerText.includes('7540670'));
    console.log(`¿Ticket confirmado en el carrito tras intento ${intento}?:`, confirmaCarrito);
  }
  if (!confirmaCarrito) {
    console.log('❌ No se pudo agregar el ticket tras 2 intentos internos.');
    const bufFail2 = await page.screenshot({ fullPage: true });
    console.log('📸 fallo agregar:', await subirArchivoR2(bufFail2, `debug/oxxogas_v2_noagregar_${Date.now()}.png`, 'image/png'));
    await browser.close();
    process.exit(1);
  }

  console.log('➡️ Seleccionando Forma de Pago (Chosen): Tarjeta De Débito...');
  const resultado = await seleccionarChosenEnFila(page, '7540670', 'tarjeta de d[eé]bito');
  console.log('Resultado selección de pago:', JSON.stringify(resultado));

  const buf1 = await page.screenshot({ fullPage: true });
  console.log('📸 antes de Facturar Tickets:', await subirArchivoR2(buf1, `debug/oxxogas_v2_antes_${Date.now()}.png`, 'image/png'));

  if (!resultado.ok) {
    console.log('❌ No se pudo seleccionar forma de pago. No se hará click en Facturar Tickets.');
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
  await page.waitForTimeout(7000);

  const bodyFinal = await page.evaluate(() => document.body.innerText.slice(0, 2500));
  console.log('\nBODY FINAL:\n', bodyFinal);

  const buf2 = await page.screenshot({ fullPage: true });
  console.log('📸 resultado:', await subirArchivoR2(buf2, `debug/oxxogas_v2_resultado_${Date.now()}.png`, 'image/png'));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
