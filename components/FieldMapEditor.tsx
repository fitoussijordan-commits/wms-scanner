"use client";
// components/FieldMapEditor.tsx
// ────────────────────────────────────────────────────────────────────────────
// Éditeur du mapping des champs Odoo, RÉUTILISABLE :
//   • dans AdminScreen (onglet « Champs Odoo ») → toutes les clés
//   • dans une roue crantée ⚙️ d'écran → sous-ensemble de clés (prop onlyKeys)
//
// Permet, sans coder :
//   – de changer le nom technique Odoo d'un champ,
//   – de le tester contre Odoo (fields_get) pour vérifier qu'il existe,
//   – de le réinitialiser à sa valeur par défaut,
//   – d'enregistrer dans Supabase (partagé entre tous les postes).
// ────────────────────────────────────────────────────────────────────────────
import { useState, useEffect, useMemo } from "react";
import * as odoo from "@/lib/odoo";
import * as fieldMap from "@/lib/fieldMap";
import { loadFieldOverrides, saveFieldOverrides } from "@/lib/supabase";

const C = {
  bg: "#f8fafc", white: "#ffffff", text: "#1a1a2e", textSec: "#374151",
  textMuted: "#6b7280", border: "#e5e7eb", blue: "#2563eb", blueSoft: "#eff6ff",
  green: "#16a34a", greenSoft: "#f0fdf4", red: "#dc2626", redSoft: "#fef2f2",
  amber: "#d97706", amberSoft: "#fffbeb", purple: "#7c3aed",
};

interface Props {
  session: odoo.OdooSession;
  onToast: (msg: string, type?: "success" | "error" | "info") => void;
  /** Si fourni : n'affiche que ces clés (roue crantée d'un écran). Sinon : toutes. */
  onlyKeys?: fieldMap.FieldKey[];
  /** Appelé après une sauvegarde réussie (ex. refermer la popover). */
  onSaved?: () => void;
  /** Rendu compact (dans une popover) vs pleine page (admin). */
  compact?: boolean;
}

type TestState = "idle" | "testing" | "ok" | "missing" | "error";

