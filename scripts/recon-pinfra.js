// Reconocimiento de pinfrafacturacion.com.mx para los tickets de
// CONCESIONARIA SANTA ANA-ALTAR (#208 y #210).
//
// Carlos confirma que NO hace falta registrarse: se entra con RFC + correo, y
// si el RFC ya tiene datos fiscales cargados el portal los abre solos.
//
// ⚠️ SOLO LEE. Entra y vuelca la pantalla siguiente para ver qué campos pide y
// si la Plaza Santa Ana está en la lista. NO envía ninguna consulta de folio:
// hasta no saber si este portal reserva el folio al consultarlo (CAPUFE sí, y
// así se quemó el #199), no se toca nada.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const puppeteer = require('puppeteer');

const RFC = process.argv[2] || 'GPR110128QD8';
const CORREO = process.argv[3] || 'buzonfacturas@serviciosga.site';

(async () => {
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}&stealth=true`,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 950 });
  page.on('dialog', async (d) => { console.log('💬', d.message()); await d.accept().catch(() => {}); });

  const vuelca = async (etapa) => {
    const d = await page.evaluate(() => {
      const vis = (e) => e.offsetParent !== null;
      return {
        url: location.href,
        texto: (document.body.innerText || '').replace(/\n{2,}/g, '\n').trim().slice(0, 900),
        campos: Array.from(document.querySelectorAll('input, textarea')).filter(vis)
          .map((i) => `${i.id || i.name || '?'} [${i.type}] ph="${i.placeholder || ''}" val="${(i.value || '').slice(0, 24)}"`),
        selects: Array.from(document.querySelectorAll('select')).filter(vis).map((s) => ({
          id: s.id || s.name || '?',
          n: s.options.length,
          santaAna: Array.from(s.options).map((o) => o.textContent.trim()).filter((t) => /santa\s*ana|altar/i.test(t)),
          muestra: Array.from(s.options).map((o) => o.textContent.trim()).filter(Boolean).slice(0, 12),
        })),
        botones: [...new Set(Array.from(document.querySelectorAll('button, input[type=submit], input[type=button], a'))
          .filter(vis).map((e) => (e.textContent || e.value || '').trim().replace(/\s+/g, ' '))
          .filter((t) => t && t.length < 40))],
      };
    });
    console.log(`\n═══ ${etapa} ═══\n${d.url}`);
    console.log('--- texto ---\n' + d.texto);
    console.log('--- campos ---'); d.campos.forEach((c) => console.log('   ', c));
    for (const s of d.selects) {
      console.log(`    select ${s.id}: ${s.n} opciones${s.santaAna.length ? `   ← ✅ ${s.santaAna.join(', ')}` : ''}`);
      if (s.n <= 20) s.muestra.forEach((o) => console.log('        ·', o));
    }
    console.log('--- botones ---', d.botones.join(' · '));
  };

  try {
    await page.goto('https://www.pinfrafacturacion.com.mx/', { waitUntil: 'load', timeout: 35000 });
    await page.waitForTimeout(2500);
    await vuelca('ENTRADA');

    await page.type('input#rfc, input[name=rfc]', RFC, { delay: 40 });
    await page.type('input#correo, input[name=correo]', CORREO, { delay: 40 });
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button, input[type=submit], a'))
        .find((x) => /ingresar/i.test((x.textContent || x.value || '')));
      if (b) b.click();
    });
    await page.waitForTimeout(6000);
    await vuelca('TRAS INGRESAR');

    // Si hay un menú, buscar la vía de "facturar ticket de caseta".
    const opcion = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('a, button, li'))
        .find((x) => /caseta|ticket|facturar|nueva factura/i.test(x.textContent || '') && x.offsetParent);
      if (!b) return null;
      const t = b.textContent.trim(); b.click(); return t;
    });
    if (opcion) {
      console.log(`\n➡️ pulsado: "${opcion}"`);
      await page.waitForTimeout(5000);
      await vuelca('PANTALLA DE FACTURACIÓN');
    }

    await browser.close();
    process.exit(0);
  } catch (e) {
    console.error('❌', e.message);
    await vuelca('estado al fallar').catch(() => {});
    await browser.close().catch(() => {});
    process.exit(1);
  }
})();
