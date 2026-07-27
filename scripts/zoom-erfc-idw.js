require('dotenv').config();
const fs = require('fs');
const puppeteer = require('puppeteer');
(async () => {
  const imgPath = 'C:/Users/carlo/AppData/Local/Temp/claude/C--Users-carlo/bd061180-d7e6-4587-97d7-6edd69b553bc/scratchpad/gasolineras/gasolineras/11_natalia_maria_del_carmen_timilpan_ERFC_erfc.com.mx_IDW.jpeg';
  const b64 = fs.readFileSync(imgPath).toString('base64');
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 500 });
  await page.setContent(`<html><body style="margin:0;background:#fff;"><canvas id="c" width="1600" height="400"></canvas>
  <script>
    const img = new Image();
    img.onload = () => {
      const ctx = document.getElementById('c').getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, 380, 795, 560, 110, 0, 0, 1600, 314);
      window.__done = true;
    };
    img.src = "data:image/jpeg;base64,${b64}";
  </script></body></html>`);
  await page.waitForFunction('window.__done===true', {timeout:10000});
  await page.waitForTimeout(300);
  const buf = await page.screenshot({fullPage:false});
  fs.writeFileSync('C:/Users/carlo/AppData/Local/Temp/claude/C--Users-carlo/bd061180-d7e6-4587-97d7-6edd69b553bc/scratchpad/erfc_idw_zoom.png', buf);
  console.log('done');
  await browser.close();
  process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1)});
