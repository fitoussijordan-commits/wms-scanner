"use client";
import { useState } from "react";
import * as odoo from "@/lib/odoo";

const C = {
  bg: "#f8fafc", white: "#ffffff", text: "#1a1a2e", textSec: "#374151",
  textMuted: "#6b7280", border: "#e5e7eb", blue: "#2563eb", blueSoft: "#eff6ff",
  green: "#16a34a", greenSoft: "#f0fdf4", red: "#dc2626", redSoft: "#fef2f2",
  orange: "#ea580c", orangeSoft: "#fff7ed", shadow: "0 1px 4px rgba(0,0,0,0.07)",
};

interface Props {
  session: odoo.OdooSession;
  onBack: () => void;
  onToast: (msg: string, type?: "success" | "error" | "info") => void;
}

// Bornes par défaut : le mois en cours.
function defaultRange(): { from: string; to: string } {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { from: iso(first), to: iso(now) };
}

export default function FefoAnalysisScreen({ session, onBack, onToast }: Props) {
  const dr = defaultRange();
  const [from, setFrom] = useState(dr.from);
  const [to, setTo] = useState(dr.to);
  const [prodQuery, setProdQuery] = useState("");
  const [prodResults, setProdResults] = useState<any[]>([]);
  const [prod, setProd] = useState<{ id: number; label: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [anomalies, setAnomalies] = useState<odoo.FefoAnomaly[]>([]);
  const [stats, setStats] = useState<{ nbSorties: number; nbProduits: number } | null>(null);
  const [ran, setRan] = useState(false);

  const searchProd = async (q: string) => {
    if (q.trim().length < 2) { setProdResults([]); return; }
    try { const r = await odoo.globalSearch(session, q.trim()); setProdResults(r.filter((x: any) => x.type === "product").slice(0, 8)); }
    catch { setProdResults([]); }
  };

  const run = async () => {
    if (!from || !to) { onToast("Choisis une période", "error"); return; }
    setLoading(true); setRan(false);
    try {
      const res = await odoo.analyzeFefo(session, from, to, prod?.id);
      setAnomalies(res.anomalies);
      setStats({ nbSorties: res.nbSorties, nbProduits: res.nbProduits });
      setRan(true);
      onToast(`${res.anomalies.length} anomalie(s) FEFO sur ${res.nbSorties} sortie(s)`, res.anomalies.length ? "info" : "success");
    } catch (e: any) { onToast("Erreur : " + (e?.message || e), "error"); }
    setLoading(false);
  };

  const exportCsv = () => {
    const head = ["Date", "Réf", "Produit", "Bon", "Lot sorti", "DLUO sorti", "Qté", "Lot + ancien dispo", "DLUO + ancien", "Stock à la date"];
    const rows = anomalies.map(a => [a.date, a.productRef, a.productName, a.pickingRef, a.soldLot, a.soldDluo, String(a.soldQty), a.olderLot, a.olderDluo, String(a.olderStockAtDate)]);
    const esc = (s: string) => `"${String(s).replace(/"/g, '""')}"`;
    const csv = [head, ...rows].map(r => r.map(esc).join(";")).join("\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `analyse_fefo_${from}_${to}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ paddingBottom: 90 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <button onClick={onBack} style={{ background: C.bg, border: "none", borderRadius: 10, padding: 8, cursor: "pointer", display: "flex" }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={C.text} strokeWidth="2"><path d="M19 12H5M12 5l-7 7 7 7" /></svg>
        </button>
        <div>
          <div style={{ fontSize: 17, fontWeight: 800, color: C.text }}>Analyse FEFO</div>
          <div style={{ fontSize: 12, color: C.textMuted }}>Détecte les sorties d'un lot récent alors qu'un lot plus ancien (DLUO) était en stock</div>
        </div>
      </div>

      {/* Filtres */}
      <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 12, padding: 14, marginBottom: 14, boxShadow: C.shadow }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
          <span style={{ fontSize: 13, color: C.textMuted, fontWeight: 600 }}>Du</span>
          <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={inp} />
          <span style={{ fontSize: 13, color: C.textMuted, fontWeight: 600 }}>au</span>
          <input type="date" value={to} onChange={e => setTo(e.target.value)} style={inp} />
        </div>
        {/* Produit optionnel */}
        {prod ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 12, color: C.textSec }}>Produit : <b>{prod.label}</b></span>
            <button onClick={() => { setProd(null); setProdQuery(""); }} style={{ fontSize: 11, color: C.red, background: "none", border: "none", cursor: "pointer", fontWeight: 700 }}>retirer</button>
          </div>
        ) : (
          <div style={{ position: "relative" }}>
            <input value={prodQuery} onChange={e => { setProdQuery(e.target.value); searchProd(e.target.value); }}
              placeholder="Filtrer sur un produit (optionnel)…"
              style={{ ...inp, width: "100%", boxSizing: "border-box" }} />
            {prodResults.length > 0 && (
              <div style={{ marginTop: 4 }}>
                {prodResults.map((x: any, i: number) => (
                  <button key={i} onClick={() => { setProd({ id: x.data.id, label: `${x.data.default_code || ""} ${x.data.name}`.trim() }); setProdResults([]); }}
                    style={{ display: "block", width: "100%", textAlign: "left", padding: "7px 10px", background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 4, cursor: "pointer", fontFamily: "inherit", fontSize: 12.5 }}>
                    <b style={{ fontFamily: "monospace" }}>{x.data.default_code || "—"}</b> · {x.data.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <button onClick={run} disabled={loading}
          style={{ marginTop: 12, padding: "11px 18px", background: C.blue, color: "#fff", border: "none", borderRadius: 10, fontWeight: 800, fontSize: 14, cursor: "pointer", fontFamily: "inherit", opacity: loading ? 0.6 : 1 }}>
          {loading ? "Analyse en cours…" : "Analyser les sorties"}
        </button>
      </div>

      {ran && stats && (
        <>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12, alignItems: "center" }}>
            <span style={chip(anomalies.length ? C.redSoft : C.greenSoft, anomalies.length ? C.red : C.green)}>{anomalies.length} anomalie{anomalies.length > 1 ? "s" : ""}</span>
            <span style={chip(C.blueSoft, C.blue)}>{stats.nbSorties} sortie(s) analysées</span>
            <span style={chip(C.bg, C.textSec)}>{stats.nbProduits} produit(s)</span>
            <div style={{ flex: 1 }} />
            {anomalies.length > 0 && <button onClick={exportCsv} style={{ padding: "8px 14px", background: C.green, color: "#fff", border: "none", borderRadius: 9, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Export</button>}
          </div>

          {anomalies.length === 0 ? (
            <div style={{ textAlign: "center", padding: 30, color: C.green, fontWeight: 700, fontSize: 14 }}>✓ Aucune anomalie FEFO sur cette période</div>
          ) : (
            <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden", boxShadow: C.shadow }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                  <thead>
                    <tr style={{ background: C.bg, fontSize: 10, fontWeight: 700, textTransform: "uppercase", color: C.textMuted, textAlign: "left" }}>
                      <th style={th}>Date</th><th style={th}>Produit</th><th style={th}>Lot sorti</th><th style={th}>Qté</th><th style={th}>Lot + ancien dispo</th><th style={th}>Stock</th>
                    </tr>
                  </thead>
                  <tbody>
                    {anomalies.map((a, i) => (
                      <tr key={i} style={{ borderTop: `1px solid ${C.border}`, background: C.redSoft }}>
                        <td style={td}>{a.date}</td>
                        <td style={td}>
                          <div style={{ fontWeight: 700, fontFamily: "monospace" }}>{a.productRef}</div>
                          <div style={{ fontSize: 11, color: C.textSec, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 220 }}>{a.productName}</div>
                          {a.pickingRef && <div style={{ fontSize: 10, color: C.textMuted }}>{a.pickingRef}</div>}
                        </td>
                        <td style={td}>
                          <div style={{ fontWeight: 700, fontFamily: "monospace" }}>{a.soldLot}</div>
                          <div style={{ fontSize: 11, color: C.red }}>DLUO {a.soldDluo}</div>
                        </td>
                        <td style={{ ...td, fontWeight: 800, textAlign: "right" }}>{a.soldQty}</td>
                        <td style={td}>
                          <div style={{ fontWeight: 700, fontFamily: "monospace", color: C.orange }}>{a.olderLot}</div>
                          <div style={{ fontSize: 11, color: C.orange }}>DLUO {a.olderDluo} ← plus ancien</div>
                        </td>
                        <td style={{ ...td, fontWeight: 800, textAlign: "right" }}>{a.olderStockAtDate}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const inp: React.CSSProperties = { padding: "9px 12px", border: "1.5px solid #e5e7eb", borderRadius: 10, fontSize: 14, fontFamily: "inherit", background: "#fff", color: "#1a1a2e", outline: "none" };
const th: React.CSSProperties = { padding: "9px 12px" };
const td: React.CSSProperties = { padding: "9px 12px", color: "#374151", verticalAlign: "top" };
function chip(bg: string, color: string): React.CSSProperties {
  return { background: bg, color, borderRadius: 8, padding: "4px 11px", fontWeight: 700, fontSize: 12 };
}
