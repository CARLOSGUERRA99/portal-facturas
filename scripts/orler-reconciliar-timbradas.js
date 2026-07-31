// Recupera los CFDI de las casetas de Sinaloa que el portal rechaza con
// "El folio ya fue timbrado", y los asocia a sus tickets.
//
// Usa la API REST real del portal (descubierta interceptando la red): el JWT
// viaja en el query string y /api/facturas/list devuelve el historial completo
// de la cuenta. Emparejar por IMPORTE y por el folio que el propio portal
// escribe dentro del concepto ("... Folio: 3017725 ...") es más fiable que
// pelear con el menú de acciones de React.
require('dotenv').config();
const puppeteer = require('puppeteer');
const db = require('../lib/db');
const { subirArchivoR2 } = require('../storage/r2');
const { extraerUUIDcfdi } = require('../lib/util');

const API = 'https://apifacturacion.sinaloa.gob.mx';
const RFC_GPN = 'GPR110128QD8';
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const parseJson = (v) => { if (!v) return {}; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return {}; } };

async function obtenerJwt() {
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}&stealth=true`,
  });
  const page = await browser.newPage();
  let jwt = null;
  page.on('request', (r) => {
    const m = r.url().match(/[?&]authorization=([^&]+)/);
    if (m && !jwt) jwt = decodeURIComponent(m[1]);
  });
  await page.goto('https://facturacion.sinaloa.gob.mx/login', { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('input[name="user"]', { timeout: 15000 });
  await page.click('input[name="user"]'); await page.keyboard.type(process.env.ORLER_SINALOA_USER, { delay: 20 });
  await page.click('input[name="password"]'); await page.keyboard.type(process.env.ORLER_SINALOA_PASS, { delay: 20 });
  const h = await page.evaluateHandle(() => Array.from(document.querySelectorAll('button')).find(x => /iniciar sesi[oó]n/i.test(x.textContent || '')) || null);
  const el = h.asElement();
  if (el) await el.click();
  for (let i = 0; i < 15 && !jwt; i++) await dormir(1000);
  await browser.close().catch(() => {});
  return jwt;
}

(async () => {
  // Tickets de casetas de Sinaloa sin factura registrada.
  const [pendientes] = await db.query(`
    SELECT t.id, t.user_id, t.comercio, t.ocr_json
      FROM tickets t LEFT JOIN facturas f ON f.ticket_id = t.id
     WHERE f.id IS NULL
       AND (t.portal_url LIKE '%sinaloa.gob.mx%' OR t.comercio LIKE '%Caseta%' OR t.comercio LIKE '%Autopista%')
     ORDER BY t.id`);

  const objetivos = pendientes.map((t) => {
    const o = parseJson(t.ocr_json);
    return { id: t.id, userId: t.user_id, comercio: t.comercio, folio: String(o.folio || '').replace(/^0+/, ''), total: parseFloat(o.total), ocr: o };
  }).filter((t) => t.folio);

  console.log(`📋 ${objetivos.length} ticket(s) de caseta sin factura:`);
  objetivos.forEach((t) => console.log(`   #${t.id} folio ${t.folio} $${t.total} — ${String(t.comercio).slice(0, 42)}`));
  if (!objetivos.length) { console.log('nada que hacer'); process.exit(0); }

  console.log('\n🔑 Obteniendo JWT del portal…');
  const jwt = await obtenerJwt();
  if (!jwt) { console.error('❌ no se capturó el JWT'); process.exit(1); }
  console.log(`   JWT ok (${jwt.length} chars)`);

  const r = await fetch(`${API}/api/facturas/list/0/100?authorization=${encodeURIComponent(jwt)}`);
  if (!r.ok) { console.error(`❌ /api/facturas/list → HTTP ${r.status}`); process.exit(1); }
  const lista = await r.json();
  const facturas = Array.isArray(lista) ? lista : (lista.data || lista.facturas || []);
  console.log(`📄 ${facturas.length} factura(s) en la cuenta\n`);

  let n = 0;
  for (const t of objetivos) {
    // `folioTicket` es el folio de la caseta tal cual viene impreso en el
    // boleto; es el campo por el que hay que emparejar. El endpoint
    // /descargarXml devuelve 400, pero no hace falta: la propia respuesta de
    // /list trae el XML COMPLETO en el campo `xml`, más urlXML y urlPDF.
    const cand = facturas.find((f) => String(f.folioTicket || '').replace(/^0+/, '') === t.folio)
              || facturas.find((f) => String(f.descripcion || '').includes(`Folio: ${t.folio}`));
    if (!cand) { console.log(`   ✖ #${t.id} folio ${t.folio}: no aparece en el historial`); continue; }
    if (!cand.xml) { console.log(`   ✖ #${t.id}: la factura ${cand.folio} no trae XML en la API`); continue; }

    const xmlBuf = Buffer.from(cand.xml, 'utf8');
    const xml = cand.xml;
    const total = (xml.match(/<(?:cfdi:)?Comprobante\b[^>]*\sTotal="([\d.]+)"/i) || [])[1];
    const rfcRec = (xml.match(/<(?:cfdi:)?Receptor[^>]*\sRfc="([^"]+)"/i) || [])[1];
    const uuid = (extraerUUIDcfdi(xmlBuf) || '').toLowerCase();

    // Verificaciones obligatorias antes de tocar la BD.
    if (!uuid) { console.log(`   ✖ #${t.id}: el XML no trae UUID`); continue; }
    if (rfcRec !== RFC_GPN) { console.log(`   ✖ #${t.id}: receptor ${rfcRec}, no es GPN`); continue; }
    if (!isNaN(t.total) && Math.abs(parseFloat(total) - t.total) > 0.01) {
      console.log(`   ✖ #${t.id}: total CFDI ${total} ≠ total ticket ${t.total}`); continue;
    }

    const xmlUrl = await subirArchivoR2(xmlBuf, `facturas/${uuid}.xml`, 'application/xml');
    let pdfUrl = null;
    if (cand.urlPDF) {
      try {
        const rp = await fetch(cand.urlPDF);
        if (rp.ok) pdfUrl = await subirArchivoR2(Buffer.from(await rp.arrayBuffer()), `facturas/${uuid}.pdf`, 'application/pdf');
      } catch {}
    }
    const ocr = t.ocr; ocr.uuid_cfdi = uuid; ocr.folio_factura = cand.folio;
    await db.query("UPDATE tickets SET status='procesado', error_msg=NULL, reintento_programado=NULL, ocr_json=? WHERE id=?", [JSON.stringify(ocr), t.id]);
    await db.query("INSERT INTO facturas (user_id, ticket_id, comercio, xml_url, pdf_url, status) VALUES (?,?,?,?,?,'completado')",
      [t.userId, t.id, String(t.comercio || 'Caseta Sinaloa').slice(0, 50), xmlUrl, pdfUrl]);
    console.log(`   ✅ #${t.id} folio ${t.folio} → UUID ${uuid} ($${total}) factura ${cand.folio}`);
    n++;
  }
  console.log(`\n=== ${n} caseta(s) reconciliada(s) ===`);
  process.exit(0);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
