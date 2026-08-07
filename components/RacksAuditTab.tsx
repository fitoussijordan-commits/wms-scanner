"use client";
// components/RacksAuditTab.tsx — audit des emplacements composés
//
// À l'entrepôt, un article a UN emplacement Odoo dont le nom assemble sa face
// de picking et ses racks de réserve : « A12-RKC1-RKC11-RKC21 ». Odoo n'y voit
// qu'un texte ; cet écran lui rend sa structure et signale ce qui cloche.
//
// Deux usages :
//   - vérifier que le décodage correspond à la réalité du terrain, AVANT que
//     d'autres écrans s'appuient dessus ;
//   - repérer un rack déclaré sur plusieurs emplacements, qui est soit une
//     faute de saisie, soit un rangement à clarifier.

import { useState, useEffect } from "react";
import * as odoo from "@/lib/odoo";
import { decoderEmplacement, trouverCollisions, type CollisionRack } from "@/lib/emplacements";
import { useEcranEtroit } from "@/lib/useEcranEtroit";
import { loadRacksPartages, saveRacksPartages, type RackPartage } from "@/lib/supabase";

const C = {
  bg: "#f8fafc", white: "#fff", text: "#0f172a", textSec: "#374151",
  textMuted: "#64748b", border: "#e2e8f0", blue: "#2563eb", blueSoft: "#eff6ff",
  green: "#16a34a", red: "#dc2626", redSoft: "#fef2f2",
  orange: "#ea580c", orangeSoft: "#fff7ed", purple: "#7c3aed",
};

interface Ligne {
  id: number;
  nom: string;
  articles: string[];
  picking: string;
  reserves: string[];
  abrege: boolean;
}

