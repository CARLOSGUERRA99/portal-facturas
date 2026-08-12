// Timbra los tickets que ya están en "Tickets por Facturar" de PINFRA.
//
// El flujo del portal son dos pasos: "Agregar Ticket" mete el ticket en una
// lista (reversible — hay "Liberar Ticket Seleccionado"), y "Facturar" timbra.
// Este script hace el segundo, y vuelca lo que aparece después para saber cómo
// entrega el CFDI (descarga directa o correo).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const puppeteer = require('puppeteer');

const RFC = process.argv[2] || 'GPR110128QD8';
const CORREO = process.argv[3] || 'carlosguerra@grupogpn.com';

(async () => {
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}&stealth=true`,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1100 });
  page.on('dialog', async (d) => { console.log('💬 DIALOG:', d.message()); await d.accept().catch(() => {}); });

  try {
    await page.goto('https://www.pinfrafacturacion.com.mx/', { waitUntil: 'load', timeout: 35000 });
    await page.waitForTimeout(2000);
    await page.type('input#rfc', RFC, { delay: 30 });
    await page.type('input#correo', CORREO, { delay: 30 });
    await page.evaluate(() => {
      const x = Array.from(document.querySelectorAll('button,input[type=submit],a')).find((e) => /ingresar/i.test(e.textContent || e.value || ''));
      if (x) x.click();
    });
    await page.waitForTimeout(5000);
    await page.goto('https://www.pinfrafacturacion.com.mx/Facturar/GenerarFactura', { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(3500);

    const pendientes = await page.evaluate(() =>
      Array.from(document.querySelectorAll('table tr')).map((t) => t.innerText.replace(/\s+/g, ' ').trim())
        .filter((t) => t && !/^TICKET CONSECUTIVO/i.test(t) && !/nada encontrado/i.test(t)));
    console.log('en la lista por facturar:');
    pendientes.forEach((p) => console.log('   ', p));
    if (!pendientes.length) { console.log('nada que timbrar'); await browser.close(); process.exit(0); }

    // Marcar todo lo de la lista, por si el portal exige selección.
    await page.evaluate(() => {
      document.querySelectorAll('table input[type=checkbox], table input[type=radio]').forEach((c) => {
        if (!c.checked) { c.click(); }
      });
    });
    await page.waitForTimeout(800);

    const pulsado = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button, input[type=submit], a'))
        .find((x) => /^\s*facturar\s*$/i.test((x.textContent || x.value || '')) && x.offsetParent);
      if (!b) return false; b.click(); return true;
    });
    console.log('botón Facturar pulsado:', pulsado);
    await page.waitForTimeout(9000);

    // Tras Facturar sale un modal pidiendo el USO DEL CFDI. Sin elegirlo no
    // avanza, y el propio portal avisa de que un uso mal puesto obliga a
    // cancelar la factura.
    // El aviso del Uso del CFDI es div#modal-uso-cdfi — NO lleva clase .modal
    // ni role=dialog, así que buscarlo con '.modal, [role=dialog]' daba cero.
    const uso = await page.evaluate(() => {
      const sel = document.querySelector('#ClaveCDFI');
      if (!sel) return null;
      const o = Array.from(sel.options).find((x) => /^\s*G03/i.test(x.textContent));
      if (!o) return null;
      sel.value = o.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return o.textContent.trim();
    });
    console.log('uso CFDI:', uso || '(no apareció #ClaveCDFI)');
    await page.waitForTimeout(1200);

    // ⚠️ El botón de confirmar del aviso se llama IGUAL y tiene el MISMO id que
    // el "Facturar" de la tabla de fuera. Buscando por texto se cogía el de
    // fuera, que solo reabría el aviso: por eso el intento anterior no timbró
    // nada. Hay que anclarlo al contenedor.
    const confirmado = await page.evaluate(() => {
      const b = document.querySelector('#modal-uso-cdfi button#Facturar');
      if (!b || b.offsetParent === null) return null;
      b.click();
      return (b.textContent || '').trim();
    });
    console.log('confirmado con:', confirmado || '(no se encontró #modal-uso-cdfi button#Facturar)');
    await page.waitForTimeout(15000);

    const r = await page.evaluate(() => ({
      url: location.href,
      texto: (document.body.innerText || '').replace(/\n{2,}/g, '\n').trim().slice(0, 1200),
      enlaces: Array.from(document.querySelectorAll('a')).filter((a) => a.offsetParent)
        .map((a) => `${(a.textContent || '').trim()} → ${a.href}`).filter((t) => /xml|pdf|descarg|factura/i.test(t)).slice(0, 10),
      botones: [...new Set(Array.from(document.querySelectorAll('button, input[type=submit]')).filter((e) => e.offsetParent)
        .map((e) => (e.textContent || e.value || '').trim()).filter(Boolean))],
    }));
    console.log('\n═══ TRAS FACTURAR ═══');
    console.log('url:', decodeURIComponent(r.url));
    console.log('--- texto ---\n' + r.texto);
    console.log('--- enlaces de descarga ---', r.enlaces.join('\n   ') || '(ninguno)');
    console.log('--- botones ---', r.botones.join(' · '));

    await browser.close();
    process.exit(0);
  } catch (e) {
    console.error('❌', e.message);
    await browser.close().catch(() => {});
    process.exit(1);
  }
})();
