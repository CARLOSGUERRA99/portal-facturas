/** @type {import('next').NextConfig} */

// ── Dominio ────────────────────────────────────────────────────────────────
// Producción: https://timbra.serviciosga.site (Vercel).
//
// ⚠️ Railway NO se apaga. Vercel solo sirve la carátula (/); TODO lo demás —la
// API entera, el login y las pantallas internas— son los rewrites de abajo, que
// reenvían a Railway. Apagar el backend deja una pantalla de login que no puede
// loguear a nadie.
//
// ⚠️ Y el DNS de serviciosga.site lleva los MX de Hostinger, que son el buzón
// buzonfacturas@serviciosga.site por donde entran TODOS los CFDI. Al apuntar el
// subdominio a Vercel hay que tocar SOLO su CNAME: nunca los MX ni los TXT.
//
// Por qué funciona la sesión desde otro dominio: el navegador solo habla con
// timbra.serviciosga.site. Los rewrites son un proxy de servidor, así que la
// cookie que pone Railway (sin atributo Domain) queda asociada al host por el
// que se entró. Por eso TODAS las llamadas van por ruta relativa: un fetch
// directo a la URL de Railway rompería esa garantía.

// BACKEND_ORIGIN: la API de Railway (server.js). En local, ponerla en .env.local
// apuntando a producción o a un server.js local. En Vercel, variable de entorno
// del proyecto.
const BACKEND_ORIGIN = process.env.BACKEND_ORIGIN || "https://portal-facturas-production.up.railway.app";

const nextConfig = {
  // Este proyecto vive en web/ dentro del monorepo de portal-facturas, que
  // también tiene su propio package-lock.json — sin esto Turbopack detecta
  // 2 lockfiles y adivina mal la raíz (toma la del repo padre en vez de web/).
  turbopack: {
    root: import.meta.dirname,
  },
  // El proxy interno de Next bufferea el body en memoria (default 10MB) y por
  // encima de eso TRUNCA EN SILENCIO en vez de fallar — el multer de server.js
  // acepta tickets de hasta 15MB, así que hace falta margen sobre eso.
  experimental: {
    proxyClientMaxBodySize: "20mb",
  },
  // ⚠️ `fallback`, NO una lista de rutas enumeradas a mano.
  //
  // La primera versión listaba ruta por ruta (/dashboard, /mis-tickets, /api/*…)
  // y las páginas cargaban con status 200 — pero SIN ESTILOS. El HTML llegaba de
  // Railway y dentro pedía /style.css y /notificaciones.js, que no estaban en la
  // lista: Vercel respondía 404 y el dashboard se veía como el logo gigante sin
  // maquetar. Verificar el status del documento no basta; hay que verificar que
  // sus archivos carguen.
  //
  // `fallback` se evalúa DESPUÉS de que Next sirve lo suyo (la carátula, sus
  // assets, /_next/*) y justo antes de devolver un 404. Así:
  //   ·  /            → la carátula que vive en Vercel
  //   ·  todo lo demás → Railway, tal cual, sin tener que enumerar nada
  // Y cualquier archivo o página que se añada al backend en el futuro funciona
  // sin tocar esta configuración.
  async rewrites() {
    return {
      beforeFiles: [],
      afterFiles: [],
      fallback: [
        { source: "/:path*", destination: `${BACKEND_ORIGIN}/:path*` },
      ],
    };
  },
};

export default nextConfig;
