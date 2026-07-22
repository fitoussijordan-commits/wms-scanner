"use client";
import { useState, useEffect } from "react";
import * as odoo from "@/lib/odoo";
import { loadUserPermissions, saveUserPermission } from "@/lib/supabase";
import FieldMapEditor from "@/components/FieldMapEditor";
import ModelMapEditor from "@/components/ModelMapEditor";

const C = {
  bg: "#f8fafc", white: "#ffffff", text: "#1a1a2e", textSec: "#374151",
  textMuted: "#6b7280", border: "#e5e7eb", blue: "#2563eb", blueSoft: "#eff6ff",
  green: "#16a34a", greenSoft: "#f0fdf4", red: "#dc2626", purple: "#7c3aed",
  shadow: "0 1px 4px rgba(0,0,0,0.07)",
};

// Catalogue de TOUS les outils contrôlables (key = identifiant interne, label = affichage).
// Doit rester aligné avec mainTools + toolItems de app/page.tsx.
export const ALL_TOOLS: { key: string; label: string; group: string }[] = [
  { key: "transfer", label: "Transfert", group: "Opérations" },
  { key: "prep", label: "Préparation", group: "Opérations" },
  { key: "waitingOrders", label: "En attente", group: "Opérations" },
  { key: "packing", label: "Emballage", group: "Opérations" },
  { key: "arrival", label: "Arrivage", group: "Opérations" },
  { key: "eshop", label: "E-shop", group: "Opérations" },
  { key: "inventory", label: "Ajustement", group: "Stock" },
  { key: "inventoryCount", label: "Inventaire", group: "Stock" },
  { key: "freeScan", label: "Scan libre", group: "Stock" },
  { key: "negativeStock", label: "Stock négatif", group: "Stock" },
  { key: "locationManager", label: "Gestion emplacements", group: "Stock" },
  { key: "returns", label: "Retours", group: "Opérations" },
  { key: "eshopSorties", label: "Sorties e-shop", group: "E-shop" },
  { key: "productImport", label: "Gestion articles", group: "Articles" },
  { key: "supplierImport", label: "Import WALA", group: "Articles" },
  { key: "imparfaite", label: "Import Imparfaite", group: "Articles" },
  { key: "labels", label: "Étiquettes", group: "Outils" },
  { key: "reprintLabel", label: "Réimpr. étiq.", group: "Outils" },
  { key: "order", label: "Commande", group: "Outils" },
  { key: "fefo", label: "Analyse FEFO", group: "Analyse" },
  { key: "manufacturing", label: "Fabrication", group: "Stock" },
  { key: "dashboard", label: "Dashboard", group: "Analyse" },
];

interface Props {
  session: odoo.OdooSession;
  onBack: () => void;
  onToast: (msg: string, type?: "success" | "error" | "info") => void;
}

