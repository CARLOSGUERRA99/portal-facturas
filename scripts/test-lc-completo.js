// Corre el bot completo de Little Caesars (paso 1 + CapSolver + paso 2 fiscal)
// contra el portal real, vía Browserless. Factura de verdad el ticket dado.
//
// Uso: BROWSERLESS_TOKEN=... CAPSOLVER_API_KEY=... node scripts/test-lc-completo.js
const { facturarLittleCaesars } = require("../bots/littlecaesars");

(async () => {
  const r = await facturarLittleCaesars({
    // Ticket #218 (real, pendiente de facturar)
    tienda: "04123-00053",
    ticketNumero: "1099376",
    fecha: "04/08/2026",
    total: 875,
    // Perfil fiscal de GPN (user_id 1)
    rfc: "GPR110128QD8",
    razonSocial: "GPN PINTURAS Y RECUBRIMIENTOS",
    regimenFiscal: "601",
    codigoPostal: "80140",
    usoCfdi: "G03",
    email: "carlosguerra@grupogpn.com",
    ticketId: 218,
  });
  console.log("\n=== RESULTADO ===");
  console.log(JSON.stringify(r, null, 2));
})().catch((e) => { console.error("ERROR FATAL:", e); process.exit(1); });
