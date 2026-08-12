// El modal de "Uso del CFDI" de PINFRA: volcar su DOM entero para encontrar el
// botón que de verdad confirma.
//
// En el intento anterior busqué por texto /facturar|aceptar|continuar/ y me
// quedé con el "Facturar" de FUERA del modal, así que el modal se reabrió y no
// se timbró nada. El ticket #210 sigue reservado en "Tickets por Facturar".
//
// ⚠️ SOLO LEE. Abre el modal y lo describe. No pulsa nada dentro.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}&stealth=true`,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1100 });
  page.on('dialog', async (d) => { console.log('💬', d.message()); await d.accept().catch(() => {}); });

  try {
    await page.goto('https://www.pinfrafacturacion.com.mx/', { waitUntil: 'load', timeout: 35000 });
    await page.waitForTimeout(2000);
    await page.type('input#rfc', 'GPR110128QD8', { delay: 30 });
    await page.type('input#correo', 'carlosguerra@grupogpn.com', { delay: 30 });
    await page.evaluate(() => {
      const x = Array.from(document.querySelectorAll('button,input[type=submit],a')).find((e) => /ingresar/i.test(e.textContent || e.value || ''));
      if (x) x.click();
    });
    await page.waitForTimeout(5000);
    await page.goto('https://www.pinfrafacturacion.com.mx/Facturar/GenerarFactura', { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(4000);

    // Marcar la fila y abrir el modal.
    await page.evaluate(() => {
      document.querySelectorAll('table input[type=checkbox], table input[type=radio]').forEach((c) => { if (!c.checked) c.click(); });
    });
    await page.waitForTimeout(600);
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button, input[type=submit], a'))
        .find((x) => /^\s*facturar\s*$/i.test(x.textContent || x.value || '') && x.offsetParent);
      if (b) b.click();
    });
    await page.waitForTimeout(4000);

    // El aviso del uso de CFDI NO es un .modal: es contenido de la propia
    // página (querySelectorAll('.modal') dio 0). Se localiza por el <select>
    // que contiene G03 y se describe su contenedor.
    const zona = await page.evaluate(() => {
      const sel = Array.from(document.querySelectorAll('select'))
        .find((s) => Array.from(s.options).some((o) => /G03/i.test(o.textContent)));
      if (!sel) return { error: 'no hay ningún select con G03' };
      let cont = sel;
      for (let i = 0; i < 4 && cont.parentElement; i++) cont = cont.parentElement;
      return {
        selectId: sel.id || sel.name,
        visible: sel.offsetParent !== null,
        contenedor: `${cont.tagName.toLowerCase()}#${cont.id || '-'}.${(typeof cont.className === 'string' ? cont.className : '').slice(0, 50)}`,
        texto: (cont.innerText || '').replace(/\s+/g, ' ').slice(0, 260),
        pulsables: Array.from(cont.querySelectorAll('button, input[type=submit], input[type=button], a')).map((b) => ({
          etiqueta: (b.textContent || b.value || '').trim().slice(0, 40),
          tag: b.tagName.toLowerCase(), id: b.id || '', name: b.name || '',
          clases: (typeof b.className === 'string' ? b.className : '').slice(0, 50),
          onclick: (b.getAttribute('onclick') || '').slice(0, 90),
          visible: b.offsetParent !== null,
        })),
      };
    });
    console.log('\n═══ ZONA DEL USO DE CFDI ═══');
    console.log(JSON.stringify(zona, null, 1));

    // Y todo lo pulsable visible de la página, para no volver a coger el de fuera.
    const todos = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button, input[type=submit], input[type=button], a'))
        .filter((b) => b.offsetParent !== null)
        .map((b) => `<${b.tagName.toLowerCase()}> "${(b.textContent || b.value || '').trim().slice(0, 34)}" id=${b.id || '-'} onclick=${(b.getAttribute('onclick') || '-').slice(0, 60)}`));
    console.log('\n═══ TODO LO PULSABLE VISIBLE ═══');
    [...new Set(todos)].forEach((t) => console.log('  ', t));

    const d = await page.evaluate(() => {
      const modales = Array.from(document.querySelectorAll('.modal, [role=dialog], .ui-dialog, .swal-modal'))
        .filter((m) => m.offsetParent !== null);
      return modales.map((m) => ({
        id: m.id || '(sin id)',
        clases: typeof m.className === 'string' ? m.className : '',
        texto: (m.innerText || '').replace(/\s+/g, ' ').slice(0, 300),
        // TODO lo pulsable de dentro, con sus atributos: aquí está el bueno.
        pulsables: Array.from(m.querySelectorAll('button, input[type=submit], input[type=button], a'))
          .map((b) => ({
            etiqueta: (b.textContent || b.value || '').trim().slice(0, 40),
            tag: b.tagName.toLowerCase(),
            id: b.id || '',
            clases: (typeof b.className === 'string' ? b.className : '').slice(0, 60),
            onclick: (b.getAttribute('onclick') || '').slice(0, 80),
            href: (b.getAttribute('href') || '').slice(0, 60),
            visible: b.offsetParent !== null,
          })),
        selects: Array.from(m.querySelectorAll('select')).map((s) => s.id || s.name),
      }));
    });

    console.log(`modales visibles: ${d.length}`);
    for (const m of d) {
      console.log(`\n═══ modal #${m.id} .${m.clases} ═══`);
      console.log('texto:', m.texto);
      console.log('selects:', m.selects.join(', ') || '(ninguno)');
      console.log('pulsables:');
      m.pulsables.forEach((b) => console.log(`   ${b.visible ? '👁️ ' : '   '} <${b.tag}> "${b.etiqueta}"  id=${b.id || '-'}  class=${b.clases || '-'}  onclick=${b.onclick || '-'}  href=${b.href || '-'}`));
    }

    await browser.close();
    process.exit(0);
  } catch (e) {
    console.error('❌', e.message);
    await browser.close().catch(() => {});
    process.exit(1);
  }
})();
