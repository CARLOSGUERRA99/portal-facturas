/**
 * Sonda de DOM del modal "Ya ha sido generada su factura!" de Carl's Jr (ICR).
 * Llena la referencia del #90, da Siguiente y reporta los inputs y botones del modal
 * (id/name/onclick/href) para sacar los selectores reales de "Enviar a:" y "Descargar".
 * Uso: node scripts/probe-carljr.js
 */
require('dotenv').config();
const puppeteer = require('puppeteer');

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto('https://retailedx.com/ICR4/', { waitUntil: 'load', timeout: 30000 });

  const tieneForm = await page.$('#txt_ticket');
  if (!tieneForm) {
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('a,button,input[type="button"],input[type="submit"]'))
        .find(el => /genere|factura|generar|iniciar/i.test(el.textContent || el.value || ''));
      if (b) b.click();
    });
    await page.waitForTimeout(3000);
  }
  await page.waitForSelector('#txt_ticket', { timeout: 15000 });
  await page.click('#txt_ticket'); await page.keyboard.type('56007072082652', { delay: 40 });
  await page.click('#txt_rfccliente'); await page.keyboard.type('GPR110128QD8', { delay: 40 });
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button,input[type="submit"],input[type="button"],a'))
      .find(x => /siguiente/i.test((x.textContent || '') + (x.value || '')));
    if (b) b.click();
  });
  await page.waitForTimeout(6000);

  const dump = await page.evaluate(() => {
    const visible = el => el.offsetParent !== null;
    const inputs = Array.from(document.querySelectorAll('input, textarea')).filter(visible).map(i => ({
      tag: i.tagName, type: i.type || null, id: i.id || null, name: i.name || null,
      placeholder: i.placeholder || null, value: (i.value || '').slice(0, 30),
    }));
    const botones = Array.from(document.querySelectorAll('a, button, input[type="button"], input[type="submit"]')).filter(visible).map(b => ({
      tag: b.tagName, id: b.id || null, text: (b.textContent || b.value || '').trim().slice(0, 30),
      href: b.href || null, onclick: b.getAttribute && b.getAttribute('onclick') ? b.getAttribute('onclick').slice(0, 80) : null,
      target: b.target || null,
    })).filter(b => /enviar|descargar|pdf|xml|aceptar/i.test(b.text) || /denviar|dxmlpdf|dcorreo/i.test(b.id || ''));
    return { inputs, botones };
  });
  console.log('=== INPUTS VISIBLES ===');
  console.log(JSON.stringify(dump.inputs, null, 2));
  console.log('\n=== BOTONES (enviar/descargar/aceptar) ===');
  console.log(JSON.stringify(dump.botones, null, 2));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
