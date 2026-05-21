/**
 * Test local del engine para Gasmaz.
 * Uso: node scripts/test-gasmaz.js
 *
 * Opcional — sobreescribir campos via env:
 *   RFC="XAXX010101000" FOLIO="12345" TOTAL="350.00" node scripts/test-gasmaz.js
 */
require('dotenv').config();
const { facturarConEngine } = require('../engine');

// ── Payload de prueba ────────────────────────────────────────────────────────
// Ajusta estos valores con un ticket real de Gasmaz antes de correr.
const PAYLOAD = {
  portal:        'gasmaz',
  ticketId:      'TEST-' + Date.now(),

  // Datos del ticket — reemplaza con valores reales
  folio:         process.env.FOLIO     || 'REEMPLAZAR_FOLIO',
  total:         process.env.TOTAL     || 'REEMPLAZAR_TOTAL',
  fecha:         process.env.FECHA     || new Date().toISOString().split('T')[0],

  // Datos fiscales — reemplaza con RFC real
  rfc:           process.env.RFC            || 'REEMPLAZAR_RFC',
  razonSocial:   process.env.RAZON_SOCIAL   || 'PERSONA DE PRUEBA SA DE CV',
  regimenFiscal: process.env.REGIMEN        || '626',
  usoCfdi:       process.env.USO_CFDI       || 'G03',
  codigoPostal:  process.env.CP             || '80140',

  // URL del portal (opcional — si no se da, usa url_base del config.json)
  portalUrl:     process.env.PORTAL_URL     || null,
};

// ── Telemetría de consola para el test ──────────────────────────────────────
const telemetria = {
  log(evento) {
    console.log(`[TEL] ${JSON.stringify(evento)}`);
  },
  record(evento) {
    console.log(`[TEL:RECORD] ${JSON.stringify(evento, null, 2)}`);
  },
};

// ── Validaciones previas ─────────────────────────────────────────────────────
function validarPayload(p) {
  const errores = [];
  if (!process.env.BROWSERLESS_TOKEN) errores.push('BROWSERLESS_TOKEN no está en .env');
  if (p.folio.startsWith('REEMPLAZAR'))   errores.push('Ajusta FOLIO con un valor real (o usa env FOLIO=xxx)');
  if (p.total.startsWith('REEMPLAZAR'))   errores.push('Ajusta TOTAL con un valor real (o usa env TOTAL=xxx)');
  if (p.rfc.startsWith('REEMPLAZAR'))     errores.push('Ajusta RFC con un valor real (o usa env RFC=xxx)');
  return errores;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n══════════════════════════════════════════════');
  console.log('  TEST ENGINE — GASMAZ');
  console.log('══════════════════════════════════════════════\n');

  console.log('📋 Payload:');
  console.log(JSON.stringify(PAYLOAD, null, 2));
  console.log('');

  const errores = validarPayload(PAYLOAD);
  if (errores.length > 0) {
    console.error('❌ El payload tiene campos sin configurar:\n');
    errores.forEach(e => console.error(`   • ${e}`));
    console.error('\nEdita scripts/test-gasmaz.js o usa variables de entorno:');
    console.error('  RFC="TU_RFC" FOLIO="12345" TOTAL="350.00" node scripts/test-gasmaz.js\n');
    process.exit(1);
  }

  console.log('🚀 Iniciando engine...\n');
  const inicio = Date.now();

  try {
    const resultado = await facturarConEngine('gasmaz', PAYLOAD, telemetria);

    const duracion = ((Date.now() - inicio) / 1000).toFixed(1);
    console.log('\n══════════════════════════════════════════════');
    console.log(`  RESULTADO (${duracion}s)`);
    console.log('══════════════════════════════════════════════');
    console.log(JSON.stringify(resultado, null, 2));

    if (!resultado) {
      console.log('\n⚠️  El engine devolvió null — no existe commerce/gasmaz/flow.json?');
      process.exit(1);
    }

    if (resultado.ok) {
      if (resultado.procesandoCorreo) {
        console.log('\n📬 Factura generada — llegará por correo IMAP (comportamiento esperado)');
      } else {
        console.log('\n✅ Factura generada con archivos directos:');
        if (resultado.xmlUrl) console.log(`   XML: ${resultado.xmlUrl}`);
        if (resultado.pdfUrl) console.log(`   PDF: ${resultado.pdfUrl}`);
      }
    } else {
      console.log(`\n❌ Error: [${resultado.error_code}] ${resultado.msg}`);
      console.log('\nRevisa los screenshots de debug en R2: debug/gasmaz_TEST-*');
    }

  } catch (err) {
    console.error('\n💥 Excepción no manejada:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

main();
