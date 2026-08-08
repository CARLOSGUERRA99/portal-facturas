// Sonda del portal Carl's Jr (ICR) para el ticket #206.
//
// Motivo: el bot lleva 6 intentos devolviendo "referencia no encontrada o
// datos del ticket inválidos". Ese texto NO es un diagnóstico: es el catch de
// un waitForSelector('#txt_cucfdi') que expiró a los 20 s. El bot no sabe por
// qué falló — solo sabe que el formulario fiscal no apareció.
//
// Además hay una discrepancia sin resolver: el OCR leyó el portal del ticket
// como https://egridhub.com:6027/icr, pero bots/carljr.js va a
// https://retailedx.com/ICR4/. Puede que ICR haya movido el portal.
//
// Esta sonda NO factura: se detiene justo después de pulsar Siguiente y vuelca
// lo que hay en pantalla.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const puppeteer = require('puppeteer');

const REFERENCIA = '56909277201446';
const RFC = process.argv[2] || 'GPR110128QD8';

(async () => {
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}&stealth=true`,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('dialog', async (d) => { console.log('💬 dialog:', d.message()); await d.accept().catch(() => {}); });

  const vuelca = async (etapa) => {
    const d = await page.evaluate(() => ({
      url: location.href,
      titulo: document.title,
      texto: (document.body.innerText || '').replace(/\n{2,}/g, '\n').trim().slice(0, 1200),
      campos: Array.from(document.querySelectorAll('input, select, textarea'))
        .filter((e) => e.offsetParent !== null)
        .map((e) => `${e.tagName.toLowerCase()}#${e.id || '(sin id)'} [${e.type || ''}] val="${(e.value || '').slice(0, 30)}"`),
      botones: Array.from(document.querySelectorAll('button, input[type=button], input[type=submit], a'))
        .filter((e) => e.offsetParent !== null)
        .map((e) => (e.textContent || e.value || '').trim().replace(/\s+/g, ' '))
        .filter((t) => t && t.length < 40),
    }));
    console.log(`\n═══ ${etapa} ═══`);
    console.log('URL:', d.url, '|', d.titulo);
    console.log('--- texto ---\n' + d.texto);
    console.log('--- campos visibles ---'); d.campos.forEach((c) => console.log('   ', c));
    console.log('--- botones/enlaces ---', [...new Set(d.botones)].join(' · '));
  };

  try {
    // ¿Sigue vivo retailedx.com, o el portal se mudó a egridhub?
    for (const url of ['https://retailedx.com/ICR4/', 'https://egridhub.com:6027/icr']) {
      const r = await page.goto(url, { waitUntil: 'load', timeout: 30000 }).catch((e) => ({ err: e.message }));
      console.log(`🌐 ${url} → ${r?.err ? 'ERROR ' + r.err : r.status() + ' · quedó en ' + page.url()}`);
    }

    await page.goto('https://retailedx.com/ICR4/', { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(2000);
    if (!(await page.$('#txt_ticket'))) {
      await page.evaluate(() => {
        const b = Array.from(document.querySelectorAll('a, button, input[type=button], input[type=submit]'))
          .find((el) => /genere|factura|generar|iniciar/i.test(el.textContent || el.value || ''));
        if (b) b.click();
      });
      await page.waitForTimeout(3000);
    }
    await page.waitForSelector('#txt_ticket', { timeout: 15000 });
    await vuelca('PASO 1 — formulario inicial');

    await page.type('#txt_ticket', REFERENCIA, { delay: 60 });
    await page.type('#txt_rfccliente', RFC, { delay: 60 });
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button, input[type=submit], input[type=button], a'))
        .find((x) => /siguiente/i.test(x.textContent || x.value || ''));
      if (b) b.click();
    });
    await page.waitForTimeout(6000);
    await vuelca('PASO 2 — tras pulsar Siguiente (aquí es donde muere el bot)');

    // El volcado de innerText se corta y el modal queda fuera. Lo pescamos aparte:
    // ese "×" del final es un aviso que el bot nunca llegó a leer.
    const avisos = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.alert, .modal, [role=alert], .toast, .ui-dialog, .swal-modal, .sweet-alert, [class*=error], [class*=aviso], [class*=mensaje], span[id*=lbl], div[id*=msg]'))
        .filter((e) => e.offsetParent !== null && (e.textContent || '').trim())
        .map((e) => `[${e.tagName.toLowerCase()}#${e.id || ''}.${(typeof e.className === 'string' ? e.className : '').slice(0, 40)}] ${(e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 250)}`)
    );
    console.log('\n═══ AVISOS EN PANTALLA ═══');
    avisos.length ? [...new Set(avisos)].forEach((a) => console.log('  ⚠️ ', a)) : console.log('  (ninguno visible)');

    // El modal ofrece un botón "Detalle". Es la única fuente que dice POR QUÉ.
    const abrio = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button, a, input[type=button]'))
        .find((x) => /detalle/i.test((x.textContent || x.value || '').trim()) && x.offsetParent);
      if (!b) return false; b.click(); return true;
    });
    console.log('\nbotón Detalle pulsado:', abrio);
    if (abrio) {
      await page.waitForTimeout(2500);
      const det = await page.evaluate(() => (document.querySelector('#modalnotificacion')?.innerText || document.body.innerText).replace(/\s+/g, ' ').slice(0, 900));
      console.log('═══ DETALLE ═══\n' + det);
    }

    // ¿El campo que el bot espera existe de verdad, o solo está tapado?
    const cu = await page.evaluate(() => {
      const e = document.querySelector('#txt_cucfdi');
      if (!e) return 'NO EXISTE';
      const r = e.getBoundingClientRect();
      return `existe · visible=${e.offsetParent !== null} · ${r.width}x${r.height} · display=${getComputedStyle(e).display}`;
    });
    console.log('\n#txt_cucfdi →', cu);
    await browser.close();
    process.exit(0);
  } catch (e) {
    console.error('❌', e.message);
    await vuelca('estado al fallar').catch(() => {});
    await browser.close().catch(() => {});
    process.exit(1);
  }
})();
