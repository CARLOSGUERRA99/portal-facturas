// Busca en el portal de CAPUFE la vía para RECUPERAR un código ya capturado.
//
// Situación real: el ticket #199 de DGA se validó (el backend respondió
// "Código verificado y guardado correctamente") pero el flujo no llegó a
// "Facturar conceptos". Ahora "Validar Código" responde "ya se encuentra
// capturado" y `buscar_tickets.json` devuelve lista vacía en una sesión nueva
// — es decir, el consumo está reservado pero fuera de alcance por esa puerta.
//
// El propio portal ofrece otra: hay que encontrarla y mapearla. Esta sonda
// recorre la navegación y vuelca las opciones y formularios disponibles.
// NO factura nada.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const puppeteer = require('puppeteer');

const CODIGO = process.argv[2] || 'K8KPKTZBHKSF7WMVHQ';

(async () => {
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}&stealth=true`,
  });
  const page = await browser.newPage();
  const api = [];
  page.on('response', async (r) => {
    if (!/capufe-quadrum-backend/i.test(r.url())) return;
    let b = null; try { b = await r.text(); } catch {}
    api.push({ url: r.url().split('/').slice(-2).join('/'), body: (b || '').slice(0, 300) });
  });

  await page.goto('https://facturacioncapufe.com.mx/Capufe/facturacionrapida', { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(2500);

  // Entrar en la opción de recuperación.
  const abierto = await page.evaluate(() => {
    const a = Array.from(document.querySelectorAll('a, button, li'))
      .find(e => /recuperar una factura/i.test(e.textContent || '') && e.offsetParent);
    if (!a) return false; a.click(); return true;
  });
  console.log('opción de recuperar pulsada:', abierto);
  await page.waitForTimeout(3000);

  const mapa = await page.evaluate(() => {
    const vis = (e) => e.offsetParent !== null && e.getBoundingClientRect().width > 5;
    const txt = (e) => (e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    return {
      titulo: document.title,
      // Todo lo navegable: menús, pestañas, enlaces y botones.
      opciones: [...new Set(Array.from(document.querySelectorAll('a, button, [role="tab"], .p-tabview-nav li, .nav-link'))
        .filter(vis).map(txt).filter(t => t.length > 2))].slice(0, 40),
      campos: Array.from(document.querySelectorAll('input')).filter(vis)
        .map(i => ({ id: i.id, ph: i.placeholder || i.getAttribute('data-placeholder') || '' })),
      // Cualquier texto que hable de recuperar/reimprimir/consultar.
      pistas: (document.body.innerText.match(/[^\n]*(recuper|reimprim|consult|descarg|ya factur)[^\n]*/gi) || []).slice(0, 10),
    };
  });

  console.log(JSON.stringify(mapa, null, 1));
  console.log('\nAPI tocada al cargar:');
  for (const a of api) console.log('  ', a.url, '→', a.body.slice(0, 120));

  await browser.close();
  process.exit(0);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
