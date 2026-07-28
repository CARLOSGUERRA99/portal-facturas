require('dotenv').config();
const { subirArchivoR2 } = require('../storage/r2');
const { extraerUUIDcfdi } = require('../lib/util');

const UUID = 'd9edf987-788b-4f71-97cb-2ccc55d449af';

async function descargar(url, cookieHeader) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const resp = await fetch(url, { headers: { Cookie: cookieHeader }, signal: controller.signal });
    if (!resp.ok) { console.log(`⚠️ ${url} respondió ${resp.status}`); return null; }
    return Buffer.from(await resp.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  const ciSession = process.env.OXXOGAS_CI_SESSION;
  const incapSes117 = process.env.OXXOGAS_INCAP_SES_117;
  const incapSes363 = process.env.OXXOGAS_INCAP_SES_363;
  const visidIncap = process.env.OXXOGAS_VISID_INCAP;
  const cookieHeader = [
    `ci_sessions=${ciSession}`,
    incapSes117 ? `incap_ses_117_3020163=${incapSes117}` : null,
    incapSes363 ? `incap_ses_363_3020163=${incapSes363}` : null,
    visidIncap ? `visid_incap_3020163=${visidIncap}` : null,
  ].filter(Boolean).join('; ');

  const xmlBuf = await descargar(`https://facturacion.oxxogas.com/facturacion/facturas/xml/${UUID}`, cookieHeader);
  const pdfBuf = await descargar(`https://facturacion.oxxogas.com/facturacion/facturas/pdf/${UUID}`, cookieHeader);

  console.log('XML:', xmlBuf ? `${xmlBuf.length} bytes` : 'NO');
  console.log('PDF:', pdfBuf ? `${pdfBuf.length} bytes` : 'NO');

  if (!xmlBuf) { console.log('❌ Sin XML — abortando'); process.exit(1); }

  const xml = xmlBuf.toString('utf8');
  const uuidReal = extraerUUIDcfdi(xmlBuf);
  const total = (xml.match(/<(?:cfdi:)?Comprobante\b[^>]*\sTotal="([\d.]+)"/i) || [])[1];
  const rfcEmisor = (xml.match(/<(?:cfdi:)?Emisor[^>]*\sRfc="([^"]+)"/i) || [])[1];
  const rfcReceptor = (xml.match(/<(?:cfdi:)?Receptor[^>]*\sRfc="([^"]+)"/i) || [])[1];
  const fechaTimbrado = (xml.match(/FechaTimbrado="([^"]+)"/i) || [])[1];

  console.log('\n=== CFDI REAL ===');
  console.log('UUID:', uuidReal);
  console.log('Total:', total);
  console.log('RFC Emisor:', rfcEmisor);
  console.log('RFC Receptor:', rfcReceptor);
  console.log('Fecha Timbrado:', fechaTimbrado);

  if (rfcReceptor !== 'GPR110128QD8') { console.log('❌ RFC receptor no es GPN'); process.exit(1); }

  const xmlUrl = await subirArchivoR2(xmlBuf, `facturas/oxxogas_${uuidReal}.xml`, 'application/xml');
  const pdfUrl = pdfBuf ? await subirArchivoR2(pdfBuf, `facturas/oxxogas_${uuidReal}.pdf`, 'application/pdf') : null;
  console.log('\n☁️ XML:', xmlUrl);
  console.log('☁️ PDF:', pdfUrl);

  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
