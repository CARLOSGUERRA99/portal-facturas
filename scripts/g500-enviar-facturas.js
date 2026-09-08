/**
 * Recupera CFDIs YA TIMBRADOS en el portal G500 mandándolos al buzón de
 * captura, para que IMAP los recoja y los asocie solos.
 *
 * Sirve cuando el bot timbró de verdad pero no alcanzó a ver la pantalla de
 * confirmación y el ticket quedó en 'error': la factura existe en el SAT, así
 * que reintentar el bot solo generaría un duplicado. Lo correcto es traerse la
 * que ya está.
 *
 * Uso:
 *   node scripts/g500-enviar-facturas.js            → solo lista lo que hay
 *   node scripts/g500-enviar-facturas.js W65440 W65441   → envía esas
 *   node scripts/g500-enviar-facturas.js --todas    → envía todas las del mes
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const puppeteer = require('puppeteer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BUZON = process.env.IMAP_USER || 'buzonfacturas@serviciosga.site';
const args = process.argv.slice(2);
const TODAS = args.includes('--todas');
const INSPECT = args.includes('--inspect');
const DESCARGAR = args.includes('--descargar');
const DESTINO = require('path').join(__dirname, '..', 'tmp', 'g500');
const PEDIDAS = args.filter((a) => !a.startsWith('--')).map((s) => s.toUpperCase());

(async () => {
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}&stealth=true`,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000 });
  page.on('dialog', async (d) => { console.log('  dialog:', d.message()); await d.accept().catch(() => {}); });

  // Los botones PDF/XML del portal no son enlaces: arman un blob en el
  // navegador y disparan un <a download>. page.on('response') no ve nada de
  // eso, así que se engancha el click del ancla y se lee el blob en base64
  // desde dentro de la página. Mismo truco que en bots/carljr.js.
  await page.evaluateOnNewDocument(() => {
    window.__descargas = [];
    const guardar = (nombre, blobOrUrl) => {
      const p = typeof blobOrUrl === 'string' ? fetch(blobOrUrl).then((r) => r.blob()) : Promise.resolve(blobOrUrl);
      p.then((b) => new Promise((res) => {
        const fr = new FileReader();
        fr.onload = () => { window.__descargas.push({ nombre, b64: String(fr.result).split(',')[1] }); res(); };
        fr.readAsDataURL(b);
      })).catch(() => {});
    };
    // Se engancha createObjectURL además del click del ancla: hookear solo el
    // click no basta si la página dispara la descarga con dispatchEvent, con
    // window.open o creando el ancla fuera del DOM. Con createObjectURL el blob
    // se captura pase lo que pase después.
    const origCOU = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function (obj) {
      try { if (obj instanceof Blob) guardar(`blob_${Date.now()}_${window.__descargas.length}`, obj); } catch (e) {}
      return origCOU(obj);
    };
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      const href = this.href || '';
      if (href.startsWith('blob:') || href.startsWith('data:')) {
        guardar(this.download || 'archivo', href);
        return;
      }
      return origClick.apply(this, arguments);
    };
  });

  try {
    console.log('1. Entrando al portal G500...');
    await page.goto(`https://g500facturagas.azurewebsites.net/?PermisoCRE=${process.env.G500_PERMISO_CRE}&seccion=`,
      { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(3500);
    await page.click('#mailUser'); await page.keyboard.type(process.env.G500_USER, { delay: 35 });
    await page.click('#pwdUser');  await page.keyboard.type(process.env.G500_PASS, { delay: 35 });
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button,input[type=submit],a')).find(x => /^\s*ingresar\s*$/i.test(x.textContent || x.value || ''));
      if (b) b.click();
    });
    await sleep(7000);

    console.log('2. Mis facturas → Mes Actual...');
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('a,button,div[onclick]')).filter(x => x.offsetParent)
        .find(x => /^\s*mis facturas\s*$/i.test((x.textContent || '').trim()));
      if (b) b.click();
    });
    await sleep(8000);
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('a,button,input[type=button],input[type=submit],label'))
        .filter(x => x.offsetParent).find(x => /mes actual/i.test(x.textContent || x.value || ''));
      if (b) b.click();
    });
    await sleep(9000);

    // Cada fila trae el folio y su propio control de "Enviar".
    // ⚠️ El MONTO y el estado (Vigente/Cancelada) van en columnas ocultas
    // (style="display:none"), así que innerText NO los trae. Hay que leer
    // textContent celda por celda. Sin el monto no se puede emparejar una
    // factura con su ticket, que es justo para lo que sirve este script.
    const filas = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('tr').forEach((tr, i) => {
        const celdas = Array.from(tr.querySelectorAll('td')).map((td) => (td.textContent || '').trim());
        const folio = celdas.find((c) => /^[A-Z]\d{5,7}$/.test(c));
        if (!folio) return;
        out.push({
          i,
          folio,
          cliente: celdas.find((c) => /GPN|S\.?A\.?|RECUBRIM/i.test(c)) || '',
          fecha: celdas.find((c) => /^\d{2}\/\d{2}\/\d{4}/.test(c)) || '',
          estado: celdas.find((c) => /vigente|cancelad/i.test(c)) || '',
          monto: (celdas.find((c) => /^\$[\d,]+/.test(c)) || '').replace(/[^0-9.]/g, ''),
        });
      });
      return out;
    });
    console.log(`\n=== ${filas.length} facturas en el periodo ===`);
    filas.forEach((f) => console.log(`  ${f.folio}  $${f.monto || '?'}  ${f.estado || '?'}  ${f.fecha}  ${f.cliente.slice(0, 32)}`));

    if (INSPECT) {
      const html = await page.evaluate((f) => {
        const tr = Array.from(document.querySelectorAll('tr')).find(t => new RegExp(f).test(t.innerText || ''));
        return tr ? tr.outerHTML.slice(0, 3000) : 'sin fila';
      }, filas[0] ? filas[0].folio : 'W');
      console.log('\n=== HTML de la primera fila ===');
      console.log(html);

      await page.evaluate((f) => {
        const tr = Array.from(document.querySelectorAll('tr')).find(t => new RegExp(f).test(t.innerText || ''));
        const img = tr && Array.from(tr.querySelectorAll('img')).find(x => /correo/i.test(x.getAttribute('src') || ''));
        if (img) (img.closest('button') || img).click();
      }, filas[0] ? filas[0].folio : 'W');
      await sleep(5000);
      const modal = await page.evaluate(() => ({
        inputs: Array.from(document.querySelectorAll('input,textarea')).filter(e => e.offsetParent)
          .map(e => ({ id: e.id, name: e.name, type: e.type, ph: e.placeholder || '', val: String(e.value || '').slice(0, 30) })),
        botones: Array.from(document.querySelectorAll('button,input[type=submit],a')).filter(e => e.offsetParent)
          .map(e => ({ txt: (e.textContent || e.value || '').trim().slice(0, 25), cls: (e.className || '').slice(0, 25) })).slice(0, 20),
        texto: document.body.innerText.replace(/\s+/g, ' ').slice(0, 400),
      }));
      console.log('\n=== MODAL tras pulsar el sobre ===');
      console.log(JSON.stringify(modal, null, 1));

      console.log('\n=== Peticiones que dispara el botón XML (click real) ===');
      const vistas = [];
      const onResp = async (r) => {
        const u = r.url();
        if (/\.(png|jpg|css|woff|js)(\?|$)/i.test(u)) return;
        vistas.push(`${r.status()} ${r.request().method()} ${u.slice(0, 150)} [${(r.headers()['content-type'] || '').slice(0, 40)}]`);
      };
      page.on('response', onResp);
      // Un .click() desde page.evaluate no dispara NADA en este portal: el
      // handler debe estar atado a eventos de ratón reales (o delegado por
      // jQuery/DataTables de forma que el click sintético no lo alcanza). Con
      // elementHandle.click(), que mueve el ratón de verdad, sí responde.
      const botones = await page.$$('button.pin');
      console.log(`  botones XML en la tabla: ${botones.length}`);
      if (botones[0]) await botones[0].click();
      await sleep(8000);
      page.off('response', onResp);
      vistas.forEach((v) => console.log('  ' + v));

      await browser.close();
      process.exit(0);
    }

    const objetivo = TODAS ? filas : filas.filter((f) => PEDIDAS.includes(f.folio));
    if (!objetivo.length) {
      console.log('\n(nada que hacer — pasa folios o --todas)');
      await browser.close();
      process.exit(0);
    }

    if (DESCARGAR) {
      const fs = require('fs');
      fs.mkdirSync(DESTINO, { recursive: true });
      console.log(`\n3. Descargando XML+PDF de ${objetivo.length} facturas a ${DESTINO}...`);
      for (const f of objetivo) {
        console.log(`  → ${f.folio}`);
        // Click REAL de Puppeteer: el .click() sintético desde evaluate no
        // dispara nada en este portal (comprobado, cero peticiones de red).
        for (const clase of ['button.pin', 'button.soup']) {
          const handles = await page.$$(clase);
          const idx = filas.findIndex((x) => x.folio === f.folio);
          if (handles[idx]) { await handles[idx].click().catch(() => {}); await sleep(6000); }
        }
      }
      await sleep(4000);
      const descargas = await page.evaluate(() => {
        const d = window.__descargas || [];
        window.__descargas = [];
        return d;
      });
      console.log(`\n  capturados: ${descargas.length} archivos`);
      for (const d of descargas) {
        const ruta = require('path').join(DESTINO, d.nombre);
        fs.writeFileSync(ruta, Buffer.from(d.b64, 'base64'));
        console.log(`  💾 ${d.nombre} (${Buffer.from(d.b64, 'base64').length} bytes)`);
      }
      await browser.close();
      process.exit(descargas.length ? 0 : 1);
    }

    console.log(`\n3. Enviando ${objetivo.length} a ${BUZON}...`);
    for (const f of objetivo) {
      console.log(`  → ${f.folio}`);
      // El control "Enviar" vive en la fila de su factura; se busca dentro de
      // ESA fila y no en toda la página, para no mandar la que no es.
      //
      // ⚠️ Los tres botones de la fila (PDF / XML / correo) no tienen texto,
      // ni title, ni alt, y sus clases son ruido generado ("soup", "pin",
      // "pea"). Lo ÚNICO que los distingue es el src del <img>:
      //   img/fg-nw/pdf.png · img/fg-nw/xml.png · img/fg-nw/correo.png
      // Buscar por texto o por clase devuelve "sin boton" siempre.
      // Click REAL: el .click() sintético desde page.evaluate no dispara nada
      // en este portal (comprobado, cero peticiones de red). Los botones de la
      // fila son, en orden, button.soup (PDF), button.pin (XML) y button.pea
      // (correo); el índice de la fila da cuál toca.
      const sobres = await page.$$('button.pea');
      const idx = filas.findIndex((x) => x.folio === f.folio);
      if (!sobres[idx]) { console.log('     ⚠️ sin boton de correo'); continue; }
      const antes = await page.evaluate(() => document.body.innerText.length);
      await sobres[idx].click();
      await sleep(5000);
      const hayModal = await page.evaluate(() =>
        !!Array.from(document.querySelectorAll('input[type=email],input[type=text]'))
          .filter(e => e.offsetParent)
          .find(e => /mail|correo/i.test(e.id + ' ' + e.name + ' ' + (e.placeholder || ''))));
      if (!hayModal) {
        // Sin modal: el portal manda al correo de la cuenta sin preguntar.
        const t = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
        const ok = /enviad|exito|correctamente/i.test(t);
        console.log(`     ${ok ? '✅ enviada al correo de la cuenta' : '⚠️ sin modal y sin confirmación (¿no hizo nada?)'}`);
        await sleep(2500);
        continue;
      }
      void antes;

      const enviado = await page.evaluate((correo) => {
        const inp = Array.from(document.querySelectorAll('input[type=email],input[type=text]'))
          .filter(e => e.offsetParent)
          .find(e => /mail|correo/i.test(e.id + ' ' + e.name + ' ' + (e.placeholder || '')));
        if (!inp) return 'sin campo de correo';
        inp.focus(); inp.value = correo;
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        const b = Array.from(document.querySelectorAll('button,input[type=submit],a')).filter(x => x.offsetParent)
          .find(x => /^\s*(enviar|aceptar)\s*$/i.test((x.textContent || x.value || '').trim()));
        if (!b) return 'sin boton enviar';
        b.click();
        return 'ok';
      }, BUZON);
      console.log(`     ${enviado === 'ok' ? '✅ enviada' : '⚠️ ' + enviado}`);
      await sleep(6000);
      // Cerrar el modal si quedó abierto, para que la siguiente fila sea clicable.
      await page.evaluate(() => {
        const c = Array.from(document.querySelectorAll('button,a,span')).filter(x => x.offsetParent)
          .find(x => /^\s*(cerrar|cancelar|×|x)\s*$/i.test((x.textContent || '').trim()));
        if (c) c.click();
      });
      await sleep(2500);
    }

    // ⚠️ Ojo con lo que se afirma aquí: la versión anterior decía "Listo, las
    // facturas llegarán al buzón" incluso cuando NINGUNA se había enviado.
    console.log('\nRevisa arriba cuáles salieron de verdad; solo las marcadas con ✅ llegarán al buzón.');
    await browser.close();
    process.exit(0);
  } catch (e) {
    console.error('❌', e.message);
    await browser.close().catch(() => {});
    process.exit(1);
  }
})();
