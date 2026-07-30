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

  // ── Scan des champs Odoo disponibles ──
  // Cache par modèle : { "stock.location": [{ name, label, type }, ...] }
  const [modelFields, setModelFields] = useState<Record<string, { name: string; label: string; type: string }[]>>({});
  const [scanning, setScanning] = useState<Record<string, boolean>>({});   // par clé logique
  const [openList, setOpenList] = useState<string | null>(null);            // clé logique dont la liste est ouverte
  const [listFilter, setListFilter] = useState("");                         // filtre dans la liste déroulante

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

  // ── Assistant de correspondance ─────────────────────────────────────────────
  // Renommages connus d'Odoo entre versions. Sert de première piste, vérifiée
  // ensuite contre les champs réellement présents dans la base connectée.
  const KNOWN_RENAMES: Record<string, string[]> = {
    move_ids_without_package: ["move_ids"],
    move_line_ids_without_package: ["move_line_ids"],
    reserved_uom_qty: ["quantity"],
    qty_done: ["quantity"],
    product_qty: ["product_uom_qty", "quantity"],
    x_studio_date_dexpdition_prvue: ["x_studio_date_expedition_prevue"],
  };

  // Champs pour lesquels un simple remappage NE SUFFIT PAS : la sémantique a
  // changé côté Odoo (fusion réservé/fait + booléen picked). Proposer un nom ici
  // donnerait une comparaison toujours fausse, sans aucune erreur visible.
  const SEMANTIC_CHANGE: Record<string, string> = {
    reserved_uom_qty: "Odoo a fusionné « réservé » et « fait » en un seul champ quantity, avec un booléen picked. Remapper le nom rendrait la comparaison « fait < réservé » toujours fausse : la préparation considérerait tout comme déjà prélevé, sans erreur visible. Adaptation du code nécessaire.",
    qty_done: "Même fusion que la quantité réservée. Le remappage seul créerait une panne silencieuse en préparation.",
  };

  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

  // Champs trop génériques pour constituer une correspondance : ils existent sur
  // TOUS les modèles et matcheraient n'importe quoi (« group_id » contient « id »…).
  const GENERIC = new Set([
    "id", "name", "state", "active", "display_name", "sequence", "note", "date",
    "create_date", "write_date", "create_uid", "write_uid", "company_id", "user_id",
    "__last_update", "message_ids", "activity_ids",
  ]);

  /** Propose un champ de remplacement parmi ceux réellement présents sur le modèle.
   *  Mieux vaut ne rien proposer qu'une correspondance hasardeuse : une mauvaise
   *  suggestion appliquée sans réfléchir est pire que pas de suggestion du tout. */
  const suggestFor = (tech: string, label: string, available: Record<string, any>) => {
    const names = Object.keys(available);
    // 1. Renommage connu, confirmé présent dans CETTE base
    for (const cand of (KNOWN_RENAMES[tech] || [])) {
      if (names.includes(cand)) return { name: cand, why: "renommage Odoo connu", strong: true };
    }
    // 2. Nom identique à la ponctuation près
    const nt = norm(tech);
    const same = names.find(n => norm(n) === nt);
    if (same) return { name: same, why: "même nom à la ponctuation près", strong: true };

    // 3. Libellé Odoo identique — plus fiable qu'une ressemblance de nom
    const lb = norm(label);
    const byLabel = names.find(n => !GENERIC.has(n) && norm(String(available[n]?.string || "")) === lb);
    if (byLabel) return { name: byLabel, why: "même libellé dans Odoo", strong: false };

    // 4. Ressemblance de nom — uniquement si elle est SIGNIFICATIVE.
    //    Un nom court (« date ») se retrouve dans trop de champs pour conclure,
    //    et un candidat bien plus court que la cible n'est pas un renommage.
    if (nt.length >= 6) {
      const partial = names
        .filter(n => !GENERIC.has(n))
        .filter(n => {
          const nn = norm(n);
          if (nn.length < 4) return false;
          // Le candidat doit couvrir l'essentiel du nom cherché, dans un sens ou l'autre
          const ratio = Math.min(nn.length, nt.length) / Math.max(nn.length, nt.length);
          return (nn.includes(nt) || nt.includes(nn)) && ratio >= 0.6;
        })
        .sort((a, b) => Math.abs(norm(a).length - nt.length) - Math.abs(norm(b).length - nt.length));
      if (partial.length) return { name: partial[0], why: "nom proche", strong: false };
    }
    return null;
  };

  // ── Test global : contrôle TOUS les champs d'un coup ────────────────────────
  // Indispensable pour un changement de version Odoo : tester 101 champs un par
  // un est intenable. On regroupe par modèle → une seule requête fields_get par
  // modèle (une dizaine au total) au lieu d'une par champ.
  const [auditing, setAuditing] = useState(false);
  const [auditDone, setAuditDone] = useState<null | {
    ok: number;
    missing: { key: string; label: string; model: string; tech: string;
               suggest: { name: string; why: string; strong: boolean } | null;
               danger: string | null }[];
    badModels: string[];
  }>(null);

  const auditAll = async () => {
    if (auditing) return;
    setAuditing(true); setAuditDone(null);
    try {
      const all = fieldMap.listFields();
      // Regroupe les champs par modèle Odoo
      const byModel = new Map<string, typeof all>();
      for (const f of all) {
        const m = f.def.model;
        if (!byModel.has(m)) byModel.set(m, [] as any);
        (byModel.get(m) as any).push(f);
      }
      const missing: {
        key: string; label: string; model: string; tech: string;
        suggest: { name: string; why: string; strong: boolean } | null;
        danger: string | null;
      }[] = [];
      const badModels: string[] = [];
      let ok = 0;
      const next: Record<string, TestState> = {};

      await Promise.all(Array.from(byModel.entries()).map(async ([model, fields]) => {
        let available: Record<string, any> | null = null;
        try {
          available = await odoo.callMethod(session, model, "fields_get", [], { attributes: ["string", "type"] });
        } catch {
          // Modèle inexistant/inaccessible : tous ses champs sont indéterminés
          badModels.push(model);
          for (const f of fields) next[f.key] = "error";
          return;
        }
        for (const f of fields) {
          const tech = (values[f.key] ?? f.effective ?? "").trim();
          const exists = !!tech && !!available && tech in available;
          next[f.key] = exists ? "ok" : "missing";
          if (exists) ok++;
          else {
            const danger = SEMANTIC_CHANGE[tech] || null;
            // On ne propose RIEN quand la sémantique a changé : une suggestion
            // ici inviterait à un remappage qui casse en silence.
            const suggest = danger ? null : suggestFor(tech, f.def.label, available || {});
            missing.push({ key: f.key, label: f.def.label, model, tech: tech || "(vide)", suggest, danger });
          }
        }
      }));

      setTests(prev => ({ ...prev, ...next }));
      setAuditDone({ ok, missing, badModels });
      if (missing.length === 0 && badModels.length === 0) {
        onToast(`✓ Les ${ok} champs existent dans cette base Odoo`, "success");
      } else {
        onToast(`⚠ ${missing.length} champ(s) à corriger`, "error");
      }
    } catch (e: any) {
      onToast("Audit échoué : " + (e?.message ?? e), "error");
    }
    setAuditing(false);
  };

  // « Scan » : récupère la liste des champs réellement disponibles sur le modèle Odoo
  // (fields_get) et ouvre le menu déroulant sous le champ. Mis en cache par modèle.
  const scanModel = async (key: fieldMap.FieldKey) => {
    const model = fieldMap.FIELD_DEFS[key].model;
    // Toggle : si la liste de ce champ est déjà ouverte, on la ferme.
    if (openList === key) { setOpenList(null); return; }
    setListFilter("");
    // Déjà en cache → on ouvre directement.
    if (modelFields[model]) { setOpenList(key); return; }
    setScanning((p) => ({ ...p, [key]: true }));
    try {
      const raw = await odoo.callMethod(session, model, "fields_get", [], {
        attributes: ["string", "type"],
      });
      const list = Object.entries(raw || {})
        .map(([name, meta]: [string, any]) => ({
          name,
          label: (meta?.string as string) || name,
          type: (meta?.type as string) || "",
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      setModelFields((p) => ({ ...p, [model]: list }));
      setOpenList(key);
    } catch (e: any) {
      onToast("Scan échoué : " + (e?.message ?? e), "error");
    }
    setScanning((p) => ({ ...p, [key]: false }));
  };

  // L'utilisateur choisit un champ dans la liste → on remplit la valeur et on ferme.
  const pickField = (key: fieldMap.FieldKey, fieldName: string) => {
    setValue(key, fieldName);
    setTests((p) => ({ ...p, [key]: "ok" })); // vient d'Odoo → existe forcément
    setOpenList(null);
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

      {/* Audit global — contrôle tous les champs contre la base Odoo connectée */}
      {!compact && (
        <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, padding: 12, marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" as const }}>
            <button onClick={auditAll} disabled={auditing}
              style={{ padding: "9px 16px", background: auditing ? "#cbd5e1" : "#2563eb", color: "#fff", border: "none", borderRadius: 9, fontSize: 13, fontWeight: 700, cursor: auditing ? "default" : "pointer", fontFamily: "inherit" }}>
              {auditing ? "Contrôle en cours…" : "Contrôler tous les champs"}
            </button>
            <div style={{ fontSize: 11.5, color: C.textMuted, flex: 1, minWidth: 180, lineHeight: 1.45 }}>
              Vérifie d&apos;un coup que chaque champ existe dans la base Odoo connectée.
              À lancer après un changement de version.
            </div>
          </div>

          {auditDone && (
            <div style={{ marginTop: 11 }}>
              {auditDone.missing.length === 0 && auditDone.badModels.length === 0 ? (
                <div style={{ fontSize: 12.5, color: "#15803d", fontWeight: 700 }}>
                  ✓ Les {auditDone.ok} champs existent dans cette base — rien à corriger.
                </div>
              ) : (
                <>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: "#9a3412", marginBottom: 6 }}>
                    {auditDone.ok} champ(s) valides · {auditDone.missing.length} à corriger
                  </div>
                  {auditDone.badModels.length > 0 && (
                    <div style={{ fontSize: 11.5, color: "#b91c1c", marginBottom: 6 }}>
                      Modèles inaccessibles : {auditDone.badModels.join(", ")} — à remapper dans l&apos;onglet Modèles.
                    </div>
                  )}
                  {/* Application groupée des correspondances sûres */}
                  {auditDone.missing.some(m => m.suggest?.strong) && (
                    <button
                      onClick={() => {
                        const safe = auditDone.missing.filter(m => m.suggest?.strong && !m.danger);
                        setValues(prev => {
                          const next = { ...prev };
                          for (const m of safe) next[m.key] = m.suggest!.name;
                          return next;
                        });
                        setTests(prev => {
                          const next = { ...prev };
                          for (const m of safe) next[m.key] = "idle";
                          return next;
                        });
                        onToast(`${safe.length} correspondance(s) appliquée(s) — pense à Enregistrer`, "success");
                      }}
                      style={{ marginBottom: 9, padding: "7px 13px", background: C.green, color: "#fff", border: "none", borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                      Appliquer les {auditDone.missing.filter(m => m.suggest?.strong && !m.danger).length} correspondance(s) sûre(s)
                    </button>
                  )}

                  <div style={{ maxHeight: 300, overflowY: "auto" as const }}>
                    {auditDone.missing.map(m => (
                      <div key={m.key} style={{ fontSize: 11.5, color: C.text, padding: "6px 0", borderTop: `1px solid ${C.border}` }}>
                        <div>
                          <b>{m.label}</b>
                          <span style={{ color: C.textMuted }}> — {m.model}</span>
                          <span style={{ color: "#b91c1c", fontFamily: "monospace" }}> · {m.tech} introuvable</span>
                        </div>

                        {/* Changement de sens : on refuse volontairement de proposer */}
                        {m.danger && (
                          <div style={{ marginTop: 4, background: C.redSoft, border: `1px solid #fecaca`, borderRadius: 7, padding: "7px 9px", fontSize: 11, color: "#991b1b", lineHeight: 1.5 }}>
                            <b>Aucune correspondance proposée — ce n&apos;est pas un simple renommage.</b><br />
                            {m.danger}
                          </div>
                        )}

                        {/* Proposition applicable en un clic */}
                        {!m.danger && m.suggest && (
                          <div style={{ marginTop: 4, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" as const }}>
                            <span style={{ fontSize: 11, color: C.textMuted }}>Proposition :</span>
                            <span style={{ fontFamily: "monospace", fontSize: 11.5, color: C.green, fontWeight: 700 }}>{m.suggest.name}</span>
                            <span style={{ fontSize: 10.5, color: m.suggest.strong ? C.green : C.amber, background: m.suggest.strong ? C.greenSoft : C.amberSoft, borderRadius: 5, padding: "1px 6px", fontWeight: 700 }}>
                              {m.suggest.strong ? "fiable" : "à vérifier"} · {m.suggest.why}
                            </span>
                            <button onClick={() => { setValue(m.key, m.suggest!.name); onToast(`${m.label} → ${m.suggest!.name}`, "info"); }}
                              style={{ padding: "3px 10px", background: C.blue, color: "#fff", border: "none", borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                              Appliquer
                            </button>
                          </div>
                        )}

                        {!m.danger && !m.suggest && (
                          <div style={{ marginTop: 3, fontSize: 11, color: C.amber }}>
                            Aucune correspondance trouvée — champ probablement absent de cette base (Studio à recréer ?).
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                  <div style={{ fontSize: 11, color: C.textMuted, marginTop: 7, lineHeight: 1.5 }}>
                    Les propositions ne sont <b>pas</b> enregistrées automatiquement : applique, vérifie avec
                    <b> Tester</b>, puis <b>Enregistre</b>. Pour les cas sans proposition, utilise <b>Scanner</b>
                    à côté du champ pour voir les noms réellement disponibles.
                  </div>
                </>
              )}
            </div>
          )}
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
                      style={{ flex: "1 1 160px", minWidth: 0, padding: "8px 10px", border: `1.5px solid ${C.border}`, borderRadius: 8, fontSize: 13, fontFamily: "monospace", color: C.text }}
                    />
                    {/* Scan : liste les champs disponibles du modèle Odoo dans un menu déroulant. */}
                    <button onClick={() => scanModel(key)} disabled={scanning[key]} title={`Voir les champs disponibles sur ${f.def.model}`}
                      style={{ display: "flex", alignItems: "center", gap: 5, padding: "8px 12px", borderRadius: 8, border: `1px solid ${openList === key ? C.green : C.border}`, background: openList === key ? C.greenSoft : C.white, color: openList === key ? C.green : C.textSec, fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M3 7V5a2 2 0 012-2h2M17 3h2a2 2 0 012 2v2M21 17v2a2 2 0 01-2 2h-2M7 21H5a2 2 0 01-2-2v-2"/><line x1="7" y1="12" x2="17" y2="12"/></svg>
                      {scanning[key] ? "…" : "Scan"}
                    </button>
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

                  {/* ── Liste déroulante des champs Odoo disponibles pour ce modèle ── */}
                  {openList === key && modelFields[f.def.model] && (() => {
                    const flt = listFilter.trim().toLowerCase();
                    const opts = modelFields[f.def.model].filter(o =>
                      !flt || o.name.toLowerCase().includes(flt) || o.label.toLowerCase().includes(flt)
                    );
                    return (
                      <div style={{ marginTop: 8, border: `1px solid ${C.border}`, borderRadius: 10, background: C.white, overflow: "hidden", boxShadow: "0 8px 24px -8px rgba(0,0,0,.18)" }}>
                        <div style={{ padding: 8, borderBottom: `1px solid ${C.border}`, background: C.bg }}>
                          <input autoFocus value={listFilter} onChange={(e) => setListFilter(e.target.value)}
                            placeholder={`🔍 Filtrer parmi ${modelFields[f.def.model].length} champs…`}
                            style={{ width: "100%", boxSizing: "border-box", padding: "7px 9px", border: `1px solid ${C.border}`, borderRadius: 7, fontSize: 12.5, fontFamily: "inherit" }} />
                        </div>
                        <div style={{ maxHeight: 220, overflowY: "auto" }}>
                          {opts.map((o) => (
                            <button key={o.name} onClick={() => pickField(key, o.name)}
                              style={{ display: "flex", alignItems: "baseline", gap: 8, width: "100%", textAlign: "left", padding: "8px 11px", border: "none", borderBottom: `1px solid ${C.bg}`, background: o.name === val ? C.blueSoft : C.white, cursor: "pointer", fontFamily: "inherit" }}>
                              <span style={{ fontSize: 12.5, fontFamily: "monospace", fontWeight: 700, color: C.text }}>{o.name}</span>
                              <span style={{ fontSize: 11, color: C.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o.label}</span>
                              <span style={{ marginLeft: "auto", flexShrink: 0, fontSize: 10, color: C.textMuted, background: C.bg, padding: "1px 6px", borderRadius: 99 }}>{o.type}</span>
                            </button>
                          ))}
                          {!opts.length && <div style={{ padding: 14, textAlign: "center", color: C.textMuted, fontSize: 12 }}>Aucun champ ne correspond.</div>}
                        </div>
                      </div>
                    );
                  })()}
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
