"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import * as odoo from "@/lib/odoo";

// ─── Données de codification (extraites du fichier Excel _Listes) ─────────────

const CATEGORIES = [
  { code: "1",  label: "Vente" },
  { code: "2",  label: "Cabine" },
  { code: "3",  label: "Testeur" },
  { code: "4",  label: "Miniature" },
  { code: "5",  label: "Echantillon" },
  { code: "6",  label: "PLV" },
  { code: "7",  label: "Offres" },
  { code: "8",  label: "Gratuité Allemagne" },
  { code: "9",  label: "Présentoir plein" },
  { code: "AV", label: "Article suivi offres" },
  { code: "90", label: "Matériel Animatrice" },
  { code: "91", label: "Formation" },
];

const FAMILLES = [
  { code: 1,  label: "Visage" },
  { code: 2,  label: "Régénérant" },
  { code: 3,  label: "Corps" },
  { code: 4,  label: "Hygiène" },
  { code: 5,  label: "Med" },
  { code: 6,  label: "Maquillage" },
  { code: 7,  label: "Produits WALA" },
  { code: 8,  label: "Accessoire - utilitaire" },
  { code: 9,  label: "Prestation Maison Dr. Hauschka" },
  { code: 10, label: "Formation" },
  { code: 11, label: "Produits Maison Dr. Hauschka" },
  { code: 12, label: "Matériel commercial-animatrice" },
  { code: 13, label: "Visage & Régénérant" },
  { code: 81, label: "ACHATS MARKETING VISAGE" },
  { code: 82, label: "ACHATS MARKETING RÉGÉNÉRANT" },
  { code: 83, label: "ACHATS MARKETING CORPS" },
  { code: 84, label: "ACHATS MARKETING HYGIÈNE" },
  { code: 85, label: "ACHATS MARKETING MED" },
  { code: 86, label: "ACHATS MARKETING MAQUILLAGE" },
];

const SOUS_FAMILLES: Record<number, { code: number; label: string }[]> = {
  1:  [{ code:1,label:"Nettoyant"},{code:2,label:"Stimulant"},{code:3,label:"Crème de jour"},{code:4,label:"Stick correcteur"},{code:5,label:"Soins des yeux"},{code:6,label:"Soins des lèvres"},{code:7,label:"Soins Intensifs"},{code:8,label:"Soin Nuit"},{code:10,label:"Coffrets"}],
  2:  [{ code:1,label:"Lait et Crème"},{code:2,label:"Stimulant"},{code:3,label:"Crème de jour"},{code:4,label:"Soins des yeux / Lèvres"},{code:7,label:"Soins Intensifs"},{code:10,label:"Coffrets"}],
  3:  [{ code:1,label:"Corps"},{code:2,label:"Huile de soin"},{code:3,label:"Soins des mains-ongles"},{code:4,label:"Soins des pieds-jambes"},{code:5,label:"Solaire"},{code:6,label:"Poudre"},{code:7,label:"Déodorant"},{code:10,label:"Coffrets"}],
  4:  [{ code:1,label:"Crème douche"},{code:2,label:"Bain"},{code:3,label:"Capillaire"},{code:10,label:"Coffret"}],
  5:  [{ code:1,label:"Lait et Crème"},{code:2,label:"Crème de jour"},{code:3,label:"Soins des yeux / Lèvres"},{code:4,label:"Dentaire"},{code:5,label:"Capillaire"}],
  6:  [{ code:1,label:"Mascaras"},{code:2,label:"Rouge à lèvres / Lipstick"},{code:3,label:"Gloss"},{code:4,label:"Crayons à lèvres / Lipliner"},{code:5,label:"Crayons Kajal / Kajal eyeliner"},{code:6,label:"Eyeliner"},{code:7,label:"Fards à joues / Rouge powder"},{code:8,label:"Poudre / Powder"},{code:9,label:"Correcteurs / Concealer"},{code:10,label:"Fond de teint / Make up"},{code:11,label:"Ombres à paupières / Eyeshadow"},{code:12,label:"Accessoires maquillage"},{code:13,label:"Offres Ephémères"},{code:14,label:"Pack Offres Ephémères"}],
  7:  [{ code:1,label:"Bitter"},{code:2,label:"Dragées"}],
  8:  [{ code:1,label:"Eponge"},{code:2,label:"Bouchon"},{code:3,label:"Pinceau"},{code:4,label:"Linge"}],
  9:  [{ code:1,label:"SOINS VISAGE"},{code:2,label:"SOINS CORPS"},{code:3,label:"JOURNÉES D'ANIMATION"},{code:4,label:"JOURNÉES D'INFO"},{code:5,label:"SOINS BEAUTÉ CORPS"},{code:6,label:"FORFAIT SOINS VISAGE+CORPS"},{code:7,label:"ATELIERS"}],
  10: [{ code:1,label:"Formations Bio-esthéticienne"},{code:2,label:"Formations Revendeur"}],
  11: [{ code:1,label:"ARTICLES DIVERS MAISON HAUSCHKA"},{code:2,label:"ÉPICERIE"}],
  12: [{ code:1,label:"MATÉRIEL D'ANIMATION"},{code:2,label:"MATÉRIEL FORMATION"}],
  13: [],
  81: [], 82: [], 83: [], 84: [], 85: [], 86: [],
};

// ─── Logique de génération de code ────────────────────────────────────────────

function buildPrefix(catCode: string, famCode: number, sfCode: number): string {
  return `${catCode}${String(famCode).padStart(2, "0")}${String(sfCode).padStart(2, "0")}`;
}

function computeNextSeq(existingCodes: string[], prefix: string): number {
  let max = 0;
  for (const code of existingCodes) {
    if (!code.startsWith(prefix)) continue;
    const suffix = code.slice(prefix.length);
    const n = parseInt(suffix, 10);
    if (!isNaN(n) && n > max) max = n;
  }
  return max + 1;
}

// ─── Styles locaux ────────────────────────────────────────────────────────────

