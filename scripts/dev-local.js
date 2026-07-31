// Arranque del servidor para desarrollo/verificación en local.
//
// Fija SIN_REDIS=1 (el Redis de Railway vive en la red privada y no es
// alcanzable desde fuera; en ese modo la sesión usa MemoryStore y las colas son
// no-op) y un puerto propio para no chocar con nada. NO usar en producción:
// Railway arranca con `npm start`, que corre server.js directamente y sí exige
// REDIS_URL.
const path = require('path');
const raiz = path.join(__dirname, '..');

// dotenv resuelve .env respecto al cwd, y este script puede lanzarse desde
// cualquier directorio (p. ej. desde el panel de preview). Se fija el cwd al
// del proyecto y se carga el .env por ruta absoluta.
process.chdir(raiz);
require('dotenv').config({ path: path.join(raiz, '.env') });

process.env.SIN_REDIS = '1';
process.env.PORT = process.env.PORT || '8097';
process.env.MANTENIMIENTO = 'false';
require(path.join(raiz, 'server.js'));
