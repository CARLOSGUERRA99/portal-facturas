// Prueba del bot Little Caesars contra un ticket real de la BD.
//
// Uso:
//   PUPPETEER_LOCAL=1 node scripts/test-littlecaesars.js 227
//   (sin CAPSOLVER_API_KEY valida todo el flujo hasta el captcha y devuelve
//    el dosier; con la key intenta facturar de verdad)
//
// En producción (Railway) se quita PUPPETEER_LOCAL y el bot usa Browserless.
const mysql = require("mysql2/promise");
const { facturarLittleCaesars } = require("../bots/littlecaesars");

(async () => {
  const ticketId = Number(process.argv[2] || 227);

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || "yamanote.proxy.rlwy.net",
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "jynqkMxSAsopdErnUIejloYGYpbUmDSW",
    port: Number(process.env.DB_PORT || 13642),
    database: process.env.DB_DATABASE || "railway",
    connectTimeout: 15000,
  });
  const [rows] = await conn.query("SELECT ocr_json FROM tickets WHERE id = ?", [ticketId]);
  await conn.end();
  if (!rows.length) { console.error(`ticket #${ticketId} no existe`); process.exit(1); }

  const ocr = JSON.parse(rows[0].ocr_json);
  console.log(`🎫 Ticket #${ticketId}:`, JSON.stringify(ocr));

  const resultado = await facturarLittleCaesars({
    folio: ocr.folio,
    ticketNumero: ocr.ticketNumero,
    tienda: ocr.tienda,
    fecha: ocr.fecha,
    total: ocr.total,
    rfc: "GPR110128QD8", // RFC receptor de GPN (el que usa el router)
    ticketId,
  });

  console.log("🏁 RESULTADO:", JSON.stringify(resultado, null, 2));
  process.exit(resultado.ok ? 0 : 2);
})().catch((e) => { console.error("💥", e); process.exit(1); });
