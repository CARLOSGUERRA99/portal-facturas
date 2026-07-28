require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('dialog', async d => { console.log('🔔 Dialog:', d.message()); await d.accept().catch(() => {}); });

  await page.goto('https://estacion.qualligas.com/', { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForTimeout(1500);

  console.log('➡️ Escribiendo número de estación 23049...');
  await page.click('#estacion');
  await page.keyboard.type('23049', { delay: 40 });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim() === 'Aceptar');
    if (b) b.click();
  });
  await page.waitForTimeout(2500);

  console.log('URL tras Aceptar:', page.url());
  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 2000));
  console.log('BODY:\n', bodyText);

  const inputs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('input,select,textarea,button')).map(el => ({
      tag: el.tagName, id: el.id, name: el.name, type: el.type, placeholder: el.placeholder, texto: (el.textContent||'').trim().slice(0,40),
    })).filter(el => el.type !== 'hidden');
  });
  console.log('\n=== CAMPOS ===');
  console.log(JSON.stringify(inputs, null, 2));

  const captchaHints = await page.evaluate(() => {
    const iframes = Array.from(document.querySelectorAll('iframe')).map(f => f.src).filter(s => /captcha|recaptcha|turnstile|hcaptcha/i.test(s));
    const scripts = Array.from(document.querySelectorAll('script')).map(s => s.src).filter(s => /captcha|recaptcha|turnstile|hcaptcha/i.test(s || ''));
    const divs = Array.from(document.querySelectorAll('[class*=captcha],[id*=captcha]')).map(d => d.outerHTML.slice(0, 200));
    const bodyHTML = document.body.innerHTML;
    const mentionsCaptcha = /captcha/i.test(bodyHTML);
    return { iframes, scripts, divs, mentionsCaptcha };
  });
  console.log('\n=== Indicios de CAPTCHA ===');
  console.log(JSON.stringify(captchaHints, null, 2));

  const buf = await page.screenshot({ fullPage: true });
  console.log('📸', await subirArchivoR2(buf, `debug/qualligas_estacion_${Date.now()}.png`, 'image/png'));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