export default function AdminScreen({ session, onBack, onToast }: Props) {
  const [users, setUsers] = useState<{ id: number; name: string; login: string }[]>([]);
  const [perms, setPerms] = useState<Record<string, string[]>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"perms" | "fields" | "models">("perms");

  const myLogin = (session.login || "").toLowerCase();

  const load = async () => {
    setLoading(true);
    try {
      const [u, p] = await Promise.all([odoo.getActiveUsers(session), loadUserPermissions()]);
      setUsers(u);
      setPerms(p);
    } catch (e: any) { onToast("Erreur chargement : " + (e?.message ?? e), "error"); }
    setLoading(false);
  };
  // Chargement UNE SEULE FOIS au montage (sinon un re-render du parent rechargerait
  // les droits depuis Supabase et écraserait les cases en cours d'édition).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, []);

  // Outils autorisés pour l'utilisateur sélectionné (par défaut : aucun = config vide).
  const current = selected ? (perms[selected] ?? []) : [];
  const hasConfig = selected ? perms[selected] !== undefined : false;

  const toggleTool = (key: string) => {
    if (!selected) return;
    setPerms(prev => {
      const cur = new Set(prev[selected] ?? []);
      cur.has(key) ? cur.delete(key) : cur.add(key);
      return { ...prev, [selected]: Array.from(cur) };
    });
  };

  const setAll = (on: boolean) => {
    if (!selected) return;
    setPerms(prev => ({ ...prev, [selected]: on ? ALL_TOOLS.map(t => t.key) : [] }));
  };

  const saveSelected = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      await saveUserPermission(selected, perms[selected] ?? []);
      onToast("✓ Droits enregistrés", "success");
    } catch (e: any) { onToast("Erreur : " + (e?.message ?? e), "error"); }
    setSaving(false);
  };

  const filteredUsers = users.filter(u =>
    !search || u.name.toLowerCase().includes(search.toLowerCase()) || u.login.includes(search.toLowerCase())
  );

  const groups = Array.from(new Set(ALL_TOOLS.map(t => t.group)));

  return (
    <div style={{ padding: "16px 16px 60px", maxWidth: 760, margin: "0 auto", fontFamily: "'DM Sans', sans-serif" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <button onClick={onBack} style={{ background: C.bg, border: "none", borderRadius: 10, padding: 8, cursor: "pointer", display: "flex" }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={C.text} strokeWidth="2"><path d="M19 12H5M12 5l-7 7 7 7" /></svg>
        </button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: C.text }}>Administration</div>
          <div style={{ fontSize: 12, color: C.textMuted }}>{tab === "perms" ? "Droits d'accès aux outils, par utilisateur" : tab === "fields" ? "Mapping des champs Odoo" : "Mapping des modèles Odoo"}</div>
        </div>
        {tab === "perms" && <button onClick={load} title="Recharger" style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 12px", cursor: "pointer", color: C.textSec }}>↻</button>}
      </div>

      {/* ── Onglets ── */}
      <div style={{ display: "flex", gap: 6, marginBottom: 16, background: C.bg, padding: 4, borderRadius: 12 }}>
        {([
          { k: "perms" as const, label: "👤 Droits" },
          { k: "fields" as const, label: "⚙️ Champs" },
          { k: "models" as const, label: "🗂️ Modèles" },
        ]).map(t => (
          <button key={t.k} onClick={() => setTab(t.k)}
            style={{ flex: 1, padding: "9px 0", borderRadius: 9, border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 700,
              background: tab === t.k ? C.white : "transparent", color: tab === t.k ? C.text : C.textMuted,
              boxShadow: tab === t.k ? C.shadow : "none" }}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === "fields" ? (
        <FieldMapEditor session={session} onToast={onToast} />
      ) : tab === "models" ? (
        <ModelMapEditor session={session} onToast={onToast} />
      ) : loading ? (
        <div style={{ textAlign: "center", color: C.textMuted, padding: 40 }}>Chargement…</div>
      ) : !selected ? (
        // ── Liste des utilisateurs ──
        <>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="🔍 Rechercher un utilisateur…"
            style={{ width: "100%", boxSizing: "border-box", padding: "10px 12px", border: `1.5px solid ${C.border}`, borderRadius: 10, fontSize: 14, fontFamily: "inherit", marginBottom: 12 }} />
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {filteredUsers.map(u => {
              const isMe = u.login === myLogin;
              const count = (perms[u.login] ?? []).length;
              const configured = perms[u.login] !== undefined;
              return (
                <button key={u.id} onClick={() => setSelected(u.login)}
                  style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, textAlign: "left", background: C.white, border: `1px solid ${C.border}`, borderRadius: 12, padding: "12px 14px", cursor: "pointer", fontFamily: "inherit", boxShadow: C.shadow }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{u.name}{isMe && <span style={{ color: C.purple, fontSize: 11, marginLeft: 6 }}>(admin — toi)</span>}</div>
                    <div style={{ fontSize: 12, color: C.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{u.login}</div>
                  </div>
                  <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 700, color: configured ? C.blue : C.textMuted, background: configured ? C.blueSoft : C.bg, padding: "3px 9px", borderRadius: 99 }}>
                    {isMe ? "tous" : configured ? `${count} outil${count > 1 ? "s" : ""}` : "non configuré"}
                  </span>
                </button>
              );
            })}
            {!filteredUsers.length && <div style={{ textAlign: "center", padding: 30, color: C.textMuted, fontSize: 13 }}>Aucun utilisateur</div>}
          </div>
          <div style={{ marginTop: 16, fontSize: 12, color: C.textMuted, lineHeight: 1.5 }}>
            ℹ️ Un utilisateur « non configuré » voit un jeu d'outils de base par défaut. Coche les outils pour personnaliser. Toi (admin) vois toujours tout.
          </div>
        </>
      ) : (
        // ── Édition des droits d'un utilisateur ──
        <>
          <button onClick={() => setSelected(null)} style={{ background: "none", border: "none", color: C.blue, cursor: "pointer", fontSize: 13, fontWeight: 700, padding: 0, marginBottom: 12, fontFamily: "inherit" }}>← Tous les utilisateurs</button>
          {(() => {
            const u = users.find(x => x.login === selected);
            const isMe = selected === myLogin;
            return (
              <>
                <div style={{ fontSize: 16, fontWeight: 800, color: C.text }}>{u?.name || selected}</div>
                <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 14 }}>{selected}</div>
                {isMe ? (
                  <div style={{ background: C.greenSoft, border: `1px solid ${C.green}44`, borderRadius: 10, padding: "12px 14px", fontSize: 13, color: C.text }}>
                    🔒 Tu es administrateur : tu as accès à tous les outils. Ces droits ne sont pas modifiables (pour ne pas te verrouiller).
                  </div>
                ) : (
                  <>
                    <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                      <button onClick={() => setAll(true)} style={{ flex: 1, padding: "8px 0", borderRadius: 8, border: `1px solid ${C.blue}`, background: C.blueSoft, color: C.blue, fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>Tout cocher</button>
                      <button onClick={() => setAll(false)} style={{ flex: 1, padding: "8px 0", borderRadius: 8, border: `1px solid ${C.border}`, background: C.white, color: C.textSec, fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>Tout décocher</button>
                    </div>
                    {groups.map(g => (
                      <div key={g} style={{ marginBottom: 14 }}>
                        <div style={{ fontSize: 11, fontWeight: 800, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>{g}</div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                          {ALL_TOOLS.filter(t => t.group === g).map(t => {
                            const on = current.includes(t.key);
                            return (
                              <label key={t.key} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", background: on ? C.blueSoft : C.white, border: `1px solid ${on ? C.blue + "55" : C.border}`, borderRadius: 10, cursor: "pointer", fontSize: 14, color: C.text }}>
                                <input type="checkbox" checked={on} onChange={() => toggleTool(t.key)} style={{ width: 17, height: 17, accentColor: C.blue, cursor: "pointer" }} />
                                {t.label}
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                    <button onClick={saveSelected} disabled={saving}
                      style={{ width: "100%", padding: "13px 0", background: saving ? C.textMuted : C.green, color: "#fff", border: "none", borderRadius: 11, fontWeight: 800, fontSize: 15, cursor: saving ? "default" : "pointer", fontFamily: "inherit", marginTop: 4 }}>
                      {saving ? "Enregistrement…" : "💾 Enregistrer les droits"}
                    </button>
                  </>
                )}
              </>
            );
          })()}
        </>
      )}
    </div>
  );
}
