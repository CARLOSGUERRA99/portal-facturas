// Descarga el documento de un código ya capturado en CAPUFE.
//
// El endpoint lo descubrió la sonda de recuperación:
//   GET /capufe-quadrum-backend/sinregistro/documentos/descargar_codigo_alfanumerico.json?codigo=XXX
//
// Devolvía cuerpo vacío al leerlo con resp.text() de Puppeteer, que es lo que
// pasa con las descargas binarias. Aquí se pide desde DENTRO de la página —para
// heredar la sesión de invitado— y se mira qué llega de verdad: cabeceras,
// tamaño y los primeros bytes, que bastan para saber si es un ZIP, un PDF, un
// XML o un JSON de error.
//
// Contexto: el ticket #199 de DGA quedó "capturado" sin completar la emisión.
// Si aquí aparece un CFDI, la factura SÍ se generó y solo hay que recogerla.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const CODIGO = (process.argv[2] || 'K8KPKTZBHKSF7WMVHQ').replace(/\s+/g, '').toUpperCase();

(async () => {
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}&stealth=true`,
  });
  const page = await browser.newPage();
  await page.goto('https://facturacioncapufe.com.mx/Capufe/facturacionrapida', { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(2500);   // deja que corra autenticar_invitado

  const r = await page.evaluate(async (cod) => {
    const url = `/capufe-quadrum-backend/sinregistro/documentos/descargar_codigo_alfanumerico.json?codigo=${cod}`;
    const resp = await fetch(url, { credentials: 'include' });
    const buf = new Uint8Array(await resp.arrayBuffer());
    const cabeceras = {};
    resp.headers.forEach((v, k) => { cabeceras[k] = v; });
    // Los primeros bytes delatan el formato: PK=zip, %PDF=pdf, <?xml / < = xml.
    const cabeza = Array.from(buf.slice(0, 8)).map(b => String.fromCharCode(b)).join('');
    return {
      status: resp.status,
      cabeceras,
      bytes: buf.length,
      cabeza,
      // Si es texto, se devuelve para poder leer el error.
      texto: buf.length < 4000 ? new TextDecoder().decode(buf) : null,
      base64: buf.length && buf.length < 3e6 ? btoa(String.fromCharCode(...buf)) : null,
    };
  }, CODIGO);

  console.log(`status ${r.status} · ${r.bytes} bytes · empieza por ${JSON.stringify(r.cabeza)}`);
  console.log('content-type:', r.cabeceras['content-type'] || '(sin)');
  if (r.texto) console.log('cuerpo:', r.texto.slice(0, 600));

  if (r.base64 && r.bytes > 100) {
    const dir = path.join(__dirname, '..', 'pruebas');
    fs.mkdirSync(dir, { recursive: true });
    const ext = r.cabeza.startsWith('PK') ? 'zip' : r.cabeza.startsWith('%PDF') ? 'pdf' : r.cabeza.includes('<') ? 'xml' : 'bin';
    const destino = path.join(dir, `capufe_${CODIGO}.${ext}`);
    fs.writeFileSync(destino, Buffer.from(r.base64, 'base64'));
    console.log(`💾 guardado en ${destino}`);
  }

  await browser.close();
  process.exit(0);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
