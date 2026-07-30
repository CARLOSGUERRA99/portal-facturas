// Reconcilia en tickets+facturas los CFDI reales de Orler, obtenidos por la API
// del portal (apifacturacion.sinaloa.gob.mx). Mapea cada factura al ticket por
// su folioTicket (el folio impreso en el boleto de la caseta).
require('dotenv').config();
const puppeteer = require('puppeteer');
const db = require('../lib/db');
const { subirArchivoR2 } = require('../storage/r2');
const { extraerUUIDcfdi } = require('../lib/util');

const API = 'https://apifacturacion.sinaloa.gob.mx';
const USER_ID = 1;
const RFC_GPN = 'GPR110128QD8';

// folio impreso en el ticket → id del ticket en la BD
const MAPA = {
  '944056':  140,
  '343989':  139,
  '2860513': 141,
  '280313':  136,
  '3017725': 137,
  '2292960': 138,
};

(async () => {
  const user = process.env.ORLER_SINALOA_USER;
  const pass = process.env.ORLER_SINALOA_PASS;
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  let jwt = null;
  page.on('request', (r) => { const m = r.url().match(/[?&]authorization=([^&]+)/); if (m && !jwt) jwt = decodeURIComponent(m[1]); });
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
  if (!jwt) { console.error('❌ sin JWT'); process.exit(1); }

  const r = await fetch(`${API}/api/facturas/list/0/50?authorization=${encodeURIComponent(jwt)}`);
  const lista = await r.json();
  const arr = Array.isArray(lista) ? lista : (lista.data || lista.facturas || lista.rows || []);
  console.log(`📋 ${arr.length} facturas en la cuenta Orler`);

  let reconciliadas = 0;
  for (const f of arr) {
    const folioTicket = String(f.folioTicket || '').replace(/^0+/, '');
    const ticketId = MAPA[folioTicket];
    if (!ticketId) continue;

    console.log(`\n➡️ Factura ${f.folio} → ticket #${ticketId} (folio ticket ${f.folioTicket}, $${f.total})`);

    const [ya] = await db.query("SELECT id FROM facturas WHERE ticket_id = ?", [ticketId]);
    if (ya.length) { console.log('   ⏭️ ya tiene factura en BD'); continue; }

    // XML: la API lo trae embebido en el registro de la lista; si no, se descarga.
    let xmlBuf = f.xml ? Buffer.from(f.xml, 'utf8') : null;
    const id = f._id || f.id;
    if (!xmlBuf) {
      const xr = await fetch(`${API}/api/facturas/descargarXml/${id}?authorization=${encodeURIComponent(jwt)}`);
      if (xr.ok) xmlBuf = Buffer.from(await xr.arrayBuffer());
    }
    if (!xmlBuf) { console.log('   ❌ sin XML'); continue; }

    const xml = xmlBuf.toString('utf8');
    const uuid = (extraerUUIDcfdi(xmlBuf) || f.uuid || '').toLowerCase();
    const total = parseFloat((xml.match(/<(?:cfdi:)?Comprobante\b[^>]*\sTotal="([\d.]+)"/i) || [])[1]);
    const rfcReceptor = (xml.match(/<(?:cfdi:)?Receptor[^>]*\sRfc="([^"]+)"/i) || [])[1];
    const rfcEmisor = (xml.match(/<(?:cfdi:)?Emisor[^>]*\sRfc="([^"]+)"/i) || [])[1];
    const fechaTimbrado = (xml.match(/FechaTimbrado="([^"]+)"/i) || [])[1];

    if (rfcReceptor !== RFC_GPN) { console.log(`   ❌ receptor ${rfcReceptor} != GPN`); continue; }

    // Verificar el total contra el OCR del ticket antes de reconciliar
    const [[t]] = await db.query("SELECT ocr_json FROM tickets WHERE id = ?", [ticketId]);
    const ocr = JSON.parse(t?.ocr_json || '{}');
    if (ocr.total && Math.abs(parseFloat(ocr.total) - total) > 0.01) {
      console.log(`   ❌ total del CFDI (${total}) != total del ticket (${ocr.total}) — no se reconcilia`);
      continue;
    }
    console.log(`   ✅ UUID ${uuid} | Total ${total} | Emisor ${rfcEmisor} | Timbrado ${fechaTimbrado}`);

    let pdfBuf = null;
    try {
      const pr = await fetch(`${API}/api/facturas/descargarPdf/${id}?authorization=${encodeURIComponent(jwt)}`);
      if (pr.ok) { const pb = Buffer.from(await pr.arrayBuffer()); if (pb.slice(0, 5).toString() === '%PDF-') pdfBuf = pb; }
    } catch {}

    const xmlUrl = await subirArchivoR2(xmlBuf, `facturas/${uuid}.xml`, 'application/xml');
    const pdfUrl = pdfBuf ? await subirArchivoR2(pdfBuf, `facturas/${uuid}.pdf`, 'application/pdf') : null;

    const ocrNuevo = {
      ...ocr,
      portal: 'orler',
      portalUrl: 'https://facturacion.sinaloa.gob.mx',
      carril: (f.descripcion || '').match(/Carril:\s*(\d+)/)?.[1] || ocr.carril || null,
      uuid_cfdi: uuid,
      folio_factura_orler: f.folio,
      _nota: 'Facturado por bots/orler.js (login + BUSCAR + FACTURAR + TIMBRAR); CFDI descargado por la API del portal y verificado (UUID/Total/RFC).',
    };
    await db.query(
      "UPDATE tickets SET status='procesado', error_msg=NULL, reintento_programado=NULL, comercio=?, portal_url=?, ocr_json=? WHERE id=?",
      [ocr.comercio || 'Autopista de Cuota (Orler / Gobierno de Sinaloa)', 'https://facturacion.sinaloa.gob.mx', JSON.stringify(ocrNuevo), ticketId]
    );
    await db.query(
      "INSERT INTO facturas (user_id, ticket_id, comercio, xml_url, pdf_url, status) VALUES (?, ?, ?, ?, ?, 'completado')",
      [USER_ID, ticketId, (ocr.comercio || 'Orler / Sinaloa').slice(0, 50), xmlUrl, pdfUrl]
    );
    console.log(`   💾 ticket #${ticketId} → procesado + factura insertada`);
    reconciliadas++;
  }

  console.log(`\n=== ${reconciliadas} factura(s) reconciliada(s) ===`);
  process.exit(0);
})().catch(e => { console.error('💥', e.message); process.exit(1); });
