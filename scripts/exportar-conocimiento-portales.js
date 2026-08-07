// Exporta TODO lo que el sistema sabe de cada portal a un JSON + un Markdown.
//
// ⚠️ POR QUÉ SE LEE EL REPO Y NO EL HISTORIAL DE CHAT.
//
// La idea original era mandarle un prompt a la API de Claude para que
// "revisara nuestras conversaciones" y volcara el conocimiento. Eso no puede
// funcionar: la API es SIN ESTADO. Cada llamada empieza en blanco y no ve
// ninguna conversación anterior. El modelo no diría "no lo sé": rellenaría los
// huecos con selectores plausibles inventados, y esos selectores acabarían en
// una base de datos de portales pareciendo reales. Para un sistema que emite
// CFDI —donde un dato mal puede quemar un folio o timbrar a otro RFC— eso es
// peor que no tener nada.
//
// El conocimiento real está aquí, y es verificable:
//   portales/portales.json   → detección, tecnología, estado, notas
//   bots/*.js                → la cabecera de cada bot documenta el
//                              reconocimiento REAL, con selectores medidos en
//                              vivo, y el cuerpo tiene los selectores de verdad
//   lib/vision.js            → qué campos pide cada portal (promptsPorPortal)
//   lib/util.js              → PORTALES_FACTURABLES, el gate de la cola
//   BD                       → altas del agente y estadísticas de intentos
//
// Uso:
//   node scripts/exportar-conocimiento-portales.js
//   node scripts/exportar-conocimiento-portales.js --con-codigo   (incluye los bots enteros)
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const CON_CODIGO = process.argv.includes('--con-codigo');
const SALIDA = path.join(RAIZ, 'docs');

const leer = (p) => { try { return fs.readFileSync(path.join(RAIZ, p), 'utf8'); } catch { return ''; } };

// ── Cabecera de un bot: los comentarios de arriba del todo ───────────────────
// Es donde vive el reconocimiento real de cada portal — lo que se midió en vivo
// y por qué. Vale más que el código: el código dice QUÉ hace, la cabecera dice
// POR QUÉ y qué se intentó antes que no funcionaba.
function cabeceraDelBot(src) {
  const lineas = [];
  for (const l of src.split('\n')) {
    const t = l.trim();
    if (t.startsWith('//')) lineas.push(t.replace(/^\/\/\s?/, ''));
    else if (t.startsWith('/*') || t.startsWith('*') || t.startsWith('*/')) lineas.push(t.replace(/^\/?\*+\/?\s?/, ''));
    else if (t === '') { if (lineas.length) break; }
    else break;
  }
  return lineas.join('\n').trim();
}

