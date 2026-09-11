// Farmacias Similares (franquicia 7324 → Factura-T / KURIGAGE) — ticket #212.
//
// No hay bot todavía: esto reproduce en vivo el flujo documentado en
// portales.json para ver DÓNDE se para hoy y con qué palabras exactas.
//
// ⚠️ Se envían los datos fiscales REALES y CORRECTOS de GPN, los mismos que
// aparecen en los CFDI ya timbrados. NO se prueban variantes del nombre ni del
// régimen: si una variante colara, el portal timbraría un CFDI a nombre
// equivocado y habría que cancelarlo. Si el portal rechaza los datos buenos,
// el problema es del portal y así hay que reportarlo.
require('dotenv').config();
const puppeteer = require('puppeteer');
const { subirArchivoR2 } = require('../storage/r2');

const PORTAL = 'https://facturacion.appskurigage.com/';

// Datos del ticket #212. El código de barras NO está en el ocr_json (el OCR
// guardó como folio el "TC Ticket", que es un UUID interno): se leyó de la foto
// en la sesión del 13/08 y quedó anotado en portales.json.
const TICKET = {
  sucursal: '7324',
  total: '322.00',
  ventaId: '2799853000012',
};
const FISCAL = {
  rfc: 'GPR110128QD8',
  cp: '80140',
  nombre: 'GPN PINTURAS Y RECUBRIMIENTOS',
  regimen: '601',
  uso: 'G03',
};

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// 🛑 SEGURO. Este script TIMBRA: el 15/08/2026 emitió el CFDI del ticket #212.
// Para BAJAR un CFDI ya emitido no hace falta esto — usa
// scripts/similares-recuperar-cfdi.js, que solo verifica y descarga el ZIP.
if (!process.argv.includes('--timbrar-de-verdad')) {
  console.log('🛑 Este script EMITE una factura real.');
  console.log('   El ticket #212 YA se timbró el 15/08/2026 y su CFDI ya está en R2 y en BD.');
  console.log('   Para recuperar un CFDI ya emitido: node scripts/similares-recuperar-cfdi.js <id>');
  console.log('   Para facturar de verdad otro ticket: --timbrar-de-verdad');
  process.exit(0);
}

