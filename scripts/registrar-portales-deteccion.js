// Da de alta en portales/portales.json los portales que YA tienen bot y prompt
// de OCR pero que la DETECCIÓN (Pasada 1) desconocía.
//
// ⚠️ El fallo que arregla: lib/vision.js tiene un prompt especializado por
// portal, pero solo se usa si la Pasada 1 identifica ese portal — y esa pasada
// arma su prompt leyendo portales.json. Si el portal no está ahí, el modelo ni
// siquiera sabe que existe como opción, devuelve "desconocido", y corre el
// prompt genérico. Consecuencia real medida en el banco de pruebas:
//   · IGasFac: el genérico tomaba el "Folio:" corto en vez del Folioweb largo,
//     y el portal rechazaba la factura. 3 tickets perdidos por esto.
//   · OXXO GAS: se detectaba como "oxxo" (la tienda), usaba su prompt, y leía
//     el folio mal (75400070 en vez de 7540670). 2 tickets.
//
// Es el cuarto sitio que hay que tocar al dar de alta un bot, además de los
// tres que ya estaban documentados en lib/util.js.
const fs = require('fs');
const path = require('path');

const RUTA = path.join(__dirname, '..', 'portales', 'portales.json');

const NUEVOS = {
  igasfac: {
    nombre: 'IGasFac (gasolineras)',
    bot: 'igasfac.js',
    estado: 'activo',
    url_base: 'https://www.igasfac.com.mx',
    tecnologia: 'ASP.NET Core con login de cuenta',
    stealth: true,
    comercios: ['Gasolineras PABA', 'Combustibles y Servicios Nainari', 'gasolineras que facturan en igasfac.com.mx'],
    deteccion: {
      por_portal_field: 'igasfac',
      por_texto_ocr: ['igasfac.com.mx', 'igasfac', 'folioweb', 'facture en linea'],
      por_comercio: [],
      // El OCR confunde el "1" inicial con una "l" minúscula: se aceptan ambas.
      por_url_qr: ['igasfac.com.mx', '1gasfac.com.mx', 'lgasfac.com.mx'],
    },
    notas_desarrollo: 'El folio que pide el portal es el FOLIOWEB largo (formato 4-8-8 con guiones) impreso DEBAJO de "Facturacion en: www.igasfac.com.mx", NO el "Folio:" corto de arriba. Ventana: hasta el ultimo dia del mes.',
  },
  oxxogas: {
    nombre: 'OXXO GAS',
    bot: 'oxxogas.js',
    estado: 'manual',
    url_base: 'https://facturacion.oxxogas.com',
    tecnologia: 'SPA con jQuery Chosen; login con reCAPTCHA v2',
    stealth: true,
    comercios: ['OXXO GAS (estaciones de servicio)'],
    deteccion: {
      por_portal_field: 'oxxogas',
      // "OXXO GAS" contiene "oxxo": sin una entrada propia se detecta como la
      // tienda de conveniencia y se usa el prompt equivocado.
      por_texto_ocr: ['oxxo gas', 'oxxogas.com', 'estacion galerias', 'spin premia'],
      por_comercio: ['oxxo gas'],
      por_url_qr: ['oxxogas.com'],
    },
    notas_desarrollo: 'NO es la tienda OXXO. El ticket trae "Folio:" de 7 digitos y "Bomba:". Requiere cookies de sesion inyectadas a mano: el login tiene reCAPTCHA v2 que no se resuelve. Entrar SIEMPRE por la home, nunca por deep link.',
  },
  caffenio: {
    nombre: 'CAFFENIO',
    bot: 'caffenio.js',
    estado: 'activo',
    url_base: 'https://facturaciondrive.caffenio.com/ticket',
    tecnologia: 'SPA con autocomplete de drives',
    stealth: true,
    comercios: ['CAFFENIO (cafeterias drive)'],
    deteccion: {
      por_portal_field: 'caffenio',
      por_texto_ocr: ['caffenio', 'facturaciondrive'],
      por_comercio: ['caffenio'],
      por_url_qr: ['facturaciondrive.caffenio.com'],
    },
    notas_desarrollo: 'Exige folio + codigo de facturacion + nombre del drive, y los valida en conjunto. Ventana de 30 dias naturales. Sin CAPTCHA.',
  },
  '7eleven': {
    nombre: '7-Eleven México',
    bot: '7elevenmexicosadecv.js',
    estado: 'activo',
    url_base: 'https://www.e7-eleven.com.mx/facturacion/KPortalExterno/',
    tecnologia: 'AngularJS con CAPTCHA de imagen (CapSolver)',
    stealth: true,
    comercios: ['7 Eleven Mexico SA de CV'],
    deteccion: {
      por_portal_field: '7eleven',
      por_texto_ocr: ['7-eleven', '7 eleven', 'e7-eleven.com.mx'],
      por_comercio: ['7 eleven', '7-eleven'],
      por_url_qr: ['e7-eleven.com.mx'],
    },
    notas_desarrollo: 'El folio es el codigo de barras de EXACTAMENTE 35 digitos; el portal rechaza si faltan.',
  },
};

const j = JSON.parse(fs.readFileSync(RUTA, 'utf8'));
j.portales = j.portales || {};

let n = 0;
for (const [clave, def] of Object.entries(NUEVOS)) {
  if (j.portales[clave]) { console.log(`⏭️  ${clave} ya estaba`); continue; }
  j.portales[clave] = def;
  console.log(`✅ ${clave} dado de alta en la detección`);
  n++;
}

if (n) {
  fs.writeFileSync(RUTA, JSON.stringify(j, null, 2));
  console.log(`\n${n} portal(es) añadido(s). La detección ahora conoce ${Object.keys(j.portales).length}.`);
} else {
  console.log('\nsin cambios');
}
