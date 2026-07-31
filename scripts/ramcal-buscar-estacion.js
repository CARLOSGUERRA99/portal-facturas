// Localiza a QUÉ estación de RAMCAL pertenece un código de facturación.
//
// El portal corporativo (corporativoramcal.mx/facturacion/) solo LISTA las
// estaciones; el formulario real vive en el host de cada una
// ("{host}/bajatufactura/"). El ticket no dice cuál es, así que hay que
// preguntarle a cada estación. Se hace por HTTP plano (form POST normal, sin
// JavaScript) para no gastar sesiones de Browserless: probar un código en la
// estación equivocada es inocuo, solo responde que no existe.
//
// Uso: node scripts/ramcal-buscar-estacion.js 0201801651
const LISTA = 'https://www.corporativoramcal.mx/facturacion/';

async function conTimeout(url, opts = {}, ms = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

async function estacionesRamcal() {
  const r = await conTimeout(LISTA, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const html = await r.text();
  const urls = [...html.matchAll(/href=["']([^"']*bajatufactura[^"']*)["']/gi)].map((m) => m[1]);
  return [...new Set(urls)].map((u) => u.replace(/\/bajatufactura\/?$/, ''));
}

const RFC_GPN = process.env.RFC_GPN || 'GPR110128QD8';
const aTexto = (html) => html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

// El flujo por código son DOS pasos: primero se envía el RFC (form
// search_codigo, que solo lleva ese campo) y solo entonces el portal muestra
// el input codigo[]. Enviar el código de una sola vez responde siempre
// "El RFC introducido no es válido", que fue lo que despistó al primer sondeo.
async function probarCodigo(host, codigo) {
  const base = `${host}/bajatufactura/`;
  const g = await conTimeout(base, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const cookie = (g.headers.get('set-cookie') || '').split(';')[0];
  await g.text();
  const headers = {
    'User-Agent': 'Mozilla/5.0',
    'Content-Type': 'application/x-www-form-urlencoded',
    Cookie: cookie,
    Referer: base,
  };

  // Paso 1 — RFC
  const b1 = new URLSearchParams({ a: 'codigo', rfc: RFC_GPN, btn_submit_codigo: 'Aceptar' });
  const p1 = await conTimeout(`${host}/bajatufactura/index.php`, { method: 'POST', headers, body: b1, redirect: 'follow' }, 20000);
  const t1 = aTexto(await p1.text());
  if (/rfc.{0,30}no es v[aá]lido|no se encontr[oó].{0,20}rfc/i.test(t1)) {
    return { rfcOk: false, invalido: true, muestra: t1.slice(0, 160) };
  }

  // Paso 2 — seleccionar al cliente de la lista "CLIENTES ENCONTRADOS".
  // El enlace/ботón de "Seleccionar" lleva el id interno del cliente en la
  // estación, que hay que extraer del HTML devuelto en el paso 1.
  const html1 = t1;
  const idCliente = (html1.match(/cliente[^0-9]{0,10}(\d{2,10})/i) || [])[1] || null;
  const b2 = new URLSearchParams({ a: 'codigo', rfc: RFC_GPN, btn_submit_cli: 'Seleccionar' });
  if (idCliente) b2.append('id_cliente', idCliente);
  const p2 = await conTimeout(`${host}/bajatufactura/index.php`, { method: 'POST', headers, body: b2, redirect: 'follow' }, 20000);
  const t2 = aTexto(await p2.text());

  // Paso 3 — el código
  const b3 = new URLSearchParams({ a: 'codigo', rfc: RFC_GPN });
  b3.append('codigo[]', String(codigo));
  b3.append('btn_submit_nf', 'Aceptar');
  const p3 = await conTimeout(`${host}/bajatufactura/index.php`, { method: 'POST', headers, body: b3, redirect: 'follow' }, 20000);
  const t3 = aTexto(await p3.text());

  const importes = (t3.match(/\$\s*[\d,]+\.\d{2}/g) || []).filter((x) => !/0\.00$/.test(x));
  const invalido = importes.length === 0;
  const pistas = (t3.match(/(MAGNA|PREMIUM|DIESEL|Litros|Importe|Total)[^|]{0,35}/gi) || []).slice(0, 4);
  return { rfcOk: true, status: p3.status, invalido, importes, pistas, muestra: (t3 + ' ‖ paso2: ' + t2).slice(0, 300) };
}

(async () => {
  const codigo = process.argv[2];
  if (!codigo) { console.error('uso: node scripts/ramcal-buscar-estacion.js <codigo>'); process.exit(1); }

  const hosts = await estacionesRamcal();
  console.log(`🔎 ${hosts.length} estación(es) publicadas por RAMCAL. Probando el código ${codigo}…\n`);

  const encontradas = [];
  for (const h of hosts) {
    try {
      const r = await probarCodigo(h, codigo);
      const marca = r.invalido ? '·' : '✅';
      const nota = !r.rfcOk ? 'GPN no registrado en esta estación' : (r.invalido ? 'código no reconocido' : 'POSIBLE COINCIDENCIA');
      console.log(`${marca} ${h.padEnd(38)} ${nota}`);
      if (!r.invalido) {
        console.log(`   pistas: ${JSON.stringify(r.pistas)}`);
        console.log(`   ${r.muestra.slice(0, 200)}`);
        encontradas.push(h);
      }
    } catch (e) {
      console.log(`✖ ${h.padEnd(38)} error: ${e.message.slice(0, 50)}`);
    }
  }

  console.log(`\n=== ${encontradas.length} estación(es) candidata(s) ===`);
  encontradas.forEach((h) => console.log(`   ${h}/bajatufactura/`));
  process.exit(0);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
