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

  // Ubicar el panel "Mis datos fiscales" y sus campos por posición dentro de ese contenedor
  const panelHandle = await page.evaluateHandle(() => {
    const heading = Array.from(document.querySelectorAll('*')).find(el => el.children.length === 0 && el.textContent.trim() === 'Mis datos fiscales');
    return heading ? heading.closest('.mud-paper') || heading.parentElement.parentElement : null;
  });

  const nombreInput = await panelHandle.evaluateHandle(panel => panel.querySelectorAll('input[type="text"]')[0]);
  const rfcInput = await panelHandle.evaluateHandle(panel => panel.querySelectorAll('input[type="text"]')[1]);
  const cpInput = await panelHandle.evaluateHandle(panel => panel.querySelectorAll('input[type="text"]')[2]);

  console.log('➡️ Llenando Nombre...');
  await nombreInput.asElement().click({ clickCount: 3 });
  await page.keyboard.type('GPN PINTURAS Y RECUBRIMIENTOS', { delay: 30 });
  await page.waitForTimeout(300);

  console.log('➡️ Llenando RFC...');
  await rfcInput.asElement().click({ clickCount: 3 });
  await page.keyboard.type('GPR110128QD8', { delay: 30 });
  await page.waitForTimeout(1200); // esperar posible autocompletado / lista de clientes

  const bodyTrasRFC = await page.evaluate(() => document.body.innerText.slice(0, 2500));
  console.log('\nBODY tras escribir RFC:\n', bodyTrasRFC);

  const buf1 = await page.screenshot({ fullPage: true });
  console.log('📸 tras RFC:', await subirArchivoR2(buf1, `debug/enerfueltech_trasrfc_${Date.now()}.png`, 'image/png'));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
