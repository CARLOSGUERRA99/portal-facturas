const mysql = require("mysql2/promise");
(async () => {
  const conn = await mysql.createConnection({
    host: "yamanote.proxy.rlwy.net", user: "root",
    password: "jynqkMxSAsopdErnUIejloYGYpbUmDSW",
    port: 13642, database: "railway", connectTimeout: 15000,
  });
  const [lc] = await conn.query(`
    SELECT id, comercio, status, creado, error_msg, ocr_json, ruta_archivo
    FROM tickets WHERE comercio LIKE '%ittle%' OR comercio LIKE '%aesars%' OR portal_url LIKE '%analytix%'
    ORDER BY id DESC LIMIT 20`);
  console.log("LITTLE CAESARS:", JSON.stringify(lc, null, 1));
  const [pend] = await conn.query(`
    SELECT id, comercio, status, creado, LEFT(error_msg,160) err
    FROM tickets WHERE status IN ('pendiente','error','procesando','procesando_correo')
    ORDER BY id DESC LIMIT 40`);
  console.log("PENDIENTES/ERROR:", JSON.stringify(pend, null, 1));
  await conn.end();
})().catch(e => { console.error("FALLO:", e.message); process.exit(1); });
