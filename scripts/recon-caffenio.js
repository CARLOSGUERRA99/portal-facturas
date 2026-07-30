require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('dialog', async d => { console.log('🔔 Dialog:', d.message()); await d.accept().catch(() => {}); });

  for (const url of ['http://facturaciondrive.caffenio.com', 'https://facturaciondrive.caffenio.com']) {
    try {
      const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 });
      console.log(`\n=== ${url} → ${resp.status()} | final: ${page.url()} ===`);
      await page.waitForTimeout(2500);
      console.log('BODY:\n', (await page.evaluate(() => document.body.innerText)).slice(0, 1200));
      const campos = await page.evaluate(() => Array.from(document.querySelectorAll('input,select,textarea,button'))
        .map(el => ({ tag: el.tagName, id: el.id, name: el.name, type: el.type, ph: el.placeholder, txt: (el.textContent||'').trim().slice(0,35) }))
        .filter(e => e.type !== 'hidden'));
      console.log('\nCAMPOS:', JSON.stringify(campos, null, 2));
      const cap = await page.evaluate(() => ({
        iframes: Array.from(document.querySelectorAll('iframe')).map(f => f.src).filter(s => /captcha|recaptcha|turnstile|hcaptcha/i.test(s)),
        divs: Array.from(document.querySelectorAll('[class*=captcha],[id*=captcha]')).map(d => d.outerHTML.slice(0,150)),
        menciona: /captcha/i.test(document.body.innerHTML),
      }));
      console.log('\nCAPTCHA:', JSON.stringify(cap, null, 2));
      const buf = await page.screenshot({ fullPage: true });
      console.log('📸', await subirArchivoR2(buf, `debug/caffenio_${Date.now()}.png`, 'image/png'));
      break;
    } catch (e) { console.log(`❌ ${url}: ${e.message}`); }
  }
  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
