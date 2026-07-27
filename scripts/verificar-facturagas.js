require('dotenv').config();
const fs = require('fs');
const { esperarFacturaPorCorreo, extraerTotalCFDI } = require('../mail/imap');
const { extraerUUIDcfdi } = require('../lib/util');
const { subirArchivoR2 } = require('../storage/r2');
const db = require('../lib/db');

(async () => {
  const r = await esperarFacturaPorCorreo('2025730', 5000, 'Suministros Energeticos', 1500).catch(() => null);
  if (!r || !r.xmlBuffer) {
    console.log('No hay correo nuevo sin leer (ya se marcó leído en la corrida anterior) — esto es normal, ya se extrajo.');
    process.exit(0);
  }
  fs.writeFileSync('C:/Users/carlo/AppData/Local/Temp/claude/C--Users-carlo/bd061180-d7e6-4587-97d7-6edd69b553bc/scratchpad/facturagas.xml', r.xmlBuffer);
  if (r.pdfBuffer) fs.writeFileSync('C:/Users/carlo/AppData/Local/Temp/claude/C--Users-carlo/bd061180-d7e6-4587-97d7-6edd69b553bc/scratchpad/facturagas.pdf', r.pdfBuffer);
  const uuid = extraerUUIDcfdi(r.xmlBuffer);
  const total = extraerTotalCFDI(r.xmlBuffer);
  console.log('UUID:', uuid, '| Total:', total);
  process.exit(0);
})();
