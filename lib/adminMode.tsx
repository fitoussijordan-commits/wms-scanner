"use client";
// lib/adminMode.tsx
// ────────────────────────────────────────────────────────────────────────────
// « Mode admin » global. Quand il est ACTIF, les roues crantées ⚙️ de
// paramétrage des champs Odoo apparaissent dans les écrans. Quand il est
// INACTIF (défaut), elles sont masquées → session quotidienne non polluée.
//
// Le choix est mémorisé par appareil (localStorage) et RÉINITIALISÉ à la
// déconnexion / au rechargement complet (valeur de départ = false).
// ────────────────────────────────────────────────────────────────────────────
import { createContext, useContext, useEffect, useState, ReactNode } from "react";

interface AdminModeCtx {
  adminMode: boolean;
  setAdminMode: (v: boolean) => void;
  toggleAdminMode: () => void;
}

const Ctx = createContext<AdminModeCtx>({
  adminMode: false,
  setAdminMode: () => {},
  toggleAdminMode: () => {},
});

const STORAGE_KEY = "wms_admin_mode";

export function AdminModeProvider({ children }: { children: ReactNode }) {
  const [adminMode, setAdminModeState] = useState(false);

  // Restaure le dernier choix (par appareil).
  useEffect(() => {
    try {
      if (typeof window !== "undefined" && window.localStorage.getItem(STORAGE_KEY) === "1") {
        setAdminModeState(true);
      }
    } catch { /* localStorage indisponible */ }
  }, []);

  const setAdminMode = (v: boolean) => {
    setAdminModeState(v);
    try {
      if (typeof window !== "undefined") {
        if (v) window.localStorage.setItem(STORAGE_KEY, "1");
        else window.localStorage.removeItem(STORAGE_KEY);
      }
    } catch { /* ignore */ }
  };

  const toggleAdminMode = () => setAdminMode(!adminMode);

  return <Ctx.Provider value={{ adminMode, setAdminMode, toggleAdminMode }}>{children}</Ctx.Provider>;
}

export function useAdminMode(): AdminModeCtx {
  return useContext(Ctx);
}
