/** @type {import('next').NextConfig} */

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
  async rewrites() {
    return [
      // Cubre las ~50 rutas /api/* (incluye anidadas como /api/admin/agente/portales/:id)
      { source: "/api/:path*", destination: `${BACKEND_ORIGIN}/api/:path*` },
      { source: "/login", destination: `${BACKEND_ORIGIN}/login` },
      { source: "/register", destination: `${BACKEND_ORIGIN}/register` },
      { source: "/logout", destination: `${BACKEND_ORIGIN}/logout` },
      { source: "/upload-ticket", destination: `${BACKEND_ORIGIN}/upload-ticket` },
    ];
  },
};

export default nextConfig;
