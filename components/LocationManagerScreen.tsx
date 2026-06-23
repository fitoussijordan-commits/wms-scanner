"use client";
import { useState, useEffect, useMemo } from "react";
import * as odoo from "@/lib/odoo";
import { PutawayTab } from "@/components/ArticleCreatorScreen";

const C = {
  bg: "#f8fafc", white: "#ffffff", text: "#1a1a2e", textSec: "#374151",
  textMuted: "#6b7280", border: "#e5e7eb", blue: "#3b82f6", blueSoft: "#eff6ff",
  green: "#22c55e", greenSoft: "#f0fdf4", red: "#ef4444", redSoft: "#fef2f2",
  orange: "#f97316", orangeSoft: "#fff7ed", purple: "#7c3aed", purpleSoft: "#f5f3ff",
  shadow: "0 1px 4px rgba(0,0,0,0.07)",
};

interface Loc {
  id: number;
  name: string;
  complete_name: string;
  barcode: string | false;
  usage: string;
  location_id: [number, string] | false;
}

interface Props {
  session: odoo.OdooSession;
  onBack: () => void;
  onToast: (msg: string, type?: "success" | "error" | "info") => void;
  // imprime l'étiquette emplacement (relié à requestPrint dans page.tsx)
  onPrintLocation: (name: string, barcode: string) => void;
}

