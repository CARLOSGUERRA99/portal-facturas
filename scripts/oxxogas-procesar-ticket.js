require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');
const { extraerUUIDcfdi } = require('../lib/util');

// Uso: node scripts/oxxogas-procesar-ticket.js <estacionId> <folio> <monto> <formaPago>
// formaPago: DEBITO | EFECTIVO
const [, , estacionId, folio, monto, formaPago = 'DEBITO'] = process.argv;
if (!estacionId || !folio || !monto) {
  console.error('Uso: node oxxogas-procesar-ticket.js <estacionId> <folio> <monto> [DEBITO|EFECTIVO]');
  process.exit(1);
}

async function seleccionarPagoEnFila(page, folio, regexTexto) {
  const info = await page.evaluate(({ folio, regexTexto }) => {
    const row = Array.from(document.querySelectorAll('tr')).find(tr => tr.textContent.includes(folio));
    if (!row) return { error: 'fila no encontrada' };
    const sel = row.querySelector('select');
    if (!sel) return { error: 'select no encontrado en la fila' };
    const opt = Array.from(sel.options).find(o => new RegExp(regexTexto, 'i').test(o.text));
    return { name: sel.name, value: opt ? opt.value : null };
  }, { folio, regexTexto });
  if (info.error || !info.name || info.value === null) return { ok: false, motivo: 'no se pudo ubicar el select o la opción', info };

  await page.select(`select[name="${info.name}"]`, info.value);
  await page.waitForTimeout(800);
  const siguePlaceholder = await page.evaluate(() => document.body.innerText.includes('Seleccione un Tipo de Pago'));
  return { ok: !siguePlaceholder };
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

  let ultimaRespuestaTickets = null;
  page.on('response', async (r) => {
    if (r.url().includes('/facturacion/facturar/tickets')) {
      try { ultimaRespuestaTickets = await r.json(); } catch (e) { ultimaRespuestaTickets = { parseError: e.message }; }
    }
  });

  const resp = await page.goto('https://facturacion.oxxogas.com/', { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForTimeout(3000);
  const bodyInicial = await page.evaluate(() => document.body.innerText.slice(0, 200));
  if (!/Hola/i.test(bodyInicial)) { console.log('❌ Sesión inválida.'); await browser.close(); process.exit(2); }
  console.log('Status:', resp.status(), '| Sesión válida: true');

  let facturarHandle = await page.evaluateHandle(() =>
    Array.from(document.querySelectorAll('a')).find(a => a.textContent.trim() === 'ACCEDER A FACTURAR') || null
  );
  let facturarEl = facturarHandle.asElement();
  if (!facturarEl) {
    await page.waitForTimeout(2500);
    facturarHandle = await page.evaluateHandle(() =>
      Array.from(document.querySelectorAll('a')).find(a => a.textContent.trim() === 'ACCEDER A FACTURAR') || null
    );
    facturarEl = facturarHandle.asElement();
  }
  if (!facturarEl) { console.log('❌ No se encontró el enlace Facturar'); await browser.close(); process.exit(2); }
  await facturarEl.click();
  await page.waitForTimeout(2500);

  console.log(`➡️ Agregando ticket: Estación ${estacionId}, Folio ${folio}, Monto ${monto}...`);
  let enCarrito = false;
  for (let intento = 1; intento <= 2 && !enCarrito; intento++) {
    await page.select('#rfc', '2186617');
    await page.waitForTimeout(1200);
    await page.select('#regimen_fiscal', '601');
    await page.waitForTimeout(500);
    await page.select('#usocfdi', 'G03');
    await page.waitForTimeout(500);
    await page.select('#estacion', estacionId);
    await page.waitForTimeout(500);
    const ticketInput = await page.$('#ticket');
    await ticketInput.click({ clickCount: 3 });
    await page.keyboard.type(String(folio), { delay: 30 });
    const montoInput = await page.$('#monto');
    await montoInput.click({ clickCount: 3 });
    await page.keyboard.type(Number(monto).toFixed(2), { delay: 30 });
    await page.waitForTimeout(300);
    ultimaRespuestaTickets = null;
    await page.click('#agregar_tickets');
    await page.waitForTimeout(5000);
    enCarrito = await page.evaluate((folio) => document.body.innerText.includes(String(folio)), folio);
    console.log(`¿En carrito tras intento ${intento}?:`, enCarrito, '| Respuesta real del servidor:', JSON.stringify(ultimaRespuestaTickets));
    if (ultimaRespuestaTickets && ultimaRespuestaTickets.success === undefined) {
      console.log('❌ El servidor rechazó el ticket (respuesta sin "success") — no reintentar, es un error de validación real.');
      break;
    }
  }
  if (!enCarrito) {
    console.log('❌ No se pudo agregar el ticket.');
    const bufX = await page.screenshot({ fullPage: true });
    console.log('📸', await subirArchivoR2(bufX, `debug/oxxogas_${folio}_noagregar_${Date.now()}.png`, 'image/png'));
    await browser.close();
    process.exit(1);
  }

  console.log(`➡️ Seleccionando Forma de Pago: ${formaPago}...`);
  const regexPago = formaPago === 'EFECTIVO' ? '^efectivo$' : 'tarjeta de d[eé]bito';
  const pago = await seleccionarPagoEnFila(page, String(folio), regexPago);
  console.log('Resultado pago:', JSON.stringify(pago));
  if (!pago.ok) {
    console.log('❌ No se pudo seleccionar forma de pago.');
    const bufY = await page.screenshot({ fullPage: true });
    console.log('📸', await subirArchivoR2(bufY, `debug/oxxogas_${folio}_nopago_${Date.now()}.png`, 'image/png'));
    await browser.close();
    process.exit(1);
  }

  const buf1 = await page.screenshot({ fullPage: true });
  console.log('📸 antes de Facturar:', await subirArchivoR2(buf1, `debug/oxxogas_${folio}_antes_${Date.now()}.png`, 'image/png'));

  console.log('➡️ Click FACTURAR TICKETS (emisión real)...');
  const facturarTicketsHandle = await page.evaluateHandle(() =>
    Array.from(document.querySelectorAll('button')).find(x => /facturar tickets/i.test(x.textContent || '')) || null
  );
  const facturarTicketsEl = facturarTicketsHandle.asElement();
  if (!facturarTicketsEl) { console.log('❌ No se encontró el botón Facturar Tickets'); await browser.close(); process.exit(1); }
  await facturarTicketsEl.click();
  await page.waitForTimeout(7000);

  const carritoVacio = await page.evaluate(() => document.body.innerText.includes('No tiene agregado ningún Ticket'));
  console.log('¿Carrito vacío tras Facturar (señal de éxito)?:', carritoVacio);

  const buf2 = await page.screenshot({ fullPage: true });
  console.log('📸 resultado:', await subirArchivoR2(buf2, `debug/oxxogas_${folio}_resultado_${Date.now()}.png`, 'image/png'));

  if (!carritoVacio) {
    const bodyFinal = await page.evaluate(() => document.body.innerText.slice(0, 1500));
    console.log('BODY FINAL (posible error):\n', bodyFinal);
    await browser.close();
    process.exit(1);
  }

  // Ir a Mis Facturas y ubicar la fila más reciente para este monto
  console.log('➡️ Verificando en Mis Facturas...');
  const misFacturasHandle = await page.evaluateHandle(() =>
    Array.from(document.querySelectorAll('a')).find(a => a.textContent.trim() === 'ACCEDER A MIS FACTURAS') || null
  );
  await misFacturasHandle.asElement().click();
  await page.waitForTimeout(3000);

  const montoBuscar = Number(monto).toFixed(2).replace(/\.00$/, '');
  const xmlHref = await page.evaluate((montoBuscar) => {
    const rows = Array.from(document.querySelectorAll('tr'));
    const row = rows.find(tr => tr.textContent.includes(montoBuscar));
    if (!row) return null;
    const a = Array.from(row.querySelectorAll('a')).find(a => /\/xml\//.test(a.href));
    return a ? a.href : null;
  }, montoBuscar);
  console.log('Link XML encontrado en Mis Facturas:', xmlHref);

  if (!xmlHref) {
    console.log('⚠️ No se pudo ubicar la factura en Mis Facturas automáticamente (puede requerir revisión manual).');
    await browser.close();
    process.exit(1);
  }

  const uuid = xmlHref.split('/').pop();
  const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  const xmlResp = await fetch(`https://facturacion.oxxogas.com/facturacion/facturas/xml/${uuid}`, { headers: { Cookie: cookieHeader } });
  const pdfResp = await fetch(`https://facturacion.oxxogas.com/facturacion/facturas/pdf/${uuid}`, { headers: { Cookie: cookieHeader } });
  const xmlBuffer = xmlResp.ok ? Buffer.from(await xmlResp.arrayBuffer()) : null;
  const pdfBuffer = pdfResp.ok ? Buffer.from(await pdfResp.arrayBuffer()) : null;

  if (!xmlBuffer) { console.log('❌ No se pudo descargar el XML real'); await browser.close(); process.exit(1); }

  const uuidReal = extraerUUIDcfdi(xmlBuffer) || uuid;
  const xml = xmlBuffer.toString('utf8');
  const total = (xml.match(/<(?:cfdi:)?Comprobante\b[^>]*\sTotal="([\d.]+)"/i) || [])[1];
  const rfcReceptor = (xml.match(/<(?:cfdi:)?Receptor[^>]*\sRfc="([^"]+)"/i) || [])[1];
  console.log('\n=== CFDI REAL ===');
  console.log('UUID:', uuidReal, '| Total:', total, '| RFC Receptor:', rfcReceptor);

  const xmlUrl = await subirArchivoR2(xmlBuffer, `facturas/oxxogas_${uuidReal}.xml`, 'application/xml');
  const pdfUrl = pdfBuffer ? await subirArchivoR2(pdfBuffer, `facturas/oxxogas_${uuidReal}.pdf`, 'application/pdf') : null;
  console.log('☁️ XML:', xmlUrl);
  console.log('☁️ PDF:', pdfUrl);

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
