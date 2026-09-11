/**
 * Baja el XML+PDF de una factura YA emitida en un portal migasolinera.net
 * (familia KERNOTEK / "Baja tu factura", la que usan las estaciones ARCO /
 * Petrosmart) y la asocia a su ticket.
 *
 * Cada estación tiene su propio subdominio: es01763.migasolinera.net es
 * "1763 - SERVICIO INSURGENTES DE MAZATLAN". El número sale impreso en el pie
 * del ticket, dentro de la URL:
 *     CFDI: FACTURA: https://es01763.migasolinera.net/bajatufactura/
 *     CODIGO: 26875446875
 *
 * ⚠️ ESTOS TICKETS NO SON DE BUZONFACTURAS. El OCR los marcaba portal='arco'
 * porque el logo del ticket es ARCO, y el router los mandaba a
 * bots/buzonfacturas.js — otro portal, de otra empresa. De ahí venía el
 * "factura generada" del #373 sobre una factura que no existía en ninguna parte.
 * La URL del pie del ticket es la que manda, no la marca del logo.
 *
 * Todo el portal son POSTs de formulario con cookie de sesión; no hace falta
 * navegador. La sesión CADUCA rápido (vuelve a index.php?timeout), así que el
 * flujo se hace de un tirón.
 *
 * Uso:
 *   node scripts/migasolinera-descargar-cfdi.js <ticketId> <estacion> <numFactura>
 *   node scripts/migasolinera-descargar-cfdi.js 373 01763 CC858306
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TICKET_ID = Number(process.argv[2]);
const ESTACION = String(process.argv[3] || '').replace(/^es/i, '').padStart(5, '0');
const FACTURA = process.argv[4];
const RFC = process.env.RFC_RECEPTOR || 'GPR110128QD8';

if (!TICKET_ID || !ESTACION || !FACTURA) {
  console.error('Uso: node scripts/migasolinera-descargar-cfdi.js <ticketId> <estacion> <numFactura>');
  console.error('  ej: node scripts/migasolinera-descargar-cfdi.js 373 01763 CC858306');
  process.exit(1);
}

const BASE = `https://es${ESTACION}.migasolinera.net/bajatufactura`;

// Cookie jar mínimo: el portal identifica la sesión con una sola cookie PHP.
let cookie = '';
function guardarCookies(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of raw) {
    const par = c.split(';')[0];
    if (par) cookie = cookie ? `${cookie}; ${par}` : par;
  }
}
async function pedir(url, body) {
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: {
      Cookie: cookie,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0 Safari/537.36',
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: body ? new URLSearchParams(body).toString() : undefined,
    redirect: 'follow',
  });
  guardarCookies(res);
  return res;
}

// El ZIP trae el XML y el PDF. Se descomprime a mano (deflate-raw) para no
// depender de unzipper aquí.
const zlib = require('zlib');
function extraerDelZip(buf) {
  const salida = {};
  for (let i = 0; i < buf.length - 30; i++) {
    if (buf[i] !== 0x50 || buf[i + 1] !== 0x4b || buf[i + 2] !== 0x03 || buf[i + 3] !== 0x04) continue;
    const metodo = buf.readUInt16LE(i + 8);
    const csize = buf.readUInt32LE(i + 18);
    const nlen = buf.readUInt16LE(i + 26);
    const elen = buf.readUInt16LE(i + 28);
    const nombre = buf.toString('utf8', i + 30, i + 30 + nlen);
    const ini = i + 30 + nlen + elen;
    const datos = buf.subarray(ini, ini + csize);
    try {
      const plano = metodo === 0 ? datos : zlib.inflateRawSync(datos);
      if (/\.xml$/i.test(nombre)) salida.xml = plano;
      else if (/\.pdf$/i.test(nombre)) salida.pdf = plano;
    } catch (e) {
      console.log(`   ⚠️ no se pudo descomprimir ${nombre}: ${e.message}`);
    }
  }
  return salida;
}

(async () => {
  console.log(`🌐 ${BASE} — factura ${FACTURA} de ${RFC}`);

  // 1. Sesión + pantalla de descarga por RFC.
  await pedir(`${BASE}/`);
  const r1 = await pedir(`${BASE}/index.php`, { rfc: RFC, a: 'rfc', btn_submit_rfc: 'Aceptar' });
  const h1 = await r1.text();
  const mPeriodo = h1.match(/index\.php\?a=periodo&hash=([^"'&]+)/);
  if (!mPeriodo) {
    console.error('❌ el portal no reconoció el RFC en esta estación.');
    console.error('  ', h1.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 240));
    process.exit(2);
  }
  const hash = mPeriodo[1];

  // 2. Las facturas se listan por periodo: 1 = mes anterior, 2 = mes actual.
  //    Una factura emitida hoy de un consumo del mes pasado aparece en el 1,
  //    así que se prueban los dos.
  let campos = null;
  for (const periodo of ['2', '1']) {
    const r2 = await pedir(`${BASE}/index.php`, { periodo, a: 'invoices', hash, btn_period: 'Continuar' });
    const h2 = await r2.text();
    if (!h2.includes(FACTURA)) continue;
    const c = {};
    for (const m of h2.matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/gi)) c[m[1]] = m[2];
    // El formulario de descarga trae su propio hash, distinto del de listado.
    const mh = h2.match(/name="hash"[^>]*value="([^"]+)"/);
    if (mh) c.hash = mh[1];
    campos = c;
    console.log(`   encontrada en el periodo ${periodo === '2' ? 'actual' : 'anterior'}`);
    break;
  }
  if (!campos) {
    console.error(`❌ la factura ${FACTURA} no aparece en ninguno de los dos periodos de la estación ${ESTACION}.`);
    process.exit(3);
  }

  // 3. Descargar el ZIP.
  const r3 = await pedir(`${BASE}/lib/download.php`, { ...campos, downloadclt: 'true', pdf: 'Descargar' });
  const zip = Buffer.from(await r3.arrayBuffer());
  if (zip.length < 1000 || zip[0] !== 0x50) {
    console.error(`❌ la descarga no es un ZIP (${zip.length} bytes).`);
    process.exit(4);
  }
  const { xml, pdf } = extraerDelZip(zip);
  if (!xml) { console.error('❌ el ZIP no traía XML.'); process.exit(5); }

  const dir = path.join(__dirname, '..', 'tmp', 'cfdi');
  fs.mkdirSync(dir, { recursive: true });
  const fx = path.join(dir, `${TICKET_ID}.xml`);
  const fp = path.join(dir, `${TICKET_ID}.pdf`);
  fs.writeFileSync(fx, xml);
  if (pdf) fs.writeFileSync(fp, pdf);
  console.log(`💾 ${fx} (${xml.length} b)${pdf ? ` · ${fp} (${pdf.length} b)` : ''}`);

  // asociar-cfdi.js verifica total y RFC del receptor antes de escribir nada.
  const args = [path.join(__dirname, 'asociar-cfdi.js'), String(TICKET_ID), fx];
  if (pdf) args.push(fp);
  const r = spawnSync(process.execPath, args, { stdio: 'inherit' });
  process.exit(r.status || 0);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
