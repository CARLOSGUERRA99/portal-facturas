let _notifInterval = null;

function initNotificaciones() {
  cargarNotificaciones();
  if (_notifInterval) clearInterval(_notifInterval);
  _notifInterval = setInterval(cargarNotificaciones, 60000);

  document.addEventListener('click', e => {
    const wrapper = document.getElementById('notif-wrapper');
    if (wrapper && !wrapper.contains(e.target)) {
      document.getElementById('notif-dropdown')?.classList.remove('open');
    }
  });
}

async function cargarNotificaciones() {
  try {
    const res = await fetch('/api/notificaciones');
    const data = await res.json();
    if (!data.ok) return;

    const badge = document.getElementById('notif-badge');
    const lista = document.getElementById('notif-lista');
    if (!badge || !lista) return;

    if (data.noLeidas > 0) {
      badge.textContent = data.noLeidas > 9 ? '9+' : data.noLeidas;
      badge.style.display = 'flex';
    } else {
      badge.style.display = 'none';
    }

    if (data.notificaciones.length === 0) {
      lista.innerHTML = '<div class="notif-empty">Sin notificaciones</div>';
      return;
    }

    lista.innerHTML = data.notificaciones.map(n => `
      <div class="notif-item ${n.leida ? 'leida' : ''}" id="notif-item-${n.id}" onclick="leerNotificacion(${n.id}, this)">
        <div class="notif-msg">${n.mensaje}</div>
        <div class="notif-time">${formatTime(n.creado)}</div>
      </div>
    `).join('');
  } catch {}
}

async function leerNotificacion(id, el) {
  if (el.classList.contains('leida')) return;
  el.classList.add('leida');
  try {
    await fetch(`/api/notificaciones/${id}/leer`, { method: 'POST' });
    const badge = document.getElementById('notif-badge');
    if (badge) {
      const current = parseInt(badge.textContent) || 0;
      const next = current - 1;
      if (next <= 0) {
        badge.style.display = 'none';
      } else {
        badge.textContent = next > 9 ? '9+' : next;
      }
    }
  } catch {}
}

async function leerTodas() {
  try {
    await fetch('/api/notificaciones/leer-todas', { method: 'POST' });
    document.getElementById('notif-badge').style.display = 'none';
    document.querySelectorAll('.notif-item').forEach(el => el.classList.add('leida'));
  } catch {}
}

function toggleNotifDropdown(e) {
  e.stopPropagation();
  document.getElementById('notif-dropdown')?.classList.toggle('open');
}

