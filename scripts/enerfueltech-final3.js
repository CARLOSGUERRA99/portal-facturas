require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

const REFERENCIA = '049847152458CE1';

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
  const regimenSelect = (await panelHandle.evaluateHandle(panel => panel.querySelectorAll('.mud-select')[0])).asElement();
  await regimenSelect.click();
  await page.waitForTimeout(700);
  await page.evaluate(() => {
    const opt = Array.from(document.querySelectorAll('.mud-list-item')).find(el => el.textContent.trim().startsWith('601'));
    if (opt) opt.click();
  });
  await page.waitForTimeout(500);

  console.log('➡️ Uso CFDI: G03...');
  const usoCfdiSelect = (await panelHandle.evaluateHandle(panel => panel.querySelectorAll('.mud-select')[1])).asElement();
  await usoCfdiSelect.click();
  await page.waitForTimeout(700);
  const opcionesUso = await page.evaluate(() => Array.from(document.querySelectorAll('.mud-list-item')).map(el => el.textContent.trim()));
  console.log('Opciones Uso CFDI:', JSON.stringify([...new Set(opcionesUso)], null, 2));
  await page.evaluate(() => {
    const opt = Array.from(document.querySelectorAll('.mud-list-item')).find(el => el.textContent.trim().startsWith('G03'));
    if (opt) opt.click();
  });
  await page.waitForTimeout(800);

  const bodyTrasSelects = await page.evaluate(() => document.body.innerText.slice(0, 1800));
  console.log('\nBODY tras completar Régimen/UsoCFDI:\n', bodyTrasSelects);

  const buf1 = await page.screenshot({ fullPage: true });
  console.log('📸 antes de Facturar:', await subirArchivoR2(buf1, `debug/enerfueltech_antesfacturar_${Date.now()}.png`, 'image/png'));

  // ¿Ya está habilitado el botón FACTURAR?
  const facturarHabilitado = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim() === 'FACTURAR' || x.textContent.trim() === 'Facturar');
    return b ? !b.disabled : null;
  });
  console.log('¿Botón Facturar habilitado?:', facturarHabilitado);

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
