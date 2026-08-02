// Reconocimiento del calendario de AutoZone (CDC Origon Cloud / Interfactura).
//
// Motivo: bots/autozone.js navega el calendario con selectores de Angular
// Material — .mat-calendar-period-button, .mat-calendar-previous-button,
// .mat-calendar-next-button — y NINGUNO de los tres existe en este portal.
// Medido el 02/08/2026: el cuerpo del calendario SÍ es Material
// (button.mat-calendar-body-cell + .mat-calendar-body-disabled), pero la
// cabecera es del portal. Resultado: el bot no puede cambiar de mes, clickea el
// día en el mes equivocado (deshabilitado) y muere dos pasos después con
// "no apareció el campo de monto".
//
// Esta sonda vuelca la cabecera real para poder arreglar la navegación.
// NO factura nada: se detiene en el paso de la fecha.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const puppeteer = require('puppeteer');

const URL = 'https://autozone.cdc.origon.cloud/facturacion/autozone';
const BARCODE = '07047995272072726';

(async () => {
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}&stealth=true`,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('dialog', async (d) => { await d.accept().catch(() => {}); });

  const clickNav = async (txt) => {
    const r = await page.evaluate((t) => {
      const d = Array.from(document.querySelectorAll('div.navigation-container'))
        .find((d) => d.textContent.trim() === t && d.getBoundingClientRect().width > 5);
      if (!d) return null;
      const b = d.getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    }, txt);
    if (!r) return false;
    await page.mouse.click(r.x, r.y);
    await page.waitForTimeout(300);
    return true;
  };

  try {
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 45000 });
    await page.waitForTimeout(3000);
    await page.evaluate(() => {
      const a = Array.from(document.querySelectorAll('a')).find((a) => /facturaci[oó]n\s+r[aá]pida/i.test(a.textContent));
      if (a) a.click();
    });
    await page.waitForTimeout(2000);
    await clickNav('Iniciar');
    await page.waitForTimeout(3000);

    const inp = await page.waitForSelector('#mat-input-0', { timeout: 10000 });
    await inp.click({ clickCount: 3 });
    await inp.type(BARCODE, { delay: 50 });
    await clickNav('Siguiente');
    await page.waitForTimeout(3500);

    // Abrir el desplegable del MES para ver qué pinta.
    await page.evaluate(() => {
      const m = Array.from(document.querySelectorAll('span.example-header-label'))
        .find((s) => /[a-zá-ú]/i.test(s.textContent.trim()));
      if (m) m.click();
    });
    await page.waitForTimeout(1500);

    const info = await page.evaluate(() => {
      const vis = (el) => el.offsetParent !== null && el.getBoundingClientRect().width > 0;
      const desc = (el) => ({
        tag: el.tagName.toLowerCase(),
        clases: typeof el.className === 'string' ? el.className.slice(0, 70) : '',
        id: el.id || '',
        texto: (el.textContent || '').trim().slice(0, 30),
        hijos: el.children.length,
        cursor: getComputedStyle(el).cursor,
      });

      const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

      // Todo lo visible cuyo texto sea exactamente un mes o un año: son los
      // controles de la cabecera, sea cual sea la etiqueta que use el portal.
      const cabecera = Array.from(document.querySelectorAll('*'))
        .filter(vis)
        .filter((el) => {
          const t = (el.textContent || '').trim().toLowerCase();
          return MESES.includes(t) || /^(19|20)\d{2}$/.test(t);
        })
        .map(desc);

      const cal = document.querySelector('mat-calendar');
      const habilitados = Array.from(document.querySelectorAll('button.mat-calendar-body-cell'))
        .filter((b) => !b.classList.contains('mat-calendar-body-disabled'))
        .map((b) => b.textContent.trim());

      return {
        hayMatCalendar: !!cal,
        selectoresMaterialQueUsaElBot: {
          periodButton: document.querySelectorAll('.mat-calendar-period-button').length,
          previousButton: document.querySelectorAll('.mat-calendar-previous-button').length,
          nextButton: document.querySelectorAll('.mat-calendar-next-button').length,
        },
        cabecera,
        diasHabilitados: habilitados,
        htmlCalendario: cal ? cal.outerHTML.slice(0, 900) : null,
      };
    });

    console.log(JSON.stringify(info, null, 1));
    await browser.close();
    process.exit(0);
  } catch (e) {
    console.error('❌', e.message);
    await browser.close().catch(() => {});
    process.exit(1);
  }
})();
