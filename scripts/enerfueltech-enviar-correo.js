require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

const REFERENCIA = '049847152458CE1';
const CORREO_DESTINO = process.env.IMAP_USER; // buzonfacturas@serviciosga.site

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

  // Si ya está facturado (re-ejecución idempotente), "Continuar" puede no aparecer — verificar
  const yaFacturado = await page.evaluate(() => document.body.innerText.includes('Facturado') || document.body.innerText.includes('100 %'));
  if (yaFacturado) {
    console.log('ℹ️ El ticket ya aparece facturado tras la búsqueda (sin necesidad de repetir el formulario).');
  } else {
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
    await rfcInput.click({ clickCount: 3 });
    await page.keyboard.type('GPR110128QD8', { delay: 25 });
    await page.waitForTimeout(500);
    await cpInput.click({ clickCount: 3 });
    await page.keyboard.type('80140', { delay: 25 });
    await page.waitForTimeout(500);
    await seleccionarPorLabel(page, 'Régimen', '601');
    await seleccionarPorLabel(page, 'Uso CFDI', 'G03');
    const facturarHandle = await page.evaluateHandle(() => Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim() === 'FACTURAR') || null);
    const facturarEl = facturarHandle.asElement();
    if (facturarEl) { await facturarEl.click(); await page.waitForTimeout(5000); }
  }

  console.log(`➡️ Llenando correo (${CORREO_DESTINO}) y enviando...`);
  // El campo de correo es el último <input type="text"> visible en la página en el
  // estado "Facturado" (confirmado por inspección: idx 3 de 4, tras Nombre/RFC/CP/Referencia
  // haber quedado fuera de flujo o reemplazados por el resumen de factura).
  const inputsFinal = await page.$$('input[type="text"]');
  const correoEl = inputsFinal[inputsFinal.length - 1];
  if (!correoEl) throw new Error('No se encontró el campo de correo');
  await correoEl.click({ clickCount: 3 });
  await page.keyboard.type(CORREO_DESTINO, { delay: 25 });
  await page.waitForTimeout(400);

  const enviarHandle = await page.evaluateHandle(() => Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim() === 'ENVIAR' || x.textContent.trim() === 'Enviar') || null);
  const enviarEl = enviarHandle.asElement();
  if (!enviarEl) throw new Error('No se encontró el botón ENVIAR');
  await enviarEl.click();
  await page.waitForTimeout(3000);

  const bodyFinal = await page.evaluate(() => document.body.innerText.slice(0, 1500));
  console.log('\nBODY tras ENVIAR:\n', bodyFinal);

  const buf = await page.screenshot({ fullPage: true });
  console.log('📸', await subirArchivoR2(buf, `debug/enerfueltech_correo_${Date.now()}.png`, 'image/png'));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
