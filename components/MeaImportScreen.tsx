"use client";
// components/MeaImportScreen.tsx
// ─────────────────────────────────────────────────────────────────────────────
// CRÉATION APPARIÉE MEA — coller le tableau marketing, tout créer d'un coup.
//
// LE BESOIN
// Le marketing fournit une liste où chaque opération existe en DEUX codes :
//   7131491    → article commercial, vendable
//   AV7131491  → article physique, acheté et stocké
// Il faut créer les deux avec le même libellé, poser une nomenclature de type
// KIT sur le code 7 dont le composant est le code AV, puis mettre du stock sur
// l'emplacement AV. Fait à la main dans Odoo, c'est une dizaine de clics par
// ligne, répétés pour toute la liste.
//
// PARTI PRIS
// Rien n'est créé avant que l'écran ait montré ce qu'il va faire. On analyse
// d'abord, on affiche ce qui existe déjà, puis seulement on crée. Une référence
// déjà présente — même ARCHIVÉE, car Odoo refuse les doublons de référence dans
// ce cas aussi — est signalée et laissée intacte.
// ─────────────────────────────────────────────────────────────────────────────
import { useState, useEffect, useCallback } from "react";
import * as odoo from "@/lib/odoo";

// Articles servant de modèle pour la catégorie et l'unité de mesure. Les valeurs
// sont LUES dans Odoo, pas recopiées ici : si la catégorie évolue, les nouveaux
// articles suivent sans modification du code.
const REF_MODELE_7  = "7131427";
const REF_MODELE_AV = "AV7131427";

const C = {
  bg: "#f8fafc", white: "#fff", text: "#0f172a", textSec: "#475569",
  textMuted: "#94a3b8", border: "#e2e8f0", blue: "#2563eb",
  green: "#16a34a", greenSoft: "#f0fdf4", red: "#dc2626", redSoft: "#fef2f2",
  amber: "#d97706", amberSoft: "#fffbeb",
};

type EtatCode = "acreer" | "existe" | "archive";

interface Ligne {
  ref7: string;
  refAv: string;
  libelle: string;
  etat7: EtatCode;
  etatAv: EtatCode;
  id7: number | null;
  tmpl7: number | null;
  idAv: number | null;
  aDejaBom: boolean;
  qte: string;
  resultat?: string;
  erreur?: string;
}

/**
 * Analyse le collage Excel.
 *
 * On ne suppose RIEN de l'ordre des colonnes ni des lignes : le tableau
 * marketing alterne une ligne « code 7 + libellé » et une ligne « code AV + dates »,
 * mais cet ordre change d'un fichier à l'autre. On repère donc les codes par leur
 * forme, et on apparie sur le NUMÉRO — AV7131491 va avec 7131491, où qu'ils soient.
 */
function analyserCollage(texte: string): { lignes: Omit<Ligne, "etat7" | "etatAv" | "id7" | "tmpl7" | "idAv" | "aDejaBom" | "qte">[]; orphelins: string[] } {
  const libelleParNum = new Map<string, string>();
  const numsVus = new Set<string>();
  const numsAv = new Set<string>();

  for (const brute of texte.split(/\r?\n/)) {
    const ligne = brute.trim();
    if (!ligne) continue;
    const cellules = ligne.split(/\t|\s{2,}/).map(c => c.trim()).filter(Boolean);
    if (!cellules.length) continue;

    for (const cel of cellules) {
      const av = cel.match(/^AV(\d{6,})$/i);
      if (av) { numsAv.add(av[1]); numsVus.add(av[1]); continue; }
      const sept = cel.match(/^(\d{6,})$/);
      if (sept) {
        numsVus.add(sept[1]);
        // Le libellé est ce qui suit le code sur la même ligne, débarrassé des
        // cellules qui n'en font pas partie : la quantité (« 200 »), le « x » des
        // lignes sans quantité, et les plages de dates d'expédition. Sans ce tri,
        // un article s'appellerait « … - Standard 200 ».
        const reste = cellules
          .filter(x => x !== cel)
          .filter(x => !/^\d+([.,]\d+)?$/.test(x))          // quantité
          .filter(x => !/^x$/i.test(x))                      // marqueur « à définir »
          .filter(x => !/\d{2}\/\d{2}\/\d{4}/.test(x))       // plage de dates
          .join(" ")
          .trim();
        const actuel = libelleParNum.get(sept[1]) || "";
        if (reste.length > actuel.length) libelleParNum.set(sept[1], reste);
      }
    }
  }

  const lignes: any[] = [];
  const orphelins: string[] = [];
  for (const num of Array.from(numsVus).sort()) {
    const libelle = (libelleParNum.get(num) || "").trim();
    if (!libelle) { orphelins.push(num); continue; }
    lignes.push({ ref7: num, refAv: `AV${num}`, libelle });
  }
  return { lignes, orphelins };
}

