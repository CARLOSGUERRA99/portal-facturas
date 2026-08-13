/**
 * action: goto
 * Navega a una URL y espera a que la red esté idle.
 *
 * Si Browserless no puede resolver el DNS, cae a un fallback via IP:
 * resuelve el hostname desde Node.js (Railway sí puede), luego navega
 * directo a la IP con CDP Security.setIgnoreCertificateErrors +
 * request interception para preservar el Host header (requerido por Cloudflare).
 *
 * Params: { url }
 */
const { lookup } = require('dns').promises;

async function goto(page, params) {
  const { url } = params;
  if (!url) throw new Error('[goto] url requerida');

  // Chrome HTTPS-First mode bloquea http:// con ERR_BLOCKED_BY_CLIENT
  let safeUrl = url.replace(/^http:\/\//, 'https://');

  // NexusFuel da un subdominio por marca, todo junto: gasmazfactura.,
  // redmaxfactura., petrofiguesfactura.… El OCR mete un punto de más al leerlo
  // ("gasmaz.factura.nexusfuel.mx") y ese host NO existe — el ticket #243 murió
  // dos veces con ERR_NAME_NOT_RESOLVED, que parece un portal caído cuando es
  // una letra mal leída. Se corrige aquí, en el engine, porque gasmaz corre por
  // el motor declarativo y NO por bots/gasmaz.js: puse el arreglo en el bot y
  // nunca llegó a ejecutarse.
  const corregido = safeUrl.replace(/([a-z0-9]+)\.factura\.nexusfuel\.mx/i, '$1factura.nexusfuel.mx');
  if (corregido !== safeUrl) {
    console.log(`[goto] 🔧 subdominio NexusFuel corregido: ${safeUrl} → ${corregido}`);
    safeUrl = corregido;
  }

  try {
    await page.goto(safeUrl, { waitUntil: 'load' });
    return;
  } catch (firstErr) {
    if (!firstErr.message.includes('ERR_NAME_NOT_RESOLVED')) throw firstErr;
    console.log(`[goto] DNS falló en Browserless (${safeUrl}) — intentando fallback via IP...`);
  }

  // Fallback: resolver IP desde Node.js y navegar directo al IP
  const { hostname } = new URL(safeUrl);
  let ip;
  try {
    const res = await lookup(hostname);
    ip = res.address;
    console.log(`[goto] ${hostname} → ${ip} (Node DNS)`);
  } catch (dnsErr) {
    throw new Error(`[goto] ERR_NAME_NOT_RESOLVED — Node tampoco resolvió "${hostname}": ${dnsErr.message}`);
  }

  // Deshabilitar validación SSL via CDP (funciona en runtime, sin flags de Chrome)
  const cdp = await page.createCDPSession();
  await cdp.send('Security.setIgnoreCertificateErrors', { ignore: true });

  // Interceptar todas las requests: reescribir hostname → IP, preservar Host header
  // para que Cloudflare enrute al vhost correcto
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    try {
      const u = new URL(req.url());
      if (u.hostname === hostname) {
        u.hostname = ip;
        req.continue({ url: u.toString(), headers: { ...req.headers(), host: hostname } });
      } else {
        req.continue();
      }
    } catch {
      req.continue();
    }
  });

  const ipUrl = new URL(safeUrl);
  ipUrl.hostname = ip;
  await page.goto(ipUrl.toString(), { waitUntil: 'load' });
}

module.exports = { goto };
