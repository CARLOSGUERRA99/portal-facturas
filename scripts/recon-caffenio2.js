require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('dialog', async d => { console.log('🔔', d.message()); await d.accept().catch(()=>{}); });

  await page.goto('https://facturaciondrive.caffenio.com', { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForTimeout(2500);

  console.log('➡️ Click "Factura sin cuenta MI CAFFENIO"...');
  const clic = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('a,button,div,span'))
      .find(x => /factura sin cuenta/i.test(x.textContent||'') && x.children.length < 3);
    if (el) { (el.closest('a,button') || el).click(); return true; }
    return false;
  });
  console.log('clic:', clic);
  await page.waitForTimeout(3500);
  console.log('URL:', page.url());
  console.log('\nBODY:\n', (await page.evaluate(()=>document.body.innerText)).slice(0,1800));

  const campos = await page.evaluate(() => Array.from(document.querySelectorAll('input,select,textarea,button'))
    .map(el => { const r=el.getBoundingClientRect(); return { tag:el.tagName, id:el.id, name:el.name, type:el.type, ph:el.placeholder||el.getAttribute('aria-label'), txt:(el.textContent||'').trim().slice(0,40), vis:r.width>0&&r.height>0 }; })
    .filter(e => e.vis && e.type!=='hidden'));
  console.log('\nCAMPOS:', JSON.stringify(campos,null,2));

  const cap = await page.evaluate(() => ({
    iframes: Array.from(document.querySelectorAll('iframe')).map(f=>f.src).filter(s=>/captcha|recaptcha|turnstile/i.test(s)),
    divs: Array.from(document.querySelectorAll('[class*=captcha],[id*=captcha]')).map(d=>d.outerHTML.slice(0,120)),
    menciona: /captcha/i.test(document.body.innerHTML),
  }));
  console.log('\nCAPTCHA:', JSON.stringify(cap,null,2));

  const buf = await page.screenshot({ fullPage: true });
  console.log('📸', await subirArchivoR2(buf, `debug/caffenio_sincuenta_${Date.now()}.png`, 'image/png'));
  await browser.close(); process.exit(0);
})().catch(e=>{console.error('❌',e.message);process.exit(1);});
