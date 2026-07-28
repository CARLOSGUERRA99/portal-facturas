require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

const REFERENCIA = '049847152458CE1';

async function seleccionarPorLabel(page, labelTexto, prefijoOpcion) {
  const selectHandle = await page.evaluateHandle((labelTexto) => {
    const candidatos = Array.from(document.querySelectorAll('*')).filter(el =>
      el.children.length === 0 && el.textContent.trim() === labelTexto
    );
    if (!candidatos.length) return null;
    const lbl = candidatos[candidatos.length - 1];
    const lblRect = lbl.getBoundingClientRect();
    const selects = Array.from(document.querySelectorAll('.mud-select'));
    let mejor = null, mejorDelta = Infinity;
    for (const s of selects) {
      const r = s.getBoundingClientRect();
      const delta = r.top - lblRect.bottom;
      if (delta >= -5 && delta < 40 && Math.abs(r.left - lblRect.left) < 60 && delta < mejorDelta) {
        mejor = s; mejorDelta = delta;
      }
    }
    return mejor;
  }, labelTexto);
  const selectEl = selectHandle.asElement();
  if (!selectEl) throw new Error(`seleccionarPorLabel("${labelTexto}"): no se encontró el select`);
  await selectEl.click();
  await page.waitForTimeout(900);
  const optionHandle = await page.evaluateHandle((prefijoOpcion) => {
    return Array.from(document.querySelectorAll('.mud-list-item')).find(el => el.textContent.trim().startsWith(prefijoOpcion)) || null;
  }, prefijoOpcion);
  const optionEl = optionHandle.asElement();
  if (!optionEl) throw new Error(`No se encontró la opción "${prefijoOpcion}" para "${labelTexto}"`);
  await optionEl.click();
  await page.waitForTimeout(600);
}

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('dialog', async d => { console.log('🔔 Dialog:', d.message()); await d.accept().catch(() => {}); });

  const netLog = [];
  page.on('response', async (resp) => {
    const ct = resp.headers()['content-type'] || '';
    if (/xml|pdf/i.test(ct) || /factur|invoice|cfdi/i.test(resp.url())) {
      netLog.push({ url: resp.url(), status: resp.status(), contentType: ct });
    }
  });

  await page.goto('https://factura.enerfueltech.com/', { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForTimeout(2500);
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button, a')).find(x => /facturar sin registro/i.test(x.textContent || ''));
    if (b) b.click();
  });
  await page.waitForTimeout(2000);

  const inputsVisibles = await page.$$('input[type="text"]');
  const refField = inputsVisibles[inputsVisibles.length - 1];
  await refField.click({ clickCount: 3 });
  await page.keyboard.type(REFERENCIA, { delay: 40 });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim() === 'Buscar');
    if (b) b.click();
  });
  await page.waitForTimeout(2500);
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim() === 'Continuar');
    if (b) b.click();
  });
  await page.waitForTimeout(1500);

  const panelHandle = await page.evaluateHandle(() => {
    const heading = Array.from(document.querySelectorAll('*')).find(el => el.children.length === 0 && el.textContent.trim() === 'Mis datos fiscales');
    return heading ? heading.closest('.mud-paper') || heading.parentElement.parentElement : null;
  });
  const nombreInput = (await panelHandle.evaluateHandle(panel => panel.querySelectorAll('input[type="text"]')[0])).asElement();
  const rfcInput = (await panelHandle.evaluateHandle(panel => panel.querySelectorAll('input[type="text"]')[1])).asElement();
  const cpInput = (await panelHandle.evaluateHandle(panel => panel.querySelectorAll('input[type="text"]')[2])).asElement();

  await nombreInput.click({ clickCount: 3 });
  await page.keyboard.type('GPN PINTURAS Y RECUBRIMIENTOS', { delay: 25 });
  await page.waitForTimeout(200);
  await rfcInput.click({ clickCount: 3 });
  await page.keyboard.type('GPR110128QD8', { delay: 25 });
  await page.waitForTimeout(800);
  await cpInput.click({ clickCount: 3 });
  await page.keyboard.type('80140', { delay: 25 });
  await page.waitForTimeout(500);

  console.log('➡️ Régimen: 601...');
  await seleccionarPorLabel(page, 'Régimen', '601');
  console.log('➡️ Uso CFDI: G03...');
  await seleccionarPorLabel(page, 'Uso CFDI', 'G03');

  const facturarHandle = await page.evaluateHandle(() => {
    return Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim() === 'FACTURAR' || x.textContent.trim() === 'Facturar') || null;
  });
  const facturarEl = facturarHandle.asElement();
  if (!facturarEl) throw new Error('No se encontró el botón FACTURAR');

  console.log('➡️ Click FACTURAR (envío real)...');
  await facturarEl.click();
  await page.waitForTimeout(5000);

  const bodyFinal = await page.evaluate(() => document.body.innerText.slice(0, 2500));
  console.log('\nBODY FINAL:\n', bodyFinal);

  console.log('\n=== NETWORK LOG (xml/pdf/factur) ===');
  console.log(JSON.stringify(netLog, null, 2));

  const buf = await page.screenshot({ fullPage: true });
  console.log('📸', await subirArchivoR2(buf, `debug/enerfueltech_resultado_${Date.now()}.png`, 'image/png'));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
