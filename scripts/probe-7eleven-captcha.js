require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

(async () => {
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto('https://www.e7-eleven.com.mx/facturacion/KPortalExterno/', { waitUntil: 'networkidle2', timeout: 40000 });
  await page.waitForTimeout(3500);

  // Click FACTURA EXPRESS
  await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('button,a,.btn')).find(e => e.offsetParent && (e.textContent||'').trim().toUpperCase() === 'FACTURA EXPRESS');
    if (el) el.click();
  });
  await page.waitForTimeout(4500);

  // Localizar la imagen del CAPTCHA
  const captchaInfo = await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('img')).filter(i => i.offsetParent).map(i => ({
      src: i.src, id: i.id, cls: i.className, width: i.naturalWidth, height: i.naturalHeight,
      parentId: i.parentElement?.id, parentCls: (i.parentElement?.className||'').slice(0, 30)
    }));
    const capField = document.querySelector('#captcha');
    return { imgs, captchaFieldId: capField ? '#captcha' : null };
  });
  console.log('CAPTCHA field:', captchaInfo.captchaFieldId);
  console.log('IMAGENES:', JSON.stringify(captchaInfo.imgs, null, 1));

  // Capturar la imagen del captcha como base64
  const captchaImgBase64 = await page.evaluate(() => {
    const img = Array.from(document.querySelectorAll('img')).find(i => i.offsetParent && i.src && !i.src.includes('logo') && !i.src.includes('icon') && (i.naturalWidth < 300));
    if (!img) return null;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      canvas.getContext('2d').drawImage(img, 0, 0);
      return { base64: canvas.toDataURL('image/png').split(',')[1], src: img.src, w: img.naturalWidth, h: img.naturalHeight };
    } catch { return { src: img.src }; }
  });
  console.log('CAPTCHA img:', JSON.stringify({ src: captchaImgBase64?.src, w: captchaImgBase64?.w, h: captchaImgBase64?.h, base64Len: captchaImgBase64?.base64?.length }));

  const buf = await page.screenshot({ fullPage: false });
  console.log('shot:', await subirArchivoR2(buf, `debug/p7e_captcha_${Date.now()}.png`, 'image/png'));
  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
