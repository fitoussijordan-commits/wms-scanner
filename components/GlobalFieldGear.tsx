"use client";
// components/GlobalFieldGear.tsx
// ────────────────────────────────────────────────────────────────────────────
// Roue ⚙️ UNIVERSELLE à poser dans le header global. En mode admin uniquement.
// Ouvre une modale avec DEUX onglets : tous les Champs Odoo + tous les Modèles.
// Donne accès au paramétrage complet depuis n'importe quel écran.
// ────────────────────────────────────────────────────────────────────────────
import { useState } from "react";
import * as odoo from "@/lib/odoo";
import FieldMapEditor from "@/components/FieldMapEditor";
import ModelMapEditor from "@/components/ModelMapEditor";
import { useAdminMode } from "@/lib/adminMode";

interface Props {
  session: odoo.OdooSession;
  onToast: (msg: string, type?: "success" | "error" | "info") => void;
  size?: number;
  color?: string;
}

export default function GlobalFieldGear({ session, onToast, size = 20, color = "#6b7280" }: Props) {
  const { adminMode } = useAdminMode();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"fields" | "models">("fields");

  if (!adminMode) return null; // masquée hors mode admin

  return (
    <>
      <button onClick={() => setOpen(true)} title="Paramétrer tous les champs et modèles Odoo" aria-label="Paramétrage Odoo"
        style={{ background: "#f3e8ff", border: "1.5px solid #7c3aed", borderRadius: 9, padding: 6, cursor: "pointer", display: "flex", alignItems: "center" }}>
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#7c3aed" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
        </svg>
      </button>

      {open && (
        <div onClick={() => setOpen(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 9999, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ background: "#fff", width: "100%", maxWidth: 680, maxHeight: "90vh", overflowY: "auto", borderRadius: "18px 18px 0 0", padding: "18px 16px 32px", fontFamily: "'DM Sans', sans-serif", boxShadow: "0 -8px 40px rgba(0,0,0,0.2)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
              <div style={{ fontSize: 17, fontWeight: 800, color: "#1a1a2e", flex: 1 }}>⚙️ Paramétrage Odoo</div>
              <button onClick={() => setOpen(false)} style={{ background: "#f8fafc", border: "none", borderRadius: 8, width: 32, height: 32, cursor: "pointer", fontSize: 18, color: "#6b7280" }}>×</button>
            </div>

            {/* Onglets Champs / Modèles */}
            <div style={{ display: "flex", gap: 6, marginBottom: 14, background: "#f8fafc", padding: 4, borderRadius: 12 }}>
              {([{ k: "fields" as const, label: "⚙️ Champs" }, { k: "models" as const, label: "🗂️ Modèles" }]).map((t) => (
                <button key={t.k} onClick={() => setTab(t.k)}
                  style={{ flex: 1, padding: "9px 0", borderRadius: 9, border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 700,
                    background: tab === t.k ? "#fff" : "transparent", color: tab === t.k ? "#1a1a2e" : "#6b7280",
                    boxShadow: tab === t.k ? "0 1px 4px rgba(0,0,0,0.07)" : "none" }}>
                  {t.label}
                </button>
              ))}
            </div>

            {tab === "fields"
              ? <FieldMapEditor session={session} onToast={onToast} compact />
              : <ModelMapEditor session={session} onToast={onToast} />}
          </div>
        </div>
      )}
    </>
  );
}
