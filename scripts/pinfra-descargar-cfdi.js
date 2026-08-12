// Baja el XML y el PDF de una factura ya timbrada en PINFRA y la registra en el
// sistema (R2 + tabla facturas, con la verificación de lib/cfdi.js).
//
// ⚠️ DOS FORMATOS DE FECHA EN EL MISMO PORTAL:
//     Facturar/GenerarFactura   → M/D/YYYY  (8/2/2026 = 2 de agosto)
//     Consultar/GenerarConsultas→ D/M/YYYY  (01/07/2026 = 1 de julio)
//   Con el formato equivocado la consulta contesta "Nada Encontrado" y parece
//   que la factura no existe.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const puppeteer = require('puppeteer');
const db = require('../lib/db');
const { subirArchivoR2 } = require('../storage/r2');
const { leerCFDI, verificarCFDI } = require('../lib/cfdi');

const TRANSACCION = process.argv[2];
const TICKET_ID = Number(process.argv[3]);
const RFC = process.argv[4] || 'GPR110128QD8';
const CORREO = process.argv[5] || 'carlosguerra@grupogpn.com';
if (!TRANSACCION || !TICKET_ID) { console.error('uso: node scripts/pinfra-descargar-cfdi.js <transaccion> <ticketId> [rfc] [correo]'); process.exit(1); }

(async () => {
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}&stealth=true`,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000 });
  page.on('dialog', async (d) => { console.log('💬', d.message()); await d.accept().catch(() => {}); });

  try {
    await page.goto('https://www.pinfrafacturacion.com.mx/', { waitUntil: 'load', timeout: 35000 });
    await page.waitForTimeout(2500);
    await page.type('input#rfc', RFC, { delay: 30 });
    await page.type('input#correo', CORREO, { delay: 30 });
    await page.evaluate(() => {
      const x = Array.from(document.querySelectorAll('button,input[type=submit],a')).find((e) => /ingresar/i.test(e.textContent || e.value || ''));
      if (x) x.click();
    });
    await page.waitForTimeout(6000);
    await page.goto('https://www.pinfrafacturacion.com.mx/Consultar/GenerarConsultas', { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(4000);

    await page.evaluate(() => {
      const s = (id, v) => { const e = document.querySelector(id); e.value = v; ['input', 'change', 'blur', 'keyup'].forEach((x) => e.dispatchEvent(new Event(x, { bubbles: true }))); };
      s('#txtDe', '01/07/2026'); s('#txtA', '12/08/2026');   // D/M/YYYY aquí; una fecha futura devuelve vacío
    });
    await page.waitForTimeout(800);
    await page.evaluate(() => {
      const x = Array.from(document.querySelectorAll('button,input[type=submit],a')).find((e) => /buscar/i.test(e.textContent || e.value || '') && e.offsetParent);
      if (x) x.click();
    });
    await page.waitForTimeout(11000);

    // La fila de la transacción y sus enlaces de descarga.
    const fila = await page.evaluate((tr) => {
      const f = Array.from(document.querySelectorAll('table tr')).find((t) => t.innerText.includes(tr));
      if (!f) return null;
      return {
        texto: f.innerText.replace(/\s+/g, ' ').trim(),
        acciones: Array.from(f.querySelectorAll('a, button, img, i')).map((e) => ({
          etq: (e.textContent || e.alt || e.title || '').trim(),
          href: e.getAttribute('href') || '',
          onclick: e.getAttribute('onclick') || '',
          clases: (typeof e.className === 'string' ? e.className : ''),
        })),
      };
    }, TRANSACCION);
    if (!fila) { console.log(`❌ no aparece la transacción ${TRANSACCION}`); await browser.close(); process.exit(1); }
    console.log('fila:', fila.texto);
    console.log('acciones:'); fila.acciones.forEach((a) => console.log('   ', JSON.stringify(a)));

    // Descargar por fetch dentro de la página: hereda la cookie de sesión.
    const archivos = await page.evaluate(async (tr) => {
      const res = {};
      for (const [clave, url] of [['xml', `/Consultar/DescargarXML?Transaccion=${tr}`], ['pdf', `/Consultar/DescargarPDF?Transaccion=${tr}`]]) {
        try {
          const r = await fetch(url);
          if (!r.ok) { res[clave] = `HTTP ${r.status}`; continue; }
          const buf = new Uint8Array(await r.arrayBuffer());
          res[clave] = { n: buf.length, b64: btoa(String.fromCharCode(...buf)) };
        } catch (e) { res[clave] = 'error: ' + e.message; }
      }
      return res;
    }, TRANSACCION);

    for (const k of ['xml', 'pdf']) {
      console.log(`${k}:`, typeof archivos[k] === 'object' ? `${archivos[k].n} bytes` : archivos[k]);
    }
    await browser.close();

    if (typeof archivos.xml !== 'object') { console.log('⚠️ sin XML — no se registra nada'); process.exit(1); }

    const xmlBuf = Buffer.from(archivos.xml.b64, 'base64');
    const cfdi = leerCFDI(xmlBuf);
    if (!cfdi) { console.log('⚠️ lo descargado no es un CFDI legible'); process.exit(1); }
    console.log(`CFDI ${cfdi.uuid} · ${cfdi.emisorNombre} → ${cfdi.receptorRfc} · $${cfdi.total}`);

    const probs = verificarCFDI(cfdi, { rfcEsperado: RFC, totalEsperado: 139 });
    probs.forEach((p) => console.log(`   ${p.gravedad === 'grave' ? '🛑' : '⚠️ '} ${p.msg}`));

    const xmlUrl = await subirArchivoR2(xmlBuf, `facturas/${cfdi.uuid}.xml`, 'application/xml');
    const pdfUrl = typeof archivos.pdf === 'object'
      ? await subirArchivoR2(Buffer.from(archivos.pdf.b64, 'base64'), `facturas/${cfdi.uuid}.pdf`, 'application/pdf')
      : null;

    const [[t]] = await db.query('SELECT user_id, comercio FROM tickets WHERE id = ?', [TICKET_ID]);
    await db.query(
      `INSERT INTO facturas (user_id, ticket_id, comercio, pdf_url, xml_url, status,
                             uuid, receptor_rfc, emisor_rfc, emisor_nombre, total, serie_folio, fecha_timbrado, verificacion)
       VALUES (?, ?, ?, ?, ?, 'completado', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [t.user_id, TICKET_ID, t.comercio, pdfUrl, xmlUrl, cfdi.uuid, cfdi.receptorRfc, cfdi.emisorRfc,
       (cfdi.emisorNombre || '').slice(0, 255), cfdi.total, `${cfdi.serie || ''}${cfdi.folio || ''}`.slice(0, 60) || null,
       cfdi.fechaTimbrado ? cfdi.fechaTimbrado.replace('T', ' ').slice(0, 19) : null,
       probs.length ? probs.map((p) => p.msg).join(' · ').slice(0, 500) : null]);
    await db.query("UPDATE tickets SET status='procesado', error_msg=NULL, reintento_programado=NULL WHERE id=?", [TICKET_ID]);

    console.log(`\n✅ ticket #${TICKET_ID} registrado\n   ${xmlUrl}\n   ${pdfUrl || '(sin PDF)'}`);
    process.exit(0);
  } catch (e) {
    console.error('❌', e.message);
    await browser.close().catch(() => {});
    process.exit(1);
  }
})();
