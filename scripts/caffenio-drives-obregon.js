require('dotenv').config();
const puppeteer = require('puppeteer');
(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1000 });
  await page.goto('https://facturaciondrive.caffenio.com/ticket', { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForTimeout(3000);
  const inp = await page.$('input[placeholder="Seleccione..."]');
  await inp.click();
  await page.waitForTimeout(2500);
  // Scrollear el listbox para cargar todas las opciones (virtualizado)
  const todas = await page.evaluate(async () => {
    const box = document.querySelector('[role=listbox], ul[class*=listbox], .MuiAutocomplete-listbox');
    const set = new Set();
    const grab = () => document.querySelectorAll('[role=option], li').forEach(o => { const t=(o.textContent||'').trim(); if(t&&t.length<90) set.add(t); });
    grab();
    if (box) for (let i=0;i<25;i++){ box.scrollTop = box.scrollHeight*(i/25); await new Promise(r=>setTimeout(r,120)); grab(); }
    return [...set];
  });
  console.log(`Total drives cargados: ${todas.length}`);
  const son = todas.filter(o=>/obreg|navojoa|guaymas|empalme|cajeme|bourlaug|borlaug|municipio/i.test(o));
  console.log('\n🎯 Drives candidatos (Obregón/Cajeme/Sonora sur):');
  console.log(JSON.stringify(son,null,2));
  await browser.close(); process.exit(0);
})().catch(e=>{console.error('❌',e.message);process.exit(1);});
