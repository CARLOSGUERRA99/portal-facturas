// Wrapper de fetch para llamar a la API — SIEMPRE con rutas relativas (/api/...),
// nunca la URL absoluta de Railway. El proxy en next.config.mjs (rewrites) es
// lo que hace que la cookie de sesión funcione sin CORS ni sameSite:'none' —
// un fetch directo a Railway rompería esa garantía. Ver memoria del proyecto:
// "feedback_confirm_relative_fetch_migration".
export async function apiFetch(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...opts.headers },
  });
  if (res.status === 401) {
    if (typeof window !== "undefined") window.location.href = "/login";
    return null;
  }
  return res.json();
}
