/**
 * Prueba EN VIVO del analizador interactivo multi-paso.
 * Recorre TUFESA (#87) con sus datos reales y reporta cuántas pantallas capturó
 * y el JSON de análisis (selectores por pantalla).
 * Uso: node scripts/test-analizador.js
 */
require('dotenv').config();
const { analizarPortal } = require('../agentes/analizador');

(async () => {
  console.log('▶️  Analizando TUFESA (interactivo)...\n');
  const a = await analizarPortal({
    portalUrl: 'https://www.tufesa.com.mx/facturacion',
    comercioNombre: 'TUFESA',
    datosReales: {
      rfc: 'GPR110128QD8', razonSocial: 'GPN PINTURAS Y RECUBRIMIENTOS',
      referencia: '63058973', folio: '63058973', total: '1789',
      fechaDMY: '25/05/2026', email: 'buzonfacturas@serviciosga.site',
    },
  });
  console.log('\n=== RESUMEN ===');
  console.log('Pantallas capturadas:', a._pantallas);
  console.log('Screenshots:', (a._screenshots || []).map(s => s.label).join(', '));
  console.log('Tecnología:', a.tecnologia, '| Flujo:', a.flujo);
  console.log('\n=== SELECTORES ===');
  console.log(JSON.stringify(a.selectores, null, 2));
  console.log('\n=== CAMPOS ===');
  console.log(JSON.stringify(a.campos, null, 2));
  console.log('\n=== PASOS ===');
  console.log(JSON.stringify(a.pasos, null, 2));
  console.log('\n=== CASOS ESPECIALES / NOTAS ===');
  console.log(JSON.stringify({ casos: a.casos_especiales, notas: a.notas, similitud: a.similitud_portales }, null, 2));
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
