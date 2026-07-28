require('dotenv').config();
const puppeteer = require('puppeteer');

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  await page.goto('https://mazzhidrocarburos.com.mx/?page_id=2', { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForTimeout(2000);

  const todosLosLinks = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('a')).map(a => ({
      href: a.href,
      imgAlt: a.querySelector('img') ? a.querySelector('img').alt : null,
      imgSrc: a.querySelector('img') ? a.querySelector('img').src : null,
      texto: a.textContent.trim(),
    })).filter(a => a.href && !a.href.endsWith('#') && !a.href.includes('page_id=2#'));
  });
  console.log('=== TODOS LOS <a href> ===');
  console.log(JSON.stringify(todosLosLinks, null, 2));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
