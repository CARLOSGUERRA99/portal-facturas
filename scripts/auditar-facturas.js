// Audita TODAS las facturas ya emitidas contra el ticket que las originó.
//
// El sistema nunca ha mirado dentro de un CFDI: de cada XML solo saca el UUID
// para nombrar el archivo. Este script baja los XML de R2 y comprueba lo que
// nadie comprobó: que el receptor sea el RFC del cliente y que el total cuadre
// con el ticket.
//
// Es de solo lectura. No toca la base de datos.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const db = require('../lib/db');
const { leerCFDI, verificarCFDI } = require('../lib/cfdi');

(async () => {
  const [filas] = await db.query(`
    SELECT f.id, f.ticket_id, f.comercio, f.xml_url, f.creado,
           u.rfc AS rfc_usuario, u.razon_social,
           t.ocr_json
      FROM facturas f
      LEFT JOIN users   u ON u.id = f.user_id
      LEFT JOIN tickets t ON t.id = f.ticket_id
     WHERE f.status = 'completado'
     ORDER BY f.id`);

  console.log(`Auditando ${filas.length} facturas…\n`);

  const graves = [], avisos = [];
  let sinXml = 0, ok = 0;

  for (const f of filas) {
    let totalTicket = 0;
    try { totalTicket = Number(JSON.parse(f.ocr_json || '{}').total) || 0; } catch {}

    if (!f.xml_url) { sinXml++; graves.push({ f, p: [{ gravedad: 'grave', clave: 'sin_xml', msg: 'la factura no tiene XML guardado' }] }); continue; }

    const r = await fetch(f.xml_url).catch(() => null);
    if (!r?.ok) { sinXml++; graves.push({ f, p: [{ gravedad: 'grave', clave: 'xml_inaccesible', msg: `el XML no se pudo descargar (${r?.status || 'sin respuesta'})` }] }); continue; }

    const cfdi = leerCFDI(Buffer.from(await r.arrayBuffer()));
    const probs = verificarCFDI(cfdi, { rfcEsperado: f.rfc_usuario, totalEsperado: totalTicket });

    const g = probs.filter((x) => x.gravedad === 'grave');
    const a = probs.filter((x) => x.gravedad === 'aviso');
    if (g.length) graves.push({ f, cfdi, p: g.concat(a) });
    else if (a.length) avisos.push({ f, cfdi, p: a });
    else { ok++; process.stdout.write('.'); }
  }

  const pinta = (titulo, lista) => {
    if (!lista.length) return;
    console.log(`\n\n${titulo}`);
    for (const { f, cfdi, p } of lista) {
      console.log(`\n  factura #${f.id} · ticket #${f.ticket_id} · ${f.comercio}`);
      console.log(`    esperado: ${f.rfc_usuario || '(sin RFC)'} — ${f.razon_social || ''}`);
      if (cfdi) console.log(`    CFDI:     ${cfdi.receptorRfc || '?'} · $${cfdi.total.toFixed(2)} · ${cfdi.serie || ''}${cfdi.folio || ''} · emisor ${cfdi.emisorNombre || cfdi.emisorRfc || '?'}`);
      p.forEach((x) => console.log(`    ${x.gravedad === 'grave' ? '🛑' : '⚠️ '} ${x.msg}`));
    }
  };

  pinta('══ GRAVES ══', graves);
  pinta('══ AVISOS ══', avisos);

  console.log(`\n\n${ok} correctas · ${avisos.length} con aviso · ${graves.length} graves · ${sinXml} sin XML utilizable`);
  process.exit(0);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
