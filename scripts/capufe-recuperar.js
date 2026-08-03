// Completa la factura de un código CAPUFE que quedó CAPTURADO a medias.
//
// Va DIRECTO al panel "Recuperar una factura, por código alfanumérico" sin
// pasar por el formulario normal. Dos motivos:
//   · si el código ya está capturado, "Validar Código" solo puede responder
//     "ya se encuentra capturado" — pasar por ahí no aporta nada;
//   · el flujo completo (formulario + recuperación) se pasaba del tope de
//     sesión de Browserless y moría con "Requesting main frame too early".
//
// ⚠️ Dos trampas del DOM, ambas medidas en vivo:
//   1. El portal DUPLICA ids: al abrir el panel hay dos <input id="codigo">,
//      dos #rfc, etc. Hay que quedarse SIEMPRE con los VISIBLES.
//   2. Los .p-dropdown del formulario oculto siguen en el DOM y son los
//      primeros que devuelve el selector; hacerles click da "Node is either
//      not clickable or not an Element". Se filtran por visibilidad.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const puppeteer = require('puppeteer');
const db = require('../lib/db');

const TICKET_ID = Number(process.argv[2] || 199);

(async () => {
  const [[t]] = await db.query(
    `SELECT t.id, t.ocr_json, c.rfc, c.razon_social, c.codigo_postal, c.regimen_fiscal, c.uso_cfdi, c.nombre cliente
       FROM tickets t JOIN users u ON u.id = t.user_id
       LEFT JOIN clientes c ON c.id = u.cliente_id WHERE t.id = ?`, [TICKET_ID]);
  const o = typeof t.ocr_json === 'object' ? t.ocr_json : JSON.parse(t.ocr_json || '{}');
  const codigo = String(o.codigo || o.referencia || '').replace(/\s+/g, '').toUpperCase();

  console.log(`♻️ Recuperando #${t.id} · ${codigo} · ${t.cliente} (${t.rfc}, rég ${t.regimen_fiscal})\n`);

  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}&stealth=true`,
  });
  const page = await browser.newPage();
  page.on('dialog', async (d) => { console.log('🔔', d.message()); await d.accept().catch(() => {}); });
  const api = [];
  page.on('response', async (r) => {
    if (!/capufe-quadrum-backend/i.test(r.url())) return;
    const nombre = r.url().split('/').pop().split('?')[0];
    // ⚠️ La descarga viene en BINARIO: resp.text() la deja vacía y parece que
    // el endpoint no devolvió nada. Hay que leerla como buffer y guardarla.
    if (/descargar_codigo/i.test(nombre)) {
      try {
        const buf = await r.buffer();
        const cabeza = buf.slice(0, 8).toString('latin1');
        const ext = cabeza.startsWith('PK') ? 'zip' : cabeza.startsWith('%PDF') ? 'pdf' : cabeza.includes('<') ? 'xml' : 'bin';
        const destino = require('path').join(__dirname, '..', 'pruebas', `capufe_recuperado.${ext}`);
        require('fs').mkdirSync(require('path').dirname(destino), { recursive: true });
        require('fs').writeFileSync(destino, buf);
        api.push({ u: nombre, b: `[${buf.length} bytes, empieza ${JSON.stringify(cabeza)}] → ${destino}` });
      } catch (e) { api.push({ u: nombre, b: 'no se pudo leer: ' + e.message }); }
      return;
    }
    let b = null; try { b = await r.text(); } catch {}
    api.push({ u: nombre, b: (b || '').slice(0, 260) });
  });

  const visible = async (sel) => page.$$eval(sel, (els) => els.filter(e => e.offsetParent).length);

  try {
    await page.goto('https://facturacioncapufe.com.mx/Capufe/facturacionrapida', { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(2500);

    // 1) Abrir el panel de recuperación
    await page.evaluate(() => {
      const a = Array.from(document.querySelectorAll('a, button, li'))
        .find(e => /recuperar una factura/i.test(e.textContent || '') && e.offsetParent);
      if (a) a.click();
    });
    await page.waitForTimeout(2500);

    // 2) Código → botón "recuperar"
    await page.evaluate((cod) => {
      const inp = Array.from(document.querySelectorAll('input')).filter(i => i.offsetParent)
        .find(i => i.id === 'codigo');
      const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      s.call(inp, cod);
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    }, codigo);
    await page.waitForTimeout(500);

    // ⚠️ El botón "recuperar" está DENTRO del modal, y el menú de arriba tiene
    // un enlace "Recuperar una factura, por código alfanúmerico". Buscar por
    // texto en todo el documento pulsaba el ENLACE y solo reabría el modal:
    // por eso "tras recuperar" seguía enseñando el diálogo. Hay que acotar la
    // búsqueda al contenedor del diálogo (PrimeReact usa .p-dialog).
    const pulsado = await page.evaluate(() => {
      const modal = document.querySelector('.p-dialog, [role="dialog"]');
      if (!modal) return 'sin modal';
      const b = Array.from(modal.querySelectorAll('button'))
        .find(x => /recuperar/i.test(x.textContent || '') && !x.disabled);
      if (!b) return 'sin botón en el modal';
      b.click();
      return (b.textContent || '').trim();
    });
    console.log('botón del modal:', pulsado);
    await page.waitForTimeout(9000);

    const txt = await page.evaluate(() => document.body.innerText);
    console.log('\nPANTALLA FINAL:', txt.replace(/\s+/g, ' ').slice(0, 400));
    console.log('\nAPI:');
    for (const a of api.slice(-6)) console.log('  ', a.u, '→', a.b.slice(0, 180));
  } catch (e) {
    console.error('❌', e.message);
  }
  await browser.close().catch(() => {});
  process.exit(0);
})();
