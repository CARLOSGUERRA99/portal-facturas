// Lectura y verificación del CFDI que nos devuelve el portal.
//
// Hasta ahora del XML solo se sacaba el UUID (lib/util.js), y solo para nombrar
// el archivo en R2. Nadie comprobaba nunca que el comprobante estuviera a nombre
// del RFC correcto ni por el importe correcto: si un portal timbraba a otro
// receptor, o por otro total, el sistema lo guardaba como "completado" igual.
//
// Con un cliente eso se nota a ojo. Con treinta, no. Y un CFDI mal emitido no se
// corrige: se cancela y se vuelve a pedir, dentro de un plazo.
//
// Sin dependencias nuevas: los atributos del CFDI son planos y el XML viene
// firmado, así que no puede traer comillas sin escapar dentro de un valor.

// Saca un atributo de la primera etiqueta que coincida, sin importar el prefijo
// de namespace (cfdi:Receptor, c:Receptor, Receptor…).
function attr(xml, etiqueta, nombre) {
  const tag = new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${etiqueta}\\b[^>]*>`, "i");
  const m = xml.match(tag);
  if (!m) return null;
  const a = m[0].match(new RegExp(`\\b${nombre}\\s*=\\s*"([^"]*)"`, "i"));
  return a ? a[1] : null;
}

// Convierte el XML del CFDI en los datos que de verdad usamos.
function leerCFDI(xmlBufferOrString) {
  const xml = Buffer.isBuffer(xmlBufferOrString) ? xmlBufferOrString.toString("utf8") : String(xmlBufferOrString || "");
  if (!/<(?:[A-Za-z0-9_.-]+:)?Comprobante\b/i.test(xml)) return null;

  return {
    version: attr(xml, "Comprobante", "Version") || attr(xml, "Comprobante", "version"),
    uuid: (attr(xml, "TimbreFiscalDigital", "UUID") || "").toUpperCase() || null,
    fechaTimbrado: attr(xml, "TimbreFiscalDigital", "FechaTimbrado"),
    fecha: attr(xml, "Comprobante", "Fecha"),
    serie: attr(xml, "Comprobante", "Serie"),
    folio: attr(xml, "Comprobante", "Folio"),
    total: parseFloat(attr(xml, "Comprobante", "Total") || "0") || 0,
    moneda: attr(xml, "Comprobante", "Moneda"),
    tipo: attr(xml, "Comprobante", "TipoDeComprobante"),
    emisorRfc: (attr(xml, "Emisor", "Rfc") || "").toUpperCase() || null,
    emisorNombre: attr(xml, "Emisor", "Nombre"),
    receptorRfc: (attr(xml, "Receptor", "Rfc") || "").toUpperCase() || null,
    receptorNombre: attr(xml, "Receptor", "Nombre"),
    receptorCp: attr(xml, "Receptor", "DomicilioFiscalReceptor"),
    receptorRegimen: attr(xml, "Receptor", "RegimenFiscalReceptor"),
    usoCfdi: attr(xml, "Receptor", "UsoCFDI"),
  };
}

// Compara el CFDI contra a quién creíamos estar facturando y por cuánto.
// Devuelve los problemas encontrados, del más grave al menos.
function verificarCFDI(cfdi, { rfcEsperado, totalEsperado, toleranciaCentavos = 1 } = {}) {
  const problemas = [];
  if (!cfdi) return [{ gravedad: "grave", clave: "xml_ilegible", msg: "el XML no es un CFDI legible" }];

  if (!cfdi.uuid)
    problemas.push({ gravedad: "grave", clave: "sin_timbre", msg: "no tiene TimbreFiscalDigital: no está timbrado ante el SAT" });

  // El más importante de todos: un CFDI a otro RFC no es deducible por nuestro
  // cliente, y no nos enteraríamos nunca.
  if (rfcEsperado && cfdi.receptorRfc && cfdi.receptorRfc !== String(rfcEsperado).toUpperCase())
    problemas.push({
      gravedad: "grave", clave: "receptor_distinto",
      msg: `emitido a ${cfdi.receptorRfc} pero el ticket es de ${String(rfcEsperado).toUpperCase()}`,
    });

  if (totalEsperado > 0 && cfdi.total > 0) {
    const dif = Math.abs(cfdi.total - Number(totalEsperado));
    if (dif > toleranciaCentavos / 100)
      problemas.push({
        gravedad: dif > 1 ? "grave" : "aviso", clave: "total_distinto",
        msg: `el CFDI dice $${cfdi.total.toFixed(2)} y el ticket $${Number(totalEsperado).toFixed(2)} (difieren $${dif.toFixed(2)})`,
      });
  }

  if (cfdi.version && cfdi.version !== "4.0")
    problemas.push({ gravedad: "aviso", clave: "version", msg: `versión ${cfdi.version}, no 4.0` });

  if (cfdi.tipo && cfdi.tipo !== "I")
    problemas.push({ gravedad: "aviso", clave: "tipo", msg: `TipoDeComprobante ${cfdi.tipo}, se esperaba I (ingreso)` });

  if (cfdi.moneda && !/^MXN$/i.test(cfdi.moneda))
    problemas.push({ gravedad: "aviso", clave: "moneda", msg: `moneda ${cfdi.moneda}` });

  return problemas;
}

module.exports = { leerCFDI, verificarCFDI };
