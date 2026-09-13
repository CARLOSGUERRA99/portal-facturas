// Detector de CAPTCHA compartido por todos los bots.
//
// ── QUÉ HACE, DESDE EL 13-SEP-2026 ───────────────────────────────────────────
// Reconoce el CAPTCHA y dice DE QUÉ TIPO es, para que el bot sepa con qué
// tarea de CapSolver atacarlo. Antes este módulo servía para lo contrario:
// para cortar. Su cabecera decía que un portal con CAPTCHA es "un portal que
// ya sabemos que no se puede automatizar" y ponía de ejemplo Cloudflare,
// RadCaptcha y el captcha de imagen. Era falso: los tres se resuelven hoy.
//
// ⚠️ REGLA DEROGADA (Carlos, 13-sep-2026): ya no hay ninguna prohibición de
// resolver CAPTCHAs. CapSolver se usa libremente. Lo que encuentres por el
// repo diciendo que un captcha "no se resuelve" o que obliga a facturar a
// mano está obsoleto — corrígelo en vez de propagarlo.
//
// ── LO QUE SÍ SIGUE SIN RESOLVERSE ───────────────────────────────────────────
// Uno solo, y está medido: el CAPTCHA DE TEXTO SENSIBLE A MAYÚSCULAS
// (Parisina / QualliGas). CapSolver acierta los caracteres pero no la caja;
// 4 intentos, 4 fallos, el 13-sep-2026. Para esa familia —y solo para esa—
// sigue teniendo sentido cortar, porque reintentarlo cuesta dinero y nunca
// acierta. Va marcada abajo como `imagen_may`.

// Qué sabe resolver este repo hoy, y con qué. Si añades un solver nuevo,
// añádelo aquí: es lo que consultan el agente de altas y lib/facturacion.js
// para decidir si un captcha merece reintento o es un callejón sin salida.
const SOLVERS = {
  recaptcha: 'ReCaptchaV2TaskProxyLess',   // bots/littlecaesars.js, youbuy.js (isInvisible)
  turnstile: 'AntiTurnstileTaskProxyLess', // bots/homedepot.js, wansoft.js
  muro: 'AntiTurnstileTaskProxyLess',      // el muro de Cloudflare suele ser Turnstile servido como página
  imagen: 'ImageToTextTask',               // lib/capsolver.js, bots/7elevenmexicosadecv.js
  hcaptcha: null,      // CapSolver lo soporta, pero aquí no está escrito todavía
  radcaptcha: null,    // idem: es una imagen, reusable con ImageToTextTask cuando se escriba
  imagen_may: null,    // ⛔ medido imposible: texto sensible a mayúsculas (Parisina/QualliGas)
};

/** ¿Tenemos hoy con qué resolver este tipo de captcha? */
function esResoluble(tipo) {
  return Boolean(SOLVERS[tipo]);
}

/** Qué tarea de CapSolver toca para este tipo, o null si aún no hay solver. */
function solverPara(tipo) {
  return SOLVERS[tipo] || null;
}

const MARCADORES = [
  // reCAPTCHA de Google (v2 casilla, v2 invisible, v3)
  { tipo: 'recaptcha', selectores: ['.g-recaptcha', 'iframe[src*="recaptcha"]', '#g-recaptcha-response'] },
  // Cloudflare Turnstile
  { tipo: 'turnstile', selectores: ['.cf-turnstile', 'iframe[src*="challenges.cloudflare.com"]', 'input[name="cf-turnstile-response"]'] },
  // hCaptcha
  { tipo: 'hcaptcha', selectores: ['.h-captcha', 'iframe[src*="hcaptcha"]'] },
  // Telerik RadCaptcha (Hemajo)
  { tipo: 'radcaptcha', selectores: ['[id*="RadCaptcha"]', '[class*="RadCaptcha"]'] },
  // Captcha de imagen casero: un <img> cuyo src o id delata el propósito
  { tipo: 'imagen', selectores: ['img[src*="captcha" i]', 'img[id*="captcha" i]', 'canvas[id*="captcha" i]'] },
];

// El muro de Cloudflare no siempre trae widget: a veces es una página entera.
const TEXTO_MURO = /verifying you are human|checking your browser|un momento…|just a moment|enable javascript and cookies|acceso denegado|access denied/i;

/**
 * Mira si la página actual está pidiendo un CAPTCHA o mostrando un muro anti-bot.
 * @returns {Promise<{hay: boolean, tipo: string|null, detalle: string|null}>}
 */
async function detectarCaptcha(page) {
  try {
    return await page.evaluate((marcadores, patronMuro) => {
      const visible = (el) => el && el.offsetParent !== null && el.getBoundingClientRect().width > 10;

      for (const m of marcadores) {
        for (const sel of m.selectores) {
          const el = document.querySelector(sel);
          // Los widgets invisibles (reCAPTCHA v3, Turnstile "managed") no pasan
          // el test de visibilidad pero igual bloquean el envío del formulario,
          // así que basta con que EXISTAN en el DOM.
          if (el) return { hay: true, tipo: m.tipo, detalle: sel, visible: visible(el) };
        }
      }

      const texto = (document.body && document.body.innerText) || '';
      if (new RegExp(patronMuro.source, patronMuro.flags).test(texto)) {
        return { hay: true, tipo: 'muro', detalle: texto.trim().slice(0, 120), visible: true };
      }
      return { hay: false, tipo: null, detalle: null, visible: false };
    }, MARCADORES, { source: TEXTO_MURO.source, flags: TEXTO_MURO.flags });
  } catch (e) {
    // Si la página ya no responde no se inventa nada: se dice que no se sabe.
    return { hay: false, tipo: null, detalle: `no se pudo comprobar: ${e.message}` };
  }
}

/**
 * Atajo para bots: si hay CAPTCHA, devuelve el RunnerResult ya formado para
 * cortar el flujo. Si no, devuelve null y el bot sigue.
 *
 * El error_code 'captcha' ya está contemplado en lib/facturacion.js: deja el
 * ticket en error SIN reintentos automáticos (reintentar no cambiaría nada) y
 * lo manda a la bandeja de validación manual.
 */
async function cortarSiHayCaptcha(page, nombrePortal) {
  const c = await detectarCaptcha(page);
  if (!c.hay) return null;
  const comoSeLlama = {
    recaptcha: 'reCAPTCHA de Google',
    turnstile: 'Cloudflare Turnstile',
    hcaptcha: 'hCaptcha',
    radcaptcha: 'RadCaptcha de Telerik',
    imagen: 'CAPTCHA de imagen',
    muro: 'muro anti-bot de Cloudflare',
  }[c.tipo] || c.tipo;
  // ⚠️ Ya NO se corta por tener captcha. Solo por los que no sabemos resolver.
  if (esResoluble(c.tipo)) {
    console.log(`🔓 ${nombrePortal}: ${comoSeLlama} detectado (${c.detalle}) — resoluble con ${solverPara(c.tipo)}`);
    return null;
  }
  console.log(`🛑 ${nombrePortal}: ${comoSeLlama} detectado (${c.detalle}) — todavía no hay solver para este tipo`);
  return {
    ok: false,
    error_code: 'captcha',
    msg: `${nombrePortal} pide ${comoSeLlama}, para el que aún no hay solver escrito: factúralo desde Validación Manual`,
    captcha_tipo: c.tipo,
  };
}

module.exports = { detectarCaptcha, cortarSiHayCaptcha, esResoluble, solverPara, SOLVERS };
