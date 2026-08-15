// Recupera la factura del ticket #220 por el flujo "Reimprimir Factura".
// El portal la emitió bien (el bot lo confirmó) pero sin devolver enlaces,
// así que aquí se busca por tienda/ticket/fecha y se leen UUID y descargas.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const puppeteer = require('puppeteer');

const TIENDA = process.env.LC_TIENDA || '04123-00025';
const TICKET = process.env.LC_TICKET || '1194671';
const FECHA = process.env.LC_FECHA || '2026-08-11';
const TOTAL = process.env.LC_TOTAL || '776.00';

(async () => {
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}&stealth=true`,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 900 });
  page.on('dialog', async (d) => { console.log('💬', d.message()); await d.accept().catch(() => {}); });

  await page.goto('https://cfdi.analytix360.cloud/cafrema/lc/imprimir/', { waitUntil: 'domcontentloaded', timeout: 40000 });
  await page.waitForTimeout(3500);

  const dump = async (etapa) => {
    const d = await page.evaluate(() => {
      const vis = (e) => e.offsetParent !== null;
      return {
        url: location.href,
        texto: (document.body.innerText || '').replace(/\n{2,}/g, '\n').trim().slice(0, 700),
        campos: Array.from(document.querySelectorAll('input, select, textarea')).filter(vis)
          .map((i) => `${i.tagName.toLowerCase()} name="${i.name}" id="${i.id}" type="${i.type || ''}"`),
        opciones: Array.from(document.querySelectorAll('select option')).slice(0, 12)
          .map((o) => `${o.value}=${o.textContent.trim().slice(0, 30)}`),
        enlaces: Array.from(document.querySelectorAll('a[href*="descargar"]')).map((a) => a.href),
      };
    });
    console.log(`── ${etapa} ── ${d.url}`);
    console.log('texto:', d.texto.replace(/\n/g, ' | ').slice(0, 500));
    d.campos.forEach((c) => console.log('  campo:', c));
    if (d.opciones.length) console.log('  opciones:', d.opciones.join(' · '));
    if (d.enlaces.length) d.enlaces.forEach((l) => console.log('  🔗', l));
    return d;
  };

  const d0 = await dump('formulario');

  // Llenar por nombre de campo (imprimir[...])
  await page.evaluate(({ TIENDA, TICKET, FECHA, TOTAL }) => {
    const nativo = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    const poner = (el, v) => { nativo.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
    for (const el of document.querySelectorAll('input, select')) {
      const n = (el.name || '').toLowerCase();
      if (el.tagName === 'SELECT' && n.includes('store')) {
        const op = Array.from(el.options).find((o) => o.textContent.includes(TIENDA));
        if (op) { el.value = op.value; el.dispatchEvent(new Event('change', { bubbles: true })); }
      } else if (n.includes('ticket') || n.includes('folio')) poner(el, TICKET);
      else if (n.includes('fecha') || n.includes('date')) poner(el, FECHA);
      else if (n.includes('total')) poner(el, TOTAL);
    }
  }, { TIENDA, TICKET, FECHA, TOTAL });

  await page.waitForTimeout(800);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
    page.evaluate(() => {
      const b = document.querySelector('button[type=submit], input[type=submit]') ||
        Array.from(document.querySelectorAll('button')).find((x) => /imprimir|buscar|consultar/i.test(x.textContent));
      if (b) b.click();
    }),
  ]);
  await page.waitForTimeout(4000);

  const d1 = await dump('resultado');
  const uuid = (d1.url.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) || [])[0]
    || (d1.enlaces[0] || '').match(/[0-9a-f-]{36}/i)?.[0];
  console.log('\nUUID:', uuid || '(no visible)');
  if (!uuid) { await browser.close(); process.exit(1); }

  // Los enlaces de descarga llevan sesión — se bajan DENTRO de la página
  const bajar = async (tipo) => {
    const b64 = await page.evaluate(async (u) => {
      const r = await fetch(u, { credentials: 'include' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const buf = await r.arrayBuffer();
      let s = ''; const b = new Uint8Array(buf);
      for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
      return btoa(s);
    }, `https://cfdi.analytix360.cloud/cafrema/lc/descargar/${tipo}/${uuid}`);
    return Buffer.from(b64, 'base64');
  };
  const xml = await bajar('xml');
  const pdf = await bajar('pdf');
  console.log(`bajados: xml ${xml.length}B · pdf ${pdf.length}B`);
  console.log('xml cabeza:', xml.slice(0, 120).toString('utf8').replace(/\n/g, ' '));

  const { subirArchivoR2 } = require('../storage/r2');
  const xmlUrl = await subirArchivoR2(xml, `facturas/littlecaesars/${uuid}.xml`, 'application/xml');
  const pdfUrl = await subirArchivoR2(pdf, `facturas/littlecaesars/${uuid}.pdf`, 'application/pdf');
  console.log('XML_URL=' + xmlUrl);
  console.log('PDF_URL=' + pdfUrl);

  await browser.close();
  process.exit(0);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
