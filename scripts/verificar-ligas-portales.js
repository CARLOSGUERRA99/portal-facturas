// Comprueba, ticket a ticket, que la liga del portal que vamos a usar existe y
// responde. Muchos "el agente no pudo cargar el portal" no eran del agente: la
// URL que trae el OCR está mal escrita, es un correo, o el dominio no resuelve.
//
//   node scripts/verificar-ligas-portales.js            → solo los pendientes
//   node scripts/verificar-ligas-portales.js --todos    → todos los tickets
require('dotenv').config();
const dns = require('dns').promises;
const db = require('../lib/db');

const TODOS = process.argv.includes('--todos');

// La liga que de verdad usa cada bot, para contrastarla con la que leyó el OCR.
const URL_DEL_BOT = {
  igasfac: 'https://www.igasfac.com.mx/Identity/Account/Login',
  enerfueltech: 'https://factura.enerfueltech.com/',
  // gashr es multiestación: la liga real sale del propio ticket. Ver
  // baseDelTicket() en bots/gashr.js.
  gashr: (cruda) => require('../bots/gashr').baseDelTicket
    ? require('../bots/gashr').baseDelTicket(cruda)
    : 'https://valerogdl.facturacionestacion.com',
  petrofigues: 'https://petrofigues.facturacionestacion.com/',
  facturagas: 'https://app.facturagas.net/',
  gasmaz: 'https://redmaxfactura.nexusfuel.mx/',
  carljr: 'https://egridhub.com:6027/icr',
  littlecaesars: 'https://cfdi.analytix360.cloud/cafrema/lc/',
  grupocentra: 'https://facturacion.grupocentra.mx/Karmi_FacturacionWeb',
  similares: 'https://facturacion.appskurigage.com/',
  orler: 'https://facturacion.sinaloa.gob.mx/',
};

function normalizar(u) {
  const s = String(u || '').trim();
  if (!s) return null;
  if (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(s)) return { correo: s };   // es un correo, no una URL
  const con = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try { return { url: new URL(con) }; } catch { return { malformada: s }; }
}

async function probar(u) {
  const host = u.hostname;
  try { await dns.lookup(host); } catch { return { estado: 'DNS_NO_RESUELVE' }; }

  for (const metodo of ['HEAD', 'GET']) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      const r = await fetch(u.href, { method: metodo, redirect: 'follow', signal: ctrl.signal });
      clearTimeout(t);
      const finalDistinta = new URL(r.url).host !== host ? new URL(r.url).host : null;
      if (r.status === 405 && metodo === 'HEAD') continue;
      return { estado: `HTTP ${r.status}`, redirige: finalDistinta };
    } catch (e) {
      if (metodo === 'GET') return { estado: e.name === 'AbortError' ? 'TIMEOUT' : `ERROR: ${e.message.slice(0, 40)}` };
    }
  }
  return { estado: 'sin respuesta' };
}

(async () => {
  const [tk] = await db.query(
    `SELECT t.id, t.comercio, t.status, t.portal_url, t.ocr_json
       FROM tickets t ${TODOS ? '' : "WHERE t.status <> 'procesado'"} ORDER BY t.id`);

  console.log(`Comprobando ligas de ${tk.length} tickets\n`);
  const filas = [];

  for (const t of tk) {
    let j = {};
    try { j = JSON.parse(t.ocr_json || '{}'); } catch {}
    const portal = j.portal && j.portal !== 'desconocido' ? j.portal : null;
    const cruda = j.portalUrl || t.portal_url || '';
    const n = normalizar(cruda);

    let veredicto, detalle = '';
    if (portal && URL_DEL_BOT[portal]) {
      // Si hay bot, la liga buena es la del bot: la del OCR da igual, salvo en
      // los multiestación, donde el bot la deriva del propio ticket.
      const def = URL_DEL_BOT[portal];
      const liga = typeof def === 'function' ? def(cruda) : def;
      const r = await probar(new URL(liga));
      veredicto = `bot ${portal}`;
      detalle = `${liga} → ${r.estado}${r.redirige ? ` (redirige a ${r.redirige})` : ''}`;
    } else if (!n) {
      veredicto = 'SIN LIGA';
      detalle = 'el OCR no leyó ninguna URL';
    } else if (n.correo) {
      veredicto = '❌ ES UN CORREO';
      detalle = `"${n.correo}" no es un portal: hay que pedir la factura por correo`;
    } else if (n.malformada) {
      veredicto = '❌ MALFORMADA';
      detalle = n.malformada;
    } else {
      const r = await probar(n.url);
      veredicto = /HTTP 2|HTTP 3/.test(r.estado) ? '✅ responde' : `❌ ${r.estado}`;
      detalle = `${n.url.href} → ${r.estado}${r.redirige ? ` (redirige a ${r.redirige})` : ''}`;
    }

    filas.push({ id: t.id, comercio: (t.comercio || '').slice(0, 34), veredicto, detalle });
    console.log(`#${t.id} ${String(t.comercio || '').slice(0, 34).padEnd(34)} ${veredicto}`);
    console.log(`      ${detalle}`);
  }

  console.log('\n── RESUMEN ──');
  const malas = filas.filter((f) => f.veredicto.startsWith('❌') || f.veredicto === 'SIN LIGA');
  console.log(`ligas que no sirven: ${malas.length} de ${filas.length}`);
  malas.forEach((m) => console.log(`  #${m.id} ${m.comercio} — ${m.veredicto}`));

  // Informe en markdown, para poder revisarlo de un vistazo sin correr nada.
  const fs = require('fs');
  const path = require('path');
  const md = ['# Ligas de facturación por ticket', '',
    `Generado el ${new Date().toLocaleString('es-MX')} · ${filas.length} tickets`, '',
    'La columna "liga" es la que se usaría HOY para facturar: si el ticket tiene bot,',
    'es la del bot (la del OCR se ignora); si no, es la que leyó el OCR.', '',
    '| ticket | comercio | vía | liga | estado |', '|---|---|---|---|---|'];
  filas.forEach((f) => {
    const [liga, estado] = f.detalle.includes(' → ')
      ? [f.detalle.split(' → ')[0], f.detalle.split(' → ').slice(1).join(' → ')]
      : ['—', f.detalle];
    md.push(`| #${f.id} | ${f.comercio} | ${f.veredicto} | ${liga} | ${estado} |`);
  });
  const destino = path.join(__dirname, '..', 'docs', 'ligas-portales.md');
  fs.writeFileSync(destino, md.join('\n') + '\n', 'utf8');
  console.log(`\ninforme: ${destino}`);
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
