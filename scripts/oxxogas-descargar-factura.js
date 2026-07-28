require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

(async () => {
  const ciSession = process.env.OXXOGAS_CI_SESSION;
  const incapSes117 = process.env.OXXOGAS_INCAP_SES_117;
  const incapSes363 = process.env.OXXOGAS_INCAP_SES_363;
  const visidIncap = process.env.OXXOGAS_VISID_INCAP;
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  const archivosCapturados = [];
  page.on('response', async (resp) => {
    const ct = resp.headers()['content-type'] || '';
    const disp = resp.headers()['content-disposition'] || '';
    if (/xml|pdf/i.test(ct) || /attachment/i.test(disp)) {
      try {
        const buf = await resp.buffer();
        archivosCapturados.push({ url: resp.url(), ct, disp, buf });
        console.log(`📎 Capturado: ${resp.url()} (${ct}, ${buf.length} bytes)`);
      } catch (e) {}
    }
  });

  const cookies = [{ name: 'ci_sessions', value: ciSession, domain: 'facturacion.oxxogas.com', path: '/' }];
  if (incapSes117) cookies.push({ name: 'incap_ses_117_3020163', value: incapSes117, domain: '.oxxogas.com', path: '/' });
  if (incapSes363) cookies.push({ name: 'incap_ses_363_3020163', value: incapSes363, domain: '.oxxogas.com', path: '/' });
  if (visidIncap) cookies.push({ name: 'visid_incap_3020163', value: visidIncap, domain: '.oxxogas.com', path: '/' });
  await page.setCookie(...cookies);

  await page.goto('https://facturacion.oxxogas.com/', { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForTimeout(2000);
  const misFacturasHandle = await page.evaluateHandle(() =>
    Array.from(document.querySelectorAll('a')).find(a => a.textContent.trim() === 'ACCEDER A MIS FACTURAS') || null
  );
  await misFacturasHandle.asElement().click();
  await page.waitForTimeout(3000);

  const accionesInfo = await page.evaluate(() => {
    const row = Array.from(document.querySelectorAll('tr')).find(tr => tr.textContent.includes('62703067'));
    if (!row) return null;
    return Array.from(row.querySelectorAll('a, button, i')).map(el => ({
      tag: el.tagName, class: el.className, href: el.href || null, title: el.title || null,
    }));
  });
  console.log('Acciones en la fila del folio 62703067:', JSON.stringify(accionesInfo, null, 2));

  // Click en cada ícono de acción de esa fila para ver qué dispara
  const iconos = await page.$$('tr');
  for (const tr of iconos) {
    const texto = await page.evaluate(el => el.textContent, tr);
    if (texto.includes('62703067')) {
      const enlaces = await tr.$$('a, i, button');
      console.log(`Encontrados ${enlaces.length} elementos clicables en la fila`);
      for (const en of enlaces) {
        await en.click().catch(e => console.log('click falló:', e.message));
        await page.waitForTimeout(1500);
      }
    }
  }

  console.log(`\nTotal archivos capturados: ${archivosCapturados.length}`);
  for (const a of archivosCapturados) {
    const ext = /pdf/i.test(a.ct) ? 'pdf' : 'xml';
    const url = await subirArchivoR2(a.buf, `debug/oxxogas_t02_real_${Date.now()}.${ext}`, a.ct);
    console.log(`☁️ Subido: ${url} (${a.buf.length} bytes)`);
  }

  const buf = await page.screenshot({ fullPage: true });
  console.log('📸', await subirArchivoR2(buf, `debug/oxxogas_acciones_${Date.now()}.png`, 'image/png'));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
