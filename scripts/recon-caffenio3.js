require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('dialog', async d => { await d.accept().catch(()=>{}); });

  await page.goto('https://facturaciondrive.caffenio.com', { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForTimeout(3000);

  // Ver el elemento real de "Factura sin cuenta"
  const info = await page.evaluate(() => {
    const cands = Array.from(document.querySelectorAll('*')).filter(x =>
      /factura sin cuenta/i.test(x.textContent||'') && x.children.length <= 2);
    return cands.map(el => ({ tag: el.tagName, cls: (el.className||'').toString().slice(0,80),
      href: el.href||null, onclick: (el.getAttribute('onclick')||'').slice(0,80),
      parentTag: el.parentElement?.tagName, parentHref: el.parentElement?.href||null }));
  });
  console.log('Elementos "Factura sin cuenta":', JSON.stringify(info,null,2));
  // Todos los <a href> de la página
  const links = await page.evaluate(() => Array.from(document.querySelectorAll('a')).map(a=>({t:a.textContent.trim().slice(0,40),h:a.href})));
  console.log('\nLinks:', JSON.stringify(links,null,2));

  // Clic sintético REAL de Puppeteer
  const h = await page.evaluateHandle(() => {
    const el = Array.from(document.querySelectorAll('*')).find(x =>
      /factura sin cuenta/i.test(x.textContent||'') && x.children.length <= 2);
    return el ? (el.closest('a,button') || el) : null;
  });
  const el = h.asElement();
  if (el) {
    console.log('\n➡️ Clic sintético real...');
    await el.hover(); await page.waitForTimeout(300);
    await el.click();
    await page.waitForTimeout(4000);
    console.log('URL tras clic:', page.url());
    console.log('\nBODY:\n', (await page.evaluate(()=>document.body.innerText)).slice(0,1500));
    const campos = await page.evaluate(() => Array.from(document.querySelectorAll('input,select,textarea,button'))
      .map(x=>{const r=x.getBoundingClientRect();return {tag:x.tagName,id:x.id,name:x.name,type:x.type,ph:x.placeholder||x.getAttribute('aria-label'),txt:(x.textContent||'').trim().slice(0,35),vis:r.width>0&&r.height>0};})
      .filter(e=>e.vis&&e.type!=='hidden'));
    console.log('\nCAMPOS:', JSON.stringify(campos,null,2));
    const cap = await page.evaluate(()=>({iframes:Array.from(document.querySelectorAll('iframe')).map(f=>f.src).filter(s=>/captcha|recaptcha|turnstile/i.test(s)),menciona:/captcha/i.test(document.body.innerHTML)}));
    console.log('\nCAPTCHA:', JSON.stringify(cap));
    const buf = await page.screenshot({ fullPage: true });
    console.log('📸', await subirArchivoR2(buf, `debug/caffenio_form_${Date.now()}.png`, 'image/png'));
  } else console.log('❌ elemento no encontrado');
  await browser.close(); process.exit(0);
})().catch(e=>{console.error('❌',e.message);process.exit(1);});
