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
  { code: 1,  label: "Visage + pré série" },
  { code: 2,  label: "Régénérant + pré série" },
  { code: 3,  label: "Corps + pré série" },
  { code: 4,  label: "Hygiène + pré série" },
  { code: 5,  label: "Med + pré série" },
  { code: 6,  label: "Maquillage + pré série" },
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
  body:    { flex: 1, padding: "16px", display: "flex", flexDirection: "column" as const, gap: 12, maxWidth: 520, width: "100%", margin: "0 auto" },
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

// ─── Composant principal ──────────────────────────────────────────────────────

interface Props {
  session: odoo.OdooSession;
  onBack: () => void;
  onToast: (msg: string, type?: "success" | "error" | "info") => void;
}

export default function ArticleCreatorScreen({ session, onBack, onToast }: Props) {
  // ── Sélections codification
  const [catCode,  setCatCode]  = useState("1");
  const [famCode,  setFamCode]  = useState(1);
  const [sfCode,   setSfCode]   = useState(1);

  // ── Infos produit
  const [designation, setDesignation] = useState("");
  const [barcode,     setBarcode]     = useState("");
  const [uomId,       setUomId]       = useState<number | null>(null);
  const [tracking,    setTracking]    = useState<"none"|"lot"|"serial">("lot");
  const [weight,      setWeight]      = useState("");

  // ── État
  const [uoms,         setUoms]         = useState<{ id: number; name: string }[]>([]);
  const [existingCodes, setExistingCodes] = useState<string[]>([]);
  const [loadingCodes,  setLoadingCodes]  = useState(false);
  const [creating,      setCreating]      = useState(false);
  const [created,       setCreated]       = useState<{ id: number; code: string; name: string } | null>(null);

  const availableSFs = SOUS_FAMILLES[famCode] || [];

  // Code généré
  const prefix  = buildPrefix(catCode, famCode, sfCode);
  const nextSeq = computeNextSeq(existingCodes, prefix);
  const generatedCode = `${prefix}${String(nextSeq).padStart(2, "0")}`;
  const isAvailable = !existingCodes.includes(generatedCode);

  // ── Charger les UoMs au montage
  useEffect(() => {
    odoo.getUoMs(session).then(list => {
      setUoms(list);
      const pce = list.find(u => /unit|pce|pièce|unité/i.test(u.name));
      if (pce) setUomId(pce.id);
      else if (list.length) setUomId(list[0].id);
    }).catch(() => {});
  }, [session]);

  // ── Recharger les codes existants quand le préfixe change
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

  // ── Réinitialiser SF quand la famille change
  useEffect(() => {
    const sfs = SOUS_FAMILLES[famCode] || [];
    if (sfs.length) setSfCode(sfs[0].code);
  }, [famCode]);

  // ── Créer dans Odoo
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
      // Réinitialiser pour une prochaine création
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
    <div style={S.screen}>
      {/* Header */}
      <div style={S.header}>
        <button style={S.backBtn} onClick={onBack}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <p style={S.title}>Création article</p>
      </div>

      <div style={S.body}>

        {/* Code généré */}
        <div style={{ ...S.codeBox, background: isAvailable ? "#f0fdf4" : "#fff7ed", border: `1.5px solid ${isAvailable ? "#bbf7d0" : "#fed7aa"}` }}>
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>
              Code généré
            </div>
            <div style={{ ...S.codeTxt, color: isAvailable ? "#166534" : "#9a3412" }}>
              {loadingCodes ? "…" : generatedCode}
            </div>
            <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2 }}>
              {catLabel} · {famLabel} · {sfLabel}
            </div>
          </div>
          <span style={S.badge(isAvailable)}>
            {isAvailable ? "✅ Disponible" : "❌ Doublon"}
          </span>
        </div>

        {/* Dernière création */}
        {created && (
          <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 10, padding: "10px 14px", fontSize: 13, color: "#166534" }}>
            ✓ <b>{created.code}</b> — {created.name} créé dans Odoo (ID {created.id})
          </div>
        )}

        {/* Sélecteurs de codification */}
        <div style={S.card}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 12 }}>
            Codification
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={S.field}>
              <label style={S.label}>Catégorie</label>
              <select style={S.select} value={catCode} onChange={e => setCatCode(e.target.value)}>
                {CATEGORIES.map(c => (
                  <option key={c.code} value={c.code}>{c.code} — {c.label}</option>
                ))}
              </select>
            </div>

            <div style={S.field}>
              <label style={S.label}>Famille</label>
              <select style={S.select} value={famCode} onChange={e => setFamCode(Number(e.target.value))}>
                {FAMILLES.map(f => (
                  <option key={f.code} value={f.code}>{String(f.code).padStart(2,"0")} — {f.label}</option>
                ))}
              </select>
            </div>

            {availableSFs.length > 0 && (
              <div style={S.field}>
                <label style={S.label}>Sous-famille</label>
                <select style={S.select} value={sfCode} onChange={e => setSfCode(Number(e.target.value))}>
                  {availableSFs.map(s => (
                    <option key={s.code} value={s.code}>{String(s.code).padStart(2,"0")} — {s.label}</option>
                  ))}
                </select>
              </div>
            )}
          </div>
        </div>

        {/* Infos produit */}
        <div style={S.card}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 12 }}>
            Informations produit
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={S.field}>
              <label style={S.label}>Désignation complète *</label>
              <input
                style={S.input}
                placeholder="ex: Crème de Jour Apaisante - 30 ml"
                value={designation}
                onChange={e => setDesignation(e.target.value)}
              />
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

        {/* Bouton créer */}
        <button
          style={{
            ...S.btn,
            background: isAvailable && designation.trim() && uomId ? "#2563eb" : "#e5e7eb",
            color: isAvailable && designation.trim() && uomId ? "#fff" : "#9ca3af",
          }}
          onClick={handleCreate}
          disabled={creating || !isAvailable || !designation.trim() || !uomId}
        >
          {creating ? "Création en cours…" : `Créer ${generatedCode} dans Odoo`}
        </button>

        {/* Codes existants du même préfixe */}
        {existingCodes.length > 0 && (
          <div style={{ ...S.card, background: "#f9fafb" }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
              Codes existants ({existingCodes.length}) — préfixe {prefix}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 6 }}>
              {existingCodes.sort().map(c => (
                <span key={c} style={{ fontFamily: "monospace", fontSize: 12, background: "#e5e7eb", padding: "2px 8px", borderRadius: 6, color: "#374151" }}>
                  {c}
                </span>
              ))}
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
