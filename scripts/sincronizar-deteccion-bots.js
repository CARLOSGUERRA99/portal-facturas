// Pone en portales/portales.json TODOS los bots que ya existen en bots/ y que
// la detección todavía no conoce.
//
// ⚠️ POR QUÉ IMPORTA (y por qué no falla nunca de forma visible):
// dar de alta un portal son CUATRO sitios — bots/, el routing de
// bots/index.js, el gate de procesarCola, y ESTE JSON. Si falta el cuarto, el
// bot existe y funciona, pero la Pasada 1 no sabe que existe: devuelve
// "desconocido", el ticket cae al prompt genérico y —lo caro— dispara al
// AGENTE para dar de alta un portal que YA TIENE BOT ESCRITO Y VERIFICADO.
//
// Cada alta del agente cuesta del orden de un dólar (max_tokens 20.000 en el
// generador y otros 20.000 por cada corrección). Auditado el 02/08/2026: había
// SEIS bots invisibles para la detección — capufe, dana, erfc, facturagas,
// orler y ramcal — y dos entradas con "bot": null cuyo bot sí existe.
//
// Uso: node scripts/sincronizar-deteccion-bots.js [--aplicar]
const fs = require('fs');
const path = require('path');

const RUTA = path.join(__dirname, '..', 'portales', 'portales.json');
const APLICAR = process.argv.includes('--aplicar');

// Datos sacados de la cabecera de cada bot, que documenta el reconocimiento real.
const NUEVOS = {
  capufe: {
    nombre: 'CAPUFE — Caminos y Puentes Federales',
    bot: 'capufe.js', estado: 'activo',
    url_base: 'https://facturacioncapufe.com.mx/Capufe/facturacionrapida',
    tecnologia: 'SPA React + PrimeReact, backend REST',
    stealth: true,
    comercios: ['CAPUFE', 'casetas de cuota federales', 'plazas de cobro'],
    deteccion: {
      por_portal_field: 'capufe',
      por_texto_ocr: ['capufe', 'caminos y puentes', 'plaza de cobro', 'facturacioncapufe'],
      por_comercio: ['capufe', 'caminos y puentes federales'],
      por_url_qr: ['facturacioncapufe.com.mx', 'capufe.gob.mx'],
      nota_deteccion: 'El dato que pide el portal es el código "FACTURACION" de 18 caracteres, NO el folio.',
    },
    notas_desarrollo: 'Consultar el código lo RESERVA: si se valida y no se llega a "Facturar conceptos", queda tomado. Régimen y Uso CFDI son p-dropdown de PrimeReact, no <select>.',
  },
  dana: {
    nombre: 'Dana Comida Mexicana',
    bot: 'dana.js', estado: 'activo',
    url_base: 'https://autofactura.softrestaurant.com',
    tecnologia: 'SoftRestaurant / AutoFactura',
    stealth: true,
    comercios: ['Dana Comida Mexicana'],
    deteccion: {
      por_portal_field: 'dana',
      por_texto_ocr: ['dana comida', 'autofactura'],
      por_comercio: ['dana'],
      por_url_qr: ['autofactura'],
      nota_deteccion: 'Misma familia que SushiO pero con selectores propios (#unicCode/#folio/#RFC).',
    },
    notas_desarrollo: 'referencia = código de facturación, distinto del folio.',
  },
  erfc: {
    nombre: 'eRFC (plataforma compartida)',
    bot: 'erfc.js', estado: 'activo',
    url_base: 'https://erfc.com.mx',
    tecnologia: 'PHP + Select2 con catálogos por AJAX',
    stealth: true,
    comercios: ['gasolineras y comercios chicos que facturan en erfc.com.mx'],
    deteccion: {
      por_portal_field: 'erfc',
      por_texto_ocr: ['erfc.com.mx', 'erfc', 'idw'],
      por_comercio: [],
      por_url_qr: ['erfc.com.mx'],
      nota_deteccion: 'El dato de facturación es el código IDW impreso en el ticket.',
    },
    notas_desarrollo: 'El checkbox de términos está DISABLED hasta pulsar "Oprima para Leer Términos y Condiciones".',
  },
  facturagas: {
    nombre: 'FacturaGAS / ControlGAS (ATIO Group)',
    bot: 'facturagas.js', estado: 'activo',
    url_base: 'https://app.facturagas.net',
    tecnologia: 'ASP.NET — "Facturación sin Usuario"',
    stealth: true,
    comercios: ['gasolineras que facturan con ControlGAS', 'Suministros Energéticos de Calidad'],
    deteccion: {
      por_portal_field: 'facturagas',
      por_texto_ocr: ['facturagas', 'controlgas', 'controlgasfe', 'webid'],
      por_comercio: [],
      por_url_qr: ['facturagas.net', 'controlgasfe'],
      nota_deteccion: 'NO navegar a la URL DDNS impresa en el ticket: suele venir mal transcrita. Usar SIEMPRE app.facturagas.net.',
    },
    notas_desarrollo: 'El ticket imprime una URL propia del negocio (ej. sumeca.ddns.net:83) que a menudo no resuelve. El WebID es el dato clave.',
  },
  orler: {
    nombre: 'Casetas de Sinaloa (Orler)',
    bot: 'orler.js', estado: 'activo',
    url_base: 'https://facturacion.sinaloa.gob.mx',
    tecnologia: 'Portal estatal con login de cuenta',
    stealth: true,
    comercios: ['Autopistas de cuota de Sinaloa', 'Caseta El Pisal', 'Caseta Las Brisas'],
    deteccion: {
      por_portal_field: 'orler',
      por_texto_ocr: ['sinaloa.gob.mx', 'caseta', 'autopista de cuota'],
      por_comercio: ['caseta', 'autopista de cuota'],
      por_url_qr: ['facturacion.sinaloa.gob.mx', 'sinaloa.gob.mx'],
      nota_deteccion: 'Requiere login: credenciales SOLO por ORLER_SINALOA_USER / ORLER_SINALOA_PASS, nunca en código.',
    },
    notas_desarrollo: 'Las casetas tardan 5-6 días hábiles desde el pago en aparecer: error_code reintentar_despues, no ticket inválido.',
  },
  ramcal: {
    nombre: 'RAMCAL',
    bot: 'ramcal.js', estado: 'activo',
    url_base: 'https://corporativoramcal.mx',
    tecnologia: 'portal propio con registro de cliente',
    stealth: true,
    comercios: ['gasolineras RAMCAL (Manzanillo / Guadalajara)'],
    deteccion: {
      por_portal_field: 'ramcal',
      por_texto_ocr: ['ramcal', 'corporativoramcal'],
      por_comercio: ['ramcal'],
      por_url_qr: ['corporativoramcal.mx', 'ramcal.no-ip'],
    },
    notas_desarrollo: 'GPN ya tiene perfil guardado. Ojo con el Total: el ticket muestra SubTotal y Total, y el bueno es el Total.',
  },
};

