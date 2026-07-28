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

  console.log('➡️ Abriendo select Régimen...');
  // Los MudSelect son <div class="mud-select"> con un input de solo lectura que abre el popup al click
  const regimenSelect = (await panelHandle.evaluateHandle(panel => {
    const selects = panel.querySelectorAll('.mud-select');
    return selects[0];
  })).asElement();
  await regimenSelect.click();
  await page.waitForTimeout(700);

  const opcionesRegimen = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('.mud-list-item, .mud-popover .mud-list-item-text, [role="option"]')).map(el => el.textContent.trim());
  });
  console.log('Opciones de Régimen visibles:', JSON.stringify(opcionesRegimen, null, 2));

  const buf = await page.screenshot({ fullPage: true });
  console.log('📸', await subirArchivoR2(buf, `debug/enerfueltech_regimen_${Date.now()}.png`, 'image/png'));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