export default function RacksAuditTab({ session, onToast }: {
  session: odoo.OdooSession;
  onToast: (msg: string, type?: "success" | "error" | "info") => void;
}) {
  const etroit = useEcranEtroit();
  const [lignes, setLignes] = useState<Ligne[] | null>(null);
  const [collisions, setCollisions] = useState<CollisionRack[]>([]);
  const [chargement, setChargement] = useState(false);
  const [recherche, setRecherche] = useState("");
  const [vue, setVue] = useState<"collisions" | "tout">("collisions");
  // Partages assumés : un rack peut légitimement porter plusieurs articles.
  // Sans cette liste, les cas corrects resteraient signalés indéfiniment et
  // l'écran finirait par ne plus être regardé.
  const [partagesOk, setPartagesOk] = useState<RackPartage[]>([]);
  const [voirPartages, setVoirPartages] = useState(false);

  const charger = async () => {
    setChargement(true);
    try {
      // TOUS les emplacements internes, pas seulement ceux qui ont du stock.
      // Un emplacement vidé garde son nom : s'il revendique encore un rack,
      // il faut le voir. Ne lire que les quants créait un angle mort.
      const locs = await odoo.searchReadAll(session, "stock.location",
        [["usage", "=", "internal"]], ["id", "name", "complete_name"], "");

      const quants = await odoo.searchReadAll(session, "stock.quant",
        [["location_id.usage", "=", "internal"], ["quantity", ">", 0]],
        ["id", "product_id", "location_id", "quantity"], "");

      const articlesParLoc: Record<number, Set<string>> = {};
      for (const q of quants as any[]) {
        if (!Array.isArray(q.location_id)) continue;
        const art = Array.isArray(q.product_id) ? String(q.product_id[1] || "") : "";
        if (art) (articlesParLoc[q.location_id[0]] ||= new Set()).add(art);
      }

      const liste: Ligne[] = (locs as any[]).map(l => {
        const nom = String(l.complete_name || l.name || "");
        const d = decoderEmplacement(nom);
        return {
          id: l.id, nom,
          articles: Array.from(articlesParLoc[l.id] || []),
          picking: d.picking, reserves: d.reserves, abrege: d.abrege,
        };
      })
        // Sans rack déclaré, rien à auditer — inutile d'alourdir la liste.
        .filter(l => l.reserves.length > 0)
        .sort((a, b) => a.nom.localeCompare(b.nom));

      setLignes(liste);
      setCollisions(trouverCollisions(liste.map(l => ({ id: l.id, nom: l.nom, articles: l.articles }))));
    } catch (e: any) {
      onToast("Erreur : " + (e?.message || e), "error");
    }
    setChargement(false);
  };

  useEffect(() => {
    charger();
    loadRacksPartages().then(setPartagesOk).catch(() => {});
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, []);

  /**
   * Assume (ou retire) un partage, en mémorisant la situation validée.
   *
   * Les emplacements concernés sont enregistrés avec le code : si demain la
   * liste change — un article déménage, un emplacement est vidé — le partage
   * n'est plus celui qui a été validé, et l'écran le redemande au lieu de
   * rester muet.
   */
  const basculerPartage = async (col: CollisionRack) => {
    const deja = partagesOk.some(p => p.code === col.code);
    const suivant = deja
      ? partagesOk.filter(p => p.code !== col.code)
      : [...partagesOk, {
          code: col.code,
          emplacements: col.emplacements.map(e => e.id),
          le: new Date().toISOString().slice(0, 10),
        }];
    setPartagesOk(suivant);
    try { await saveRacksPartages(suivant); }
    catch (e: any) { onToast("Non enregistré : " + (e?.message || e), "error"); }
  };

  /**
   * Le partage validé décrit-il encore la réalité ?
   *
   * On compare les emplacements du moment à ceux enregistrés. Toute différence
   * — en plus ou en moins — signifie que la décision portait sur autre chose.
   */
  const partageAJour = (col: CollisionRack): { assume: boolean; aRevoir: boolean; le: string } => {
    const p = partagesOk.find(x => x.code === col.code);
    if (!p) return { assume: false, aRevoir: false, le: "" };
    const avant = [...p.emplacements].sort().join(",");
    const maintenant = col.emplacements.map(e => e.id).sort().join(",");
    // Sans emplacements enregistrés (ancien format), on redemande.
    const aRevoir = !p.emplacements.length || avant !== maintenant;
    return { assume: true, aRevoir, le: p.le };
  };

  /**
   * Attribue un rack à un seul emplacement et le retire de tous les autres.
   *
   * C'est l'opération qu'on ne peut pas faire à la main quand un rack traîne
   * sur neuf références : il faudrait ouvrir neuf fiches sans en oublier une.
   *
   * Les échecs sont comptés et nommés plutôt que d'annuler l'ensemble — neuf
   * corrections dont une ratée vaut mieux qu'un abandon complet.
   */
  const [correction, setCorrection] = useState<string | null>(null);
  /** Emplacements CONSERVÉS pour chaque rack. Absent = tous conservés. */
  const [selection, setSelection] = useState<Record<string, Set<number>>>({});

  const retirerDeSelection = async (col: CollisionRack, aRetirer: { id: number; nom: string }[]) => {
    if (!aRetirer.length) return;
    const restants = col.emplacements.length - aRetirer.length;
    if (!confirm(
      `Retirer ${col.code} de ${aRetirer.length} emplacement(s) ?\n\n` +
      aRetirer.slice(0, 6).map(e => `• ${e.nom.split("/").pop()}`).join("\n") +
      (aRetirer.length > 6 ? `\n… et ${aRetirer.length - 6} autre(s)` : "") +
      `\n\nIl restera sur ${restants} emplacement(s).\n` +
      `Seul le NOM change — aucun stock n'est déplacé.`
    )) return;

    setCorrection(col.code);
    let ok = 0; const echecs: string[] = [];
    for (const e of aRetirer) {
      try { await odoo.retirerRacksDuNom(session, e.id, [col.code]); ok++; }
      catch (err: any) { echecs.push(`${e.nom} : ${err?.message || err}`); }
    }
    onToast(echecs.length
      ? `${ok} corrigé(s), ${echecs.length} échec(s) — ${echecs[0]}`
      : `✓ ${col.code} retiré de ${ok} emplacement(s)`,
      echecs.length ? "error" : "success");
    // La sélection porte sur des données qu'on vient de changer : on repart
    // d'une page propre plutôt que de garder des cases sur d'anciens états.
    setSelection(prev => { const n = { ...prev }; delete n[col.code]; return n; });
    setCorrection(null);
    await charger();
  };

  const q = recherche.trim().toUpperCase();
  const visibles = (lignes || []).filter(l =>
    !q || l.nom.toUpperCase().includes(q)
    || l.reserves.some(r => r.includes(q))
    || l.articles.some(a => a.toUpperCase().includes(q)));

  const abreges = (lignes || []).filter(l => l.abrege).length;

  // Les partages assumés sortent de la liste par défaut : c'est ce qui la garde
  // utile. Le compteur permet de les retrouver quand on veut les revoir.
  const collisionsAffichees = collisions
    .filter(c => {
      const { assume, aRevoir } = partageAJour(c);
      // Un partage assumé disparaît — sauf si la situation a changé depuis.
      return voirPartages || !assume || aRevoir;
    })
    .filter(c => !q || c.code.includes(q));
  const nbPartages = collisions.filter(c => {
    const { assume, aRevoir } = partageAJour(c);
    return assume && !aRevoir;
  }).length;

  return (
    <div>
      <div style={{ fontSize: 12.5, color: C.textMuted, lineHeight: 1.5, marginBottom: 12 }}>
        Les noms d&apos;emplacement assemblent la face de picking et les racks de réserve.
        Cet écran les décode et montre les racks déclarés à plusieurs endroits — ce qui
        peut être une faute de saisie <em>ou</em> un partage voulu. À toi de trancher.
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
        {([["collisions", `Racks partagés (${collisionsAffichees.length})`], ["tout", `Tous les emplacements (${lignes?.length ?? 0})`]] as const).map(([k, label]) => (
          <button key={k} onClick={() => setVue(k)}
            style={{ padding: etroit ? "10px 13px" : "8px 14px", borderRadius: 9, cursor: "pointer", fontFamily: "inherit", fontSize: 12.5, fontWeight: 700,
                     border: `1.5px solid ${vue === k ? C.blue : C.border}`,
                     background: vue === k ? C.blueSoft : C.white, color: vue === k ? C.blue : C.textSec }}>
            {label}
          </button>
        ))}
        <button onClick={charger} disabled={chargement}
          style={{ padding: etroit ? "10px 13px" : "8px 14px", borderRadius: 9, cursor: "pointer", fontFamily: "inherit", fontSize: 12.5, fontWeight: 700, border: `1.5px solid ${C.border}`, background: C.white, color: C.textSec, marginLeft: "auto" }}>
          {chargement ? "…" : "↻"}
        </button>
      </div>

      {abreges > 0 && (
        <div style={{ background: C.orangeSoft, border: "1px solid #fed7aa", borderRadius: 10, padding: 10, marginBottom: 12, fontSize: 12, color: "#7c2d12" }}>
          <strong>{abreges} emplacement(s) écrits en abrégé</strong> — le préfixe du rack précédent a été
          rétabli automatiquement (« RKF1-F2 » lu RKF1, RKF2). Vérifie-les dans l&apos;onglet « tous les
          emplacements » : c&apos;est là que je peux me tromper.
        </div>
      )}

      <input value={recherche} onChange={e => setRecherche(e.target.value)}
        placeholder="Rechercher un rack, un emplacement, un article…"
        style={{ width: "100%", boxSizing: "border-box", padding: etroit ? "11px 12px" : "9px 12px", border: `1.5px solid ${C.border}`, borderRadius: 10, fontSize: etroit ? 14 : 13, fontFamily: "inherit", outline: "none", marginBottom: 12 }} />

      {chargement && !lignes && <div style={{ textAlign: "center", color: C.textMuted, padding: 40 }}>Lecture du stock…</div>}

      {nbPartages > 0 && (
        <button onClick={() => setVoirPartages(v => !v)}
          style={{ width: "100%", padding: 10, marginBottom: 10, background: C.white, border: `1.5px solid ${C.border}`, borderRadius: 9, fontSize: 12.5, fontWeight: 700, color: C.textSec, cursor: "pointer", fontFamily: "inherit" }}>
          {voirPartages ? `Masquer les ${nbPartages} partage(s) assumé(s)` : `Voir les ${nbPartages} partage(s) assumé(s)`}
        </button>
      )}

      {/* ── Racks partagés ── */}
      {vue === "collisions" && lignes && (
        collisionsAffichees.length === 0 ? (
          <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 11, padding: 14, fontSize: 13, color: "#15803d" }}>
            ✓ Rien à trancher — aucun rack partagé sans décision.
          </div>
        ) : (
          collisionsAffichees.map(c => {
            const { assume, aRevoir, le } = partageAJour(c);
            const gardes = selection[c.code] ?? new Set(c.emplacements.map(e => e.id));
            const aRetirer = c.emplacements.filter(e => !gardes.has(e.id));
            return (
              <div key={c.code} style={{ background: C.white, border: `1.5px solid ${assume ? C.border : "#fecaca"}`, borderRadius: 12, padding: 12, marginBottom: 12 }}>
                {/* En-tête : le code du rack, gros et lisible au bras tendu */}
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 20, fontWeight: 800, fontFamily: "monospace", color: aRevoir ? C.orange : assume ? C.text : C.red, lineHeight: 1.1 }}>{c.code}</div>
                    <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>
                      sur {c.emplacements.length} emplacements
                      {assume && !aRevoir && <span style={{ color: C.green, fontWeight: 700 }}> · partage assumé{le ? ` le ${le}` : ""}</span>}
                    </div>
                  </div>
                </div>

                {aRevoir && (
                  <div style={{ background: C.orangeSoft, border: "1px solid #fed7aa", borderRadius: 9, padding: 9, marginTop: 6, fontSize: 12, color: "#7c2d12", lineHeight: 1.45 }}>
                    <strong>Partage à revoir.</strong> Tu avais validé ce partage{le ? ` le ${le}` : ""},
                    mais les emplacements concernés ont changé depuis. Tranche à nouveau.
                  </div>
                )}

                <button onClick={() => basculerPartage(c)}
                  style={{ width: "100%", padding: 10, margin: "8px 0", borderRadius: 9, cursor: "pointer", fontFamily: "inherit", fontSize: 12.5, fontWeight: 700,
                           border: `1.5px solid ${assume && !aRevoir ? "#bbf7d0" : C.border}`,
                           background: assume && !aRevoir ? "#f0fdf4" : C.white,
                           color: assume && !aRevoir ? C.green : C.textSec }}>
                  {assume && !aRevoir ? "✓ Partage voulu — ne plus signaler"
                    : aRevoir ? "Revalider ce partage" : "C'est un partage voulu"}
                </button>

                {/* Une ligne par emplacement : coché = le rack y reste. */}
                <div style={{ fontSize: 11.5, color: C.textMuted, marginBottom: 5 }}>
                  Décoche les emplacements qui ne sont <strong>pas</strong> sur ce rack :
                </div>
                {c.emplacements.map(e => {
                  const garde = gardes.has(e.id);
                  return (
                    <label key={e.id} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: 10, marginBottom: 5,
                                               background: garde ? C.bg : "#fff7ed",
                                               border: `1px solid ${garde ? C.border : "#fed7aa"}`,
                                               borderRadius: 9, cursor: "pointer" }}>
                      <input type="checkbox" checked={garde}
                        onChange={() => setSelection(prev => {
                          const cur = new Set(prev[c.code] ?? c.emplacements.map(x => x.id));
                          garde ? cur.delete(e.id) : cur.add(e.id);
                          return { ...prev, [c.code]: cur };
                        })}
                        style={{ width: 20, height: 20, marginTop: 1, flexShrink: 0, accentColor: C.green }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13.5, fontWeight: 700, fontFamily: "monospace", color: C.text, wordBreak: "break-all", lineHeight: 1.3 }}>
                          {e.nom.split("/").pop()}
                        </div>
                        <div style={{ fontSize: 11.5, color: C.textMuted, marginTop: 2, lineHeight: 1.4 }}>
                          {e.articles.slice(0, 3).join(" · ") || "aucun article"}
                          {e.articles.length > 3 && ` … +${e.articles.length - 3}`}
                        </div>
                        {!garde && (
                          <div style={{ fontSize: 11.5, color: C.orange, fontWeight: 700, marginTop: 3 }}>
                            {c.code} sera retiré de ce nom
                          </div>
                        )}
                      </div>
                    </label>
                  );
                })}

                {aRetirer.length > 0 && (
                  <button onClick={() => retirerDeSelection(c, aRetirer)} disabled={correction === c.code}
                    style={{ width: "100%", padding: 13, marginTop: 4, background: correction === c.code ? "#94a3b8" : "#b91c1c",
                             color: "#fff", border: "none", borderRadius: 10, fontSize: 13.5, fontWeight: 800,
                             cursor: "pointer", fontFamily: "inherit" }}>
                    {correction === c.code ? "Correction…" : `Retirer ${c.code} de ${aRetirer.length} emplacement(s)`}
                  </button>
                )}
              </div>
            );
          })
        )
      )}

      {/* ── Décodage de tous les emplacements ── */}
      {vue === "tout" && lignes && (
        <>
          <div style={{ fontSize: 11.5, color: C.textMuted, marginBottom: 8 }}>
            {visibles.length} emplacement(s). Vérifie que la colonne « réserves » correspond à la réalité.
          </div>
          {visibles.map(l => (
            <div key={l.id} style={{ background: C.white, border: `1px solid ${l.abrege ? "#fed7aa" : C.border}`, borderRadius: 10, padding: 11, marginBottom: 8 }}>
              {/* Le chemin Odoo complet n'apporte rien sur un téléphone : on
                  garde le dernier maillon, seul lisible et seul utile. */}
              <div style={{ fontSize: 12, fontFamily: "monospace", color: C.textMuted, wordBreak: "break-all" }}>
                {l.nom.split("/").pop()}
              </div>
              <div style={{ marginTop: 7 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: .4 }}>Picking</div>
                <div style={{ fontSize: 19, fontWeight: 800, color: C.text, fontFamily: "monospace", lineHeight: 1.2 }}>{l.picking || "—"}</div>
              </div>
              <div style={{ marginTop: 7 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: .4 }}>
                  Réserves{l.abrege && <span style={{ color: C.orange }}> · abrégé</span>}
                </div>
                {/* Une pastille par rack : sur un écran étroit, une ligne
                    « RKC1 · RKC11 · RKC21 » se coupe n'importe où. */}
                <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 3 }}>
                  {l.reserves.length ? l.reserves.map(r => (
                    <span key={r} style={{ fontSize: 13, fontWeight: 700, fontFamily: "monospace", color: C.text,
                                           background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6, padding: "3px 8px" }}>
                      {r}
                    </span>
                  )) : <span style={{ fontSize: 13, color: C.textMuted }}>aucune</span>}
                </div>
              </div>
              <div style={{ fontSize: 11.5, color: C.textMuted, marginTop: 8, lineHeight: 1.45 }}>
                {l.articles.length} article(s)
                {l.articles.length > 0 && <><br />{l.articles.slice(0, 3).join(" · ")}
                  {l.articles.length > 3 && ` … +${l.articles.length - 3}`}</>}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
