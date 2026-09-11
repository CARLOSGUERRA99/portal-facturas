// Grupo Centra (Karmi FacturacionWeb) — recorrido real de un ticket.
//
// Sin login y sin CAPTCHA. Los ids son de WEBDEV y no son descriptivos:
//   #A4 RFC · #A1 Buscar · #A3 Nombre · #A71 Régimen · #A117 CP
//   #A15 plaza · #A14 estación · #A41 Empresa · #A13 Dirección
//   #A95_1 Gasolina · #A12 No.Ticket · #A47 Fecha (DD/MM/AAAA) · #A48 Hora (HH:MM)
//   #A17 Cargar · #A24 Agregar · #A40 Facturar
//   #A33 forma de pago · #A45 uso CFDI
//
// Por defecto NO factura: llega hasta tener el ticket cargado y enseña qué
// devolvió el portal. Con --facturar pulsa Agregar y Facturar de verdad.
require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

const TICKETS = {
  260: { estacion: '11024', fecha: '30/07/2026', hora: '17:24', ticket: '3823771', total: 1822.08 },
  264: { estacion: '11055', fecha: '01/08/2026', hora: '21:08', ticket: '3530763', total: 1000.04 },
  267: { estacion: '7870',  fecha: '02/08/2026', hora: '16:20', ticket: '7799576', total: 1184.71 },
  272: { estacion: '11055', fecha: '31/07/2026', hora: '19:31', ticket: '3529181', total: 700.00 },
};
const RFC = 'GPR110128QD8';

// ⚠️ La plaza NO se deduce de la dirección impresa en el ticket: ésa es la del
// OPERADOR (todas dicen San Luis Río Colorado), no la de la estación. El #11024
// TERAN TERAN y el #11055 EJIDO PUEBLA están en MEXICALI, y el #7870 en
// SONOYTA. Por eso se recorren las plazas hasta encontrar el número de estación
// —que sí coincide con el "E.S." del ticket— en vez de adivinarla.

const id = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)));
const FACTURAR = process.argv.includes('--facturar');
const t = TICKETS[id];
if (!t) { console.log('uso: node scripts/probe-grupocentra.js <260|264|267|272> [--facturar]'); process.exit(1); }