// Entradas cuyo "bot" quedó en null aunque el archivo existe.
const CORREGIR_BOT = { autozone: 'autozone.js', tufesa: 'tufesa.js' };

const j = JSON.parse(fs.readFileSync(RUTA, 'utf8'));
let cambios = 0;

for (const [clave, def] of Object.entries(NUEVOS)) {
  if (j.portales[clave]) { console.log(`⏭️  ${clave} ya estaba`); continue; }
  if (!fs.existsSync(path.join(__dirname, '..', 'bots', def.bot))) {
    console.log(`⚠️  ${clave}: no existe bots/${def.bot} — no se da de alta`);
    continue;
  }
  j.portales[clave] = def;
  console.log(`✅ ${clave} → la detección ya lo conoce (bots/${def.bot})`);
  cambios++;
}

for (const [clave, archivo] of Object.entries(CORREGIR_BOT)) {
  if (j.portales[clave] && !j.portales[clave].bot) {
    j.portales[clave].bot = archivo;
    j.portales[clave].estado = 'activo';
    console.log(`🔧 ${clave}: "bot" estaba en null y el archivo existe → ${archivo}`);
    cambios++;
  }
}

if (!cambios) { console.log('\nsin cambios'); process.exit(0); }
if (!APLICAR) { console.log(`\n${cambios} cambio(s) — usa --aplicar para escribirlos`); process.exit(0); }

j.actualizado = new Date().toISOString().slice(0, 10);
fs.writeFileSync(RUTA, JSON.stringify(j, null, 2));
console.log(`\n${cambios} cambio(s) escritos. La detección conoce ${Object.keys(j.portales).length} portales.`);
