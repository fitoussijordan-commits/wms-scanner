"use client";
import { useState, useEffect, useCallback, useRef, Fragment as Fragment2 } from "react";
import * as odoo from "@/lib/odoo";
import FieldSettingsGear from "@/components/FieldSettingsGear";
import { useScannerListener } from "@/lib/useScannerListener";
import ChariotConfigScreen from "@/components/ChariotConfigScreen";
import { getEshopMappingOverrides, saveEshopMappingOverride, getCartonsConfig, getProcessedEshopOrders, markEshopOrdersProcessed, getLastProcessedEshopOrders, getCronRunHistory, type EshopMappingOverrides, type CronRunStatus } from "@/lib/supabase";
import { writeHeaders } from "@/lib/writeToken";

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
  const [tab, setTab] = useState<"sorties" | "audit" | "resend" | "reappro" | "chariot">("sorties");
  return (
    <div style={{ padding: "16px 16px 0", width: "100%", maxWidth: "100%", boxSizing: "border-box", fontFamily: "'DM Sans', sans-serif" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
        <button onClick={onBack} style={{ background: C.bg, border: "none", borderRadius: 10, padding: 8, cursor: "pointer", display: "flex" }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={C.text} strokeWidth="2"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
        </button>
        <div style={{ fontSize: 17, fontWeight: 700, color: C.text, flex: 1 }}>E-shop</div>
        <FieldSettingsGear session={session} onToast={onToast} screen="eshopSorties" />
      </div>
      <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
        {([["sorties", "Sorties du jour"], ["reappro", "Réappro chariot"], ["chariot", "Config. chariot"], ["audit", "Audit catalogue"], ["resend", "Renvoi"]] as const).map(([k, lbl]) => (
          <button key={k} onClick={() => setTab(k)}
            style={{ padding: "9px 16px", borderRadius: 10, border: `1.5px solid ${tab === k ? C.blue : C.border}`, background: tab === k ? C.blueSoft : C.white, color: tab === k ? C.blue : C.textSec, fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>
            {lbl}
          </button>
        ))}
      </div>
      {/* Onglets gardés montés (display:none) pour ne pas perdre l'état (audit, etc.) */}
      <div style={{ display: tab === "sorties" ? "block" : "none" }}><SortiesTab session={session} onToast={onToast} /></div>
      <div style={{ display: tab === "audit" ? "block" : "none" }}><AuditTab session={session} onToast={onToast} /></div>
      <div style={{ display: tab === "reappro" ? "block" : "none" }}><ReapproChariotTab session={session} onToast={onToast} active={tab === "reappro"} /></div>
      <div style={{ display: tab === "chariot" ? "block" : "none" }}><ChariotConfigScreen session={session} onToast={onToast} /></div>
      <div style={{ display: tab === "resend" ? "block" : "none" }}><ResendTab onToast={onToast} /></div>
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
  // Valider automatiquement le pick + le out dans Odoo après création (choix mémorisé).
  const [autoValidate, setAutoValidate] = useState<boolean>(() => {
    try { return localStorage.getItem("eshop_auto_validate") === "1"; } catch { return false; }
  });
  // Récap des 5 dernières commandes validées (pick / out / facture) — anomalies à traiter à la main sur Odoo
  const [recentStatus, setRecentStatus] = useState<odoo.EshopOrderStatus[]>([]);
  const [recentLoading, setRecentLoading] = useState(false);
  // Historique des runs du cron auto — pour vérifier qu'il tourne sans attendre le lendemain,
  // et repérer un échec même si un run suivant a réussi depuis (n'écrase plus l'historique).
  const [cronHistory, setCronHistory] = useState<CronRunStatus[] | undefined>(undefined);
  const [showAllCronHistory, setShowAllCronHistory] = useState(false);
  // Popup d'anomalie (pick/OUT non validé) à l'arrivée sur l'écran — régularisation manuelle sur Odoo
  const [showAnomalyPopup, setShowAnomalyPopup] = useState(false);
  // Activer/désactiver + régler la fréquence du déclenchement externe du cron (cron-job.org)
  const [cronToggle, setCronToggle] = useState<{ enabled: boolean; jobId: number; intervalMinutes: number | null; presets: number[] } | null | undefined>(undefined);
  const [cronToggleBusy, setCronToggleBusy] = useState(false);
  const [cronFreqBusy, setCronFreqBusy] = useState(false);

  // ── Correction ponctuelle des dates d'expédition prévues ────────────────────
  // Rattrapage des commandes sorties par le cron AVANT qu'il ne pose la date.
  // undefined = on ne sait pas encore · true = déjà fait, le bouton disparaît.
  const [shipFixDone, setShipFixDone] = useState<boolean | undefined>(undefined);
  const [shipFixBusy, setShipFixBusy] = useState(false);

  const loadShipFixStatus = useCallback(async () => {
    try {
      const r = await fetch("/api/fix-shipping-date?status=1").then(x => x.json());
      setShipFixDone(!!r.done);
    } catch { setShipFixDone(true); } // en cas de doute on masque plutôt que d'afficher un bouton cassé
  }, []);

  const runShipFix = async () => {
    if (shipFixBusy) return;
    // Sans NEXT_PUBLIC_WMS_TOKEN au build, aucun entête n'est envoyé → 401 opaque.
    // On le dit clairement plutôt que de laisser un « Non autorisé » inexplicable.
    if (!writeHeaders["x-wms-token"]) {
      onToast("Token d'écriture absent de cette build (NEXT_PUBLIC_WMS_TOKEN)", "error");
      return;
    }
    setShipFixBusy(true);
    try {
      const r = await fetch("/api/fix-shipping-date", { method: "POST", headers: writeHeaders }).then(x => x.json());
      if (r.ok) {
        const s = r.summary || {};
        const parts = [`${s["écrites"] ?? 0} corrigée(s)`];
        if (s["déjàRenseignées"]) parts.push(`${s["déjàRenseignées"]} déjà à jour`);
        if (s["introuvables"]) parts.push(`${s["introuvables"]} introuvable(s)`);
        onToast(`✓ Dates d'expédition : ${parts.join(", ")}`, "success");
        setShipFixDone(true);
      } else {
        onToast("Erreur : " + (r.error || "échec de la correction"), "error");
      }
    } catch (e: any) { onToast("Erreur : " + e.message, "error"); }
    setShipFixBusy(false);
  };

  const loadCronToggle = useCallback(async () => {
    try {
      const r = await fetch("/api/cronjob-control?action=status").then(x => x.json());
      if (r.ok) setCronToggle({ enabled: r.enabled, jobId: r.jobId, intervalMinutes: r.intervalMinutes ?? null, presets: r.presets || [] });
      else setCronToggle(null);
    } catch { setCronToggle(null); }
  }, []);

  const toggleCron = async () => {
    if (!cronToggle) return;
    setCronToggleBusy(true);
    try {
      const action = cronToggle.enabled ? "disable" : "enable";
      const r = await fetch(`/api/cronjob-control?action=${action}`, { method: "POST", headers: writeHeaders }).then(x => x.json());
      if (r.ok) {
        setCronToggle(prev => prev ? { ...prev, enabled: r.enabled } : prev);
        onToast(r.enabled ? "✓ Cron réactivé" : "✓ Cron désactivé", "success");
      } else onToast("Erreur : " + (r.error || "échec"), "error");
    } catch (e: any) { onToast("Erreur : " + e.message, "error"); }
    setCronToggleBusy(false);
  };

  const setCronFrequency = async (minutes: number) => {
    if (!cronToggle) return;
    setCronFreqBusy(true);
    try {
      const r = await fetch(`/api/cronjob-control?action=setFreq&minutes=${minutes}`, { method: "POST", headers: writeHeaders }).then(x => x.json());
      if (r.ok) {
        setCronToggle(prev => prev ? { ...prev, intervalMinutes: r.intervalMinutes } : prev);
        onToast(`✓ Fréquence réglée : ${freqLabel(minutes)}`, "success");
      } else onToast("Erreur : " + (r.error || "échec"), "error");
    } catch (e: any) { onToast("Erreur : " + e.message, "error"); }
    setCronFreqBusy(false);
  };

  const loadRecentStatus = useCallback(async () => {
    setRecentLoading(true);
    try {
      const recents = await getLastProcessedEshopOrders(20);
      const statuses = await odoo.getRecentEshopOrdersStatus(session, recents);
      setRecentStatus(statuses);
      if (statuses.some(s => s.anomaly)) setShowAnomalyPopup(true);
    } catch { /* non bloquant — juste un récap informatif */ }
    setRecentLoading(false);
  }, [session]);

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
    loadRecentStatus();
    getCronRunHistory().then(setCronHistory).catch(() => setCronHistory([]));
    loadCronToggle();
    loadShipFixStatus();
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

  // ── CHARIOT : quantités vendues des réfs chariot (mêmes filtres que le devis,
  // mais SEULEMENT les réfs chariot) → pour décrémenter le stock chariot dans l'app.
  const chariotAgg: Record<string, number> = {};
  for (const o of orders) {
    if (processed.has(o.number)) continue;
    if (String(o.orderStatusId) === "-1") continue;
    if (String(o.paymentStatusId) !== "12") continue;
    for (const l of o.lines) {
      if (l.mode === 4 || !l.articleNumber) continue;
      if (!isChariot(l.articleNumber)) continue;
      chariotAgg[l.articleNumber] = (chariotAgg[l.articleNumber] || 0) + l.quantity;
    }
  }
  const chariotDeductions = Object.entries(chariotAgg).map(([sku, qty]) => ({ sku, qty }));

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
    if (!toDeduct.length && !chariotDeductions.length) { onToast("Aucune ligne mappée à déduire", "info"); return; }
    if (blocked.length && !confirm(`${blocked.length} référence(s) NON mappée(s) seront ignorées. Continuer quand même ?`)) return;
    if (!confirm(`Créer et CONFIRMER la commande Odoo pour ${partner.name} avec ${toDeduct.length} ligne(s) ?\n(génère le bon de préparation)${autoValidate ? "\n\n⚠ Le pick ET le OUT seront VALIDÉS automatiquement (stock déduit)." : ""}`)) return;
    setCreatingQuote(true);
    try {
      let q: any = null;
      if (toDeduct.length) {
        const lines = toDeduct.map(a => ({
          productId: a.productId, qty: a.qty, name: a.name,
          orders: a.cmds.map(c => `${c.number}${c.qty > 1 ? ` ×${c.qty}` : ""}`).join(", "),
        }));
        // confirm=true → commande confirmée + pick généré + tags import eShop / Transmise
        q = await odoo.createEshopQuotation(session, partner.id, lines, `E-shop ${dateFrom}${dateFrom !== dateTo ? "→" + dateTo : ""}`, true);
      }
      // GARDE-FOU : marque UNIQUEMENT les commandes réellement incluses (payées, non annulées)
      const includedNumbers = deductOrderNumbers;
      try { await markEshopOrdersProcessed(includedNumbers, q ? q.name : "chariot", "manual"); setProcessed(prev => new Set([...Array.from(prev), ...includedNumbers])); } catch {}
      // Trace : export Excel du détail envoyé au devis (pour comparer avec Odoo)
      if (q) try {
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
      if (q) onToast(`✓ Commande ${q.name} confirmée (pick généré) — ${includedNumbers.length} commande(s) sorties · Excel téléchargé`, "success");
      // ── Validation auto du pick + OUT dans Odoo (si la case est cochée) ──
      if (q && autoValidate) {
        try {
          const r = await odoo.validateOrderPickings(session, q.id);
          if (r.validated.length) onToast(`✓ Validé dans Odoo : ${r.validated.join(", ")}`, "success");
          if (r.failed.length) onToast(`⚠ Validation partielle : ${r.failed.map(f => `${f.name} (${f.error})`).join(" · ")}`, "error");
          if (!r.validated.length && !r.failed.length) onToast("ℹ Aucun picking à valider", "info");
        } catch (e: any) { onToast("⚠ Validation Odoo : " + e.message, "error"); }
      }
      // ── CHARIOT : décrémente le stock chariot des réfs chariot vendues ──
      if (chariotDeductions.length) {
        try {
          const sb = await import("@/lib/supabase");
          const { shortages } = await sb.decrementChariotStock(chariotDeductions);
          if (shortages.length) {
            const msg = shortages.map(s => `${s.sku} (demandé ${s.demande}, dispo ${s.dispo})`).join(" · ");
            onToast(`⚠ Chariot insuffisant : ${msg}`, "error");
          } else {
            onToast(`Chariot mis à jour (${chariotDeductions.length} réf décrémentée${chariotDeductions.length > 1 ? "s" : ""}) ✓`, "success");
          }
        } catch (e: any) { onToast("Chariot : erreur MAJ stock — " + e.message, "error"); }
      }
    } catch (e: any) { onToast("Erreur création devis : " + e.message, "error"); }
    setCreatingQuote(false);
    loadRecentStatus();
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
          <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, cursor: "pointer", fontSize: 13, color: C.text, userSelect: "none" }}>
            <input type="checkbox" checked={autoValidate}
              onChange={e => { setAutoValidate(e.target.checked); try { localStorage.setItem("eshop_auto_validate", e.target.checked ? "1" : "0"); } catch {} }}
              style={{ width: 17, height: 17, cursor: "pointer", accentColor: C.green }} />
            Valider automatiquement le <strong>pick</strong> + le <strong>OUT</strong> dans Odoo
          </label>
          <button onClick={createQuote} disabled={creatingQuote || !partner || !toDeduct.length}
            style={{ width: "100%", padding: "13px", background: (!partner || !toDeduct.length) ? "#cbd5e1" : C.green, color: "#fff", border: "none", borderRadius: 11, fontWeight: 800, fontSize: 15, cursor: (!partner || !toDeduct.length) ? "default" : "pointer", opacity: creatingQuote ? 0.6 : 1 }}>
            {creatingQuote ? "Création…" : `Créer + confirmer la commande (${toDeduct.length} ligne${toDeduct.length > 1 ? "s" : ""})`}
          </button>
        </div>
      )}

      {!loading && orders.length === 0 && !error && (
        <div style={{ textAlign: "center", color: C.textMuted, padding: 40, fontSize: 14 }}>Aucune commande ce jour-là</div>
      )}

      {/* Correction ponctuelle — disparaît définitivement une fois exécutée (état partagé
          via Supabase, donc masqué sur tous les postes, pas seulement celui qui a cliqué) */}
      {shipFixDone === false && (
        <div style={{ marginTop: 24, background: C.orangeSoft, border: "1px solid #fed7aa", borderRadius: 12, padding: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#9a3412", marginBottom: 4 }}>
            🛠 Dates d&apos;expédition manquantes
          </div>
          <div style={{ fontSize: 12, color: "#9a3412", lineHeight: 1.5, marginBottom: 10 }}>
            72 commandes déjà sorties n&apos;ont pas de date d&apos;expédition prévue : le cron ne la
            remplissait pas. Ce bouton leur remet leur date de création. À cliquer une seule
            fois — il disparaîtra ensuite.
          </div>
          <button onClick={runShipFix} disabled={shipFixBusy}
            style={{
              padding: "10px 16px", background: shipFixBusy ? "#fdba74" : C.orange, color: "#fff",
              border: "none", borderRadius: 9, fontSize: 13, fontWeight: 700,
              cursor: shipFixBusy ? "not-allowed" : "pointer", fontFamily: "inherit",
            }}>
            {shipFixBusy ? "Correction en cours…" : "Corriger les 72 commandes"}
          </button>
        </div>
      )}

      {/* Historique du cron automatique — vérifier qu'il tourne, sans perdre un échec écrasé par un run suivant */}
      <div style={{ marginTop: 24, background: C.white, border: `1px solid ${C.border}`, borderRadius: 12, padding: 14, boxShadow: C.shadow }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.05em", flex: 1 }}>
            🤖 Historique du cron automatique
          </div>
          {cronToggle !== undefined && cronToggle !== null && (
            <button onClick={toggleCron} disabled={cronToggleBusy}
              style={{
                padding: "5px 10px", borderRadius: 8, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
                border: `1px solid ${cronToggle.enabled ? "#bbf7d0" : "#fecaca"}`,
                background: cronToggle.enabled ? C.greenSoft : C.redSoft,
                color: cronToggle.enabled ? C.green : C.red,
                opacity: cronToggleBusy ? 0.6 : 1,
              }}>
              {cronToggleBusy ? "…" : cronToggle.enabled ? "✓ Activé — cliquer pour désactiver" : "⏸ Désactivé — cliquer pour activer"}
            </button>
          )}
          {cronToggle === null && (
            <span style={{ fontSize: 11, color: C.textMuted }}>Contrôle cron-job.org indisponible</span>
          )}
          <button onClick={() => { setCronHistory(undefined); getCronRunHistory().then(setCronHistory).catch(() => setCronHistory([])); }}
            style={{ padding: "5px 10px", background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 11, fontWeight: 700, color: C.textSec, cursor: "pointer", fontFamily: "inherit" }}>
            ↻ Rafraîchir
          </button>
        </div>

        {cronToggle && cronToggle.presets?.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 12, paddingBottom: 12, borderBottom: `1px solid ${C.border}` }}>
            <span style={{ fontSize: 11.5, color: C.textMuted, fontWeight: 600 }}>Fréquence :</span>
            {cronToggle.presets.map(m => {
              const active = cronToggle.intervalMinutes === m;
              return (
                <button key={m} onClick={() => setCronFrequency(m)} disabled={cronFreqBusy || active}
                  style={{
                    padding: "4px 10px", borderRadius: 999, fontSize: 11.5, fontWeight: 700, cursor: active ? "default" : "pointer", fontFamily: "inherit",
                    border: `1.5px solid ${active ? C.blue : C.border}`,
                    background: active ? C.blueSoft : C.white,
                    color: active ? C.blue : C.textSec,
                    opacity: cronFreqBusy ? 0.6 : 1,
                  }}>
                  {freqLabel(m)}
                </button>
              );
            })}
            {cronToggle.intervalMinutes == null && (
              <span style={{ fontSize: 11, color: C.textMuted }}>(fréquence actuelle non reconnue — configure-la ici)</span>
            )}
          </div>
        )}

        {cronHistory === undefined ? (
          <div style={{ fontSize: 13, color: C.textMuted }}>Chargement…</div>
        ) : cronHistory.length === 0 ? (
          <div style={{ fontSize: 13, color: C.textMuted }}>Aucun run enregistré pour l'instant (le cron n'a pas encore tourné).</div>
        ) : (
          <div>
            {cronHistory.some(r => !r.ok) && (
              <div style={{ fontSize: 11.5, fontWeight: 700, color: C.red, marginBottom: 8 }}>
                ⚠ {cronHistory.filter(r => !r.ok).length} échec(s) dans l'historique récent — à vérifier ci-dessous.
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {(showAllCronHistory ? cronHistory : cronHistory.slice(0, 5)).map((r, i) => (
                <div key={i} style={{ border: `1px solid ${r.ok ? C.border : "#fecaca"}`, background: r.ok ? C.bg : C.redSoft, borderRadius: 8, padding: "8px 10px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: r.ok ? C.green : C.red }}>
                      {r.ok ? "✓ OK" : "⚠ Échec"}
                    </span>
                    <span style={{ fontSize: 11, color: C.textMuted }}>
                      {new Date(r.ranAt).toLocaleString("fr-FR")}
                    </span>
                  </div>
                  <div style={{ fontSize: 12.5, color: C.text }}>{r.summary}</div>
                  {r.error && <div style={{ fontSize: 11.5, color: C.red, marginTop: 2 }}>{r.error}</div>}
                </div>
              ))}
            </div>
            {cronHistory.length > 5 && (
              <button onClick={() => setShowAllCronHistory(v => !v)}
                style={{ marginTop: 8, background: "none", border: "none", color: C.blue, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", padding: 0 }}>
                {showAllCronHistory ? "Voir moins" : `Voir les ${cronHistory.length} runs`}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Récap des 20 dernières commandes validées — pick / out / facture, anomalies à traiter à la main sur Odoo */}
      <div style={{ marginTop: 24, background: C.white, border: `1px solid ${C.border}`, borderRadius: 12, padding: 14, boxShadow: C.shadow }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.05em", flex: 1 }}>
            20 dernières commandes validées
          </div>
          <button onClick={loadRecentStatus} disabled={recentLoading}
            style={{ padding: "5px 10px", background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 11, fontWeight: 700, color: C.textSec, cursor: "pointer", fontFamily: "inherit", opacity: recentLoading ? 0.6 : 1 }}>
            {recentLoading ? "…" : "↻ Rafraîchir"}
          </button>
        </div>
        {recentStatus.length === 0 ? (
          <div style={{ fontSize: 13, color: C.textMuted, padding: "8px 0" }}>{recentLoading ? "Chargement…" : "Aucune commande validée récemment"}</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {recentStatus.map((s, i) => {
              const MAX_REFS = 6;
              const shownRefs = s.orderNumbers.slice(0, MAX_REFS);
              const hiddenCount = s.orderNumbers.length - shownRefs.length;
              return (
              <div key={i} style={{ border: `1px solid ${s.anomaly ? "#fecaca" : C.border}`, background: s.anomaly ? C.redSoft : C.bg, borderRadius: 10, padding: "10px 12px", width: "100%", maxWidth: "100%", boxSizing: "border-box", overflow: "hidden" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
                  <span style={{ fontSize: 11, color: C.textMuted, fontWeight: 600 }}>Commande Odoo</span>
                  <span style={{ fontFamily: "monospace", fontWeight: 800, fontSize: 14, color: C.text }}>{s.devis}</span>
                  <span style={{
                    fontSize: 10, fontWeight: 800, padding: "2px 7px", borderRadius: 999, textTransform: "uppercase", letterSpacing: "0.03em",
                    background: s.source === "cron" ? "#ede9fe" : "#f1f5f9", color: s.source === "cron" ? C.purple : C.textSec,
                  }}>
                    {s.source === "cron" ? "🤖 Auto (cron)" : "👤 Manuel"}
                  </span>
                  <span style={{ marginLeft: "auto", fontSize: 11, fontWeight: 700, color: s.anomaly ? C.red : C.green }}>
                    {s.anomaly ? "⚠ Anomalie" : "✓ OK"}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 6, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", overflowWrap: "anywhere" }}>
                  <span style={{ flexShrink: 0 }}>réf. Shopware :</span>
                  {shownRefs.map((n, k) => (
                    <span key={k} style={{ fontFamily: "monospace", background: C.white, border: `1px solid ${C.border}`, borderRadius: 5, padding: "1px 5px" }}>{n}</span>
                  ))}
                  {hiddenCount > 0 && <span style={{ fontWeight: 700 }}>+{hiddenCount} autre{hiddenCount > 1 ? "s" : ""}</span>}
                </div>
                <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 12 }}>
                  <span style={{ color: s.pick?.state === "done" ? C.green : C.orange, fontWeight: 700 }}>
                    Pick : {s.pick ? (s.pick.state === "done" ? "✓ validé" : `⏳ ${s.pick.state}`) : (s.found ? "—" : "?")}
                  </span>
                  <span style={{ color: s.out?.state === "done" ? C.green : C.orange, fontWeight: 700 }}>
                    Out : {s.out ? (s.out.state === "done" ? "✓ validé" : `⏳ ${s.out.state}`) : (s.found ? "—" : "?")}
                  </span>
                  <span style={{ color: s.invoiced ? C.green : C.orange, fontWeight: 700 }}>
                    Facture : {s.invoiced ? "✓ faite" : "⏳ à faire"}
                  </span>
                </div>
                {s.anomaly && (
                  <div style={{ marginTop: 6, fontSize: 11.5, color: C.red, overflowWrap: "anywhere" }}>
                    {s.anomaly} — à traiter manuellement sur Odoo.
                  </div>
                )}
              </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Popup d'anomalie — pick/OUT non validé (souvent créé par le cron auto 22h) */}
      {showAnomalyPopup && (
        <div onClick={() => setShowAnomalyPopup(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.5)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: C.white, borderRadius: 16, padding: 20, maxWidth: 520, width: "100%", maxHeight: "80vh", overflowY: "auto", boxShadow: "0 20px 60px -12px rgba(0,0,0,0.35)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <span style={{ fontSize: 20 }}>⚠️</span>
              <div style={{ fontSize: 16, fontWeight: 800, color: C.text }}>Commande(s) à régulariser</div>
            </div>
            <div style={{ fontSize: 13, color: C.textMuted, marginBottom: 14 }}>
              Un pick ou une sortie (OUT) n'a pas pu être validé automatiquement — à corriger dans Odoo.
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 }}>
              {recentStatus.filter(s => s.anomaly).map((s, i) => {
                const base = (session.config.url || "").replace(/\/$/, "");
                const pickLink = s.pick ? `${base}/web#id=${s.pick.id}&model=stock.picking&view_type=form` : null;
                const outLink = s.out ? `${base}/web#id=${s.out.id}&model=stock.picking&view_type=form` : null;
                const orderLink = s.saleOrderId ? `${base}/web#id=${s.saleOrderId}&model=sale.order&view_type=form` : null;
                return (
                  <div key={i} style={{ border: `1.5px solid #fecaca`, background: C.redSoft, borderRadius: 10, padding: "10px 12px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                      <span style={{ fontFamily: "monospace", fontWeight: 800, fontSize: 14, color: C.text }}>{s.devis}</span>
                      <span style={{ fontSize: 11, color: C.red, fontWeight: 700 }}>{s.anomaly}</span>
                    </div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {pickLink && (
                        <a href={pickLink} target="_blank" rel="noopener noreferrer"
                          style={{ fontSize: 12, fontWeight: 700, color: C.blue, background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, padding: "5px 10px", textDecoration: "none" }}>
                          → Ouvrir le pick {s.pick?.name}
                        </a>
                      )}
                      {outLink && (
                        <a href={outLink} target="_blank" rel="noopener noreferrer"
                          style={{ fontSize: 12, fontWeight: 700, color: C.blue, background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, padding: "5px 10px", textDecoration: "none" }}>
                          → Ouvrir le OUT {s.out?.name}
                        </a>
                      )}
                      {!pickLink && !outLink && orderLink && (
                        <a href={orderLink} target="_blank" rel="noopener noreferrer"
                          style={{ fontSize: 12, fontWeight: 700, color: C.blue, background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, padding: "5px 10px", textDecoration: "none" }}>
                          → Ouvrir la commande {s.devis}
                        </a>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <button onClick={() => setShowAnomalyPopup(false)}
              style={{ width: "100%", padding: "11px", background: C.bg, color: C.text, border: `1px solid ${C.border}`, borderRadius: 10, fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: "inherit" }}>
              Fermer
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function freqLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  if (minutes === 1440) return "1×/jour";
  const h = minutes / 60;
  return `${h}h`;
}

const th: React.CSSProperties = { padding: "8px 10px", letterSpacing: "0.03em" };
const td: React.CSSProperties = { padding: "9px 10px", wordBreak: "break-word" };


// ════════════════════════════════════════════════════════════════
//  Onglet Audit catalogue — tous les produits actifs SW vs stock Odoo
// ════════════════════════════════════════════════════════════════
interface AuditRow { number: string; nameSW: string; inStock: number | null; odoo: number | null; productId: number; odooRef: string; mapped: boolean; detailId: number; }
function AuditTab({ session, onToast }: { session: odoo.OdooSession; onToast: Props["onToast"] }) {
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [filter, setFilter] = useState<"all" | "noOdoo" | "swZeroOdooStock" | "ok" | "unmapped" | "service">("noOdoo");
  const [error, setError] = useState("");
  const [chariot, setChariot] = useState<string[]>([]);
  const [service, setService] = useState<string[]>([]);
  const [fixRef, setFixRef] = useState<string | null>(null);
  const [fixQuery, setFixQuery] = useState("");
  const [fixResults, setFixResults] = useState<any[]>([]);
  const [pushing, setPushing] = useState<string | null>(null);
  // résultat de la MAJ par réf : { newStock, hasLocation, locCode }
  const [pushed, setPushed] = useState<Record<string, { newStock: number; hasLocation: boolean; locCode?: string }>>({});
  const [search, setSearch] = useState("");
  // Recherche DIRECTE dans Shopware, independante de la liste de l'audit.
  // L'audit ne couvre que le catalogue qu'il a su lister ; une reference absente
  // de cette liste reste parfaitement interrogeable et corrigeable par son
  // numero — c'est ce que fait Shopware avec /variants?useNumberAsId=true.
  const [direct, setDirect] = useState<{ number: string; found: boolean; sw: number | null; odoo: number | null; name: string; odooRef: string } | null>(null);
  const [directLoading, setDirectLoading] = useState(false);

  const chercherDirect = async (ref: string) => {
    const n = ref.trim();
    if (!n) return;
    setDirectLoading(true); setDirect(null);
    try {
      const sw = await fetch(`/api/shopware-explore?action=stockInfo&articleNumber=${encodeURIComponent(n)}`).then(r => r.json());
      let odooQty: number | null = null, nom = "", oref = "";
      try {
        const m = await odoo.matchEshopSkus(session, [n]);
        const hit: any = (m as any)[n];
        if (hit?.product_id) {
          nom = hit.product_name || ""; oref = hit.default_code || "";
          const stock = await odoo.getAvailableStockBatch(session, [hit.product_id]);
          odooQty = stock[hit.product_id] ?? 0;
        }
      } catch { /* le stock Odoo est un complement : son echec ne masque pas Shopware */ }
      setDirect({ number: n, found: !!sw?.found, sw: sw?.native_inStock ?? null, odoo: odooQty, name: nom, odooRef: oref });
      if (!sw?.found) onToast(`Référence ${n} introuvable dans Shopware`, "error");
    } catch (e: any) {
      onToast("Recherche Shopware impossible : " + (e?.message || e), "error");
    }
    setDirectLoading(false);
  };
  // valeur libre saisie par réf (pour MAJ manuelle)
  const [freeVal, setFreeVal] = useState<Record<string, string>>({});
  // emplacements préchargés : detailId → { code, stock }
  const [binMap, setBinMap] = useState<Record<string, { code: string; stock: number }>>({});

  const runAudit = async () => {
    setLoading(true); setError("");
    try {
      // 0) Listes chariot + service (exclusions)
      const sb = await import("@/lib/supabase");
      const [chariotList, serviceList] = await Promise.all([
        odoo.loadChariotSkus(session).catch(() => [] as string[]),
        sb.getServiceRefs().catch(() => [] as string[]),
      ]);
      setChariot(chariotList); setService(serviceList);
      // 1) Catalogue actif Shopware. Les emplacements (binAll) sont LOURDS
      //    (un fetch par emplacement, jusqu'à ~2000) : on ne bloque plus l'audit
      //    dessus. Ils se chargent en tâche de fond et la colonne emplacement se
      //    remplit ensuite — l'audit (stock SW vs Odoo) s'affiche tout de suite.
      setBinMap({});
      fetch("/api/shopware-explore?action=binAll")
        .then(r => r.json())
        .then(b => setBinMap(b.byDetail || {}))
        .catch(() => {});
      // Ne JAMAIS retomber silencieusement sur une liste vide : sans ce contrôle,
      // un Shopware injoignable (identifiants absents sur ce déploiement, panne
      // réseau, 401) donnait un audit à zéro ligne et aucun message — impossible
      // de distinguer « catalogue vide » de « appel échoué ».
      const catRes = await fetch("/api/shopware-explore?action=activeProducts").then(r => r.json());
      if (catRes?.error) throw new Error(`Shopware : ${catRes.error}`);
      if (!Array.isArray(catRes?.products)) {
        throw new Error("Shopware n'a pas renvoyé de catalogue (réponse inattendue)");
      }
      const products: any[] = catRes.products;
      if (!products.length) throw new Error("Shopware a répondu, mais aucun article actif");
      // 2) Mapping : cache + overrides d'abord, matchEshopSkus seulement pour les manquants
      const [cache, overrides] = await Promise.all([
        (await import("@/lib/supabase")).getEshopMappingCache(),
        (await import("@/lib/supabase")).getEshopMappingOverrides(),
      ]);
      const map: Record<string, any> = {};
      const missing: string[] = [];
      for (const p of products) {
        const ref = p.number;
        if (overrides[ref]) map[ref] = { product_id: overrides[ref].productId, default_code: overrides[ref].odooRef, product_name: overrides[ref].productName };
        else if (cache[ref]) map[ref] = cache[ref];
        else missing.push(ref);
      }
      // Matching auto pour les non-cachés, puis on enrichit le cache
      if (missing.length) {
        const fresh = await odoo.matchEshopSkus(session, missing);
        for (const ref of missing) {
          const m: any = fresh[ref];
          if (m?.product_id) map[ref] = { product_id: m.product_id, default_code: m.default_code, product_name: m.product_name };
        }
        // Sauvegarde du cache (fusion)
        const newCache = { ...cache };
        for (const ref of missing) if (map[ref]) newCache[ref] = map[ref];
        try { await (await import("@/lib/supabase")).saveEshopMappingCache(newCache); } catch {}
      }
      // 3) Stock Odoo en batch
      const productIds = Array.from(new Set(Object.values(map).map((m: any) => m.product_id).filter(Boolean))) as number[];
      const stockMap = await odoo.getAvailableStockBatch(session, productIds);
      // 4) Construire les lignes
      const out: AuditRow[] = products.map(p => {
        const m: any = map[p.number];
        return {
          number: p.number, nameSW: p.name, inStock: p.inStock ?? null,
          productId: m?.product_id || 0, odooRef: m?.default_code || "",
          mapped: !!m?.product_id, detailId: p.detailId || 0,
          odoo: m?.product_id ? (stockMap[m.product_id] ?? 0) : null,
        };
      });
      setRows(out);
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  const searchOdoo = async (q: string) => {
    if (q.trim().length < 2) { setFixResults([]); return; }
    try { const r = await odoo.globalSearch(session, q.trim()); setFixResults(r.filter((x: any) => x.type === "product").slice(0, 8)); } catch { setFixResults([]); }
  };
  const applyFix = async (ref: string, prod: any) => {
    try {
      await (await import("@/lib/supabase")).saveEshopMappingOverride(ref, prod.id, prod.default_code || "", prod.name);
      const stockMap = await odoo.getAvailableStockBatch(session, [prod.id]);
      setRows(prev => prev.map(r => r.number === ref ? { ...r, mapped: true, productId: prod.id, odooRef: prod.default_code || "", odoo: stockMap[prod.id] ?? 0 } : r));
      setFixRef(null); setFixQuery(""); setFixResults([]);
      onToast("Mapping enregistré ✓", "success");
    } catch (e: any) { onToast("Erreur : " + e.message, "error"); }
  };
  const markChariot = async (ref: string) => {
    try { await odoo.addChariotSku(session, ref); setChariot(prev => prev.includes(ref) ? prev : [...prev, ref]); setFixRef(null); onToast("Ajouté au chariot eShop ✓", "success"); }
    catch (e: any) { onToast("Erreur : " + e.message, "error"); }
  };
  const markService = async (ref: string) => {
    try { await (await import("@/lib/supabase")).addServiceRef(ref); setService(prev => prev.includes(ref) ? prev : [...prev, ref]); setFixRef(null); onToast("Marqué comme service ✓", "success"); }
    catch (e: any) { onToast("Erreur : " + e.message, "error"); }
  };

  // MAJ stock : écrit le stock Odoo dans Shopware (inStock) + vérifie l'emplacement.
  // L'écriture par emplacement n'est pas possible via l'API Pickware : on écrit le
  // stock global, et on ALERTE si l'article n'a pas d'emplacement (à ranger à la main).
  // override = valeur libre saisie ; sinon stock Odoo
  const pushStock = async (r: AuditRow, override?: number) => {
    const qty = override != null ? override : (r.odoo ?? 0);
    if (override == null && !r.mapped) { onToast("Produit non mappé", "error"); return; }
    if (qty < 0 || Number.isNaN(qty)) { onToast("Valeur invalide", "error"); return; }
    setPushing(r.number);
    try {
      // 1) écrire le stock global (instantané)
      const res = await fetch(`/api/shopware-explore?action=setStock&articleNumber=${encodeURIComponent(r.number)}&qty=${qty}`, { headers: writeHeaders }).then(x => x.json());
      if (!res.ok) throw new Error(res.error || "échec écriture stock");
      // 2) emplacement : lu depuis la map préchargée (pas d'appel réseau → rapide)
      const loc = binMap[String(r.detailId)];
      const hasLocation = !!loc;
      const locCode = loc?.code;
      setPushed(prev => ({ ...prev, [r.number]: { newStock: res.newStock, hasLocation, locCode } }));
      setRows(prev => prev.map(x => x.number === r.number ? { ...x, inStock: res.newStock } : x));
      if (hasLocation) onToast(`Stock mis à jour : ${res.newStock} (emplacement ${locCode}) ✓`, "success");
      else onToast(`Stock mis à jour : ${res.newStock} ⚠ SANS emplacement — à ranger dans Pickware`, "success");
    } catch (e: any) {
      onToast("Erreur : " + e.message, "error");
    }
    setPushing(null);
  };

  // Catégorisation
  const inList = (ref: string, list: string[]) => list.some(x => x.trim().toLowerCase() === ref.trim().toLowerCase());
  const cat = (r: AuditRow): "service" | "chariot" | "noOdoo" | "swZeroOdooStock" | "ok" | "unmapped" => {
    if (inList(r.number, service)) return "service";        // carte cadeau, etc. → hors champ principal
    if (inList(r.number, chariot)) return "chariot";        // déjà sorti, exclu
    if (!r.mapped) return "unmapped";
    if ((r.odoo ?? 0) <= 0) return "noOdoo";                 // actif SW mais pas de stock Odoo
    if ((r.inStock ?? 0) <= 0 && (r.odoo ?? 0) > 0) return "swZeroOdooStock"; // 0 sur SW mais stock Odoo
    return "ok";
  };
  const counts: Record<string, number> = { all: rows.length, noOdoo: 0, swZeroOdooStock: 0, ok: 0, unmapped: 0, service: 0, chariot: 0 };
  for (const r of rows) counts[cat(r)]++;
  const q = search.trim().toLowerCase();
  let visible = filter === "all" ? rows : rows.filter(r => cat(r) === filter);
  if (q) visible = visible.filter(r => r.number.toLowerCase().includes(q) || (r.odooRef || "").toLowerCase().includes(q) || (r.nameSW || "").toLowerCase().includes(q));

  const FILTERS: { k: typeof filter; label: string }[] = [
    { k: "noOdoo", label: "Actif SW sans stock Odoo" },
    { k: "swZeroOdooStock", label: "0 sur SW mais stock Odoo" },
    { k: "unmapped", label: "Non mappés" },
    { k: "ok", label: "Cohérents" },
    { k: "service", label: "Service" },
    { k: "all", label: "Tout" },
  ];

  return (
    <div style={{ paddingBottom: 80 }}>
      <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 12 }}>Compare tout le catalogue actif Shopware avec ton stock Odoo. Repère les anomalies à corriger.</div>
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        <button onClick={runAudit} disabled={loading} style={{ padding: "10px 18px", background: C.blue, color: "#fff", border: "none", borderRadius: 10, fontWeight: 700, fontSize: 14, cursor: "pointer", opacity: loading ? 0.6 : 1 }}>
          {loading ? "Audit en cours…" : "Lancer l'audit"}
        </button>
      </div>
      {error && <div style={{ background: C.redSoft, border: "1px solid #fecaca", borderRadius: 10, padding: "10px 14px", color: C.red, fontSize: 13, marginBottom: 12 }}>{error}</div>}

      {rows.length > 0 && (
        <>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
            {FILTERS.map(f => (
              <button key={f.k} onClick={() => setFilter(f.k)} style={chip(filter === f.k)}>
                {f.label} ({counts[f.k]})
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="🔍 Rechercher une réf, code Odoo ou nom…"
              style={{ flex: 1, minWidth: 0, padding: "8px 12px", border: `1.5px solid ${C.border}`, borderRadius: 10, fontSize: 13, fontFamily: "inherit", background: C.white, color: C.text, outline: "none", boxSizing: "border-box" }} />
            {search && <button onClick={() => setSearch("")} style={{ padding: "8px 12px", background: C.white, border: `1.5px solid ${C.border}`, borderRadius: 10, fontSize: 12, cursor: "pointer", color: C.textMuted, fontFamily: "inherit" }}>✕</button>}
            <span style={{ fontSize: 12, color: C.textMuted, whiteSpace: "nowrap" }}>{visible.length} ligne{visible.length > 1 ? "s" : ""}</span>
          </div>

          {/* La reference cherchee n'est pas dans la liste : on interroge Shopware
              directement plutot que de conclure qu'elle n'existe pas. */}
          {search.trim() && visible.length === 0 && (
            <div style={{ background: C.white, border: `1.5px solid ${C.border}`, borderRadius: 12, padding: 14, marginBottom: 12 }}>
              <div style={{ fontSize: 13, color: C.textSec, marginBottom: 10, lineHeight: 1.5 }}>
                <strong>{search.trim()}</strong> n&apos;est pas dans le catalogue chargé par l&apos;audit.
                Cela ne veut pas dire qu&apos;elle n&apos;existe pas — interroge Shopware directement.
              </div>
              <button onClick={() => chercherDirect(search)} disabled={directLoading}
                style={{ padding: "9px 16px", background: directLoading ? "#cbd5e1" : C.blue, color: "#fff", border: "none",
                         borderRadius: 9, fontSize: 13, fontWeight: 700, cursor: directLoading ? "default" : "pointer", fontFamily: "inherit" }}>
                {directLoading ? "Recherche…" : "Chercher dans Shopware"}
              </button>

              {direct && (
                <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.border}` }}>
                  {!direct.found ? (
                    <div style={{ fontSize: 13, color: C.red }}>
                      Référence <strong>{direct.number}</strong> introuvable dans Shopware.
                    </div>
                  ) : (
                    <div style={{ display: "flex", gap: 16, flexWrap: "wrap" as const, alignItems: "center" }}>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{direct.number}</div>
                        <div style={{ fontSize: 12, color: C.textMuted }}>
                          {direct.name || "produit Odoo non rapproché"}{direct.odooRef ? ` · ${direct.odooRef}` : ""}
                        </div>
                      </div>
                      <div style={{ fontSize: 13 }}>
                        Stock Shopware <strong>{direct.sw ?? "?"}</strong>
                      </div>
                      <div style={{ fontSize: 13 }}>
                        Stock Odoo <strong>{direct.odoo ?? "?"}</strong>
                      </div>
                      {direct.odoo !== null && direct.sw !== null && direct.odoo !== direct.sw && (
                        <button onClick={async () => {
                            if (!confirm(`Écrire ${direct.odoo} sur Shopware pour ${direct.number} ?\n(actuel : ${direct.sw})`)) return;
                            try {
                              const r = await fetch(`/api/shopware-explore?action=setStock&articleNumber=${encodeURIComponent(direct.number)}&qty=${direct.odoo}`,
                                { headers: writeHeaders }).then(x => x.json());
                              if (r?.error) throw new Error(r.error);
                              onToast(`Stock Shopware mis à jour : ${direct.odoo}`, "success");
                              setDirect({ ...direct, sw: direct.odoo });
                            } catch (e: any) { onToast("Écriture refusée : " + (e?.message || e), "error"); }
                          }}
                          style={{ padding: "8px 14px", background: C.orange, color: "#fff", border: "none", borderRadius: 8,
                                   fontSize: 12.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                          Aligner Shopware sur Odoo
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden", boxShadow: C.shadow }}>
            <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
              <colgroup><col style={{ width: "11%" }} /><col style={{ width: "29%" }} /><col style={{ width: "11%" }} /><col style={{ width: "11%" }} /><col style={{ width: "12%" }} /><col style={{ width: "26%" }} /></colgroup>
              <thead><tr style={{ background: C.bg, fontSize: 10, fontWeight: 700, textTransform: "uppercase", color: C.textMuted, textAlign: "left" }}>
                <th style={th}>Réf</th><th style={th}>Produit Shopware</th><th style={th}>Stock SW</th><th style={th}>Stock Odoo</th><th style={th}>Emplac.</th><th style={th}>État / Action</th>
              </tr></thead>
              <tbody>
                {visible.map((r, i) => {
                  const c = cat(r);
                  const bg = c === "unmapped" ? C.redSoft : c === "noOdoo" ? "#fff7ed" : c === "swZeroOdooStock" ? C.blueSoft : C.white;
                  return (
                    <Fragment2 key={i}>
                      <tr style={{ borderTop: `1px solid ${C.border}`, fontSize: 13, verticalAlign: "top", background: bg }}>
                        <td style={{ ...td, fontFamily: "monospace", fontWeight: 700 }}>{r.number}</td>
                        <td style={td}>{r.nameSW}</td>
                        <td style={{ ...td, fontWeight: 800 }}>{r.inStock ?? "—"}</td>
                        <td style={{ ...td, fontWeight: 800 }}>{r.mapped ? (r.odoo ?? 0) : "—"}</td>
                        <td style={td}>
                          {(() => {
                            const loc = binMap[String(r.detailId)];
                            return loc
                              ? <span style={{ fontFamily: "monospace", fontWeight: 700, fontSize: 12, color: C.text }}>{loc.code}</span>
                              : <span style={{ fontSize: 10.5, color: C.orange, fontWeight: 700 }}>sans empl.</span>;
                          })()}
                        </td>
                        <td style={td}>
                          {c === "unmapped" ? <span style={{ color: C.red, fontWeight: 700, fontSize: 11 }}>non mappé</span>
                            : c === "noOdoo" ? <span style={{ color: C.orange, fontWeight: 700, fontSize: 11 }}>pas de stock Odoo</span>
                            : c === "swZeroOdooStock" ? <span style={{ color: C.blue, fontWeight: 700, fontSize: 11 }}>0 sur SW, stock Odoo</span>
                            : <span style={{ color: C.green, fontWeight: 700, fontSize: 11 }}>✓ ok</span>}
                          <button onClick={() => { setFixRef(fixRef === r.number ? null : r.number); setFixQuery(""); setFixResults([]); }}
                            style={{ background: "none", border: "none", cursor: "pointer", color: C.blue, fontSize: 11, fontWeight: 700, padding: "0 0 0 8px", fontFamily: "inherit" }}>
                            {fixRef === r.number ? "fermer" : "mapper"}
                          </button>
                          <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 5 }}>
                            {r.mapped && (
                              <button onClick={() => pushStock(r)} disabled={pushing === r.number}
                                style={{ padding: "4px 10px", background: C.green, color: "#fff", border: "none", borderRadius: 7, fontSize: 11, fontWeight: 800, cursor: "pointer", fontFamily: "inherit", opacity: pushing === r.number ? 0.6 : 1, alignSelf: "flex-start" }}>
                                {pushing === r.number ? "…" : `MAJ stock Odoo → ${r.odoo ?? 0}`}
                              </button>
                            )}
                            {/* MAJ valeur libre — dispo même pour les non mappés */}
                            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                              <input type="number" min={0} value={freeVal[r.number] ?? ""}
                                onChange={e => setFreeVal(prev => ({ ...prev, [r.number]: e.target.value }))}
                                placeholder="valeur"
                                style={{ width: 64, padding: "4px 6px", border: `1.5px solid ${C.border}`, borderRadius: 6, fontSize: 11, fontFamily: "inherit", boxSizing: "border-box" }} />
                              <button
                                onClick={() => { const v = parseInt(freeVal[r.number] ?? "", 10); if (Number.isNaN(v)) { onToast("Saisis une valeur", "error"); return; } pushStock(r, v); }}
                                disabled={pushing === r.number || (freeVal[r.number] ?? "") === ""}
                                style={{ padding: "4px 10px", background: C.blue, color: "#fff", border: "none", borderRadius: 7, fontSize: 11, fontWeight: 800, cursor: "pointer", fontFamily: "inherit", opacity: pushing === r.number || (freeVal[r.number] ?? "") === "" ? 0.5 : 1 }}>
                                MAJ libre →
                              </button>
                            </div>
                            {pushed[r.number] && (
                              pushed[r.number].hasLocation
                                ? <div style={{ fontSize: 10.5, color: C.green, fontWeight: 700 }}>✓ {pushed[r.number].newStock} · empl. {pushed[r.number].locCode}</div>
                                : <div style={{ fontSize: 10.5, color: C.orange, fontWeight: 800 }}>⚠ {pushed[r.number].newStock} · SANS emplacement — ranger dans Pickware</div>
                            )}
                          </div>
                        </td>
                      </tr>
                      {fixRef === r.number && (
                        <tr style={{ background: "#f8fafc" }}>
                          <td colSpan={6} style={{ padding: "10px 12px" }}>
                            <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                              <button onClick={() => markChariot(r.number)} style={{ padding: "6px 12px", background: C.orangeSoft, color: C.orange, border: `1px solid ${C.orange}`, borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>→ Chariot eShop</button>
                              <button onClick={() => markService(r.number)} style={{ padding: "6px 12px", background: "#ede9fe", color: C.purple, border: `1px solid ${C.purple}`, borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>→ Service (carte cadeau…)</button>
                            </div>
                            <input value={fixQuery} onChange={e => { setFixQuery(e.target.value); searchOdoo(e.target.value); }}
                              placeholder="OU chercher le produit Odoo à associer…" autoFocus
                              style={{ width: "100%", boxSizing: "border-box", padding: "8px 10px", border: `1.5px solid ${C.border}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", marginBottom: 6 }} />
                            {fixResults.map((x: any, k: number) => (
                              <button key={k} onClick={() => applyFix(r.number, x.data)}
                                style={{ display: "block", width: "100%", textAlign: "left", padding: "7px 10px", background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 4, cursor: "pointer", fontFamily: "inherit", fontSize: 12.5 }}>
                                <b style={{ fontFamily: "monospace" }}>{x.data.default_code || "—"}</b> · {x.data.name}
                              </button>
                            ))}
                          </td>
                        </tr>
                      )}
                    </Fragment2>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
//  Onglet Renvoi — duplique une commande Shopware existante (renvoi gratuit)
//  Utile quand un colis est perdu/retourné : recrée la commande (mêmes lignes,
//  même client) à 0€ pour qu'elle remonte normalement dans le flux e-shop → SendCloud.
// ════════════════════════════════════════════════════════════════
interface ResendRow {
  number: string;
  status: "idle" | "loading" | "done" | "error";
  message?: string;
  newOrderId?: number;
  newOrderNumber?: string;
}
function ResendTab({ onToast }: { onToast: Props["onToast"] }) {
  const [input, setInput] = useState("");
  const [rows, setRows] = useState<ResendRow[]>([]);

  // ── Renvoi partiel : on choisit les articles au lieu de tout dupliquer ──────
  // Quantités À ZÉRO par défaut : on ne renvoie que ce qu'on monte explicitement.
  const [pick, setPick] = useState<null | {
    number: string; customer: string; city: string;
    lines: { articleNumber: string; articleName: string; quantity: number }[];
    qty: Record<string, number>;                     // réf → qté à renvoyer
    extra: { articleNumber: string; articleName: string; qty: number }[]; // articles ajoutés
  }>(null);
  const [pickLoading, setPickLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [addRef, setAddRef] = useState("");
  const [addBusy, setAddBusy] = useState(false);

  const openPicker = async (number: string) => {
    const n = number.trim();
    if (!n) return;
    setPickLoading(true);
    try {
      const r = await fetch(`/api/shopware-explore?action=orderLines&number=${encodeURIComponent(n)}`).then(x => x.json());
      if (!r.ok) { onToast(r.error || "Commande introuvable", "error"); setPickLoading(false); return; }
      setPick({
        number: r.number || n, customer: r.customer || "", city: r.city || "",
        lines: r.lines || [], qty: {}, extra: [],
      });
      setInput("");
    } catch (e: any) { onToast("Erreur : " + e.message, "error"); }
    setPickLoading(false);
  };

  const setQty = (ref: string, v: number, max: number) => {
    const q = Math.max(0, Math.min(max, v));
    setPick(p => p ? { ...p, qty: { ...p.qty, [ref]: q } } : p);
  };

  const addArticle = async () => {
    const ref = addRef.trim();
    if (!ref || !pick) return;
    if (pick.lines.some(l => l.articleNumber === ref) || pick.extra.some(e => e.articleNumber === ref)) {
      onToast("Cette référence est déjà dans la liste", "info"); return;
    }
    setAddBusy(true);
    try {
      const r = await fetch(`/api/shopware-explore?action=lookupArticle&articleNumber=${encodeURIComponent(ref)}`).then(x => x.json());
      if (!r.ok) { onToast(r.error || "Référence introuvable", "error"); setAddBusy(false); return; }
      setPick(p => p ? { ...p, extra: [...p.extra, { articleNumber: r.articleNumber, articleName: r.articleName, qty: 1 }] } : p);
      setAddRef("");
    } catch (e: any) { onToast("Erreur : " + e.message, "error"); }
    setAddBusy(false);
  };

  const totalPicked = pick
    ? Object.values(pick.qty).reduce((s, n) => s + n, 0) + pick.extra.reduce((s, e) => s + e.qty, 0)
    : 0;

  const createPartial = async () => {
    if (!pick || !totalPicked) return;
    const only = Object.entries(pick.qty).filter(([, q]) => q > 0).map(([r, q]) => `${r}:${q}`).join(",");
    const add  = pick.extra.filter(e => e.qty > 0).map(e => `${e.articleNumber}:${e.qty}`).join(",");
    const lignes = [
      ...Object.entries(pick.qty).filter(([, q]) => q > 0).map(([r, q]) => `${r} ×${q}`),
      ...pick.extra.filter(e => e.qty > 0).map(e => `${e.articleNumber} ×${e.qty} (ajouté)`),
    ];
    if (!confirm(`Créer un renvoi gratuit (0 €) depuis la commande ${pick.number} ?\n\n${lignes.join("\n")}\n\nUne NOUVELLE commande Shopware sera créée.`)) return;
    setCreating(true);
    try {
      // `only` est TOUJOURS envoyé, même vide : sinon le serveur retombe sur son
      // comportement historique et duplique la commande entière — c'est ce qui
      // arrivait quand on ajoutait un article sans monter aucune quantité.
      const qs = new URLSearchParams({ action: "duplicateOrder", number: pick.number, only });
      if (add) qs.set("add", add);
      const res = await fetch(`/api/shopware-explore?${qs.toString()}`, { headers: writeHeaders }).then(x => x.json());
      if (res.ok) {
        const label = res.newOrderNumber ? `n° ${res.newOrderNumber}` : `id ${res.newOrderId ?? "?"}`;
        onToast(`✓ Renvoi créé (${label})`, "success");
        setRows(prev => [...prev, { number: pick.number, status: "done", newOrderId: res.newOrderId, newOrderNumber: res.newOrderNumber, message: `Renvoi partiel créé (${label})` }]);
        setPick(null);
      } else onToast("Erreur : " + (res.error || "échec"), "error");
    } catch (e: any) { onToast("Erreur : " + e.message, "error"); }
    setCreating(false);
  };
  const [diag, setDiag] = useState<{ loading: boolean; scanned: number; matches: any[] } | null>(null);
  const [diagNumbers, setDiagNumbers] = useState("");

  const runDiagnostic = async () => {
    setDiag({ loading: true, scanned: 0, matches: [] });
    try {
      const nums = diagNumbers.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
      const url = nums.length
        ? `/api/shopware-explore?action=findDuplicates&numbers=${encodeURIComponent(nums.join(","))}`
        : `/api/shopware-explore?action=findDuplicates`;
      const res = await fetch(url).then(x => x.json());
      setDiag({ loading: false, scanned: res.scanned || 0, matches: res.matches || [] });
    } catch (e: any) {
      onToast("Erreur diagnostic : " + e.message, "error");
      setDiag(null);
    }
  };

  // Annule un duplicata de test (montant 0€ uniquement, refusé côté serveur sinon).
  // La suppression pure n'est pas possible (bloquée côté serveur + bug Shopware 5) : on passe
  // la commande au statut "Annulée" à la place — elle reste visible mais clairement neutralisée.
  const [deleting, setDeleting] = useState<string | null>(null);
  const deleteDuplicate = async (m: { number: string; invoiceAmount: number; number_label?: string }) => {
    if (!confirm(`Annuler la commande n° ${m.number} (montant ${m.invoiceAmount}€) ?\nElle passera au statut "Annulée" dans Shopware (la suppression définitive n'est pas possible via l'API).`)) return;
    setDeleting(m.number);
    try {
      const res = await fetch(`/api/shopware-explore?action=cancelOrder&number=${encodeURIComponent(m.number)}`, { headers: writeHeaders }).then(x => x.json());
      if (res.ok) {
        onToast(`✓ Commande ${m.number} annulée`, "success");
        setDiag(prev => prev ? { ...prev, matches: prev.matches.filter((x: any) => x.number !== m.number) } : prev);
      } else {
        onToast("Erreur : " + (res.error || "échec"), "error");
      }
    } catch (e: any) {
      onToast("Erreur : " + e.message, "error");
    }
    setDeleting(null);
  };

  const addNumbers = () => {
    const nums = input.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
    if (!nums.length) return;
    setRows(prev => {
      const existing = new Set(prev.map(r => r.number));
      const toAdd = nums.filter(n => !existing.has(n)).map(n => ({ number: n, status: "idle" as const }));
      return [...prev, ...toAdd];
    });
    setInput("");
  };

  const removeRow = (number: string) => setRows(prev => prev.filter(r => r.number !== number));

  const duplicateOne = async (number: string) => {
    setRows(prev => prev.map(r => r.number === number ? { ...r, status: "loading", message: undefined } : r));
    try {
      const res = await fetch(`/api/shopware-explore?action=duplicateOrder&number=${encodeURIComponent(number)}`, { headers: writeHeaders }).then(x => x.json());
      if (res.ok) {
        const label = res.newOrderNumber ? `n° ${res.newOrderNumber}` : `id interne ${res.newOrderId ?? "?"}`;
        setRows(prev => prev.map(r => r.number === number ? { ...r, status: "done", newOrderId: res.newOrderId, newOrderNumber: res.newOrderNumber, message: `Nouvelle commande créée (${label})` } : r));
        onToast(`✓ ${number} dupliquée → ${label}`, "success");
      } else {
        setRows(prev => prev.map(r => r.number === number ? { ...r, status: "error", message: res.error || "échec" } : r));
        onToast(`Erreur ${number} : ${res.error || "échec"}`, "error");
      }
    } catch (e: any) {
      setRows(prev => prev.map(r => r.number === number ? { ...r, status: "error", message: e.message } : r));
      onToast("Erreur : " + e.message, "error");
    }
  };

  const duplicateAll = async () => {
    const pending = rows.filter(r => r.status === "idle" || r.status === "error");
    if (!pending.length) return;
    if (!confirm(`Dupliquer ${pending.length} commande(s) en renvoi gratuit (0€) ? Chaque duplicata créera une NOUVELLE commande Shopware avec les mêmes articles.`)) return;
    for (const r of pending) await duplicateOne(r.number);
  };

  return (
    <div style={{ paddingBottom: 80 }}>
      <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 12, lineHeight: 1.6 }}>
        Un renvoi crée une <strong>nouvelle commande Shopware à 0 €</strong>, sur le même client.
        Elle remonte normalement dans Shopware → SendCloud, où tu génères l&apos;étiquette comme d&apos;habitude.
        Le stock est bien décrémenté : ce n&apos;est pas un envoi fictif.
      </div>

      {/* ── Renvoi partiel : choisir les articles ─────────────────────────── */}
      <div style={{ background: C.white, border: `1.5px solid ${C.blue}`, borderRadius: 12, padding: 14, marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
          <span style={{ fontSize: 10, fontWeight: 800, color: "#fff", background: C.blue, borderRadius: 5, padding: "2px 6px" }}>1</span>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>Renvoyer une partie d&apos;une commande</div>
          <span style={{ fontSize: 10, fontWeight: 700, color: C.blue, background: C.blueSoft, borderRadius: 5, padding: "2px 7px" }}>le plus courant</span>
        </div>
        <div style={{ fontSize: 11.5, color: C.textMuted, marginBottom: 10, lineHeight: 1.5 }}>
          Pour renvoyer <strong>seulement certains articles</strong> : un produit cassé, oublié ou remplacé.
          Les quantités partent à zéro, tu montes celles que tu veux. Tu peux ajouter une référence absente de la commande.
        </div>

        {!pick ? (
          <div style={{ display: "flex", gap: 8 }}>
            <input value={input} onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") openPicker(input); }}
              placeholder="Numéro de commande — ex : ECDE2644068"
              style={{ flex: 1, padding: "9px 12px", border: `1.5px solid ${C.border}`, borderRadius: 9, fontSize: 13, fontFamily: "inherit" }} />
            <button onClick={() => openPicker(input)} disabled={pickLoading || !input.trim()}
              style={{ padding: "9px 16px", background: pickLoading || !input.trim() ? "#cbd5e1" : C.blue, color: "#fff", border: "none", borderRadius: 9, fontWeight: 700, fontSize: 13, cursor: pickLoading || !input.trim() ? "default" : "pointer", whiteSpace: "nowrap" }}>
              {pickLoading ? "…" : "Voir les articles"}
            </button>
          </div>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, paddingBottom: 8, borderBottom: `1px solid ${C.border}` }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 800, color: C.text }}>{pick.number}</div>
                <div style={{ fontSize: 11.5, color: C.textMuted }}>{[pick.customer, pick.city].filter(Boolean).join(" · ") || "—"}</div>
              </div>
              <button onClick={() => setPick(null)}
                style={{ background: "none", border: `1px solid ${C.border}`, borderRadius: 8, padding: "5px 11px", fontSize: 12, color: C.textMuted, cursor: "pointer", fontFamily: "inherit" }}>
                Changer
              </button>
            </div>

            {pick.lines.map(l => {
              const q = pick.qty[l.articleNumber] ?? 0;
              return (
                <div key={l.articleNumber} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0", borderBottom: `1px solid ${C.border}` }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, color: q > 0 ? C.text : C.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.articleName}</div>
                    <div style={{ fontSize: 11, color: C.textMuted, fontFamily: "monospace" }}>{l.articleNumber} · commandé ×{l.quantity}</div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
                    <button onClick={() => setQty(l.articleNumber, q - 1, l.quantity)} disabled={q <= 0}
                      style={{ width: 28, height: 28, borderRadius: 7, border: `1px solid ${C.border}`, background: C.white, cursor: q <= 0 ? "default" : "pointer", fontSize: 15, fontWeight: 700, color: q <= 0 ? "#cbd5e1" : C.text }}>−</button>
                    <span style={{ minWidth: 26, textAlign: "center", fontSize: 14, fontWeight: 800, color: q > 0 ? C.blue : "#cbd5e1" }}>{q}</span>
                    <button onClick={() => setQty(l.articleNumber, q + 1, l.quantity)} disabled={q >= l.quantity}
                      style={{ width: 28, height: 28, borderRadius: 7, border: `1px solid ${C.border}`, background: C.white, cursor: q >= l.quantity ? "default" : "pointer", fontSize: 15, fontWeight: 700, color: q >= l.quantity ? "#cbd5e1" : C.text }}>+</button>
                  </div>
                </div>
              );
            })}

            {pick.extra.map(e => (
              <div key={e.articleNumber} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0", borderBottom: `1px solid ${C.border}`, background: C.greenSoft }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.articleName}</div>
                  <div style={{ fontSize: 11, color: C.green, fontFamily: "monospace" }}>{e.articleNumber} · ajouté</div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
                  <button onClick={() => setPick(p => p ? { ...p, extra: p.extra.map(x => x.articleNumber === e.articleNumber ? { ...x, qty: Math.max(1, x.qty - 1) } : x) } : p)}
                    style={{ width: 28, height: 28, borderRadius: 7, border: `1px solid ${C.border}`, background: C.white, cursor: "pointer", fontSize: 15, fontWeight: 700 }}>−</button>
                  <span style={{ minWidth: 26, textAlign: "center", fontSize: 14, fontWeight: 800, color: C.green }}>{e.qty}</span>
                  <button onClick={() => setPick(p => p ? { ...p, extra: p.extra.map(x => x.articleNumber === e.articleNumber ? { ...x, qty: x.qty + 1 } : x) } : p)}
                    style={{ width: 28, height: 28, borderRadius: 7, border: `1px solid ${C.border}`, background: C.white, cursor: "pointer", fontSize: 15, fontWeight: 700 }}>+</button>
                  <button onClick={() => setPick(p => p ? { ...p, extra: p.extra.filter(x => x.articleNumber !== e.articleNumber) } : p)}
                    title="Retirer" style={{ marginLeft: 2, background: "none", border: "none", color: C.red, cursor: "pointer", fontSize: 14, fontWeight: 700 }}>✕</button>
                </div>
              </div>
            ))}

            {/* Ajouter une référence absente de la commande */}
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <input value={addRef} onChange={e => setAddRef(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") addArticle(); }}
                placeholder="Ajouter une référence absente de la commande…"
                style={{ flex: 1, padding: "8px 11px", border: `1.5px solid ${C.border}`, borderRadius: 9, fontSize: 12.5, fontFamily: "inherit" }} />
              <button onClick={addArticle} disabled={addBusy || !addRef.trim()}
                style={{ padding: "8px 14px", background: addBusy || !addRef.trim() ? "#cbd5e1" : C.text, color: "#fff", border: "none", borderRadius: 9, fontWeight: 700, fontSize: 12.5, cursor: addBusy || !addRef.trim() ? "default" : "pointer", whiteSpace: "nowrap" }}>
                {addBusy ? "…" : "+ Ajouter"}
              </button>
            </div>

            <button onClick={createPartial} disabled={creating || !totalPicked}
              style={{ width: "100%", marginTop: 12, padding: "12px 0", background: creating || !totalPicked ? "#e5e7eb" : C.green, color: creating || !totalPicked ? C.textMuted : "#fff", border: "none", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: creating || !totalPicked ? "default" : "pointer", fontFamily: "inherit" }}>
              {creating ? "Création…" : totalPicked ? `Créer le renvoi — ${totalPicked} article${totalPicked > 1 ? "s" : ""}` : "Sélectionne au moins un article"}
            </button>
          </>
        )}
      </div>

      {/* Diagnostic (lecture seule) : retrouve les duplicatas déjà créés, sans rien recréer */}
      <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 12, padding: 14, marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
          <span style={{ fontSize: 10, fontWeight: 800, color: C.textMuted, background: C.bg, borderRadius: 5, padding: "2px 6px" }}>2</span>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>Vérifier qu&apos;un renvoi existe déjà</div>
          <span style={{ fontSize: 10, fontWeight: 700, color: C.green, background: C.greenSoft, borderRadius: 5, padding: "2px 7px" }}>ne crée rien</span>
        </div>
        <div style={{ fontSize: 11.5, color: C.textMuted, marginBottom: 9, lineHeight: 1.5 }}>
          Avant de recréer un renvoi, contrôle qu&apos;il n&apos;a pas déjà été fait — ça évite les doublons.
          Laisse vide pour balayer les 50 dernières commandes, ou saisis des numéros précis.
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: diag ? 8 : 0 }}>
          <input value={diagNumbers} onChange={e => setDiagNumbers(e.target.value)} onKeyDown={e => { if (e.key === "Enter") runDiagnostic(); }}
            placeholder="Numéros précis (optionnel) — ex: ECDE2643786, ECDE2643787"
            style={{ flex: 1, padding: "7px 10px", border: `1.5px solid ${C.border}`, borderRadius: 8, fontSize: 12.5, fontFamily: "inherit" }} />
          <button onClick={runDiagnostic} disabled={diag?.loading}
            style={{ padding: "7px 14px", background: C.blue, color: "#fff", border: "none", borderRadius: 8, fontWeight: 700, fontSize: 12, cursor: "pointer", opacity: diag?.loading ? 0.6 : 1, whiteSpace: "nowrap" }}>
            {diag?.loading ? "Scan…" : "🔍 Diagnostic"}
          </button>
        </div>
        {diag && !diag.loading && (
          diag.matches.length === 0 ? (
            <div style={{ fontSize: 12.5, color: C.textMuted }}>{diag.scanned} commande(s) scannée(s) — aucun duplicata trouvé.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {diag.matches.map((m, i) => (
                <div key={i} style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 10px", fontSize: 12, display: "flex", alignItems: "flex-start", gap: 10 }}>
                  <div style={{ flex: 1 }}>
                    <div><strong style={{ fontFamily: "monospace" }}>n° {m.number}</strong> (id {m.id}) — {m.detailsCount} ligne(s) — {m.orderTime}</div>
                    <div style={{ color: C.textMuted, marginTop: 2 }}>{m.internalComment}</div>
                    <div style={{ color: C.textMuted, marginTop: 2 }}>orderStatusId {m.orderStatusId} · paymentStatusId {m.paymentStatusId} · montant {m.invoiceAmount}€</div>
                  </div>
                  {Number(m.invoiceAmount) === 0 && m.orderStatusId !== -1 && (
                    <button onClick={() => deleteDuplicate(m)} disabled={deleting === m.number}
                      style={{ padding: "6px 12px", background: C.red, color: "#fff", border: "none", borderRadius: 8, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", opacity: deleting === m.number ? 0.6 : 1, whiteSpace: "nowrap" }}>
                      {deleting === m.number ? "…" : "🚫 Annuler"}
                    </button>
                  )}
                  {m.orderStatusId === -1 && (
                    <span style={{ fontSize: 11, color: C.textMuted, fontWeight: 700, whiteSpace: "nowrap" }}>déjà annulée</span>
                  )}
                </div>
              ))}
            </div>
          )
        )}
      </div>

      <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 12, padding: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
          <span style={{ fontSize: 10, fontWeight: 800, color: C.textMuted, background: C.bg, borderRadius: 5, padding: "2px 6px" }}>3</span>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>Renvoyer des commandes entières</div>
        </div>
        <div style={{ fontSize: 11.5, color: C.textMuted, marginBottom: 10, lineHeight: 1.5 }}>
          Pour renvoyer <strong>tout le contenu</strong> d&apos;une ou plusieurs commandes — typiquement un colis
          perdu par le transporteur. Ajoute les numéros, puis lance la duplication.
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter") addNumbers(); }}
            placeholder="Un ou plusieurs numéros, séparés par un espace ou une virgule"
            style={{ flex: 1, padding: "9px 12px", border: `1.5px solid ${C.border}`, borderRadius: 10, fontSize: 13.5, fontFamily: "inherit" }} />
          <button onClick={addNumbers} style={{ padding: "9px 16px", background: C.text, color: "#fff", border: "none", borderRadius: 10, fontWeight: 700, fontSize: 13.5, cursor: "pointer", whiteSpace: "nowrap" }}>+ Ajouter</button>
        </div>

      {rows.length === 0 ? (
        <div style={{ textAlign: "center", color: C.textMuted, padding: "26px 0", fontSize: 12.5 }}>Aucune commande dans la liste</div>
      ) : (
        <>
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10 }}>
            <button onClick={duplicateAll} style={{ padding: "9px 16px", background: C.green, color: "#fff", border: "none", borderRadius: 10, fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
              Dupliquer tout ({rows.filter(r => r.status === "idle" || r.status === "error").length})
            </button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {rows.map((r, i) => (
              <div key={i} style={{
                border: `1px solid ${r.status === "error" ? "#fecaca" : r.status === "done" ? "#bbf7d0" : C.border}`,
                background: r.status === "error" ? C.redSoft : r.status === "done" ? C.greenSoft : C.white,
                borderRadius: 10, padding: "10px 12px", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
              }}>
                <span style={{ fontFamily: "monospace", fontWeight: 800, fontSize: 13, color: C.text }}>{r.number}</span>
                <span style={{ fontSize: 12, flex: 1, color: r.status === "error" ? C.red : r.status === "done" ? C.green : C.textMuted }}>
                  {r.status === "idle" && "En attente"}
                  {r.status === "loading" && "Duplication en cours…"}
                  {r.status === "done" && (r.message || "✓ dupliquée")}
                  {r.status === "error" && (r.message || "Erreur")}
                </span>
                {(r.status === "idle" || r.status === "error") && (
                  <button onClick={() => duplicateOne(r.number)} style={{ padding: "6px 12px", background: C.blue, color: "#fff", border: "none", borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                    Dupliquer
                  </button>
                )}
                <button onClick={() => removeRow(r.number)} style={{ background: "none", border: "none", cursor: "pointer", color: C.textMuted, fontSize: 16 }}>×</button>
              </div>
            ))}
          </div>
        </>
      )}
      </div>
    </div>
  );
}

function chip(active: boolean): React.CSSProperties {
  return { padding: "5px 12px", borderRadius: 8, border: `1.5px solid ${active ? "#2563eb" : "#e5e7eb"}`, background: active ? "#eff6ff" : "#fff", color: active ? "#2563eb" : "#374151", fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "inherit" };
}
function badge(bg: string, color: string): React.CSSProperties {
  return { background: bg, color, borderRadius: 8, padding: "6px 12px", fontWeight: 700, fontSize: 13 };
}

// ════════════════════════════════════════════════════════════════
//  Onglet Réappro chariot
//  Le chariot e-shop est un stock qui vit dans Shopware, hors Odoo.
//  Processus : le service client crée la commande e-shop dans Odoo, les
//  préparateurs la préparent et posent physiquement les articles sur le chariot.
//  Ici, ils scannent le numéro S de cette commande : le WMS valide la sortie
//  Odoo, incrémente le stock chariot et met Shopware à jour — sans qu'ils aient
//  à faire le moindre rapprochement de références.
// ════════════════════════════════════════════════════════════════
interface ReapproLine {
  productId: number; defaultCode: string; name: string; qty: number;
  sku: string | null;        // SKU chariot correspondant (null = non rattaché)
  swBefore: number | null;   // stock chariot avant
}

function ReapproChariotTab({ session, onToast, active }: { session: odoo.OdooSession; onToast: Props["onToast"]; active: boolean }) {
  const [ref, setRef] = useState("");
  const [loading, setLoading] = useState(false);
  const [validating, setValidating] = useState(false);
  const [found, setFound] = useState<null | {
    orderName: string; pickingId: number; pickingName: string; lines: ReapproLine[];
  }>(null);
  const [done, setDone] = useState<null | { picking: string; pushed: number; failed: string[] }>(null);

  // Rapprochement produit Odoo → SKU chariot, fait UNE fois et gardé en mémoire.
  const skuByProduct = useRef<Map<number, string> | null>(null);
  const buildSkuMap = async (): Promise<Map<number, string>> => {
    if (skuByProduct.current) return skuByProduct.current;
    const map = new Map<number, string>();
    try {
      const skus = await odoo.loadChariotSkus(session);
      if (skus.length) {
        const [matches, ov] = await Promise.all([
          odoo.matchEshopSkus(session, skus),
          getEshopMappingOverrides().catch(() => ({} as EshopMappingOverrides)),
        ]);
        // Détection automatique d'abord…
        for (const [sku, m] of Object.entries(matches)) {
          const pid = (m as any)?.product_id;
          if (pid && !map.has(pid)) map.set(pid, sku);
        }
        // …puis les rattachements MANUELS, qui priment (mêmes overrides que
        // l'audit catalogue et la config chariot). Sans ça, une correction faite
        // à la main n'aurait aucun effet sur le réappro.
        for (const sku of skus) {
          const o = ov[sku];
          if (o?.productId) map.set(o.productId, sku);
        }
      }
    } catch { /* on renverra des lignes non rattachées, signalées à l'écran */ }
    skuByProduct.current = map;
    return map;
  };

  const search = async (raw?: string) => {
    const q = (raw ?? ref).trim();
    if (!q || loading) return;
    setLoading(true); setDone(null);
    try {
      const [r, map, stock] = await Promise.all([
        odoo.findChariotReappro(session, q),
        buildSkuMap(),
        (await import("@/lib/supabase")).getChariotStock(),
      ]);
      setFound({
        orderName: r.orderName, pickingId: r.pickingId, pickingName: r.pickingName,
        lines: r.lines.map(l => {
          const sku = map.get(l.productId) || null;
          return { ...l, sku, swBefore: sku ? (stock[sku] ?? 0) : null };
        }),
      });
      setRef("");
    } catch (e: any) { onToast(e.message || "Commande introuvable", "error"); setFound(null); }
    setLoading(false);
  };

  // Écouteur actif UNIQUEMENT quand l'onglet est visible : les onglets restent
  // montés (display:none), sans ce garde un scan fait ailleurs déclencherait
  // une recherche de réappro.
  useScannerListener(useCallback((code: string) => { setRef(code); search(code); }, [loading, ref]), active);

  const unmatched = found ? found.lines.filter(l => !l.sku) : [];
  const matched   = found ? found.lines.filter(l => l.sku) : [];

  // ── Rattacher un article au chariot SANS quitter l'écran ────────────────────
  // Cas critique : un article devrait aller sur le chariot mais n'y est pas
  // encore déclaré. Si on validait tel quel, il sortirait du stock Odoo sans
  // jamais arriver sur le chariot — et le bon étant validé, impossible de
  // recommencer. On permet donc de le rattacher AVANT validation.
  const [addFor, setAddFor] = useState<number | null>(null);  // productId en cours
  const [addSku, setAddSku] = useState("");
  const [addBusy2, setAddBusy2] = useState(false);

  const attachToChariot = async (line: ReapproLine) => {
    const sku = addSku.trim();
    if (!sku || addBusy2) return;
    setAddBusy2(true);
    try {
      // 1. La référence Shopware doit exister — sinon on ne déclare rien.
      const chk = await fetch(`/api/shopware-explore?action=lookupArticle&articleNumber=${encodeURIComponent(sku)}`).then(x => x.json());
      if (!chk.ok) { onToast(chk.error || `Référence ${sku} introuvable dans Shopware`, "error"); setAddBusy2(false); return; }
      const sb = await import("@/lib/supabase");
      // 2. Déclarer le SKU comme article du chariot
      await odoo.addChariotSku(session, sku);
      // 3. Fixer la correspondance avec CE produit Odoo (mapping manuel, prioritaire)
      await sb.saveEshopMappingOverride(sku, line.productId, line.defaultCode || "", line.name || "");
      // 4. Rafraîchir l'écran : la ligne bascule côté « rattaché »
      skuByProduct.current = null;                       // le cache doit être refait
      const stock = await sb.getChariotStock();
      setFound(prev => prev ? {
        ...prev,
        lines: prev.lines.map(l => l.productId === line.productId
          ? { ...l, sku, swBefore: stock[sku] ?? 0 } : l),
      } : prev);
      setAddFor(null); setAddSku("");
      onToast(`✓ ${line.defaultCode || line.name} rattaché à ${sku}`, "success");
    } catch (e: any) {
      onToast("Erreur : " + (e.message || "échec"), "error");
    }
    setAddBusy2(false);
  };

  const validate = async () => {
    if (!found || validating || !matched.length) return;
    const recap = matched.map(l => `${l.defaultCode || l.name} ×${l.qty}`).join("\n");
    // Les articles ignorés sont rappelés NOMMÉMENT : après validation le bon est
    // consommé, ils ne pourront plus être rattachés ni rejoués.
    const skipped = unmatched.length
      ? `\n\n⚠ IGNORÉS — ils ne seront PAS mis sur le chariot :\n${unmatched.map(l => `${l.defaultCode || l.name} ×${l.qty}`).join("\n")}\n\nSi l'un d'eux doit y aller, annule et rattache-le d'abord : ce sera irrattrapable ensuite.`
      : "";
    if (!confirm(`Valider le réappro chariot ?\n\n${recap}${skipped}\n\n· Sortie Odoo ${found.pickingName} validée\n· Stock chariot incrémenté\n· Shopware mis à jour`)) return;
    setValidating(true);
    try {
      const sb = await import("@/lib/supabase");
      // 1. Sortie Odoo — si elle échoue, on n'écrit RIEN ailleurs.
      await odoo.validatePicking(session, found.pickingId);
      // 2. Stock chariot
      const { stock } = await sb.incrementChariotStock(matched.map(l => ({ sku: l.sku!, qty: l.qty })));
      // 3. Shopware
      const failed: string[] = [];
      for (const l of matched) {
        try {
          const r = await fetch(`/api/shopware-explore?action=setStock&articleNumber=${encodeURIComponent(l.sku!)}&qty=${stock[l.sku!] ?? 0}`,
                                { headers: writeHeaders }).then(x => x.json());
          if (!r.ok) failed.push(`${l.sku} : ${r.error || "échec"}`);
        } catch (e: any) { failed.push(`${l.sku} : ${e.message}`); }
      }
      setDone({ picking: found.pickingName, pushed: matched.length - failed.length, failed });
      setFound(null);
      if (failed.length) onToast(`⚠ Réappro fait, mais ${failed.length} envoi(s) Shopware en échec`, "error");
      else onToast(`✓ Réappro validé — ${matched.length} article(s) sur le chariot`, "success");
    } catch (e: any) {
      onToast("Erreur : " + (e.message || "échec"), "error");
    }
    setValidating(false);
  };

  return (
    <div style={{ paddingBottom: 80 }}>
      <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 12, lineHeight: 1.6 }}>
        Le chariot e-shop est un stock qui vit dans <strong>Shopware</strong>, en dehors d&apos;Odoo.
        Une fois les articles physiquement posés sur le chariot, scanne le <strong>numéro S</strong> de
        la commande e-shop correspondante : la sortie Odoo est validée, le stock chariot augmenté et
        Shopware mis à jour. Aucun rapprochement de référence à faire à la main.
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        <input value={ref} onChange={e => setRef(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") search(); }}
          placeholder="Scanne ou saisis le numéro S — ex : S71596"
          style={{ flex: 1, padding: "11px 13px", border: `1.5px solid ${C.border}`, borderRadius: 10, fontSize: 14, fontFamily: "inherit", fontWeight: 600 }} />
        <button onClick={() => search()} disabled={loading || !ref.trim()}
          style={{ padding: "11px 18px", background: loading || !ref.trim() ? "#cbd5e1" : C.blue, color: "#fff", border: "none", borderRadius: 10, fontWeight: 700, fontSize: 14, cursor: loading || !ref.trim() ? "default" : "pointer" }}>
          {loading ? "…" : "→"}
        </button>
      </div>

      {done && (
        <div style={{ background: C.greenSoft, border: `1px solid #6ee7b7`, borderRadius: 12, padding: 16, marginBottom: 14 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.green, marginBottom: 4 }}>✓ Réappro terminé</div>
          <div style={{ fontSize: 12.5, color: "#065f46" }}>
            Sortie {done.picking} validée · {done.pushed} article(s) mis à jour dans Shopware
          </div>
          {done.failed.length > 0 && (
            <div style={{ marginTop: 8, fontSize: 12, color: C.red }}>
              <strong>À reprendre à la main :</strong>
              {done.failed.map((f, i) => <div key={i}>· {f}</div>)}
            </div>
          )}
        </div>
      )}

      {found && (
        <div style={{ background: C.white, border: `1.5px solid ${C.blue}`, borderRadius: 12, padding: 14 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, paddingBottom: 9, borderBottom: `1px solid ${C.border}` }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 800, color: C.text }}>{found.orderName}</div>
              <div style={{ fontSize: 11.5, color: C.textMuted }}>{found.pickingName} · {found.lines.length} article(s)</div>
            </div>
            <button onClick={() => setFound(null)}
              style={{ background: "none", border: `1px solid ${C.border}`, borderRadius: 8, padding: "5px 11px", fontSize: 12, color: C.textMuted, cursor: "pointer", fontFamily: "inherit" }}>
              Annuler
            </button>
          </div>

          {matched.map(l => (
            <div key={l.productId} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: `1px solid ${C.border}` }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.name}</div>
                <div style={{ fontSize: 11, color: C.textMuted, fontFamily: "monospace" }}>
                  {l.sku} · chariot {l.swBefore} → <strong style={{ color: C.green }}>{(l.swBefore ?? 0) + l.qty}</strong>
                </div>
              </div>
              <span style={{ fontSize: 14, fontWeight: 800, color: C.blue, flexShrink: 0 }}>+{l.qty}</span>
            </div>
          ))}

          {unmatched.length > 0 && (
            <div style={{ marginTop: 10, background: C.orangeSoft, border: "1px solid #fed7aa", borderRadius: 9, padding: 11 }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: "#9a3412", marginBottom: 5 }}>
                {unmatched.length} article(s) hors chariot — ignorés
              </div>
              {unmatched.map(l => (
                <div key={l.productId} style={{ borderTop: "1px solid #fed7aa", paddingTop: 7, marginTop: 7 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ flex: 1, minWidth: 0, fontSize: 11.5, color: "#9a3412" }}>
                      {l.defaultCode || l.name} ×{l.qty}
                    </div>
                    <button onClick={() => { setAddFor(addFor === l.productId ? null : l.productId); setAddSku(""); }}
                      style={{ flexShrink: 0, padding: "4px 10px", background: "#fff", border: "1px solid #fdba74", borderRadius: 7, fontSize: 11, fontWeight: 700, color: "#9a3412", cursor: "pointer", fontFamily: "inherit" }}>
                      {addFor === l.productId ? "Annuler" : "Ajouter au chariot"}
                    </button>
                  </div>
                  {addFor === l.productId && (
                    <div style={{ marginTop: 7, background: "#fff", border: "1px solid #fed7aa", borderRadius: 8, padding: 9 }}>
                      <div style={{ fontSize: 11, color: "#9a3412", marginBottom: 6, lineHeight: 1.5 }}>
                        Saisis la <strong>référence Shopware</strong> de cet article. Si tu ne la connais pas,
                        demande-la au service e-shop et ne valide pas en attendant.
                      </div>
                      <div style={{ display: "flex", gap: 6 }}>
                        <input value={addSku} onChange={e => setAddSku(e.target.value)}
                          onKeyDown={e => { e.stopPropagation(); if (e.key === "Enter") attachToChariot(l); }}
                          placeholder="Référence Shopware…"
                          style={{ flex: 1, padding: "7px 10px", border: "1.5px solid #fdba74", borderRadius: 7, fontSize: 12, fontFamily: "inherit", outline: "none" }} />
                        <button onClick={() => attachToChariot(l)} disabled={addBusy2 || !addSku.trim()}
                          style={{ padding: "7px 13px", background: addBusy2 || !addSku.trim() ? "#e5e7eb" : C.green, color: addBusy2 || !addSku.trim() ? C.textMuted : "#fff", border: "none", borderRadius: 7, fontSize: 12, fontWeight: 700, cursor: addBusy2 || !addSku.trim() ? "default" : "pointer", fontFamily: "inherit", whiteSpace: "nowrap" as const }}>
                          {addBusy2 ? "…" : "Rattacher"}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
              <div style={{ fontSize: 11, color: "#9a3412", marginTop: 8, lineHeight: 1.5 }}>
                Si un article <strong>doit</strong> aller sur le chariot, rattache-le maintenant avec le bouton
                ci-dessus. Une fois le réappro validé, il sera trop tard : l&apos;article sortira du stock Odoo
                sans jamais arriver sur le chariot, et le bon ne pourra plus être rejoué.
              </div>
            </div>
          )}

          <button onClick={validate} disabled={validating || !matched.length}
            style={{ width: "100%", marginTop: 12, padding: "13px 0", background: validating || !matched.length ? "#e5e7eb" : C.green, color: validating || !matched.length ? C.textMuted : "#fff", border: "none", borderRadius: 10, fontSize: 14.5, fontWeight: 700, cursor: validating || !matched.length ? "default" : "pointer", fontFamily: "inherit" }}>
            {validating ? "Validation…" : matched.length ? `Valider le réappro — ${matched.reduce((s, l) => s + l.qty, 0)} article(s)` : "Aucun article du chariot dans cette commande"}
          </button>
        </div>
      )}
    </div>
  );
}
