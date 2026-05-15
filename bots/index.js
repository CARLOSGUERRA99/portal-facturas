const { facturarOXXO } = require('./oxxo');
const { facturarBuzonFacturas } = require('./buzonfacturas');
const { facturarGasmaz } = require('./gasmaz');

async function detectarYFacturar(datos) {
  const texto = (datos.ocr_text || '').toLowerCase();
  const comercio = (datos.comercio || '').toLowerCase();
  const portalUrl = (datos.portalUrl || '').toLowerCase();

  if (
    texto.includes('buzonfacturas') ||
    portalUrl.includes('buzonfacturas') ||
    texto.includes('arco') ||
    comercio.includes('arco')
  ) {
    console.log('🎯 Portal detectado: BuzonFacturas');
    return await facturarBuzonFacturas(datos);
  }

  if (texto.includes('oxxo') || comercio.includes('oxxo')) {
    console.log('🎯 Portal detectado: OXXO');
    return await facturarOXXO(datos);
  }

  if (
    texto.includes('nexusfuel') ||
    texto.includes('gasmaz') ||
    portalUrl.includes('nexusfuel') ||
    portalUrl.includes('gasmaz') ||
    comercio.includes('gasmaz')
  ) {
    console.log('🎯 Portal detectado: Gasmaz/NexusFuel');
    return await facturarGasmaz(datos);
  }

  console.log('⚠️ Portal no reconocido:', datos.comercio);
  return {
    ok: false,
    sinPortal: true,
    msg: `Portal no reconocido para: ${datos.comercio || 'desconocido'}`,
  };
}

module.exports = { detectarYFacturar };

