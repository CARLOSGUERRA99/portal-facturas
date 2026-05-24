/**
 * Test local del engine para Farmacias Benavides (e-facturate.com/benavides/).
 * Uso: node scripts/test-benavides.js
 *
 * Opcional — sobreescribir campos via env:
 *   RFC="XAXX010101000" FOLIO="123456789" TOTAL="1251.15" node scripts/test-benavides.js
 *
 * Nota: el FOLIO es el "Numero de referencia" del ticket (números bajo el código de barras,
 * a veces encerrados entre asteriscos *123456789*).
 */
require('dotenv').config();
const { facturarConEngine } = require('../engine');

const PAYLOAD = {
  portal:        'benavides',
  ticketId:      'TEST-' + Date.now(),

  folio:         process.env.FOLIO     || 'REEMPLAZAR_REFERENCIA',
  total:         process.env.TOTAL     || 'REEMPLAZAR_TOTAL',
  fecha:         process.env.FECHA     || new Date().toISOString().split('T')[0],

  rfc:           process.env.RFC            || 'REEMPLAZAR_RFC',
  razonSocial:   process.env.RAZON_SOCIAL   || 'EMPRESA DE PRUEBA SA DE CV',
  regimenFiscal: process.env.REGIMEN        || '601',
  usoCfdi:       process.env.USO_CFDI       || 'G03',
  codigoPostal:  process.env.CP             || '85000',

  portalUrl:     process.env.PORTAL_URL     || 'https://e-facturate.com/benavides/',
};

function validarPayload(p) {
  const errores = [];
  if (!process.env.BROWSERLESS_TOKEN) errores.push('BROWSERLESS_TOKEN no está en .env');
  if (p.folio.startsWith('REEMPLAZAR'))   errores.push('Ajusta FOLIO (referencia del ticket)');
  if (p.total.startsWith('REEMPLAZAR'))   errores.push('Ajusta TOTAL');
  if (p.rfc.startsWith('REEMPLAZAR'))     errores.push('Ajusta RFC');
  return errores;
}

async function main() {
  console.log('\n══════════════════════════════════════════════');
  console.log('  TEST ENGINE — FARMACIAS BENAVIDES');
  console.log('══════════════════════════════════════════════\n');
  console.log('📋 Payload:');
  console.log(JSON.stringify(PAYLOAD, null, 2));
  console.log('');

  const errores = validarPayload(PAYLOAD);
  if (errores.length > 0) {
    console.error('❌ Campos sin configurar:\n');
    errores.forEach(e => console.error(`   • ${e}`));
    console.error('\nEjemplo:');
    console.error('  RFC="TU_RFC" FOLIO="123456789" TOTAL="1251.15" node scripts/test-benavides.js\n');
    process.exit(1);
  }

  console.log('🚀 Iniciando engine...\n');
  const inicio = Date.now();

  try {
    const resultado = await facturarConEngine('benavides', PAYLOAD);
    const duracion = ((Date.now() - inicio) / 1000).toFixed(1);

    console.log('\n══════════════════════════════════════════════');
    console.log(`  RESULTADO (${duracion}s)`);
    console.log('══════════════════════════════════════════════');
    console.log(JSON.stringify(resultado, null, 2));

    if (!resultado) {
      console.log('\n⚠️  Engine devolvió null — ¿existe commerce/benavides/flow.json?');
      process.exit(1);
    }
    if (resultado.ok) {
      if (resultado.procesandoCorreo) {
        console.log('\n📬 Factura generada — llegará por IMAP a buzonfacturas@serviciosga.site');
      } else {
        console.log('\n✅ Éxito con archivos directos:');
        if (resultado.xmlUrl) console.log(`   XML: ${resultado.xmlUrl}`);
        if (resultado.pdfUrl) console.log(`   PDF: ${resultado.pdfUrl}`);
      }
    } else {
      console.log(`\n❌ Error: [${resultado.error_code}] ${resultado.msg}`);
      console.log('\nRevisa screenshots en R2: debug/benavides_TEST-*');
    }
  } catch (err) {
    console.error('\n💥 Excepción no manejada:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

main();
