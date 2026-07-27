require('dotenv').config();
const puppeteer = require('puppeteer');
const fs = require('fs');

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  page.on('dialog', async d => { await d.accept().catch(() => {}); });
  await page.setViewport({ width: 1280, height: 900 });

  let xmlBuffer = null, pdfBuffer = null;
  async function watchResponses(p) {
    p.on('response', async (resp) => {
      const ct = resp.headers()['content-type'] || '';
      const url = resp.url();
      console.log('   resp:', resp.status(), ct, url.slice(0, 120));
      if ((ct.includes('xml') || /\.xml/i.test(url)) && !xmlBuffer) {
        const b = await resp.buffer().catch(() => null);
        if (b && b.length > 200) { xmlBuffer = b; console.log('📄 XML capturado:', url, b.length, 'bytes'); }
      }
      if (ct.includes('pdf') && !pdfBuffer) {
        const b = await resp.buffer().catch(() => null);
        if (b && b.length > 200) { pdfBuffer = b; console.log('📄 PDF capturado:', url, b.length, 'bytes'); }
      }
    });
  }
  await watchResponses(page);
  browser.on('targetcreated', async (target) => {
    try {
      const newPage = await target.page();
      if (newPage) { console.log('🆕 Nueva pestaña:', target.url()); await watchResponses(newPage); }
    } catch {}
  });

  await page.goto('https://petrofigues.facturacionestacion.com/', { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('#txtReferencia', { timeout: 15000 });
  await page.click('#txtReferencia'); await page.keyboard.type('13697', { delay: 10 });
  await page.click('#txtFolio'); await page.keyboard.type('1067336', { delay: 10 });
  await page.click('#txtAmount'); await page.keyboard.type('1000.00', { delay: 10 });
  await page.click('#txtRFC'); await page.keyboard.type('GPR110128QD8', { delay: 10 });
  await page.click('#btnNext');
  await page.waitForTimeout(2500);

  console.log('➡️ Click en XML...');
  await page.evaluate(() => {
    const a = Array.from(document.querySelectorAll('a')).find(x => x.textContent.trim() === 'XML');
    if (a) a.click();
  });
  await page.waitForTimeout(3000);

  console.log('➡️ Click en PDF...');
  await page.evaluate(() => {
    const a = Array.from(document.querySelectorAll('a')).find(x => x.textContent.trim() === 'PDF');
    if (a) a.click();
  });
  await page.waitForTimeout(3000);

  if (xmlBuffer) fs.writeFileSync('C:/Users/carlo/AppData/Local/Temp/claude/C--Users-carlo/bd061180-d7e6-4587-97d7-6edd69b553bc/scratchpad/petrofigues.xml', xmlBuffer);
  if (pdfBuffer) fs.writeFileSync('C:/Users/carlo/AppData/Local/Temp/claude/C--Users-carlo/bd061180-d7e6-4587-97d7-6edd69b553bc/scratchpad/petrofigues.pdf', pdfBuffer);

  console.log('XML:', xmlBuffer ? xmlBuffer.length : 'NO');
  console.log('PDF:', pdfBuffer ? pdfBuffer.length : 'NO');

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
