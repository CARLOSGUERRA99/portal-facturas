// Segunda pasada de PINFRA: elegir AUTOPISTA SANTA ANA - ALTAR y ver qué pide
// de verdad — carriles disponibles y el rótulo de cada campo.
//
// El formulario tiene Fecha, NumeroId, consecutivo, total, hora y "cadena", y
// del ticket de Santa Ana solo se sabe con certeza fecha, hora, total, carril
// (2B) y el FOLIO 2-0000983716. Hace falta saber a qué campo va cada cosa
// antes de escribir el bot.
//
// ⚠️ SOLO LEE. Selecciona la caseta —que no consulta nada— y vuelca la
// pantalla. NO pulsa "Agregar Ticket" ni "Facturar".
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const puppeteer = require('puppeteer');

const RFC = process.argv[2] || 'GPR110128QD8';
const CORREO = process.argv[3] || 'carlosguerra@grupogpn.com';

(async () => {
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}&stealth=true`,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 950 });
  page.on('dialog', async (d) => { console.log('💬', d.message()); await d.accept().catch(() => {}); });

  try {
    await page.goto('https://www.pinfrafacturacion.com.mx/', { waitUntil: 'load', timeout: 35000 });
    await page.waitForTimeout(2000);
    await page.type('input#rfc', RFC, { delay: 35 });
    await page.type('input#correo', CORREO, { delay: 35 });
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button, input[type=submit], a')).find((x) => /ingresar/i.test(x.textContent || x.value || ''));
      if (b) b.click();
    });
    await page.waitForTimeout(5000);
    await page.goto('https://www.pinfrafacturacion.com.mx/Facturar/GenerarFactura', { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(3000);

    // Elegir la autopista: solo rellena el desplegable de carriles, no consulta.
    const elegida = await page.evaluate(() => {
      const s = document.querySelector('#cmbCaseta');
      const o = Array.from(s.options).find((x) => /santa\s*ana.*altar/i.test(x.textContent));
      if (!o) return null;
      s.value = o.value;
      s.dispatchEvent(new Event('change', { bubbles: true }));
      return `${o.textContent.trim()} (value=${o.value})`;
    });
    console.log('caseta elegida:', elegida);
    await page.waitForTimeout(4000);

    const d = await page.evaluate(() => {
      const vis = (e) => e.offsetParent !== null;
      // El rótulo de cada campo es el texto que le queda justo encima o al lado.
      const rotulo = (el) => {
        const r = el.getBoundingClientRect();
        const cand = Array.from(document.querySelectorAll('label, span, div, th, p'))
          .filter((t) => vis(t) && t.children.length === 0 && (t.textContent || '').trim().length > 1)
          .map((t) => ({ txt: t.textContent.trim(), r: t.getBoundingClientRect() }))
          .filter((t) => t.r.bottom <= r.top + 6 && r.top - t.r.bottom < 60 && Math.abs(t.r.left - r.left) < 160)
          .sort((a, b) => b.r.bottom - a.r.bottom)[0];
        return cand ? cand.txt : '(sin rótulo)';
      };
      return {
        campos: Array.from(document.querySelectorAll('input[type=text], input:not([type]), textarea')).filter(vis)
          .map((i) => ({
            id: i.id || i.name || '?',
            rotulo: rotulo(i),
            val: i.value || '',
            requerido: i.required || i.getAttribute('data-val-required') || i.classList.contains('required') || false,
            maxlen: i.maxLength > 0 ? i.maxLength : null,
          })),
        carriles: Array.from(document.querySelectorAll('#CarrilId option')).map((o) => o.textContent.trim()),
        avisos: Array.from(document.querySelectorAll('.field-validation-error, .validation-summary-errors, .text-danger, .alert'))
          .filter(vis).map((e) => e.textContent.trim().replace(/\s+/g, ' ')).filter(Boolean),
      };
    });

    console.log('\n--- campos con su rótulo ---');
    d.campos.forEach((c) => console.log(`   ${String(c.id).padEnd(12)} «${c.rotulo}»  val="${c.val}"${c.maxlen ? ` max=${c.maxlen}` : ''}${c.requerido ? '  [requerido]' : ''}`));
    console.log('\n--- carriles de Santa Ana - Altar ---');
    d.carriles.forEach((c) => console.log('   ·', c));
    if (d.avisos.length) console.log('\n--- avisos ---', d.avisos.join(' | '));

    await browser.close();
    process.exit(0);
  } catch (e) {
    console.error('❌', e.message);
    await browser.close().catch(() => {});
    process.exit(1);
  }
})();
