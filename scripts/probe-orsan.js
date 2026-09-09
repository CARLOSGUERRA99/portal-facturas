/**
 * Sondea mifactura.orsan.com.mx tras iniciar sesión, para mapear el flujo de
 * facturación. Las credenciales salen de .env (ORSAN_USER / ORSAN_PASS), nunca
 * escritas en el código.
 *
 * Este portal NO tiene facturación sin registro: sus únicas rutas públicas son
 * #/login-form, #/create-account y #/reset-password. Por eso hace falta cuenta.
 *
 * Uso: node scripts/probe-orsan.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const puppeteer = require('puppeteer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!process.env.ORSAN_USER || !process.env.ORSAN_PASS) {
    console.error('❌ Falta ORSAN_USER / ORSAN_PASS en .env');
    process.exit(1);
  }
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}&stealth=true`,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000 });
  page.on('dialog', async (d) => { console.log('  dialog:', d.message()); await d.accept().catch(() => {}); });

  const resumen = async (etiqueta) => {
    const d = await page.evaluate(() => ({
      url: location.href,
      inputs: Array.from(document.querySelectorAll('input:not([type=hidden]),select,textarea'))
        .filter((e) => e.offsetParent)
        .map((e) => ({ id: e.id, name: e.name, type: e.type, ph: e.placeholder || '', aria: e.getAttribute('aria-label') || '' })),
      botones: Array.from(document.querySelectorAll('button,a,[role=button],.dx-button'))
        .filter((e) => e.offsetParent)
        .map((e) => (e.textContent || '').trim().slice(0, 30)).filter(Boolean).slice(0, 25),
      txt: document.body.innerText.replace(/\s+/g, ' ').slice(0, 700),
    }));
    console.log(`\n=== ${etiqueta} ===`);
    console.log(JSON.stringify(d, null, 1));
    return d;
  };

  try {
    console.log('1. Abriendo login...');
    await page.goto('https://mifactura.orsan.com.mx/#/login-form', { waitUntil: 'networkidle2', timeout: 45000 });
    await sleep(6000);

    console.log('2. Iniciando sesión...');
    // DevExtreme: los ids llevan un GUID que cambia, así que se localizan por
    // type en vez de por id.
    await page.evaluate((u, p) => {
      const set = (el, v) => {
        const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        s.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
      };
      const mail = document.querySelector('input[type=email]');
      const pass = document.querySelector('input[type=password]');
      if (mail) set(mail, u);
      if (pass) set(pass, p);
    }, process.env.ORSAN_USER, process.env.ORSAN_PASS);
    await sleep(1500);
    await page.evaluate(() => {
      const b = document.querySelector('input[type=submit]')
        || Array.from(document.querySelectorAll('button,[role=button],.dx-button')).find((x) => /iniciar sesi/i.test(x.textContent || ''));
      if (b) b.click();
    });
    await sleep(12000);

    const d = await resumen('TRAS LOGIN');
    if (/login-form/.test(d.url)) {
      console.log('\n⚠️ Sigue en la pantalla de login — revisa usuario/contraseña o si pide algo más.');
      await browser.close();
      process.exit(1);
    }

    // Al entrar sale un modal recordando revisar las razones sociales; tapa
    // todo lo demás, así que hay que cerrarlo antes de navegar.
    console.log('\n3. Cerrando el aviso de razones sociales...');
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button,a,[role=button],.dx-button'))
        .filter((x) => x.offsetParent)
        .find((x) => /^\s*cerrar\s*$/i.test((x.textContent || '').trim()));
      if (b) b.click();
    });
    await sleep(5000);

    console.log('4. Ruta #/bill (Facturar Ticket)...');
    await page.goto('https://mifactura.orsan.com.mx/#/bill', { waitUntil: 'networkidle2', timeout: 45000 });
    await sleep(9000);
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button,a,[role=button],.dx-button'))
        .filter((x) => x.offsetParent)
        .find((x) => /^\s*cerrar\s*$/i.test((x.textContent || '').trim()));
      if (b) b.click();
    });
    await sleep(4000);
    await resumen('FORMULARIO DE FACTURAR TICKET');

    // Los inputs de DevExtreme no traen id ni placeholder útiles: el rótulo
    // vive en el contenedor de al lado, así que se lee de ahí.
    const campos = await page.evaluate(() => Array.from(document.querySelectorAll('input[type=text]'))
      .filter((e) => e.offsetParent)
      .map((e, i) => {
        const caja = e.closest('.dx-field, .dx-item, .form-group, div');
        const previo = caja && caja.previousElementSibling;
        return {
          i,
          rotuloCaja: caja ? (caja.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40) : '',
          rotuloPrevio: previo ? (previo.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40) : '',
          clase: (e.className || '').slice(0, 50),
        };
      }));
    console.log('\n=== RÓTULOS DE LOS CAMPOS ===');
    console.log(JSON.stringify(campos, null, 1));

    const buf = await page.screenshot({ fullPage: true });
    fs.writeFileSync(require('path').join(__dirname,'..','tmp','orsan-bill.png'), buf);
    console.log('\n📸 captura → tmp/orsan-bill.png');

    await browser.close();
    process.exit(0);
  } catch (e) {
    console.error('❌', e.message);
    await browser.close().catch(() => {});
    process.exit(1);
  }
})();
