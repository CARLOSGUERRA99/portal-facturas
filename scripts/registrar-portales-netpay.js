// Da de alta la familia de tickets con terminal NetPay (Enerfuel Tech, Enerser).
// Ver el comentario de PROMPT_NETPAY_REFERENCIA en lib/vision.js: el dato que
// pide el portal es la "Referencia:" del pie, no el "Folio:" de la terminal.
const fs = require('fs');
const path = require('path');

const RUTA = path.join(__dirname, '..', 'portales', 'portales.json');
const NOTA = 'El dato de facturación es la "Referencia:" del PIE del ticket (15-16 caracteres sin guiones), NO el "Folio:" con guiones de la terminal bancaria.';

const NUEVOS = {
  enerfueltech: {
    nombre: 'Enerfuel Tech',
    bot: 'enerfueltech.js',
    estado: 'activo',
    url_base: 'https://factura.enerfueltech.com/',
    tecnologia: 'Blazor/MudBlazor — "Facturar sin registro" con un único campo Referencia',
    stealth: true,
    comercios: ['Grupo Inmo SA de CV', 'gasolineras que facturan en factura.enerfueltech.com'],
    deteccion: {
      por_portal_field: 'enerfueltech',
      por_texto_ocr: ['pagina(s) para facturar', 'enerfueltech.com', 'netpay'],
      por_comercio: ['grupo inmo'],
      por_url_qr: ['enerfueltech.com'],
      nota_deteccion: NOTA,
    },
    notas_desarrollo: 'Ticket impreso por terminal NetPay. El portal pide SOLO la Referencia. La ventana real NO es fija: hay que consultar y confiar en la respuesta del portal.',
  },
  enerser: {
    nombre: 'Enerser',
    bot: null,
    estado: 'pendiente',
    url_base: 'http://facturacion.enerser.com.mx/',
    tecnologia: 'misma plataforma que Enerfuel Tech, otro dominio',
    stealth: true,
    comercios: ['Petroliferos La Territorial S de RL de CV', 'gasolineras que facturan en facturacion.enerser.com.mx'],
    deteccion: {
      por_portal_field: 'enerser',
      por_texto_ocr: ['pagina(s) para facturar', 'enerser.com.mx', 'netpay'],
      por_comercio: ['petroliferos la territorial'],
      por_url_qr: ['enerser.com.mx'],
      nota_deteccion: NOTA,
    },
    notas_desarrollo: 'Mismo formato de ticket y mismo campo Referencia que enerfueltech, pero OTRO dominio: falta confirmar en vivo que bots/enerfueltech.js sirva tal cual antes de marcarlo activo.',
  },
};

const j = JSON.parse(fs.readFileSync(RUTA, 'utf8'));
let n = 0;
for (const [clave, def] of Object.entries(NUEVOS)) {
  if (j.portales[clave]) { console.log(`⏭️  ${clave} ya estaba`); continue; }
  j.portales[clave] = def;
  console.log(`✅ ${clave} dado de alta en la detección`);
  n++;
}
if (n) {
  j.actualizado = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(RUTA, JSON.stringify(j, null, 2));
  console.log(`\n${n} añadido(s). La detección conoce ${Object.keys(j.portales).length} portales.`);
} else {
  console.log('\nsin cambios');
}
