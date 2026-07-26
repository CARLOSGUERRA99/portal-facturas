require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');
(async () => {
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  let status = '?';
  page.on('response', r => { if (r.url().includes('prb.com.mx')) status = r.status() + ' ' + r.url(); });
  try {
    const resp = await page.goto('https://facturacion.prb.com.mx:444/', { waitUntil: 'domcontentloaded', timeout: 40000 });
    console.log('HTTP:', resp ? resp.status() : '?', '| firstResp:', status);
  } catch (e) { console.log('goto err:', e.message); }
  await page.waitForTimeout(8000);
  const info = await page.evaluate(() => ({
    loc: location.href, htmlLen: document.documentElement.outerHTML.length,
    frames: window.frames.length, iframes: Array.from(document.querySelectorAll('iframe,frame')).map(f => f.src),
    bodyStart: (document.body ? document.body.innerHTML : '').slice(0, 300),
    inputs: Array.from(document.querySelectorAll('input,select')).map(i => i.id || i.name).filter(Boolean),
    links: Array.from(document.querySelectorAll('a[href]')).map(a => a.href).slice(0, 10),
  }));
  console.log(JSON.stringify(info, null, 1));
  const buf = await page.screenshot({ fullPage: false });
  console.log('shot:', await subirArchivoR2(buf, `debug/probe_kfc_deep_${Date.now()}.png`, 'image/png'));
  await browser.close(); process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