export default function MeaImportScreen({
  session, onToast,
}: { session: odoo.OdooSession; onToast: (m: string, t?: "success" | "error" | "info") => void }) {

  const [collage, setCollage] = useState("");
  const [lignes, setLignes] = useState<Ligne[]>([]);
  const [orphelins, setOrphelins] = useState<string[]>([]);
  const [analyse, setAnalyse] = useState(false);
  const [creation, setCreation] = useState(false);
  const [erreur, setErreur] = useState("");
  const [fait, setFait] = useState(false);

  const [emplacements, setEmplacements] = useState<{ id: number; name: string }[]>([]);
  const [empId, setEmpId] = useState<number | null>(null);
  const [filtreEmp, setFiltreEmp] = useState("");

  useEffect(() => {
    odoo.getLocations(session)
      .then((l: any[]) => setEmplacements(l.map(x => ({ id: x.id, name: x.complete_name || x.name }))))
      .catch(() => {});
  }, [session]);

  const lancerAnalyse = useCallback(async () => {
    setErreur(""); setFait(false);
    const { lignes: brutes, orphelins: orph } = analyserCollage(collage);
    setOrphelins(orph);
    if (!brutes.length) {
      setLignes([]);
      setErreur("Aucun code reconnu. Colle les colonnes Code et Libellé depuis Excel.");
      return;
    }
    setAnalyse(true);
    try {
      const refs = brutes.flatMap(l => [l.ref7, l.refAv]);
      const existants = await odoo.findProductsByRefs(session, refs);

      // Nomenclature déjà posée ? On interroge uniquement les codes 7 existants.
      const tmplIds = brutes.map(l => existants[l.ref7]?.tmplId).filter(Boolean) as number[];
      const bomParTmpl = new Map<number, boolean>();
      await Promise.all(tmplIds.map(async t => {
        try { bomParTmpl.set(t, await odoo.hasBom(session, t)); } catch { bomParTmpl.set(t, false); }
      }));

      const etat = (r?: { active: boolean }): EtatCode => !r ? "acreer" : (r.active ? "existe" : "archive");

      setLignes(brutes.map(l => {
        const e7 = existants[l.ref7], eAv = existants[l.refAv];
        return {
          ...l,
          etat7: etat(e7), etatAv: etat(eAv),
          id7: e7?.id ?? null, tmpl7: e7?.tmplId ?? null, idAv: eAv?.id ?? null,
          aDejaBom: e7 ? (bomParTmpl.get(e7.tmplId) || false) : false,
          qte: "",
        };
      }));
    } catch (e: any) {
      setErreur(e?.message || String(e));
    }
    setAnalyse(false);
  }, [collage, session]);

  const majQte = (ref7: string, v: string) =>
    setLignes(prev => prev.map(l => l.ref7 === ref7 ? { ...l, qte: v.replace(/[^0-9]/g, "") } : l));

  const creerTout = async () => {
    if (creation) return;
    const avecQte = lignes.filter(l => Number(l.qte) > 0);
    if (avecQte.length && !empId) {
      setErreur("Choisis l'emplacement avant de créer : des quantités sont saisies.");
      return;
    }
    if (!confirm(
      `Créer ${lignes.length} opération(s) dans Odoo ?\n\n` +
      `Articles manquants créés, nomenclature kit posée sur le code 7, ` +
      `et stock ajouté pour ${avecQte.length} ligne(s).`
    )) return;

    setCreation(true); setErreur("");
    // Les réglages viennent d'articles existants : rien n'est figé dans le code.
    let def7: odoo.ProductDefaults = { categId: null, uomId: null };
    let defAv: odoo.ProductDefaults = { categId: null, uomId: null };
    try {
      [def7, defAv] = await Promise.all([
        odoo.getProductDefaults(session, REF_MODELE_7),
        odoo.getProductDefaults(session, REF_MODELE_AV),
      ]);
    } catch { /* on continuera avec les valeurs par défaut d'Odoo */ }

    // Séquentiel volontairement : en cas d'échec on sait exactement où ça s'est
    // arrêté, et on n'inonde pas Odoo de créations concurrentes.
    for (const l of lignes) {
      setLignes(prev => prev.map(x => x.ref7 === l.ref7 ? { ...x, resultat: "en cours…", erreur: undefined } : x));
      try {
        const etapes: string[] = [];

        if (l.etat7 === "acreer") {
          await odoo.createProductTemplate(session, {
            name: l.libelle, default_code: l.ref7,
            uom_id: def7.uomId || 1, tracking: "none",
            sale_ok: true, purchase_ok: false,
            ...(def7.categId ? { categId: def7.categId } : {}),
          });
          etapes.push("code 7 créé");
        }
        if (l.etatAv === "acreer") {
          await odoo.createProductTemplate(session, {
            name: l.libelle, default_code: l.refAv,
            uom_id: defAv.uomId || 1, tracking: "none",
            sale_ok: false, purchase_ok: true,
            ...(defAv.categId ? { categId: defAv.categId } : {}),
          });
          etapes.push("code AV créé");
        }

        // Relecture : createProductTemplate renvoie l'id du MODÈLE, alors que la
        // nomenclature et le stock ont besoin de la VARIANTE (product.product),
        // créée par Odoo juste après. On la relit donc plutôt que de la deviner.
        const apres = await odoo.findProductsByRefs(session, [l.ref7, l.refAv]);
        const p7 = apres[l.ref7], pAv = apres[l.refAv];
        if (!p7) throw new Error(`code 7 introuvable après création`);
        if (!pAv) throw new Error(`code AV introuvable après création`);

        const dejaBom = l.aDejaBom || await odoo.hasBom(session, p7.tmplId);
        if (!dejaBom) {
          await odoo.createKitBom(session, p7.tmplId, pAv.id, 1);
          etapes.push("nomenclature kit posée");
        } else {
          etapes.push("nomenclature déjà présente");
        }

        const q = Number(l.qte);
        if (q > 0 && empId) {
          await odoo.createInventoryAdjustment(session, pAv.id, empId, q, undefined, `Création MEA ${l.ref7}`);
          etapes.push(`stock ${q} posé`);
        }

        setLignes(prev => prev.map(x => x.ref7 === l.ref7
          ? { ...x, resultat: etapes.join(" · "), etat7: "existe", etatAv: "existe", aDejaBom: true }
          : x));
      } catch (e: any) {
        setLignes(prev => prev.map(x => x.ref7 === l.ref7
          ? { ...x, resultat: undefined, erreur: odoo.safeErrMsg?.(e) || e?.message || String(e) }
          : x));
      }
    }
    setCreation(false);
    setFait(true);
    onToast("Création terminée — vérifie le détail ligne par ligne", "success");
  };

  const empFiltres = filtreEmp.trim()
    ? emplacements.filter(e => e.name.toLowerCase().includes(filtreEmp.toLowerCase())).slice(0, 40)
    : emplacements.slice(0, 40);

  const nbACreer = lignes.filter(l => l.etat7 === "acreer" || l.etatAv === "acreer").length;
  const nbArchive = lignes.filter(l => l.etat7 === "archive" || l.etatAv === "archive").length;

  const pastille = (e: EtatCode) => {
    const m = { acreer: ["à créer", C.blue], existe: ["existe", C.textMuted], archive: ["ARCHIVÉ", C.amber] } as const;
    const [txt, col] = m[e];
    return <span style={{ fontSize: 10.5, fontWeight: 700, color: col as string }}>{txt}</span>;
  };

  return (
    <div style={{ padding: 16, fontFamily: "'DM Sans', sans-serif" }}>
      <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 12, padding: 14, marginBottom: 14 }}>
        <div style={{ fontSize: 12.5, color: C.textSec, lineHeight: 1.6, marginBottom: 10 }}>
          Colle les colonnes <strong>Code composant</strong> et <strong>Libellé</strong> du tableau marketing.
          Les codes <code>7…</code> et <code>AV7…</code> sont appariés automatiquement par leur numéro,
          quel que soit l&apos;ordre des lignes. <strong>Rien n&apos;est créé avant l&apos;analyse.</strong>
        </div>
        <textarea
          value={collage}
          onChange={e => setCollage(e.target.value)}
          placeholder={"7131492\tMEA Laits et les Huiles de Soin 2026 - Standard\nAV7131492\n7131493\tMEA Laits et les Huiles de Soin 2026 - Essentiel\nAV7131493"}
          style={{ width: "100%", minHeight: 130, padding: 10, border: `1px solid ${C.border}`, borderRadius: 9, fontSize: 12.5, fontFamily: "ui-monospace, monospace", resize: "vertical" as const }}
        />
        <button onClick={lancerAnalyse} disabled={analyse || !collage.trim()}
          style={{ marginTop: 10, padding: "10px 18px", background: analyse || !collage.trim() ? "#cbd5e1" : C.blue, color: "#fff", border: "none", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: analyse ? "default" : "pointer", fontFamily: "inherit" }}>
          {analyse ? "Analyse…" : "Analyser"}
        </button>
      </div>

      {erreur && (
        <div style={{ background: C.redSoft, border: "1px solid #fecaca", borderRadius: 10, padding: 11, marginBottom: 12, fontSize: 13, color: "#991b1b" }}>{erreur}</div>
      )}

      {orphelins.length > 0 && (
        <div style={{ background: C.amberSoft, border: "1px solid #fde68a", borderRadius: 10, padding: 11, marginBottom: 12, fontSize: 12.5, color: "#92400e" }}>
          <strong>{orphelins.length} code(s) sans libellé</strong> — ignorés : {orphelins.join(", ")}.
          Un article ne peut pas être créé sans nom ; ajoute le libellé sur la même ligne que le code.
        </div>
      )}

      {lignes.length > 0 && (
        <>
          <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 12, padding: 14, marginBottom: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 8 }}>
              Emplacement pour le stock AV
            </div>
            <input value={filtreEmp} onChange={e => setFiltreEmp(e.target.value)} placeholder="Filtrer les emplacements…"
              style={{ width: "100%", padding: 9, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 13, marginBottom: 8, fontFamily: "inherit" }} />
            <select value={empId ?? ""} onChange={e => setEmpId(e.target.value ? Number(e.target.value) : null)}
              style={{ width: "100%", padding: 9, border: `1px solid ${empId ? C.border : "#fca5a5"}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", background: "#fff" }}>
              <option value="">— choisir un emplacement —</option>
              {empFiltres.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
            <div style={{ fontSize: 11.5, color: C.textMuted, marginTop: 6 }}>
              Le stock est posé sur le code <strong>AV</strong>, jamais sur le code 7 : c&apos;est l&apos;article physique.
              Laisse une quantité vide pour créer l&apos;article sans stock.
            </div>
          </div>

          <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden", marginBottom: 14 }}>
            <div style={{ padding: "10px 14px", borderBottom: `1px solid ${C.border}`, fontSize: 12.5, color: C.textSec }}>
              <strong>{lignes.length}</strong> opération(s) · <strong>{nbACreer}</strong> avec au moins un article à créer
              {nbArchive > 0 && <> · <span style={{ color: C.amber, fontWeight: 700 }}>{nbArchive} référence(s) archivée(s)</span></>}
            </div>
            {lignes.map((l, i) => (
              <div key={l.ref7} style={{ padding: "10px 14px", borderTop: i > 0 ? `1px solid ${C.border}` : "none", display: "flex", gap: 12, alignItems: "flex-start" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{l.libelle}</div>
                  <div style={{ fontSize: 11.5, color: C.textSec, marginTop: 3, display: "flex", gap: 12, flexWrap: "wrap" as const }}>
                    <span>{l.ref7} {pastille(l.etat7)}</span>
                    <span>{l.refAv} {pastille(l.etatAv)}</span>
                    {l.aDejaBom && <span style={{ color: C.textMuted }}>nomenclature déjà là</span>}
                  </div>
                  {l.resultat && <div style={{ fontSize: 11.5, color: C.green, marginTop: 4 }}>✓ {l.resultat}</div>}
                  {l.erreur && <div style={{ fontSize: 11.5, color: C.red, marginTop: 4, fontFamily: "monospace", wordBreak: "break-word" as const }}>✕ {l.erreur}</div>}
                </div>
                <div style={{ flexShrink: 0, textAlign: "right" as const }}>
                  <input value={l.qte} onChange={e => majQte(l.ref7, e.target.value)} placeholder="qté"
                    inputMode="numeric"
                    style={{ width: 76, padding: "7px 9px", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 13, textAlign: "right" as const, fontFamily: "inherit" }} />
                </div>
              </div>
            ))}
          </div>

          <button onClick={creerTout} disabled={creation}
            style={{ width: "100%", padding: 14, background: creation ? "#cbd5e1" : C.green, color: "#fff", border: "none", borderRadius: 11, fontSize: 15, fontWeight: 700, cursor: creation ? "default" : "pointer", fontFamily: "inherit" }}>
            {creation ? "Création en cours…" : fait ? "Relancer sur les lignes en échec" : `Créer ${lignes.length} opération(s) dans Odoo`}
          </button>
        </>
      )}
    </div>
  );
}