const S = {
  screen:  { minHeight: "100dvh", background: "#f8f9fb", display: "flex", flexDirection: "column" as const },
  header:  { display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", background: "#fff", borderBottom: "1px solid #e5e7eb" },
  backBtn: { background: "none", border: "none", cursor: "pointer", padding: 6, display: "flex", alignItems: "center", color: "#6b7280" },
  title:   { fontSize: 16, fontWeight: 700, color: "#111827", margin: 0 },
  body:    { flex: 1, padding: "16px", display: "flex", flexDirection: "column" as const, gap: 12, maxWidth: 620, width: "100%", margin: "0 auto" },
  card:    { background: "#fff", borderRadius: 12, padding: "14px 16px", border: "1px solid #e5e7eb" },
  label:   { fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", color: "#6b7280", textTransform: "uppercase" as const, marginBottom: 4, display: "block" },
  select:  { width: "100%", border: "1px solid #d1d5db", borderRadius: 8, padding: "9px 10px", fontSize: 14, color: "#111827", background: "#fff", fontFamily: "inherit", outline: "none" },
  input:   { width: "100%", border: "1px solid #d1d5db", borderRadius: 8, padding: "9px 10px", fontSize: 14, color: "#111827", fontFamily: "inherit", outline: "none", boxSizing: "border-box" as const },
  codeBox: { borderRadius: 12, padding: "16px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 },
  codeTxt: { fontSize: 28, fontWeight: 800, letterSpacing: "0.1em", fontFamily: "monospace" },
  badge:   (ok: boolean) => ({ display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 10px", borderRadius: 99, fontSize: 12, fontWeight: 600, background: ok ? "#dcfce7" : "#fee2e2", color: ok ? "#166534" : "#991b1b" }),
  btn:     { width: "100%", padding: "14px", borderRadius: 10, border: "none", cursor: "pointer", fontSize: 15, fontWeight: 700, fontFamily: "inherit" },
  field:   { display: "flex", flexDirection: "column" as const, gap: 4 },
  row:     { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 },
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface ThresholdRow {
  id: number;
  default_code: string;
  name: string;
  currentVal: number;
  newVal: string;   // string pour édition libre
  saved: boolean;
  error?: string;
}

// ─── Composant principal ──────────────────────────────────────────────────────

interface Props {
  session: odoo.OdooSession;
  onBack: () => void;
  onToast: (msg: string, type?: "success" | "error" | "info") => void;
  initialTab?: "creation" | "seuils";
}

export default function ArticleCreatorScreen({ session, onBack, onToast, initialTab = "creation" }: Props) {
  const [tab, setTab] = useState<"creation" | "seuils" | "nonvendable">(initialTab);

  const TAB_LABELS: Record<string, string> = {
    creation: "Création article",
    seuils: "Seuils d'alerte",
    nonvendable: "Stock non vendable",
  };

  return (
    <div style={S.screen}>
      {/* Header */}
      <div style={S.header}>
        <button style={S.backBtn} onClick={onBack}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <p style={S.title}>Gestion articles</p>
      </div>

      {/* Onglets */}
      <div style={{ display: "flex", background: "#fff", borderBottom: "1px solid #e5e7eb", padding: "0 16px", overflowX: "auto" }}>
        {(["creation", "seuils", "nonvendable"] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              background: "none", border: "none", cursor: "pointer", padding: "12px 16px",
              fontSize: 13, fontWeight: 600, fontFamily: "inherit", whiteSpace: "nowrap",
              color: tab === t ? "#2563eb" : "#6b7280",
              borderBottom: tab === t ? "2px solid #2563eb" : "2px solid transparent",
              marginBottom: -1,
            }}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      {tab === "creation"
        ? <CreationTab session={session} onToast={onToast} />
        : tab === "seuils"
        ? <SeuilsTab   session={session} onToast={onToast} />
        : <NonVendableTab session={session} onToast={onToast} />
      }
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ONGLET CRÉATION (code original inchangé)
// ═══════════════════════════════════════════════════════════════════════════════

export function CreationTab({ session, onToast }: { session: odoo.OdooSession; onToast: (msg: string, type?: "success"|"error"|"info") => void }) {
  const [catCode,  setCatCode]  = useState("1");
  const [famCode,  setFamCode]  = useState(1);
  const [sfCode,   setSfCode]   = useState(1);
  const [designation, setDesignation] = useState("");
  const [barcode,     setBarcode]     = useState("");
  const [uomId,       setUomId]       = useState<number | null>(null);
  const [tracking,    setTracking]    = useState<"none"|"lot"|"serial">("lot");
  const [weight,      setWeight]      = useState("");
  const [uoms,         setUoms]         = useState<{ id: number; name: string }[]>([]);
  const [existingCodes, setExistingCodes] = useState<string[]>([]);
  const [loadingCodes,  setLoadingCodes]  = useState(false);
  const [creating,      setCreating]      = useState(false);
  const [created,       setCreated]       = useState<{ id: number; code: string; name: string } | null>(null);

  const availableSFs = SOUS_FAMILLES[famCode] || [];
  const prefix  = buildPrefix(catCode, famCode, sfCode);
  const nextSeq = computeNextSeq(existingCodes, prefix);
  const generatedCode = `${prefix}${String(nextSeq).padStart(2, "0")}`;
  const isAvailable = !existingCodes.includes(generatedCode);

  useEffect(() => {
    odoo.getUoMs(session).then(list => {
      setUoms(list);
      const pce = list.find(u => /unit|pce|pièce|unité/i.test(u.name));
      if (pce) setUomId(pce.id);
      else if (list.length) setUomId(list[0].id);
    }).catch(() => {});
  }, [session]);

  const loadCodes = useCallback(async () => {
    setLoadingCodes(true);
    try {
      const codes = await odoo.getProductsByCodePrefix(session, prefix);
      setExistingCodes(codes);
    } catch {
      setExistingCodes([]);
    } finally {
      setLoadingCodes(false);
    }
  }, [session, prefix]);

  useEffect(() => { loadCodes(); }, [loadCodes]);

  useEffect(() => {
    const sfs = SOUS_FAMILLES[famCode] || [];
    if (sfs.length) setSfCode(sfs[0].code);
  }, [famCode]);

  const handleCreate = async () => {
    if (!designation.trim()) { onToast("Désignation requise", "error"); return; }
    if (!uomId) { onToast("Unité de mesure requise", "error"); return; }
    if (!isAvailable) { onToast("Code non disponible", "error"); return; }
    setCreating(true);
    try {
      const id = await odoo.createProductTemplate(session, {
        name: designation.trim(),
        default_code: generatedCode,
        barcode: barcode.trim() || undefined,
        uom_id: uomId,
        tracking,
        weight: weight ? parseFloat(weight) : undefined,
      });
      setCreated({ id, code: generatedCode, name: designation.trim() });
      onToast(`Article ${generatedCode} créé dans Odoo ✓`, "success");
      setDesignation(""); setBarcode(""); setWeight("");
      loadCodes();
    } catch (e: any) {
      onToast(`Erreur : ${e.message}`, "error");
    } finally {
      setCreating(false);
    }
  };

  const catLabel = CATEGORIES.find(c => c.code === catCode)?.label || "";
  const famLabel = FAMILLES.find(f => f.code === famCode)?.label || "";
  const sfLabel  = availableSFs.find(s => s.code === sfCode)?.label || "";

  return (
    <div style={S.body}>
      <div style={{ ...S.codeBox, background: isAvailable ? "#f0fdf4" : "#fff7ed", border: `1.5px solid ${isAvailable ? "#bbf7d0" : "#fed7aa"}` }}>
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>Code généré</div>
          <div style={{ ...S.codeTxt, color: isAvailable ? "#166534" : "#9a3412" }}>{loadingCodes ? "…" : generatedCode}</div>
          <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2 }}>{catLabel} · {famLabel} · {sfLabel}</div>
        </div>
        <span style={S.badge(isAvailable)}>{isAvailable ? "✅ Disponible" : "❌ Doublon"}</span>
      </div>

      {created && (
        <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 10, padding: "10px 14px", fontSize: 13, color: "#166534" }}>
          ✓ <b>{created.code}</b> — {created.name} créé dans Odoo (ID {created.id})
        </div>
      )}

      <div style={S.card}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 12 }}>Codification</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={S.field}>
            <label style={S.label}>Catégorie</label>
            <select style={S.select} value={catCode} onChange={e => setCatCode(e.target.value)}>
              {CATEGORIES.map(c => <option key={c.code} value={c.code}>{c.code} — {c.label}</option>)}
            </select>
          </div>
          <div style={S.field}>
            <label style={S.label}>Famille</label>
            <select style={S.select} value={famCode} onChange={e => setFamCode(Number(e.target.value))}>
              {FAMILLES.map(f => <option key={f.code} value={f.code}>{String(f.code).padStart(2,"0")} — {f.label}</option>)}
            </select>
          </div>
          {availableSFs.length > 0 && (
            <div style={S.field}>
              <label style={S.label}>Sous-famille</label>
              <select style={S.select} value={sfCode} onChange={e => setSfCode(Number(e.target.value))}>
                {availableSFs.map(s => <option key={s.code} value={s.code}>{String(s.code).padStart(2,"0")} — {s.label}</option>)}
              </select>
            </div>
          )}
        </div>
      </div>

      <div style={S.card}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 12 }}>Informations produit</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={S.field}>
            <label style={S.label}>Désignation complète *</label>
            <input style={S.input} placeholder="ex: Crème de Jour Apaisante - 30 ml" value={designation} onChange={e => setDesignation(e.target.value)} />
          </div>
          <div style={S.field}>
            <label style={S.label}>EAN / Code-barre (optionnel)</label>
            <input style={S.input} placeholder="ex: 4020829001234" value={barcode} onChange={e => setBarcode(e.target.value)} />
          </div>
          <div style={S.row}>
            <div style={S.field}>
              <label style={S.label}>Unité de mesure *</label>
              <select style={S.select} value={uomId ?? ""} onChange={e => setUomId(Number(e.target.value))}>
                {uoms.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </div>
            <div style={S.field}>
              <label style={S.label}>Suivi</label>
              <select style={S.select} value={tracking} onChange={e => setTracking(e.target.value as any)}>
                <option value="lot">Par lot</option>
                <option value="serial">Par N° série</option>
                <option value="none">Sans suivi</option>
              </select>
            </div>
          </div>
          <div style={S.field}>
            <label style={S.label}>Poids (kg, optionnel)</label>
            <input style={S.input} placeholder="ex: 0.150" type="number" step="0.001" value={weight} onChange={e => setWeight(e.target.value)} />
          </div>
        </div>
      </div>

      <button
        style={{ ...S.btn, background: isAvailable && designation.trim() && uomId ? "#2563eb" : "#e5e7eb", color: isAvailable && designation.trim() && uomId ? "#fff" : "#9ca3af" }}
        onClick={handleCreate}
        disabled={creating || !isAvailable || !designation.trim() || !uomId}
      >
        {creating ? "Création en cours…" : `Créer ${generatedCode} dans Odoo`}
      </button>

      {existingCodes.length > 0 && (
        <div style={{ ...S.card, background: "#f9fafb" }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
            Codes existants ({existingCodes.length}) — préfixe {prefix}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 6 }}>
            {existingCodes.sort().map(c => (
              <span key={c} style={{ fontFamily: "monospace", fontSize: 12, background: "#e5e7eb", padding: "2px 8px", borderRadius: 6, color: "#374151" }}>{c}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ONGLET SEUILS D'ALERTE — redesign complet
// ═══════════════════════════════════════════════════════════════════════════════

export function SeuilsTab({ session, onToast }: { session: odoo.OdooSession; onToast: (msg: string, type?: "success"|"error"|"info") => void }) {
  const [query,        setQuery]        = useState("");
  const [suggestions,  setSuggestions]  = useState<{ id: number; default_code: string; name: string; temp_min_quantity: number }[]>([]);
  const [dropOpen,     setDropOpen]     = useState(false);
  const [searching,    setSearching]    = useState(false);
  const [rows,         setRows]         = useState<ThresholdRow[]>([]);
  const [saving,       setSaving]       = useState(false);
  const [bulkOpen,     setBulkOpen]     = useState(false);
  const [bulkText,     setBulkText]     = useState("");
  const [bulkLoading,  setBulkLoading]  = useState(false);
  const [notFound,     setNotFound]     = useState<string[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const changedRows = rows.filter(r => r.newVal.trim() !== "" && r.newVal.trim() !== String(r.currentVal) && !r.saved);
  const savedCount  = rows.filter(r => r.saved).length;

  /* ── Autocomplete ── */
  const handleQueryChange = (val: string) => {
    setQuery(val);
    setDropOpen(false);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (val.trim().length < 2) { setSuggestions([]); return; }
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await odoo.searchProductsByQuery(session, val.trim(), 15);
        setSuggestions(res);
        setDropOpen(res.length > 0);
      } catch { setSuggestions([]); }
      finally { setSearching(false); }
    }, 320);
  };

  /* ── Ajouter un article depuis le dropdown ── */
  const addRow = (p: { id: number; default_code: string; name: string; temp_min_quantity: number }) => {
    setDropOpen(false);
    setQuery("");
    setSuggestions([]);
    if (rows.find(r => r.id === p.id)) { onToast("Article déjà dans la liste", "info"); return; }
    setRows(prev => [{ id: p.id, default_code: p.default_code, name: p.name, currentVal: p.temp_min_quantity, newVal: "", saved: false }, ...prev]);
  };

  /* ── Import en masse ── */
  function parseBulk(raw: string): { ref: string; qty?: number }[] {
    return raw.split("\n").map(l => l.trim()).filter(Boolean).map(line => {
      const tokens = line.split(/[\s\t]+/);
      const ref    = tokens[0];
      const last   = parseFloat(tokens[tokens.length - 1]);
      return { ref, qty: tokens.length > 1 && !isNaN(last) ? last : undefined };
    });
  }

  const handleBulkImport = async () => {
    const parsed = parseBulk(bulkText);
    if (!parsed.length) { onToast("Aucune référence saisie", "error"); return; }
    setBulkLoading(true);
    setNotFound([]);
    try {
      const refs    = parsed.map(p => p.ref);
      const products = await odoo.searchProductsForThreshold(session, refs);
      const qtyMap  = new Map(parsed.map(p => [p.ref.toLowerCase(), p.qty]));
      const newRows: ThresholdRow[] = products
        .filter(p => !rows.find(r => r.id === p.id))
        .map(p => ({
          id: p.id, default_code: p.default_code, name: p.name,
          currentVal: p.temp_min_quantity,
          newVal: qtyMap.get(p.default_code.toLowerCase()) !== undefined ? String(qtyMap.get(p.default_code.toLowerCase())) : "",
          saved: false,
        }));
      const foundCodes = new Set(products.map(p => p.default_code.toLowerCase()));
      setNotFound(parsed.filter(p => !foundCodes.has(p.ref.toLowerCase())).map(p => p.ref));
      setRows(prev => [...newRows, ...prev]);
      if (newRows.length) {
        onToast(`${newRows.length} article(s) ajouté(s)`, "success");
        setBulkText("");
        setBulkOpen(false);
      } else {
        onToast("Aucun nouvel article trouvé", "error");
      }
    } catch (e: any) {
      onToast(`Erreur : ${e.message}`, "error");
    } finally {
      setBulkLoading(false);
    }
  };

  /* ── Édition d'une ligne ── */
  const updateRow = (id: number, val: string) =>
    setRows(prev => prev.map(r => r.id === id ? { ...r, newVal: val, saved: false } : r));

  const removeRow = (id: number) =>
    setRows(prev => prev.filter(r => r.id !== id));

  /* ── Sauvegarde ── */
  const handleSaveAll = async () => {
    const toSave = rows.filter(r => r.newVal.trim() !== "" && !r.saved);
    if (!toSave.length) { onToast("Aucune modification à enregistrer", "error"); return; }
    setSaving(true);
    try {
      const updates = toSave.map(r => ({ id: r.id, value: parseFloat(r.newVal) || 0 }));
      await odoo.bulkUpdateMinQuantity(session, updates);
      setRows(prev => prev.map(r => {
        const u = updates.find(u => u.id === r.id);
        if (!u) return r;
        return { ...r, currentVal: u.value, newVal: "", saved: true };
      }));
      onToast(`${toSave.length} seuil(s) mis à jour ✓`, "success");
    } catch (e: any) {
      onToast(`Erreur sauvegarde : ${e.message}`, "error");
    } finally {
      setSaving(false);
    }
  };

  /* ── Render ── */
  return (
    <div style={{ ...S.body, maxWidth: 720, paddingBottom: 32 }}>

      {/* ── Barre de recherche principale ── */}
      <div style={{ position: "relative" }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", background: "#fff", border: "1.5px solid #d1d5db", borderRadius: 12, padding: "10px 14px", boxShadow: "0 1px 4px rgba(0,0,0,0.06)" }}>
          {/* icône loupe */}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2.2" style={{ flexShrink: 0 }}>
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
          </svg>
          <input
            style={{ flex: 1, border: "none", outline: "none", fontSize: 14, color: "#111827", background: "transparent", fontFamily: "inherit" }}
            placeholder="Rechercher un article par référence ou nom…"
            value={query}
            onChange={e => handleQueryChange(e.target.value)}
            onFocus={() => suggestions.length > 0 && setDropOpen(true)}
            onBlur={() => setTimeout(() => setDropOpen(false), 160)}
          />
          {searching && (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2" style={{ flexShrink: 0, animation: "spin 1s linear infinite" }}>
              <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
            </svg>
          )}
        </div>

        {/* Dropdown suggestions */}
        {dropOpen && suggestions.length > 0 && (
          <div style={{
            position: "absolute", top: "calc(100% + 6px)", left: 0, right: 0, zIndex: 100,
            background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12,
            boxShadow: "0 8px 24px rgba(0,0,0,0.12)", overflow: "hidden",
          }}>
            {suggestions.map((s, i) => (
              <div
                key={s.id}
                onMouseDown={() => addRow(s)}
                style={{
                  display: "flex", alignItems: "center", gap: 12, padding: "10px 14px",
                  cursor: "pointer", borderBottom: i < suggestions.length - 1 ? "1px solid #f3f4f6" : undefined,
                  transition: "background 0.1s",
                }}
                onMouseEnter={e => (e.currentTarget.style.background = "#f8f9fb")}
                onMouseLeave={e => (e.currentTarget.style.background = "#fff")}
              >
                <span style={{ fontFamily: "monospace", fontSize: 12, fontWeight: 700, color: "#2563eb", background: "#eff6ff", padding: "2px 7px", borderRadius: 6, flexShrink: 0 }}>
                  {s.default_code || "—"}
                </span>
                <span style={{ fontSize: 13, color: "#374151", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {s.name}
                </span>
                <span style={{ fontSize: 11, color: "#9ca3af", flexShrink: 0 }}>
                  seuil : <b style={{ color: "#374151" }}>{s.temp_min_quantity}</b>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Import en masse (collapsible) ── */}
      <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, overflow: "hidden" }}>
        <button
          onClick={() => setBulkOpen(v => !v)}
          style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "11px 14px", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit" }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
              <line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
            </svg>
            <span style={{ fontSize: 13, fontWeight: 600, color: "#374151" }}>Import en masse</span>
            <span style={{ fontSize: 11, color: "#9ca3af" }}>— coller plusieurs références d'un coup</span>
          </div>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2" style={{ transform: bulkOpen ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s" }}>
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>

        {bulkOpen && (
          <div style={{ padding: "0 14px 14px" }}>
            <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 8 }}>
              1 référence par ligne — optionnel : <code style={{ background: "#f3f4f6", padding: "1px 5px", borderRadius: 4, fontSize: 11 }}>10020101 5</code> pour inclure le seuil directement.
            </div>
            <textarea
              style={{ ...S.input, height: 100, resize: "vertical", fontFamily: "monospace", fontSize: 12 }}
              placeholder={"10020101 5\n10020102 10\n10020103"}
              value={bulkText}
              onChange={e => setBulkText(e.target.value)}
            />
            <button
              style={{ ...S.btn, marginTop: 8, background: bulkText.trim() ? "#2563eb" : "#e5e7eb", color: bulkText.trim() ? "#fff" : "#9ca3af", fontSize: 13 }}
              onClick={handleBulkImport}
              disabled={bulkLoading || !bulkText.trim()}
            >
              {bulkLoading ? "Recherche…" : "Ajouter à la liste"}
            </button>
            {notFound.length > 0 && (
              <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap" as const, gap: 5 }}>
                {notFound.map(r => (
                  <span key={r} style={{ fontFamily: "monospace", fontSize: 11, background: "#fde68a", padding: "2px 7px", borderRadius: 5, color: "#92400e" }}>
                    ✗ {r}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── État vide ── */}
      {rows.length === 0 && (
        <div style={{ display: "flex", flexDirection: "column" as const, alignItems: "center", gap: 10, padding: "40px 20px", color: "#9ca3af", textAlign: "center" }}>
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#d1d5db" strokeWidth="1.5">
            <path d="M9 19v-6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2z"/>
            <path d="M15 5v14a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2z"/>
            <path d="M9 9H5M9 12H5"/>
          </svg>
          <p style={{ fontSize: 14, fontWeight: 600, color: "#6b7280", margin: 0 }}>Aucun article dans la liste</p>
          <p style={{ fontSize: 12, margin: 0 }}>Recherchez un article ci-dessus ou importez une liste en masse.</p>
        </div>
      )}

      {/* ── Tableau des articles ── */}
      {rows.length > 0 && (
        <>
          {/* Barre d'action */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <span style={{ fontSize: 12, color: "#6b7280" }}>
              <b style={{ color: "#374151" }}>{rows.length}</b> article(s)
              {changedRows.length > 0 && <> · <b style={{ color: "#2563eb" }}>{changedRows.length}</b> modifié(s)</>}
              {savedCount > 0 && <> · <b style={{ color: "#059669" }}>{savedCount}</b> enregistré(s)</>}
            </span>
            <button
              style={{
                padding: "9px 20px", borderRadius: 9, border: "none", cursor: "pointer",
                fontSize: 13, fontWeight: 700, fontFamily: "inherit",
                background: changedRows.length ? "#059669" : "#e5e7eb",
                color: changedRows.length ? "#fff" : "#9ca3af",
                transition: "background 0.2s",
              }}
              onClick={handleSaveAll}
              disabled={saving || !changedRows.length}
            >
              {saving ? "Enregistrement…" : `Enregistrer ${changedRows.length > 0 ? changedRows.length + " " : ""}modification(s)`}
            </button>
          </div>

          {/* Table */}
          <div style={{ ...S.card, padding: 0, overflow: "hidden" }}>
            {/* Header */}
            <div style={{
              display: "grid", gridTemplateColumns: "120px 1fr 70px 110px 32px",
              padding: "8px 14px", background: "#f9fafb", borderBottom: "1px solid #e5e7eb",
              fontSize: 10, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.06em", gap: 10, alignItems: "center",
            }}>
              <span>Référence</span>
              <span>Désignation</span>
              <span style={{ textAlign: "right" }}>Actuel</span>
              <span>Nouveau seuil</span>
              <span></span>
            </div>

            {/* Rows */}
            {rows.map((row, i) => {
              const isChanged = row.newVal.trim() !== "" && row.newVal.trim() !== String(row.currentVal) && !row.saved;
              const isSaved   = row.saved;
              return (
                <div
                  key={row.id}
                  style={{
                    display: "grid", gridTemplateColumns: "120px 1fr 70px 110px 32px",
                    padding: "9px 14px", gap: 10, alignItems: "center",
                    borderBottom: i < rows.length - 1 ? "1px solid #f3f4f6" : undefined,
                    background: isSaved ? "#f0fdf4" : isChanged ? "#eff6ff" : "#fff",
                    transition: "background 0.15s",
                  }}
                >
                  <span style={{ fontFamily: "monospace", fontSize: 12, fontWeight: 700, color: "#2563eb" }}>
                    {row.default_code || "—"}
                  </span>
                  <span title={row.name} style={{ fontSize: 12, color: "#374151", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {row.name}
                  </span>
                  <span style={{ fontSize: 13, color: "#6b7280", textAlign: "right", fontFamily: "monospace", fontWeight: 600 }}>
                    {row.currentVal}
                  </span>
                  <input
                    type="number" step="1" min="0" placeholder="—"
                    value={row.newVal}
                    onChange={e => updateRow(row.id, e.target.value)}
                    disabled={isSaved}
                    className="seuil-input"
                    style={{
                      border: `1.5px solid ${isChanged ? "#3b82f6" : isSaved ? "#bbf7d0" : "#e5e7eb"}`,
                      borderRadius: 7, padding: "5px 9px", fontSize: 13, fontFamily: "monospace",
                      outline: "none", width: "100%", boxSizing: "border-box" as const,
                      background: isSaved ? "#f0fdf4" : "#fff", color: "#111827",
                      transition: "border-color 0.15s",
                    }}
                    onKeyDown={e => {
                      if (e.key === "Enter" || e.key === "Tab") {
                        e.preventDefault();
                        const inputs = document.querySelectorAll<HTMLInputElement>(".seuil-input");
                        const idx = Array.from(inputs).indexOf(e.currentTarget);
                        if (idx >= 0 && idx < inputs.length - 1) inputs[idx + 1].focus();
                      }
                    }}
                  />
                  <button
                    onClick={() => removeRow(row.id)}
                    style={{ background: "none", border: "none", cursor: "pointer", padding: 4, display: "flex", alignItems: "center", justifyContent: "center", color: isSaved ? "#9ca3af" : "#d1d5db", transition: "color 0.15s" }}
                    onMouseEnter={e => !isSaved && (e.currentTarget.style.color = "#ef4444")}
                    onMouseLeave={e => (e.currentTarget.style.color = isSaved ? "#9ca3af" : "#d1d5db")}
                    title="Retirer"
                  >
                    {isSaved
                      ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                      : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    }
                  </button>
                </div>
              );
            })}
          </div>
        </>
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ONGLET STOCK NON VENDABLE
// Articles avec qty_available > 0 mais sale_ok = false
// ═══════════════════════════════════════════════════════════════════════════════

interface NonVendableRow {
  id: number;
  default_code: string;
  name: string;
  qty_available: number;
  product_tmpl_id: number;
  enabling: boolean;
  excluded: boolean; // exclure du cron sale_ok
}

// Catégories connues (code = premier(s) caractère(s) de la référence)
const CAT_FILTERS = [
  { code: "1", label: "Vente" },
  { code: "2", label: "Cabine" },
  { code: "3", label: "Testeur" },
  { code: "4", label: "Miniature" },
  { code: "5", label: "Echantillon" },
  { code: "6", label: "PLV" },
  { code: "7", label: "Offres" },
  { code: "8", label: "Gratuité DE" },
  { code: "9", label: "Présentoir" },
  { code: "AV", label: "Art. suivi offres" },
  { code: "90", label: "Mat. Animatrice" },
  { code: "91", label: "Formation" },
  { code: "__other__", label: "Autres" },
];

function getCatCode(ref: string): string {
  const r = (ref || "").trim().toUpperCase();
  // Codes à 2 chars alphanumériques en priorité
  const two = r.slice(0, 2);
  if (CAT_FILTERS.find(c => c.code === two)) return two;
  const one = r.charAt(0);
  if (CAT_FILTERS.find(c => c.code === one)) return one;
  return "__other__";
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

async function fetchExclusions(): Promise<Set<string>> {
  if (!SUPABASE_URL) return new Set();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/wms_cron_exclusions?select=odoo_ref`, {
    headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${SUPABASE_ANON}` },
  });
  if (!res.ok) return new Set();
  const data: { odoo_ref: string }[] = await res.json();
  return new Set(data.map(d => d.odoo_ref));
}

async function setExclusion(ref: string, excluded: boolean): Promise<void> {
  if (!SUPABASE_URL) return;
  if (excluded) {
    await fetch(`${SUPABASE_URL}/rest/v1/wms_cron_exclusions`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON, Authorization: `Bearer ${SUPABASE_ANON}`,
        "Content-Type": "application/json", Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify({ odoo_ref: ref }),
    });
  } else {
    await fetch(`${SUPABASE_URL}/rest/v1/wms_cron_exclusions?odoo_ref=eq.${encodeURIComponent(ref)}`, {
      method: "DELETE",
      headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${SUPABASE_ANON}` },
    });
  }
}

export function NonVendableTab({ session, onToast }: { session: odoo.OdooSession; onToast: (msg: string, type?: "success"|"error"|"info") => void }) {
  const [rows, setRows]       = useState<NonVendableRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [search, setSearch]   = useState("");
  const [activeCats, setActiveCats] = useState<Set<string>>(new Set());
  const [exclusions, setExclusions] = useState<Set<string>>(new Set());
  const [togglingRef, setTogglingRef] = useState<string | null>(null);

  const TARGET_PREFIXES = ["1", "4", "6", "L"];

  // Charge les exclusions Supabase au montage
  useEffect(() => {
    fetchExclusions().then(setExclusions);
  }, []);

  const toggleExclusion = async (ref: string) => {
    setTogglingRef(ref);
    const nowExcluded = !exclusions.has(ref);
    try {
      await setExclusion(ref, nowExcluded);
      setExclusions(prev => {
        const next = new Set(prev);
        nowExcluded ? next.add(ref) : next.delete(ref);
        return next;
      });
      setRows(prev => prev.map(r => r.default_code === ref ? { ...r, excluded: nowExcluded } : r));
    } catch (e: any) {
      onToast("Erreur exclusion : " + (e?.message ?? e), "error");
    } finally {
      setTogglingRef(null);
    }
  };

  const syncSaleOk = async () => {
    setSyncing(true);
    try {
      // Recharge les exclusions au moment de la sync
      const currentExclusions = await fetchExclusions();

      // 1. Récupère tous les produits ciblés
      const prods = await odoo.searchRead(session, "product.product",
        [["active", "=", true], ["default_code", "!=", false]],
        ["id", "default_code", "sale_ok", "product_tmpl_id"], 0);
      const targeted = prods.filter((p: any) => {
        const ref = (p.default_code || "").trim().toUpperCase();
        return TARGET_PREFIXES.some(pfx => ref.startsWith(pfx)) && !currentExclusions.has(ref);
      });
      // 2. Stock dispo par produit
      const productIds = targeted.map((p: any) => p.id);
      const quants = productIds.length ? await odoo.searchRead(session, "stock.quant",
        [["product_id", "in", productIds], ["location_id.usage", "=", "internal"]],
        ["product_id", "quantity", "reserved_quantity"], 0) : [];
      const dispoByPid: Record<number, number> = {};
      for (const q of quants) {
        const pid = q.product_id[0];
        dispoByPid[pid] = (dispoByPid[pid] || 0) + Math.max(0, (q.quantity || 0) - (q.reserved_quantity || 0));
      }
      // 3. Calcule les changements
      const toDisable: number[] = [];
      const toEnable: number[] = [];
      for (const p of targeted) {
        const dispo = dispoByPid[p.id] || 0;
        const tmplId = Array.isArray(p.product_tmpl_id) ? p.product_tmpl_id[0] : p.product_tmpl_id;
        if (dispo <= 0 && p.sale_ok === true) toDisable.push(tmplId);
        else if (dispo >= 1 && p.sale_ok === false) toEnable.push(tmplId);
      }
      // 4. Applique
      const BATCH = 50;
      for (let i = 0; i < toDisable.length; i += BATCH)
        await odoo.callMethod(session, "product.template", "write", [toDisable.slice(i, i + BATCH), { sale_ok: false }]);
      for (let i = 0; i < toEnable.length; i += BATCH)
        await odoo.callMethod(session, "product.template", "write", [toEnable.slice(i, i + BATCH), { sale_ok: true }]);
      onToast(`✓ Mise à jour : ${toDisable.length} désactivé(s), ${toEnable.length} réactivé(s)`, "success");
      load(); // Refresh la liste
    } catch (e: any) {
      onToast("Erreur sync : " + (e?.message ?? e), "error");
    } finally {
      setSyncing(false);
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Charge en parallèle : articles non-vendables avec stock + exclusions + tous les articles ciblés pour détecter sale_ok=true dispo=0
      const [nonVendable, allTargeted, quants, currentExclusions] = await Promise.all([
        // 1. Articles sale_ok=false avec stock prévu > 0 (liste principale)
        odoo.searchRead(
          session,
          "product.product",
          [["sale_ok", "=", false], ["virtual_available", ">", 0], ["active", "=", true]],
          ["id", "name", "default_code", "virtual_available", "product_tmpl_id", "sale_ok"],
          0,
          "virtual_available desc"
        ),
        // 2. Articles ciblés sale_ok=true (pour trouver ceux avec dispo=0 à désactiver)
        odoo.searchRead(
          session,
          "product.product",
          [["sale_ok", "=", true], ["active", "=", true], ["default_code", "!=", false]],
          ["id", "name", "default_code", "virtual_available", "product_tmpl_id", "sale_ok"],
          0
        ),
        // 3. Stock quant pour calculer dispo réel
        odoo.searchRead(
          session,
          "stock.quant",
          [["location_id.usage", "=", "internal"]],
          ["product_id", "quantity", "reserved_quantity"],
          0
        ),
        fetchExclusions(),
      ]);

      setExclusions(currentExclusions);

      // Calcule dispo par product_id
      const dispoByPid: Record<number, number> = {};
      for (const q of quants) {
        const pid = q.product_id[0];
        dispoByPid[pid] = (dispoByPid[pid] || 0) + Math.max(0, (q.quantity || 0) - (q.reserved_quantity || 0));
      }

      // Articles sale_ok=true des catégories cibles avec dispo=0 (manquent dans la liste principale)
      const toAdd = allTargeted.filter((p: any) => {
        const ref = (p.default_code || "").trim().toUpperCase();
        if (!TARGET_PREFIXES.some(pfx => ref.startsWith(pfx))) return false;
        const dispo = dispoByPid[p.id] || 0;
        return dispo <= 0; // sale_ok=true mais plus de stock → incohérence
      });

      const allRows = [...nonVendable, ...toAdd];
      // Déduplique par id
      const seen = new Set<number>();
      const deduped = allRows.filter(r => { if (seen.has(r.id)) return false; seen.add(r.id); return true; });

      setRows(deduped.map((r: any) => {
        const ref = (r.default_code || "").trim().toUpperCase();
        return {
          id: r.id,
          default_code: r.default_code || "",
          name: r.name || "",
          qty_available: r.virtual_available ?? 0,
          product_tmpl_id: Array.isArray(r.product_tmpl_id) ? r.product_tmpl_id[0] : r.product_tmpl_id,
          enabling: false,
          excluded: currentExclusions.has(ref),
        };
      }));
    } catch (e: any) {
      onToast("Erreur chargement : " + (e?.message ?? e), "error");
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => { load(); }, [load]);

  const enableSaleOk = async (row: NonVendableRow) => {
    setRows(prev => prev.map(r => r.id === row.id ? { ...r, enabling: true } : r));
    try {
      await odoo.callMethod(session, "product.template", "write", [[row.product_tmpl_id], { sale_ok: true }]);
      onToast(`✓ "${row.name}" peut maintenant être vendu`, "success");
      setRows(prev => prev.filter(r => r.id !== row.id));
    } catch (e: any) {
      onToast("Erreur : " + (e?.message ?? e), "error");
      setRows(prev => prev.map(r => r.id === row.id ? { ...r, enabling: false } : r));
    }
  };

  // Priorité de tri : 1-5 en premier (vente), puis 6-9, puis AV/autres
  function refPriority(code: string): number {
    const c = (code || "").trim();
    const first = c.charAt(0);
    if (["1","2","3","4","5"].includes(first)) return 0;
    if (["6","7","8","9"].includes(first)) return 1;
    return 2;
  }

  // Chips disponibles = catégories présentes dans les données
  const availableCats = CAT_FILTERS.filter(cf =>
    rows.some(r => getCatCode(r.default_code) === cf.code)
  );

  const toggleCat = (code: string) => {
    setActiveCats(prev => {
      const next = new Set(prev);
      next.has(code) ? next.delete(code) : next.add(code);
      return next;
    });
  };

  const filtered = rows
    .filter(r => {
      if (activeCats.size > 0 && !activeCats.has(getCatCode(r.default_code))) return false;
      if (!search) return true;
      return (
        r.default_code.toLowerCase().includes(search.toLowerCase()) ||
        r.name.toLowerCase().includes(search.toLowerCase())
      );
    })
    .sort((a, b) => {
      const pa = refPriority(a.default_code);
      const pb = refPriority(b.default_code);
      if (pa !== pb) return pa - pb;
      return b.qty_available - a.qty_available;
    });

  // Groupes visuels (désactivés quand filtre actif pour éviter la redondance)
  const showGroups = activeCats.size === 0 && !search;
  const GROUP_LABELS: Record<number, string> = { 0: "Articles vente (1–5)", 1: "Autres catégories (6–9)", 2: "Codes spéciaux (AV…)" };

  return (
    <div style={{ ...S.body, maxWidth: 760 }}>
      {/* Barre de recherche + refresh + sync */}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          style={{ ...S.input, flex: 1 }}
          placeholder="Rechercher (ref, nom)…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <button
          onClick={load}
          disabled={loading}
          style={{ ...S.btn, width: "auto", padding: "9px 14px", background: "#f3f4f6", color: "#374151", display: "flex", alignItems: "center", gap: 6 }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
            style={loading ? { animation: "spin 1s linear infinite" } : {}}>
            <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
          </svg>
        </button>
        <button
          onClick={syncSaleOk}
          disabled={syncing || loading}
          title="Synchronise sale_ok selon stock dispo (cat. Vente / Miniature / Échantillon / PLV)"
          style={{ ...S.btn, width: "auto", padding: "9px 16px", background: syncing ? "#e0e7ff" : "#4f46e5", color: "#fff", display: "flex", alignItems: "center", gap: 7, fontWeight: 600, fontSize: 13, borderRadius: 9 }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
            style={syncing ? { animation: "spin 1s linear infinite" } : {}}>
            <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
          </svg>
          {syncing ? "Mise à jour…" : "Mettre à jour"}
        </button>
      </div>

      {/* Chips catégories */}
      {!loading && availableCats.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {availableCats.map(cf => {
            const active = activeCats.has(cf.code);
            const count = rows.filter(r => getCatCode(r.default_code) === cf.code).length;
            return (
              <button
                key={cf.code}
                onClick={() => toggleCat(cf.code)}
                style={{
                  padding: "5px 11px", borderRadius: 99, border: "1.5px solid",
                  borderColor: active ? "#2563eb" : "#d1d5db",
                  background: active ? "#2563eb" : "#fff",
                  color: active ? "#fff" : "#374151",
                  fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
                  transition: "all 0.12s",
                }}
              >
                {cf.code === "__other__" ? cf.label : `${cf.code} · ${cf.label}`} <span style={{ opacity: 0.7, fontSize: 11 }}>({count})</span>
              </button>
            );
          })}
          {activeCats.size > 0 && (
            <button
              onClick={() => setActiveCats(new Set())}
              style={{
                padding: "5px 11px", borderRadius: 99, border: "1.5px solid #e5e7eb",
                background: "#f3f4f6", color: "#6b7280",
                fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
              }}
            >
              ✕ Tout afficher
            </button>
          )}
        </div>
      )}

      {/* Compteur */}
      {!loading && (
        <div style={{ fontSize: 12, color: "#6b7280", fontWeight: 600 }}>
          {filtered.length === 0
            ? rows.length === 0 ? "✓ Aucun article avec qté prévue non vendable" : "Aucun résultat"
            : `${filtered.length} article${filtered.length > 1 ? "s" : ""} avec qté prévue > 0 mais non vendable`
          }
        </div>
      )}

      {/* Tableau */}
      {loading ? (
        <div style={{ display: "flex", justifyContent: "center", padding: 40, color: "#6b7280" }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            style={{ animation: "spin 1s linear infinite" }}>
            <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
          </svg>
        </div>
      ) : filtered.length > 0 ? (
        <div style={{ ...S.card, padding: 0, overflow: "hidden" }}>
          {/* Header */}
          <div style={{
            display: "grid", gridTemplateColumns: "120px 1fr 90px 70px 44px",
            padding: "8px 14px", background: "#f1f5f9", borderBottom: "1px solid #e5e7eb",
            fontSize: 10, fontWeight: 700, color: "#6b7280", letterSpacing: "0.06em", textTransform: "uppercase" as const,
          }}>
            <span>Référence</span>
            <span>Désignation</span>
            <span style={{ textAlign: "right" }}>Qté prévue</span>
            <span style={{ textAlign: "center" }} title="Exclure du cron sale_ok automatique">Excl. cron</span>
            <span/>
          </div>
          {(() => {
            let lastGroup = -1;
            return filtered.map((row, i) => {
              const grp = refPriority(row.default_code);
              const showSep = !search && grp !== lastGroup;
              lastGroup = grp;
              return (
                <div key={row.id}>
                  {showGroups && showSep && (
                    <div style={{
                      padding: "6px 14px", fontSize: 10, fontWeight: 700, letterSpacing: "0.07em",
                      textTransform: "uppercase" as const,
                      color: grp === 0 ? "#1d4ed8" : grp === 1 ? "#7c3aed" : "#9ca3af",
                      background: grp === 0 ? "#eff6ff" : grp === 1 ? "#f5f3ff" : "#f9fafb",
                      borderBottom: "1px solid #e5e7eb",
                    }}>
                      {GROUP_LABELS[grp]}
                    </div>
                  )}
                  <div style={{
                    display: "grid", gridTemplateColumns: "120px 1fr 90px 70px 44px",
                    padding: "9px 14px", alignItems: "center",
                    background: i % 2 === 0 ? "#fff" : "#fafafa",
                    borderBottom: i < filtered.length - 1 ? "1px solid #f3f4f6" : "none",
                  }}>
                    <span style={{ fontSize: 12, fontWeight: 800, color: "#374151", fontFamily: "'Courier New', monospace", letterSpacing: "0.04em", fontVariantNumeric: "slashed-zero" }}>
                      {row.default_code || "—"}
                    </span>
                    <span style={{ fontSize: 12, color: "#111827", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", paddingRight: 8 }} title={row.name}>
                      {row.name}
                    </span>
                    <span style={{
                      fontSize: 13, fontWeight: 700, textAlign: "right", fontFamily: "monospace",
                      color: row.qty_available >= 50 ? "#b45309" : "#374151",
                    }}>
                      {row.qty_available % 1 === 0 ? row.qty_available : row.qty_available.toFixed(2)}
                    </span>
                    {/* Toggle exclusion cron */}
                    <div style={{ display: "flex", justifyContent: "center" }}>
                      <button
                        onClick={() => toggleExclusion(row.default_code.trim().toUpperCase())}
                        disabled={togglingRef === row.default_code.trim().toUpperCase()}
                        title={row.excluded ? "Inclure dans le cron" : "Exclure du cron"}
                        style={{
                          background: row.excluded ? "#fee2e2" : "#f3f4f6",
                          border: `1.5px solid ${row.excluded ? "#fca5a5" : "#d1d5db"}`,
                          borderRadius: 6, cursor: "pointer",
                          padding: "4px 7px", fontSize: 10, fontWeight: 700,
                          color: row.excluded ? "#b91c1c" : "#6b7280",
                          fontFamily: "inherit", whiteSpace: "nowrap" as const,
                          opacity: togglingRef === row.default_code.trim().toUpperCase() ? 0.5 : 1,
                          transition: "all 0.12s",
                        }}
                      >
                        {row.excluded ? "Exclu" : "—"}
                      </button>
                    </div>
                    <button
                      onClick={() => enableSaleOk(row)}
                      disabled={row.enabling}
                      title='Activer "Peut être vendu"'
                      style={{
                        background: row.enabling ? "#f3f4f6" : "#dcfce7",
                        border: "none", borderRadius: 6, cursor: row.enabling ? "wait" : "pointer",
                        padding: "5px 6px", display: "flex", alignItems: "center", justifyContent: "center",
                        color: row.enabling ? "#9ca3af" : "#166534", transition: "background 0.15s",
                        marginLeft: "auto",
                      }}
                      onMouseEnter={e => !row.enabling && (e.currentTarget.style.background = "#bbf7d0")}
                      onMouseLeave={e => !row.enabling && (e.currentTarget.style.background = "#dcfce7")}
                    >
                      {row.enabling
                        ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ animation: "spin 1s linear infinite" }}><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                        : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                      }
                    </button>
                  </div>
                </div>
              );
            });
          })()}
        </div>
      ) : null}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PutawayTab — Stratégie de rangement
// ─────────────────────────────────────────────────────────────────────────────

type PutawayRow = {
  ruleId: number;
  productId: number;
  productName: string;
  productCode: string;
  ruleLocation: string;
  ruleLocationId: number;
  realLocation: string;
  realLocationId: number | null;
  realQty: number;
  divergent: boolean;
  updating: boolean;
};

type NoPutawayRow = {
  productId: number;
  productName: string;
  productCode: string;
  realLocation: string;
  realLocationId: number;
  realQty: number;
  creating: boolean;
};

export function PutawayTab({ session, onToast }: { session: odoo.OdooSession; onToast: (msg: string, type?: "success"|"error"|"info") => void }) {
  const [rows, setRows] = useState<PutawayRow[]>([]);
  const [noPutaway, setNoPutaway] = useState<NoPutawayRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "divergent" | "ok">("all");
  const [confirmRow, setConfirmRow] = useState<PutawayRow | NoPutawayRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rules = await odoo.searchRead(
        session, "stock.putaway.rule",
        [["product_id", "!=", false]],
        ["id", "product_id", "location_in_id", "location_out_id"],
        0
      );

      const ruleProductIds = rules.map((r: any) =>
        Array.isArray(r.product_id) ? r.product_id[0] : r.product_id
      );

      const quants = await odoo.searchRead(
        session, "stock.quant",
        [
          ["product_id", "in", ruleProductIds],
          ["location_id.usage", "=", "internal"],
          ["quantity", ">", 0],
        ],
        ["product_id", "location_id", "quantity"],
        0
      );

      const allStockProductIds: number[] = Array.from(new Set(
        quants.map((q: any) => Array.isArray(q.product_id) ? q.product_id[0] : q.product_id)
      ));
      const ruleProductIdSet = new Set(ruleProductIds);
      const noRuleProductIds = allStockProductIds.filter(id => !ruleProductIdSet.has(id));

      const noRuleProducts = noRuleProductIds.length > 0
        ? await odoo.searchRead(
            session, "product.product",
            [["id", "in", noRuleProductIds]],
            ["id", "name", "default_code"],
            0
          )
        : [];

      type QuantEntry = { locationId: number; locationName: string; qty: number };
      const quantsByProduct: Record<number, QuantEntry[]> = {};
      for (const q of quants) {
        const pid = Array.isArray(q.product_id) ? q.product_id[0] : q.product_id;
        const lid = Array.isArray(q.location_id) ? q.location_id[0] : q.location_id;
        const lname = Array.isArray(q.location_id) ? q.location_id[1] : String(lid);
        if (!quantsByProduct[pid]) quantsByProduct[pid] = [];
        quantsByProduct[pid].push({ locationId: lid, locationName: lname, qty: q.quantity });
      }

      const built: PutawayRow[] = rules.map((r: any) => {
        const pid = Array.isArray(r.product_id) ? r.product_id[0] : r.product_id;
        const pname = Array.isArray(r.product_id) ? r.product_id[1] : "";
        const pcode = pname.match(/^\[([^\]]+)\]/)?.[1] ?? "";
        const cleanName = pname.replace(/^\[[^\]]+\]\s*/, "");
        const destId = Array.isArray(r.location_out_id) ? r.location_out_id[0] : r.location_out_id;
        const destName = Array.isArray(r.location_out_id) ? r.location_out_id[1] : String(destId);
        const entries = (quantsByProduct[pid] ?? []).sort((a, b) => b.qty - a.qty);
        const dominant = entries[0] ?? null;
        return {
          ruleId: r.id,
          productId: pid,
          productName: cleanName,
          productCode: pcode,
          ruleLocation: destName,
          ruleLocationId: destId,
          realLocation: dominant?.locationName ?? "Aucun stock",
          realLocationId: dominant?.locationId ?? null,
          realQty: dominant?.qty ?? 0,
          divergent: dominant ? dominant.locationId !== destId : false,
          updating: false,
        };
      });

      const noRuleMap: Record<number, any> = {};
      for (const p of noRuleProducts) noRuleMap[p.id] = p;

      const noPut: NoPutawayRow[] = noRuleProductIds
        .map(pid => {
          const p = noRuleMap[pid];
          if (!p) return null;
          const entries = (quantsByProduct[pid] ?? []).sort((a, b) => b.qty - a.qty);
          const dominant = entries[0];
          if (!dominant) return null;
          const pname = p.name || "";
          const pcode = p.default_code || pname.match(/^\[([^\]]+)\]/)?.[1] || "";
          const cleanName = pname.replace(/^\[[^\]]+\]\s*/, "");
          return {
            productId: pid,
            productName: cleanName,
            productCode: pcode,
            realLocation: dominant.locationName,
            realLocationId: dominant.locationId,
            realQty: dominant.qty,
            creating: false,
          };
        })
        .filter(Boolean) as NoPutawayRow[];

      setRows(built.sort((a, b) => (b.divergent ? 1 : 0) - (a.divergent ? 1 : 0)));
      setNoPutaway(noPut.sort((a, b) => b.realQty - a.realQty).slice(0, 50));
    } catch (e: any) {
      onToast("Erreur chargement : " + (e?.message ?? e), "error");
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => { load(); }, [load]);

  const updateRule = async (row: PutawayRow) => {
    if (!row.realLocationId) return;
    setRows(prev => prev.map(r => r.ruleId === row.ruleId ? { ...r, updating: true } : r));
    try {
      await odoo.write(session, "stock.putaway.rule", [row.ruleId], { location_out_id: row.realLocationId });
      onToast(`✓ Règle mise à jour → ${row.realLocation}`, "success");
      setRows(prev => prev.map(r => r.ruleId === row.ruleId
        ? { ...r, ruleLocation: row.realLocation, ruleLocationId: row.realLocationId!, divergent: false, updating: false }
        : r
      ));
    } catch (e: any) {
      onToast("Erreur : " + (e?.message ?? e), "error");
      setRows(prev => prev.map(r => r.ruleId === row.ruleId ? { ...r, updating: false } : r));
    }
    setConfirmRow(null);
  };

  const createRule = async (row: NoPutawayRow) => {
    if (!row.realLocationId) return;
    setNoPutaway(prev => prev.map(r => r.productId === row.productId ? { ...r, creating: true } : r));
    try {
      const stockLocs = await odoo.searchRead(
        session, "stock.location",
        [["complete_name", "=", "WH/Stock"], ["usage", "=", "internal"]],
        ["id"], 1
      );
      const stockLocId = stockLocs[0]?.id;
      if (!stockLocId) throw new Error("Emplacement WH/Stock introuvable");
      await odoo.create(session, "stock.putaway.rule", {
        product_id: row.productId,
        location_in_id: stockLocId,
        location_out_id: row.realLocationId,
      });
      onToast(`✓ Règle créée : → ${row.realLocation}`, "success");
      setNoPutaway(prev => prev.filter(r => r.productId !== row.productId));
    } catch (e: any) {
      onToast("Erreur : " + (e?.message ?? e), "error");
      setNoPutaway(prev => prev.map(r => r.productId === row.productId ? { ...r, creating: false } : r));
    }
    setConfirmRow(null);
  };

  const S = {
    card: { background: "#fff", border: "1px solid #e8ecf3", borderRadius: 14, boxShadow: "0 1px 2px rgba(15,23,42,.04)" } as React.CSSProperties,
    badge: (color: string, bg: string): React.CSSProperties => ({
      display: "inline-flex", alignItems: "center", padding: "2px 9px", borderRadius: 20,
      fontSize: 11, fontWeight: 700, color, background: bg, whiteSpace: "nowrap",
    }),
    row: { borderBottom: "1px solid #f1f5f9", padding: "13px 16px" } as React.CSSProperties,
  };

  const q = search.toLowerCase();
  const filteredRows = rows.filter(r => {
    const matchSearch = !q || r.productCode.toLowerCase().includes(q) || r.productName.toLowerCase().includes(q);
    const matchFilter = filter === "all" || (filter === "divergent" ? r.divergent : !r.divergent);
    return matchSearch && matchFilter;
  });

  const divergentCount = rows.filter(r => r.divergent).length;

  const Spinner = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      style={{ animation: "spin 1s linear infinite" }}>
      <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
    </svg>
  );

  return (
    <div style={{ maxWidth: 900 }}>
      {/* Stats */}
      <div style={{ display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap" as const }}>
        {[
          { emoji: "📦", count: rows.length, label: "Règles actives", highlight: false },
          { emoji: "⚠️", count: divergentCount, label: "Divergences", highlight: divergentCount > 0 },
          { emoji: "🔍", count: noPutaway.length, label: "Sans règle", highlight: false },
        ].map(({ emoji, count, label, highlight }) => (
          <div key={label} style={{ ...S.card, padding: "12px 18px", display: "flex", gap: 10, alignItems: "center", borderColor: highlight ? "#fca5a5" : "#e8ecf3" }}>
            <span style={{ fontSize: 20 }}>{emoji}</span>
            <div>
              <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: -0.5, color: highlight ? "#dc2626" : "#0f172a" }}>{count}</div>
              <div style={{ fontSize: 11, color: "#64748b", fontWeight: 600 }}>{label}</div>
            </div>
          </div>
        ))}
        <button onClick={load} disabled={loading} style={{ marginLeft: "auto", alignSelf: "center", padding: "9px 16px", borderRadius: 10, border: "1px solid #e8ecf3", background: "#fff", cursor: loading ? "wait" : "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 600, color: "#64748b", display: "flex", alignItems: "center", gap: 7 }}>
          {loading ? <Spinner /> : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>}
          Actualiser
        </button>
      </div>

      {/* Filtres */}
      <div style={{ display: "flex", gap: 10, marginBottom: 16, alignItems: "center", flexWrap: "wrap" as const }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Rechercher réf, désignation…"
          style={{ flex: "1 1 220px", padding: "9px 14px", borderRadius: 10, border: "1px solid #e2e8f0", fontFamily: "inherit", fontSize: 13, outline: "none", color: "#0f172a" }} />
        {(["all", "divergent", "ok"] as const).map(f => (
          <button key={f} onClick={() => setFilter(f)}
            style={{ padding: "8px 14px", borderRadius: 10, border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 12.5, fontWeight: 600,
              background: filter === f ? "#eef2ff" : "#f1f5f9", color: filter === f ? "#2563eb" : "#64748b" }}>
            {f === "all" ? "Tout" : f === "divergent" ? `⚠ Divergences (${divergentCount})` : "✓ OK"}
          </button>
        ))}
      </div>

      {loading ? (
        <div style={{ display: "flex", justifyContent: "center", padding: 60, color: "#94a3b8" }}>
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ animation: "spin 1s linear infinite" }}>
            <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
          </svg>
        </div>
      ) : (
        <>
          {filteredRows.length > 0 && (
            <div style={{ ...S.card, overflow: "hidden", marginBottom: 24 }}>
              <div style={{ display: "grid", gridTemplateColumns: "120px 1fr 1fr 100px 44px", padding: "9px 16px", background: "#f8fafc", borderBottom: "1px solid #e8ecf3", fontSize: 10.5, fontWeight: 700, color: "#94a3b8", letterSpacing: "0.07em", textTransform: "uppercase" as const, gap: 12 }}>
                <span>Réf</span><span>Désignation</span><span>Règle → Réel</span><span style={{ textAlign: "center" }}>Statut</span><span/>
              </div>
              {filteredRows.map(row => (
                <div key={row.ruleId} style={{ display: "grid", gridTemplateColumns: "120px 1fr 1fr 100px 44px", ...S.row, alignItems: "center", gap: 12, background: row.divergent ? "#fffbeb" : "#fff" }}>
                  <span style={{ fontFamily: "monospace", fontSize: 12, fontWeight: 700, color: "#374151" }}>{row.productCode}</span>
                  <span style={{ fontSize: 13, color: "#0f172a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }} title={row.productName}>{row.productName}</span>
                  <div style={{ fontSize: 12, lineHeight: 1.6 }}>
                    <div><span style={{ color: "#7c3aed", fontWeight: 600 }}>Règle :</span> <span style={{ color: "#64748b" }}>{row.ruleLocation}</span></div>
                    <div><span style={{ fontWeight: 600, color: row.divergent ? "#b45309" : "#16a34a" }}>Réel :</span> <span style={{ color: row.divergent ? "#b45309" : "#16a34a" }}>{row.realLocation}</span>{row.realQty > 0 && <span style={{ color: "#94a3b8", marginLeft: 5 }}>({row.realQty % 1 === 0 ? row.realQty : row.realQty.toFixed(1)})</span>}</div>
                  </div>
                  <div style={{ textAlign: "center" }}>
                    {row.divergent ? <span style={S.badge("#b45309", "#fef3c7")}>⚠ Décalé</span> : <span style={S.badge("#166534", "#dcfce7")}>✓ OK</span>}
                  </div>
                  <button disabled={!row.divergent || !row.realLocationId || row.updating} onClick={() => setConfirmRow(row)}
                    title={row.divergent ? `Mettre à jour → ${row.realLocation}` : "Déjà à jour"}
                    style={{ width: 34, height: 34, borderRadius: 9, border: "none", cursor: row.divergent && row.realLocationId ? "pointer" : "default",
                      background: row.divergent && row.realLocationId ? "#dbeafe" : "#f1f5f9",
                      color: row.divergent && row.realLocationId ? "#2563eb" : "#cbd5e1",
                      display: "flex", alignItems: "center", justifyContent: "center" }}>
                    {row.updating ? <Spinner /> : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>}
                  </button>
                </div>
              ))}
            </div>
          )}

          {noPutaway.length > 0 && (
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase" as const, color: "#94a3b8", margin: "0 0 12px 2px" }}>
                Articles sans règle de rangement ({noPutaway.length})
              </div>
              <div style={{ ...S.card, overflow: "hidden" }}>
                <div style={{ display: "grid", gridTemplateColumns: "120px 1fr 1fr 44px", padding: "9px 16px", background: "#f8fafc", borderBottom: "1px solid #e8ecf3", fontSize: 10.5, fontWeight: 700, color: "#94a3b8", letterSpacing: "0.07em", textTransform: "uppercase" as const, gap: 12 }}>
                  <span>Réf</span><span>Désignation</span><span>Stock actuel</span><span/>
                </div>
                {noPutaway.map(row => (
                  <div key={row.productId} style={{ display: "grid", gridTemplateColumns: "120px 1fr 1fr 44px", ...S.row, alignItems: "center", gap: 12 }}>
                    <span style={{ fontFamily: "monospace", fontSize: 12, fontWeight: 700, color: "#374151" }}>{row.productCode}</span>
                    <span style={{ fontSize: 13, color: "#0f172a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }} title={row.productName}>{row.productName}</span>
                    <div style={{ fontSize: 12 }}>
                      <span style={{ fontWeight: 600, color: "#d97706" }}>📍 {row.realLocation}</span>
                      <span style={{ color: "#94a3b8", marginLeft: 5 }}>({row.realQty % 1 === 0 ? row.realQty : row.realQty.toFixed(1)})</span>
                    </div>
                    <button disabled={row.creating} onClick={() => setConfirmRow(row)}
                      style={{ width: 34, height: 34, borderRadius: 9, border: "none", cursor: "pointer", background: "#fef3c7", color: "#b45309", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      {row.creating ? <Spinner /> : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {filteredRows.length === 0 && !loading && rows.length > 0 && (
            <div style={{ textAlign: "center" as const, padding: 40, color: "#94a3b8", fontSize: 14 }}>Aucun résultat pour cette recherche</div>
          )}
        </>
      )}

      {/* Modale confirmation */}
      {confirmRow && (
        <div style={{ position: "fixed" as const, inset: 0, background: "rgba(15,23,42,.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}
          onClick={() => setConfirmRow(null)}>
          <div style={{ background: "#fff", borderRadius: 18, padding: "28px 32px", maxWidth: 440, width: "90%", boxShadow: "0 24px 48px -12px rgba(15,23,42,.35)" }}
            onClick={e => e.stopPropagation()}>
            {"ruleId" in confirmRow ? (
              <>
                <div style={{ fontSize: 17, fontWeight: 700, color: "#0f172a", marginBottom: 6 }}>Modifier la stratégie de rangement</div>
                <div style={{ fontSize: 13, color: "#64748b", marginBottom: 20, lineHeight: 1.6 }}>
                  Destination pour <strong>{confirmRow.productCode}</strong> :<br/>
                  <span style={{ color: "#7c3aed", fontWeight: 600 }}>{(confirmRow as PutawayRow).ruleLocation}</span>{" → "}<span style={{ color: "#16a34a", fontWeight: 600 }}>{confirmRow.realLocation}</span>
                </div>
                <div style={{ background: "#fef3c7", border: "1px solid #fcd34d", borderRadius: 10, padding: "11px 14px", fontSize: 12.5, color: "#92400e", marginBottom: 20 }}>
                  ⚠️ Les transferts de réception <strong>en cours</strong> peuvent encore pointer vers l'ancien emplacement. Vérifiez avant de valider.
                </div>
                <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                  <button onClick={() => setConfirmRow(null)} style={{ padding: "9px 18px", borderRadius: 10, border: "1px solid #e2e8f0", background: "#fff", cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 600, color: "#64748b" }}>Annuler</button>
                  <button onClick={() => updateRule(confirmRow as PutawayRow)} style={{ padding: "9px 18px", borderRadius: 10, border: "none", background: "#2563eb", color: "#fff", cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 600 }}>Mettre à jour</button>
                </div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 17, fontWeight: 700, color: "#0f172a", marginBottom: 6 }}>Créer une règle de rangement</div>
                <div style={{ fontSize: 13, color: "#64748b", marginBottom: 20, lineHeight: 1.6 }}>
                  <strong>{confirmRow.productCode} — {confirmRow.productName}</strong><br/>
                  Destination : <span style={{ color: "#16a34a", fontWeight: 600 }}>{confirmRow.realLocation}</span>
                </div>
                <div style={{ background: "#fef3c7", border: "1px solid #fcd34d", borderRadius: 10, padding: "11px 14px", fontSize: 12.5, color: "#92400e", marginBottom: 20 }}>
                  ⚠️ Les prochaines réceptions seront automatiquement orientées vers cet emplacement.
                </div>
                <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                  <button onClick={() => setConfirmRow(null)} style={{ padding: "9px 18px", borderRadius: 10, border: "1px solid #e2e8f0", background: "#fff", cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 600, color: "#64748b" }}>Annuler</button>
                  <button onClick={() => createRule(confirmRow as NoPutawayRow)} style={{ padding: "9px 18px", borderRadius: 10, border: "none", background: "#d97706", color: "#fff", cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 600 }}>Créer la règle</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <style>{`@keyframes putaway-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
