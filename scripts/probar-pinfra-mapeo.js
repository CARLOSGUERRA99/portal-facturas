// Comprueba el MAPEO de campos de PINFRA con el ticket real #208 antes de
// escribir el bot. Si el mapeo está mal, el bot entero estaría mal.
//
// Hipótesis, del ticket "FOLIO = 2-0000983716 CARRIL:2B":
//     Caseta      → AUTOPISTA SANTA ANA - ALTAR
//     Número Id   → 2            (lo de antes del guion; el campo admite 7)
//     Consecutivo → 0000983716   (lo de después; el campo admite 10, y son 10)
//     Máquina     → 02B          (el CARRIL, con cero delante como en la lista)
//     Fecha/Hora/Total → 8/2/2026 (M/D/YYYY, como el valor por defecto del portal), 18:40:08, 139.00
//
// Llega hasta "Agregar Ticket" y se PARA ahí: no pulsa Facturar. El portal
// tiene "Liberar Ticket Seleccionado", así que añadir es reversible; timbrar no.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const puppeteer = require('puppeteer');

const T = JSON.parse(process.argv[2] || '{"numeroId":"2","consecutivo":"0000983716","maquina":"02B","fecha":"8/2/2026","hora":"18:40:08","total":"139.00"}');

(async () => {
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}&stealth=true`,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1100 });
  page.on('dialog', async (d) => { console.log('💬 DIALOG:', d.message()); await d.accept().catch(() => {}); });

  // ⚠️ NO se puede click+type: #Fecha abre un datepicker que tapa el resto del
  // formulario, así que los clics siguientes caen en el calendario y los demás
  // campos se quedan vacíos (pasó en la primera corrida: NumeroId, consecutivo
  // y total salieron ""). Se asigna el valor y se avisa a jQuery a mano.
  const escribir = (sel, v) => page.evaluate((s, val) => {
    const e = document.querySelector(s);
    if (!e) return false;
    e.value = val;
    ['input', 'change', 'keyup', 'blur'].forEach((ev) => e.dispatchEvent(new Event(ev, { bubbles: true })));
    return true;
  }, sel, v);

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
    await page.waitForTimeout(3000);

    await page.select('#cmbCaseta', '38');   // AUTOPISTA SANTA ANA - ALTAR
    await page.waitForTimeout(3500);

    await escribir('#Fecha', T.fecha);
    await escribir('#NumeroId', T.numeroId);
    await escribir('#consecutivo', T.consecutivo);
    await escribir('#total', T.total);
    await escribir('#hora', T.hora);

    const maq = await page.evaluate((m) => {
      const s = document.querySelector('#CarrilId');
      const o = Array.from(s.options).find((x) => x.textContent.trim() === m);
      if (!o) return Array.from(s.options).map((x) => x.textContent.trim());
      s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true }));
      return o.textContent.trim();
    }, T.maquina);
    console.log('máquina:', maq);

    const antes = await page.evaluate(() => ({
      valores: ['Fecha', 'NumeroId', 'consecutivo', 'total', 'hora'].map((id) => `${id}=${document.querySelector('#' + id)?.value}`),
      caseta: document.querySelector('#cmbCaseta')?.selectedOptions[0]?.textContent.trim(),
      filas: document.querySelectorAll('#idTablaTickets tbody tr').length,
    }));
    console.log('a punto de enviar:', JSON.stringify(antes));

    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button, input[type=submit], a')).find((x) => /agregar\s*ticket/i.test(x.textContent || x.value || ''));
      if (b) b.click();
    });
    await page.waitForTimeout(7000);

    const despues = await page.evaluate(() => ({
      url: location.href,
      avisos: Array.from(document.querySelectorAll('.field-validation-error, .validation-summary-errors, .text-danger, .alert, .modal'))
        .filter((e) => e.offsetParent !== null).map((e) => e.textContent.trim().replace(/\s+/g, ' ')).filter(Boolean).slice(0, 6),
      tabla: Array.from(document.querySelectorAll('table tr')).map((t) => t.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 8),
      textoRelevante: (document.body.innerText.match(/.{0,90}(no se encontr|no existe|incorrect|error|agregad|éxito|exito|ya fue|factura).{0,90}/gi) || []).slice(0, 5),
    }));
    console.log('\n═══ TRAS AGREGAR TICKET ═══');
    console.log('url:', despues.url);
    console.log('avisos:', despues.avisos.join(' | ') || '(ninguno)');
    console.log('coincidencias:', despues.textoRelevante.join('\n   ') || '(ninguna)');
    console.log('tabla:'); despues.tabla.forEach((t) => console.log('   ', t));

    await browser.close();
    process.exit(0);
  } catch (e) {
    console.error('❌', e.message);
    await browser.close().catch(() => {});
    process.exit(1);
  }
})();
