// Reconocimiento del ControlGasFE propio de la estación LA SUERTE
// (hemajolasuerte.ddns.net:8087). Es un ASP.NET WebForms distinto de
// app.facturagas.net: el bot de FacturaGAS no sirve aquí porque esa estación no
// existe en su autocomplete.
require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');
const dormir = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const b = await puppeteer.connect({ browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}&stealth=true` });
  const p = await b.newPage();
  await p.setViewport({ width: 1280, height: 1000 });
  p.on('dialog', async d => { console.log('🔔', d.message()); await d.accept().catch(()=>{}); });
  await p.goto('http://hemajolasuerte.ddns.net:8087/ControlGasFE/', { waitUntil: 'networkidle2', timeout: 40000 });
  await dormir(3000);

  const campos = await p.evaluate(() => ({
    inputs: [...document.querySelectorAll('input:not([type=hidden])')].map(i => ({ id: i.id, name: i.name, tipo: i.type, ph: i.placeholder, vis: i.offsetParent !== null })),
    selects: [...document.querySelectorAll('select')].map(s => ({ id: s.id, name: s.name, n: s.options.length })),
    captcha: document.querySelectorAll('iframe[src*=recaptcha],[class*=captcha],[id*=aptcha]').length,
    texto: document.body.innerText.replace(/\s+/g, ' ').slice(0, 500),
  }));
  console.log('INICIO:', JSON.stringify(campos, null, 1).slice(0, 1500));

  // Pulsar "Facturar" (el flujo que emite, no el que solo consulta)
  const h = await p.evaluateHandle(() => document.querySelector('#imgbtnFacturarFast') || document.querySelector('#imgbtnFacturarLarge'));
  const el = h.asElement();
  if (el) { await el.click(); await dormir(5000); }

  const paso2 = await p.evaluate(() => ({
    url: location.href,
    inputs: [...document.querySelectorAll('input:not([type=hidden])')].map(i => ({ id: i.id, name: i.name, tipo: i.type, ph: i.placeholder, vis: i.offsetParent !== null })),
    selects: [...document.querySelectorAll('select')].map(s => ({ id: s.id, name: s.name, n: s.options.length, ops: [...s.options].slice(0,4).map(o=>o.text) })),
    labels: [...document.querySelectorAll('label,span.lbl,td')].map(x => x.textContent.trim()).filter(t => t && t.length < 40).slice(0, 25),
    captcha: document.querySelectorAll('iframe[src*=recaptcha],[class*=captcha],[id*=aptcha]').length,
    texto: document.body.innerText.replace(/\s+/g, ' ').slice(0, 600),
  }));
  console.log('\nTRAS FACTURAR:', JSON.stringify(paso2, null, 1).slice(0, 2600));
  console.log('📸', await subirArchivoR2(await p.screenshot({fullPage:true}), `debug/controlgasfe_recon_${Date.now()}.png`, 'image/png'));
  await b.close(); process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
