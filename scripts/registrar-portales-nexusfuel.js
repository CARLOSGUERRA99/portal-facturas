// Da de alta la familia NexusFuel multi-tenant (facturacionestacion.com): un
// subdominio por estación, mismo flujo y mismos campos.
//
// Sin estas entradas la Pasada 1 devolvía "desconocido" y el ticket se extraía
// con el prompt genérico, que confunde el "Ticket:" con la "Referencia para
// facturar" — justamente los dos campos que pide el bot.
const fs = require('fs');
const path = require('path');

const RUTA = path.join(__dirname, '..', 'portales', 'portales.json');
const NOTA = 'El bot pide DOS datos: folio = el número de "Ticket:", referencia = la "Referencia para facturar" (que coincide con el número de "Estación:"). No confundirlos.';

const NUEVOS = {
  gashr: {
    nombre: 'NexusFuel / facturacionestacion.com (Grupo GASHR y estaciones asociadas)',
    bot: 'gashr.js',
    estado: 'activo',
    url_base: 'https://valerogdl.facturacionestacion.com',
    tecnologia: 'NexusFuel multi-tenant — un subdominio por estación',
    stealth: true,
    comercios: ['Autoservicio Gashr / Valero GDL', 'Sibilina Pantoja Reyes - Servicio Las Conchas', 'estaciones con portal en *.facturacionestacion.com'],
    deteccion: {
      por_portal_field: 'gashr',
      por_texto_ocr: ['facturacionestacion.com', 'referencia para facturar', 'facturacion en linea'],
      por_comercio: [],
      por_url_qr: ['facturacionestacion.com'],
      nota_deteccion: NOTA,
    },
    notas_desarrollo: 'El subdominio cambia por estación (valerogdl., lasconchas., …): reconocer el DOMINIO, no el subdominio. Ventana corta: el ticket avisa 24 hrs.',
  },
  petrofigues: {
    nombre: 'Petrofigues',
    bot: 'petrofigues.js',
    estado: 'activo',
    url_base: 'https://facturacion.petrofigues.com',
    tecnologia: 'NexusFuel — misma plataforma y mismos campos que gashr',
    stealth: true,
    comercios: ['Petrofigues'],
    deteccion: {
      por_portal_field: 'petrofigues',
      por_texto_ocr: ['petrofigues'],
      por_comercio: ['petrofigues'],
      por_url_qr: ['petrofigues'],
      nota_deteccion: NOTA,
    },
    notas_desarrollo: 'Otro tenant NexusFuel. Cada tenant guarda su propio registro de cliente aunque el RFC sea el mismo.',
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
