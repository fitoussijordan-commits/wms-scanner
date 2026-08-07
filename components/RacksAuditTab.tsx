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

const C = {
  bg: "#f8fafc", white: "#fff", text: "#0f172a", textSec: "#374151",
  textMuted: "#64748b", border: "#e2e8f0", blue: "#2563eb", blueSoft: "#eff6ff",
  green: "#16a34a", red: "#dc2626", redSoft: "#fef2f2",
  orange: "#ea580c", orangeSoft: "#fff7ed", purple: "#7c3aed",
};

interface Ligne {
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

  const charger = async () => {
    setChargement(true);
    try {
      // Le stock réel plutôt que les règles de rangement : c'est ce qui est
      // physiquement là qui compte, pas ce qui était prévu.
      const quants = await odoo.searchReadAll(session, "stock.quant",
        [["location_id.usage", "=", "internal"], ["quantity", ">", 0]],
        ["id", "product_id", "location_id", "quantity"], "");

      const parEmplacement: Record<string, Set<string>> = {};
      for (const q of quants as any[]) {
        const nom = Array.isArray(q.location_id) ? String(q.location_id[1] || "") : "";
        if (!nom) continue;
        const art = Array.isArray(q.product_id) ? String(q.product_id[1] || "") : "";
        (parEmplacement[nom] ||= new Set()).add(art);
      }

      const liste: Ligne[] = Object.entries(parEmplacement).map(([nom, arts]) => {
        const d = decoderEmplacement(nom);
        return { nom, articles: Array.from(arts), picking: d.picking, reserves: d.reserves, abrege: d.abrege };
      }).sort((a, b) => a.nom.localeCompare(b.nom));

      setLignes(liste);
      setCollisions(trouverCollisions(liste.map(l => ({ nom: l.nom, articles: l.articles }))));
    } catch (e: any) {
      onToast("Erreur : " + (e?.message || e), "error");
    }
    setChargement(false);
  };

  useEffect(() => { charger(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const q = recherche.trim().toUpperCase();
  const visibles = (lignes || []).filter(l =>
    !q || l.nom.toUpperCase().includes(q)
    || l.reserves.some(r => r.includes(q))
    || l.articles.some(a => a.toUpperCase().includes(q)));

  const abreges = (lignes || []).filter(l => l.abrege).length;

  return (
    <div>
      <div style={{ fontSize: 12.5, color: C.textMuted, lineHeight: 1.5, marginBottom: 12 }}>
        Les noms d&apos;emplacement assemblent la face de picking et les racks de réserve.
        Cet écran les décode et signale les racks déclarés à plusieurs endroits.
        <strong> Rien n&apos;est modifié dans Odoo</strong> — c&apos;est une lecture.
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
        {([["collisions", `⚠ Racks en double (${collisions.length})`], ["tout", `Tous les emplacements (${lignes?.length ?? 0})`]] as const).map(([k, label]) => (
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

      {/* ── Racks partagés ── */}
      {vue === "collisions" && lignes && (
        collisions.length === 0 ? (
          <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 11, padding: 14, fontSize: 13, color: "#15803d" }}>
            ✓ Aucun rack déclaré sur plusieurs emplacements.
          </div>
        ) : (
          collisions
            .filter(c => !q || c.code.includes(q))
            .map(c => (
              <div key={c.code} style={{ background: C.white, border: "1.5px solid #fecaca", borderRadius: 11, padding: 12, marginBottom: 10 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
                  <div style={{ fontSize: 16, fontWeight: 800, fontFamily: "monospace", color: C.red }}>{c.code}</div>
                  <div style={{ fontSize: 12, color: C.textMuted }}>sur {c.emplacements.length} emplacements</div>
                </div>
                {c.emplacements.map((e, i) => (
                  <div key={i} style={{ background: C.bg, borderRadius: 8, padding: 9, marginBottom: 5 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, fontFamily: "monospace", color: C.text, wordBreak: "break-all" }}>{e.nom}</div>
                    <div style={{ fontSize: 11.5, color: C.textMuted, marginTop: 2, lineHeight: 1.4 }}>
                      {e.articles.slice(0, 4).join(" · ")}
                      {e.articles.length > 4 && ` … +${e.articles.length - 4}`}
                    </div>
                  </div>
                ))}
              </div>
            ))
        )
      )}

      {/* ── Décodage de tous les emplacements ── */}
      {vue === "tout" && lignes && (
        <>
          <div style={{ fontSize: 11.5, color: C.textMuted, marginBottom: 8 }}>
            {visibles.length} emplacement(s). Vérifie que la colonne « réserves » correspond à la réalité.
          </div>
          {visibles.map(l => (
            <div key={l.nom} style={{ background: C.white, border: `1px solid ${l.abrege ? "#fed7aa" : C.border}`, borderRadius: 10, padding: 11, marginBottom: 8 }}>
              <div style={{ fontSize: 12.5, fontFamily: "monospace", color: C.textMuted, wordBreak: "break-all" }}>{l.nom}</div>
              <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 7, alignItems: "baseline" }}>
                <div>
                  <div style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: .4 }}>Picking</div>
                  <div style={{ fontSize: 17, fontWeight: 800, color: C.text, fontFamily: "monospace" }}>{l.picking || "—"}</div>
                </div>
                <div style={{ flex: 1, minWidth: 140 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: .4 }}>
                    Réserves{l.abrege && <span style={{ color: C.orange }}> · abrégé</span>}
                  </div>
                  <div style={{ fontSize: 13.5, fontWeight: 700, color: l.reserves.length ? C.text : C.textMuted, fontFamily: "monospace", lineHeight: 1.4 }}>
                    {l.reserves.length ? l.reserves.join("  ·  ") : "aucune"}
                  </div>
                </div>
              </div>
              <div style={{ fontSize: 11.5, color: C.textMuted, marginTop: 6, lineHeight: 1.4 }}>
                {l.articles.length} article(s) : {l.articles.slice(0, 3).join(" · ")}
                {l.articles.length > 3 && ` … +${l.articles.length - 3}`}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
