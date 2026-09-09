/**
 * Lista las facturas ya emitidas a un RFC en BuzonFacturas (ARCO) y, si se
 * pide, baja el XML/PDF de una y la asocia a su ticket.
 *
 * Sirve para el caso de "el portal dice que el ticket YA fue facturado": el
 * CFDI existe, reintentar el bot solo generaría un duplicado, y lo que hace
 * falta es el FOLIO INTERNO (formato BXI-0123456) que la pantalla de descarga
 * pide y que el ticket no imprime.
 *
 * ⚠️ HAY QUE TECLEAR DE VERDAD. Poniendo el .value del campo RFC y disparando
 * input/change, el portal responde "El dato no puede estar vacío" aunque el
 * valor se vea en pantalla — su validación escucha eventos de teclado reales.
 *
 * Uso:
 *   node scripts/arco-buscar-facturas.js                    → lista las del RFC de GPN
 *   node scripts/arco-buscar-facturas.js --rfc XAXX010101000
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const puppeteer = require('puppeteer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = process.argv.slice(2);
const valorDe = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const RFC = valorDe('--rfc') || 'GPR110128QD8';

(async () => {
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}&stealth=true`,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000 });
  page.on('dialog', async (d) => { console.log('  dialog:', d.message()); await d.accept().catch(() => {}); });

  try {
    console.log(`Buscando facturas de ${RFC} en BuzonFacturas...`);
    await page.goto('https://buzonfacturas.com/CFDI/DescargarFactura', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(4000);

    // El id real es #RFC (mayúsculas). Ojo: el hook de commerce/arco busca
    // input#Rfc / input[name="Rfc"], que en CSS son CASE-SENSITIVE y no casan;
    // solo le funcionaba el selector por placeholder.
    const campo = await page.$('#RFC, input[name="RFC"], input[placeholder*="RFC"]');
    if (!campo) throw new Error('no apareció el campo de RFC');
    await campo.click({ clickCount: 3 });
    await page.keyboard.type(RFC, { delay: 70 });
    await sleep(800);

    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button,input[type=submit],a'))
        .find((x) => /buscar/i.test(x.textContent || x.value || ''));
      if (b) b.click();
    });
    await sleep(9000);

    const filas = await page.evaluate(() => Array.from(document.querySelectorAll('table tr'))
      .map((tr) => {
        const celdas = Array.from(tr.querySelectorAll('td')).map((td) => (td.textContent || '').trim());
        return celdas.filter(Boolean);
      })
      .filter((c) => c.length));

    const aviso = await page.evaluate(() => {
      const t = document.body.innerText.replace(/\s+/g, ' ');
      const m = t.match(/(El dato no puede estar vac[ií]o|no se encontr[oó][^.]{0,60}|sin resultados[^.]{0,40})/i);
      return m ? m[1] : null;
    });

    console.log('');
    if (aviso) console.log(`⚠️ el portal dijo: "${aviso}"`);
    if (!filas.length) {
      console.log('Sin filas de facturas.');
    } else {
      console.log(`=== ${filas.length} fila(s) ===`);
      filas.forEach((c) => console.log('  · ' + c.join(' | ').slice(0, 170)));
    }

    await browser.close();
    process.exit(0);
  } catch (e) {
    console.error('❌', e.message);
    await browser.close().catch(() => {});
    process.exit(1);
  }
})();
