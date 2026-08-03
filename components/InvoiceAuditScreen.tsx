"use client";
// components/InvoiceAuditScreen.tsx
// ─────────────────────────────────────────────────────────────────────────────
// AUDIT DES FACTURES — retrouver ce que l'automatisation a laissé en plan.
//
// L'action automatisée de facturation compare le montant de la facture à celui
// de la COMMANDE ENTIÈRE. Dès qu'une commande est livrée en plusieurs fois, la
// facture ne couvre que le livré : l'écart est normal, mais l'action le traite
// comme une anomalie. Elle envoie une alerte — sans dire quelle facture — puis
// s'arrête AVANT de comptabiliser. La facture reste en brouillon et le client ne
// reçoit rien.
//
// Cet écran répond à la seule question utile : sur une période donnée, quelles
// factures sont restées en brouillon, et l'écart est-il réel ou non ?
//
// LECTURE SEULE. Rien n'est modifié dans Odoo : comptabiliser une facture est
// un acte comptable, il se fait dans Odoo en connaissance de cause.
// ─────────────────────────────────────────────────────────────────────────────
import { useState, useCallback } from "react";
import * as odoo from "@/lib/odoo";

const C = {
  bg: "#f8fafc", white: "#fff", text: "#0f172a", textSec: "#475569",
  textMuted: "#94a3b8", border: "#e2e8f0", blue: "#2563eb",
  green: "#16a34a", greenSoft: "#f0fdf4", red: "#dc2626", redSoft: "#fef2f2",
  amber: "#d97706", amberSoft: "#fffbeb",
};

const euros = (n: number) =>
  n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";