(async () => {
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}`,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000 });
  page.on('dialog', async (d) => { console.log('🔔 Dialog:', d.message()); await d.accept().catch(() => {}); });

  const snap = async (e) => {
    const u = await subirArchivoR2(await page.screenshot({ fullPage: true }), `debug/centra_${id}_${e}_${Date.now()}.png`, 'image/png');
    console.log(`📸 ${e}: ${u}`);
    return u;
  };
  const poner = (sel, v) => page.evaluate((s, val) => {
    const e = document.querySelector(s);
    if (!e) return false;
    e.focus();
    e.value = val;
    ['input', 'change', 'keyup', 'blur'].forEach((ev) => e.dispatchEvent(new Event(ev, { bubbles: true })));
    return true;
  }, sel, String(v));
  // ⚠️ NUNCA hacer click ni disparar 'change' desde dentro de page.evaluate en
  // este portal. WEBDEV lanza alert() en varios de esos handlers, y un alert
  // dentro de evaluate bloquea el hilo del navegador: el handler de 'dialog' no
  // llega a correr, Browserless mata la pestaña y sale "Requesting main frame
  // too early". Con page.click / page.select la llamada es fuera de banda y el
  // diálogo sí se puede aceptar. Es la misma lección que 7-Eleven.
  // Los botones sí se pueden pulsar desde evaluate (probado: #A1 Buscar carga
  // los datos fiscales). page.click falla aquí porque la portada se superpone y
  // el clic por coordenadas acaba en el elemento equivocado.
  const pulsar = (sel) => page.evaluate((s) => {
    const e = document.querySelector(s);
    if (!e) return false;
    e.click();
    return true;
  }, sel).catch(() => false);
  const elegir = async (sel, valor) => {
    try { await page.select(sel, valor); return true; } catch { return false; }
  };
  const leer = (sel) => page.evaluate((s) => document.querySelector(s)?.value ?? null, sel);

  // ⚠️ WEBDEV recarga el marco entero en cada postback (elegir plaza, elegir
  // estación, Cargar). Si se lee justo en ese momento sale "Requesting main
  // frame too early". Se espera a que el formulario vuelva a estar montado.
  const esperarFormulario = async (intentos = 12) => {
    for (let i = 0; i < intentos; i++) {
      try {
        const ok = await page.evaluate(() => !!document.querySelector('#A12'));
        if (ok) return true;
      } catch { /* marco aún cambiando */ }
      await dormir(1500);
    }
    // Si no vuelve, hay que ver QUÉ hay en la página: WEBDEV a veces regenera
    // los ids en el postback y entonces #A12 ya no es #A12.
    try {
      const estado = await page.evaluate(() => ({
        url: location.href,
        ids: Array.from(document.querySelectorAll('input, select')).map((e) => `${e.tagName}#${e.id}`).slice(0, 40),
        texto: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 300),
      }));
      console.log('   ⚠️ diagnóstico:', JSON.stringify(estado, null, 1).slice(0, 1200));
    } catch (e) { console.log('   ⚠️ ni siquiera se puede leer la página:', e.message); }
    return false;
  };

  try {
    console.log(`🤖 Grupo Centra · ticket #${id} · E.S. ${t.estacion} · ${t.fecha} ${t.hora} · folio ${t.ticket} · $${t.total}`);
    await page.goto('https://facturacion.grupocentra.mx/Karmi_FacturacionWeb', { waitUntil: 'networkidle2', timeout: 60000 });
    await dormir(2500);
    await pulsar('#M16');            // Facturar GAS
    await page.waitForSelector('#A4', { timeout: 25000 });
    await dormir(2000);

    // ── Datos fiscales: RFC + Buscar los trae del padrón del portal ─────────
    await poner('#A4', RFC);
    await pulsar('#A1');
    await dormir(5000);
    const fiscales = {
      nombre: await leer('#A3'), regimen: await leer('#A71'),
      cp: await leer('#A117'), correo: await leer('#A7'),
    };
    console.log(`   datos fiscales que trajo el portal: ${JSON.stringify(fiscales)}`);
    if (!fiscales.nombre) console.log('   ⚠️ el RFC no cargó datos: puede que no esté dado de alta en el portal');

    // ── Plaza y estación ────────────────────────────────────────────────────
    const plazas = await page.evaluate(() =>
      Array.from(document.querySelector('#A15').options)
        .filter((o) => !/seleccione/i.test(o.textContent))
        .map((o) => ({ v: o.value, t: o.textContent.trim() })));

    // La plaza SÍ va por evaluate: page.select no dispara el AJAX que puebla la
    // lista de sucursales. La ESTACIÓN, en cambio, va por page.select, porque
    // su handler abre un alert y desde evaluate eso mata la pestaña.
    let est = null;
    for (const p of plazas) {
      await page.evaluate((v) => {
        const s = document.querySelector('#A15');
        s.value = v;
        s.dispatchEvent(new Event('change', { bubbles: true }));
      }, p.v).catch(() => {});
      await dormir(4500);
      const encontrada = await page.evaluate((num) => {
        const o = Array.from(document.querySelector('#A14').options).find((x) => x.textContent.includes(`#${num}`));
        return o ? { v: o.value, t: o.textContent.trim() } : null;
      }, t.estacion).catch(() => null);
      if (encontrada) {
        // Elegir la sucursal recarga el marco entero: hay que esperar a esa
        // navegación, o todo lo que se lea después revienta.
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
          elegir('#A14', encontrada.v),
        ]);
        await dormir(3000);
        est = { plaza: p.t, elegida: encontrada.t };
        break;
      }
    }

    if (!est) {
      console.log(`   ❌ la estación #${t.estacion} no aparece en ninguna de las ${plazas.length} plazas`);
      await snap('sin_estacion');
      await browser.close();
      process.exit(1);
    }
    console.log(`   plaza: ${est.plaza}`);
    console.log(`   estación: ${est.elegida}`);
    await dormir(3000);
    if (!await esperarFormulario()) throw new Error('el formulario no volvió tras elegir la estación');
    console.log(`   empresa: ${await leer('#A41')} · dirección: ${await leer('#A13')}`);

    // ── Datos del ticket ────────────────────────────────────────────────────
    const gasolinaMarcada = await page.evaluate(() => document.querySelector('#A95_1')?.checked).catch(() => null);
    if (!gasolinaMarcada) await pulsar('#A95_1');
    await poner('#A12', t.ticket);
    await poner('#A47', t.fecha);
    await poner('#A48', t.hora);
    await dormir(500);
    console.log(`   escrito → ticket:${await leer('#A12')} fecha:${await leer('#A47')} hora:${await leer('#A48')}`);
    await snap('antes_cargar');

    // ── Cargar: el portal busca el consumo y rellena importes ───────────────
    await pulsar('#A17');
    await dormir(8000);
    if (!await esperarFormulario()) throw new Error('el formulario no volvió tras Cargar');
    const cargado = {
      combustible: await leer('#A18'), litros: await leer('#A19'), precio: await leer('#A21'),
      importe: await leer('#A23'), subtotal: await leer('#A26'), iva: await leer('#A27'), total: await leer('#A28'),
    };
    console.log(`   tras Cargar: ${JSON.stringify(cargado)}`);
    await snap('tras_cargar');

    const totalPortal = parseFloat(String(cargado.total || '').replace(/[^\d.]/g, '')) || 0;
    if (!totalPortal) {
      const txt = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 500));
      console.log('   ❌ el portal no cargó el consumo. Pantalla:', txt.slice(0, 300));
      await browser.close();
      process.exit(1);
    }
    if (Math.abs(totalPortal - t.total) > 0.01) {
      console.log(`   ⚠️ el total del portal ($${totalPortal}) no coincide con el del ticket ($${t.total}) — NO se factura`);
      await browser.close();
      process.exit(1);
    }
    console.log(`   ✅ el consumo cuadra: $${totalPortal}`);

    if (!FACTURAR) {
      console.log('\n(sin --facturar: se para aquí, no se emite nada)');
      await browser.close();
      process.exit(0);
    }

    // ── Agregar + Facturar ──────────────────────────────────────────────────
    await page.evaluate(() => {
      const s = document.querySelector('#A45');
      const o = Array.from(s.options).find((x) => /gastos en general/i.test(x.textContent));
      if (o) { s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); }
      const p = document.querySelector('#A33');
      const op = Array.from(p.options).find((x) => /debito/i.test(x.textContent));
      if (op) { p.value = op.value; p.dispatchEvent(new Event('change', { bubbles: true })); }
    });
    await pulsar('#A24');            // Agregar
    await dormir(5000);
    await snap('tras_agregar');

    await pulsar('#A40');            // Facturar
    await dormir(20000);
    await snap('tras_facturar');

    const fin = await page.evaluate(() => ({
      url: location.href,
      texto: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 800),
      enlaces: Array.from(document.querySelectorAll('a')).map((a) => a.href).filter((h) => /xml|pdf|descarg/i.test(h)),
    }));
    console.log('\n═══ RESULTADO ═══');
    console.log('texto:', fin.texto.slice(0, 500));
    console.log('enlaces:', fin.enlaces);

    await browser.close();
    process.exit(0);
  } catch (e) {
    console.error('❌', e.message);
    await snap('excepcion').catch(() => {});
    await browser.close().catch(() => {});
    process.exit(1);
  }
})();
