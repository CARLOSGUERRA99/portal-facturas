require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

async function dump(page, label) {
  const buf = await page.screenshot({ fullPage: true }).catch(() => null);
  if (buf) console.log(`📸 [${label}]:`, await subirArchivoR2(buf, `debug/redpetroil_probe2_${label}_${Date.now()}.png`, 'image/png'));
  const info = await page.evaluate(() => {
    const visible = el => el.offsetParent !== null;
    const inputs = Array.from(document.querySelectorAll('input, textarea, select')).filter(visible).map(i => ({ tag: i.tagName, type: i.type, id: i.id, name: i.name, placeholder: i.placeholder, value: (i.value||'').slice(0,30) }));
    const botones = Array.from(document.querySelectorAll('a,button,input[type=button],input[type=submit]')).filter(visible).map(b => ({ tag: b.tagName, id: b.id, text: (b.textContent || b.value || '').trim().slice(0, 60) }));
    return { inputs, botones, bodyText: document.body.innerText.slice(0, 900) };
  });
  console.log(`=== ${label} ===`, JSON.stringify(info, null, 2));
}

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  const browser = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${token}&stealth=true` });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('dialog', async d => { console.log('🔔 Dialog:', d.message()); await d.accept().catch(()=>{}); });

  const apiCalls = [];
  page.on('response', async (resp) => {
    const url = resp.url();
    if (!/migasolinera\.net/i.test(url) || /\.(js|css|png|jpg|svg|woff|ico|gif)(\?|$)/i.test(url)) return;
    let body = null;
    try { body = (await resp.text()).slice(0, 600); } catch {}
    apiCalls.push({ status: resp.status(), url, body });
  });

  await page.goto('https://es11469.migasolinera.net/bajatufactura/', { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(1200);
  await page.click('#btn_facturar');
  await page.waitForTimeout(1500);

  await page.click('#rfc');
  await page.keyboard.type('GPR110128QD8', { delay: 20 });
  await page.evaluate(() => {
    const b = document.querySelector('input[name="btn_submit_codigo"]');
    if (b) b.click();
  });
  await page.waitForTimeout(2500);
  await dump(page, 'p2_post_rfc');

  console.log('\n➡️ Click Seleccionar...');
  await page.evaluate(() => {
    const a = Array.from(document.querySelectorAll('a')).find(x => /seleccionar/i.test(x.textContent||''));
    if (a) a.click();
  });
  await page.waitForTimeout(2000);
  await dump(page, 'p3_post_seleccionar');

  console.log('\n➡️ Llenando código de transacción...');
  await page.click('input[name="codigo[]"]');
  await page.keyboard.type('L02013269011', { delay: 20 });
  await page.click('#submit');
  await page.waitForTimeout(2500);
  await dump(page, 'p4_post_codigo');

  console.log('\n=== API CALLS ===');
  console.log(JSON.stringify(apiCalls, null, 2));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
