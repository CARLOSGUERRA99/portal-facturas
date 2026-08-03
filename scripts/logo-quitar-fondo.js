// Quita el fondo de un logo y lo deja como PNG transparente, usando el canvas
// de un navegador remoto (Browserless) en vez de una librería de imágenes.
//
// Por qué así y no con sharp: meter un binario nativo en Railway sube el peso
// de la imagen y la RAM, que es justo lo que estamos bajando. El navegador ya
// trae decodificador de JPEG/PNG y canvas.
//
// El truco del CORS: si se navega DIRECTAMENTE a la URL de la imagen, el
// documento ES la imagen, así que el <img> del visor es del mismo origen y
// getImageData() funciona. Intentar cargar la imagen de R2 desde otra página
// falla con "Failed to fetch": el bucket público no manda cabeceras CORS.
//
// El algoritmo es el mismo que quitarFondoLogo() de public/notificaciones.js:
// el fondo se deduce del color medio de las CUATRO ESQUINAS —no se asume
// blanco, porque muchos logos vienen sobre gris claro o crema— y el borde se
// desvanece con alfa progresivo para que no quede serrado sobre el guinda.
//
// Uso:
//   node scripts/logo-quitar-fondo.js <url-de-la-imagen> [clienteId] [tolerancia]
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const puppeteer = require('puppeteer');
const db = require('../lib/db');
const { subirArchivoR2 } = require('../storage/r2');

const fs = require('fs');
const ORIGEN = process.argv[2];   // ruta local o URL
const CLIENTE = process.argv[3] ? Number(process.argv[3]) : null;
const TOL = process.argv[4] ? Number(process.argv[4]) : 40;

