"use client";
import { useState, useEffect, useCallback, Fragment as Fragment2 } from "react";
import * as odoo from "@/lib/odoo";
import { getEshopMappingOverrides, saveEshopMappingOverride, getCartonsConfig, getProcessedEshopOrders, markEshopOrdersProcessed, type EshopMappingOverrides } from "@/lib/supabase";

const C = {
  bg: "#f8fafc", white: "#ffffff", text: "#1a1a2e", textSec: "#374151",
  textMuted: "#6b7280", border: "#e5e7eb", blue: "#2563eb", blueSoft: "#eff6ff",
  green: "#16a34a", greenSoft: "#f0fdf4", red: "#dc2626", redSoft: "#fef2f2",
  orange: "#ea580c", orangeSoft: "#fff7ed", purple: "#7c3aed",
  shadow: "0 1px 4px rgba(0,0,0,0.07)",
};

interface Props {
  session: odoo.OdooSession;
  onBack: () => void;
  onToast: (msg: string, type?: "success" | "error" | "info") => void;
}
interface SaleLine { articleNumber: string | null; ean: string; name: string; quantity: number; mode: number; }
interface SaleOrder { id: number; number: string; orderStatusId: number; paymentStatusId: number; dispatchId: number; orderTime: string; lines: SaleLine[]; }

const PARTNER_KEY = "wms_eshop_partner_id";