function aujourdhui(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

type Filtre = "tout" | "brouillon" | "ecart";

export default function InvoiceAuditScreen({
  session, onToast,
}: { session: odoo.OdooSession; onToast: (m: string, t?: "success" | "error" | "info") => void }) {

  const [du, setDu]     = useState(aujourdhui());
  const [au, setAu]     = useState(aujourdhui());
  const [rows, setRows] = useState<odoo.InvoiceAuditRow[] | null>(null);
  const [chargement, setChargement] = useState(false);
  const [erreur, setErreur] = useState("");
  const [filtre, setFiltre] = useState<Filtre>("tout");

  const charger = useCallback(async () => {
    setChargement(true); setErreur("");
    try {
      const r = await odoo.auditInvoices(session, du, au);
      setRows(r);
      if (!r.length) onToast("Aucune facture créée sur cette période", "info");
    } catch (e: any) {
      setErreur(odoo.safeErrMsg?.(e) || e?.message || String(e));
    }
    setChargement(false);
  }, [session, du, au, onToast]);

  const toutes    = rows || [];
  const brouillons = toutes.filter(r => r.brouillon);
  // Seuil identique à celui de l'action automatisée, pour retrouver exactement
  // les factures qu'elle a signalées.
  const avecEcart = toutes.filter(r => r.ecart !== null && Math.abs(r.ecart) > 0.01);

  const affichees = filtre === "brouillon" ? brouillons
                  : filtre === "ecart"     ? avecEcart
                  : toutes;

  const totalBrouillon = brouillons.reduce((s, r) => s + r.amount, 0);

  const onglet = (k: Filtre, label: string, n: number) => (
    <button key={k} onClick={() => setFiltre(k)}
      style={{ padding: "7px 13px", borderRadius: 8, border: `1.5px solid ${filtre === k ? C.blue : C.border}`,
               background: filtre === k ? C.blue : C.white, color: filtre === k ? "#fff" : C.textSec,
               fontSize: 12.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
      {label} ({n})
    </button>
  );

  return (
    <div style={{ padding: 16, fontFamily: "'DM Sans', sans-serif" }}>
      <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 12, padding: 14, marginBottom: 14 }}>
        <div style={{ fontSize: 12.5, color: C.textSec, lineHeight: 1.6, marginBottom: 10 }}>
          Factures client créées sur la période. L&apos;automatisation laisse en <strong>brouillon</strong> celles
          dont le montant diffère de la commande — y compris quand l&apos;écart est normal
          (livraison partielle). Ces factures ne sont ni comptabilisées ni envoyées au client.
          <strong> Lecture seule.</strong>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" as const }}>
          <label style={{ fontSize: 12, color: C.textSec, fontWeight: 600 }}>
            Du<br />
            <input type="date" value={du} onChange={e => setDu(e.target.value)}
              style={{ marginTop: 4, padding: 8, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit" }} />
          </label>
          <label style={{ fontSize: 12, color: C.textSec, fontWeight: 600 }}>
            Au<br />
            <input type="date" value={au} onChange={e => setAu(e.target.value)}
              style={{ marginTop: 4, padding: 8, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit" }} />
          </label>
          <button onClick={charger} disabled={chargement}
            style={{ padding: "10px 18px", background: chargement ? "#cbd5e1" : C.blue, color: "#fff", border: "none",
                     borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: chargement ? "default" : "pointer", fontFamily: "inherit" }}>
            {chargement ? "Lecture…" : "Analyser"}
          </button>
        </div>
      </div>

      {erreur && (
        <div style={{ background: C.redSoft, border: "1px solid #fecaca", borderRadius: 10, padding: 11, marginBottom: 12, fontSize: 13, color: "#991b1b" }}>{erreur}</div>
      )}

      {rows && rows.length > 0 && (
        <>
          <div style={{ background: brouillons.length ? C.amberSoft : C.greenSoft,
                        border: `1px solid ${brouillons.length ? "#fde68a" : "#bbf7d0"}`,
                        borderRadius: 12, padding: 13, marginBottom: 12, fontSize: 13,
                        color: brouillons.length ? "#92400e" : "#15803d" }}>
            {brouillons.length ? (
              <>
                <strong>{brouillons.length} facture(s) restée(s) en brouillon</strong> sur {toutes.length},
                pour {euros(totalBrouillon)}. Elles ne sont ni comptabilisées ni envoyées au client.
              </>
            ) : (
              <><strong>Aucune facture en brouillon</strong> sur cette période — {toutes.length} facture(s) traitées normalement.</>
            )}
          </div>

          <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" as const }}>
            {onglet("tout", "Toutes", toutes.length)}
            {onglet("brouillon", "En brouillon", brouillons.length)}
            {onglet("ecart", "Avec écart", avecEcart.length)}
          </div>

          <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden" }}>
            {affichees.map((r, i) => {
              const ecartReel = r.ecart !== null && Math.abs(r.ecart) > 0.01;
              return (
                <div key={r.id} style={{ padding: "11px 14px", borderTop: i > 0 ? `1px solid ${C.border}` : "none" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 700, color: C.text }}>
                        {r.name}
                        {r.brouillon && (
                          <span style={{ marginLeft: 8, fontSize: 10.5, fontWeight: 700, color: C.amber, background: C.amberSoft, padding: "2px 7px", borderRadius: 5 }}>
                            BROUILLON
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 12, color: C.textSec, marginTop: 2 }}>{r.partner}</div>
                      <div style={{ fontSize: 11.5, color: C.textMuted, marginTop: 2 }}>
                        {r.origin || "sans commande d'origine"} · {r.date}
                      </div>
                    </div>
                    <div style={{ textAlign: "right" as const, flexShrink: 0 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 700, color: C.text }}>{euros(r.amount)}</div>
                      {r.orderAmount !== null ? (
                        <>
                          <div style={{ fontSize: 11.5, color: C.textMuted }}>commande {euros(r.orderAmount)}</div>
                          <div style={{ fontSize: 12, fontWeight: 700, marginTop: 2, color: ecartReel ? C.red : C.green }}>
                            {ecartReel ? `écart ${r.ecart! > 0 ? "+" : ""}${euros(r.ecart!)}` : "montants identiques"}
                          </div>
                        </>
                      ) : (
                        <div style={{ fontSize: 11.5, color: C.textMuted }}>commande introuvable</div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
            {!affichees.length && (
              <div style={{ padding: 16, fontSize: 13, color: C.textMuted, textAlign: "center" as const }}>
                Aucune facture dans cette catégorie.
              </div>
            )}
          </div>

          <div style={{ fontSize: 11.5, color: C.textMuted, marginTop: 10, lineHeight: 1.6 }}>
            Un écart n&apos;est pas toujours une anomalie : une commande livrée en plusieurs fois
            produit une facture inférieure au total, ce qui est normal. Compare avec le nombre
            de colis expédiés avant de conclure. La comptabilisation se fait dans Odoo.
          </div>
        </>
      )}
    </div>
  );
}
