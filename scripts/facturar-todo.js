// Intenta facturar TODOS los tickets sin factura, uno detrás de otro, y deja
// un informe de qué salió y qué no.
//
// Por qué existe: ir ticket a ticket desde el chat no escala — son decenas, y
// cada intento tarda entre 30 s y 4 min. Esto lo hace del tirón y escribe el
// resultado en docs/informe-facturacion.md.
//
// ⚠️ EN SERIE, A PROPÓSITO. El plan de Browserless permite 2 sesiones
// simultáneas (dashboard, 13/08/2026). Lanzar en paralelo devuelve 429 y tumba
// tickets que no tenían nada malo — pasó con los #229 y #230, que murieron en
// el mismo segundo. Aquí se va de uno en uno y con una pausa entre medias.
//
// ⚠️ CARRERA CON EL WORKER. rescatarTicketsSinEncolar() recoge lo que esté en
// 'pendiente_confirmacion' con requiere_confirmacion=0, y procesarReintentos()
// lo que esté en 'error' con reintento vencido. Los dos ignoran 'procesando',
// así que cada ticket se marca así ANTES de tocarlo. Si no, el worker y este
// script facturarían el mismo folio y saldrían dos CFDI.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const db = require('../lib/db');
const { ejecutarFacturacion } = require('../lib/facturacion');
const { esPortalFacturable } = require('../lib/util');

const PAUSA_MS = Number(process.env.PAUSA_MS || 8000);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// Portales que ya sabemos que no se pueden cerrar solos: intentarlos gasta una
// sesión de Browserless para nada. Se listan aparte en el informe.
const SIN_SALIDA = {
  littlecaesars: 'reCAPTCHA v2 — solo con una persona delante',
  carljr: 'ICR no ha subido la venta a su plataforma; no depende de nosotros',
};

