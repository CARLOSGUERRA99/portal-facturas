// Lista las facturas emitidas en el portal G500 (Mis facturas). Sirve para
// confirmar qué se timbró de verdad cuando el bot no alcanza a ver la
// pantalla de confirmación.
require('dotenv').config();
const puppeteer = require('puppeteer');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}&stealth=true`,
  });
  const page = await browser.newPage();
  page.on('dialog', async d => { console.log('dialog:', d.message()); await d.accept().catch(() => {}); });

  await page.goto(`https://g500facturagas.azurewebsites.net/?PermisoCRE=${process.env.G500_PERMISO_CRE}&seccion=`,
    { waitUntil: 'domcontentloaded', timeout: 40000 });
  await sleep(3500);
  await page.click('#mailUser'); await page.keyboard.type(process.env.G500_USER, { delay: 35 });
  await page.click('#pwdUser');  await page.keyboard.type(process.env.G500_PASS, { delay: 35 });
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button,input[type=submit],a')).find(x => /^\s*ingresar\s*$/i.test(x.textContent || x.value || ''));
    if (b) b.click();
  });
  await sleep(7000);

  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('a,button,div[onclick]')).filter(x => x.offsetParent)
      .find(x => /^\s*mis facturas\s*$/i.test((x.textContent || '').trim()));
    if (b) b.click();
  });
  await sleep(8000);

  console.log('>> pidiendo "Mes Actual"...');
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('a,button,input[type=button],input[type=submit],label'))
      .filter(x => x.offsetParent)
      .find(x => /mes actual/i.test(x.textContent || x.value || ''));
    if (b) b.click();
  });
  await sleep(9000);

  const t = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 1800));
  console.log('=== MIS FACTURAS ===');
  console.log(t);
  await browser.close();
  process.exit(0);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
