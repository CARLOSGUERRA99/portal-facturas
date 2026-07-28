require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('dialog', async d => { console.log('🔔 Dialog:', d.message()); await d.accept().catch(() => {}); });

  await page.goto('https://mazzhidrocarburos.com.mx/?page_id=2', { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForTimeout(2000);

  const estaciones = await page.evaluate(() => {
    // Buscar todos los links/botones "Facturar" y su contexto (nombre de estación)
    const facturarEls = Array.from(document.querySelectorAll('a, button')).filter(el =>
      /facturar/i.test(el.textContent || '') || (el.querySelector && el.querySelector('img[alt*=acturar], img[src*=acturar]'))
    );
    return facturarEls.map(el => ({
      tag: el.tagName, href: el.href || null, onclick: el.getAttribute('onclick'),
      texto: el.textContent.trim().slice(0, 100),
      parentText: el.closest('div') ? el.closest('div').textContent.trim().slice(0, 100) : null,
    }));
  });
  console.log('=== Elementos "Facturar" encontrados ===');
  console.log(JSON.stringify(estaciones, null, 2));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
