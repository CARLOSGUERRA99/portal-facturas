/**
 * SONDEO — Grupo Estrella Blanca / Autobuses Expreso Futura (marca FUTURA SIENTE MX)
 *   URL real: https://factura.estrellablanca.com.mx/generar-factura  (200, NO redirige)
 *   SPA React (bundle unico /static/js/main.<hash>.js, hoy main.6af642ef.js).
 *   Plataforma AMS Integra; backend https://apifacturasestrellablanca.amsintegra.com.mx/main
 *   Sin login. Sin captcha de ningun tipo.
 *
 * ⛔ ESTE SCRIPT NUNCA TIMBRA. Hay DOS botones que dicen "Facturar":
 *      A) el del modal "Informacion de Facturacion" → button.ternary-second
 *         POST /Operacion/generarCfdi con isGenerarCFDI:"0" = SOLO PREVISUALIZA
 *         (comprobado: la respuesta trae Folio:"" y NoCertificado:"000...0").
 *      B) el del paso 3 "Genera tu factura"        → button.primary
 *         abre el modal "Facturar / ¿Desea confirmar la emision de la factura?"
 *         y su "Aceptar" lanza generarCfdi con isGenerarCFDI:"1" ← ESE TIMBRA.
 *    guardiaAntiTimbre() intercepta el (B) y su confirmacion por si acaso.
 *
 * ── EL BLOQUEO RESUELTO: por que #regimenFiscal y #usoCfdi salian vacios ──
 *   NO era lentitud ni un input hidden. Los catalogos se piden EN CASCADA y
 *   solo los dispara la interaccion humana:
 *     1. #rfc  --onBlur(focusout), y SOLO si value.length es 12 o 13-->
 *              GET /Catalogos/obtenerRegimenFiscal/{RFC}   (9 opciones)
 *     2. #regimenFiscal --onChange--> useEffect([regimenFiscal]) -->
 *              GET /Catalogos/obtenerUsoCfdi?rfc={RFC}&regimenFiscal={IdRegimenFiscal}
 *   Si el RFC se rellena con .value a pelo, React no ve nada y NINGUNA de las
 *   dos llamadas sale: los dos <select> se quedan con su unico <option>
 *   placeholder para siempre. Hay que TECLEAR y provocar un focusout de verdad.
 *
 *   ⚠️ El <option> de #regimenFiscal vale IdRegimenFiscal, NO la clave del SAT:
 *      601 => value "1". Hay que elegir por la ETIQUETA ("601 - ...").
 *      Si le metes "601" como value, obtenerUsoCfdi responde data:[] (probado)
 *      y ademas el payload final sale con regimenFiscal:"" → "El Regimen Fiscal
 *      es requerido". Por eso tambien SOBRA el boton lupa de al lado del RFC
 *      (/Catalogos/obtenerReceptor/{RFC}): autorrellena el domicilio pero
 *      escribe la clave "601" en un select cuyas opciones son ids. No usarlo.
 *
 * ── Endpoints utiles (todos GET salvo generarCfdi) ──
 *   /Catalogos/obtenerTicket/GEB?tipo=1&noComprobante=..&noTr=..&precio=..
 *        &claveTicket=AUTOBUS&franquicia=null&noTicket=&sucursal=null&fechaVenta=
 *        → valida el boleto. Trae TicketTimbrado (0/1) y FacturableMes (0/1):
 *          sirve para detectar "ya facturado" y "vencido" SIN abrir el navegador.
 *   /Catalogos/obtenerRegimenFiscal/{RFC}      → [{IdRegimenFiscal,Clave,Descripcion}]
 *   /Catalogos/obtenerUsoCfdi?rfc=..&regimenFiscal={IdRegimenFiscal}
 *   /Operacion/generarCfdi                     → isGenerarCFDI 0=preview, 1=TIMBRA
 *   /Operacion/obtenerCfdis?rfc=..&folio={#Comprobante}&claveTicket=AUTOBUS
 *        → recuperar un CFDI ya emitido (es lo que usa /mis-facturas)
 *   /Operacion/obtenerRutaS3?keyUrl=..         → descarga del XML/PDF
 *
 * ── Plazo y contacto (publicados en la propia pagina) ──
 *   "solo tiene el mes en que lo adquirio y hasta 7 dias del mes siguiente".
 *   atencion.cliente@estrellablanca.com.mx
 *   El importe a facturar es Subtotal+IVA: NO incluye "Programa de Asistencia"
 *   ni "Sin Carbono". Para los tickets 354/369 el total del OCR ya era el bueno.
 *
 * Uso:  node scripts/probe-estrellablanca.js [354|369] [--preview]
 *       --preview = pulsa ademas el "Facturar" del modal (isGenerarCFDI:0) para
 *                   documentar el paso 3. Sigue SIN timbrar.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

process.on('unhandledRejection', (e) => console.log('  ⚠️ unhandledRejection:', (e && e.message) || String(e)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = path.join(__dirname, '..', 'tmp');
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

const PORTAL = 'https://factura.estrellablanca.com.mx/generar-factura';
const API = 'https://apifacturasestrellablanca.amsintegra.com.mx/main';

// Datos reales de los tickets 354 / 369 (BD, columna ocr_json).
const TICKETS = {
  354: { comprobante: 'MAZE1600176772285', tr: 'VB84', precio: 1569.5, fecha: '04/09/2026' },
  369: { comprobante: 'MAZE1600176772284', tr: 'VB84', precio: 1744, fecha: '03/09/2026' },
};

const RECEPTOR = {
  rfc: 'GPR110128QD8',
  razon: 'GPN PINTURAS Y RECUBRIMIENTOS',
  claveRegimen: '601',
  claveUso: 'G03',
  calle: 'CALZADA AEROPUERTO',
  noExterior: '7569',
  colonia: 'BACHIGUALATO',
  cp: '80140',
  municipio: 'CULIACAN',
  estado: 'SINALOA',
  pais: 'MEX',
  email: 'buzonfacturas@serviciosga.site',
};

const ID = process.argv[2] && TICKETS[process.argv[2]] ? process.argv[2] : '354';
const TICKET = TICKETS[ID];
const PREVIEW = process.argv.includes('--preview');

// --------------------------------------------------------------- utilidades
async function inventario(page, etiqueta) {
  const d = await page.evaluate(() => {
    const vis = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
    const campos = Array.from(document.querySelectorAll('input,select,textarea')).map((e) => {
      const o = { tag: e.tagName, type: e.type || null, id: e.id || null, name: e.name || null,
        ph: e.placeholder || null, vis: vis(e), val: (e.value || '').slice(0, 45), chk: e.checked };
      if (e.tagName === 'SELECT') {
        o.nOptions = e.options.length;
        o.options = Array.from(e.options).map((x) => `${x.value}|${x.textContent.trim().slice(0, 50)}`);
      }
      return o;
    });
    const botones = Array.from(document.querySelectorAll('button,a[href],[role=button]'))
      .filter(vis)
      .map((e) => ({ tag: e.tagName, id: e.id || null, type: e.type || null,
        text: (e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 45),
        clase: (e.className || '').toString().slice(0, 45), disabled: e.disabled === true }))
      .filter((b) => b.text);
    return { url: location.href, campos, botones,
      texto: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 1200) };
  });
  console.log(`\n========== ${etiqueta} ==========`);
  console.log(JSON.stringify(d, null, 1));
  const buf = await page.screenshot({ fullPage: true }).catch(() => null);
  if (buf) {
    const f = path.join(TMP, `eb_${etiqueta.replace(/[^a-z0-9]+/gi, '_')}.png`);
    fs.writeFileSync(f, buf);
    console.log('📸', f);
  }
  return d;
}

/** TRAMPA 1: al cargar sale el modal "Aviso Importante" (CFDI 4.0) tapando TODO.
 *  Mientras este abierto, cualquier page.click() se lo come el overlay y los
 *  inputs se quedan vacios sin dar ningun error. Hay que cerrarlo lo primero. */
