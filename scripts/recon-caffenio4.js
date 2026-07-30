require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1000 });
  page.on('dialog', async d => { console.log('🔔', d.message()); await d.accept().catch(()=>{}); });

  const resp = await page.goto('https://facturaciondrive.caffenio.com/ticket', { waitUntil: 'networkidle2', timeout: 30000 });
  console.log('Status:', resp.status(), '| URL:', page.url());
  await page.waitForTimeout(3500);
  console.log('\nBODY:\n', (await page.evaluate(()=>document.body.innerText)).slice(0,2000));

  const campos = await page.evaluate(() => Array.from(document.querySelectorAll('input,select,textarea,button'))
    .map(x=>{const r=x.getBoundingClientRect();return {tag:x.tagName,id:x.id,name:x.name,type:x.type,ph:x.placeholder||x.getAttribute('aria-label'),maxlen:x.maxLength,txt:(x.textContent||'').trim().slice(0,40),vis:r.width>0&&r.height>0};})
    .filter(e=>e.vis&&e.type!=='hidden'));
  console.log('\nCAMPOS:', JSON.stringify(campos,null,2));

  // Labels visibles para saber qué pide cada campo
  const labels = await page.evaluate(()=>Array.from(document.querySelectorAll('label,p,span,h1,h2,h3'))
    .filter(e=>e.children.length===0&&e.textContent.trim().length>2&&e.textContent.trim().length<60)
    .map(e=>e.textContent.trim()).slice(0,30));
  console.log('\nTEXTOS/LABELS:', JSON.stringify(labels,null,2));

  const cap = await page.evaluate(()=>({iframes:Array.from(document.querySelectorAll('iframe')).map(f=>f.src).filter(s=>/captcha|recaptcha|turnstile|hcaptcha/i.test(s)),divs:Array.from(document.querySelectorAll('[class*=captcha],[id*=captcha]')).map(d=>d.outerHTML.slice(0,120)),menciona:/captcha/i.test(document.body.innerHTML)}));
  console.log('\nCAPTCHA:', JSON.stringify(cap,null,2));

  const buf = await page.screenshot({ fullPage: true });
  console.log('📸', await subirArchivoR2(buf, `debug/caffenio_ticket_${Date.now()}.png`, 'image/png'));
  await browser.close(); process.exit(0);
})().catch(e=>{console.error('❌',e.message);process.exit(1);});
