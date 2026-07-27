require('dotenv').config();
const puppeteer = require('puppeteer');
const fs = require('fs');
(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
  const url = 'https://www.soriana.com/facturacion-login?srsltid=AfmBOop7xyaQcSl-omEFk8Wz_4GISbldc_qNIPTfvUyFYCrldsZ8MHFR';
  const r = await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  console.log('Status:', r.status());
  console.log('Title:', await page.title());
  const buf = await page.screenshot({ fullPage: true });
  fs.writeFileSync('C:/Users/carlo/AppData/Local/Temp/claude/C--Users-carlo/bd061180-d7e6-4587-97d7-6edd69b553bc/scratchpad/soriana_login_try.png', buf);
  const info = await page.evaluate(() => {
    const visible = el => el.offsetParent !== null;
    const inputs = Array.from(document.querySelectorAll('input, textarea, select')).filter(visible).map(i => ({
      tag: i.tagName, type: i.type || null, id: i.id || null, name: i.name || null, placeholder: i.placeholder || null,
    }));
    const botones = Array.from(document.querySelectorAll('a, button, input[type="button"], input[type="submit"]')).filter(visible).map(b => ({
      tag: b.tagName, id: b.id || null, text: (b.textContent || b.value || '').trim().slice(0, 60), href: b.href || null,
    }));
    return { inputs, botones, bodyText: (document.body.innerText || '').slice(0, 800) };
  });
  console.log(JSON.stringify(info, null, 2));
  await browser.close();
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
