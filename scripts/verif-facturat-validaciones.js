/**
 * verif-facturat-validaciones.js — comprueba las salidas de bots/facturat.js
 * que ocurren ANTES de abrir el navegador (rule: no gastar una sesion de
 * Browserless para descubrir que faltan datos).
 *
 * Corre SIN BROWSERLESS_TOKEN a proposito: si la ejecucion llegara a intentar
 * abrir el navegador, revienta con "BROWSERLESS_TOKEN no definido" y aqui se ve.
 */
delete process.env.BROWSERLESS_TOKEN;
const { facturarFacturaT } = require("../bots/facturat");

const BASE = {
  folio: "271404",
  total: 330.01,
  fecha: "07/09/2026",
  rfc: "GPR110128QD8",
  razonSocial: "GPN PINTURAS Y RECUBRIMIENTOS",
  regimenFiscal: "601",
  usoCfdi: "G03",
  codigoPostal: "80140",
  emailEntrega: "buzonfacturas@serviciosga.site",
  portalUrl: "https://autofacturat.com.mx/FacturacionChurchsChicken/",
  ticketId: 362,
};

const CASOS = [
  ["sin folio", { ...BASE, folio: null, referencia: null }, "datos_invalidos"],
  ["sin total", { ...BASE, total: null, importe: null, monto: null }, "datos_invalidos"],
  ["total no numerico", { ...BASE, total: "N/D" }, "datos_invalidos"],
  ["sin RFC", { ...BASE, rfc: null }, "datos_invalidos"],
  ["URL de otro portal", { ...BASE, portalUrl: "https://facturacion.oxxo.com/" }, "datos_invalidos"],
  ["sin URL y sin pista en el OCR", { ...BASE, portalUrl: null, urlEstacion: null }, "datos_invalidos"],
  // Este SI pasa la validacion: la marca sale del texto del ticket. Debe morir
  // en el navegador (token borrado), no antes.
  ["marca sacada del ocr_text", { ...BASE, portalUrl: null, urlEstacion: null, ocr_text: "gracias por su compra autofacturat.com.mx/FacturacionChurchsChicken/" }, "LLEGA-AL-NAVEGADOR"],
  ["otra marca en la URL", { ...BASE, portalUrl: "https://autofacturat.com.mx/FacturacionOtraMarca/" }, "LLEGA-AL-NAVEGADOR"],
];

(async () => {
  let fallos = 0;
  for (const [nombre, datos, esperado] of CASOS) {
    let r;
    try { r = await facturarFacturaT(datos); } catch (e) { r = { excepcion: e.message }; }
    const obtenido = r.excepcion ? (/BROWSERLESS_TOKEN/.test(r.excepcion) ? "LLEGA-AL-NAVEGADOR" : `EXCEPCION: ${r.excepcion}`) : (r.error_code || (r.ok ? "ok:true" : "sin error_code"));
    const ok = obtenido === esperado;
    if (!ok) fallos++;
    console.log(`${ok ? "OK " : "!! "}${nombre.padEnd(32)} -> ${obtenido}`);
    if (r.msg) console.log(`      ${r.msg.slice(0, 170)}`);
  }
  console.log(`\n${fallos ? `!! ${fallos} FALLOS` : "TODO OK"}`);
  process.exit(fallos ? 1 : 0);
})();
