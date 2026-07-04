"use client";
// components/ModelMapEditor.tsx
// ────────────────────────────────────────────────────────────────────────────
// Éditeur du mapping des MODÈLES Odoo (product.product, stock.picking…).
// Même principe que FieldMapEditor mais pour les noms de modèles.
//   – changer le nom d'un modèle si Odoo l'a renommé,
//   – le tester (search_count) pour vérifier qu'il existe,
//   – reset au défaut, sauvegarde Supabase (partagée).
// ────────────────────────────────────────────────────────────────────────────
import { useState, useEffect } from "react";
import * as odoo from "@/lib/odoo";
import * as fieldMap from "@/lib/fieldMap";
import { loadModelOverrides, saveModelOverrides } from "@/lib/supabase";

const C = {
  bg: "#f8fafc", white: "#ffffff", text: "#1a1a2e", textSec: "#374151",
  textMuted: "#6b7280", border: "#e5e7eb", blue: "#2563eb", blueSoft: "#eff6ff",
  green: "#16a34a", greenSoft: "#f0fdf4", red: "#dc2626", amber: "#d97706", amberSoft: "#fffbeb",
};

interface Props {
  session: odoo.OdooSession;
  onToast: (msg: string, type?: "success" | "error" | "info") => void;
  onSaved?: () => void;
}

type TestState = "idle" | "testing" | "ok" | "missing" | "error";

export default function ModelMapEditor({ session, onToast, onSaved }: Props) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => {
    (async () => {
      try { fieldMap.setModelOverrides(await loadModelOverrides()); } catch {}
      const init: Record<string, string> = {};
      for (const m of fieldMap.listModels()) init[m.key] = m.effective;
      setValues(init);
      setLoaded(true);
    })();
  }, []);

  const setValue = (key: string, v: string) => {
    setValues((p) => ({ ...p, [key]: v }));
    setTests((p) => ({ ...p, [key]: "idle" }));
  };

  const resetToDefault = (key: fieldMap.ModelKey) => setValue(key, fieldMap.MODEL_DEFS[key].default);

  // Teste un modèle : un search_count [] réussit si le modèle existe (et est accessible).
  const testModel = async (key: fieldMap.ModelKey) => {
    const model = (values[key] ?? "").trim();
    if (!model) { setTests((p) => ({ ...p, [key]: "error" })); return; }
    setTests((p) => ({ ...p, [key]: "testing" }));
    try {
      await odoo.callMethod(session, model, "search_count", [[]], {});
      setTests((p) => ({ ...p, [key]: "ok" }));
    } catch (e: any) {
      // Un modèle inexistant renvoie une erreur → "introuvable".
      setTests((p) => ({ ...p, [key]: "missing" }));
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const merged: Record<string, string> = {};
      for (const m of fieldMap.listModels()) {
        const v = (values[m.key] ?? "").trim();
        const def = fieldMap.MODEL_DEFS[m.key].default;
        if (v && v !== def) merged[m.key] = v;
      }
      await saveModelOverrides(merged);
      fieldMap.setModelOverrides(merged);
      onToast("✓ Modèles Odoo enregistrés", "success");
      onSaved?.();
    } catch (e: any) {
      onToast("Erreur : " + (e?.message ?? e), "error");
    }
    setSaving(false);
  };

  if (!loaded) return <div style={{ textAlign: "center", color: C.textMuted, padding: 24 }}>Chargement…</div>;

  const testBadge = (st: TestState | undefined) => {
    switch (st) {
      case "testing": return <span style={{ fontSize: 11, color: C.textMuted }}>…test</span>;
      case "ok": return <span style={{ fontSize: 11, fontWeight: 700, color: C.green }}>✓ existe</span>;
      case "missing": return <span style={{ fontSize: 11, fontWeight: 700, color: C.red }}>✕ introuvable</span>;
      case "error": return <span style={{ fontSize: 11, fontWeight: 700, color: C.amber }}>! vide</span>;
      default: return null;
    }
  };

  const flt = search.trim().toLowerCase();
  const rows = fieldMap.listModels().filter((m) =>
    !flt || `${m.def.label} ${m.key} ${m.effective}`.toLowerCase().includes(flt)
  );

  return (
    <div style={{ fontFamily: "'DM Sans', sans-serif" }}>
      <div style={{ background: C.amberSoft, border: `1px solid ${C.amber}44`, borderRadius: 10, padding: "10px 12px", fontSize: 12.5, color: C.text, lineHeight: 1.5, marginBottom: 14 }}>
        🗂️ Remappe les <b>noms de modèles Odoo</b> (product.product, stock.picking…) si Odoo les renomme.
        Rarement nécessaire, mais utile en migration majeure. Teste avec <b>Tester</b> puis <b>Enregistre</b>.
      </div>

      <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="🔍 Filtrer un modèle…"
        style={{ width: "100%", boxSizing: "border-box", padding: "9px 11px", border: `1.5px solid ${C.border}`, borderRadius: 9, fontSize: 13, fontFamily: "inherit", marginBottom: 12 }} />

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {rows.map((m) => {
          const key = m.key;
          const val = values[key] ?? "";
          const isDefault = val.trim() === fieldMap.MODEL_DEFS[key].default;
          return (
            <div key={key} style={{ background: C.white, border: `1px solid ${isDefault ? C.border : C.blue + "66"}`, borderRadius: 10, padding: "10px 12px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
                <span style={{ fontSize: 13.5, fontWeight: 700, color: C.text }}>{m.def.label}</span>
                {!isDefault && <span style={{ fontSize: 10, fontWeight: 700, color: C.blue, background: C.blueSoft, padding: "1px 7px", borderRadius: 99 }}>modifié</span>}
                <span style={{ marginLeft: "auto" }}>{testBadge(tests[key])}</span>
              </div>
              {m.def.hint && <div style={{ fontSize: 11.5, color: C.textMuted, marginBottom: 7, lineHeight: 1.4 }}>{m.def.hint}</div>}
              <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                <input value={val} onChange={(e) => setValue(key, e.target.value)} spellCheck={false}
                  style={{ flex: "1 1 180px", minWidth: 0, padding: "8px 10px", border: `1.5px solid ${C.border}`, borderRadius: 8, fontSize: 13, fontFamily: "monospace", color: C.text }} />
                <button onClick={() => testModel(key)} disabled={tests[key] === "testing"}
                  style={{ padding: "8px 12px", borderRadius: 8, border: `1px solid ${C.blue}`, background: C.blueSoft, color: C.blue, fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>
                  Tester
                </button>
                {!isDefault && (
                  <button onClick={() => resetToDefault(key)} title={`Défaut : ${fieldMap.MODEL_DEFS[key].default}`}
                    style={{ padding: "8px 12px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.white, color: C.textSec, fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>
                    ↺ Défaut
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <button onClick={save} disabled={saving}
        style={{ width: "100%", padding: "13px 0", background: saving ? C.textMuted : C.green, color: "#fff", border: "none", borderRadius: 11, fontWeight: 800, fontSize: 15, cursor: saving ? "default" : "pointer", fontFamily: "inherit", marginTop: 12 }}>
        {saving ? "Enregistrement…" : "💾 Enregistrer les modèles"}
      </button>
    </div>
  );
}
