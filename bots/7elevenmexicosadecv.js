// 7-Eleven México (e7-eleven.com.mx) — Facturación Express.
//
// IMPORTANTE: el portal exige un CAPTCHA de imagen obligatorio en el formulario
// (campo "* CAPTCHA:"). Los CAPTCHA son protección anti-bot por diseño; NO se
// automatizan ni se burlan. Por eso 7-Eleven NO se factura de forma automática:
// se enruta a FACTURACIÓN MANUAL ASISTIDA — el usuario abre el portal, sus datos
// ya están extraídos (folio de 35 dígitos, RFC, total) y solo resuelve el CAPTCHA.
//
// Flujo manual: FACTURA EXPRESS → No. Ticket (35 díg.) → Agregar Ticket →
// datos fiscales → CAPTCHA → FACTURAR → descarga PDF/XML.

async function facturar7Eleven(datos = {}) {
  const folio = (datos.folio || datos.referencia || '').toString();
  console.log(`ℹ️ 7-Eleven requiere CAPTCHA — facturación manual. Folio: ${folio}`);
  return {
    ok: false,
    error_code: 'captcha',
    requiere_manual: true,
    portal_url: 'https://www.e7-eleven.com.mx/facturacion/KPortalExterno/',
    msg: '7-Eleven pide CAPTCHA — no se puede facturar automáticamente. ' +
         'Hazlo manual en el portal (FACTURA EXPRESS): captura el No. de Ticket (35 dígitos), ' +
         'tus datos fiscales y resuelve el CAPTCHA. Tus datos ya están extraídos y listos.',
  };
}

module.exports = { facturar7Eleven };
