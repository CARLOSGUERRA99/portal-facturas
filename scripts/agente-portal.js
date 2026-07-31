// Lanza el agente de alta automática de portales para UN ticket concreto.
//
// El agente hace: analizar el portal en vivo → generar el bot → validarlo
// corriéndolo de verdad → corregirlo hasta 2 veces si falla. Tarda entre 15 y
// 40 minutos y cuesta tokens, así que conviene lanzarlo UNA vez por portal, no
// una por ticket: dar de alta el portal resuelve todos sus tickets de golpe.
//
// Uso: node scripts/agente-portal.js <ticketId>
require('dotenv').config();
const db = require('../lib/db');
const { orquestar } = require('../agentes/orquestador');

const parseJson = (v) => { if (!v) return {}; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return {}; } };

(async () => {
  const ticketId = parseInt(process.argv[2], 10);
  if (!ticketId) { console.error('uso: node scripts/agente-portal.js <ticketId>'); process.exit(1); }

  const [[t]] = await db.query('SELECT id, comercio, portal_url, ocr_json FROM tickets WHERE id = ?', [ticketId]);
  if (!t) { console.error(`❌ el ticket #${ticketId} no existe`); process.exit(1); }

  const o = parseJson(t.ocr_json);
  let portalUrl = t.portal_url || o.portalUrl;
  if (!portalUrl) {
    console.log(`⚠️ el ticket #${ticketId} no tiene URL de portal — el agente no tiene por dónde empezar`);
    process.exit(2);
  }
  if (!/^https?:\/\//i.test(portalUrl)) portalUrl = `https://${portalUrl}`;

  console.log(`🧠 Agente sobre ${portalUrl}`);
  console.log(`   ticket #${t.id} · ${t.comercio} · folio ${o.folio || '—'} · $${o.total ?? '—'}`);

  const t0 = Date.now();
  try {
    const r = await orquestar({
      db, ticketId: t.id, portalUrl,
      comercioNombre: t.comercio || 'Portal nuevo',
      instrucciones: 'Factura electrónica de gasolinera/comercio mexicano. Los datos del ticket (folio, importe, fecha) van en el formulario; los datos fiscales del receptor son los de la cuenta.',
    });
    const min = ((Date.now() - t0) / 60000).toFixed(1);
    if (r && r.ok) console.log(`✅ agente terminó en ${min} min — estado: ${r.estado || 'ok'}`);
    else console.log(`⚠️ agente terminó en ${min} min sin dar de alta el bot: ${r?.msg || r?.estado || 'sin detalle'}`);
    process.exit(0);
  } catch (e) {
    console.log(`❌ agente falló tras ${((Date.now() - t0) / 60000).toFixed(1)} min: ${e.message}`);
    process.exit(1);
  }
})();
