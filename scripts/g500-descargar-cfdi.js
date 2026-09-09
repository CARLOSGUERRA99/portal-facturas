/**
 * Baja los XML/PDF de facturas YA TIMBRADAS en G500 y los deja en tmp/g500.
 *
 * Entra directo a misFacturas.aspx (la ruta que da el portal en su menú) en vez
 * de navegar Inicio → Mis facturas, que es más frágil.
 *
 * ⚠️ Los tres botones de cada fila (PDF / XML / correo) no tienen texto, ni
 * title, ni alt, y sus clases son ruido generado: "soup" = PDF, "pin" = XML,
 * "pea" = correo. Lo único que los identifica de verdad es el src del <img>
 * (img/fg-nw/pdf.png · xml.png · correo.png).
 *
 * ⚠️ El monto y el estatus van en columnas OCULTAS (display:none), así que
 * innerText no los trae; hay que leer textContent celda por celda. Sin el monto
 * no se puede emparejar cada factura con su ticket.
 *
 * Uso:
 *   node scripts/g500-descargar-cfdi.js                → solo lista
 *   node scripts/g500-descargar-cfdi.js W65440 W65441  → baja esas
 *   node scripts/g500-descargar-cfdi.js --todas
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = process.argv.slice(2);
const TODAS = args.includes('--todas');
const PEDIDAS = args.filter((a) => !a.startsWith('--')).map((s) => s.toUpperCase());
const DESTINO = path.join(__dirname, '..', 'tmp', 'g500');

(async () => {
  for (const v of ['G500_USER', 'G500_PASS', 'G500_PERMISO_CRE']) {
    if (!process.env[v]) { console.error(`❌ falta ${v} en .env`); process.exit(1); }
  }
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}&stealth=true`,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000 });
  browser.on('targetcreated', async (t) => {
    try {
      if (t.type() === 'page') console.log('  ⚠️ el portal abrio una ventana nueva:', t.url().slice(0, 90));
    } catch {}
  });
  page.on('dialog', async (d) => { console.log('  dialog:', d.message()); await d.accept().catch(() => {}); });

  // Los archivos pueden llegar como respuesta HTTP normal o como blob del
  // navegador; se cubren las dos vías.
  const capturados = [];
  page.on('response', async (resp) => {
    try {
      const ct = (resp.headers()['content-type'] || '').toLowerCase();
      const cd = (resp.headers()['content-disposition'] || '').toLowerCase();
      // Filtro ESTRICTO: 'xml' a secas tambien casa con image/svg+xml (los
      // iconos del portal) y octet-stream con las fuentes .woff2 — los dos se
      // colaron como "descargas" en el primer intento.
      const esDescarga = /attachment/.test(cd) || /\.(xml|pdf|zip)/.test(cd);
      const esCFDI = /application\/(xml|pdf|zip|octet-stream)/.test(ct) && !/svg/.test(ct);
      if (esDescarga || esCFDI) {
        const buf = await resp.buffer();
        const cabeza = buf ? buf.toString('utf8', 0, 300) : '';
        const util = buf && buf.length > 500 && (/<cfdi:Comprobante|<Comprobante/i.test(cabeza) || buf.toString('latin1', 0, 5) === '%PDF-' || /attachment/.test(cd));
        if (util) {
          const m = cd.match(/filename\*?=(?:utf-8'')?"?([^";]+)/i);
          capturados.push({ nombre: m ? decodeURIComponent(m[1]) : `desc_${capturados.length}`, buf, ct });
        }
      }
    } catch {}
  });
  await page.evaluateOnNewDocument(() => {
    window.__blobs = [];
    const guarda = (nombre, blob) => new Promise((res) => {
      const fr = new FileReader();
      fr.onload = () => { window.__blobs.push({ nombre, b64: String(fr.result).split(',')[1] }); res(); };
      fr.readAsDataURL(blob);
    });
    const origCOU = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function (o) {
      try { if (o instanceof Blob) guarda(`blob_${Date.now()}`, o); } catch (e) {}
      return origCOU(o);
    };
  });

  try {
    console.log('1. Entrando...');
    await page.goto(`https://g500facturagas.azurewebsites.net/?PermisoCRE=${process.env.G500_PERMISO_CRE}&seccion=`,
      { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(3500);
    await page.click('#mailUser'); await page.keyboard.type(process.env.G500_USER, { delay: 35 });
    await page.click('#pwdUser');  await page.keyboard.type(process.env.G500_PASS, { delay: 35 });
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button,input[type=submit],a')).find((x) => /^\s*ingresar\s*$/i.test(x.textContent || x.value || ''));
      if (b) b.click();
    });
    await sleep(7000);

    console.log('2. misFacturas.aspx...');
    await page.goto('https://g500facturagas.azurewebsites.net/misFacturas.aspx', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(6000);
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('a,button,input[type=button],input[type=submit],label'))
        .filter((x) => x.offsetParent).find((x) => /mes actual/i.test(x.textContent || x.value || ''));
      if (b) b.click();
    });
    await sleep(9000);

    const filas = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('tr').forEach((tr, i) => {
        const c = Array.from(tr.querySelectorAll('td')).map((td) => (td.textContent || '').trim());
        const folio = c.find((x) => /^[A-Z]\d{5,7}$/.test(x));
        if (!folio) return;
        out.push({
          i, folio,
          monto: (c.find((x) => /^\$[\d,]+/.test(x)) || '').replace(/[^0-9.]/g, ''),
          estado: c.find((x) => /vigente|cancelad/i.test(x)) || '',
          fecha: c.find((x) => /^\d{2}\/\d{2}\/\d{4}/.test(x)) || '',
        });
      });
      return out;
    });
    console.log(`\n=== ${filas.length} factura(s) ===`);
    filas.forEach((f) => console.log(`  ${f.folio}  $${f.monto || '?'}  ${f.estado}  ${f.fecha}`));

    if (args.includes('--inspect')) {
      const info = await page.evaluate(() => {
        const tr = Array.from(document.querySelectorAll('tr')).find((t) => /W654/.test(t.innerText || ''));
        const btn = tr && tr.querySelector('button.pin');
        const r = { filaHtml: tr ? tr.outerHTML.slice(0, 700) : 'sin fila' };
        if (btn) {
          r.btnHtml = btn.outerHTML.slice(0, 200);
          r.onclick = btn.getAttribute('onclick');
          r.jqEvents = (window.jQuery && jQuery._data(btn, 'events')) ? Object.keys(jQuery._data(btn, 'events')) : 'sin jQuery._data';
          r.padreOnclick = btn.parentElement ? btn.parentElement.getAttribute('onclick') : null;
        }
        r.form = document.forms[0] ? { action: document.forms[0].action, nombre: document.forms[0].name } : null;
        r.doPostBack = typeof window.__doPostBack;
        return r;
      });
      console.log('=== INSPECCION ===');
      console.log(JSON.stringify(info, null, 1).slice(0, 2000));
      await browser.close();
      process.exit(0);
    }

    const objetivo = TODAS ? filas : filas.filter((f) => PEDIDAS.includes(f.folio));
    if (!objetivo.length) { console.log('\n(nada que bajar — pasa folios o --todas)'); await browser.close(); process.exit(0); }

    fs.mkdirSync(DESTINO, { recursive: true });
    console.log(`\n3. Bajando ${objetivo.length}...`);
    for (const f of objetivo) {
      const idx = filas.findIndex((x) => x.folio === f.folio);
      for (const [clase, tipo] of [['button.pin', 'xml'], ['button.soup', 'pdf']]) {
        const antes = capturados.length;
        // El <button> no tiene onclick ni handler propio: el manejador esta
        // DELEGADO, asi que el evento tiene que nacer en el <img> de dentro,
        // que es el target real. Pulsar el <button> no dispara nada.
        const handles = await page.$$(`${clase} img`);
        if (!handles[idx]) { console.log(`  ${f.folio} ${tipo}: sin boton`); continue; }
        await handles[idx].click().catch(() => {});
        await sleep(7000);
        const blobs = await page.evaluate(() => { const b = window.__blobs || []; window.__blobs = []; return b; });
        for (const b of blobs) capturados.push({ nombre: `${f.folio}.${tipo}`, buf: Buffer.from(b.b64, 'base64'), ct: tipo });
        console.log(`  ${f.folio} ${tipo}: ${capturados.length > antes ? '✅' : '— sin respuesta'}`);
      }
    }

    console.log(`\n${capturados.length} archivo(s) capturado(s)`);
    capturados.forEach((c, i) => {
      const ext = /xml/i.test(c.ct + c.nombre) ? 'xml' : /pdf/i.test(c.ct + c.nombre) ? 'pdf' : 'bin';
      const ruta = path.join(DESTINO, /\.(xml|pdf)$/i.test(c.nombre) ? c.nombre : `${c.nombre}.${ext}`);
      fs.writeFileSync(ruta, c.buf);
      console.log(`  💾 ${path.basename(ruta)} (${c.buf.length} bytes)`);
    });

    await browser.close();
    process.exit(capturados.length ? 0 : 1);
  } catch (e) {
    console.error('❌', e.message);
    await browser.close().catch(() => {});
    process.exit(1);
  }
})();