(async () => {
  const soloIds = process.argv.slice(2).map(Number).filter(Boolean);

  const [tickets] = await db.query(`
    SELECT t.id, t.user_id, t.comercio, t.status, t.error_msg, t.ocr_json, t.residente_id
      FROM tickets t
      LEFT JOIN facturas f ON f.ticket_id = t.id
     WHERE f.id IS NULL
       AND t.status NOT IN ('procesado', 'procesando_correo', 'procesando')
     ORDER BY t.id`);

  const cola = soloIds.length ? tickets.filter((t) => soloIds.includes(t.id)) : tickets;

  const res = { ok: [], correo: [], sinSalida: [], falta: [], fallo: [] };
  console.log(`\n═══ ${cola.length} tickets sin factura ═══\n`);

  for (const [i, t] of cola.entries()) {
    let j = {}; try { j = JSON.parse(t.ocr_json || '{}'); } catch {}
    const portal = (j.portal || '').toLowerCase();
    const total = Number(j.total) || 0;
    const etq = `#${t.id} ${(t.comercio || '?').slice(0, 30)} · ${portal || '?'} · $${total}`;
    console.log(`[${i + 1}/${cola.length}] ${etq}`);

    if (SIN_SALIDA[portal]) {
      console.log(`   ⏭️  ${SIN_SALIDA[portal]}\n`);
      res.sinSalida.push({ ...t, portal, total, motivo: SIN_SALIDA[portal] });
      continue;
    }
    if (!esPortalFacturable(j, j.portalUrl)) {
      console.log(`   ⏭️  sin bot para "${portal || 'portal desconocido'}" (${j.portalUrl || 'sin URL'})\n`);
      res.falta.push({ ...t, portal, total, url: j.portalUrl || null });
      continue;
    }

    const estadoPrevio = t.status;
    await db.query("UPDATE tickets SET status = 'procesando' WHERE id = ?", [t.id]);

    const t0 = Date.now();
    let r;
    try {
      r = await ejecutarFacturacion(t.id, t.user_id);
    } catch (e) {
      await db.query('UPDATE tickets SET status = ? WHERE id = ?', [estadoPrevio, t.id]);
      r = { ok: false, msg: `excepción: ${e.message}` };
    }
    const seg = ((Date.now() - t0) / 1000).toFixed(0);

    const [[fin]] = await db.query('SELECT status, error_msg FROM tickets WHERE id = ?', [t.id]);
    // Si ejecutarFacturacion salió por un camino que no toca el estado, se
    // devuelve el anterior para que el ticket no quede invisible para la cola.
    if (fin.status === 'procesando') await db.query('UPDATE tickets SET status = ? WHERE id = ?', [estadoPrevio, t.id]);

    const fila = { id: t.id, comercio: t.comercio, portal, total, seg, msg: fin.error_msg || r?.msg || '' };
    if (r?.ok && r.procesandoCorreo) { console.log(`   📧 timbrado — el CFDI llega por correo (${seg}s)\n`); res.correo.push(fila); }
    else if (r?.ok) { console.log(`   ✅ FACTURADO (${seg}s)\n`); res.ok.push(fila); }
    else { console.log(`   ❌ ${(fila.msg || '?').slice(0, 110)} (${seg}s)\n`); res.fallo.push({ ...fila, code: r?.error_code || '' }); }

    if (i < cola.length - 1) await dormir(PAUSA_MS);
  }

  // ── Informe ───────────────────────────────────────────────────────────────
  const dinero = (l) => l.reduce((s, x) => s + (x.total || 0), 0).toFixed(2);
  const tabla = (l, cols) => l.length
    ? l.map((x) => `| #${x.id} | ${(x.comercio || '?').slice(0, 34)} | ${x.portal || '?'} | $${(x.total || 0).toFixed(2)} |${cols ? ` ${(x.msg || x.motivo || x.url || '').replace(/\|/g, '/').slice(0, 150)} |` : ''}`).join('\n')
    : '| — | — | — | — |' + (cols ? ' — |' : '');

  const md = `# Informe de facturación

Generado el ${new Date().toLocaleString('es-MX')} · ${cola.length} tickets intentados

| resultado | tickets | importe |
|---|---|---|
| ✅ facturados | ${res.ok.length} | $${dinero(res.ok)} |
| 📧 timbrados, CFDI por correo | ${res.correo.length} | $${dinero(res.correo)} |
| ❌ el portal los rechazó | ${res.fallo.length} | $${dinero(res.fallo)} |
| 🔒 sin salida automática | ${res.sinSalida.length} | $${dinero(res.sinSalida)} |
| 🧩 sin bot todavía | ${res.falta.length} | $${dinero(res.falta)} |

## ✅ Facturados
| ticket | comercio | portal | importe |
|---|---|---|---|
${tabla(res.ok)}

## 📧 Timbrados — el CFDI llega por correo
| ticket | comercio | portal | importe |
|---|---|---|---|
${tabla(res.correo)}

## ❌ Rechazados por el portal
| ticket | comercio | portal | importe | motivo (palabras del portal) |
|---|---|---|---|---|
${tabla(res.fallo, true)}

## 🔒 Sin salida automática
| ticket | comercio | portal | importe | por qué |
|---|---|---|---|---|
${tabla(res.sinSalida, true)}

## 🧩 Sin bot todavía
| ticket | comercio | portal | importe | portal real |
|---|---|---|---|---|
${tabla(res.falta, true)}
`;

  const ruta = path.join(__dirname, '..', 'docs', 'informe-facturacion.md');
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  fs.writeFileSync(ruta, md);

  console.log('═'.repeat(60));
  console.log(`✅ ${res.ok.length} facturados ($${dinero(res.ok)})`);
  console.log(`📧 ${res.correo.length} por correo ($${dinero(res.correo)})`);
  console.log(`❌ ${res.fallo.length} rechazados ($${dinero(res.fallo)})`);
  console.log(`🔒 ${res.sinSalida.length} sin salida ($${dinero(res.sinSalida)})`);
  console.log(`🧩 ${res.falta.length} sin bot ($${dinero(res.falta)})`);
  console.log(`\ninforme: ${ruta}`);
  process.exit(0);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