export default function FieldMapEditor({ session, onToast, onlyKeys, onSaved, compact }: Props) {
  // Valeurs éditées localement (cléLogique → nom technique). On part des valeurs effectives.
  const [values, setValues] = useState<Record<string, string>>({});
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [search, setSearch] = useState("");

  // Liste des champs à afficher (filtrée si onlyKeys).
  const allFields = useMemo(() => {
    const list = fieldMap.listFields();
    if (onlyKeys && onlyKeys.length) {
      const set = new Set(onlyKeys);
      return list.filter((f) => set.has(f.key));
    }
    return list;
  }, [onlyKeys]);

  // Chargement initial : recharge les overrides Supabase pour être sûr d'éditer le dernier état.
  useEffect(() => {
    (async () => {
      try {
        const ov = await loadFieldOverrides();
        fieldMap.setFieldOverrides(ov);
      } catch { /* on garde les valeurs en mémoire */ }
      const init: Record<string, string> = {};
      for (const f of fieldMap.listFields()) init[f.key] = f.effective;
      setValues(init);
      setLoaded(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setValue = (key: string, v: string) => {
    setValues((prev) => ({ ...prev, [key]: v }));
    setTests((prev) => ({ ...prev, [key]: "idle" }));
  };

  const resetToDefault = (key: fieldMap.FieldKey) => {
    setValue(key, fieldMap.FIELD_DEFS[key].default);
  };

  // Teste un champ contre Odoo : fields_get sur le modèle, vérifie que le nom existe.
  const testField = async (key: fieldMap.FieldKey) => {
    const def = fieldMap.FIELD_DEFS[key];
    const tech = (values[key] ?? "").trim();
    if (!tech) { setTests((p) => ({ ...p, [key]: "error" })); return; }
    setTests((p) => ({ ...p, [key]: "testing" }));
    try {
      const fields = await odoo.callMethod(session, def.model, "fields_get", [], {
        attributes: ["string", "type"],
      });
      const exists = fields && typeof fields === "object" && tech in fields;
      setTests((p) => ({ ...p, [key]: exists ? "ok" : "missing" }));
    } catch (e: any) {
      setTests((p) => ({ ...p, [key]: "error" }));
      onToast("Test échoué : " + (e?.message ?? e), "error");
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      // On repart TOUJOURS des overrides complets existants pour ne pas écraser
      // les clés non affichées (cas de la roue crantée qui ne montre qu'un sous-ensemble).
      const existing = await loadFieldOverrides();
      const merged: Record<string, string> = { ...existing };
      for (const f of allFields) {
        const key = f.key;
        const tech = (values[key] ?? "").trim();
        const def = fieldMap.FIELD_DEFS[key].default;
        if (!tech || tech === def) {
          delete merged[key]; // valeur par défaut → pas d'override (registre reste maître)
        } else {
          merged[key] = tech;
        }
      }
      await saveFieldOverrides(merged);
      fieldMap.setFieldOverrides(merged); // applique immédiatement dans l'app
      onToast("✓ Champs Odoo enregistrés", "success");
      onSaved?.();
    } catch (e: any) {
      onToast("Erreur : " + (e?.message ?? e), "error");
    }
    setSaving(false);
  };

  if (!loaded) return <div style={{ textAlign: "center", color: C.textMuted, padding: 24 }}>Chargement…</div>;

  // Groupement par modèle Odoo.
  const byModel: Record<string, typeof allFields> = {};
  for (const f of allFields) {
    const filt = search.toLowerCase();
    if (filt && !(`${f.def.label} ${f.key} ${f.effective} ${f.def.model}`.toLowerCase().includes(filt))) continue;
    (byModel[f.def.model] ||= []).push(f);
  }
  const models = Object.keys(byModel).sort();

  const testBadge = (st: TestState | undefined) => {
    switch (st) {
      case "testing": return <span style={{ fontSize: 11, color: C.textMuted }}>…test</span>;
      case "ok": return <span style={{ fontSize: 11, fontWeight: 700, color: C.green }}>✓ existe</span>;
      case "missing": return <span style={{ fontSize: 11, fontWeight: 700, color: C.red }}>✕ introuvable</span>;
      case "error": return <span style={{ fontSize: 11, fontWeight: 700, color: C.amber }}>! erreur</span>;
      default: return null;
    }
  };

  return (
    <div style={{ fontFamily: "'DM Sans', sans-serif" }}>
      {!compact && (
        <div style={{ background: C.amberSoft, border: `1px solid ${C.amber}44`, borderRadius: 10, padding: "10px 12px", fontSize: 12.5, color: C.text, lineHeight: 1.5, marginBottom: 14 }}>
          ⚙️ Ici tu remappes les <b>noms techniques des champs Odoo</b> sans toucher au code.
          Utile quand un champ est renommé (ex. passage à Odoo 19). Modifie, teste avec <b>Tester</b>,
          puis <b>Enregistre</b>. Les champs custom (Studio) sont marqués <span style={{ color: C.purple, fontWeight: 700 }}>Studio</span>.
        </div>
      )}

      {allFields.length > 6 && (
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="🔍 Filtrer un champ…"
          style={{ width: "100%", boxSizing: "border-box", padding: "9px 11px", border: `1.5px solid ${C.border}`, borderRadius: 9, fontSize: 13, fontFamily: "inherit", marginBottom: 12 }} />
      )}

      {models.map((model) => (
        <div key={model} style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>{model}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {byModel[model].map((f) => {
              const key = f.key;
              const val = values[key] ?? "";
              const isDefault = val.trim() === fieldMap.FIELD_DEFS[key].default;
              return (
                <div key={key} style={{ background: C.white, border: `1px solid ${isDefault ? C.border : C.blue + "66"}`, borderRadius: 10, padding: "10px 12px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 13.5, fontWeight: 700, color: C.text }}>{f.def.label}</span>
                    {f.def.custom && <span style={{ fontSize: 10, fontWeight: 700, color: C.purple, background: "#f3e8ff", padding: "1px 7px", borderRadius: 99 }}>Studio</span>}
                    {!isDefault && <span style={{ fontSize: 10, fontWeight: 700, color: C.blue, background: C.blueSoft, padding: "1px 7px", borderRadius: 99 }}>modifié</span>}
                    <span style={{ marginLeft: "auto" }}>{testBadge(tests[key])}</span>
                  </div>
                  {f.def.hint && <div style={{ fontSize: 11.5, color: C.textMuted, marginBottom: 7, lineHeight: 1.4 }}>{f.def.hint}</div>}
                  <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                    <input
                      value={val}
                      onChange={(e) => setValue(key, e.target.value)}
                      spellCheck={false}
                      style={{ flex: "1 1 180px", minWidth: 0, padding: "8px 10px", border: `1.5px solid ${C.border}`, borderRadius: 8, fontSize: 13, fontFamily: "monospace", color: C.text }}
                    />
                    <button onClick={() => testField(key)} disabled={tests[key] === "testing"}
                      style={{ padding: "8px 12px", borderRadius: 8, border: `1px solid ${C.blue}`, background: C.blueSoft, color: C.blue, fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>
                      Tester
                    </button>
                    {!isDefault && (
                      <button onClick={() => resetToDefault(key)} title={`Défaut : ${fieldMap.FIELD_DEFS[key].default}`}
                        style={{ padding: "8px 12px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.white, color: C.textSec, fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>
                        ↺ Défaut
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {!models.length && <div style={{ textAlign: "center", padding: 24, color: C.textMuted, fontSize: 13 }}>Aucun champ.</div>}

      <button onClick={save} disabled={saving}
        style={{ width: "100%", padding: "13px 0", background: saving ? C.textMuted : C.green, color: "#fff", border: "none", borderRadius: 11, fontWeight: 800, fontSize: 15, cursor: saving ? "default" : "pointer", fontFamily: "inherit", marginTop: 4 }}>
        {saving ? "Enregistrement…" : "💾 Enregistrer les champs"}
      </button>
    </div>
  );
}
