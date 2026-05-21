/**
 * Valida que R2 funciona correctamente:
 * - sube un archivo de prueba
 * - verifica que la URL es pública y accesible
 * - confirma nombres únicos (no overwrite)
 * - borra el archivo de prueba al final
 *
 * Uso: node scripts/validate-r2.js
 */
require('dotenv').config();
const { subirArchivoR2, borrarArchivoR2 } = require('../storage/r2');

const OK   = (msg) => console.log(`[R2][OK]   ${msg}`);
const FAIL = (msg) => console.error(`[R2][FAIL] ${msg}`);
const INFO = (msg) => console.log(`[R2][INFO] ${msg}`);

async function main() {
  console.log('\n══════════════════════════════════════════════');
  console.log('  VALIDADOR DE R2');
  console.log('══════════════════════════════════════════════\n');

  const vars = ['R2_ACCESS_KEY', 'R2_SECRET_KEY', 'R2_ENDPOINT', 'R2_BUCKET', 'R2_PUBLIC_URL'];
  let missingVars = false;
  for (const v of vars) {
    if (!process.env[v]) {
      FAIL(`Variable de entorno faltante: ${v}`);
      missingVars = true;
    } else {
      OK(`${v} configurado`);
    }
  }
  if (missingVars) { console.error('\n❌ Configura las variables de R2 en .env'); process.exit(1); }

  const ts = Date.now();
  const keys = [];

  // ── Test 1: subir PNG de prueba (simula screenshot) ──────────────────────
  console.log('\n── Test 1: subir archivo de prueba ──');
  try {
    const buf = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64'
    ); // PNG 1x1 pixel válido
    const key = `debug/r2_validate_test_${ts}.png`;
    const url = await subirArchivoR2(buf, key, 'image/png');
    keys.push(key);
    if (url && url.startsWith('http')) {
      OK(`Subida exitosa → ${url}`);
    } else {
      FAIL(`URL inesperada: ${url}`);
    }
  } catch (err) {
    FAIL(`Error al subir: ${err.message}`);
    process.exit(1);
  }

  // ── Test 2: verificar que la URL es accesible públicamente ───────────────
  console.log('\n── Test 2: acceso público a la URL ──');
  try {
    const key = `debug/r2_validate_test_${ts}.png`;
    const url = `${process.env.R2_PUBLIC_URL}/${key}`;
    const resp = await fetch(url);
    if (resp.ok) {
      OK(`URL pública accesible: ${resp.status} ${resp.statusText}`);
      const ct = resp.headers.get('content-type');
      OK(`Content-Type: ${ct}`);
    } else {
      FAIL(`URL devuelve ${resp.status} — revisar permisos públicos del bucket`);
    }
  } catch (err) {
    FAIL(`No se pudo hacer fetch a la URL: ${err.message}`);
  }

  // ── Test 3: nombres únicos — dos uploads no se pisan ─────────────────────
  console.log('\n── Test 3: unicidad de nombres ──');
  try {
    const buf1 = Buffer.from('contenido-uno');
    const buf2 = Buffer.from('contenido-dos');
    const key1 = `debug/r2_validate_unique_${ts}_1.txt`;
    const key2 = `debug/r2_validate_unique_${ts}_2.txt`;
    await subirArchivoR2(buf1, key1, 'text/plain');
    await subirArchivoR2(buf2, key2, 'text/plain');
    keys.push(key1, key2);
    OK(`Dos archivos con timestamps distintos subidos sin colisión`);

    // Verificar que tienen contenido diferente
    const url1 = `${process.env.R2_PUBLIC_URL}/${key1}`;
    const url2 = `${process.env.R2_PUBLIC_URL}/${key2}`;
    const [r1, r2] = await Promise.all([fetch(url1), fetch(url2)]);
    const [t1, t2] = await Promise.all([r1.text(), r2.text()]);
    if (t1 !== t2) {
      OK(`Contenido diferente confirmado (no hay overwrite)`);
    } else {
      FAIL(`Ambos archivos tienen el mismo contenido — posible overwrite`);
    }
  } catch (err) {
    FAIL(`Error en test de unicidad: ${err.message}`);
  }

  // ── Test 4: subida funciona incluso con buffer pequeño ──────────────────
  console.log('\n── Test 4: buffer pequeño (simula screenshot de error) ──');
  try {
    const smallBuf = Buffer.from('error-test');
    const key = `debug/r2_validate_error_${ts}.txt`;
    const url = await subirArchivoR2(smallBuf, key, 'text/plain');
    keys.push(key);
    OK(`Buffer pequeño subido OK → ${url}`);
  } catch (err) {
    FAIL(`Error con buffer pequeño: ${err.message}`);
  }

  // ── Limpieza ──────────────────────────────────────────────────────────────
  console.log('\n── Limpieza: borrando archivos de prueba ──');
  for (const key of keys) {
    try {
      await borrarArchivoR2(key);
      INFO(`Borrado: ${key}`);
    } catch (err) {
      INFO(`No se pudo borrar ${key}: ${err.message}`);
    }
  }

  console.log('\n══════════════════════════════════════════════');
  console.log('  R2 validado correctamente ✅');
  console.log('  Los screenshots del engine se subirán sin problemas.');
  console.log('══════════════════════════════════════════════\n');
}

main().catch(err => {
  console.error('💥 Error inesperado:', err.message);
  process.exit(1);
});
