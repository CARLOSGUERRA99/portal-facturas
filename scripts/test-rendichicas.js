/**
 * Test local del engine para Rendichicas / Rendilitros.
 * Uso: node scripts/test-rendichicas.js
 *
 * Opcional — sobreescribir campos via env:
 *   RFC="XAXX010101000" FOLIO="769660" TOTAL="1000.00" FECHA="2026-05-18" node scripts/test-rendichicas.js
 */
require('dotenv').config();
const { facturarConEngine } = require('../engine');

// ── Payload de prueba ────────────────────────────────────────────────────────
// Ajusta con datos de un ticket real de Rendichicas/Rendilitros antes de correr.
const PAYLOAD = {
  portal:        'rendichicas',
  ticketId:      'TEST-' + Date.now(),

  // Datos del ticket — reemplaza con valores reales del ticket
  folio:         process.env.FOLIO     || 'REEMPLAZAR_FOLIO',
  total:         process.env.TOTAL     || 'REEMPLAZAR_TOTAL',
  fecha:         process.env.FECHA     || new Date().toISOString().split('T')[0],

  // Datos fiscales
  rfc:           process.env.RFC            || 'REEMPLAZAR_RFC',
  razonSocial:   process.env.RAZON_SOCIAL   || 'EMPRESA DE PRUEBA SA DE CV',
  regimenFiscal: process.env.REGIMEN        || '601',
  usoCfdi:       process.env.USO_CFDI       || 'G03',
  codigoPostal:  process.env.CP             || '85000',

  // portalUrl: si el ticket trae URL de rendilitros.com, ponla aquí
  portalUrl:     process.env.PORTAL_URL     || null,
};

function validarPayload(p) {
  const errores = [];
  if (!process.env.BROWSERLESS_TOKEN) errores.push('BROWSERLESS_TOKEN no está en .env');
  if (p.folio.startsWith('REEMPLAZAR'))   errores.push('Ajusta FOLIO (o usa env FOLIO=xxx)');
  if (p.total.startsWith('REEMPLAZAR'))   errores.push('Ajusta TOTAL (o usa env TOTAL=xxx)');
  if (p.rfc.startsWith('REEMPLAZAR'))     errores.push('Ajusta RFC (o usa env RFC=xxx)');
  return errores;
}

async function main() {
  console.log('\n══════════════════════════════════════════════');
  console.log('  TEST ENGINE — RENDICHICAS / RENDILITROS');
  console.log('══════════════════════════════════════════════\n');

  console.log('📋 Payload:');
  console.log(JSON.stringify(PAYLOAD, null, 2));
  console.log('');

  const errores = validarPayload(PAYLOAD);
  if (errores.length > 0) {
    console.error('❌ Campos sin configurar:\n');
    errores.forEach(e => console.error(`   • ${e}`));
    console.error('\nEjemplo:');
    console.error('  RFC="TU_RFC" FOLIO="769660" TOTAL="1000.00" FECHA="2026-05-18" node scripts/test-rendichicas.js\n');
    process.exit(1);
  }

  console.log('🚀 Iniciando engine...\n');
  const inicio = Date.now();

  try {
    const resultado = await facturarConEngine('rendichicas', PAYLOAD);
    const duracion = ((Date.now() - inicio) / 1000).toFixed(1);

    console.log('\n══════════════════════════════════════════════');
    console.log(`  RESULTADO (${duracion}s)`);
    console.log('══════════════════════════════════════════════');
    console.log(JSON.stringify(resultado, null, 2));

    if (!resultado) {
      console.log('\n⚠️  Engine devolvió null — ¿existe commerce/rendichicas/flow.json?');
      process.exit(1);
    }

    if (resultado.ok) {
      if (resultado.procesandoCorreo) {
        console.log('\n📬 Factura generada — llegará por IMAP');
      } else {
        console.log('\n✅ Éxito con archivos directos:');
        if (resultado.xmlUrl) console.log(`   XML: ${resultado.xmlUrl}`);
        if (resultado.pdfUrl) console.log(`   PDF: ${resultado.pdfUrl}`);
      }
    } else {
      console.log(`\n❌ Error: [${resultado.error_code}] ${resultado.msg}`);
      console.log('\nRevisa screenshots en R2: debug/rendichicas_TEST-*');
    }

  } catch (err) {
    console.error('\n💥 Excepción no manejada:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

main();
