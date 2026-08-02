// Detector de CAPTCHA compartido por todos los bots.
//
// ── POR QUÉ EXISTE ───────────────────────────────────────────────────────────
// Hoy un portal con CAPTCHA se come la sesión ENTERA de Browserless antes de
// rendirse: el bot navega, rellena, pulsa, espera timeouts y acaba muriendo a
// los ~240s con un "Target closed" que no dice nada. Multiplicado por los
// reintentos nocturnos, es tiempo y dinero tirados en portales que ya sabemos
// que no se pueden automatizar.
//
// Preguntando por el CAPTCHA justo después de cargar la página, el ticket cae
// a la bandeja de validación manual en 3-5 segundos y con un motivo legible.
//
// ── LO QUE ESTA FUNCIÓN NO HACE ──────────────────────────────────────────────
// No lo resuelve ni intenta esquivarlo. Solo lo RECONOCE y lo reporta, para que
// una persona lo atienda desde el módulo de validación manual. Los portales
// bloqueados de verdad (Soriana con Cloudflare, Hemajo con RadCaptcha, QualliGas
// con captcha de imagen) se facturan a mano o se piden por correo.

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
  console.log(`🛑 ${nombrePortal}: ${comoSeLlama} detectado (${c.detalle}) — se corta sin gastar la sesión`);
  return {
    ok: false,
    error_code: 'captcha',
    msg: `${nombrePortal} pide ${comoSeLlama}: hay que facturarlo a mano desde Validación Manual`,
    captcha_tipo: c.tipo,
  };
}

module.exports = { detectarCaptcha, cortarSiHayCaptcha };
