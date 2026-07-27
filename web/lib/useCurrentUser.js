"use client";
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";

// Reemplaza el initNav() duplicado que hoy existe en 5 páginas HTML
// (dashboard, mis-tickets, mis-facturas, perfil, admin-residentes) — todas
// hacían su propio fetch('/api/me') para pintar avatar/nombre/rol.
export function useCurrentUser() {
  const [me, setMe] = useState(null);
  const [cargando, setCargando] = useState(true);

  useEffect(() => {
    let cancelado = false;
    apiFetch("/api/me").then((data) => {
      if (!cancelado) {
        setMe(data);
        setCargando(false);
      }
    });
    return () => { cancelado = true; };
  }, []);

  return { me, cargando };
}
