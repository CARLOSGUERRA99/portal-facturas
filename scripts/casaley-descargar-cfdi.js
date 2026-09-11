/**
 * Recupera el XML y el PDF de una factura YA emitida en Casa Ley y la asocia a
 * su ticket (R2 + tabla `facturas` + ticket a 'procesado').
 *
 * Para qué sirve: el bot de Casa Ley timbra bien, pero el portal NO manda el
 * CFDI por correo — hay que ir a buscarlo. El ticket se quedaba en
 * `procesando_correo` para siempre esperando un correo que nunca sale.
 *
 * El flujo del portal (mapeado en vivo el 11-sep-2026):
 *   BuscarFactura.aspx → RFC + número de ticket (el código de barras LARGO de
 *   24 dígitos del pie del ticket, no el folio corto) → "Siguiente" →
 *   FacturaListado.aspx muestra EMISOR/FOLIO/SERIE/CONTRIBUYENTE/FECHA.
 *
 * ⚠️ LA DESCARGA ES UN __doPostBack, NO UN ENLACE. "Descargar XML" y
 * "Descargar PDF" son `javascript:__doPostBack('...btnVerXML','')`. Pulsarlos
 * con Puppeteer dispara una descarga de navegador que en Browserless se pierde.
 * Lo que sí funciona es reenviar el formulario por fetch DENTRO de la página,
 * con el __EVENTTARGET correspondiente: la respuesta trae el archivo en el
 * cuerpo (text/xml y application/octet-stream).
 *
 * ⚠️ HAY QUE TECLEAR DE VERDAD en los dos campos. Son ASP.NET WebForms con
 * validadores de cliente; poner el .value y disparar eventos deja el postback
 * sin validar y la pantalla no avanza.
 *
 * Uso:
 *   node scripts/casaley-descargar-cfdi.js <ticketId> <numeroTicketLargo> [--dry]
 *   node scripts/casaley-descargar-cfdi.js 305 10510201639204007009051
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const TICKET_ID = Number(process.argv[2]);
const NUM_TICKET = process.argv[3];
const DRY = process.argv.includes('--dry');
const RFC = process.env.RFC_RECEPTOR || 'GPR110128QD8';
const BASE = 'https://aplicaciones.casaley.com.mx/facturacionelectronica/BuscarFactura.aspx';

if (!TICKET_ID || !NUM_TICKET) {
  console.error('Uso: node scripts/casaley-descargar-cfdi.js <ticketId> <numeroTicketLargo> [--dry]');
  process.exit(1);
}

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error('BROWSERLESS_TOKEN no definido');

  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true`,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('dialog', async (d) => { await d.accept().catch(() => {}); });

  try {
    console.log(`🌐 Casa Ley — consultando ticket ${NUM_TICKET} para ${RFC}`);
    await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 45000 });

    const SEL_RFC = '#ctl00_ContentPlaceHolder1_txtRFCVenta';
    const SEL_TK = '#ctl00_ContentPlaceHolder1_txtnoTicketVenta';
    await page.waitForSelector(SEL_RFC, { visible: true, timeout: 20000 });

    // Tecleo real: los validadores de WebForms no escuchan eventos sintéticos.
    const teclear = async (sel, valor) => {
      await page.click(sel);
      await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
      await page.keyboard.press('Delete');
      await page.keyboard.type(String(valor), { delay: 40 });
    };
    await teclear(SEL_RFC, RFC);
    await teclear(SEL_TK, NUM_TICKET);

    // "Siguiente" es un __doPostBack: navega. Sin el waitForNavigation, el
    // evaluate siguiente muere con "Execution context was destroyed".
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {}),
      page.evaluate(() => {
        const a = Array.from(document.querySelectorAll('a')).find((x) => /^\s*Siguiente\s*$/i.test((x.textContent || '').trim()));
        if (a) a.click();
      }),
    ]);
    await page.waitForTimeout(2000);

    const listado = await page.evaluate(() => ({
      url: location.href,
      texto: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 400),
      hayDescarga: Array.from(document.querySelectorAll('a')).some((a) => /Descargar XML/i.test(a.textContent || '')),
    }));
    console.log(`   ${listado.texto}`);

    if (!listado.hayDescarga) {
      console.error('❌ El portal no listó ninguna factura para ese RFC + ticket.');
      console.error('   Comprueba que el número sea el código de barras LARGO del pie del ticket.');
      await browser.close();
      process.exit(2);
    }

    // Reenvío del formulario por fetch con el __EVENTTARGET de cada botón: así
    // el archivo llega en el cuerpo de la respuesta en vez de como descarga.
    const bajar = async (target) => {
      const d = await page.evaluate(async (tg) => {
        const f = document.forms[0];
        const fd = new FormData(f);
        fd.set('__EVENTTARGET', tg);
        fd.set('__EVENTARGUMENT', '');
        const r = await fetch(location.href, {
          method: 'POST',
          body: new URLSearchParams([...fd.entries()]),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          credentials: 'include',
        });
        const b = await r.arrayBuffer();
        return { ct: r.headers.get('content-type') || '', bytes: Array.from(new Uint8Array(b)) };
      }, target).catch((e) => ({ error: e.message }));
      if (!d || d.error || !d.bytes || !d.bytes.length) return null;
      return Buffer.from(d.bytes);
    };

    const bufXml = await bajar('ctl00$ContentPlaceHolder1$btnVerXML');
    const bufPdf = await bajar('ctl00$ContentPlaceHolder1$btnVerDoc');
    await browser.close();

    if (!bufXml || !/cfdi:Comprobante/.test(bufXml.toString('utf8', 0, 200))) {
      console.error('❌ La respuesta del postback no es un CFDI.');
      process.exit(3);
    }

    const dir = path.join(__dirname, '..', 'tmp', 'cfdi');
    fs.mkdirSync(dir, { recursive: true });
    const fx = path.join(dir, `${TICKET_ID}.xml`);
    const fp = path.join(dir, `${TICKET_ID}.pdf`);
    fs.writeFileSync(fx, bufXml);
    if (bufPdf && bufPdf.length > 500) fs.writeFileSync(fp, bufPdf);
    console.log(`💾 ${fx} (${bufXml.length} b)${bufPdf ? ` · ${fp} (${bufPdf.length} b)` : ''}`);

    if (DRY) { console.log('🔎 --dry: no se asocia.'); process.exit(0); }

    // asociar-cfdi.js ya verifica total y RFC del receptor antes de escribir.
    const { spawnSync } = require('child_process');
    const args = [path.join(__dirname, 'asociar-cfdi.js'), String(TICKET_ID), fx];
    if (fs.existsSync(fp)) args.push(fp);
    const r = spawnSync(process.execPath, args, { stdio: 'inherit' });
    process.exit(r.status || 0);
  } catch (err) {
    console.error('❌', err.message);
    try { await browser.close(); } catch {}
    process.exit(1);
  }
})();
