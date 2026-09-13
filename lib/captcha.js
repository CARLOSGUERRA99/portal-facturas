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
// ── REGISTRO DE SOLVERS ──────────────────────────────────────────────────────
// Qué proveedor y qué tarea atacan cada tipo de captcha. NO es una lista de
// "lo que se puede y lo que no": es config. Un tipo con `null` no es un portal
// bloqueado, es un hueco a rellenar — y rellenarlo es añadir una línea aquí.
//
// ⚠️ EL PROVEEDOR NO TIENE POR QUÉ SER CAPSOLVER. Está puesto por tipo a
// propósito, porque CapSolver no es bueno en todo: en el captcha de TEXTO
// SENSIBLE A MAYÚSCULAS va 0 de 14 (medido en QualliGas, con imagen cruda y
// binarizada, 3 llamadas por intento) y 0 de 4 en el de consulta de Parisina —
// acierta los caracteres y falla la caja. Ese hueco se llena con OTRO
// proveedor, no insistiendo con este. Cuando lo encuentres, pon aquí su
// nombre y su tarea y el resto del sistema se entera solo.
const SOLVERS = {
  recaptcha:  { proveedor: 'capsolver', tarea: 'ReCaptchaV2TaskProxyLess' },   // littlecaesars.js, youbuy.js (isInvisible)
  turnstile:  { proveedor: 'capsolver', tarea: 'AntiTurnstileTaskProxyLess' }, // homedepot.js, wansoft.js
  muro:       { proveedor: 'capsolver', tarea: 'AntiTurnstileTaskProxyLess' }, // el muro de Cloudflare suele ser Turnstile servido como página
  imagen:     { proveedor: 'capsolver', tarea: 'ImageToTextTask' },            // lib/capsolver.js, 7elevenmexicosadecv.js

  // Huecos. CapSolver soporta hCaptcha; aquí simplemente no está escrito.
  hcaptcha:   null,
  radcaptcha: null,  // es una imagen: reusable con ImageToTextTask cuando se escriba
  // Texto sensible a mayúsculas (QualliGas, consulta de Parisina). CapSolver
  // medido 0/14 y 0/4 → hace falta otro proveedor. NO está "bloqueado".
  imagen_may: null,
};

/** ¿Hay hoy un solver configurado para este tipo? Si no, es un hueco, no un muro. */
function esResoluble(tipo) {
  return Boolean(SOLVERS[tipo]);
}

/** El solver configurado para este tipo: {proveedor, tarea}, o null si falta. */
function solverPara(tipo) {
  return SOLVERS[tipo] || null;
}

/** Texto corto para logs: "capsolver/ImageToTextTask" o "sin solver configurado". */
function describeSolver(tipo) {
  const s = SOLVERS[tipo];
  return s ? `${s.proveedor}/${s.tarea}` : 'sin solver configurado';
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
 * Si el tipo TIENE proveedor configurado devuelve null y el bot sigue: ya no
 * se corta por el mero hecho de haber captcha. Si no lo tiene, el error_code
 * 'captcha' hace que lib/facturacion.js deje el ticket en error sin reintento
 * (reintentar sin proveedor solo gasta) y lo mande a validación manual.
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
    console.log(`🔓 ${nombrePortal}: ${comoSeLlama} detectado (${c.detalle}) — resoluble con ${describeSolver(c.tipo)}`);
    return null;
  }
  console.log(`🧩 ${nombrePortal}: ${comoSeLlama} detectado (${c.detalle}) — aún sin proveedor configurado para este tipo`);
  return {
    ok: false,
    error_code: 'captcha',
    msg: `${nombrePortal} pide ${comoSeLlama}, para el que aún no hay proveedor configurado (ver lib/captcha.js → SOLVERS): factúralo desde Validación Manual mientras tanto`,
    captcha_tipo: c.tipo,
  };
}

module.exports = { detectarCaptcha, cortarSiHayCaptcha, esResoluble, solverPara, describeSolver, SOLVERS };
