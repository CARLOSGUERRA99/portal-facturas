require('dotenv').config();
const fs = require('fs');
const puppeteer = require('puppeteer');

(async () => {
  const imgPath = 'C:/Users/carlo/AppData/Local/Temp/claude/C--Users-carlo/bd061180-d7e6-4587-97d7-6edd69b553bc/scratchpad/imgs/capufe/capufe2.webp';
  const b64 = fs.readFileSync(imgPath).toString('base64');
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 1300 });
  await page.setContent(`
    <html><body style="margin:0;background:#fff;">
      <img id="im" src="data:image/webp;base64,${b64}" style="width:1000px;transform:rotate(180deg);display:block;">
    </body></html>
  `);
  await page.waitForSelector('#im');
  await page.waitForTimeout(500);
  const buf = await page.screenshot({ fullPage: true });
  fs.writeFileSync('C:/Users/carlo/AppData/Local/Temp/claude/C--Users-carlo/bd061180-d7e6-4587-97d7-6edd69b553bc/scratchpad/imgs/capufe/capufe2_rotado.png', buf);
  console.log('✅ Guardado capufe2_rotado.png');
  await browser.close();
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
