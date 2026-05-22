/**
 * action: goto
 * Navega a una URL y espera a que la red esté idle.
 * Si Browserless no puede resolver el DNS, cae a un fallback via IP:
 * resuelve el hostname desde Node.js y navega directo a la IP con
 * CDP Security.setIgnoreCertificateErrors + request interception.
 *
 * Params: { url }
 */
const { lookup } = require('dns').promises;

async function goto(page, params) {
  const { url } = params;
  if (!url) throw new Error('[goto] url requerida');

  try {
    await page.goto(url, { waitUntil: 'networkidle2' });
    return;
  } catch (firstErr) {
    if (!firstErr.message.includes('ERR_NAME_NOT_RESOLVED')) throw firstErr;
    console.log('[goto] DNS falló en Browserless — intentando fallback via IP...');
  }

  // Fallback: resolver IP desde Node (Railway sí puede) y navegar directo
  const parsed = new URL(url);
  const hostname = parsed.hostname;
  let ip;
  try {
    const res = await lookup(hostname);
    ip = res.address;
    console.log(`[goto] ${hostname} → ${ip} (Node DNS)`);
  } catch (dnsErr) {
    throw new Error(`[goto] ERR_NAME_NOT_RESOLVED — también falló desde Node: ${dnsErr.message}`);
  }

  // Deshabilitar validación SSL via CDP (funciona en runtime, sin flags de Chrome)
  const cdp = await page.createCDPSession();
  await cdp.send('Security.setIgnoreCertificateErrors', { ignore: true });

  // Interceptar TODAS las requests: reescribir hostname → IP, preservar Host header
  // para que el servidor (Cloudflare) entienda qué vhost servir
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

  parsed.hostname = ip;
  await page.goto(parsed.toString(), { waitUntil: 'networkidle2' });
}

module.exports = { goto };
