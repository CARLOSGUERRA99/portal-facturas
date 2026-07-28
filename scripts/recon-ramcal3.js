require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('dialog', async d => { console.log('🔔 Dialog:', d.message()); await d.accept().catch(() => {}); });

  await page.goto('https://corporativoramcal.mx/facturacion/', { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForTimeout(1500);

  const enlacesEstaciones = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('a')).map(a => ({ text: a.textContent.trim(), href: a.href }))
      .filter(a => /E0\d{4}|E1\d{4}/.test(a.text));
  });
  console.log('Enlaces de estaciones encontrados:', JSON.stringify(enlacesEstaciones, null, 2));

  if (enlacesEstaciones.length) {
    const target = enlacesEstaciones.find(e => e.text.includes('07932')) || enlacesEstaciones[0];
    console.log(`\n➡️ Navegando a la estación E07932: ${target.href}`);
    const resp = await page.goto(target.href, { waitUntil: 'networkidle2', timeout: 25000 }).catch(e => null);
    console.log('Status:', resp ? resp.status() : 'N/A', '| URL final:', page.url());
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 2000));
    console.log('BODY:\n', bodyText);
    const inputs = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('input,select,textarea,button')).map(el => ({
        tag: el.tagName, id: el.id, name: el.name, type: el.type, placeholder: el.placeholder,
      })).filter(el => el.type !== 'hidden');
    });
    console.log('\n=== CAMPOS ===');
    console.log(JSON.stringify(inputs, null, 2));
  }

  const buf = await page.screenshot({ fullPage: true });
  console.log('📸', await subirArchivoR2(buf, `debug/ramcal_estacion_${Date.now()}.png`, 'image/png'));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
