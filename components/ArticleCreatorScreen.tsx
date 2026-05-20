"use client";

import { useState, useEffect, useCallback } from "react";
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
  const [tab, setTab] = useState<"creation" | "seuils">(initialTab);

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
      <div style={{ display: "flex", background: "#fff", borderBottom: "1px solid #e5e7eb", padding: "0 16px" }}>
        {(["creation", "seuils"] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              background: "none", border: "none", cursor: "pointer", padding: "12px 16px",
              fontSize: 13, fontWeight: 600, fontFamily: "inherit",
              color: tab === t ? "#2563eb" : "#6b7280",
              borderBottom: tab === t ? "2px solid #2563eb" : "2px solid transparent",
              marginBottom: -1,
            }}
          >
            {t === "creation" ? "Création article" : "Seuils d'alerte"}
          </button>
        ))}
      </div>

      {tab === "creation"
        ? <CreationTab session={session} onToast={onToast} />
        : <SeuilsTab   session={session} onToast={onToast} />
      }
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ONGLET CRÉATION (code original inchangé)
// ═══════════════════════════════════════════════════════════════════════════════

function CreationTab({ session, onToast }: { session: odoo.OdooSession; onToast: (msg: string, type?: "success"|"error"|"info") => void }) {
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
// ONGLET SEUILS D'ALERTE
// ═══════════════════════════════════════════════════════════════════════════════

function SeuilsTab({ session, onToast }: { session: odoo.OdooSession; onToast: (msg: string, type?: "success"|"error"|"info") => void }) {
  const [rawInput,  setRawInput]  = useState("");
  const [rows,      setRows]      = useState<ThresholdRow[]>([]);
  const [notFound,  setNotFound]  = useState<string[]>([]);
  const [loading,   setLoading]   = useState(false);
  const [saving,    setSaving]    = useState(false);

  // Nombre de lignes modifiées (newVal différent de l'actuel ou non vide)
  const changedRows = rows.filter(r => r.newVal.trim() !== "" && r.newVal.trim() !== String(r.currentVal) && !r.saved);

  /** Parse la zone de texte → liste de refs (et éventuellement quantités) */
  function parseInput(raw: string): { ref: string; qty?: number }[] {
    return raw
      .split("\n")
      .map(l => l.trim())
      .filter(Boolean)
      .map(line => {
        // Formats acceptés :
        // "10020101"           → juste le code
        // "10020101 5"         → code + seuil
        // "10020101\t5"        → code + tab + seuil
        // "10020101 - Crème 5" → on prend le premier token comme ref, dernier number comme qty
        const tokens = line.split(/[\s\t]+/);
        const ref = tokens[0];
        const lastNum = parseFloat(tokens[tokens.length - 1]);
        const qty = tokens.length > 1 && !isNaN(lastNum) ? lastNum : undefined;
        return { ref, qty };
      });
  }

  const handleSearch = async () => {
    const parsed = parseInput(rawInput);
    if (!parsed.length) { onToast("Collez au moins une référence", "error"); return; }
    setLoading(true);
    setRows([]);
    setNotFound([]);
    try {
      const refs = parsed.map(p => p.ref);
      const products = await odoo.searchProductsForThreshold(session, refs);

      // Mapper : si la ref correspond exactement à un code → on pré-remplit qty si fournie
      const qtyMap = new Map(parsed.map(p => [p.ref.toLowerCase(), p.qty]));

      const newRows: ThresholdRow[] = products.map(p => {
        const matchedQty = qtyMap.get(p.default_code.toLowerCase()) ?? qtyMap.get(p.name.toLowerCase());
        return {
          id: p.id,
          default_code: p.default_code,
          name: p.name,
          currentVal: p.temp_min_quantity,
          newVal: matchedQty !== undefined ? String(matchedQty) : "",
          saved: false,
        };
      });

      // Refs non trouvées
      const foundCodes = new Set(products.map(p => p.default_code.toLowerCase()));
      const foundNames = new Set(products.map(p => p.name.toLowerCase()));
      const missing = parsed
        .filter(p => !foundCodes.has(p.ref.toLowerCase()) && !foundNames.has(p.ref.toLowerCase()))
        .map(p => p.ref);

      setRows(newRows);
      setNotFound(missing);

      if (!newRows.length) onToast("Aucun article trouvé", "error");
      else onToast(`${newRows.length} article(s) trouvé(s)`, "info");
    } catch (e: any) {
      onToast(`Erreur recherche : ${e.message}`, "error");
    } finally {
      setLoading(false);
    }
  };

  const handleSaveAll = async () => {
    const toSave = rows.filter(r => r.newVal.trim() !== "" && !r.saved);
    if (!toSave.length) { onToast("Aucune valeur à enregistrer", "error"); return; }
    setSaving(true);
    try {
      const updates = toSave.map(r => ({ id: r.id, value: parseFloat(r.newVal) || 0 }));
      await odoo.bulkUpdateMinQuantity(session, updates);
      // Marquer comme sauvegardé
      setRows(prev => prev.map(r => {
        const u = updates.find(u => u.id === r.id);
        if (!u) return r;
        return { ...r, currentVal: u.value, newVal: "", saved: true };
      }));
      onToast(`${toSave.length} seuil(s) mis à jour dans Odoo ✓`, "success");
    } catch (e: any) {
      onToast(`Erreur sauvegarde : ${e.message}`, "error");
    } finally {
      setSaving(false);
    }
  };

  const updateRow = (id: number, val: string) => {
    setRows(prev => prev.map(r => r.id === id ? { ...r, newVal: val, saved: false } : r));
  };

  return (
    <div style={{ ...S.body, maxWidth: 700 }}>

      {/* Zone de collage */}
      <div style={S.card}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
          Collez vos références
        </div>
        <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 10 }}>
          1 référence par ligne. Vous pouvez inclure le seuil directement :<br/>
          <code style={{ background: "#f3f4f6", padding: "1px 5px", borderRadius: 4 }}>10020101 5</code>
          {" ou simplement "}
          <code style={{ background: "#f3f4f6", padding: "1px 5px", borderRadius: 4 }}>10020101</code>
          {" pour remplir manuellement."}
        </div>
        <textarea
          style={{ ...S.input, height: 120, resize: "vertical", fontFamily: "monospace", fontSize: 13 }}
          placeholder={"10020101 5\n10020102 10\n10020103"}
          value={rawInput}
          onChange={e => setRawInput(e.target.value)}
        />
        <button
          style={{ ...S.btn, marginTop: 10, background: rawInput.trim() ? "#2563eb" : "#e5e7eb", color: rawInput.trim() ? "#fff" : "#9ca3af" }}
          onClick={handleSearch}
          disabled={loading || !rawInput.trim()}
        >
          {loading ? "Recherche…" : "Rechercher les articles"}
        </button>
      </div>

      {/* Refs non trouvées */}
      {notFound.length > 0 && (
        <div style={{ background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 10, padding: "10px 14px" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#92400e", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>
            {notFound.length} référence(s) non trouvée(s)
          </div>
          <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 6 }}>
            {notFound.map(r => (
              <span key={r} style={{ fontFamily: "monospace", fontSize: 12, background: "#fde68a", padding: "2px 8px", borderRadius: 6, color: "#92400e" }}>{r}</span>
            ))}
          </div>
        </div>
      )}

      {/* Tableau des articles */}
      {rows.length > 0 && (
        <>
          {/* Bouton sauvegarder tout */}
          <button
            style={{
              ...S.btn,
              background: changedRows.length ? "#059669" : "#e5e7eb",
              color: changedRows.length ? "#fff" : "#9ca3af",
            }}
            onClick={handleSaveAll}
            disabled={saving || !changedRows.length}
          >
            {saving ? "Enregistrement…" : `Enregistrer ${changedRows.length} modification(s) dans Odoo`}
          </button>

          <div style={{ ...S.card, padding: 0, overflow: "hidden" }}>
            {/* En-tête */}
            <div style={{
              display: "grid", gridTemplateColumns: "130px 1fr 90px 100px 36px",
              padding: "8px 12px", background: "#f9fafb",
              borderBottom: "1px solid #e5e7eb",
              fontSize: 10, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em",
              gap: 8, alignItems: "center",
            }}>
              <span>Référence</span>
              <span>Désignation</span>
              <span style={{ textAlign: "right" }}>Actuel</span>
              <span>Nouveau seuil</span>
              <span></span>
            </div>

            {/* Lignes */}
            {rows.map((row, i) => {
              const isChanged = row.newVal.trim() !== "" && row.newVal.trim() !== String(row.currentVal) && !row.saved;
              const isSaved   = row.saved;
              return (
                <div
                  key={row.id}
                  style={{
                    display: "grid", gridTemplateColumns: "130px 1fr 90px 100px 36px",
                    padding: "8px 12px", gap: 8, alignItems: "center",
                    borderBottom: i < rows.length - 1 ? "1px solid #f3f4f6" : undefined,
                    background: isSaved ? "#f0fdf4" : isChanged ? "#eff6ff" : "#fff",
                    transition: "background 0.2s",
                  }}
                >
                  <span style={{ fontFamily: "monospace", fontSize: 12, color: "#374151", fontWeight: 600 }}>
                    {row.default_code || "—"}
                  </span>
                  <span style={{ fontSize: 12, color: "#4b5563", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {row.name}
                  </span>
                  <span style={{ fontSize: 13, color: "#6b7280", textAlign: "right", fontFamily: "monospace" }}>
                    {row.currentVal}
                  </span>
                  <input
                    type="number"
                    step="1"
                    min="0"
                    placeholder="seuil"
                    value={row.newVal}
                    onChange={e => updateRow(row.id, e.target.value)}
                    style={{
                      border: `1.5px solid ${isChanged ? "#3b82f6" : "#d1d5db"}`,
                      borderRadius: 6, padding: "5px 8px", fontSize: 13,
                      fontFamily: "monospace", outline: "none",
                      background: isSaved ? "#dcfce7" : "#fff",
                      width: "100%", boxSizing: "border-box" as const,
                    }}
                    disabled={isSaved}
                    onKeyDown={e => {
                      // Tab → ligne suivante
                      if (e.key === "Enter" || e.key === "Tab") {
                        e.preventDefault();
                        const inputs = document.querySelectorAll<HTMLInputElement>(".seuil-input");
                        const idx = Array.from(inputs).indexOf(e.currentTarget);
                        if (idx >= 0 && idx < inputs.length - 1) inputs[idx + 1].focus();
                      }
                    }}
                    className="seuil-input"
                  />
                  <span style={{ fontSize: 16, textAlign: "center" }}>
                    {isSaved ? "✅" : isChanged ? "✏️" : ""}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Résumé bas de page */}
          <div style={{ fontSize: 12, color: "#6b7280", textAlign: "center", paddingBottom: 16 }}>
            {rows.filter(r => r.saved).length} enregistré(s) · {changedRows.length} en attente · {rows.length} article(s) au total
          </div>
        </>
      )}
    </div>
  );
}