async function cerrarAviso(page) {
  const r = await page.evaluate(() => {
    const h = Array.from(document.querySelectorAll("h4,h3,h2"))
      .find((x) => /aviso importante/i.test(x.textContent || ""));
    if (!h) return "no habia aviso";
    const caja = h.closest(".modal") || h.parentElement.parentElement;
    const b = Array.from(caja.querySelectorAll("button")).find((x) => /aceptar/i.test(x.textContent || ""));
    if (b) { b.click(); return "cerrado con Aceptar"; }
    const x = caja.querySelector("span,img");
    if (x) { x.click(); return "cerrado con la X"; }
    return "no encontre como cerrarlo";
  });
  console.log("  🚪 Aviso Importante:", r);
  await sleep(1500);
}

/** TRAMPA 2: tras "Anadir boleto" sale el modal "Boleto(s) anadido(s)" con un
 *  boton "Cerrar". Mientras siga abierto tapa la tabla, las casillas y
 *  "Siguiente": los clicks se pierden SIN error. Hay que cerrarlo. */
async function cerrarModalAviso(page, etiqueta) {
  const r = await page.evaluate(() => {
    const vis = (e) => !!(e.offsetWidth || e.offsetHeight);
    const b = Array.from(document.querySelectorAll("button"))
      .filter(vis)
      .find((x) => /^\s*cerrar\s*$/i.test(x.textContent || ""));
    if (!b) return { cerrado: false };
    const caja = b.closest(".modal") || b.parentElement;
    const txt = (caja.innerText || "").replace(/\s+/g, " ").trim().slice(0, 160);
    b.click();
    return { cerrado: true, texto: txt };
  });
  console.log("  🚪 modal " + etiqueta + ":", JSON.stringify(r));
  await sleep(1800);
  return r;
}

