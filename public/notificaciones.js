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
