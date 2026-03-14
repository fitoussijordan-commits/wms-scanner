"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import * as odoo from "@/lib/odoo";

// ── Types ──────────────────────────────────────────────────────────────────────
interface StockAlert { productId: number; ref: string; name: string; qty: number; threshold: number; }
interface ConsoRow { ref: string; name: string; months: Record<string, number>; total: number; avg: number; }
interface DeliveryRow { date: string; count: number; lines: number; }
interface MoveRow { date: string; type: string; ref: string; qty: number; lot: string; from: string; to: string; picking: string; }

// ── Config helpers (shared with scanner) ──────────────────────────────────────
function loadCfg(): { u: string; d: string } | null {
  try { const c = localStorage.getItem("wms_c"); return c ? JSON.parse(c) : null; } catch { return null; }
}
function saveSession(s: odoo.OdooSession) { try { localStorage.setItem("wms_dash_s", JSON.stringify(s)); } catch {} }
function loadSession(): odoo.OdooSession | null {
  try { const s = localStorage.getItem("wms_dash_s"); return s ? JSON.parse(s) : null; } catch { return null; }
}
function clearSession() { try { localStorage.removeItem("wms_dash_s"); } catch {} }

// ── Date helpers ──────────────────────────────────────────────────────────────
function monthsBack(n: number): string[] {
  const months: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  return months;
}
function fmtMonth(m: string): string {
  const [y, mo] = m.split("-");
  return new Date(+y, +mo - 1, 1).toLocaleDateString("fr-FR", { month: "short", year: "2-digit" });
}
function fmtDate(s: string): string {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

// ── Constants ─────────────────────────────────────────────────────────────────
const C = {
  bg: "#f8fafc", card: "#ffffff", border: "#e2e8f0",
  text: "#0f172a", textSec: "#475569", textMuted: "#94a3b8",
  blue: "#2563eb", blueSoft: "#eff6ff", blueBorder: "#bfdbfe",
  green: "#16a34a", greenSoft: "#f0fdf4", greenBorder: "#bbf7d0",
  orange: "#ea580c", orangeSoft: "#fff7ed", orangeBorder: "#fed7aa",
  red: "#dc2626", redSoft: "#fef2f2", redBorder: "#fecaca",
  purple: "#7c3aed", purpleSoft: "#f5f3ff", purpleBorder: "#ddd6fe",
};

const TABS = [
  { key: "alerts", label: "⚠️ Alertes stock", icon: "⚠️" },
  { key: "conso", label: "📊 Conso mensuelle", icon: "📊" },
  { key: "deliveries", label: "🚚 Livraisons", icon: "🚚" },
  { key: "moves", label: "🔄 Historique mouvements", icon: "🔄" },
];

// ── Spinner ───────────────────────────────────────────────────────────────────
function Spinner() {
  return <div style={{ width: 18, height: 18, border: `2px solid ${C.border}`, borderTop: `2px solid ${C.blue}`, borderRadius: "50%", animation: "spin 0.7s linear infinite", display: "inline-block" }} />;
}

// ── Main component ─────────────────────────────────────────────────────────────
export default function Dashboard() {
  const [session, setSession] = useState<odoo.OdooSession | null>(null);
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [url, setUrl] = useState("");
  const [db, setDb] = useState("");
  const [user, setUser] = useState("");
  const [pw, setPw] = useState("");
  const [tab, setTab] = useState("alerts");

  // ── Data states ──
  const [alerts, setAlerts] = useState<StockAlert[]>([]);
  const [thresholds, setThresholds] = useState<Record<number, number>>({});
  const [conso, setConso] = useState<ConsoRow[]>([]);
  const [deliveries, setDeliveries] = useState<DeliveryRow[]>([]);
  const [moves, setMoves] = useState<MoveRow[]>([]);
  const [stockMap, setStockMap] = useState<Record<number, { qty: number; name: string; ref: string }>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // ── Filters ──
  const [consoMonths, setConsoMonths] = useState(6);
  const [delStart, setDelStart] = useState(() => { const d = new Date(); d.setDate(1); return d.toISOString().split("T")[0]; });
  const [delEnd, setDelEnd] = useState(() => new Date().toISOString().split("T")[0]);
  const [consoSearch, setConsoSearch] = useState("");
  const [moveRef, setMoveRef] = useState("");
  const [moveSearched, setMoveSearched] = useState(false);
  const [editThresh, setEditThresh] = useState<number | null>(null);
  const [stockSearch, setStockSearch] = useState("");
  const [editVal, setEditVal] = useState("");

  // ── Load session ──
  useEffect(() => {
    const s = loadSession();
    if (s) setSession(s);
    const cfg = loadCfg();
    if (cfg) { setUrl(cfg.u); setDb(cfg.d); }
  }, []);

  // ── Login ──
  const login = async () => {
    if (!url || !db || !user || !pw) return;
    setLoginLoading(true); setLoginError("");
    try {
      const s = await odoo.authenticate({ url, db }, user, pw);
      saveSession(s);
      setSession(s);
    } catch (e: any) { setLoginError(e.message); }
    setLoginLoading(false);
  };

  const logout = () => { clearSession(); setSession(null); setAlerts([]); setConso([]); setDeliveries([]); setMoves([]); };

  // ── Load thresholds from localStorage ──
  useEffect(() => {
    try {
      const t = localStorage.getItem("wms_thresholds");
      if (t) setThresholds(JSON.parse(t));
    } catch {}
  }, []);
  const saveThresholds = (t: Record<number, number>) => {
    setThresholds(t);
    try { localStorage.setItem("wms_thresholds", JSON.stringify(t)); } catch {}
  };

  // ── Load stock alerts ──
  const loadAlerts = useCallback(async () => {
    if (!session) return;
    setLoading(true); setError("");
    try {
      // Get all quants for internal locations
      const quants = await odoo.searchRead(session, "stock.quant", [
        ["location_id.usage", "=", "internal"],
        ["quantity", ">", 0],
      ], ["product_id", "quantity", "location_id"], 2000);

      // Aggregate by product
      const byProduct: Record<number, { name: string; ref: string; qty: number }> = {};
      for (const q of quants) {
        const pid = q.product_id[0];
        if (!byProduct[pid]) byProduct[pid] = { name: q.product_id[1], ref: "", qty: 0 };
        byProduct[pid].qty += q.quantity;
      }

      // Get refs
      const pids = Object.keys(byProduct).map(Number);
      if (pids.length) {
        const prods = await odoo.searchRead(session, "product.product", [["id", "in", pids]], ["id", "default_code"], 2000);
        for (const p of prods) if (byProduct[p.id]) byProduct[p.id].ref = p.default_code || "";
      }

      setStockMap(Object.fromEntries(Object.entries(byProduct).map(([id, v]) => [id, { qty: v.qty, name: v.name, ref: v.ref }])));

      // Build alerts based on thresholds
      const alertList: StockAlert[] = [];
      for (const [idStr, data] of Object.entries(byProduct)) {
        const pid = Number(idStr);
        const thresh = thresholds[pid];
        if (thresh !== undefined && data.qty <= thresh) {
          alertList.push({ productId: pid, ref: data.ref, name: data.name, qty: data.qty, threshold: thresh });
        }
      }
      alertList.sort((a, b) => (a.qty / a.threshold) - (b.qty / b.threshold));
      setAlerts(alertList);

      // Also return full product list for threshold management
      return byProduct;
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [session, thresholds]);

  // ── Load conso ──
  const loadConso = useCallback(async () => {
    if (!session) return;
    setLoading(true); setError("");
    try {
      const months = monthsBack(consoMonths);
      const startDate = months[0] + "-01";
      const endDate = new Date().toISOString().split("T")[0];

      // Get outgoing picking type IDs (reliable vs dotted domain)
      const outTypes = await odoo.searchRead(session, "stock.picking.type", [["code", "=", "outgoing"]], ["id"], 50);
      const outTypeIds = outTypes.map((t: any) => t.id);

      // Get validated outgoing pickings in date range
      const pickings = await odoo.searchRead(session, "stock.picking", [
        ["state", "=", "done"],
        ["picking_type_id", "in", outTypeIds],
        ["date_done", ">=", startDate + " 00:00:00"],
        ["date_done", "<=", endDate + " 23:59:59"],
      ], ["id", "date_done"], 2000);

      const pickingIds = pickings.map((p: any) => p.id);
      const pickingDateMap: Record<number, string> = Object.fromEntries(pickings.map((p: any) => [p.id, p.date_done]));

      if (!pickingIds.length) { setConso([]); setLoading(false); return; }

      // Get all moves for these pickings in batches of 500 ids
      const batchSize = 500;
      let allMoves: any[] = [];
      for (let i = 0; i < pickingIds.length; i += batchSize) {
        const batch = pickingIds.slice(i, i + batchSize);
        const batchMoves = await odoo.searchRead(session, "stock.move", [
          ["picking_id", "in", batch],
          ["state", "=", "done"],
        ], ["product_id", "product_qty", "picking_id"], 10000);
        allMoves = allMoves.concat(batchMoves);
      }
      const moves = allMoves;

      // Aggregate by product + month (using picking date for accuracy)
      const byProd: Record<number, { name: string; ref: string; months: Record<string, number> }> = {};
      for (const m of moves) {
        const pid = m.product_id[0];
        const pickingDate = pickingDateMap[m.picking_id?.[0]] || "";
        const month = pickingDate.substring(0, 7);
        if (!month) continue;
        if (!byProd[pid]) byProd[pid] = { name: m.product_id[1], ref: "", months: {} };
        byProd[pid].months[month] = (byProd[pid].months[month] || 0) + m.product_qty;
      }

      // Get refs
      const pids = Object.keys(byProd).map(Number);
      if (pids.length) {
        const prods = await odoo.searchRead(session, "product.product", [["id", "in", pids]], ["id", "default_code"], 2000);
        for (const p of prods) if (byProd[p.id]) byProd[p.id].ref = p.default_code || "";
      }

      const rows: ConsoRow[] = Object.entries(byProd).map(([, v]) => ({
        ref: v.ref, name: v.name, months: v.months,
        total: Object.values(v.months).reduce((s, n) => s + n, 0),
        avg: 0,
      }));
      rows.sort((a, b) => b.total - a.total);
      // compute avg over months with activity
      rows.forEach(r => {
        const activeMonths = Object.values(r.months).filter(v => v > 0).length;
        r.avg = activeMonths > 0 ? Math.round(r.total / activeMonths) : 0;
      });
      setConso(rows);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [session, consoMonths]);

  // ── Load deliveries ──
  const loadDeliveries = useCallback(async () => {
    if (!session) return;
    setLoading(true); setError("");
    try {
      const pickings = await odoo.searchRead(session, "stock.picking", [
        ["state", "=", "done"],
        ["picking_type_code", "=", "outgoing"],
        ["date_done", ">=", delStart + " 00:00:00"],
        ["date_done", "<=", delEnd + " 23:59:59"],
      ], ["name", "date_done", "partner_id", "move_ids"], 1000, "date_done desc");

      // Group by date
      const byDate: Record<string, { count: number; lines: number }> = {};
      for (const p of pickings) {
        const date = (p.date_done || "").substring(0, 10);
        if (!byDate[date]) byDate[date] = { count: 0, lines: 0 };
        byDate[date].count++;
        byDate[date].lines += (p.move_ids || []).length;
      }
      const rows: DeliveryRow[] = Object.entries(byDate)
        .sort(([a], [b]) => b.localeCompare(a))
        .map(([date, v]) => ({ date, ...v }));
      setDeliveries(rows);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [session, delStart, delEnd]);

  // ── Load moves by ref ──
  const loadMoves = useCallback(async () => {
    if (!session || !moveRef.trim()) return;
    setLoading(true); setError(""); setMoveSearched(true);
    try {
      // Find product by ref or barcode
      let prods = await odoo.searchRead(session, "product.product", [["default_code", "=ilike", moveRef.trim()]], ["id", "name", "default_code"], 5);
      if (!prods.length) prods = await odoo.searchRead(session, "product.product", [["barcode", "=", moveRef.trim()]], ["id", "name", "default_code"], 5);
      if (!prods.length) { setError(`Référence "${moveRef}" introuvable`); setLoading(false); return; }

      const productId = prods[0].id;
      const rawMoves = await odoo.searchRead(session, "stock.move", [
        ["product_id", "=", productId],
        ["state", "=", "done"],
      ], ["date", "picking_id", "location_id", "location_dest_id", "product_qty", "lot_ids"], 200, "date desc");

      // Determine type from location usage
      const locIds = [...new Set(rawMoves.flatMap((m: any) => [m.location_id?.[0], m.location_dest_id?.[0]]).filter(Boolean))];
      const locs = locIds.length ? await odoo.searchRead(session, "stock.location", [["id", "in", locIds]], ["id", "usage"], 200) : [];
      const locUsage: Record<number, string> = Object.fromEntries(locs.map((l: any) => [l.id, l.usage]));

      const rows: MoveRow[] = rawMoves.map((m: any) => {
        const fromUsage = locUsage[m.location_id?.[0]] || "";
        const toUsage = locUsage[m.location_dest_id?.[0]] || "";
        const type = fromUsage === "supplier" || toUsage === "internal" && fromUsage !== "internal" ? "Entrée"
          : toUsage === "customer" || fromUsage === "internal" && toUsage !== "internal" ? "Sortie" : "Interne";
        return {
          date: m.date,
          type,
          ref: prods[0].default_code || "",
          qty: m.product_qty,
          lot: Array.isArray(m.lot_ids) ? m.lot_ids.join(", ") || "—" : "—",
          from: m.location_id?.[1] || "—",
          to: m.location_dest_id?.[1] || "—",
          picking: m.picking_id?.[1] || "—",
        };
      });
      setMoves(rows);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [session, moveRef]);

  // Auto-load on tab change
  useEffect(() => {
    if (!session) return;
    if (tab === "alerts") { loadAlerts(); if (conso.length === 0) loadConso(); }
    if (tab === "conso") loadConso();
    if (tab === "deliveries") loadDeliveries();
  }, [tab, session]);

  // ── Login screen ──
  if (!session) return (
    <div style={{ minHeight: "100vh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap'); @keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <div style={{ width: "100%", maxWidth: 400, padding: 24 }}>
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{ width: 52, height: 52, borderRadius: 14, background: C.blue, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.8"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>
          </div>
          <h1 style={{ fontSize: 22, fontWeight: 800, color: C.text, margin: "0 0 4px" }}>Dashboard Odoo</h1>
          <p style={{ fontSize: 14, color: C.textMuted, margin: 0 }}>Rapports & Alertes stock</p>
        </div>
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 16, padding: 24 }}>
          {[{ label: "URL Odoo", val: url, set: setUrl, ph: "https://..." }, { label: "Base de données", val: db, set: setDb, ph: "nom_base" }, { label: "Identifiant", val: user, set: setUser, ph: "admin@..." }, { label: "Mot de passe", val: pw, set: setPw, ph: "••••••", type: "password" }].map(f => (
            <div key={f.label} style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: C.textSec, display: "block", marginBottom: 5 }}>{f.label}</label>
              <input type={f.type || "text"} value={f.val} onChange={e => f.set(e.target.value)}
                placeholder={f.ph} onKeyDown={e => e.key === "Enter" && login()}
                style={{ width: "100%", padding: "10px 12px", border: `1.5px solid ${C.border}`, borderRadius: 10, fontSize: 14, fontFamily: "inherit", outline: "none", background: C.bg, boxSizing: "border-box" }} />
            </div>
          ))}
          {loginError && <div style={{ background: C.redSoft, border: `1px solid ${C.redBorder}`, borderRadius: 8, padding: "8px 12px", fontSize: 13, color: C.red, marginBottom: 12 }}>{loginError}</div>}
          <button onClick={login} disabled={loginLoading} style={{ width: "100%", padding: 13, background: C.blue, color: "#fff", border: "none", borderRadius: 10, fontSize: 15, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
            {loginLoading ? "Connexion..." : "Se connecter"}
          </button>
        </div>
      </div>
    </div>
  );

  const months = monthsBack(consoMonths);

  return (
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap'); @keyframes spin { to { transform: rotate(360deg); } } table { border-collapse: collapse; } th, td { text-align: left; }`}</style>

      {/* ── Header ── */}
      <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, padding: "14px 28px", display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, zIndex: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: C.blue, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>
          </div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 800, color: C.text }}>Dashboard Odoo</div>
            <div style={{ fontSize: 12, color: C.textMuted }}>{session.name} · {session.config?.url?.replace("https://", "")}</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <a href="/" style={{ padding: "8px 14px", background: C.bg, color: C.textSec, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 13, fontWeight: 600, textDecoration: "none" }}>← Scanner</a>
          <button onClick={logout} style={{ padding: "8px 14px", background: C.bg, color: C.red, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Déconnexion</button>
        </div>
      </div>

      {/* ── Tabs ── */}
      <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, padding: "0 28px", display: "flex", gap: 4 }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            padding: "14px 18px", background: "none", border: "none", borderBottom: `3px solid ${tab === t.key ? C.blue : "transparent"}`,
            fontSize: 14, fontWeight: tab === t.key ? 700 : 500, color: tab === t.key ? C.blue : C.textSec,
            cursor: "pointer", fontFamily: "inherit", transition: "all .15s"
          }}>{t.label}</button>
        ))}
      </div>

      {/* ── Content ── */}
      <div style={{ maxWidth: 1200, margin: "0 auto", padding: 28 }}>
        {error && <div style={{ background: C.redSoft, border: `1px solid ${C.redBorder}`, borderRadius: 10, padding: "12px 16px", fontSize: 14, color: C.red, marginBottom: 20 }}>⚠ {error}</div>}

        {/* ══ ALERTES STOCK ══ */}
        {tab === "alerts" && (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
              <div>
                <h2 style={{ fontSize: 20, fontWeight: 800, color: C.text, margin: "0 0 4px" }}>Alertes stock</h2>
                <p style={{ fontSize: 14, color: C.textMuted, margin: 0 }}>Définissez vos seuils min. Les jours restants sont estimés d'après la conso moyenne.</p>
              </div>
              <button onClick={loadAlerts} disabled={loading} style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 16px", background: C.blue, color: "#fff", border: "none", borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
                {loading ? <Spinner /> : "↻"} Actualiser
              </button>
            </div>

            {/* ── Alertes actives ── */}
            {alerts.length > 0 && (
              <div style={{ marginBottom: 28 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: C.red, marginBottom: 12, textTransform: "uppercase", letterSpacing: 0.8, display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: C.red, animation: "pulse 1.5s ease-in-out infinite" }} />
                  {alerts.length} article(s) en alerte
                </div>
                <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} } @keyframes spin { to{transform:rotate(360deg)} }`}</style>
                <div style={{ display: "grid", gap: 10 }}>
                  {alerts.map(a => {
                    const ratio = a.qty / a.threshold;
                    const color = ratio <= 0.25 ? C.red : ratio <= 0.75 ? C.orange : "#ca8a04";
                    const bgColor = ratio <= 0.25 ? C.redSoft : ratio <= 0.75 ? C.orangeSoft : "#fefce8";
                    const borderColor = ratio <= 0.25 ? C.redBorder : ratio <= 0.75 ? C.orangeBorder : "#fde68a";
                    // Estimate days remaining from conso avg
                    const consoRow = conso.find(c => c.ref === a.ref);
                    const dailyAvg = consoRow ? consoRow.avg / 30 : 0;
                    const daysLeft = dailyAvg > 0 ? Math.round(a.qty / dailyAvg) : null;
                    const daysLabel = daysLeft === null ? "Conso inconnue" : daysLeft <= 0 ? "Rupture imminente" : daysLeft === 1 ? "1 jour restant" : `${daysLeft} jours restants`;
                    const status = daysLeft === null ? "⚠️" : daysLeft <= 7 ? "🔴" : daysLeft <= 30 ? "🟠" : "🟡";
                    return (
                      <div key={a.productId} style={{ background: bgColor, border: `1.5px solid ${borderColor}`, borderRadius: 14, padding: "16px 20px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 2 }}>
                              {a.ref && <span style={{ color: C.blue, marginRight: 6 }}>[{a.ref}]</span>}
                              {a.name}
                            </div>
                            <div style={{ display: "flex", gap: 16, marginTop: 6, flexWrap: "wrap" }}>
                              <span style={{ fontSize: 13, color: C.textSec }}>Stock : <strong style={{ color, fontSize: 15 }}>{a.qty}</strong></span>
                              <span style={{ fontSize: 13, color: C.textSec }}>Seuil : <strong>{a.threshold}</strong></span>
                              {consoRow && <span style={{ fontSize: 13, color: C.textSec }}>Moy : <strong>{consoRow.avg}/mois</strong></span>}
                            </div>
                          </div>
                          <div style={{ textAlign: "right", flexShrink: 0 }}>
                            <div style={{ fontSize: 20 }}>{status}</div>
                            <div style={{ fontSize: 12, fontWeight: 700, color, marginTop: 2, whiteSpace: "nowrap" }}>{daysLabel}</div>
                          </div>
                        </div>
                        {/* Barre de stock */}
                        <div style={{ height: 6, background: `${color}22`, borderRadius: 3, marginTop: 12, overflow: "hidden" }}>
                          <div style={{ height: "100%", width: `${Math.min(ratio * 100, 100)}%`, background: color, borderRadius: 3, transition: "width .5s" }} />
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
                          <span style={{ fontSize: 11, color: C.textMuted }}>0</span>
                          <span style={{ fontSize: 11, color: C.textMuted }}>Seuil : {a.threshold}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {alerts.length === 0 && Object.keys(stockMap).length > 0 && (
              <div style={{ background: C.greenSoft, border: `1.5px solid ${C.greenBorder}`, borderRadius: 14, padding: "20px 24px", marginBottom: 24, display: "flex", alignItems: "center", gap: 16 }}>
                <div style={{ fontSize: 32 }}>✅</div>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: C.green }}>Tous les stocks sont OK</div>
                  <div style={{ fontSize: 13, color: C.textMuted, marginTop: 2 }}>Aucun article n'a atteint son seuil d'alerte.</div>
                </div>
              </div>
            )}

            {/* ── Gérer les seuils ── */}
            <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 16, padding: 20 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 4 }}>Gérer les seuils</div>
              <div style={{ fontSize: 13, color: C.textMuted, marginBottom: 14 }}>Cliquez sur "+ Seuil" pour surveiller un article.</div>
              <input value={stockSearch} onChange={e => setStockSearch(e.target.value)}
                placeholder="Filtrer par référence ou nom..."
                style={{ width: "100%", padding: "9px 12px", border: `1.5px solid ${C.border}`, borderRadius: 10, fontSize: 13, fontFamily: "inherit", background: C.bg, marginBottom: 12, boxSizing: "border-box" }} />
              <div style={{ maxHeight: 400, overflowY: "auto" }}>
                {Object.keys(stockMap).length === 0 && !loading && (
                  <div style={{ color: C.textMuted, fontSize: 14, textAlign: "center", padding: 20 }}>Cliquez sur "Actualiser" pour charger les produits</div>
                )}
                {Object.entries(stockMap).filter(([, data]) => !stockSearch || data.ref.toLowerCase().includes(stockSearch.toLowerCase()) || data.name.toLowerCase().includes(stockSearch.toLowerCase())).map(([pidStr, data]) => {
                  const pid = Number(pidStr);
                  const { qty, name, ref } = data;
                  const thresh = thresholds[pid];
                  const isAlert = thresh !== undefined && qty <= thresh;
                  return (
                    <div key={pid} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: `1px solid ${C.border}` }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, color: C.text, fontWeight: thresh !== undefined ? 600 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {ref && <span style={{ color: C.blue, fontWeight: 700, marginRight: 6 }}>[{ref}]</span>}
                          {name}
                        </div>
                        <div style={{ fontSize: 12, color: isAlert ? C.red : C.textMuted }}>
                          Stock : <strong>{qty}</strong>{thresh !== undefined ? ` · Seuil : ${thresh}` : ""}
                          {isAlert && <span style={{ marginLeft: 6, color: C.red, fontWeight: 700 }}>⚠ Alerte</span>}
                        </div>
                      </div>
                      {editThresh === pid ? (
                        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                          <input value={editVal} onChange={e => setEditVal(e.target.value)} type="number" min="0"
                            style={{ width: 80, padding: "6px 8px", border: `1.5px solid ${C.blue}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}
                            autoFocus onKeyDown={e => {
                              if (e.key === "Enter") { const v = Number(editVal); if (!isNaN(v) && v >= 0) saveThresholds({ ...thresholds, [pid]: v }); setEditThresh(null); }
                              if (e.key === "Escape") setEditThresh(null);
                            }} />
                          <button onClick={() => { const v = Number(editVal); if (!isNaN(v) && v >= 0) saveThresholds({ ...thresholds, [pid]: v }); setEditThresh(null); }}
                            style={{ padding: "6px 10px", background: C.green, color: "#fff", border: "none", borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>✓</button>
                          <button onClick={() => { if (thresh !== undefined) { const t = {...thresholds}; delete t[pid]; saveThresholds(t); } setEditThresh(null); }}
                            style={{ padding: "6px 10px", background: C.bg, color: C.red, border: `1px solid ${C.redBorder}`, borderRadius: 8, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>🗑</button>
                        </div>
                      ) : (
                        <button onClick={() => { setEditThresh(pid); setEditVal(thresh !== undefined ? String(thresh) : ""); }}
                          style={{ flexShrink: 0, padding: "6px 12px", background: thresh !== undefined ? (isAlert ? C.redSoft : C.orangeSoft) : C.bg, color: thresh !== undefined ? (isAlert ? C.red : C.orange) : C.textMuted, border: `1px solid ${thresh !== undefined ? (isAlert ? C.redBorder : C.orangeBorder) : C.border}`, borderRadius: 8, fontSize: 12, cursor: "pointer", fontFamily: "inherit", fontWeight: thresh !== undefined ? 700 : 400 }}>
                          {thresh !== undefined ? `Seuil: ${thresh}` : "+ Seuil"}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}

                {/* ══ CONSO MENSUELLE ══ */}
        {tab === "conso" && (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
              <div>
                <h2 style={{ fontSize: 20, fontWeight: 800, color: C.text, margin: "0 0 4px" }}>Consommation mensuelle</h2>
                <p style={{ fontSize: 14, color: C.textMuted, margin: 0 }}>Quantités sorties des stocks internes par mois.</p>
              </div>
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <select value={consoMonths} onChange={e => setConsoMonths(Number(e.target.value))}
                  style={{ padding: "9px 12px", border: `1.5px solid ${C.border}`, borderRadius: 10, fontSize: 14, background: C.card, fontFamily: "inherit", cursor: "pointer" }}>
                  {[3, 6, 9, 12].map(n => <option key={n} value={n}>{n} mois</option>)}
                </select>
                <button onClick={loadConso} disabled={loading} style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 16px", background: C.blue, color: "#fff", border: "none", borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
                  {loading ? <Spinner /> : "↻"} Charger
                </button>
              </div>
            </div>

            {conso.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <input value={consoSearch} onChange={e => setConsoSearch(e.target.value)}
                  placeholder="Filtrer par référence ou désignation..."
                  style={{ width: "100%", padding: "10px 14px", border: `1.5px solid ${C.border}`, borderRadius: 10, fontSize: 14, fontFamily: "inherit", background: C.card, boxSizing: "border-box" }} />
              </div>
            )}
            {conso.length > 0 && (
              <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 16, overflow: "hidden" }}>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: C.bg }}>
                        <th style={{ padding: "12px 16px", fontWeight: 700, color: C.textSec, borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap", position: "sticky", left: 0, background: C.bg }}>Référence</th>
                        <th style={{ padding: "12px 16px", fontWeight: 700, color: C.textSec, borderBottom: `1px solid ${C.border}`, minWidth: 200 }}>Désignation</th>
                        {months.map(m => <th key={m} style={{ padding: "12px 12px", fontWeight: 700, color: C.textSec, borderBottom: `1px solid ${C.border}`, textAlign: "center", whiteSpace: "nowrap" }}>{fmtMonth(m)}</th>)}
                        <th style={{ padding: "12px 12px", fontWeight: 700, color: C.textSec, borderBottom: `1px solid ${C.border}`, textAlign: "center", whiteSpace: "nowrap" }}>Moy/mois</th>
                        <th style={{ padding: "12px 16px", fontWeight: 700, color: C.text, borderBottom: `1px solid ${C.border}`, textAlign: "center" }}>Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {conso.filter(row => !consoSearch || row.ref.toLowerCase().includes(consoSearch.toLowerCase()) || row.name.toLowerCase().includes(consoSearch.toLowerCase())).map((row, i) => {
                        const max = Math.max(...months.map(m => row.months[m] || 0));
                        return (
                          <tr key={i} style={{ borderBottom: `1px solid ${C.border}` }}>
                            <td style={{ padding: "11px 16px", fontWeight: 700, color: C.blue, whiteSpace: "nowrap", position: "sticky", left: 0, background: i % 2 === 0 ? C.card : C.bg }}>{row.ref || "—"}</td>
                            <td style={{ padding: "11px 16px", color: C.text, background: i % 2 === 0 ? C.card : C.bg }}>{row.name}</td>
                            {months.map(m => {
                              const val = row.months[m] || 0;
                              const intensity = max > 0 ? val / max : 0;
                              return (
                                <td key={m} style={{ padding: "11px 12px", textAlign: "center", background: val > 0 ? `rgba(37,99,235,${intensity * 0.15 + 0.03})` : "transparent", color: val > 0 ? C.text : C.textMuted, fontWeight: val > 0 ? 600 : 400 }}>
                                  {val > 0 ? val : "—"}
                                </td>
                              );
                            })}
                            <td style={{ padding: "11px 12px", textAlign: "center", fontWeight: 600, color: C.purple }}>{row.avg > 0 ? row.avg : "—"}</td>
                            <td style={{ padding: "11px 16px", textAlign: "center", fontWeight: 800, color: C.text }}>{row.total}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {conso.length === 0 && !loading && <div style={{ textAlign: "center", padding: 60, color: C.textMuted, fontSize: 15 }}>Cliquez sur "Charger" pour afficher les données</div>}
          </>
        )}

        {/* ══ LIVRAISONS ══ */}
        {tab === "deliveries" && (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
              <div>
                <h2 style={{ fontSize: 20, fontWeight: 800, color: C.text, margin: "0 0 4px" }}>Livraisons par période</h2>
                <p style={{ fontSize: 14, color: C.textMuted, margin: 0 }}>Bons de livraison validés, groupés par jour.</p>
              </div>
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <input type="date" value={delStart} onChange={e => setDelStart(e.target.value)}
                  style={{ padding: "9px 12px", border: `1.5px solid ${C.border}`, borderRadius: 10, fontSize: 14, fontFamily: "inherit" }} />
                <span style={{ color: C.textMuted }}>→</span>
                <input type="date" value={delEnd} onChange={e => setDelEnd(e.target.value)}
                  style={{ padding: "9px 12px", border: `1.5px solid ${C.border}`, borderRadius: 10, fontSize: 14, fontFamily: "inherit" }} />
                <button onClick={loadDeliveries} disabled={loading} style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 16px", background: C.blue, color: "#fff", border: "none", borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
                  {loading ? <Spinner /> : "↻"} Charger
                </button>
              </div>
            </div>

            {deliveries.length > 0 && (
              <>
                {/* Totaux */}
                <div style={{ display: "flex", gap: 12, marginBottom: 20 }}>
                  {[
                    { label: "Jours", val: deliveries.length, color: C.blue },
                    { label: "Livraisons", val: deliveries.reduce((s, d) => s + d.count, 0), color: C.green },
                    { label: "Lignes totales", val: deliveries.reduce((s, d) => s + d.lines, 0), color: C.purple },
                    { label: "Moy. / jour", val: Math.round(deliveries.reduce((s, d) => s + d.count, 0) / deliveries.length), color: C.orange },
                  ].map(stat => (
                    <div key={stat.label} style={{ flex: 1, background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "14px 18px" }}>
                      <div style={{ fontSize: 24, fontWeight: 800, color: stat.color }}>{stat.val}</div>
                      <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>{stat.label}</div>
                    </div>
                  ))}
                </div>

                {/* Table */}
                <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 16, overflow: "hidden" }}>
                  <table style={{ width: "100%", fontSize: 14 }}>
                    <thead>
                      <tr style={{ background: C.bg }}>
                        {["Date", "Livraisons", "Lignes articles"].map(h => (
                          <th key={h} style={{ padding: "12px 20px", fontWeight: 700, color: C.textSec, borderBottom: `1px solid ${C.border}`, textAlign: h === "Date" ? "left" : "center" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {deliveries.map((d, i) => {
                        const maxCount = Math.max(...deliveries.map(x => x.count));
                        return (
                          <tr key={i} style={{ borderBottom: `1px solid ${C.border}`, background: i % 2 === 0 ? C.card : C.bg }}>
                            <td style={{ padding: "12px 20px", fontWeight: 600, color: C.text }}>{fmtDate(d.date)}</td>
                            <td style={{ padding: "12px 20px", textAlign: "center" }}>
                              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}>
                                <div style={{ height: 8, width: `${(d.count / maxCount) * 80}px`, background: C.blue, borderRadius: 4, minWidth: 4 }} />
                                <span style={{ fontWeight: 700, color: C.text }}>{d.count}</span>
                              </div>
                            </td>
                            <td style={{ padding: "12px 20px", textAlign: "center", color: C.textSec, fontWeight: 600 }}>{d.lines}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            {deliveries.length === 0 && !loading && <div style={{ textAlign: "center", padding: 60, color: C.textMuted, fontSize: 15 }}>Sélectionnez une période et cliquez sur "Charger"</div>}
          </>
        )}

        {/* ══ HISTORIQUE MOUVEMENTS ══ */}
        {tab === "moves" && (
          <>
            <div style={{ marginBottom: 20 }}>
              <h2 style={{ fontSize: 20, fontWeight: 800, color: C.text, margin: "0 0 4px" }}>Historique des mouvements</h2>
              <p style={{ fontSize: 14, color: C.textMuted, margin: "0 0 16px" }}>Recherchez par référence article ou code-barres.</p>
              <div style={{ display: "flex", gap: 10 }}>
                <input value={moveRef} onChange={e => setMoveRef(e.target.value)} placeholder="Référence ou code-barres..."
                  onKeyDown={e => e.key === "Enter" && loadMoves()}
                  style={{ flex: 1, padding: "11px 14px", border: `1.5px solid ${C.border}`, borderRadius: 10, fontSize: 14, fontFamily: "inherit", background: C.card }} />
                <button onClick={loadMoves} disabled={loading || !moveRef.trim()} style={{ display: "flex", alignItems: "center", gap: 8, padding: "11px 20px", background: C.blue, color: "#fff", border: "none", borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", opacity: !moveRef.trim() ? 0.5 : 1 }}>
                  {loading ? <Spinner /> : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>}
                  Rechercher
                </button>
              </div>
            </div>

            {moves.length > 0 && (
              <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 16, overflow: "hidden" }}>
                <div style={{ padding: "14px 20px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{moves.length} mouvement(s)</span>
                </div>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: C.bg }}>
                        {["Date", "Type", "Qté", "Lot", "De", "Vers", "BL/Transfert"].map(h => (
                          <th key={h} style={{ padding: "11px 16px", fontWeight: 700, color: C.textSec, borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {moves.map((m, i) => {
                        const typeColor = m.type === "Sortie" ? C.red : m.type === "Entrée" ? C.green : C.blue;
                        const typeBg = m.type === "Sortie" ? C.redSoft : m.type === "Entrée" ? C.greenSoft : C.blueSoft;
                        return (
                          <tr key={i} style={{ borderBottom: `1px solid ${C.border}`, background: i % 2 === 0 ? C.card : C.bg }}>
                            <td style={{ padding: "11px 16px", color: C.textSec, whiteSpace: "nowrap" }}>{fmtDate(m.date)}</td>
                            <td style={{ padding: "11px 16px" }}>
                              <span style={{ background: typeBg, color: typeColor, borderRadius: 6, padding: "3px 8px", fontSize: 12, fontWeight: 700 }}>{m.type}</span>
                            </td>
                            <td style={{ padding: "11px 16px", fontWeight: 800, color: C.text }}>{m.qty}</td>
                            <td style={{ padding: "11px 16px", color: C.textSec, fontFamily: "monospace", fontSize: 12 }}>{m.lot}</td>
                            <td style={{ padding: "11px 16px", color: C.textMuted, fontSize: 12, whiteSpace: "nowrap" }}>{m.from}</td>
                            <td style={{ padding: "11px 16px", color: C.textMuted, fontSize: 12, whiteSpace: "nowrap" }}>{m.to}</td>
                            <td style={{ padding: "11px 16px", color: C.blue, fontSize: 12, fontWeight: 600 }}>{m.picking}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {moves.length === 0 && moveSearched && !loading && (
              <div style={{ textAlign: "center", padding: 60, color: C.textMuted, fontSize: 15 }}>Aucun mouvement trouvé pour "{moveRef}"</div>
            )}
            {!moveSearched && <div style={{ textAlign: "center", padding: 60, color: C.textMuted, fontSize: 15 }}>Entrez une référence pour afficher l'historique</div>}
          </>
        )}

        {loading && tab !== "alerts" && (
          <div style={{ textAlign: "center", padding: 40 }}><Spinner /></div>
        )}
      </div>
    </div>
  );
}
