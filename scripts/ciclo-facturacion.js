// CICLO DE FACTURACIÓN — corre en bucle hasta que no quede nada que hacer.
//
// Cada vuelta hace, en este orden:
//   1. RECONCILIAR    — recoge los CFDI que llegaron por correo (muchos
//                       portales no descargan nada: mandan la factura por mail).
//   2. REINTENTAR     — vuelve a intentar los tickets que tienen bot.
//   3. AGENTE         — para los portales que NO tienen bot, lanza el agente de
//                       alta automática, de uno en uno.
//
// Por qué en ese orden: reconciliar primero evita reintentar tickets que ya
// están facturados y solo esperaban el correo. Y el agente va al final porque
// es lo más lento (15-40 min por portal) y lo más caro.
//
// El bucle PARA solo cuando una vuelta completa no cambia nada — no cuando
// "todo está facturado", porque hay casos que nunca se van a poder cerrar solos
// (CAPTCHA, ventana vencida, foto ilegible). Insistir en esos es quemar dinero.
//
// Uso:
//   node scripts/ciclo-facturacion.js              → hasta 6 vueltas
//   VUELTAS=3 node scripts/ciclo-facturacion.js
//   SIN_AGENTE=1 node scripts/ciclo-facturacion.js → sin el agente (rápido)
require('dotenv').config();
const { execFileSync } = require('child_process');
const path = require('path');
const db = require('../lib/db');

const VUELTAS = parseInt(process.env.VUELTAS || '6', 10);
const SIN_AGENTE = process.env.SIN_AGENTE === '1';
const RAIZ = path.join(__dirname, '..');
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// Errores en los que insistir NO sirve: el problema es el dato, el plazo o el
// portal, no una falla pasajera.
const IRRECUPERABLE = /captcha|cloudflare|duplicad|72 hora|venci|plazo|ya (fue|est[aá]) (timbrad|facturad)|no lo reconoce NINGUNA|ilegible|no extrajo|no se pudo leer|reserva|ya capturado|sin portal|no automatizable/i;

function correr(script, args = [], minutos = 12) {
  try {
    const salida = execFileSync(process.execPath, [path.join(RAIZ, 'scripts', script), ...args], {
      cwd: RAIZ, encoding: 'utf8', timeout: minutos * 60 * 1000,
      env: { ...process.env, SIN_REDIS: '1' },
      maxBuffer: 40 * 1024 * 1024,
    });
    return { ok: true, salida };
  } catch (e) {
    return { ok: false, salida: (e.stdout || '') + (e.stderr || ''), error: e.message };
  }
}

async function foto() {
  const [[c]] = await db.query(`
    SELECT
      (SELECT COUNT(*) FROM facturas WHERE xml_url IS NOT NULL) AS cfdi,
      (SELECT COUNT(*) FROM tickets t LEFT JOIN facturas f ON f.ticket_id=t.id
        WHERE f.id IS NULL AND t.status <> 'procesado') AS pendientes`);
  return c;
}

// Tickets que aún pueden avanzar: sin factura y sin un motivo irrecuperable.
async function accionables() {
  const [r] = await db.query(`
    SELECT t.id, t.comercio, t.status, t.error_msg, t.portal_url, t.ocr_json
      FROM tickets t LEFT JOIN facturas f ON f.ticket_id = t.id
     WHERE f.id IS NULL AND t.status <> 'procesado'
     ORDER BY t.id`);
  return r.filter((t) => !IRRECUPERABLE.test(String(t.error_msg || '')));
}

(async () => {
  console.log(`🔁 Ciclo de facturación — hasta ${VUELTAS} vuelta(s)${SIN_AGENTE ? ' (sin agente)' : ''}\n`);
  const inicio = await foto();
  console.log(`   punto de partida: ${inicio.cfdi} CFDI · ${inicio.pendientes} pendientes\n`);

  for (let vuelta = 1; vuelta <= VUELTAS; vuelta++) {
    const antes = await foto();
    console.log(`${'═'.repeat(64)}\n VUELTA ${vuelta}/${VUELTAS}  —  ${antes.cfdi} CFDI · ${antes.pendientes} pendientes\n${'═'.repeat(64)}`);

    // 1) Reconciliar el correo
    console.log('\n📧 [1/3] Reconciliando CFDI recibidos por correo…');
    const rec = correr('reconciliar-correo.js', [], 7);
    const nRec = (rec.salida.match(/=== (\d+) factura/) || [])[1] || '0';
    console.log(`   → ${nRec} factura(s) reconciliada(s)`);

    // 2) Reintentar lo que tiene bot
    const lista = await accionables();
    console.log(`\n🤖 [2/3] Reintentando ${lista.length} ticket(s) accionable(s)…`);
    if (lista.length) {
      const ids = lista.map((t) => String(t.id));
      const re = correr('reintentar-todos.js', ids, 45);
      const resumen = (re.salida.match(/✅ facturados: \d+.*$/m) || ['(sin resumen)'])[0];
      console.log(`   → ${resumen}`);
    }

    // 3) El agente, para portales sin bot
    if (!SIN_AGENTE) {
      const sinBot = (await accionables()).filter((t) => /portal nuevo|no reconocido|Agente/i.test(String(t.error_msg || '')));
      // Uno por PORTAL, no por ticket: dar de alta el portal resuelve todos sus
      // tickets de golpe, y correr el agente varias veces sobre el mismo sitio
      // es tirar 15-40 minutos por la ventana en cada repetición.
      const porPortal = new Map();
      for (const t of sinBot) {
        const clave = String(t.portal_url || t.comercio || t.id).toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
        if (!porPortal.has(clave)) porPortal.set(clave, t);
      }
      console.log(`\n🧠 [3/3] Agente: ${porPortal.size} portal(es) distinto(s) sin bot`);
      for (const [clave, t] of porPortal) {
        console.log(`   ▸ ${clave} (ticket #${t.id})`);
        const ag = correr('agente-portal.js', [String(t.id)], 40);
        const linea = (ag.salida.match(/^(✅|❌|⚠️).*$/m) || [ag.error || '(sin salida)'])[0];
        console.log(`     ${String(linea).slice(0, 150)}`);
        await dormir(5000);
      }
    }

    const despues = await foto();
    const ganancia = despues.cfdi - antes.cfdi;
    console.log(`\n📊 vuelta ${vuelta}: ${ganancia >= 0 ? '+' : ''}${ganancia} CFDI · quedan ${despues.pendientes} pendientes`);

    if (ganancia === 0 && despues.pendientes === antes.pendientes) {
      console.log('\n⏹️ Una vuelta completa sin cambios — no tiene sentido seguir insistiendo.');
      break;
    }
    await dormir(10000);
  }

  const fin = await foto();
  console.log(`\n${'█'.repeat(64)}`);
  console.log(`RESULTADO: ${inicio.cfdi} → ${fin.cfdi} CFDI  (+${fin.cfdi - inicio.cfdi})`);
  console.log(`Pendientes: ${inicio.pendientes} → ${fin.pendientes}`);

  const quedan = await accionables();
  if (quedan.length) {
    console.log(`\nSiguen siendo accionables (${quedan.length}):`);
    quedan.forEach((t) => console.log(`  #${t.id} ${String(t.comercio).slice(0, 38).padEnd(39)}${String(t.error_msg || '').slice(0, 60)}`));
  }
  console.log('█'.repeat(64));
  process.exit(0);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
