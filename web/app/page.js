"use client";

// Carátula del portal (login + alta de cuenta), servida desde Vercel.
//
// Por qué vive aquí y no en Railway: es la página que recibe TODO el tráfico
// anónimo (visitas, bots, health checks) y es estática salvo dos POST. Servirla
// desde Railway obliga a mantener el contenedor Node despierto y con RAM
// reservada para devolver un HTML que no cambia nunca. Desde Vercel sale del
// CDN y no consume nada del backend.
//
// Los POST van por RUTA RELATIVA (/login, /register): el rewrite de
// next.config.mjs los reenvía a Railway desde el MISMO origen, así la cookie de
// sesión viaja sin CORS ni sameSite:'none'. Nunca llamar a la URL de Railway
// directamente desde aquí.
import { useState } from "react";

export default function Caratula() {
  const [modo, setModo] = useState("login");
  const [cargando, setCargando] = useState(false);
  const [aviso, setAviso] = useState(null);
  const [form, setForm] = useState({ nombre: "", email: "", password: "" });

  const cambiar = (campo) => (e) => setForm((f) => ({ ...f, [campo]: e.target.value }));

  async function enviar(e) {
    e.preventDefault();
    setAviso(null);

    if (!form.email || !form.password) {
      return setAviso({ tipo: "error", texto: "Escribe tu correo y tu contraseña." });
    }
    if (modo === "register" && !form.nombre.trim()) {
      return setAviso({ tipo: "error", texto: "Escribe tu nombre." });
    }

    setCargando(true);
    try {
      const cuerpo = modo === "login"
        ? { email: form.email, password: form.password }
        : { nombre: form.nombre, email: form.email, password: form.password };

      const res = await fetch(`/${modo}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cuerpo),
      });
      const datos = await res.json().catch(() => ({}));

      if (datos.ok) {
        window.location.href = "/dashboard";
        return;
      }
      setAviso({ tipo: "error", texto: datos.msg || "No se pudo completar la operación." });
    } catch {
      setAviso({ tipo: "error", texto: "No hay conexión con el servidor. Revisa tu internet." });
    } finally {
      setCargando(false);
    }
  }

  return (
    <main className="pantalla">
      <section className="marca" aria-hidden="true">
        <span className="deco deco1" />
        <span className="deco deco2" />
        <span className="deco deco3" />
        <div className="marca-contenido">
          <div className="logo">🎨</div>
          <h1>GPN</h1>
          <p className="marca-sub">Pinturas y Recubrimientos</p>
          <p className="pie">© {new Date().getFullYear()} GPN Pinturas y Recubrimientos</p>
        </div>
      </section>

      <section className="panel">
        <div className="caja">
          <p className="kicker">PORTAL FACTURAS</p>
          <h2>{modo === "login" ? "Bienvenido" : "Crea tu cuenta"}</h2>
          <p className="sub">
            {modo === "login"
              ? "Ingresa a tu portal para recuperar facturas"
              : "Regístrate para empezar a facturar tus tickets"}
          </p>

          <div className="tabs" role="tablist">
            <button
              type="button" role="tab" aria-selected={modo === "login"}
              className={modo === "login" ? "tab activa" : "tab"}
              onClick={() => { setModo("login"); setAviso(null); }}
            >
              Iniciar sesión
            </button>
            <button
              type="button" role="tab" aria-selected={modo === "register"}
              className={modo === "register" ? "tab activa" : "tab"}
              onClick={() => { setModo("register"); setAviso(null); }}
            >
              Crear cuenta
            </button>
          </div>

          <form onSubmit={enviar} noValidate>
            {modo === "register" && (
              <label className="campo">
                <span>Nombre</span>
                <input type="text" value={form.nombre} onChange={cambiar("nombre")}
                       autoComplete="name" placeholder="Tu nombre" />
              </label>
            )}

            <label className="campo">
              <span>Correo electrónico</span>
              <input type="email" value={form.email} onChange={cambiar("email")}
                     autoComplete="email" placeholder="tucorreo@ejemplo.com" />
            </label>

            <label className="campo">
              <span>Contraseña</span>
              <input type="password" value={form.password} onChange={cambiar("password")}
                     autoComplete={modo === "login" ? "current-password" : "new-password"}
                     placeholder="••••••••" />
            </label>

            {aviso && <p className={`aviso ${aviso.tipo}`} role="alert">{aviso.texto}</p>}

            <button type="submit" className="principal" disabled={cargando}>
              {cargando ? "Un momento…" : modo === "login" ? "Iniciar sesión" : "Crear cuenta"}
            </button>
          </form>
        </div>
      </section>
    </main>
  );
}
