// Registra en el sistema CFDI que llegaron POR FUERA del pipeline (a otro
// correo, descargados a mano del portal, enviados por el comercio…).
//
// Empareja cada XML con su ticket por TOTAL, y verifica antes de escribir:
//   · el RFC receptor tiene que ser el de GPN;
//   · el total del CFDI tiene que cuadrar con el del ticket (±0.01);
//   · el ticket no puede tener ya una factura registrada.
// Si algo no cuadra lo dice y no toca nada: es preferible dejarlo pendiente que
// registrar una factura que no corresponde.
//
// Uso: node scripts/registrar-cfdi-manual.js <carpeta-o-xml...>
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../lib/db');
const { subirArchivoR2 } = require('../storage/r2');
const { extraerUUIDcfdi } = require('../lib/util');

const RFC_GPN = 'GPR110128QD8';
const parseJson = (v) => { if (!v) return {}; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return {}; } };
const atrib = (xml, re) => (xml.match(re) || [])[1];

(async () => {
  const args = process.argv.slice(2);
  if (!args.length) { console.error('uso: node scripts/registrar-cfdi-manual.js <archivo.xml|carpeta>...'); process.exit(1); }

  // Reunir los XML (de archivos sueltos o de carpetas).
  const xmls = [];
  for (const a of args) {
    const st = fs.existsSync(a) ? fs.statSync(a) : null;
    if (!st) { console.log(`⚠️ no existe: ${a}`); continue; }
    if (st.isDirectory()) {
      for (const f of fs.readdirSync(a)) if (/\.xml$/i.test(f)) xmls.push(path.join(a, f));
    } else if (/\.xml$/i.test(a)) xmls.push(a);
  }

  // Tickets todavía sin factura.
  const [pendientes] = await db.query(`
    SELECT t.id, t.user_id, t.comercio, t.ocr_json
      FROM tickets t LEFT JOIN facturas f ON f.ticket_id = t.id
     WHERE f.id IS NULL ORDER BY t.id`);
  const objetivos = pendientes.map((t) => {
    const o = parseJson(t.ocr_json);
    return { id: t.id, userId: t.user_id, comercio: t.comercio, total: parseFloat(o.total), ocr: o };
  }).filter((t) => !isNaN(t.total));

  console.log(`📄 ${xmls.length} XML | 🎫 ${objetivos.length} ticket(s) sin factura\n`);
  const usados = new Set();
  let nuevos = 0, yaEstaban = 0, sinTicket = 0;

  for (const ruta of xmls) {
    const buf = fs.readFileSync(ruta);
    const xml = buf.toString('utf8');
    const uuid = (extraerUUIDcfdi(buf) || '').toLowerCase();
    const total = atrib(xml, /<(?:cfdi:)?Comprobante\b[^>]*\sTotal="([\d.]+)"/i);
    const rfcRec = atrib(xml, /<(?:cfdi:)?Receptor[^>]*\sRfc="([^"]+)"/i);
    const emisor = atrib(xml, /<(?:cfdi:)?Emisor[^>]*\sNombre="([^"]{0,60})"/i) || '';
    const nombre = path.basename(ruta);

    if (!uuid) { console.log(`✖ ${nombre}: sin UUID`); continue; }
    if (rfcRec !== RFC_GPN) { console.log(`✖ ${nombre}: receptor ${rfcRec}, no es GPN`); continue; }

    const [ya] = await db.query('SELECT ticket_id FROM facturas WHERE xml_url LIKE ?', [`%${uuid}%`]);
    if (ya.length) { console.log(`⏭️ ${nombre}: ya registrado (ticket #${ya[0].ticket_id}) — $${total}`); yaEstaban++; continue; }

    const cand = objetivos.find((t) => !usados.has(t.id) && Math.abs(t.total - parseFloat(total)) <= 0.01);
    if (!cand) { console.log(`⚠️ ${nombre}: $${total} (${emisor.slice(0, 34)}) no casa con ningún ticket pendiente`); sinTicket++; continue; }

    // El PDF hermano, si viene al lado con el mismo nombre base.
    let pdfUrl = null;
    for (const cand2 of [ruta.replace(/\.xml$/i, '.pdf'), ruta + '.pdf']) {
      if (fs.existsSync(cand2)) { pdfUrl = await subirArchivoR2(fs.readFileSync(cand2), `facturas/${uuid}.pdf`, 'application/pdf'); break; }
    }
    const xmlUrl = await subirArchivoR2(buf, `facturas/${uuid}.xml`, 'application/xml');

    const ocr = cand.ocr;
    ocr.uuid_cfdi = uuid;
    ocr._nota = `CFDI recibido fuera del pipeline (otro correo / descarga manual) y registrado con scripts/registrar-cfdi-manual.js el ${new Date().toISOString().slice(0, 10)}.`;
    await db.query("UPDATE tickets SET status='procesado', error_msg=NULL, reintento_programado=NULL, requiere_confirmacion=0, ocr_json=? WHERE id=?", [JSON.stringify(ocr), cand.id]);
    await db.query("INSERT INTO facturas (user_id, ticket_id, comercio, xml_url, pdf_url, status) VALUES (?,?,?,?,?,'completado')",
      [cand.userId, cand.id, String(cand.comercio || emisor || 'Comercio').slice(0, 50), xmlUrl, pdfUrl]);

    console.log(`✅ ${nombre} → ticket #${cand.id} | $${total} | ${emisor.slice(0, 34)} | UUID ${uuid}${pdfUrl ? ' (+PDF)' : ''}`);
    usados.add(cand.id);
    nuevos++;
  }

  console.log(`\n=== ${nuevos} nuevo(s) · ${yaEstaban} ya estaban · ${sinTicket} sin ticket que casara ===`);
  process.exit(0);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