// Saca los selectores CSS que el bot usa de verdad, no los que uno supondría.
function selectoresDelBot(src) {
  const encontrados = new Set();
  const patrones = [
    /(?:querySelector(?:All)?|waitForSelector|\$\$?)\(\s*["'`]([^"'`]{2,90})["'`]/g,
    /page\.(?:click|type|select|focus)\(\s*["'`]([^"'`]{2,90})["'`]/g,
  ];
  for (const re of patrones) {
    let m;
    while ((m = re.exec(src)) !== null) encontrados.add(m[1]);
  }
  return [...encontrados];
}

// Clasifica un selector por el campo al que corresponde, mirando cómo se llama.
function mapearSelectores(sels, src) {
  const buscar = (re) => sels.find((s) => re.test(s)) || null;
  return {
    input_folio: buscar(/folio|codigo|barcode|ticket|referencia|unicCode/i),
    input_fecha: buscar(/fecha|date|calendar/i),
    input_total: buscar(/total|monto|importe|mat-input-1/i),
    input_rfc: buscar(/rfc/i),
    input_correo: buscar(/correo|email/i),
    input_cp: buscar(/codigo?Postal|domicilioFiscal|\bcp\b/i),
    input_regimen_fiscal: buscar(/regimen/i),
    input_uso_cfdi: buscar(/usoCfdi|uso_cfdi|selectUsoCfdi|CFDI/i),
    input_forma_pago: buscar(/formaPago|forma_pago/i),
    boton_facturar: /facturar conceptos/i.test(src) ? 'button[texto="Facturar conceptos"]'
      : buscar(/btn_facturar|generarFactura|submit/i),
    boton_descargar_xml: buscar(/xml/i),
    boton_descargar_pdf: buscar(/pdf/i),
    modal_exito: buscar(/exito|success|p-dialog|modal/i),
    modal_error: buscar(/error|alert/i),
    modal_ya_facturado: /ya.*facturad|ya se encuentra capturado/i.test(src) ? '(detectado por TEXTO en el body, no por selector)' : null,
  };
}

// ¿El portal pide CAPTCHA? Solo cuenta la evidencia de USO, nunca la mención.
function detectarCaptcha(src, p) {
  const notas = p.notas_desarrollo || '';
  // Una negación explícita del reconocimiento gana sobre cualquier heurística:
  // es alguien que fue a mirar y lo escribió.
  if (/NO hay CAPTCHA|sin captcha|no tiene captcha/i.test(src + notas))
    return { tiene_captcha: false, tipo_captcha: 'ninguno', captcha_evidencia: 'el reconocimiento dice explícitamente que no hay' };

  // Evidencia dura, en orden de fiabilidad.
  const pruebas = [
    [/AntiTurnstileTaskProxyLess/, 'Cloudflare Turnstile', 'resuelto con CapSolver (AntiTurnstileTaskProxyLess)'],
    [/ImageToTextTask/, 'imagen', 'resuelto con CapSolver (ImageToTextTask)'],
    [/["'`]\.g-recaptcha|iframe\[src\*=["']recaptcha/, 'reCAPTCHA', 'se consulta el widget en el DOM'],
    [/["'`]\.cf-turnstile/, 'Cloudflare Turnstile', 'se consulta el widget en el DOM'],
    [/RadCaptcha/, 'Telerik RadCaptcha', 'widget de Telerik en el DOM'],
    [/error_code:\s*["']captcha["']/, 'sin determinar', 'el bot devuelve error_code captcha'],
  ];
  for (const [re, tipo, evidencia] of pruebas)
    if (re.test(src)) return { tiene_captcha: true, tipo_captcha: tipo, captcha_evidencia: evidencia };

  // Las notas del portal, si lo afirman en positivo.
  const m = notas.match(/(reCAPTCHA(?:\s*v\d)?|Turnstile|RadCaptcha|CAPTCHA de imagen)/i);
  if (m && !/sin |no /i.test(notas.slice(Math.max(0, notas.indexOf(m[0]) - 12), notas.indexOf(m[0]))))
    return { tiene_captcha: true, tipo_captcha: m[0], captcha_evidencia: 'declarado en las notas del portal' };

  return { tiene_captcha: false, tipo_captcha: 'ninguno', captcha_evidencia: 'sin evidencia de uso' };
}

// Los mensajes del portal que el bot reconoce. Son oro: distinguen un fallo
// real de un "ya estaba hecho" y de un "el dato es inválido".
function mensajesDetectados(src) {
  const saca = (re) => { const m = src.match(re); return m ? m[0].replace(/\\\//g, '/') : null; };
  return {
    mensaje_exito: saca(/\/[^/\n]*(?:exito|éxito|generad|emitid|se ha enviado|correctamente)[^/\n]*\/[gimsuy]*/i),
    mensaje_ya_facturado: saca(/\/[^/\n]*(?:ya.{0,12}factur|ya se encuentra capturado|previamente)[^/\n]*\/[gimsuy]*/i),
    mensaje_ticket_invalido: saca(/\/[^/\n]*(?:no se encontr|no existe|inv[aá]lid|incorrect)[^/\n]*\/[gimsuy]*/i),
  };
}

// Los campos que el OCR extrae para ese portal = los que el portal pide.
function camposDelPrompt(vision, slug) {
  const re = new RegExp(`^\\s*["']?${slug}["']?:\\s*\\[([^\\]]*)\\]`, 'm');
  const m = vision.match(re);
  if (!m) return [];
  return m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
}

(async () => {
  const portales = JSON.parse(leer('portales/portales.json')).portales || {};
  const vision = leer('lib/vision.js');
  const util = leer('lib/util.js');
  const indexBots = leer('bots/index.js');

  // Estado real desde la BD (si hay conexión). Sin ella el export sigue
  // funcionando: es información que enriquece, no que hace falta.
  let agente = [], intentos = {};
  try {
    const db = require('../lib/db');
    [agente] = await db.query('SELECT comercio, estado, intentos_correccion, creado FROM portales_agente');
    const [st] = await db.query(
      `SELECT bot, COUNT(*) n, SUM(resultado='ok') ok, ROUND(AVG(duracion_ms)/1000,1) seg
         FROM ticket_intentos GROUP BY bot`);
    for (const r of st) intentos[r.bot] = { intentos: r.n, exitos: Number(r.ok), segundos_medio: Number(r.seg) };
  } catch (e) {
    console.log('⚠️ sin BD, se exporta solo lo del repo:', e.message);
  }

  const gate = (util.match(/const PORTALES_FACTURABLES = \[([\s\S]*?)\];/) || ['', ''])[1];
  const enGate = (slug) => new RegExp(`['"]${slug}['"]`).test(gate);

  const salida = [];
  for (const [slug, p] of Object.entries(portales)) {
    const archivo = (p.bot || '').replace(/^bots\//, '');
    const src = archivo ? leer(`bots/${archivo}`) : '';
    const sels = src ? selectoresDelBot(src) : [];
    const det = p.deteccion || {};
    const ag = agente.find((a) => a.comercio === slug);

    salida.push({
      portal: {
        nombre_comercial: p.nombre,
        razon_social: (p.comercios || [])[0] || p.nombre,
        slug,
        url_portal: p.url_base || null,
        url_base: p.url_base || null,
        tecnologia: p.tecnologia || 'desconocida',
        // El CAPTCHA se detecta por USO REAL, no porque aparezca la palabra.
        //
        // ⚠️ La primera versión buscaba /captcha|turnstile/ en todo el archivo y
        // marcó a CAFFENIO como protegido con Turnstile. Su cabecera dice justo
        // lo contrario: "NO hay CAPTCHA en ningún punto del flujo (verificado…
        // sin iframes de recaptcha/turnstile)". El regex casó con la NEGACIÓN.
        //
        // Es el mismo fallo del que este script protege —dato inventado que
        // parece real— cometido por el propio script. Así que ahora solo cuenta
        // como CAPTCHA lo que se puede demostrar: llamadas al resolutor, un
        // error_code dedicado, o que las notas del portal lo afirmen. Y si el
        // bot dice explícitamente que NO hay, eso manda sobre todo lo demás.
        ...detectarCaptcha(src, p),
        requiere_registro: /login|iniciar sesi|credencial|_USER|_PASS/i.test(src),
        campos_requeridos: camposDelPrompt(vision, slug),
        soporta_cfdi_40: /regimenFiscalReceptor|DomicilioFiscalReceptor|cfdi.?40|4\.0/i.test(src + (p.notas_desarrollo || '')),
      },
      flujo_facturacion: {
        // El flujo detallado vive en la cabecera del bot: es prosa medida en
        // vivo, más útil que una lista de pasos inventada.
        pasos_documentados: p.flujo || null,
        reconocimiento: src ? cabeceraDelBot(src) : null,
        ...mensajesDetectados(src),
      },
      selectores_criticos: src ? mapearSelectores(sels, src) : null,
      selectores_todos: sels,
      manejo_errores: {
        error_codes: [...new Set((src.match(/error_code:\s*["'](\w+)["']/g) || [])
          .map((s) => s.replace(/.*["'](\w+)["']/, '$1')))],
        timeouts_ms: [...new Set((src.match(/timeout:\s*(\d+)/g) || []).map((s) => Number(s.replace(/\D/g, ''))))],
        esperas_fijas_total_s: +((src.match(/waitForTimeout\((\d+)\)/g) || [])
          .reduce((a, s) => a + Number(s.replace(/\D/g, '')), 0) / 1000).toFixed(1),
      },
      estado: {
        investigado: true,
        bot_generado: !!archivo && !!src,
        bot_en_gate: enGate(slug),
        estado_declarado: p.estado,
        generado_por_agente: !!ag,
        estado_agente: ag ? ag.estado : null,
        estadisticas: intentos[slug] || null,
        notas: p.notas_desarrollo || null,
      },
      deteccion: det,
    });

    if (CON_CODIGO && src) salida[salida.length - 1].bot_puppeteer = { archivo, codigo_completo: src };
  }

  // ── Patrones globales, contados sobre los datos, no estimados ──────────────
  const tec = {};
  for (const s of salida) { const t = s.portal.tecnologia.split(/[—(,]/)[0].trim(); tec[t] = (tec[t] || 0) + 1; }
  const conCaptcha = salida.filter((s) => s.portal.tiene_captcha);

  const doc = {
    meta: {
      total_portales: salida.length,
      con_bot: salida.filter((s) => s.estado.bot_generado).length,
      en_produccion: salida.filter((s) => s.estado.bot_en_gate).length,
      generados_por_agente: salida.filter((s) => s.estado.generado_por_agente).length,
      fecha_extraccion: new Date().toISOString().slice(0, 10),
      fuente: 'repositorio portal-facturas (portales.json + bots/ + lib/) y base de datos — NO historial de chat',
    },
    patrones_globales: {
      tecnologias: Object.fromEntries(Object.entries(tec).sort((a, b) => b[1] - a[1])),
      portales_con_captcha: conCaptcha.map((s) => ({ slug: s.portal.slug, tipo: s.portal.tipo_captcha })),
      requieren_cuenta: salida.filter((s) => s.portal.requiere_registro).map((s) => s.portal.slug),
      campos_mas_pedidos: (() => {
        const c = {};
        for (const s of salida) for (const f of s.portal.campos_requeridos) c[f] = (c[f] || 0) + 1;
        return Object.fromEntries(Object.entries(c).sort((a, b) => b[1] - a[1]));
      })(),
    },
    portales: salida,
  };

  fs.mkdirSync(SALIDA, { recursive: true });
  const destinoJson = path.join(SALIDA, 'conocimiento-portales.json');
  fs.writeFileSync(destinoJson, JSON.stringify(doc, null, 1));

  // ── Markdown legible, que es lo que de verdad se consulta ──────────────────
  const md = ['# Conocimiento de portales — portal-facturas', '',
    `Extraído del repositorio el ${doc.meta.fecha_extraccion}. **No** de historial de chat: todo lo de aquí está en \`portales.json\`, en las cabeceras de \`bots/*.js\` y en la base de datos, y se puede verificar abriendo esos archivos.`, '',
    `**${doc.meta.total_portales} portales · ${doc.meta.con_bot} con bot · ${doc.meta.en_produccion} en el gate de la cola · ${doc.meta.generados_por_agente} dados de alta por el agente**`, '',
    '## Tecnologías', '',
    ...Object.entries(doc.patrones_globales.tecnologias).map(([t, n]) => `- ${t} — ${n}`), '',
    '## Portales con CAPTCHA', '',
    ...(conCaptcha.length ? conCaptcha.map((s) => `- **${s.portal.slug}** — ${s.portal.tipo_captcha}`) : ['- ninguno']), '',
    '---', ''];

  for (const s of salida) {
    md.push(`## ${s.portal.nombre_comercial}  \`${s.portal.slug}\``, '');
    md.push(`- **URL:** ${s.portal.url_portal || '—'}`);
    md.push(`- **Tecnología:** ${s.portal.tecnologia}`);
    md.push(`- **CAPTCHA:** ${s.portal.tipo_captcha}${s.portal.requiere_registro ? ' · requiere cuenta' : ''}`);
    md.push(`- **Campos que pide:** ${s.portal.campos_requeridos.join(', ') || '—'}`);
    md.push(`- **Bot:** ${s.estado.bot_generado ? '✅ ' + (portales[s.portal.slug].bot) : '❌ sin bot'} · ${s.estado.bot_en_gate ? 'en la cola' : 'fuera del gate'}`);
    if (s.estado.estadisticas) {
      const e = s.estado.estadisticas;
      md.push(`- **Historial:** ${e.exitos}/${e.intentos} intentos con éxito · ${e.segundos_medio}s de media`);
    }
    if (s.manejo_errores.error_codes.length) md.push(`- **Errores que distingue:** ${s.manejo_errores.error_codes.join(', ')}`);
    if (s.manejo_errores.esperas_fijas_total_s) md.push(`- **Esperas fijas:** ${s.manejo_errores.esperas_fijas_total_s}s (⚠️ el tope de sesión de Browserless son 60s)`);
    if (s.estado.notas) md.push('', `> ${s.estado.notas}`);
    if (s.flujo_facturacion.reconocimiento) {
      md.push('', '<details><summary>Reconocimiento real del portal</summary>', '', '```', s.flujo_facturacion.reconocimiento, '```', '</details>');
    }
    md.push('');
  }

  const destinoMd = path.join(SALIDA, 'conocimiento-portales.md');
  fs.writeFileSync(destinoMd, md.join('\n'));

  console.log(`✅ ${doc.meta.total_portales} portales exportados`);
  console.log(`   con bot: ${doc.meta.con_bot} · en el gate: ${doc.meta.en_produccion} · del agente: ${doc.meta.generados_por_agente}`);
  console.log(`   ${destinoJson}  (${Math.round(fs.statSync(destinoJson).size / 1024)} KB)`);
  console.log(`   ${destinoMd}  (${Math.round(fs.statSync(destinoMd).size / 1024)} KB)`);
  process.exit(0);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