export default function EshopSortiesScreen({ session, onBack, onToast }: Props) {
  const [tab, setTab] = useState<"sorties" | "stock">("sorties");
  return (
    <div style={{ padding: "16px 16px 0", width: "100%", maxWidth: "100%", boxSizing: "border-box", fontFamily: "'DM Sans', sans-serif" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
        <button onClick={onBack} style={{ background: C.bg, border: "none", borderRadius: 10, padding: 8, cursor: "pointer", display: "flex" }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={C.text} strokeWidth="2"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
        </button>
        <div style={{ fontSize: 17, fontWeight: 700, color: C.text }}>E-shop</div>
      </div>
      <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
        {([["sorties", "Sorties du jour"], ["stock", "Synchro stock"]] as const).map(([k, lbl]) => (
          <button key={k} onClick={() => setTab(k)}
            style={{ padding: "9px 16px", borderRadius: 10, border: `1.5px solid ${tab === k ? C.blue : C.border}`, background: tab === k ? C.blueSoft : C.white, color: tab === k ? C.blue : C.textSec, fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>
            {lbl}
          </button>
        ))}
      </div>
      {tab === "sorties" ? <SortiesTab session={session} onToast={onToast} /> : <StockSyncTab session={session} onToast={onToast} />}
    </div>
  );
}

function SortiesTab({ session, onToast }: { session: odoo.OdooSession; onToast: Props["onToast"] }) {
  const today = new Date().toISOString().slice(0, 10);
  const [dateFrom, setDateFrom] = useState(today);
  const [dateTo, setDateTo] = useState(today);
  const [timeFrom, setTimeFrom] = useState(""); // HH:MM optionnel — vide = toute la journée
  const [timeTo, setTimeTo] = useState("");
  const [loading, setLoading] = useState(false);
  const [orders, setOrders] = useState<SaleOrder[]>([]);
  const [statusTally, setStatusTally] = useState<Record<string, number>>({});
  const [statusNames, setStatusNames] = useState<Record<string, string>>({});
  const [payNames, setPayNames] = useState<Record<string, string>>({});
  const [matchMap, setMatchMap] = useState<Record<string, any>>({});
  const [overrides, setOverrides] = useState<EshopMappingOverrides>({});
  const [chariot, setChariot] = useState<string[]>([]);
  const [processed, setProcessed] = useState<Set<string>>(new Set()); // commandes déjà sorties (devis créé)
  const [error, setError] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  // Par défaut : payées uniquement (statut paiement 12) → exclut les paniers oubliés
  const [payFilter, setPayFilter] = useState<string>("12");
  // Correction en cours : ref Shopware ciblée
  const [fixRef, setFixRef] = useState<string | null>(null);
  const [fixQuery, setFixQuery] = useState("");
  const [fixResults, setFixResults] = useState<any[]>([]);
  const [fixing, setFixing] = useState(false);
  // Client e-shop + création devis
  const [partner, setPartner] = useState<{ id: number; name: string } | null>(null);
  const [partnerInput, setPartnerInput] = useState("");
  const [creatingQuote, setCreatingQuote] = useState(false);

  useEffect(() => {
    fetch("/api/shopware-explore?action=orderStatuses").then(r => r.json()).then(d => {
      const m: Record<string, string> = {};
      for (const s of (d.statuses || [])) m[String(s.id)] = s.description || s.name;
      setStatusNames(m);
    }).catch(() => {});
    fetch("/api/shopware-explore?action=paymentStatuses").then(r => r.json()).then(d => {
      const m: Record<string, string> = {};
      for (const s of (d.statuses || [])) m[String(s.id)] = s.description || s.name;
      setPayNames(m);
    }).catch(() => {});
    odoo.loadChariotSkus(session).then(setChariot).catch(() => {});
    getEshopMappingOverrides().then(setOverrides).catch(() => {});
    // Client e-shop mémorisé localement (id) — résolu via Odoo
    const saved = (() => { try { return localStorage.getItem(PARTNER_KEY) || ""; } catch { return ""; } })();
    if (saved) { setPartnerInput(saved); odoo.findEshopPartner(session, saved).then(p => p && setPartner(p)).catch(() => {}); }
  }, [session]);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const res = await fetch(`/api/shopware-explore?action=dailySales&from=${dateFrom}&to=${dateTo}${timeFrom ? `&fromTime=${timeFrom}` : ""}${timeTo ? `&toTime=${timeTo}` : ""}`);
      const d = await res.json();
      if (d.error) { setError(d.error); setLoading(false); return; }
      setOrders(d.orders || []);
      setStatusTally(d.statusTally || {});
      // Garde-fou : commandes déjà sorties (devis déjà créé) → à exclure
      const orderNums = (d.orders || []).map((o: SaleOrder) => o.number).filter(Boolean);
      setProcessed(await getProcessedEshopOrders(orderNums));
      const refs = Array.from(new Set(
        (d.orders || []).flatMap((o: SaleOrder) => o.lines.filter(l => l.articleNumber && l.mode !== 4).map(l => l.articleNumber as string))
      )) as string[];
      if (refs.length) setMatchMap(await odoo.matchEshopSkus(session, refs));
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  }, [dateFrom, dateTo, timeFrom, timeTo, session]);
  useEffect(() => { load(); }, [load]);

  const isChariot = (ref: string) => chariot.some(c => c.trim().toLowerCase() === ref.trim().toLowerCase());
  // Match effectif = override manuel prioritaire, sinon match auto
  const effMatch = (ref: string) => overrides[ref] || matchMap[ref] || null;

  // Libellés statuts (fallback connu si l'API ne les fournit pas)
  const STATUS_FALLBACK: Record<string, string> = { "0": "Ouverte", "5": "Prête à livrer", "1": "En cours", "-1": "Annulée" };
  const PAY_FALLBACK: Record<string, string> = { "12": "Payée", "0": "Non payée", "17": "Ouvert" };
  const stLabel = (id: string) => statusNames[id] || STATUS_FALLBACK[id] || `Statut ${id}`;
  const payLabel = (id: string) => payNames[id] || PAY_FALLBACK[id] || `Paiement ${id}`;

  // ── Correction mapping : recherche produit Odoo ──
  const searchOdoo = async (q: string) => {
    if (q.trim().length < 2) { setFixResults([]); return; }
    try {
      const results = await odoo.globalSearch(session, q.trim());
      setFixResults(results.filter((r: any) => r.type === "product").slice(0, 8));
    } catch { setFixResults([]); }
  };
  const applyFix = async (ref: string, prod: any) => {
    setFixing(true);
    try {
      await saveEshopMappingOverride(ref, prod.id, prod.default_code || "", prod.name);
      setOverrides(prev => ({ ...prev, [ref]: { productId: prod.id, odooRef: prod.default_code || "", productName: prod.name } }));
      setFixRef(null); setFixQuery(""); setFixResults([]);
      onToast("Mapping corrigé ✓", "success");
    } catch (e: any) { onToast("Erreur : " + e.message, "error"); }
    setFixing(false);
  };

  // Récap statuts de paiement (pour repérer les paniers oubliés)
  const payTally: Record<string, number> = {};
  for (const o of orders) { const p = String(o.paymentStatusId); payTally[p] = (payTally[p] || 0) + 1; }
  const payList = Object.entries(payTally).sort((a, b) => Number(b[1]) - Number(a[1]));

  // Nb de commandes déjà sorties (devis déjà créé) dans la période
  const processedCount = orders.filter(o => processed.has(o.number)).length;

  // ── Agrégation ──
  const agg: Record<string, { ref: string; name: string; qty: number; productId: number; odooRef: string; matched: boolean; chariot: boolean; manual: boolean; cmds: { number: string; qty: number }[] }> = {};
  let totalLines = 0, mappedLines = 0, chariotLines = 0;
  const visibleOrders = orders
    // GARDE-FOU : exclut TOUJOURS les commandes déjà sorties (anti double déduction)
    .filter(o => !processed.has(o.number))
    // Exclut TOUJOURS les commandes annulées (statut -1), sauf si on les sélectionne exprès
    .filter(o => statusFilter === "-1" ? true : String(o.orderStatusId) !== "-1")
    .filter(o => statusFilter === "all" || String(o.orderStatusId) === statusFilter)
    .filter(o => payFilter === "all" || String(o.paymentStatusId) === payFilter);
  for (const o of visibleOrders) {
    for (const l of o.lines) {
      if (l.mode === 4 || !l.articleNumber) continue;
      totalLines++;
      const ref = l.articleNumber;
      const m: any = effMatch(ref);
      const onChariot = isChariot(ref);
      if (onChariot) chariotLines++;
      if (m) mappedLines++;
      const pid = m ? (m.product_id ?? m.productId ?? 0) : 0;
      const oref = m ? (m.default_code ?? m.odooRef ?? "") : "";
      if (!agg[ref]) agg[ref] = { ref, name: l.name, qty: 0, productId: pid, odooRef: oref, matched: !!m, chariot: onChariot, manual: !!overrides[ref], cmds: [] };
      agg[ref].qty += l.quantity;
      agg[ref].cmds.push({ number: o.number, qty: l.quantity });
    }
  }
  const aggList = Object.values(agg).sort((a, b) => Number(a.matched) - Number(b.matched) || a.ref.localeCompare(b.ref));
  const blocked = aggList.filter(a => !a.matched && !a.chariot);
  const statusList = Object.entries(statusTally).sort((a, b) => Number(b[1]) - Number(a[1]));

  // ── DEVIS : agrégation STRICTE et indépendante de l'affichage ──
  // Ne JAMAIS déduire : annulées (-1), non payées (≠12), déjà sorties, chariot, non mappées.
  const deductAgg: Record<string, { productId: number; qty: number; ref: string; odooRef: string; name: string; cmds: { number: string; qty: number }[] }> = {};
  for (const o of orders) {
    if (processed.has(o.number)) continue;            // déjà sortie
    if (String(o.orderStatusId) === "-1") continue;   // annulée
    if (String(o.paymentStatusId) !== "12") continue; // non payée
    for (const l of o.lines) {
      if (l.mode === 4 || !l.articleNumber) continue;
      const ref = l.articleNumber;
      if (isChariot(ref)) continue;                   // chariot
      const m: any = effMatch(ref);
      const pid = m ? (m.product_id ?? m.productId ?? 0) : 0;
      if (!pid) continue;                             // non mappé
      if (!deductAgg[ref]) deductAgg[ref] = { productId: pid, qty: 0, ref, odooRef: m.default_code ?? m.odooRef ?? "", name: l.name, cmds: [] };
      deductAgg[ref].qty += l.quantity;
      deductAgg[ref].cmds.push({ number: o.number, qty: l.quantity });
    }
  }
  const toDeduct = Object.values(deductAgg);
  // Commandes réellement incluses dans le devis (pour le garde-fou)
  const deductOrderNumbers = Array.from(new Set(
    orders.filter(o => !processed.has(o.number) && String(o.orderStatusId) !== "-1" && String(o.paymentStatusId) === "12").map(o => o.number).filter(Boolean)
  ));

  // ── Client e-shop ──
  const resolvePartner = async () => {
    if (!partnerInput.trim()) return;
    try {
      const p = await odoo.findEshopPartner(session, partnerInput);
      if (p) { setPartner(p); try { localStorage.setItem(PARTNER_KEY, partnerInput.trim()); } catch {} onToast(`Client : ${p.name}`, "success"); }
      else onToast("Client introuvable dans Odoo", "error");
    } catch (e: any) { onToast("Erreur : " + e.message, "error"); }
  };

  // ── Création devis Odoo ──
  const createQuote = async () => {
    if (!partner) { onToast("Renseigne d'abord le client e-shop", "error"); return; }
    if (!toDeduct.length) { onToast("Aucune ligne mappée à déduire", "info"); return; }
    if (blocked.length && !confirm(`${blocked.length} référence(s) NON mappée(s) seront ignorées. Continuer quand même ?`)) return;
    if (!confirm(`Créer un devis Odoo pour ${partner.name} avec ${toDeduct.length} ligne(s) ?`)) return;
    setCreatingQuote(true);
    try {
      const lines = toDeduct.map(a => ({
        productId: a.productId, qty: a.qty, name: a.name,
        orders: a.cmds.map(c => `${c.number}${c.qty > 1 ? ` ×${c.qty}` : ""}`).join(", "),
      }));
      const q = await odoo.createEshopQuotation(session, partner.id, lines, `E-shop ${dateFrom}${dateFrom !== dateTo ? "→" + dateTo : ""}`);
      // GARDE-FOU : marque UNIQUEMENT les commandes réellement incluses (payées, non annulées)
      const includedNumbers = deductOrderNumbers;
      try { await markEshopOrdersProcessed(includedNumbers, q.name); setProcessed(prev => new Set([...Array.from(prev), ...includedNumbers])); } catch {}
      // Trace : export Excel du détail envoyé au devis (pour comparer avec Odoo)
      try {
        const XLSX = await import("xlsx");
        const rows = toDeduct.map(a => ({
          "Réf Shopware": a.ref,
          "Réf Odoo": a.odooRef,
          "Produit": a.name,
          "Qté": a.qty,
          "Commandes": a.cmds.map(c => `${c.number}${c.qty > 1 ? `×${c.qty}` : ""}`).join(", "),
        }));
        const ws = XLSX.utils.json_to_sheet(rows);
        ws["!cols"] = [{ wch: 16 }, { wch: 14 }, { wch: 42 }, { wch: 8 }, { wch: 50 }];
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Devis");
        XLSX.writeFile(wb, `Devis_${q.name}_${dateFrom}.xlsx`);
      } catch {}
      onToast(`✓ Devis ${q.name} créé — ${includedNumbers.length} commande(s) marquée(s) sorties · Excel téléchargé`, "success");
    } catch (e: any) { onToast("Erreur création devis : " + e.message, "error"); }
    setCreatingQuote(false);
  };

  return (
    <div style={{ paddingBottom: 80, width: "100%", maxWidth: "100%", boxSizing: "border-box", overflowX: "hidden" }}>
      <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 12 }}>Vérifie le mapping, corrige, puis crée le devis Odoo</div>

      <div style={{ display: "flex", gap: 8, marginBottom: 14, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontSize: 13, color: C.textMuted, fontWeight: 600 }}>Du</span>
        <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
          style={{ padding: "9px 12px", border: `1.5px solid ${C.border}`, borderRadius: 10, fontSize: 14, fontFamily: "inherit" }} />
        <input type="time" value={timeFrom} onChange={e => setTimeFrom(e.target.value)} title="Heure début (vide = 00:00)"
          style={{ padding: "9px 8px", border: `1.5px solid ${C.border}`, borderRadius: 10, fontSize: 14, fontFamily: "inherit" }} />
        <span style={{ fontSize: 13, color: C.textMuted, fontWeight: 600 }}>au</span>
        <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
          style={{ padding: "9px 12px", border: `1.5px solid ${C.border}`, borderRadius: 10, fontSize: 14, fontFamily: "inherit" }} />
        <input type="time" value={timeTo} onChange={e => setTimeTo(e.target.value)} title="Heure fin (vide = 23:59)"
          style={{ padding: "9px 8px", border: `1.5px solid ${C.border}`, borderRadius: 10, fontSize: 14, fontFamily: "inherit" }} />
        <button onClick={load} disabled={loading}
          style={{ padding: "9px 16px", background: C.blue, color: "#fff", border: "none", borderRadius: 10, fontWeight: 700, fontSize: 14, cursor: "pointer", opacity: loading ? 0.6 : 1 }}>
          {loading ? "Chargement…" : "Charger"}
        </button>
      </div>

      {error && <div style={{ background: C.redSoft, border: `1px solid #fecaca`, borderRadius: 10, padding: "10px 14px", color: C.red, fontSize: 13, marginBottom: 12 }}>{error}</div>}

      {/* Statuts */}
      {statusList.length > 0 && (
        <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 12, padding: 12, marginBottom: 12, boxShadow: C.shadow }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>Filtrer par statut</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button onClick={() => setStatusFilter("all")} style={chip(statusFilter === "all")}>Toutes ({orders.length})</button>
            {statusList.map(([sid, n]) => (
              <button key={sid} onClick={() => setStatusFilter(sid)} style={chip(statusFilter === sid)}>{stLabel(sid)} ({n})</button>
            ))}
          </div>
        </div>
      )}

      {/* Statut de PAIEMENT (pour exclure les paniers oubliés / non payés) */}
      {payList.length > 0 && (
        <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 12, padding: 12, marginBottom: 12, boxShadow: C.shadow }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>Filtrer par paiement <span style={{ color: C.orange, textTransform: "none" }}>· exclure les non payés !</span></div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button onClick={() => setPayFilter("all")} style={chip(payFilter === "all")}>Tous paiements</button>
            {payList.map(([sid, n]) => (
              <button key={sid} onClick={() => setPayFilter(sid)} style={chip(payFilter === sid)}>{payLabel(sid)} ({n})</button>
            ))}
          </div>
        </div>
      )}

      {/* Récap */}
      {totalLines > 0 && (
        <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
          <span style={badge(C.greenSoft, C.green)}>{mappedLines} mappées</span>
          <span style={badge(C.redSoft, C.red)}>{blocked.length} à corriger</span>
          {chariotLines > 0 && <span style={badge(C.orangeSoft, C.orange)}>{chariotLines} chariot (exclues)</span>}
          {processedCount > 0 && <span style={badge("#ede9fe", "#7c3aed")}>{processedCount} déjà sortie(s) (exclues)</span>}
          <span style={badge(C.bg, C.textSec)}>→ {toDeduct.length} réf au devis</span>
        </div>
      )}

      {/* Tableau */}
      {aggList.length > 0 && (
        <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden", boxShadow: C.shadow, marginBottom: 14 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
            <colgroup>
              <col style={{ width: "12%" }} />
              <col style={{ width: "10%" }} />
              <col style={{ width: "26%" }} />
              <col style={{ width: "6%" }} />
              <col style={{ width: "14%" }} />
              <col style={{ width: "32%" }} />
            </colgroup>
            <thead>
              <tr style={{ background: C.bg, fontSize: 10, fontWeight: 700, textTransform: "uppercase", color: C.textMuted, textAlign: "left" }}>
                <th style={th}>Réf Shopware</th><th style={th}>Réf Odoo</th><th style={th}>Produit</th><th style={th}>Qté</th><th style={th}>État</th><th style={th}>Commandes</th>
              </tr>
            </thead>
            <tbody>
              {aggList.map((a, i) => (
                <Fragment2 key={i}>
                  <tr style={{ borderTop: `1px solid ${C.border}`, fontSize: 12.5, verticalAlign: "top", background: a.chariot ? C.orangeSoft : !a.matched ? C.redSoft : a.manual ? "#f5f3ff" : C.white }}>
                    <td style={{ ...td, fontFamily: "monospace", fontWeight: 700, wordBreak: "break-word" }}>{a.ref}</td>
                    <td style={{ ...td, fontFamily: "monospace", color: a.matched ? C.green : C.textMuted }}>{a.odooRef || "—"}</td>
                    <td style={td}>{a.name}</td>
                    <td style={{ ...td, fontWeight: 800 }}>{a.qty}</td>
                    <td style={td}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: a.chariot ? C.orange : a.matched ? (a.manual ? C.purple : C.green) : C.red }}>
                        {a.chariot ? "Chariot" : a.matched ? (a.manual ? "✓ manuel" : "✓ OK") : "non mappé"}
                      </span>
                      {!a.chariot && (
                        <button onClick={() => { setFixRef(fixRef === a.ref ? null : a.ref); setFixQuery(""); setFixResults([]); }}
                          style={{ background: "none", border: "none", cursor: "pointer", color: C.blue, fontSize: 11, fontWeight: 700, padding: "0 0 0 6px", fontFamily: "inherit" }}>
                          {fixRef === a.ref ? "fermer" : "corriger"}
                        </button>
                      )}
                    </td>
                    <td style={{ ...td, fontSize: 11, color: C.textMuted, whiteSpace: "normal", overflowWrap: "anywhere", lineHeight: 1.5 }}>
                      {a.cmds.map((c, k) => <span key={k} style={{ display: "inline-block", marginRight: 6, whiteSpace: "nowrap" }}>{c.number}{c.qty > 1 ? `×${c.qty}` : ""}</span>)}
                    </td>
                  </tr>
                  {fixRef === a.ref && (
                    <tr style={{ background: "#f8fafc" }}>
                      <td colSpan={6} style={{ padding: "10px 12px" }}>
                        <input value={fixQuery} onChange={e => { setFixQuery(e.target.value); searchOdoo(e.target.value); }}
                          placeholder="Chercher le produit Odoo (réf, nom, code-barres)…" autoFocus
                          style={{ width: "100%", boxSizing: "border-box", padding: "8px 10px", border: `1.5px solid ${C.border}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", marginBottom: 6 }} />
                        {fixResults.map((r: any, k: number) => (
                          <button key={k} onClick={() => applyFix(a.ref, r.data)} disabled={fixing}
                            style={{ display: "block", width: "100%", textAlign: "left", padding: "7px 10px", background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 4, cursor: "pointer", fontFamily: "inherit", fontSize: 12.5 }}>
                            <b style={{ fontFamily: "monospace" }}>{r.data.default_code || "—"}</b> · {r.data.name}
                          </button>
                        ))}
                      </td>
                    </tr>
                  )}
                </Fragment2>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Bloc client + création devis */}
      {aggList.length > 0 && (
        <div style={{ background: C.white, border: `1.5px solid ${C.blue}`, borderRadius: 12, padding: 14, boxShadow: "0 0 0 3px #eff6ff" }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 8 }}>Client e-shop (Odoo)</div>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <input value={partnerInput} onChange={e => setPartnerInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") resolvePartner(); }}
              placeholder="Nom du client e-shop (ex: eSHOP)"
              style={{ flex: 1, padding: "9px 12px", border: `1.5px solid ${C.border}`, borderRadius: 10, fontSize: 14, fontFamily: "inherit" }} />
            <button onClick={resolvePartner} style={{ padding: "0 16px", background: C.bg, color: C.text, border: `1px solid ${C.border}`, borderRadius: 10, fontWeight: 700, fontSize: 13, cursor: "pointer" }}>Vérifier</button>
          </div>
          {partner && <div style={{ fontSize: 13, color: C.green, fontWeight: 700, marginBottom: 10 }}>✓ {partner.name} (id {partner.id})</div>}
          <button onClick={createQuote} disabled={creatingQuote || !partner || !toDeduct.length}
            style={{ width: "100%", padding: "13px", background: (!partner || !toDeduct.length) ? "#cbd5e1" : C.green, color: "#fff", border: "none", borderRadius: 11, fontWeight: 800, fontSize: 15, cursor: (!partner || !toDeduct.length) ? "default" : "pointer", opacity: creatingQuote ? 0.6 : 1 }}>
            {creatingQuote ? "Création…" : `Créer le devis Odoo (${toDeduct.length} ligne${toDeduct.length > 1 ? "s" : ""})`}
          </button>
        </div>
      )}

      {!loading && orders.length === 0 && !error && (
        <div style={{ textAlign: "center", color: C.textMuted, padding: 40, fontSize: 14 }}>Aucune commande ce jour-là</div>
      )}
    </div>
  );
}

const th: React.CSSProperties = { padding: "8px 10px", letterSpacing: "0.03em" };
const td: React.CSSProperties = { padding: "9px 10px", wordBreak: "break-word" };

// ════════════════════════════════════════════════════════════════
//  Onglet Synchro stock — comparaison Odoo vs Shopware par produit
// ════════════════════════════════════════════════════════════════
interface StockRow { ref: string; name: string; odoo: number | null; shopware: number | null; loading: boolean; error?: string; }
function StockSyncTab({ session, onToast }: { session: odoo.OdooSession; onToast: Props["onToast"] }) {
  const [input, setInput] = useState("");
  const [rows, setRows] = useState<StockRow[]>(() => {
    try { return JSON.parse(localStorage.getItem("wms_stocksync_refs") || "[]").map((ref: string) => ({ ref, name: "", odoo: null, shopware: null, loading: false })); } catch { return []; }
  });

  const persistRefs = (rs: StockRow[]) => { try { localStorage.setItem("wms_stocksync_refs", JSON.stringify(rs.map(r => r.ref))); } catch {} };

  const fetchRow = async (ref: string): Promise<Partial<StockRow>> => {
    let odoo_q: number | null = null, shopware_q: number | null = null, name = "", error = "";
    // Stock Odoo via le MÊME mapping que les sorties (réf fournisseur, EAN, LR…)
    try {
      const matches = await odoo.matchEshopSkus(session, [ref]);
      const m: any = matches[ref];
      if (m?.product_id) {
        name = m.product_name || "";
        const detail = await odoo.getProductStockDetail(session, m.product_id);
        // detail = tableau par emplacement/lot → on somme le dispo (qty - réservé)
        odoo_q = Math.round((detail || []).reduce((s: number, d: any) => s + ((d.qty || 0) - (d.reservedQty || 0)), 0));
      } else {
        // fallback recherche directe
        const o = await odoo.getStockByRef(session, ref);
        if (o) { odoo_q = o.available; name = o.name; } else error = "Odoo: introuvable";
      }
    } catch (e: any) { error = "Odoo: " + e.message; }
    try {
      const r = await fetch(`/api/shopware-explore?action=stockInfo&articleNumber=${encodeURIComponent(ref)}`).then(x => x.json());
      if (r.found) shopware_q = r.native_inStock ?? null; else error = (error ? error + " · " : "") + "Shopware: introuvable";
    } catch (e: any) { error = (error ? error + " · " : "") + "Shopware: " + e.message; }
    return { name, odoo: odoo_q, shopware: shopware_q, error: error || undefined };
  };

  const addRef = async () => {
    const ref = input.trim();
    if (!ref || rows.some(r => r.ref === ref)) { setInput(""); return; }
    const newRow: StockRow = { ref, name: "", odoo: null, shopware: null, loading: true };
    const next = [...rows, newRow];
    setRows(next); persistRefs(next); setInput("");
    const data = await fetchRow(ref);
    setRows(prev => prev.map(r => r.ref === ref ? { ...r, ...data, loading: false } : r));
  };

  const refreshAll = async () => {
    for (const r of rows) {
      setRows(prev => prev.map(x => x.ref === r.ref ? { ...x, loading: true } : x));
      const data = await fetchRow(r.ref);
      setRows(prev => prev.map(x => x.ref === r.ref ? { ...x, ...data, loading: false } : x));
    }
  };

  const removeRef = (ref: string) => { const next = rows.filter(r => r.ref !== ref); setRows(next); persistRefs(next); };

  // Pousse le stock Odoo vers Shopware (ÉCRITURE) avec confirmation
  const [pushing, setPushing] = useState<string | null>(null);
  const pushStock = async (r: StockRow) => {
    if (r.odoo == null) { onToast("Stock Odoo inconnu", "error"); return; }
    if (!confirm(`Écrire le stock Shopware de ${r.ref} :\n${r.shopware ?? "?"} → ${r.odoo} ?\n\n⚠ Cette action modifie le stock affiché sur le site.`)) return;
    setPushing(r.ref);
    try {
      const res = await fetch(`/api/shopware-explore?action=setStock&articleNumber=${encodeURIComponent(r.ref)}&qty=${r.odoo}`).then(x => x.json());
      if (res.ok) {
        setRows(prev => prev.map(x => x.ref === r.ref ? { ...x, shopware: res.newStock ?? r.odoo } : x));
        onToast(`✓ ${r.ref} : Shopware ${res.oldStock} → ${res.newStock}`, "success");
      } else onToast("Erreur : " + (res.error || "échec"), "error");
    } catch (e: any) { onToast("Erreur : " + e.message, "error"); }
    setPushing(null);
  };

  return (
    <div style={{ paddingBottom: 80 }}>
      <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 12 }}>Compare le stock Odoo et Shopware. Le bouton "Pousser" écrit le vrai stock Odoo sur Shopware (test prudent sur 1 produit d'abord).</div>
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter") addRef(); }}
          placeholder="Réf produit (ex: 429000040)"
          style={{ flex: 1, maxWidth: 320, padding: "9px 12px", border: `1.5px solid ${C.border}`, borderRadius: 10, fontSize: 14, fontFamily: "inherit" }} />
        <button onClick={addRef} style={{ padding: "9px 16px", background: C.blue, color: "#fff", border: "none", borderRadius: 10, fontWeight: 700, fontSize: 14, cursor: "pointer" }}>+ Ajouter</button>
        {rows.length > 0 && <button onClick={refreshAll} style={{ padding: "9px 16px", background: C.bg, color: C.text, border: `1px solid ${C.border}`, borderRadius: 10, fontWeight: 700, fontSize: 14, cursor: "pointer" }}>↻ Tout rafraîchir</button>}
      </div>

      {rows.length === 0 ? (
        <div style={{ textAlign: "center", color: C.textMuted, padding: 40, fontSize: 14 }}>Ajoute des références produit à suivre</div>
      ) : (
        <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden", boxShadow: C.shadow }}>
          <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
            <colgroup><col style={{ width: "12%" }} /><col style={{ width: "30%" }} /><col style={{ width: "12%" }} /><col style={{ width: "13%" }} /><col style={{ width: "10%" }} /><col style={{ width: "17%" }} /><col style={{ width: "6%" }} /></colgroup>
            <thead><tr style={{ background: C.bg, fontSize: 10, fontWeight: 700, textTransform: "uppercase", color: C.textMuted, textAlign: "left" }}>
              <th style={th}>Réf</th><th style={th}>Produit</th><th style={th}>Stock Odoo</th><th style={th}>Stock Shopware</th><th style={th}>Écart</th><th style={th}>Action</th><th style={th}></th>
            </tr></thead>
            <tbody>
              {rows.map((r, i) => {
                const ecart = (r.odoo != null && r.shopware != null) ? r.odoo - r.shopware : null;
                return (
                  <tr key={i} style={{ borderTop: `1px solid ${C.border}`, fontSize: 13, verticalAlign: "top", background: ecart !== null && ecart !== 0 ? "#fff7ed" : C.white }}>
                    <td style={{ ...td, fontFamily: "monospace", fontWeight: 700 }}>{r.ref}</td>
                    <td style={td}>{r.loading ? "…" : (r.name || (r.error ? <span style={{ color: C.red, fontSize: 11 }}>{r.error}</span> : "—"))}</td>
                    <td style={{ ...td, fontWeight: 800 }}>{r.odoo ?? "—"}</td>
                    <td style={{ ...td, fontWeight: 800 }}>{r.shopware ?? "—"}</td>
                    <td style={{ ...td, fontWeight: 800, color: ecart == null ? C.textMuted : ecart === 0 ? C.green : C.orange }}>{ecart == null ? "—" : ecart === 0 ? "✓" : (ecart > 0 ? `+${ecart}` : ecart)}</td>
                    <td style={td}>
                      {r.odoo != null && ecart !== 0 && (
                        <button onClick={() => pushStock(r)} disabled={pushing === r.ref}
                          style={{ padding: "5px 10px", background: C.blue, color: "#fff", border: "none", borderRadius: 7, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", opacity: pushing === r.ref ? 0.6 : 1 }}>
                          {pushing === r.ref ? "…" : "Pousser →"}
                        </button>
                      )}
                    </td>
                    <td style={td}><button onClick={() => removeRef(r.ref)} style={{ background: "none", border: "none", cursor: "pointer", color: C.textMuted, fontSize: 16 }}>×</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function chip(active: boolean): React.CSSProperties {
  return { padding: "5px 12px", borderRadius: 8, border: `1.5px solid ${active ? "#2563eb" : "#e5e7eb"}`, background: active ? "#eff6ff" : "#fff", color: active ? "#2563eb" : "#374151", fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "inherit" };
}
function badge(bg: string, color: string): React.CSSProperties {
  return { background: bg, color, borderRadius: 8, padding: "6px 12px", fontWeight: 700, fontSize: 13 };
}
