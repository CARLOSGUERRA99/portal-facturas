const { facturarOXXO } = require('./oxxo');
const { facturarBuzonFacturas } = require('./buzonfacturas');
const { facturarGasmaz } = require('./gasmaz');
const { facturarFarmaciasGuadalajara } = require('./farmaciaguadalajara');
const { facturarHomeDepotMexico } = require('./homedepot');
const fs = require('fs');
const path = require('path');

async function detectarYFacturar(datos, db = null) {
  const texto = (datos.ocr_text || '').toLowerCase();
  const comercio = (datos.comercio || '').toLowerCase();
  const portalUrl = (datos.portalUrl || '').toLowerCase();
  const portal = (datos.portal || '').toLowerCase();

  if (
    portal === 'homedepot' ||
    texto.includes('home depot') ||
    comercio.includes('home depot') ||
    portalUrl.includes('homedepot.com.mx')
  ) {
    console.log('🎯 Portal detectado: Home Depot Mexico');
    return await facturarHomeDepotMexico(datos);
  }

  if (
    portal === 'farmaciaguadalajara' ||
    texto.includes('farmacia guadalajara') ||
    texto.includes('farmaciasguadalajara') ||
    texto.includes('fragua') ||
    comercio.includes('farmacia guadalajara') ||
    comercio.includes('fragua') ||
    portalUrl.includes('farmaciasguadalajara.com')
  ) {
    console.log('🎯 Portal detectado: Farmacias Guadalajara');
    return await facturarFarmaciasGuadalajara(datos);
  }

  if (
    portal === 'arco' ||
    texto.includes('buzonfacturas') ||
    portalUrl.includes('buzonfacturas') ||
    texto.includes('arco') ||
    comercio.includes('arco')
  ) {
    console.log('🎯 Portal detectado: BuzonFacturas');
    return await facturarBuzonFacturas(datos);
  }

  if (portal === 'oxxo' || texto.includes('oxxo') || comercio.includes('oxxo')) {
    console.log('🎯 Portal detectado: OXXO');
    return await facturarOXXO(datos);
  }

  if (
    portal === 'gasmaz' ||
    texto.includes('nexusfuel') ||
    texto.includes('gasmaz') ||
    portalUrl.includes('nexusfuel') ||
    portalUrl.includes('gasmaz') ||
    comercio.includes('gasmaz')
  ) {
    console.log('🎯 Portal detectado: Gasmaz/NexusFuel');
    return await facturarGasmaz(datos);
  }

  // Buscar bot dinámico generado por el sistema de agentes
  const slugify = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '').slice(0, 30);
  const slug = slugify(portal || comercio);
  if (slug) {
    const candidatos = [
      path.join(__dirname, `${slug}.js`),
      path.join(__dirname, `${slug.replace(/_/g, '')}.js`),
    ];
    for (const botPath of candidatos) {
      if (fs.existsSync(botPath)) {
        try {
          delete require.cache[require.resolve(botPath)];
          const botModule = require(botPath);
          const fn = Object.values(botModule)[0];
          if (typeof fn === 'function') {
            console.log(`🤖 Bot dinámico: ${path.basename(botPath)}`);
            return await fn(datos);
          }
        } catch (e) {
          console.log(`⚠️ Error cargando bot dinámico ${botPath}:`, e.message);
        }
      }
    }
  }

  // Último recurso: buscar en DB por bots activos cuyo comercio empiece igual
  // (cubre casos donde el slug del OCR no coincide exactamente con el nombre registrado)
  if (db && slug && slug.length >= 4) {
    try {
      const prefijo = slug.slice(0, Math.min(10, slug.length));
      const [rows] = await db.query(
        "SELECT comercio, nombre_archivo, bot_code FROM portales_agente WHERE estado='activo' AND bot_code IS NOT NULL AND comercio LIKE ? LIMIT 1",
        [`${prefijo}%`]
      );
      if (rows.length) {
        const row = rows[0];
        const archivo = row.nombre_archivo || `${row.comercio}.js`;
        const botPath = path.join(__dirname, archivo);
        if (!fs.existsSync(botPath)) {
          fs.writeFileSync(botPath, row.bot_code, 'utf8');
          console.log(`♻️ Bot restaurado desde DB: ${archivo}`);
        }
        try {
          delete require.cache[require.resolve(botPath)];
          const mod = require(botPath);
          const fn = Object.values(mod)[0];
          if (typeof fn === 'function') {
            console.log(`🤖 Bot dinámico (DB fallback): ${archivo}`);
            return await fn(datos);
          }
        } catch (e) {
          console.log(`⚠️ Error ejecutando bot DB ${archivo}:`, e.message);
        }
      }
    } catch (e) {
      console.log('⚠️ Error consultando portales_agente:', e.message);
    }
  }

  console.log('⚠️ Portal no reconocido:', datos.comercio);
  return {
    ok: false,
    sinPortal: true,
    msg: `Portal no reconocido para: ${datos.comercio || 'desconocido'}`,
  };
}

module.exports = { detectarYFacturar };

