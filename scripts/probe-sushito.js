/**
 * Sonda de DOM del portal SushiO (mefacturo.mx) — READ-ONLY diagnóstico.
 * Llena el formulario con el código real del #72 y reporta:
 *  - tag/clase reales del botón "Facturar"
 *  - si un click amplio funciona
 *  - qué muestra el portal tras hacer click (banner vencido vs campo de correo)
 * Uso: node scripts/probe-sushito.js
 */
require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true`,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto('https://mefacturo.mx/sushio', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2500);

  await page.waitForSelector('#CodigoUnicoTicket', { visible: true, timeout: 15000 });
  await page.click('#CodigoUnicoTicket'); await page.keyboard.type('206197GVETHHC7', { delay: 40 });
  const hayFolio = await page.$('#FolioTicket');
  if (hayFolio) { await page.click('#FolioTicket'); await page.keyboard.type('79542', { delay: 40 }); }
  await page.click('#RFC'); await page.keyboard.type('XAXX010101000', { delay: 40 });
  await page.waitForTimeout(1200);

  const dump = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('button, a, input, [role="button"], [onclick], .btn'));
    return els.filter(e => {
      const t = (e.textContent || e.value || '').toLowerCase();
      return /factur|recuperar|generar|enviar/.test(t) || /btn/.test(String(e.className));
    }).map(e => ({
      tag: e.tagName, type: e.type || null, id: e.id || null,
      class: String(e.className || '').slice(0, 50),
      text: (e.textContent || e.value || '').trim().slice(0, 40),
      disabled: e.disabled || false, href: e.href || null,
      onclick: e.getAttribute && e.getAttribute('onclick') ? 'yes' : null,
      visible: e.offsetParent !== null,
    }));
  });
  console.log('=== BOTONES ANTES DEL CLICK ===');
  console.log(JSON.stringify(dump, null, 2));

  const clicked = await page.evaluate(() => {
    const cand = Array.from(document.querySelectorAll('button, a, input[type=submit], input[type=button], [role=button], .btn'));
    const btn = cand.find(b => /factur/i.test((b.textContent || b.value || '')) && !/recuperar/i.test((b.textContent || b.value || '')));
    if (btn) { btn.click(); return { tag: btn.tagName, text: (btn.textContent || btn.value || '').trim() }; }
    return null;
  });
  console.log('\n=== CLICK AMPLIO EN FACTURAR ===');
  console.log(JSON.stringify(clicked));

  await page.waitForTimeout(6000);
  const after = await page.evaluate(() => ({
    bodyText: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 700),
    hasEmail: !!document.querySelector("input[type='email'], #Correo, #CorreoElectronico, #Email"),
  }));
  console.log('\n=== TRAS EL CLICK ===');
  console.log('bodyText:', after.bodyText);
  console.log('hasEmailField:', after.hasEmail);

  const buf = await page.screenshot({ fullPage: false });
  const u = await subirArchivoR2(buf, `debug/probe_sushito_after_${Date.now()}.png`, 'image/png');
  console.log('screenshot:', u);

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
