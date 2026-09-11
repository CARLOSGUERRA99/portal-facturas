// ─────────────────────────────────────────────────────────────────────────────
// RECONOCIMIENTO Wansoft Autoemision — www.wansoft.net (Los Senderos S.A. de C.V.)
//
// ⛔ ESTE SCRIPT NUNCA PULSA #btnGenerateInvoice ("EMITIR FACTURA").
//    Llega a la pantalla anterior, la documenta y para.
//
// Uso:
//   PASO=1  node scripts/probe-wansoft.js                  → landings FE.html de las 3 plazas
//   PASO=2  SID=7780 node scripts/probe-wansoft.js         → los dos formularios (con/sin codigo)
//   PASO=3  SID=7780 CODIGOS="a,b,c" node ...              → prueba codigos contra GetBillingInformation
//   PASO=4  SID=7780 CODIGO=xxx node ...                   → flujo A por UI hasta la pantalla previa
//   PASO=5  SID=7780 FECHA=2026-09-03 ORDEN=288949 TOTAL=39 node ...  → flujo B lleno, sin timbrar
// ─────────────────────────────────────────────────────────────────────────────
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const puppeteer = require('puppeteer');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PASO = process.env.PASO || '1';
const ORIGEN = 'https://www.wansoft.net';

async function dump(page, label, max) {
  const info = await page.evaluate((MAX) => {
    const vis = (el) => el.offsetParent !== null;
    const inputs = Array.from(document.querySelectorAll('input, textarea')).map((i) => ({
      type: (i.type || '').toLowerCase(), id: i.id || null, name: i.name || null,
      placeholder: i.placeholder || null, value: (i.value || '').slice(0, 60),
      readOnly: !!i.readOnly, disabled: !!i.disabled, visible: vis(i), cls: (i.className || '').slice(0, 60),
    }));
    const selects = Array.from(document.querySelectorAll('select')).map((s) => ({
      id: s.id || null, name: s.name || null, visible: vis(s), value: s.value, nOptions: s.options.length,
      primeras: Array.from(s.options).slice(0, 6).map((o) => (o.value + '=' + o.text).slice(0, 70)),
    }));
    const botones = Array.from(document.querySelectorAll('a, button, input[type=button], input[type=submit], [onclick]')).map((b) => ({
      tag: b.tagName, type: (b.type || '').toLowerCase() || null, id: b.id || null,
      cls: (b.className || '').slice(0, 50),
      text: (b.innerText || b.value || '').trim().replace(/\s+/g, ' ').slice(0, 70),
      href: b.getAttribute && b.getAttribute('href') ? b.getAttribute('href').slice(0, 130) : null,
      onclick: b.getAttribute && b.getAttribute('onclick') ? b.getAttribute('onclick').slice(0, 140) : null,
      visible: vis(b),
    })).filter((b) => b.text || b.href || b.onclick || b.id);
    const forms = Array.from(document.querySelectorAll('form')).map((f) => ({
      id: f.id || null, action: f.getAttribute('action'), method: f.method,
    }));
    const turnstile = (() => {
      const d = document.querySelector('.cf-turnstile, [data-sitekey]');
      const ifr = document.querySelector("iframe[src*='challenges.cloudflare.com']");
      const inp = document.querySelector("input[name='cf-turnstile-response'], textarea[name='g-recaptcha-response']");
      if (!d && !ifr && !inp) return null;
      return { html: d ? d.outerHTML.slice(0, 250) : null, sitekey: d ? d.getAttribute('data-sitekey') : null,
               iframeSrc: ifr ? ifr.src.slice(0, 250) : null, campo: inp ? (inp.name || inp.id) : null };
    })();
    return { url: location.href, title: document.title,
             texto: (document.body.innerText || '').replace(/\n{3,}/g, '\n\n').slice(0, MAX),
             forms, inputs, selects, botones, turnstile };
  }, max || 2500).catch((e) => ({ error: e.message }));
  console.log('\n########## ' + label + ' ##########');
  console.log(JSON.stringify(info, null, 1));
  return info;
}

