// ¿Dónde se factura un ticket de CONCESIONARIA SANTA ANA-ALTAR, S.A. DE C.V.?
//
// Los tickets #208 y #210 se detectaron como CAPUFE porque dicen "PLAZA DE
// COBRO", pero son de una concesionaria privada y su formato no trae el código
// de 18 caracteres que pide el portal de CAPUFE. Las páginas que salen al
// buscar se contradicen entre PINFRA, Zonalta y CAPUFE, y todas son SEO.
//
// ⚠️ SOLO LEE. No escribe en ningún campo ni pulsa ningún botón de consulta.
// El portal de CAPUFE RESERVA el código al validarlo: así se quemó el ticket
// #199 y se perdieron $48. Aquí únicamente se vuelcan las opciones visibles
// para ver si existe una vía para plazas concesionadas.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const puppeteer = require('puppeteer');

const DESTINOS = [
  'https://facturacioncapufe.com.mx/Capufe/facturacionrapida',
  'http://www.pinfrafacturacion.com.mx/',
];

(async () => {
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}&stealth=true`,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('dialog', async (d) => { console.log('💬', d.message()); await d.accept().catch(() => {}); });

  for (const url of DESTINOS) {
    console.log(`\n${'═'.repeat(64)}\n${url}`);
    const r = await page.goto(url, { waitUntil: 'load', timeout: 35000 }).catch((e) => ({ err: e.message }));
    if (r?.err) { console.log('  ❌', r.err); continue; }
    await page.waitForTimeout(3000);

    const info = await page.evaluate(() => {
      const vis = (e) => e.offsetParent !== null;
      return {
        url: location.href,
        titulo: document.title,
        // Un <select> de plazas es la pista: si Santa Ana está dentro, este es el sitio.
        selects: Array.from(document.querySelectorAll('select')).filter(vis).map((s) => ({
          id: s.id || s.name || '(sin id)',
          opciones: Array.from(s.options).map((o) => o.textContent.trim()).filter(Boolean).slice(0, 60),
        })),
        campos: Array.from(document.querySelectorAll('input')).filter(vis)
          .map((i) => `${i.id || i.name || '?'} [${i.type}] ${i.placeholder || ''}`),
        opciones: [...new Set(Array.from(document.querySelectorAll('a, button, [role=tab], li'))
          .filter(vis).map((e) => (e.textContent || '').trim().replace(/\s+/g, ' '))
          .filter((t) => t && t.length > 2 && t.length < 45))].slice(0, 35),
        mencionaSantaAna: /santa\s*ana|altar/i.test(document.body.innerText || ''),
      };
    });

    console.log(`  ${info.titulo}  ·  ${info.url}`);
    console.log(`  ¿menciona Santa Ana/Altar?  ${info.mencionaSantaAna ? 'SÍ' : 'no'}`);
    console.log('  opciones:', info.opciones.join(' · '));
    console.log('  campos:'); info.campos.forEach((c) => console.log('     ', c));
    for (const s of info.selects) {
      const hit = s.opciones.filter((o) => /santa\s*ana|altar/i.test(o));
      console.log(`     select ${s.id}: ${s.opciones.length} opciones${hit.length ? `  ← ✅ ${hit.join(', ')}` : ''}`);
      if (s.opciones.length <= 25) s.opciones.forEach((o) => console.log('        ·', o));
    }
  }

  await browser.close();
  process.exit(0);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
