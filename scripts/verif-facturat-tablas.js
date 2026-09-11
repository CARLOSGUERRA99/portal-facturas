/**
 * verif-facturat-tablas.js — comprobacion OFFLINE (sin navegador) de las dos
 * tablas de bots/facturat.js contra lo que el portal sirve de verdad:
 *   · REGIMENES: cada clave SAT casa con UNA sola opcion, y con la correcta.
 *   · La clasificacion de los mensajes del feedback (los textos son los
 *     literales capturados en vivo el 11-sep-2026).
 */
const fs = require("fs");
const fuente = fs.readFileSync(require("path").join(__dirname, "..", "bots", "facturat.js"), "utf8");
const trozo = (re) => { const m = fuente.match(re); if (!m) throw new Error("no se pudo extraer " + re); return m[0]; };
// eslint-disable-next-line no-eval
const REGIMENES = eval("(" + trozo(/const REGIMENES = \{[\s\S]*?\n\};/).replace(/^const REGIMENES = /, "").replace(/;$/, "") + ")");
// eslint-disable-next-line no-eval
const plano = eval("(" + trozo(/const plano = \(s\) =>[^\n]*/).replace(/^const plano = /, "").replace(/;$/, "") + ")");

// Catalogo tal cual lo pinta el portal (orden incluido).
const OPCIONES = [
  "Choose One",
  "General de Ley Personas Morales",
  "Personas Morales con Fines no Lucrativos",
  "Sueldos y Salarios e Ingresos Asimilados a Salarios",
  "Arrendamiento",
  "Demas Ingresos",
  "Consolidacion",
  "Residentes en el Extranjero sin Establecimiento Permanente en Mexico",
  "Ingresos por Dividendos (socios y accionistas)",
  "Personas Fisicas con Actividades Empresariales y Profesionales",
  "Ingresos por intereses",
  "Sin obligaciones fiscales",
  "Sociedades Cooperativas de Produccion que optan por diferir sus ingresos",
  "Incorporacion Fiscal",
  "Actividades Agricolas, Ganaderas, Silvicolas y Pesqueras",
  "Opcional para Grupos de Sociedades",
  "Coordinados",
  "Hidrocarburos",
  "Regimen de Enajenacion o Adquisicion de Bienes",
  "De los Regimenes Fiscales Preferentes y de las Empresas Multinacionales",
  "Enajenacion de acciones en bolsa de valores",
  "Regimen de los ingresos por obtencion de premios",
  "Regimen de las Actividades Empresariales con ingresos a traves de Plataformas Tecnologicas",
  "Regimen Simplificado de Confianza",
];
const ESPERADO = {
  "601": "General de Ley Personas Morales",
  "603": "Personas Morales con Fines no Lucrativos",
  "605": "Sueldos y Salarios e Ingresos Asimilados a Salarios",
  "606": "Arrendamiento",
  "607": "Regimen de Enajenacion o Adquisicion de Bienes",
  "608": "Demas Ingresos",
  "609": "Consolidacion",
  "610": "Residentes en el Extranjero sin Establecimiento Permanente en Mexico",
  "611": "Ingresos por Dividendos (socios y accionistas)",
  "612": "Personas Fisicas con Actividades Empresariales y Profesionales",
  "614": "Ingresos por intereses",
  "615": "Regimen de los ingresos por obtencion de premios",
  "616": "Sin obligaciones fiscales",
  "620": "Sociedades Cooperativas de Produccion que optan por diferir sus ingresos",
  "621": "Incorporacion Fiscal",
  "622": "Actividades Agricolas, Ganaderas, Silvicolas y Pesqueras",
  "623": "Opcional para Grupos de Sociedades",
  "624": "Coordinados",
  "625": "Regimen de las Actividades Empresariales con ingresos a traves de Plataformas Tecnologicas",
  "626": "Regimen Simplificado de Confianza",
  "628": "Hidrocarburos",
  "629": "De los Regimenes Fiscales Preferentes y de las Empresas Multinacionales",
  "630": "Enajenacion de acciones en bolsa de valores",
};

let fallos = 0;
console.log("== REGIMENES ==");
for (const [clave, patron] of Object.entries(REGIMENES)) {
  // El bot salta la opcion de value "" (Choose One), igual que aqui.
  const casan = OPCIONES.slice(1).filter((t) => patron.test(plano(t)));
  const ok = casan.length === 1 && casan[0] === ESPERADO[clave];
  if (!ok) fallos++;
  console.log(`${ok ? "OK " : "!! "}${clave} ${patron} -> ${JSON.stringify(casan)}`);
}
const sinTabla = Object.keys(ESPERADO).filter((k) => !REGIMENES[k]);
if (sinTabla.length) { fallos++; console.log("!! claves del catalogo que el bot no sabe casar:", sinTabla.join(", ")); }

console.log("\n== USO DE CFDI (se casa por el prefijo del texto) ==");
const USOS = ["G01.Adquisición de mercancias", "G02.Devoluciones, descuentos o bonificaciones", "G03.Gastos en general",
  "I01.Construcciones", "S01.Sin efectos fiscales", "CP01.Pagos", "CN01.Nómina", "P01. Pagos", "D01.Honorarios médicos, dentales y gastos hospitalarios."];
for (const clave of ["G03", "G01", "P01", "CP01"]) {
  const patron = new RegExp(`^${clave.toLowerCase().replace(/[^a-z0-9]/g, "")}[.\\s]`);
  const casan = USOS.filter((t) => patron.test(plano(t)));
  const ok = casan.length === 1 && casan[0].toUpperCase().startsWith(clave);
  if (!ok) fallos++;
  console.log(`${ok ? "OK " : "!! "}${clave} -> ${JSON.stringify(casan)}`);
}

console.log("\n== CLASIFICACION DE MENSAJES DEL PORTAL ==");
// Mismas expresiones, en el mismo orden en que las evalua el bot.
const clasificar = (txt) => {
  const m = plano(txt);
  if (/page expired|pagina expirada|sesion (ha )?(expirad|caducad)|internal server error|error interno/.test(m)) return "reintentar_despues";
  if (/ya (fue|ha sido|esta) facturad|ya (existe|se genero|se emitio)|factura ya (generad|emitid)/.test(m)) return "ya_facturado";
  if (/monto del ticket invalid|monto invalid|importe invalid/.test(m)) return "datos_invalidos(monto)";
  if (/no encontrad|no existe|no se encontro/.test(m)) return "datos_invalidos(no encontrado)";
  return "seguir";
};
const CASOS = [
  ["Ticket o Remisión encontrada, datos mostrados en pantalla", "seguir"],
  ["Monto del ticket Inválido", "datos_invalidos(monto)"],
  ["Ticket o Remisión no encontrada", "datos_invalidos(no encontrado)"],
  ["Ticket o Remisión encontrada, datos mostrados en pantalla | Monto del ticket Inválido", "datos_invalidos(monto)"],
  ["Page Expired", "reintentar_despues"],
  ["La factura ya fue facturada", "ya_facturado"],
  ["", "seguir"],
];
for (const [txt, esperado] of CASOS) {
  const r = clasificar(txt);
  const ok = r === esperado;
  if (!ok) fallos++;
  console.log(`${ok ? "OK " : "!! "}${JSON.stringify(txt).slice(0, 70)} -> ${r}`);
}

console.log(`\n${fallos ? `!! ${fallos} FALLOS` : "TODO OK"}`);
process.exit(fallos ? 1 : 0);
