require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

const dumpInputs = () => {
  const vis = el => el.offsetParent !== null;
  const inputs = Array.from(document.querySelectorAll('input,select,textarea')).filter(vis).map(i => ({ id: i.id || null, name: i.name || null, ph: i.placeholder || null, type: i.type || null, opts: i.tagName === 'SELECT' ? Array.from(i.options).map(o => o.text).slice(0, 8) : undefined }));
  const botones = Array.from(document.querySelectorAll('button,a,input[type=submit],input[type=button],.btn,[role=button]')).filter(vis).map(b => ({ id: b.id || null, text: (b.textContent || b.value || '').trim().slice(0, 30) })).filter(b => b.text);
  return { inputs: inputs.slice(0, 30), botones: botones.slice(0, 25), txt: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 400) };
};

(async () => {
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}&stealth=true` });

  // ── TUFESA ──
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto('https://ventas.tufesa.com.mx/apw3/tufesa_es/SolicitarFactura.aspx', { waitUntil: 'networkidle2', timeout: 35000 });
    await page.waitForTimeout(3000);
    const opts = await page.evaluate(() => { const s = document.querySelector('#CboTipoFact'); return s ? Array.from(s.options).map(o => ({ v: o.value, t: o.text })) : []; });
    console.log('TUFESA CboTipoFact opciones:', JSON.stringify(opts));
    // Seleccionar la opción de boleto/viaje (o la primera real)
    const target = opts.find(o => /boleto|viaje|pasaje|ticket|sencill/i.test(o.t)) || opts.find(o => o.v && o.v !== '0' && o.v !== '');
    if (target) {
      console.log('TUFESA selecciono:', JSON.stringify(target));
      await page.select('#CboTipoFact', target.v);
      await page.waitForTimeout(4500); // ASP.NET postback
    }
    const buf = await page.screenshot({ fullPage: false });
    console.log('TUFESA screenshot:', await subirArchivoR2(buf, `debug/probe_tufesa3_${Date.now()}.png`, 'image/png'));
    console.log('TUFESA tras seleccionar:', JSON.stringify(await page.evaluate(dumpInputs), null, 1));
    await page.close();
  } catch (e) { console.log('TUFESA ❌', e.message); }

  // ── KFC / PRB ──
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto('https://facturacion.prb.com.mx:444/', { waitUntil: 'networkidle2', timeout: 35000 });
    await page.waitForTimeout(6000);
    const buf = await page.screenshot({ fullPage: false });
    console.log('\nKFC screenshot:', await subirArchivoR2(buf, `debug/probe_kfc3_${Date.now()}.png`, 'image/png'));
    console.log('KFC contenido:', JSON.stringify(await page.evaluate(dumpInputs), null, 1));
    await page.close();
  } catch (e) { console.log('KFC ❌', e.message); }

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