(async () => {
  if (!ORIGEN) { console.error('uso: node scripts/logo-quitar-fondo.js <archivo|url> [clienteId] [tolerancia]'); process.exit(1); }

  // La imagen se inyecta en la página como data URL en vez de navegar a ella.
  // Dos motivos: navegar al bucket de R2 daba ERR_ABORTED desde Browserless, y
  // así la imagen es del MISMO ORIGEN que el documento (about:blank), que es lo
  // que necesita getImageData() para no fallar por canvas "tainted".
  let dataUrl;
  if (/^https?:\/\//i.test(ORIGEN)) {
    const resp = await fetch(ORIGEN);
    if (!resp.ok) throw new Error(`no se pudo descargar (${resp.status})`);
    const tipo = resp.headers.get('content-type') || 'image/jpeg';
    dataUrl = `data:${tipo};base64,${Buffer.from(await resp.arrayBuffer()).toString('base64')}`;
  } else {
    const ext = (ORIGEN.split('.').pop() || 'jpg').toLowerCase();
    const tipo = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    dataUrl = `data:${tipo};base64,${fs.readFileSync(ORIGEN).toString('base64')}`;
  }

  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_TOKEN}&stealth=true`,
  });
  const page = await browser.newPage();
  await page.setContent(`<body style="margin:0"><img id="src" src="${dataUrl}"></body>`);
  await page.waitForFunction(() => { const i = document.getElementById('src'); return i && i.complete && i.naturalWidth > 0; }, { timeout: 30000 });

  const r = await page.evaluate((tol) => {
    const img = document.getElementById('src');
    if (!img) return { error: 'no se pudo inyectar la imagen' };

    const lado = Math.min(512, Math.max(img.naturalWidth, img.naturalHeight));
    const esc = lado / Math.max(img.naturalWidth, img.naturalHeight);
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * esc);
    c.height = Math.round(img.naturalHeight * esc);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, c.width, c.height);

    const d = ctx.getImageData(0, 0, c.width, c.height);
    const p = d.data;
    // ⚠️ El fondo se decide por el color MÁS FRECUENTE del borde, no por la
    // media de las cuatro esquinas.
    //
    // Con la media, basta que una esquina tenga ruido de compresión JPEG para
    // arrastrar el resultado. Medido con el logo de DGA: las esquinas daban
    // rgb(186,186,186) —un gris que no está en la imagen— y con tolerancia 40
    // el blanco real quedaba a distancia 119, así que NO se recortó ni un píxel.
    //
    // La moda del borde ignora esos píxeles raros: si el 90% del marco es
    // blanco, el fondo es blanco por mucho que una esquina esté sucia.
    const px = (x, y) => { const i = (y * c.width + x) * 4; return [p[i], p[i + 1], p[i + 2]]; };
    const cuenta = new Map();
    const anota = (rgb) => {
      // Cuantizado a bloques de 8 para que los tonos casi iguales cuenten juntos.
      const k = rgb.map(v => Math.round(v / 8) * 8).join(',');
      cuenta.set(k, (cuenta.get(k) || 0) + 1);
    };
    // ⚠️ El anillo se muestrea METIDO HACIA DENTRO, no en el píxel del borde.
    //
    // Medido con el logo de DGA: el JPG trae un marco fino de rgb(144,144,144)
    // alrededor de un fondo que en realidad es blanco (254). Muestreando el
    // borde exacto, la moda daba el gris del marco y no se recortaba nada.
    // Con un margen del 3% se salta el marco y aparece el fondo de verdad.
    const m = Math.max(3, Math.round(Math.min(c.width, c.height) * 0.03));
    for (let x = m; x < c.width - m; x++) { anota(px(x, m)); anota(px(x, c.height - 1 - m)); }
    for (let y = m; y < c.height - m; y++) { anota(px(m, y)); anota(px(c.width - 1 - m, y)); }
    const dominante = [...cuenta.entries()].sort((a, b) => b[1] - a[1])[0];
    const fondo = dominante[0].split(',').map(Number);
    const cuotaBorde = dominante[1] / (2 * (c.width + c.height - 4*m));

    let transp = 0;
    for (let i = 0; i < p.length; i += 4) {
      const dist = Math.sqrt((p[i] - fondo[0]) ** 2 + (p[i + 1] - fondo[1]) ** 2 + (p[i + 2] - fondo[2]) ** 2);
      if (dist < tol) { p[i + 3] = 0; transp++; }
      else if (dist < tol * 2) p[i + 3] = Math.round(255 * (dist - tol) / tol);
    }
    ctx.putImageData(d, 0, 0);
    return {
      png: c.toDataURL('image/png'),
      tam: `${c.width}x${c.height}`,
      fondo: fondo.map(Math.round),
      pctTransparente: Math.round(transp / (c.width * c.height) * 100),
      cuotaBorde: Math.round(cuotaBorde * 100),
    };
  }, TOL);

  await browser.close();
  if (r.error) { console.error('❌', r.error); process.exit(1); }

  console.log(`   tamaño: ${r.tam} · fondo detectado rgb(${r.fondo.join(',')}) · ${r.pctTransparente}% transparente`);
  // Un logo cuyo fondo no llega al 15% probablemente no tenía fondo uniforme:
  // mejor avisar que subir algo con un marco sucio.
  if (r.pctTransparente < 15) console.log('   ⚠️ se recortó poco fondo — revisa el resultado o sube la tolerancia');

  const buf = Buffer.from(r.png.replace(/^data:image\/png;base64,/, ''), 'base64');
  const url = await subirArchivoR2(buf, `marca/cliente-${CLIENTE || 'x'}-${Date.now()}.png`, 'image/png');
  console.log(`   PNG: ${Math.round(buf.length / 1024)}KB → ${url}`);

  if (CLIENTE) {
    await db.query('UPDATE clientes SET marca_logo = ? WHERE id = ?', [url, CLIENTE]);
    const [[c]] = await db.query('SELECT nombre, marca_logo FROM clientes WHERE id = ?', [CLIENTE]);
    console.log(`   ✅ asignado a "${c.nombre}"`);
  }
  process.exit(0);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