(async () => {
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}&stealth=true`,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 950 });
  page.on('dialog', async (d) => { console.log('🔔 Dialog:', d.message()); await d.accept().catch(() => {}); });

  const snap = async (etq) => {
    const u = await subirArchivoR2(await page.screenshot({ fullPage: true }),
      `debug/similares_212_${etq}_${Date.now()}.png`, 'image/png').catch(() => null);
    console.log(`📸 ${etq}: ${u}`);
    return u;
  };
  const poner = (sel, v) => page.evaluate((s, val) => {
    const e = document.querySelector(s);
    if (!e) return false;
    e.value = val;
    ['input', 'change', 'keyup', 'blur'].forEach((ev) => e.dispatchEvent(new Event(ev, { bubbles: true })));
    return true;
  }, sel, String(v));

  try {
    console.log('🌐 Factura-T (KURIGAGE)...');
    await page.goto(PORTAL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('#inputSucursalClave', { timeout: 25000 });
    await dormir(1200);

    // ── Paso A: datos del ticket ────────────────────────────────────────────
    console.log(`📝 sucursal=${TICKET.sucursal} total=${TICKET.total} ventaId=${TICKET.ventaId}`);
    for (const [sel, val] of [
      ['#inputSucursalClave', TICKET.sucursal],
      ['#inputVentaTotal', TICKET.total],
      ['#inputVentaId', TICKET.ventaId],
    ]) {
      if (!await poner(sel, val)) console.log(`   ⚠️ no existe ${sel}`);
    }
    await snap('pasoA_lleno');

    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button, input[type=submit], a'))
        .find((x) => /verificar/i.test(x.textContent || x.value || '') && x.offsetParent);
      if (b) b.click();
    });
    await dormir(6000);
    await snap('pasoA_tras_verificar');

    const trasVerificar = await page.evaluate(() => ({
      texto: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 700),
      hayPasoB: !!document.querySelector('#inputReceptorRFC'),
    }));
    console.log(`\n🔎 ¿llegó a Datos personales?: ${trasVerificar.hayPasoB ? 'SÍ' : 'NO'}`);
    console.log(`   texto: ${trasVerificar.texto.slice(0, 300)}`);

    if (!trasVerificar.hayPasoB) {
      console.log('\n🛑 SE PARA EN LA BÚSQUEDA DE LA VENTA (paso A).');
      await browser.close();
      return;
    }

    // ── Paso B: datos del receptor ──────────────────────────────────────────
    await poner('#inputReceptorRFC', FISCAL.rfc);
    await poner('#inputReceptorCodigoPostal', FISCAL.cp);
    await poner('#inputReceptorNombre', FISCAL.nombre);

    await page.evaluate((cod) => {
      const s = document.querySelector('#selectReceptorRegimenFiscal');
      const o = Array.from(s.options).find((x) => x.value === cod || x.textContent.trim().startsWith(cod));
      if (o) { s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); }
    }, FISCAL.regimen);

    // El uso de CFDI se rellena por AJAX DESPUÉS del régimen: hay que esperar a
    // que deje de decir "Cargando" o se envía vacío.
    await page.waitForFunction(() => {
      const s = document.querySelector('#selectReceptorUsoCFDI');
      return s && s.options.length > 1 && !/cargando/i.test(s.textContent);
    }, { timeout: 20000 }).catch(() => console.log('   ⚠️ el uso de CFDI no terminó de cargar'));

    await page.evaluate((cod) => {
      const s = document.querySelector('#selectReceptorUsoCFDI');
      const o = Array.from(s.options).find((x) => x.value === cod || x.textContent.trim().startsWith(cod));
      if (o) { s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); }
    }, FISCAL.uso);

    const escrito = await page.evaluate(() => ({
      rfc: document.querySelector('#inputReceptorRFC')?.value,
      cp: document.querySelector('#inputReceptorCodigoPostal')?.value,
      nombre: document.querySelector('#inputReceptorNombre')?.value,
      regimen: document.querySelector('#selectReceptorRegimenFiscal')?.value,
      uso: document.querySelector('#selectReceptorUsoCFDI')?.value,
    }));
    console.log(`\n📝 paso B: ${JSON.stringify(escrito)}`);
    await snap('pasoB_lleno');

    // El portal abre un modal promocional ("Nueva funcionalidad") que tapa el
    // formulario. Se cierra antes de tocar nada.
    await page.evaluate(() => {
      const x = Array.from(document.querySelectorAll('button, .close, [data-dismiss=modal], a'))
        .find((e) => /^(×|x|cerrar)$/i.test((e.textContent || '').trim()) && e.offsetParent);
      if (x) x.click();
    });
    await dormir(1000);

    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button, input[type=submit], a'))
        .find((x) => /env[ií]ar/i.test(x.textContent || x.value || '') && x.offsetParent);
      if (b) b.click();
    });
    await dormir(3000);
    await snap('pasoB_tras_enviar');

    // ⚠️ "Antes de continuar — Por favor verifica que los datos ingresados
    // coinciden con los de tu constancia de situación fiscal" NO es un rechazo:
    // es un aviso previo con CONTINUAR / CANCELAR. En la sesión del 13/08 se
    // leyó como si el portal hubiera rechazado los datos fiscales, y por eso
    // este ticket llevaba dos días dado por bloqueado.
    const hayConfirmacion = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button, a'))
        .find((x) => /^continuar$/i.test((x.textContent || '').trim()) && x.offsetParent);
      if (b) { b.click(); return true; }
      return false;
    });
    console.log(`\n🔔 modal "Antes de continuar": ${hayConfirmacion ? 'encontrado y aceptado' : 'no apareció'}`);
    await dormir(12000);
    await snap('tras_continuar');

    // Y todavía queda una pantalla más: "Detalle de compra" enseña los
    // productos y el total para que uno los coteje, y el timbrado real ocurre
    // al pulsar Facturar.
    const detalle = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button, a'))
        .find((x) => /^facturar$/i.test((x.textContent || '').trim()) && x.offsetParent);
      if (b) { b.click(); return true; }
      return false;
    });
    console.log(`🧾 botón "Facturar" (Detalle de compra): ${detalle ? 'pulsado' : 'no apareció'}`);
    if (detalle) {
      await dormir(20000);
      await snap('tras_facturar');
    }

    const fin = await page.evaluate(() => ({
      url: location.href,
      texto: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 900),
      avisos: Array.from(document.querySelectorAll('.alert, .error, .invalid-feedback, [class*=danger], [class*=success], .swal2-html-container, .swal2-title'))
        .filter((e) => e.offsetParent !== null)
        .map((e) => e.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 8),
      enlaces: Array.from(document.querySelectorAll('a')).map((a) => a.href).filter((h) => /xml|pdf|descarg/i.test(h)),
    }));

    console.log('\n═══ RESULTADO ═══');
    console.log('url:', fin.url);
    console.log('avisos:', JSON.stringify(fin.avisos, null, 1));
    console.log('enlaces:', fin.enlaces);
    console.log('texto:', fin.texto.slice(0, 500));

    await browser.close();
  } catch (e) {
    console.error('❌', e.message);
    await snap('excepcion').catch(() => {});
    await browser.close().catch(() => {});
  }
  process.exit(0);
})();
