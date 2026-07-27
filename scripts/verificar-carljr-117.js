require('dotenv').config();
const db = require('../lib/db');
const { esperarFacturaPorCorreo, extraerTotalCFDI } = require('../mail/imap');
const { subirArchivoR2 } = require('../storage/r2');
const { extraerUUIDcfdi } = require('../lib/util');
const fs = require('fs');

(async () => {
  const ticketId = 117;
  const codigoTicket = '56816019212317';
  const expectedComercio = "ICR S.A. de C.V.";
  const expectedTotal = 319.5;

  console.log('=== Verificando correo real para ticket #117 (Carl\'s Jr / ICR) ===');
  console.log(`Buscando correo con codigo=${codigoTicket} comercio=${expectedComercio} total=${expectedTotal}...`);

  let xmlBuffer, pdfBuffer, subject;
  try {
    const r = await esperarFacturaPorCorreo(codigoTicket, 4 * 60 * 1000, expectedComercio, expectedTotal);
    xmlBuffer = r.xmlBuffer; pdfBuffer = r.pdfBuffer; subject = r.subject;
  } catch (e) {
    console.log('❌ No llegó correo verificable:', e.message);
    process.exit(1);
  }

  console.log(`✅ Correo encontrado: "${subject}"`);
  console.log(`   XML: ${xmlBuffer ? xmlBuffer.length + ' bytes' : 'NO'}`);
  console.log(`   PDF: ${pdfBuffer ? pdfBuffer.length + ' bytes' : 'NO'}`);

  if (!xmlBuffer) {
    console.log('❌ Sin XML — no se puede verificar CFDI real. Abortando sin tocar DB.');
    process.exit(1);
  }

  fs.writeFileSync('C:/Users/carlo/portal-facturas/scripts/tmp_carljr_117.xml', xmlBuffer);
  if (pdfBuffer) fs.writeFileSync('C:/Users/carlo/portal-facturas/scripts/tmp_carljr_117.pdf', pdfBuffer);

  const uuid = extraerUUIDcfdi(xmlBuffer);
  const totalCFDI = extraerTotalCFDI(xmlBuffer);
  console.log(`📄 UUID: ${uuid}`);
  console.log(`💲 Total CFDI: ${totalCFDI}`);

  const xml = xmlBuffer.toString('utf8');
  const rfcEmisor = (xml.match(/<cfdi:Emisor[^>]*\sRfc="([^"]+)"/i) || [])[1];
  const rfcReceptor = (xml.match(/<cfdi:Receptor[^>]*\sRfc="([^"]+)"/i) || [])[1];
  const fechaTimbrado = (xml.match(/FechaTimbrado="([^"]+)"/i) || [])[1];
  const rfcProvCertif = (xml.match(/RfcProvCertif="([^"]+)"/i) || [])[1];
  console.log(`🏢 RFC Emisor: ${rfcEmisor} | RFC Receptor: ${rfcReceptor}`);
  console.log(`🕒 Timbrado: ${fechaTimbrado} | PAC: ${rfcProvCertif}`);

  if (!uuid || !fechaTimbrado || !rfcProvCertif) {
    console.log('❌ XML no parece un CFDI timbrado real (falta UUID/FechaTimbrado/RfcProvCertif). Abortando sin tocar DB.');
    process.exit(1);
  }
  if (rfcReceptor !== 'GPR110128QD8') {
    console.log(`❌ RFC receptor no coincide con GPN (GPR110128QD8) — es "${rfcReceptor}". Abortando sin tocar DB.`);
    process.exit(1);
  }

  const prefijo = `facturas/${uuid}`;
  const xmlUrl = await subirArchivoR2(xmlBuffer, `${prefijo}.xml`, 'application/xml');
  const pdfUrl = pdfBuffer ? await subirArchivoR2(pdfBuffer, `${prefijo}.pdf`, 'application/pdf') : null;
  console.log(`☁️ XML subido: ${xmlUrl}`);
  console.log(`☁️ PDF subido: ${pdfUrl}`);

  const [[ticket]] = await db.query('SELECT user_id, comercio FROM tickets WHERE id=?', [ticketId]);

  try {
    await db.query(
      "INSERT INTO facturas (user_id, ticket_id, comercio, pdf_url, xml_url, status) VALUES (?, ?, ?, ?, ?, ?)",
      [ticket.user_id, ticketId, ticket.comercio, pdfUrl, xmlUrl, "completado"]
    );
    console.log('✅ Fila insertada en facturas');
  } catch (dupErr) {
    if (dupErr.code === 'ER_DUP_ENTRY') {
      const [[existente]] = await db.query('SELECT id, xml_url FROM facturas WHERE ticket_id=?', [ticketId]);
      if (existente && !existente.xml_url) {
        await db.query('UPDATE facturas SET pdf_url=?, xml_url=?, status=\'completado\' WHERE id=?', [pdfUrl, xmlUrl, existente.id]);
        console.log(`♻️ Fila #${existente.id} estaba incompleta — actualizada con archivos reales`);
      } else {
        console.log('⏭️ Ya existía una factura completa — no se duplicó');
      }
    } else {
      throw dupErr;
    }
  }

  await db.query("UPDATE tickets SET status='procesado', error_msg=NULL WHERE id=?", [ticketId]);
  console.log('✅ Ticket #117 → procesado');
  console.log('=== FIN ===');
  process.exit(0);
})().catch(e => { console.error('💥 Error fatal:', e); process.exit(1); });
