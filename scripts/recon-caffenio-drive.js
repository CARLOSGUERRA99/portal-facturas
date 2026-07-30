require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1000 });
  page.on('dialog', async d => { await d.accept().catch(()=>{}); });

  await page.goto('https://facturaciondrive.caffenio.com/ticket', { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForTimeout(3500);

  // Abrir el autocomplete "Drive" con clic sintético real
  const inp = await page.$('input[placeholder="Seleccione..."]');
  if (!inp) { console.log('❌ no se encontró el input Drive'); await browser.close(); process.exit(1); }
  await inp.hover(); await page.waitForTimeout(300);
  await inp.click();
  await page.waitForTimeout(2500);

  const opciones = await page.evaluate(() => {
    const sels = ['[role=option]','li','.MuiAutocomplete-option','[class*=option]'];
    const out = new Set();
    for (const s of sels) for (const el of document.querySelectorAll(s)) {
      const t = (el.textContent||'').trim();
      if (t && t.length < 90) out.add(t);
    }
    return [...out];
  });
  console.log(`Opciones del Drive (${opciones.length}):`);
  console.log(JSON.stringify(opciones.slice(0,60),null,2));

  // Filtrar las de Obregón / Bourlaug
  const m = opciones.filter(o=>/obreg|bourlaug|borlaug|municipio libre/i.test(o));
  console.log('\n🎯 Coinciden con el ticket (Obregón / Bourlaug):', JSON.stringify(m,null,2));

  const buf = await page.screenshot({ fullPage: true });
  console.log('📸', await subirArchivoR2(buf, `debug/caffenio_drives_${Date.now()}.png`, 'image/png'));
  await browser.close(); process.exit(0);
})().catch(e=>{console.error('❌',e.message);process.exit(1);});
