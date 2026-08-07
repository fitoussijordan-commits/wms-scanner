"use client";
// components/ConflitRacksModal.tsx — arbitrage d'un rack déjà utilisé
//
// Renommer un emplacement réattribue des racks. Quand un rack est déjà déclaré
// ailleurs, il y a TROIS issues possibles, pas deux :
//
//   - le partager : les deux emplacements sont réellement sur ce rack
//   - le libérer  : l'autre déclaration est fausse, on la corrige
//   - renoncer    : on ne touche à rien
//
// Une boîte de confirmation du navigateur n'en propose que deux, ce qui
// obligeait à annuler puis recommencer autrement. D'où cette fenêtre.

import type { ConflitRack } from "@/lib/odoo";

const C = {
  white: "#fff", text: "#0f172a", textSec: "#374151", textMuted: "#64748b",
  border: "#e2e8f0", bg: "#f8fafc", green: "#16a34a", red: "#b91c1c", orange: "#b45309",
};

export default function ConflitRacksModal({
  nouveauNom, conflits, occupe, onPartager, onLiberer, onAnnuler,
}: {
  nouveauNom: string;
  conflits: ConflitRack[];
  occupe: boolean;
  onPartager: () => void;
  onLiberer: () => void;
  onAnnuler: () => void;
}) {
  // Un rack peut apparaître sur plusieurs emplacements : on regroupe pour ne
  // pas répéter le même code dix fois.
  const parRack: Record<string, ConflitRack[]> = {};
  for (const c of conflits) (parRack[c.rack] ||= []).push(c);

  return (
    <div onClick={occupe ? undefined : onAnnuler}
      style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,.55)", zIndex: 2000,
               display: "flex", alignItems: "flex-end", justifyContent: "center", padding: 12 }}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: C.white, borderRadius: 16, padding: 16, width: "100%", maxWidth: 460,
                 maxHeight: "85vh", overflowY: "auto", boxShadow: "0 20px 60px -12px rgba(0,0,0,.4)" }}>

        <div style={{ fontSize: 16, fontWeight: 800, color: C.text, marginBottom: 3 }}>
          Rack déjà utilisé
        </div>
        <div style={{ fontSize: 12.5, color: C.textMuted, marginBottom: 12, lineHeight: 1.5 }}>
          Tu renommes en <strong style={{ fontFamily: "monospace", color: C.text }}>{nouveauNom}</strong>.
          Ces racks sont déjà déclarés ailleurs.
        </div>

        {Object.entries(parRack).map(([rack, liste]) => (
          <div key={rack} style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10, padding: 10, marginBottom: 8 }}>
            <div style={{ fontSize: 16, fontWeight: 800, fontFamily: "monospace", color: C.orange }}>{rack}</div>
            {liste.map((c, i) => (
              <div key={i} style={{ fontSize: 12, color: C.textSec, marginTop: 4, lineHeight: 1.4 }}>
                <div style={{ fontFamily: "monospace", fontWeight: 700, wordBreak: "break-all" }}>
                  {c.locationName.split("/").pop()}
                </div>
                {c.articles.length > 0 && (
                  <div style={{ color: C.textMuted }}>
                    {c.articles.slice(0, 2).join(" · ")}
                    {c.articles.length > 2 && ` … +${c.articles.length - 2}`}
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}

        {/* L'ordre des boutons suit le risque : le plus anodin en premier. */}
        <button onClick={onPartager} disabled={occupe}
          style={{ width: "100%", padding: 14, marginTop: 6, background: C.green, color: "#fff", border: "none",
                   borderRadius: 11, fontSize: 14, fontWeight: 800, cursor: "pointer", fontFamily: "inherit" }}>
          C&apos;est un partage — garder les deux
        </button>
        <div style={{ fontSize: 11, color: C.textMuted, margin: "4px 2px 10px", lineHeight: 1.4 }}>
          Le rack reste sur les deux emplacements, et ne sera plus signalé comme anomalie.
        </div>

        <button onClick={onLiberer} disabled={occupe}
          style={{ width: "100%", padding: 14, background: C.red, color: "#fff", border: "none",
                   borderRadius: 11, fontSize: 14, fontWeight: 800, cursor: "pointer", fontFamily: "inherit" }}>
          {occupe ? "En cours…" : "Le retirer de l'autre emplacement"}
        </button>
        <div style={{ fontSize: 11, color: C.textMuted, margin: "4px 2px 10px", lineHeight: 1.4 }}>
          Modifie le nom d&apos;un autre emplacement. Aucun stock n&apos;est déplacé.
        </div>

        <button onClick={onAnnuler} disabled={occupe}
          style={{ width: "100%", padding: 12, background: C.white, color: C.textSec,
                   border: `1.5px solid ${C.border}`, borderRadius: 11, fontSize: 13.5, fontWeight: 700,
                   cursor: "pointer", fontFamily: "inherit" }}>
          Annuler — ne rien changer
        </button>
      </div>
    </div>
  );
}
