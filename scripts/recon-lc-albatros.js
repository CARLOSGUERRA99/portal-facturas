// Reconocimiento de los dos portales que quedan: Little Caesars (analytix360)
// y Albatros Autobuses.
//
// ⚠️ SOLO LEE. Carga cada portal, avanza a la pantalla del formulario si hay un
// botón de entrada, y vuelca campos y botones. No envía ningún folio: hasta no
// saber si reservan el folio al consultarlo, no se toca (CAPUFE sí lo reserva,
// y así se quemó el ticket #199).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const puppeteer = require('puppeteer');

const DESTINOS = [
  ['Little Caesars', 'https://cfdi.analytix360.cloud/cafrema/'],
  ['Albatros', 'https://www.albatrosautobuses.com'],
];

(async () => {
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}&stealth=true`,
  });

  for (const [nombre, url] of DESTINOS) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 900 });
    page.on('dialog', async (d) => { console.log('💬', d.message()); await d.accept().catch(() => {}); });
    console.log(`\n${'═'.repeat(66)}\n${nombre} — ${url}`);
    try {
      const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch((e) => ({ err: e.message }));
      if (r?.err) { console.log('  ❌', r.err); await page.close(); continue; }
      await page.waitForTimeout(4000);

      const foto = async (etapa) => {
        const d = await page.evaluate(() => {
          const vis = (e) => e.offsetParent !== null;
          return {
            url: location.href,
            titulo: document.title,
            texto: (document.body.innerText || '').replace(/\n{2,}/g, '\n').trim().slice(0, 550),
            campos: Array.from(document.querySelectorAll('input, select, textarea')).filter(vis)
              .map((i) => `${i.tagName.toLowerCase()}#${i.id || i.name || '?'} [${i.type || ''}] ph="${i.placeholder || ''}"`),
            botones: [...new Set(Array.from(document.querySelectorAll('button, input[type=submit], input[type=button], a'))
              .filter(vis).map((e) => (e.textContent || e.value || '').trim().replace(/\s+/g, ' '))
              .filter((t) => t && t.length > 1 && t.length < 42))].slice(0, 22),
            iframes: Array.from(document.querySelectorAll('iframe')).map((f) => f.src).filter(Boolean),
            captcha: !!document.querySelector('.g-recaptcha, .cf-turnstile, iframe[src*=recaptcha], iframe[src*=turnstile]'),
          };
        });
        console.log(`\n  ── ${etapa} ──  ${d.titulo}  ·  ${d.url}`);
        console.log('  texto:', d.texto.replace(/\n/g, ' | ').slice(0, 400));
        console.log('  campos:'); d.campos.forEach((c) => console.log('     ', c));
        console.log('  botones:', d.botones.join(' · '));
        if (d.iframes.length) console.log('  iframes:', d.iframes.join(' , '));
        console.log('  ¿CAPTCHA en el DOM?', d.captcha ? '🛑 SÍ' : 'no');
        return d;
      };

      const a = await foto('entrada');

      // Si no hay campos, buscar el botón que abre el formulario de facturación.
      if (!a.campos.length) {
        const pulsado = await page.evaluate(() => {
          const b = Array.from(document.querySelectorAll('a, button'))
            .find((x) => /facturaci[oó]n|facturar|factura electr|generar factura/i.test(x.textContent || '') && x.offsetParent);
          if (!b) return null;
          const t = b.textContent.trim(); b.click(); return t;
        });
        console.log('\n  ➡️ pulsado:', pulsado || '(no había enlace de facturación)');
        if (pulsado) { await page.waitForTimeout(6000); await foto('formulario'); }
      }
    } catch (e) {
      console.log('  ❌', e.message);
    }
    await page.close().catch(() => {});
  }

  await browser.close();
  process.exit(0);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