export default function LocationManagerScreen({ session, onBack, onToast, onPrintLocation }: Props) {
  const [tab, setTab] = useState<"locations" | "putaway">("locations");
  const [locs, setLocs] = useState<Loc[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  // formulaire de création (rempli par duplication)
  const [form, setForm] = useState<{ name: string; barcode: string; parentId: number; parentName: string; usage: string } | null>(null);
  const [creating, setCreating] = useState(false);
  // suggestion de création de voisins (ex: A12 → A10,A11,A13)
  const [suggestFor, setSuggestFor] = useState<Loc | null>(null);
  const [suggestRange, setSuggestRange] = useState({ from: "10", to: "13" });
  const [bulkCreating, setBulkCreating] = useState(false);

  const load = async () => {
    setLoading(true);
    try { setLocs(await odoo.getLocations(session) as Loc[]); }
    catch (e: any) { onToast("Erreur chargement : " + e.message, "error"); }
    setLoading(false);
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return locs;
    return locs.filter(l =>
      l.name.toLowerCase().includes(q) ||
      (l.complete_name || "").toLowerCase().includes(q) ||
      (l.barcode ? String(l.barcode).toLowerCase().includes(q) : false)
    );
  }, [locs, search]);

  // Duplique un emplacement → pré-remplit le formulaire (parent = même parent).
  const duplicate = (l: Loc) => {
    const parentId = Array.isArray(l.location_id) ? l.location_id[0] : 0;
    const parentName = Array.isArray(l.location_id) ? l.location_id[1] : "(racine)";
    setForm({
      name: l.name,
      barcode: l.barcode ? String(l.barcode) : "",
      parentId,
      parentName,
      usage: l.usage || "internal",
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const create = async () => {
    if (!form) return;
    if (!form.name.trim()) { onToast("Nom requis", "error"); return; }
    if (!form.parentId) { onToast("Emplacement parent manquant", "error"); return; }
    setCreating(true);
    try {
      // garde-fou doublon code-barres
      if (form.barcode.trim()) {
        const exists = await odoo.locationBarcodeExists(session, form.barcode.trim());
        if (exists) { onToast("Ce code-barres existe déjà", "error"); setCreating(false); return; }
      }
      const id = await odoo.createLocation(session, {
        name: form.name, barcode: form.barcode, parentId: form.parentId, usage: form.usage,
      });
      onToast(`Emplacement « ${form.name} » créé ✓`, "success");
      const createdName = form.name.trim();
      const createdBarcode = (form.barcode || form.name).trim();
      setForm(null);
      await load();
      // impression proposée juste après création
      if (typeof window !== "undefined" && window.confirm(`Imprimer l'étiquette de « ${createdName} » ?`)) {
        onPrintLocation(createdName, createdBarcode);
      }
      void id;
    } catch (e: any) {
      onToast("Erreur création : " + (e?.message || String(e)), "error");
    }
    setCreating(false);
  };

  // ── Suggestion de voisins : A12 → préfixe "A", numéro 12. On propose les
  //    numéros de l'étage (from..to) qui n'existent pas encore. ──
  const parseLoc = (name: string): { prefix: string; num: number } | null => {
    const m = name.match(/^(.*?)(\d+)\s*$/); // tout sauf le nombre final + nombre final
    if (!m) return null;
    return { prefix: m[1], num: parseInt(m[2], 10) };
  };
  const suggestions = useMemo(() => {
    if (!suggestFor) return [] as { name: string; barcode: string }[];
    const base = parseLoc(suggestFor.name);
    if (!base) return [];
    const from = parseInt(suggestRange.from, 10), to = parseInt(suggestRange.to, 10);
    if (Number.isNaN(from) || Number.isNaN(to) || to < from) return [];
    // largeur de numéro (A12 → 2 chiffres → on garde le même padding)
    const pad = String(base.num).length;
    const existing = new Set(locs.map(l => l.name.trim().toLowerCase()));
    const out: { name: string; barcode: string }[] = [];
    // motif du code-barres : on remplace le numéro dans le code-barres du cousin
    const cousinBc = suggestFor.barcode ? String(suggestFor.barcode) : suggestFor.name;
    for (let n = from; n <= to; n++) {
      if (n === base.num) continue; // le cousin lui-même
      const name = `${base.prefix}${String(n).padStart(pad, "0")}`;
      if (existing.has(name.toLowerCase())) continue; // déjà créé
      // code-barres : remplace le numéro du cousin par le nouveau
      const barcode = cousinBc.replace(String(base.num), String(n).padStart(pad, "0"));
      out.push({ name, barcode });
    }
    return out;
  }, [suggestFor, suggestRange, locs]);

  const openSuggest = (l: Loc) => {
    const base = parseLoc(l.name);
    if (!base) { onToast("Nom non numéroté — pas de voisins à proposer", "info"); return; }
    setSuggestFor(l);
    setSuggestRange({ from: "10", to: "13" });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const createSuggestions = async () => {
    if (!suggestFor || !suggestions.length) return;
    const parentId = Array.isArray(suggestFor.location_id) ? suggestFor.location_id[0] : 0;
    if (!parentId) { onToast("Parent introuvable", "error"); return; }
    if (!confirm(`Créer ${suggestions.length} emplacement(s) : ${suggestions.map(s => s.name).join(", ")} ?`)) return;
    setBulkCreating(true);
    let ok = 0;
    for (const s of suggestions) {
      try {
        const exists = await odoo.locationBarcodeExists(session, s.barcode);
        if (exists) continue;
        await odoo.createLocation(session, { name: s.name, barcode: s.barcode, parentId, usage: suggestFor.usage || "internal" });
        ok++;
      } catch {}
    }
    onToast(`${ok}/${suggestions.length} emplacement(s) créé(s) ✓`, "success");
    setSuggestFor(null);
    await load();
    setBulkCreating(false);
  };

  // Barre d'onglets
  const TabBar = (
    <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
      {([["locations", "Emplacements"], ["putaway", "Stratégie de rangement"]] as const).map(([k, label]) => (
        <button key={k} onClick={() => setTab(k)} style={{
          padding: "8px 16px", borderRadius: 10, border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 700,
          background: tab === k ? C.blue : C.white, color: tab === k ? "#fff" : C.textSec, boxShadow: tab === k ? "none" : `inset 0 0 0 1px ${C.border}`,
        }}>{label}</button>
      ))}
    </div>
  );

  return (
    <div style={{ paddingBottom: 90 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <button onClick={onBack} style={{ background: C.bg, border: "none", borderRadius: 10, padding: 8, cursor: "pointer", display: "flex" }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={C.text} strokeWidth="2"><path d="M19 12H5M12 5l-7 7 7 7" /></svg>
        </button>
        <div>
          <div style={{ fontSize: 17, fontWeight: 800, color: C.text }}>Gestion emplacements</div>
          <div style={{ fontSize: 12, color: C.textMuted }}>Emplacements + stratégie de rangement</div>
        </div>
      </div>
      {TabBar}
      {tab === "putaway" && <PutawayTab session={session} onToast={onToast} />}
      {tab === "locations" && (
    <div>
      {/* Suggestion de création de voisins (ex: A12 → A10, A11, A13) */}
      {suggestFor && (
        <div style={{ background: C.white, border: `1.5px solid ${C.purple}`, borderRadius: 14, padding: 16, marginBottom: 16, boxShadow: `0 0 0 3px ${C.purpleSoft}` }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: C.purple, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>Créer les voisins de « {suggestFor.name} »</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, color: C.textMuted }}>Étages du n°</span>
            <input type="number" value={suggestRange.from} onChange={e => setSuggestRange(r => ({ ...r, from: e.target.value }))} style={{ ...inp, width: 64 }} />
            <span style={{ fontSize: 12, color: C.textMuted }}>au</span>
            <input type="number" value={suggestRange.to} onChange={e => setSuggestRange(r => ({ ...r, to: e.target.value }))} style={{ ...inp, width: 64 }} />
            <span style={{ fontSize: 11, color: C.textMuted }}>(même parent / type / base que {suggestFor.name})</span>
          </div>
          {suggestions.length === 0 ? (
            <div style={{ fontSize: 12, color: C.textMuted }}>Aucun voisin manquant sur cette plage.</div>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
              {suggestions.map(s => (
                <span key={s.name} style={{ fontSize: 12, fontWeight: 700, fontFamily: "monospace", background: C.purpleSoft, color: C.purple, borderRadius: 8, padding: "4px 10px" }}>{s.name}</span>
              ))}
            </div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={createSuggestions} disabled={bulkCreating || !suggestions.length}
              style={{ flex: 1, padding: "10px 0", background: suggestions.length ? C.purple : C.border, color: "#fff", border: "none", borderRadius: 10, fontWeight: 800, fontSize: 13, cursor: "pointer", fontFamily: "inherit", opacity: bulkCreating ? 0.6 : 1 }}>
              {bulkCreating ? "Création…" : `Créer ${suggestions.length} emplacement(s)`}
            </button>
            <button onClick={() => setSuggestFor(null)} style={{ padding: "10px 16px", background: C.white, color: C.textSec, border: `1.5px solid ${C.border}`, borderRadius: 10, fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>Annuler</button>
          </div>
        </div>
      )}

      {/* Formulaire de création (apparaît après duplication) */}
      {form && (
        <div style={{ background: C.white, border: `1.5px solid ${C.blue}`, borderRadius: 14, padding: 16, marginBottom: 16, boxShadow: `0 0 0 3px ${C.blueSoft}` }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: C.blue, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 12 }}>Nouvel emplacement</div>
          <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 10 }}>Parent : <b style={{ color: C.text }}>{form.parentName}</b> · type : {form.usage}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div>
              <label style={lbl}>Nom *</label>
              <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} autoFocus
                style={inp} placeholder="Ex: A13" />
            </div>
            <div>
              <label style={lbl}>Code-barres</label>
              <input value={form.barcode} onChange={e => setForm({ ...form, barcode: e.target.value })}
                style={{ ...inp, fontFamily: "monospace" }} placeholder="Ex: B-A13" />
              <div style={{ fontSize: 11, color: C.textMuted, marginTop: 3 }}>Laisse vide pour utiliser le nom comme code-barres.</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <button onClick={create} disabled={creating}
              style={{ flex: 1, padding: "11px 0", background: C.green, color: "#fff", border: "none", borderRadius: 10, fontWeight: 800, fontSize: 14, cursor: "pointer", fontFamily: "inherit", opacity: creating ? 0.6 : 1 }}>
              {creating ? "Création…" : "Créer l'emplacement"}
            </button>
            <button onClick={() => setForm(null)} disabled={creating}
              style={{ padding: "11px 18px", background: C.white, color: C.textSec, border: `1.5px solid ${C.border}`, borderRadius: 10, fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: "inherit" }}>
              Annuler
            </button>
          </div>
        </div>
      )}

      {/* Recherche */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="🔍 Rechercher un emplacement (nom, chemin, code-barres)…"
          style={{ flex: 1, minWidth: 0, padding: "9px 12px", border: `1.5px solid ${C.border}`, borderRadius: 10, fontSize: 13, fontFamily: "inherit", background: C.white, color: C.text, outline: "none", boxSizing: "border-box" }} />
        {search && <button onClick={() => setSearch("")} style={{ padding: "9px 12px", background: C.white, border: `1.5px solid ${C.border}`, borderRadius: 10, fontSize: 12, cursor: "pointer", color: C.textMuted }}>✕</button>}
        <button onClick={load} title="Recharger" style={{ padding: "9px 12px", background: C.white, border: `1.5px solid ${C.border}`, borderRadius: 10, fontSize: 13, cursor: "pointer", color: C.textSec, fontFamily: "inherit" }}>↻</button>
      </div>

      {loading ? (
        <div style={{ textAlign: "center", padding: 40, color: C.textMuted, fontSize: 14 }}>Chargement…</div>
      ) : (
        <>
          <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 8 }}>{filtered.length} emplacement{filtered.length > 1 ? "s" : ""}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {filtered.map(l => (
              <div key={l.id} style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 12, padding: "11px 14px", boxShadow: C.shadow, display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{l.name}</div>
                  <div style={{ fontSize: 11, color: C.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.complete_name}</div>
                  {l.barcode && <div style={{ fontSize: 11, fontFamily: "monospace", color: C.blue, marginTop: 1 }}>{l.barcode}</div>}
                </div>
                <button onClick={() => openSuggest(l)} title="Proposer les voisins manquants (A12 → A10, A11, A13)"
                  style={{ padding: "6px 12px", background: C.purpleSoft, color: C.purple, border: `1px solid ${C.purple}44`, borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", flexShrink: 0 }}>
                  + Voisins
                </button>
                <button onClick={() => duplicate(l)} title="Dupliquer"
                  style={{ padding: "6px 12px", background: C.blueSoft, color: C.blue, border: `1px solid ${C.blue}44`, borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", flexShrink: 0 }}>
                  Dupliquer
                </button>
                <button onClick={() => onPrintLocation(l.name, l.barcode ? String(l.barcode) : l.name)} title="Imprimer l'étiquette"
                  style={{ padding: "6px 10px", background: C.bg, color: C.textSec, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 13, cursor: "pointer", fontFamily: "inherit", flexShrink: 0 }}>
                  🖨
                </button>
              </div>
            ))}
            {!filtered.length && <div style={{ textAlign: "center", padding: 30, color: C.textMuted, fontSize: 13 }}>Aucun emplacement</div>}
          </div>
        </>
      )}
    </div>
      )}
    </div>
  );
}

const lbl: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em", display: "block", marginBottom: 5 };
const inp: React.CSSProperties = { width: "100%", boxSizing: "border-box", padding: "10px 12px", border: "1.5px solid #e5e7eb", borderRadius: 10, fontSize: 14, fontFamily: "inherit", background: "#f8fafc", color: "#1a1a2e", outline: "none" };