/** Dice si el modal "Informacion de Facturacion" esta realmente VISIBLE. */
const modalFiscalVisible = (page) => page.evaluate(() => {
  const e = document.getElementById("rfc");
  return !!(e && e.getClientRects().length && e.offsetWidth);
});

/** Teclea de verdad: React ignora el .value puesto a mano en un input controlado. */
async function teclear(page, sel, texto) {
  const existe = await page.$(sel);
  if (!existe) { console.log('  ⚠️ NO EXISTE', sel); return false; }
  await page.click(sel, { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.keyboard.type(String(texto), { delay: 40 });
  const v = await page.$eval(sel, (e) => e.value);
  console.log(`  ✏️ ${sel} = "${v}"`);
  return v === String(texto);
}

/** Elige la <option> cuyo texto empieza por `clave` (el value es un id interno). */
async function elegirPorClave(page, sel, clave) {
  const r = await page.evaluate((s, c) => {
    const el = document.querySelector(s);
    if (!el) return { ok: false, motivo: 'no existe el select' };
    const op = Array.from(el.options).find((o) => o.textContent.trim().startsWith(c + ' '));
    if (!op) return { ok: false, motivo: `sin option "${c}"`, hay: el.options.length };
    // El setter nativo evita que React descarte el cambio.
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')
      .set.call(el, op.value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, value: op.value, label: op.textContent.trim() };
  }, sel, clave);
  console.log(`  🔽 ${sel} →`, JSON.stringify(r));
  return r;
}

/** Cuenta las <option> de los dos selects del bloqueo. */
const catalogos = (page) => page.evaluate(() => {
  const n = (id) => { const e = document.getElementById(id); return e ? e.options.length : -1; };
  return { regimenFiscal: n('regimenFiscal'), usoCfdi: n('usoCfdi') };
});

/** Aborta si alguien intenta pulsar el boton que timbra. */
async function guardiaAntiTimbre(page) {
  await page.evaluate(() => {
    document.addEventListener('click', (ev) => {
      const b = ev.target.closest && ev.target.closest('button');
      if (!b) return;
      const t = (b.textContent || '').trim();
      const esTimbre = (/^facturar$/i.test(t) && /\bprimary\b/.test(b.className))
        || (/^aceptar$/i.test(t) && /confirm/i.test(document.body.innerText.slice(0, 4000)) && /Desea confirmar la emisi/i.test(document.body.innerText));
      if (esTimbre) {
        ev.preventDefault(); ev.stopImmediatePropagation();
        console.error('GUARDIA: bloqueado un click sobre el boton que TIMBRA');
      }
    }, true);
  });
}

(async () => {
  // Browserless devuelve 429 si ya hay una sesion viva del mismo token; reintenta.
  let browser = null;
  for (let i = 1; i <= 8 && !browser; i++) {
    try {
      browser = await puppeteer.connect({
        browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}&stealth=true`,
      });
    } catch (e) {
      console.log(`  ⏳ connect intento ${i}: ${e.message} — espero 30s`);
      await sleep(30000);
    }
  }
  if (!browser) { console.error('❌ no se pudo conectar a Browserless'); process.exit(1); }
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1100 });
  // Sin esto, un alert() sin manejar cuelga el hilo y Browserless mata la pestaña.
  page.on('dialog', async (d) => { console.log('  🗨️ dialog:', d.type(), d.message()); await d.accept().catch(() => {}); });
  page.on('console', (m) => { const t = m.text(); if (/GUARDIA|Error|error/.test(t)) console.log('  ⛔ console:', t.slice(0, 180)); });

  const red = [];
  page.on('response', async (res) => {
    const u = res.url();
    if (!/amsintegra|estrellablanca/.test(u)) return;
    if (/\.(png|jpg|svg|woff2?|css|ico|js)(\?|$)/i.test(u)) return;
    const reg = { st: res.status(), m: res.request().method(), url: u.replace(API, '{API}') };
    if (/Catalogos|Operacion|catalogos/i.test(u)) {
      reg.body = await res.text().then((t) => t.slice(0, 500)).catch(() => '?');
      const pd = res.request().postData();
      if (pd) reg.post = pd.slice(0, 700);
    }
    red.push(reg);
    console.log(`  🌐 ${reg.st} ${reg.m} ${reg.url}`);
  });

  try {
    console.log(`=== TICKET ${ID}:`, JSON.stringify(TICKET), PREVIEW ? '(con --preview)' : '', '===');

    // -------------------------------------------------- PASO 1: el boleto
    console.log('\n1) Abriendo el portal...');
    await page.goto(PORTAL, { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(3500);
    await guardiaAntiTimbre(page);
    await cerrarAviso(page);
    await inventario(page, 'P1_inicio');
    console.log('  catalogos al cargar →', JSON.stringify(await catalogos(page)),
      ' ← ambos a 1 = solo el placeholder, confirmado que NO se piden al cargar');

    console.log('\n2) Rellenando el boleto (ojo: los ids van en Mayuscula)...');
    await teclear(page, '#NoComprobante', TICKET.comprobante);
    await teclear(page, '#NoTr', TICKET.tr);
    await teclear(page, '#Precio', TICKET.precio);

    console.log('\n3) "Añadir boleto"...');
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find((x) => /a[ñn]adir boleto/i.test(x.textContent || ''));
      if (b) b.click();
    });
    await sleep(8000);
    const p3 = await inventario(page, 'P2_boleto_anadido');
    await cerrarModalAviso(page, '"Boleto(s) anadido(s)"');
    if (/no se encontr|no existe|inv[aá]lid|error/i.test(p3.texto) && !/Sin boletos/i.test(p3.texto)) {
      console.log('  ⚠️ ojo al texto de arriba, puede haber modal de error');
    }

    console.log('\n4) Marcando la casilla del boleto en la tabla...');
    const cb = await page.evaluate(() => {
      const cbs = Array.from(document.querySelectorAll('input[type=checkbox]'))
        .filter((c) => c.offsetWidth || c.offsetHeight);
      cbs.forEach((c) => { if (!c.checked) c.click(); });
      return cbs.map((c) => ({ id: c.id || null, name: c.name || null, clase: (c.className || '').slice(0, 40), chk: c.checked }));
    });
    console.log('  casillas:', JSON.stringify(cb));
    await sleep(1200);

    console.log('\n5) "Siguiente" → abre el modal "Informacion de Facturacion"...');
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find((x) => /^\s*siguiente\s*$/i.test(x.textContent || ''));
      if (b) b.click();
    });
    await sleep(4500);
    console.log('  ¿modal fiscal visible? →', await modalFiscalVisible(page));
    await inventario(page, 'P3_modal_datos_fiscales');

    // ------------------------------- PASO 2: LA CASCADA QUE ESTABA ROTA
    console.log('\n6) 🔑 RFC + focusout REAL (es lo que dispara obtenerRegimenFiscal)...');
    console.log('  antes del RFC →', JSON.stringify(await catalogos(page)));
    await teclear(page, '#rfc', RECEPTOR.rfc);
    await page.keyboard.press('Tab');          // focusout de verdad → React onBlur
    await page.evaluate(() => document.getElementById('rfc') && document.getElementById('rfc').blur());
    await sleep(6000);
    console.log('  ✅ DESPUES del RFC →', JSON.stringify(await catalogos(page)));

    console.log('\n7) Eligiendo Regimen Fiscal 601 (por etiqueta: el value es IdRegimenFiscal)...');
    await elegirPorClave(page, '#regimenFiscal', RECEPTOR.claveRegimen);
    await sleep(6000);
    console.log('  ✅ tras elegir regimen →', JSON.stringify(await catalogos(page)));

    console.log('\n8) Eligiendo Uso de CFDI G03 (aqui el value SI es la clave)...');
    await elegirPorClave(page, '#usoCfdi', RECEPTOR.claveUso);
    await sleep(1500);

    console.log('\n9) Resto de datos fiscales...');
    await teclear(page, '#nombreRazonSocial', RECEPTOR.razon);
    await teclear(page, '#calle', RECEPTOR.calle);
    await teclear(page, '#noExterior', RECEPTOR.noExterior);
    await teclear(page, '#colonia', RECEPTOR.colonia);
    await teclear(page, '#codigoPostal', RECEPTOR.cp);
    await teclear(page, '#municipio', RECEPTOR.municipio);
    await teclear(page, '#estado', RECEPTOR.estado);
    await teclear(page, '#pais', RECEPTOR.pais);
    await teclear(page, '#email', RECEPTOR.email);
    await sleep(1200);

    const lleno = await inventario(page, 'P4_modal_completo');
    const btnModal = lleno.botones.filter((b) => /facturar/i.test(b.text));
    console.log('\n  BOTONES "Facturar" visibles ahora:', JSON.stringify(btnModal, null, 1));

    if (!PREVIEW) {
      console.log('\n⛔ PARADA. El modal esta completo y su boton "Facturar" (class ternary-second)');
      console.log('   ya deberia estar habilitado. Corre con --preview para ver ademas el paso 3.');
    } else {
      console.log('\n10) Pulsando el "Facturar" DEL MODAL (ternary-second → isGenerarCFDI:"0", solo previsualiza)...');
      await page.evaluate(() => {
        const b = Array.from(document.querySelectorAll('button'))
          .find((x) => /^\s*facturar\s*$/i.test(x.textContent || '') && /ternary-second/.test(x.className) && !x.disabled);
        if (b) b.click(); else console.error('Error: no hay boton Facturar habilitado en el modal');
      });
      await sleep(12000);
      await inventario(page, 'P5_paso3_previsualizacion');
      const rs = await page.evaluate(() => Array.from(document.querySelectorAll('[class*=css-][class*=-control], .select__control'))
        .map((e) => ({ clase: e.className, txt: (e.textContent || '').trim().slice(0, 40) })));
      console.log('\n  react-select (Forma de pago) en el paso 3:', JSON.stringify(rs, null, 1));
      console.log('\n⛔ PARADA DEFINITIVA: el boton "Facturar" class="primary" de esta pantalla');
      console.log('   es el que TIMBRA. NO se pulsa.');
    }

    console.log('\n=== RED (solo API) ===');
    console.log(JSON.stringify(red, null, 1));
  } catch (e) {
    console.error('❌', e.message, '\n', e.stack);
    await page.screenshot({ path: path.join(TMP, 'eb_ERROR.png'), fullPage: true }).catch(() => {});
  } finally {
    await browser.close().catch(() => {});
    process.exit(0);
  }
})();
