// Respaldo de la base de datos a R2 (FASE 1, plan B de backups).
// Vuelca TODAS las tablas a un JSON comprimido (gzip) y lo sube a R2 bajo
// backups/db_YYYY-MM-DD_HHmm.json.gz. Conserva los últimos 14 respaldos.
// Corre diario en el worker; también ejecutable a mano: node -e "require('./lib/backup-db').respaldarBaseDatos()"
//
// Nota: esto NO sustituye los backups de volumen de Railway (que respaldan
// binarios de MySQL) — es una capa extra restaurable a mano tabla por tabla.
const zlib = require("zlib");
const crypto = require("crypto");
const db = require("./db");
const { subirArchivoR2, borrarArchivoR2, listarArchivosR2 } = require("../storage/r2");

const RETENER = 14;

async function respaldarBaseDatos() {
  const inicio = Date.now();
  const [tablas] = await db.query("SHOW TABLES");
  const nombres = tablas.map(t => Object.values(t)[0]);

  const dump = { creado: new Date().toISOString(), tablas: {} };
  for (const tabla of nombres) {
    const [filas] = await db.query(`SELECT * FROM \`${tabla}\``);
    dump.tablas[tabla] = filas;
  }

  const json = JSON.stringify(dump);
  const gz = zlib.gzipSync(Buffer.from(json, "utf8"));
  // El bucket R2 es PÚBLICO (sin listado público, pero cualquier key adivinable
  // se puede descargar). El dump contiene datos fiscales y hashes de contraseña:
  // el sufijo aleatorio hace la URL impredecible. Pendiente (brechas): mover
  // backups a un bucket privado.
  const stamp = new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "");
  const rand = crypto.randomBytes(16).toString("hex");
  const key = `backups/db_${stamp}_${rand}.json.gz`;
  const url = await subirArchivoR2(gz, key, "application/gzip");
  if (!url) throw new Error("No se pudo subir el respaldo a R2");

  console.log(`💾 Respaldo DB: ${nombres.length} tablas, ${(json.length / 1024).toFixed(0)} KB → ${(gz.length / 1024).toFixed(0)} KB gz, ${Date.now() - inicio}ms → ${key}`);

  // Retención: borrar respaldos viejos (conservar los RETENER más recientes)
  try {
    const archivos = (await listarArchivosR2("backups/db_", 100))
      .sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
    for (const viejo of archivos.slice(RETENER)) {
      await borrarArchivoR2(viejo.key);
      console.log(`🗑️ Respaldo viejo eliminado: ${viejo.key}`);
    }
  } catch (e) {
    console.log("⚠️ Retención de respaldos:", e.message);
  }

  return { key, url, tablas: nombres.length, bytes: gz.length };
}

module.exports = { respaldarBaseDatos };