function formatTime(ts) {
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Ahora';
  if (mins < 60) return `Hace ${mins} min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `Hace ${hrs} h`;
  const days = Math.floor(hrs / 24);
  return `Hace ${days} día${days !== 1 ? 's' : ''}`;
}

// ── MARCA POR CLIENTE ────────────────────────────────────────────────────────
//
// El portal es de G&A pero lo usan ~30 clientes distintos, y cada uno tiene que
// ver el suyo. Esto vive aquí, en el JS que ya cargan TODAS las páginas, en vez
// de duplicar markup en los ocho .html: así una página nueva hereda la marca
// sola y no hay ocho sitios que se desincronicen.
//
// El subtítulo pasa a ser el nombre del cliente. No es cosmético: una
// capturista de GPN ve "GPN PINTURAS Y RECUBRIMIENTOS" y sabe de un vistazo con
// qué RFC está trabajando, que es justo lo que evita facturar con el RFC
// equivocado cuando alguien lleve dos clientes.
async function aplicarMarca() {
  try {
    const res = await fetch('/api/marca');
    const data = await res.json();
    if (!data.ok || !data.marca) return;
    const m = data.marca;

    const nombre = document.querySelector('.nav-brand-name');
    if (nombre) nombre.textContent = m.nombre;

    const sub = document.querySelector('.nav-brand-sub');
    if (sub) sub.textContent = m.esPlataforma ? 'G&A · todos los clientes' : m.sub;

    const logo = document.querySelector('.nav-brand-logo');
    if (logo && m.logo) logo.src = m.logo;

    // El color solo se toca si el cliente puso uno propio: si no, se respeta
    // la hoja de estilos y no se pisa el guinda de la marca.
    if (m.color) {
      document.documentElement.style.setProperty('--vino', m.color);
      document.documentElement.style.setProperty('--green', m.color);
    }

    if (m.nombre) document.title = document.title.replace(/^[^—]+/, m.nombre + ' ');
  } catch { /* si falla, se queda la marca por defecto: nunca una pantalla rota */ }
}

document.addEventListener('DOMContentLoaded', aplicarMarca);

// ── QUITAFONDOS DE LOGOS ─────────────────────────────────────────────────────
//
// Recorta el fondo de un logo EN EL NAVEGADOR y devuelve un PNG transparente.
//
// Se hace aquí y no en el servidor a propósito: procesar imágenes en Node obliga
// a instalar sharp o similar —binario nativo, más peso y más RAM en Railway,
// justo lo que estamos bajando— y el navegador ya trae un decodificador gratis.
//
// Cómo decide qué es fondo: mira las CUATRO ESQUINAS y toma su color medio como
// referencia. Es más fiable que asumir "el fondo es blanco", porque muchos
// logos vienen sobre gris muy claro o crema y con el umbral fijo quedaba un
// marco sucio alrededor.
//
// El borde se suaviza con alfa progresivo en vez de recortar en seco: si no, el
// contorno queda serrado y se nota sobre el guinda de la barra.
async function quitarFondoLogo(archivo, tolerancia = 40) {
  const img = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error('No se pudo leer la imagen'));
    i.src = URL.createObjectURL(archivo);
  });

  // 512px de lado basta para un logo de barra y evita PNG de varios MB.
  const lado = Math.min(512, Math.max(img.width, img.height));
  const escala = lado / Math.max(img.width, img.height);
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * escala);
  c.height = Math.round(img.height * escala);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, c.width, c.height);

  const d = ctx.getImageData(0, 0, c.width, c.height);
  const p = d.data;
  const px = (x, y) => { const i = (y * c.width + x) * 4; return [p[i], p[i + 1], p[i + 2]]; };
  const esquinas = [px(0, 0), px(c.width - 1, 0), px(0, c.height - 1), px(c.width - 1, c.height - 1)];
  const fondo = [0, 1, 2].map(k => esquinas.reduce((a, e) => a + e[k], 0) / esquinas.length);

  for (let i = 0; i < p.length; i += 4) {
    const dist = Math.sqrt((p[i] - fondo[0]) ** 2 + (p[i + 1] - fondo[1]) ** 2 + (p[i + 2] - fondo[2]) ** 2);
    if (dist < tolerancia) p[i + 3] = 0;                       // fondo → transparente
    else if (dist < tolerancia * 2) p[i + 3] = Math.round(255 * (dist - tolerancia) / tolerancia); // borde suave
  }
  ctx.putImageData(d, 0, 0);
  return c.toDataURL('image/png');
}

// Sube el logo ya recortado. Devuelve la URL pública en R2.
async function subirLogoCliente(clienteId, archivo, tolerancia) {
  const pngBase64 = await quitarFondoLogo(archivo, tolerancia);
  const r = await fetch(`/api/admin/clientes/${clienteId}/logo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pngBase64 }),
  });
  return r.json();
}

// ── ENLACES SEGÚN QUIÉN ENTRA ────────────────────────────────────────────────
//
// "Clientes" es la cartera de G&A: quiénes son, cuánto pagan, en qué estado
// están. Un admin de cliente NO tiene por qué ver a los demás clientes de la
// plataforma, así que el enlace nace oculto en el HTML y solo se enseña aquí,
// cuando /api/marca confirma que quien entró es el dueño.
//
// El servidor ya bloquea /clientes por su lado; esto es para que no se vea un
// enlace que va a rebotar, no como control de acceso.
async function ajustarMenuPorRol() {
  try {
    const { marca } = await (await fetch('/api/marca')).json();
    const enlace = document.getElementById('nav-clientes');
    if (enlace && marca && marca.esPlataforma) enlace.style.display = '';
  } catch { /* si falla, el enlace se queda oculto: fallar hacia lo seguro */ }
}
document.addEventListener('DOMContentLoaded', ajustarMenuPorRol);

// ── ETIQUETAS CORTAS EN LA BARRA INFERIOR ────────────────────────────────────
//
// En escritorio caben "Mis Tickets" y "Mis Facturas" de sobra. En un teléfono de
// 375px, con seis secciones, cada una dispone de ~62px y los textos se tocan
// entre sí — se lee peor que si no hubiera etiqueta.
//
// Se acortan por JS y no por CSS porque no hay forma de reescribir el texto de
// un enlace desde la hoja de estilos, y duplicar el markup por viewport
// significaría mantener dos menús sincronizados a mano. El texto original se
// guarda para poder restaurarlo si la pantalla crece (girar el teléfono).
function ajustarEtiquetasMenu() {
  const CORTAS = {
    '/mis-tickets': 'Tickets',
    '/mis-facturas': 'Facturas',
    '/perfil': 'Perfil',
  };
  const movil = window.innerWidth <= 700;
  document.querySelectorAll('.nav-links .nav-link').forEach((a) => {
    if (!a.dataset.textoLargo) a.dataset.textoLargo = a.textContent.trim();
    const ruta = new URL(a.href, location.origin).pathname;
    a.textContent = movil && CORTAS[ruta] ? CORTAS[ruta] : a.dataset.textoLargo;
  });
}
document.addEventListener('DOMContentLoaded', ajustarEtiquetasMenu);
window.addEventListener('resize', ajustarEtiquetasMenu);
