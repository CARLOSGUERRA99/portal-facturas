require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

const FOLIO = '2116611', COD = '8663482';
const DRIVES = ['Caffenio Bellavista Obregón', 'Caffenio Alvaro Obregon'];

async function seleccionarDrive(page, nombre) {
  const inp = await page.$('input[placeholder="Seleccione..."]');
  if (!inp) return false;
  await inp.click({ clickCount: 3 });
  await page.keyboard.type(nombre.replace('Caffenio ', ''), { delay: 40 });
  await page.waitForTimeout(1800);
  const h = await page.evaluateHandle((n) => {
    const opts = Array.from(document.querySelectorAll('[role=option], li'));
    return opts.find(o => o.textContent.trim().toLowerCase() === n.toLowerCase())
        || opts.find(o => o.textContent.trim().toLowerCase().includes(n.toLowerCase().replace('caffenio ',''))) || null;
  }, nombre);
  const el = h.asElement();
  if (!el) return false;
  await el.click();
  await page.waitForTimeout(800);
  return true;
}

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  for (const drive of DRIVES) {
    const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1000 });
    page.on('dialog', async d => { console.log('🔔', d.message()); await d.accept().catch(()=>{}); });
    console.log(`\n${'='.repeat(60)}\nProbando drive: ${drive}\n${'='.repeat(60)}`);
    try {
      await page.goto('https://facturaciondrive.caffenio.com/ticket', { waitUntil: 'networkidle2', timeout: 30000 });
      await page.waitForTimeout(3000);
      await page.click('input[name="folio"]'); await page.keyboard.type(FOLIO, { delay: 50 });
      await page.click('input[name="codFacturacion"]'); await page.keyboard.type(COD, { delay: 50 });
      const ok = await seleccionarDrive(page, drive);
      console.log('drive seleccionado:', ok);
      if (!ok) { await browser.close(); continue; }

      const buf0 = await page.screenshot({ fullPage: true });
      console.log('📸 form:', await subirArchivoR2(buf0, `debug/caffenio_form_lleno_${Date.now()}.png`, 'image/png'));

      const btn = await page.evaluateHandle(() => Array.from(document.querySelectorAll('button')).find(b=>/buscar ticket/i.test(b.textContent||''))||null);
      const be = btn.asElement();
      if (be) { await be.click(); }
      await page.waitForTimeout(6000);

      const body = await page.evaluate(()=>document.body.innerText);
      console.log('\nBODY tras Buscar:\n', body.slice(0,1600));
      const buf = await page.screenshot({ fullPage: true });
      console.log('📸', await subirArchivoR2(buf, `debug/caffenio_buscar_${Date.now()}.png`, 'image/png'));

      if (/213|no encontrado|no existe|inv[aá]lid|datos fiscales|receptor/i.test(body)) {
        console.log('\n🎯 RESPUESTA RELEVANTE detectada con drive:', drive);
        if (/213/.test(body)) { console.log('✅ EL TICKET FUE ENCONTRADO (aparece el total 213)'); await browser.close(); process.exit(0); }
      }
    } catch (e) { console.log('❌', e.message); }
    await browser.close();
    await new Promise(r=>setTimeout(r,3000));
  }
  process.exit(0);
})().catch(e=>{console.error('❌',e.message);process.exit(1);});
