require('dotenv').config();
const fs = require('fs');
const { descargarLinkCorreo } = require('../mail/imap');
const { extraerUUIDcfdi } = require('../lib/util');
const { extraerTotalCFDI } = require('../mail/imap');

(async () => {
  const xmlUrl = 'https://erfc.com.mx/Cubox/DescargaCFDI/?file=4sgYsb31%2FQgn%2Fh7b1f194uCvP51cuTGcpPjg80EgDnBpd%2FMrkPgyxHf%2FkwWw0nAiHb4CoHwBM%2B5E%2F%2B8uaUjLQQgNi9idygw1R6V%2BO3yepTk2EEIJ5i7RDTDcHGVmyxqYfu4Q9Bi2N15RRb6Ls7IuwlXA4THpssTwd%2BMtaW7uaVs%3D&hash=f94afd58fc99b1191a33d635ae107ffcb862f6e6&ident=6883745';
  const pdfUrl = 'https://erfc.com.mx/Cubox/DescargaCFDI/?file=yHShLhwEk%2F%2F5%2Fh5pbmc2ODyMMwfTBtBcyVXHBIIvfSGbENORlW9LtxtVH6thFlLnVX4DZflXHMJsDFrPu8s4%2BIZgIhwK%2BrtewRDUDHd0bNXHLK07LVCfyWeU9csQ%2B5g5A1PjdkBEz4JmQzV8A8Ooh1PL%2FtePnkudl2lQKzdUP1o%3D&hash=f94afd58fc99b1191a33d635ae107ffcb862f6e6&ident=6883745';

  const xmlBuf = await descargarLinkCorreo(xmlUrl, 'xml');
  const pdfBuf = await descargarLinkCorreo(pdfUrl, 'pdf');

  console.log('XML:', xmlBuf ? xmlBuf.length + ' bytes' : 'NO');
  console.log('PDF:', pdfBuf ? pdfBuf.length + ' bytes' : 'NO');

  if (xmlBuf) {
    fs.writeFileSync('C:/Users/carlo/AppData/Local/Temp/claude/C--Users-carlo/bd061180-d7e6-4587-97d7-6edd69b553bc/scratchpad/erfc_real.xml', xmlBuf);
    console.log('UUID:', extraerUUIDcfdi(xmlBuf));
    console.log('Total:', extraerTotalCFDI(xmlBuf));
    const xml = xmlBuf.toString('utf8');
    console.log('Rfc Emisor:', (xml.match(/<cfdi:Emisor[^>]*\sRfc="([^"]+)"/i) || [])[1]);
    console.log('Rfc Receptor:', (xml.match(/<cfdi:Receptor[^>]*\sRfc="([^"]+)"/i) || [])[1]);
  }
  if (pdfBuf) {
    fs.writeFileSync('C:/Users/carlo/AppData/Local/Temp/claude/C--Users-carlo/bd061180-d7e6-4587-97d7-6edd69b553bc/scratchpad/erfc_real.pdf', pdfBuf);
    console.log('PDF magic:', pdfBuf.slice(0, 8).toString('utf8'));
  }
})().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