(async () => {
  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error('falta BROWSERLESS_TOKEN en .env');
  const browser = await puppeteer.connect({
    browserWSEndpoint: 'wss://production-sfo.browserless.io?token=' + token + '&stealth=true',
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 1100 });
  await page.setDefaultNavigationTimeout(60000);
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'es-MX,es;q=0.9' });
  // OBLIGATORIO: un alert() sin manejar cuelga el hilo y Browserless mata la pestana.
  page.on('dialog', async (d) => {
    console.log('🔔 DIALOG ' + d.type() + ': ' + JSON.stringify(d.message()));
    await d.accept().catch(() => {});
  });
  page.on('response', async (resp) => {
    const u = resp.url();
    if (!/wansoft\.net\/Wansoft\.Web\/Public\//i.test(u)) return;
    const rt = resp.request().resourceType();
    if (rt !== 'xhr' && rt !== 'fetch') return;
    let body = '';
    try { body = (await resp.text()).slice(0, 1200); } catch (e) {}
    console.log('  [XHR ' + resp.request().method() + ' ' + resp.status() + '] ' + u);
    console.log('     POST: ' + (resp.request().postData() || '').slice(0, 300));
    console.log('     RESP: ' + body);
  });

  try {
    if (PASO === '1') {
      const landings = [
        ORIGEN + '/LosSenderosDurango/FE.html',
        ORIGEN + '/losSenderosMazatlan/Fe.html',
        ORIGEN + '/LosSenderos/Torreon/FE.html', // la URL ROTA del ticket #370
        ORIGEN + '/LosSenderosTorreon/FE.html',  // la buena
      ];
      for (const l of landings) {
        console.log('\n\n🌐 GOTO ' + l);
        try {
          const r = await page.goto(l, { waitUntil: 'networkidle2', timeout: 45000 });
          console.log('   HTTP ' + (r && r.status()) + ' → ' + page.url());
          await sleep(1500);
          await dump(page, 'LANDING ' + l, 1800);
        } catch (e) { console.log('   ❌ ' + e.message); }
      }
    }

    if (PASO === '2') {
      const sid = process.env.SID || '7780';
      for (const u of [
        ORIGEN + '/Wansoft.Web/Public/ElectronicInvoice?sid=' + sid,
        ORIGEN + '/Wansoft.Web/Public/ElectronicInvoice40?sid=' + sid + '&hasCode=false',
      ]) {
        console.log('\n\n🌐 GOTO ' + u);
        try {
          const r = await page.goto(u, { waitUntil: 'networkidle2', timeout: 45000 });
          console.log('   HTTP ' + (r && r.status()) + ' → ' + page.url());
          await sleep(2500);
          await dump(page, 'FORM ' + u, 3000);
        } catch (e) { console.log('   ❌ ' + e.message); }
      }
    }

    if (PASO === '3') {
      // Valida codigos contra el MISMO endpoint que usa SearchInfoCode().
      // Es solo una consulta: NO emite nada.
      const sid = process.env.SID || '7780';
      const codigos = (process.env.CODIGOS || '').split(',').map((s) => s.trim()).filter(Boolean);
      await page.goto(ORIGEN + '/Wansoft.Web/Public/ElectronicInvoice?sid=' + sid, { waitUntil: 'networkidle2', timeout: 60000 });
      await sleep(2500);
      console.log('   URL del formulario: ' + page.url());
      for (const entrada of codigos) {
        // Se admite "sid:codigo" para probar varias sucursales en una sola sesion.
        const [c, sidLocal] = entrada.includes(':')
          ? [entrada.split(':')[1], entrada.split(':')[0]]
          : [entrada, sid];
        console.log('\n🎫 ===== CODIGO "' + c + '" (sid ' + sidLocal + ') =====');
        const resp = await page.evaluate(async (code, s) => {
          const r = await fetch('/Wansoft.Web/Public/GetBillingInformation', {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
            body: 'code=' + encodeURIComponent(code) + '&subsidiaryId=' + encodeURIComponent(s),
          });
          return { status: r.status, body: (await r.text()).slice(0, 2500) };
        }, c, sidLocal).catch((e) => ({ error: e.message }));
        console.log('   → ' + JSON.stringify(resp, null, 1));
      }
    }

    if (PASO === '4') {
      // Flujo A por la UI: teclear el codigo y pulsar la lupa #btnSearchInvoce.
      // NO se toca #btnGenerateInvoice.
      const sid = process.env.SID || '7780';
      const codigo = process.env.CODIGO;
      await page.goto(ORIGEN + '/Wansoft.Web/Public/ElectronicInvoice?sid=' + sid, { waitUntil: 'networkidle2', timeout: 60000 });
      await sleep(2500);
      await page.click('#BillingCode');
      await page.keyboard.type(codigo, { delay: 40 });
      await page.click('#btnSearchInvoce');
      await sleep(5000);
      await dump(page, 'POST-CODIGO ' + codigo, 4000);
      // Datos fiscales del receptor. Se teclea DE VERDAD (click + keyboard.type).
      for (const [sel, v] of [['#rfc', 'GPR110128QD8'], ['#legalName', 'GPN PINTURAS Y RECUBRIMIENTOS'],
                              ['#email', 'buzonfacturas@serviciosga.site'], ['#CP', '80140']]) {
        const h = await page.$(sel);
        if (!h) { console.log('   ⚠️ no existe ' + sel); continue; }
        await h.click({ clickCount: 3 });
        await page.keyboard.type(String(v), { delay: 30 });
        await page.keyboard.press('Tab');
        await sleep(700);
      }
      // <select> bootstrap-select: .value NO basta para el widget; hay que refrescarlo.
      const sels = await page.evaluate(() => {
        const set = (id, v) => {
          const e = document.getElementById(id);
          if (!e) return 'NO EXISTE';
          e.value = v;
          if (window.jQuery) { jQuery(e).trigger('change'); try { jQuery(e).selectpicker('refresh'); } catch (x) {} }
          const btn = e.parentElement.querySelector('button.dropdown-toggle');
          return { value: e.value, textoWidget: btn ? btn.innerText.trim().slice(0, 60) : null };
        };
        return { receiverFiscalRegime: set('receiverFiscalRegime', '601'), ReceiverCfdiUse: set('ReceiverCfdiUse', 'G03'), formOfPayment: set('formOfPayment', '01') };
      });
      console.log('   selects → ' + JSON.stringify(sels));
      await sleep(1200);
      const estado = await page.evaluate(() => {
        const g = (id) => { const e = document.getElementById(id); return e ? (e.value !== undefined ? e.value : e.innerText) : null; };
        const v = (id) => { const e = document.getElementById(id); return !!(e && e.offsetParent !== null); };
        const b = document.getElementById('btnGenerateInvoice');
        return { dataContentVisible: v('dataContent'), formOfPaymentBlockVisible: v('formOfPaymentBlock'),
                 DateTicket: g('DateTicket'), OrderTicket: g('OrderTicket'), TotalTicket: g('TotalTicket'),
                 Date: g('Date'), OrderNumber: g('OrderNumber'), Total: g('Total'),
                 TotalInvoice: g('TotalInvoice'), TipInvoice: g('TipInvoice'),
                 rfc: g('rfc'), legalName: g('legalName'), email: g('email'), CP: g('CP'),
                 receiverFiscalRegime: g('receiverFiscalRegime'), ReceiverCfdiUse: g('ReceiverCfdiUse'),
                 formOfPayment: g('formOfPayment'), IepsBreakdown: (document.getElementById('IepsBreakdown') || {}).checked,
                 DetailedOrGroupedInvoiceSelection: g('DetailedOrGroupedInvoiceSelection'),
                 botonFinal: b ? { id: b.id, value: b.value, type: b.type, disabled: b.disabled, visible: b.offsetParent !== null } : null,
                 serializado: window.jQuery ? jQuery('#formNewDocument').serialize().slice(0, 900) : null };
      }).catch((e) => ({ error: e.message }));
      console.log('\nESTADO TRAS EL CODIGO: ' + JSON.stringify(estado, null, 1));
    }

    if (PASO === '5') {
      // Flujo B (sin codigo): llenar TODO y PARAR justo antes de EMITIR FACTURA.
      const sid = process.env.SID || '7780';
      const fecha = process.env.FECHA;
      const orden = process.env.ORDEN;
      const total = process.env.TOTAL;
      await page.goto(ORIGEN + '/Wansoft.Web/Public/ElectronicInvoice40?sid=' + sid + '&hasCode=false', { waitUntil: 'networkidle2', timeout: 60000 });
      await sleep(2500);
      // #Date es un datepicker READONLY: hay que quitarle el readonly para teclear.
      await page.evaluate(() => { const e = document.querySelector('#Date'); if (e) { e.removeAttribute('readonly'); e.readOnly = false; } });
      const campos = [['#Date', fecha], ['#OrderNumber', orden], ['#Total', total], ['#TotalInvoice', total],
                      ['#rfc', 'GPR110128QD8'], ['#legalName', 'GPN PINTURAS Y RECUBRIMIENTOS'],
                      ['#email', 'buzonfacturas@serviciosga.site'], ['#CP', '80140']];
      for (const [sel, v] of campos) {
        const h = await page.$(sel);
        if (!h) { console.log('   ⚠️ no existe ' + sel); continue; }
        await h.click({ clickCount: 3 });
        await page.keyboard.type(String(v), { delay: 30 });
        await page.keyboard.press('Tab');
        await sleep(500);
      }
      // Los <select> son bootstrap-select: value + selectpicker('refresh').
      const sels = await page.evaluate(() => {
        const set = (id, v) => {
          const e = document.getElementById(id);
          if (!e) return 'NO EXISTE';
          e.value = v;
          if (window.jQuery) { jQuery(e).trigger('change'); try { jQuery(e).selectpicker('refresh'); } catch (x) {} }
          return e.value;
        };
        return { receiverFiscalRegime: set('receiverFiscalRegime', '601'), ReceiverCfdiUse: set('ReceiverCfdiUse', 'G03'), formOfPayment: set('formOfPayment', '28') };
      });
      console.log('   selects → ' + JSON.stringify(sels));
      await sleep(1500);
      await dump(page, 'FLUJO B LLENO (pantalla previa a EMITIR FACTURA)', 3500);
      const estado = await page.evaluate(() => {
        const g = (id) => { const e = document.getElementById(id); return e ? e.value : null; };
        const b = document.getElementById('btnGenerateInvoice');
        return { Date: g('Date'), OrderNumber: g('OrderNumber'), Total: g('Total'), TotalInvoice: g('TotalInvoice'), TipInvoice: g('TipInvoice'),
                 rfc: g('rfc'), legalName: g('legalName'), email: g('email'), CP: g('CP'),
                 receiverFiscalRegime: g('receiverFiscalRegime'), ReceiverCfdiUse: g('ReceiverCfdiUse'), formOfPayment: g('formOfPayment'),
                 formOfPaymentBlockVisible: !!(document.getElementById('formOfPaymentBlock') && document.getElementById('formOfPaymentBlock').offsetParent),
                 botonFinal: b ? { id: b.id, value: b.value, type: b.type, disabled: b.disabled, visible: b.offsetParent !== null } : null };
      });
      console.log('\n🛑 ESTADO FINAL — NO se pulsa EMITIR FACTURA:');
      console.log(JSON.stringify(estado, null, 1));
    }

    if (PASO === '6') {
      // El codigo de facturacion tiene COMO MAXIMO 18 digitos: con 19-20 el portal
      // responde "El codigo de factura es invalido" (ni siquiera busca). Cuando el
      // OCR devuelve una cadena mas larga, sobran digitos. Aqui se prueban todas
      // las variantes que resultan de borrar N digitos, contra GetBillingInformation
      // (una CONSULTA: no emite nada).
      const sid = process.env.SID;
      const base = process.env.BASE;          // la cadena leida por OCR
      const prefijo = process.env.PREFIJO || ''; // trozo que NO se toca (p.ej. la fecha YYMMDD)
      const largo = Number(process.env.LARGO || 18);
      const cola = base.slice(prefijo.length);
      const faltan = cola.length - (largo - prefijo.length);
      const cands = new Set();
      const borrar = (s, n, desde) => {
        if (n === 0) { cands.add(prefijo + s); return; }
        for (let i = desde; i < s.length; i++) borrar(s.slice(0, i) + s.slice(i + 1), n - 1, i);
      };
      borrar(cola, faltan, 0);
      const lista = Array.from(cands);
      console.log('Probando ' + lista.length + ' candidatos de ' + largo + ' digitos (sid ' + sid + ')...');
      await page.goto(ORIGEN + '/Wansoft.Web/Public/ElectronicInvoice?sid=' + sid, { waitUntil: 'networkidle2', timeout: 60000 });
      await sleep(2500);
      const res = await page.evaluate(async (cands, s) => {
        const out = [];
        for (const c of cands) {
          try {
            const r = await fetch('/Wansoft.Web/Public/GetBillingInformation', {
              method: 'POST', credentials: 'include',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
              body: 'code=' + encodeURIComponent(c) + '&subsidiaryId=' + encodeURIComponent(s),
            });
            const t = await r.text();
            if (t.indexOf('"MessageType":1') !== -1) out.push({ codigo: c, body: t.slice(0, 1500) });
          } catch (e) { out.push({ codigo: c, error: e.message }); }
          await new Promise((z) => setTimeout(z, 250));
        }
        return out;
      }, lista, sid);
      console.log('ACIERTOS: ' + JSON.stringify(res, null, 1));
    }

    if (PASO === '7') {
      // Codigo con digitos ilegibles en la foto: PREFIJO fijo + una lista de
      // candidatos por posicion, p.ej. PATRON="1|56 8|389|086|8960|89406".
      const sid = process.env.SID;
      const prefijo = process.env.PREFIJO;
      const patron = process.env.PATRON.split('|').map((g) => g.split(''));
      let lista = [prefijo];
      for (const grupo of patron) {
        const nueva = [];
        for (const base of lista) for (const d of grupo) nueva.push(base + d);
        lista = nueva;
      }
      console.log('Probando ' + lista.length + ' candidatos (sid ' + sid + ')...');
      await page.goto(ORIGEN + '/Wansoft.Web/Public/ElectronicInvoice?sid=' + sid, { waitUntil: 'networkidle2', timeout: 60000 });
      await sleep(2500);
      const res = await page.evaluate(async (cands, s) => {
        const out = [];
        for (const c of cands) {
          try {
            const r = await fetch('/Wansoft.Web/Public/GetBillingInformation', {
              method: 'POST', credentials: 'include',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
              body: 'code=' + encodeURIComponent(c) + '&subsidiaryId=' + encodeURIComponent(s),
            });
            const t = await r.text();
            if (t.indexOf('"MessageType":1') !== -1) out.push({ codigo: c, body: t.slice(0, 1500) });
          } catch (e) {}
          await new Promise((z) => setTimeout(z, 120));
        }
        return out;
      }, lista, sid);
      console.log('ACIERTOS: ' + JSON.stringify(res, null, 1));
    }
  } finally {
    await browser.close().catch(() => {});
  }
  process.exit(0);
})().catch((e) => { console.error('❌ FATAL: ' + e.message); process.exit(1); });
