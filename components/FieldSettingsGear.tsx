"use client";
// components/FieldSettingsGear.tsx
// ────────────────────────────────────────────────────────────────────────────
// Roue crantée ⚙️ à poser dans le header de n'importe quel écran.
// Ouvre une modale permettant de remapper LES CHAMPS ODOO UTILISÉS PAR CET ÉCRAN,
// sans passer par l'admin. Les modifications sont partagées (Supabase) et
// appliquées immédiatement.
//
// Usage :
//   <FieldSettingsGear session={session} onToast={toast} screen="waitingOrders" />
//   ou en passant des clés explicites :
//   <FieldSettingsGear session={session} onToast={toast} keys={["SHIPPING_DATE","ORDER_TAGS"]} />
// ────────────────────────────────────────────────────────────────────────────
import { useState } from "react";
import * as odoo from "@/lib/odoo";
import * as fieldMap from "@/lib/fieldMap";
import FieldMapEditor from "@/components/FieldMapEditor";
import { useAdminMode } from "@/lib/adminMode";

interface Props {
  session: odoo.OdooSession;
  onToast: (msg: string, type?: "success" | "error" | "info") => void;
  /** Identifiant d'écran → résout automatiquement les champs concernés. */
  screen?: string;
  /** Ou liste explicite de clés (prioritaire sur `screen`). */
  keys?: fieldMap.FieldKey[];
  /** Taille de l'icône. */
  size?: number;
  /** Couleur de l'icône. */
  color?: string;
  /** Callback après enregistrement (ex. recharger les données de l'écran). */
  onSaved?: () => void;
}

export default function FieldSettingsGear({ session, onToast, screen, keys, size = 20, color = "#6b7280", onSaved }: Props) {
  const [open, setOpen] = useState(false);
  const { adminMode } = useAdminMode();

  // Roue masquée hors mode admin → ne pollue pas la session quotidienne.
  if (!adminMode) return null;

  // Clés à éditer : explicites, sinon dérivées de l'écran.
  const resolvedKeys = keys && keys.length
    ? keys
    : screen
      ? fieldMap.fieldsForScreen(screen)
      : [];

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Paramétrer les champs Odoo de cet écran"
        aria-label="Paramétrer les champs Odoo"
        style={{ background: "transparent", border: "none", padding: 6, cursor: "pointer", display: "flex", alignItems: "center", borderRadius: 8 }}
      >
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
        </svg>
      </button>

      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 9999, display: "flex", alignItems: "flex-end", justifyContent: "center" }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ background: "#fff", width: "100%", maxWidth: 640, maxHeight: "88vh", overflowY: "auto", borderRadius: "18px 18px 0 0", padding: "18px 16px 32px", fontFamily: "'DM Sans', sans-serif", boxShadow: "0 -8px 40px rgba(0,0,0,0.2)" }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
              <div style={{ fontSize: 17, fontWeight: 800, color: "#1a1a2e", flex: 1 }}>⚙️ Champs Odoo de cet écran</div>
              <button onClick={() => setOpen(false)} style={{ background: "#f8fafc", border: "none", borderRadius: 8, width: 32, height: 32, cursor: "pointer", fontSize: 18, color: "#6b7280" }}>×</button>
            </div>
            <div style={{ fontSize: 12.5, color: "#6b7280", marginBottom: 14, lineHeight: 1.5 }}>
              Remappe le nom technique d'un champ si Odoo l'a renommé. Modifie, teste, puis enregistre. Partagé avec tous les postes.
            </div>
            {resolvedKeys.length ? (
              <FieldMapEditor
                session={session}
                onToast={onToast}
                onlyKeys={resolvedKeys}
                compact
                onSaved={() => { onSaved?.(); setOpen(false); }}
              />
            ) : (
              <div style={{ textAlign: "center", padding: 24, color: "#6b7280", fontSize: 13 }}>
                Aucun champ paramétrable déclaré pour cet écran.
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
