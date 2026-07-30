// Descarga los CFDI de Orler usando la API REST real del portal
// (apifacturacion.sinaloa.gob.mx) en vez de pelear con el menú de React.
// Descubierto interceptando la red: el portal usa un JWT en el query string
// ?authorization=<jwt> y expone /api/facturas/list/<offset>/<limit>.
require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');
const { extraerUUIDcfdi } = require('../lib/util');

const API = 'https://apifacturacion.sinaloa.gob.mx';

(async () => {
  const user = process.env.ORLER_SINALOA_USER;
  const pass = process.env.ORLER_SINALOA_PASS;
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();

  let jwt = null;
  page.on('request', (r) => {
    const m = r.url().match(/[?&]authorization=([^&]+)/);
    if (m && !jwt) jwt = decodeURIComponent(m[1]);
  });

  await page.goto('https://facturacion.sinaloa.gob.mx/login', { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('input[name="user"]', { timeout: 15000 });
  await page.click('input[name="user"]'); await page.keyboard.type(user, { delay: 25 });
  await page.click('input[name="password"]'); await page.keyboard.type(pass, { delay: 25 });
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(x => /iniciar|entrar|acceder/i.test(x.textContent || ''));
    if (b) b.click();
  });
  await page.waitForTimeout(6000);
  await browser.close();

  if (!jwt) { console.error('❌ No se capturó el JWT de sesión'); process.exit(1); }
  console.log(`🔑 JWT capturado (${jwt.length} chars)`);

  const listResp = await fetch(`${API}/api/facturas/list/0/25?authorization=${encodeURIComponent(jwt)}`);
  if (!listResp.ok) { console.error('❌ list falló:', listResp.status); process.exit(1); }
  const lista = await listResp.json();
  const arr = Array.isArray(lista) ? lista : (lista.data || lista.facturas || lista.rows || []);
  console.log(`📋 Facturas en la lista: ${arr.length}`);
  if (arr.length) console.log('Estructura de la 1ª:', JSON.stringify(arr[0], null, 2).slice(0, 1200));

  // Folios de las facturas timbradas hoy por el bot (los 3 tickets de 24/07)
  const FOLIOS_TICKET = ['944056', '343989', '2860513'];
  const objetivo = arr.filter(f => {
    const s = JSON.stringify(f);
    return FOLIOS_TICKET.some(fo => s.includes(fo));
  });
  console.log(`\n🎯 Facturas que coinciden con los folios de ticket: ${objetivo.length}`);

  const resultados = [];
  for (const f of objetivo) {
    const id = f._id || f.id || f.idFactura;
    const folioFactura = f.folio || f.folioFactura || f.numeroFactura;
    console.log(`\n➡️ Factura ${folioFactura} (id ${id})`);

    // Probar los endpoints de descarga más probables
    const candidatos = [
      `${API}/api/facturas/xml/${id}?authorization=${encodeURIComponent(jwt)}`,
      `${API}/api/facturas/${id}/xml?authorization=${encodeURIComponent(jwt)}`,
      `${API}/api/facturas/descargarXml/${id}?authorization=${encodeURIComponent(jwt)}`,
      `${API}/api/facturas/downloadXml/${id}?authorization=${encodeURIComponent(jwt)}`,
    ];
    let xmlBuf = null, urlUsada = null;
    for (const u of candidatos) {
      try {
        const r = await fetch(u);
        if (!r.ok) { console.log(`   ${r.status} ${u.split('?')[0].replace(API, '')}`); continue; }
        const b = Buffer.from(await r.arrayBuffer());
        const txt = b.slice(0, 200).toString('utf8');
        if (/<\?xml|<cfdi:/i.test(txt)) { xmlBuf = b; urlUsada = u; console.log(`   ✅ XML por ${u.split('?')[0].replace(API, '')} (${b.length}b)`); break; }
        console.log(`   200 pero no es XML: ${txt.slice(0, 80)}`);
      } catch (e) { console.log(`   error: ${e.message}`); }
    }
    if (!xmlBuf) { console.log('   ❌ ningún endpoint devolvió XML'); resultados.push({ folioFactura, ok: false, registro: f }); continue; }

    const xml = xmlBuf.toString('utf8');
    const uuid = extraerUUIDcfdi(xmlBuf);
    const total = (xml.match(/<(?:cfdi:)?Comprobante\b[^>]*\sTotal="([\d.]+)"/i) || [])[1];
    const rfcReceptor = (xml.match(/<(?:cfdi:)?Receptor[^>]*\sRfc="([^"]+)"/i) || [])[1];
    const rfcEmisor = (xml.match(/<(?:cfdi:)?Emisor[^>]*\sRfc="([^"]+)"/i) || [])[1];
    const conceptoDesc = (xml.match(/Descripcion="([^"]{0,200})"/i) || [])[1];
    console.log(`   UUID ${uuid} | Total ${total} | Emisor ${rfcEmisor} | Receptor ${rfcReceptor}`);
    console.log(`   Concepto: ${conceptoDesc}`);
    if (rfcReceptor !== 'GPR110128QD8') { console.log('   ❌ receptor no es GPN'); continue; }

    const pdfUrlApi = urlUsada.replace('/xml', '/pdf').replace('Xml', 'Pdf');
    let pdfBuf = null;
    try { const pr = await fetch(pdfUrlApi); if (pr.ok) { const pb = Buffer.from(await pr.arrayBuffer()); if (pb.slice(0,5).toString() === '%PDF-') pdfBuf = pb; } } catch {}

    const xmlUrl = await subirArchivoR2(xmlBuf, `facturas/${uuid}.xml`, 'application/xml');
    const pdfUrl = pdfBuf ? await subirArchivoR2(pdfBuf, `facturas/${uuid}.pdf`, 'application/pdf') : null;
    console.log(`   ☁️ ${xmlUrl}`);
    console.log(`   ☁️ ${pdfUrl || '(PDF no disponible por API)'}`);
    resultados.push({ folioFactura, ok: true, uuid, total: parseFloat(total), conceptoDesc, xmlUrl, pdfUrl });
  }

  console.log('\n=== JSON RESULTADOS ===');
  console.log(JSON.stringify(resultados.filter(r => r.ok), null, 2));
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
