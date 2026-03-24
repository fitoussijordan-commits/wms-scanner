"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import * as odoo from "@/lib/odoo";
import * as supa from "@/lib/supabase";

// ─────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────
interface StockAlert {
  productId: number;
  ref: string;
  name: string;
  qty: number;
  threshold: number;
  consoAvg: number;
  daysLeft: number;
}
interface ConsoRow {
  ref: string;
  name: string;
  months: Record<string, number>;
  total: number;
  avg: number;
}
interface DeliveryRow {
  date: string;
  count: number;
  lines: number;
}
interface MoveRow {
  date: string;
  type: string;
  qty: number;
  lot: string;
  from: string;
  to: string;
  picking: string;
  partner: string;
  product: string;
}
interface StockProduct {
  qty: number;
  name: string;
  ref: string;
}

type SortDir = "asc" | "desc" | null;

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function loadCfg(): { u: string; d: string } | null {
  try {
    const c = localStorage.getItem("wms_c");
    return c ? JSON.parse(c) : null;
  } catch {
    return null;
  }
}
function saveSession(s: odoo.OdooSession) {
  try {
    localStorage.setItem("wms_dash_s", JSON.stringify(s));
  } catch {}
}
function loadSession(): odoo.OdooSession | null {
  try {
    const s = localStorage.getItem("wms_dash_s");
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}
function clearSession() {
  try {
    localStorage.removeItem("wms_dash_s");
  } catch {}
}
function monthsBack(n: number): string[] {
  const months: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - i);
    months.push(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
    );
  }
  return months;
}
function fmtMonth(m: string): string {
  const [y, mo] = m.split("-");
  return new Date(+y, +mo - 1, 1).toLocaleDateString("fr-FR", {
    month: "short",
    year: "2-digit",
  });
}
function fmtDate(s: string): string {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

// ─────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────
const GLOBAL_CSS = `
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,500;0,9..40,700;0,9..40,800;1,9..40,400&family=JetBrains+Mono:wght@400;600&display=swap');


:root {
  --bg-base: #f4f6f9;
  --bg-raised: #ffffff;
  --bg-surface: #f8f9fb;
  --bg-hover: #eef1f5;
  --bg-input: #ffffff;
  --border: #dfe3ea;
  --text-primary: #111827;
  --text-secondary: #4b5563;
  --text-muted: #9ca3af;
  --accent: #2563eb;
  --accent-soft: rgba(37,99,235,0.08);
  --accent-border: rgba(37,99,235,0.2);
  --success: #16a34a;
  --success-soft: rgba(22,163,74,0.08);
  --success-border: rgba(22,163,74,0.2);
  --warning: #d97706;
  --warning-soft: rgba(217,119,6,0.08);
  --warning-border: rgba(217,119,6,0.2);
  --danger: #dc2626;
  --danger-soft: rgba(220,38,38,0.06);
  --danger-border: rgba(220,38,38,0.2);
  --purple: #7c3aed;
  --purple-soft: rgba(124,58,237,0.08);
  --purple-border: rgba(124,58,237,0.2);
  --orange: #ea580c;
  --shadow-popup: 0 8px 24px rgba(0,0,0,0.12);
  --table-row-alt: rgba(0,0,0,0.018);
  --heat-color: 37,99,235;
}

* { box-sizing: border-box; margin: 0; padding: 0; }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes pulse-dot { 0%,100%{opacity:1} 50%{opacity:0.3} }
@keyframes fadeIn { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }
@keyframes slideUp { from { opacity:0; transform:translateY(16px); } to { opacity:1; transform:translateY(0); } }
@keyframes barGrow { from { transform:scaleX(0); } to { transform:scaleX(1); } }
@keyframes dropIn { from { opacity:0; transform:translateY(-6px) scale(0.97); } to { opacity:1; transform:translateY(0) scale(1); } }

table { border-collapse:collapse; width:100%; }
th, td { text-align:left; }

.wms-root { min-height:100vh; background:var(--bg-base); font-family:'DM Sans',-apple-system,sans-serif; color:var(--text-primary); transition:background .25s ease,color .25s ease; }

.wms-input { width:100%; padding:11px 14px; border:1.5px solid var(--border); border-radius:8px; font-size:14px; font-family:'DM Sans',sans-serif; background:var(--bg-input); color:var(--text-primary); outline:none; transition:border-color .18s,box-shadow .18s; }
.wms-input:focus { border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-soft); }
.wms-input::placeholder { color:var(--text-muted); }

.wms-btn { display:inline-flex; align-items:center; gap:8px; padding:10px 18px; border:none; border-radius:8px; font-size:14px; font-weight:600; font-family:'DM Sans',sans-serif; cursor:pointer; transition:all .18s; line-height:1.4; white-space:nowrap; }
.wms-btn:disabled { opacity:.5; cursor:not-allowed; }
.wms-btn-primary { background:var(--accent); color:#fff; }
.wms-btn-primary:hover:not(:disabled) { filter:brightness(1.1); box-shadow:0 0 20px var(--accent-soft); }
.wms-btn-ghost { background:var(--bg-surface); color:var(--text-secondary); border:1px solid var(--border); }
.wms-btn-ghost:hover:not(:disabled) { background:var(--bg-hover); color:var(--text-primary); }
.wms-btn-danger { background:var(--danger-soft); color:var(--danger); border:1px solid var(--danger-border); }

.wms-card { background:var(--bg-raised); border:1px solid var(--border); border-radius:16px; overflow:hidden; }

.wms-table thead th { padding:0; font-weight:600; font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:.5px; border-bottom:1px solid var(--border); background:var(--bg-surface); position:sticky; top:0; z-index:2; }
.wms-table thead th .th-inner { display:flex; align-items:center; justify-content:space-between; padding:10px 16px; gap:4px; cursor:pointer; user-select:none; transition:background .12s; }
.wms-table thead th .th-inner:hover { background:var(--bg-hover); }
.wms-table tbody td { padding:11px 16px; font-size:13px; color:var(--text-secondary); border-bottom:1px solid var(--border); }
.wms-table tbody tr { transition:background .12s; }
.wms-table tbody tr:nth-child(even) { background:var(--table-row-alt); }
.wms-table tbody tr:hover { background:var(--bg-hover); }

.wms-badge { display:inline-flex; align-items:center; gap:4px; padding:3px 10px; border-radius:6px; font-size:11px; font-weight:700; letter-spacing:.3px; }

.wms-tab { padding:14px 20px; background:none; border:none; border-bottom:2.5px solid transparent; font-size:13px; font-weight:500; font-family:'DM Sans',sans-serif; color:var(--text-muted); cursor:pointer; transition:all .18s; white-space:nowrap; }
.wms-tab:hover { color:var(--text-secondary); }
.wms-tab[data-active="true"] { color:var(--accent); border-bottom-color:var(--accent); font-weight:700; }

.wms-select { padding:10px 32px 10px 14px; border:1.5px solid var(--border); border-radius:8px; font-size:14px; font-family:'DM Sans',sans-serif; background:var(--bg-input); color:var(--text-primary); cursor:pointer; outline:none; appearance:none; background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23555d6e' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E"); background-repeat:no-repeat; background-position:right 10px center; }

.wms-scrollbar::-webkit-scrollbar { width:6px; height:6px; }
.wms-scrollbar::-webkit-scrollbar-track { background:transparent; }
.wms-scrollbar::-webkit-scrollbar-thumb { background:var(--border); border-radius:3px; }

.alert-card { animation:slideUp .35s ease both; border-radius:12px; padding:18px 22px; border-left:4px solid; transition:transform .18s; }
.alert-card:hover { transform:translateX(2px); }
.bar-fill { height:100%; border-radius:3px; transform-origin:left; animation:barGrow .6s cubic-bezier(.22,1,.36,1) both; }

.col-filter-popup { position:absolute; top:100%; left:0; z-index:50; min-width:200px; max-width:280px; background:var(--bg-raised); border:1px solid var(--border); border-radius:10px; box-shadow:var(--shadow-popup); padding:8px; animation:dropIn .15s ease both; }
.col-filter-popup input[type="text"] { width:100%; padding:8px 10px; margin-bottom:6px; border:1px solid var(--border); border-radius:6px; font-size:12px; font-family:'DM Sans',sans-serif; background:var(--bg-surface); color:var(--text-primary); outline:none; }
.col-filter-popup input[type="text"]:focus { border-color:var(--accent); }
.col-filter-list { max-height:200px; overflow-y:auto; }
.col-filter-item { display:flex; align-items:center; gap:8px; padding:5px 8px; border-radius:5px; cursor:pointer; font-size:12px; color:var(--text-secondary); transition:background .1s; }
.col-filter-item:hover { background:var(--bg-hover); }
.col-filter-item input[type="checkbox"] { accent-color:var(--accent); width:14px; height:14px; cursor:pointer; }
.col-filter-actions { display:flex; gap:6px; padding-top:6px; margin-top:4px; border-top:1px solid var(--border); }
.col-filter-actions button { flex:1; padding:6px; border-radius:6px; border:none; font-size:11px; font-weight:600; cursor:pointer; font-family:inherit; }


/* Resizable columns */
.wms-table th.resizable { position:relative; }
.wms-table th.resizable .resize-handle {
  position:absolute; right:0; top:0; bottom:0; width:5px;
  cursor:col-resize; background:transparent; z-index:5;
}
.wms-table th.resizable .resize-handle:hover,
.wms-table th.resizable .resize-handle:active { background:var(--accent); opacity:.4; }

.stat-card { flex:1; min-width:140px; background:var(--bg-raised); border:1px solid var(--border); border-radius:12px; padding:18px 20px; animation:fadeIn .4s ease both; }
`;

// ─────────────────────────────────────────────
// ICONS
// ─────────────────────────────────────────────
const I = {
  warehouse: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 21V8l9-5 9 5v13"/><path d="M9 21V12h6v9"/></svg>,
  refresh: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>,
  search: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>,
  alert: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>,
  chart: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>,
  truck: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>,
  history: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>,
  logout: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>,
  upload: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>,
  check: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>,
  scanner: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><line x1="7" y1="12" x2="17" y2="12"/></svg>,
  chevronDown: <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6"/></svg>,
  filter: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>,
  sortAsc: <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 19V5M5 12l7-7 7 7"/></svg>,
  sortDesc: <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 5v14M5 12l7 7 7-7"/></svg>,
};

const TABS = [
  { key: "alerts", label: "Alertes stock", icon: I.alert },
  { key: "conso", label: "Consommation", icon: I.chart },
  { key: "deliveries", label: "Livraisons & Prépa.", icon: I.truck },
  { key: "moves", label: "Historique", icon: I.history },
] as const;

// ─────────────────────────────────────────────
// COLUMN FILTER DROPDOWN (Excel-like)
// ─────────────────────────────────────────────
function ColumnFilter({ values, selected, onApply, onClose, sortDir, onSort }: {
  values: string[]; selected: Set<string>; onApply: (s: Set<string>) => void; onClose: () => void; sortDir: SortDir; onSort: (d: SortDir) => void;
}) {
  const [search, setSearch] = useState("");
  const [local, setLocal] = useState<Set<string>>(new Set(selected));
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    document.addEventListener("mousedown", h); return () => document.removeEventListener("mousedown", h);
  }, [onClose]);
  const filtered = values.filter((v) => v.toLowerCase().includes(search.toLowerCase()));
  const allChecked = filtered.length > 0 && filtered.every((v) => local.has(v));

  // Enter in search box → select only matching items and apply immediately
  const applySearch = () => {
    if (search.trim()) {
      onApply(new Set(filtered));
    } else {
      onApply(local);
    }
    onClose();
  };

  return (
    <div className="col-filter-popup" ref={ref} onClick={(e) => e.stopPropagation()}>
      <div style={{ display: "flex", gap: 4, marginBottom: 6 }}>
        <button onClick={() => onSort(sortDir === "asc" ? null : "asc")} style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 4, padding: "6px", borderRadius: 6, border: "none", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", background: sortDir === "asc" ? "var(--accent-soft)" : "var(--bg-surface)", color: sortDir === "asc" ? "var(--accent)" : "var(--text-secondary)" }}>
          {I.sortAsc} A→Z
        </button>
        <button onClick={() => onSort(sortDir === "desc" ? null : "desc")} style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 4, padding: "6px", borderRadius: 6, border: "none", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", background: sortDir === "desc" ? "var(--accent-soft)" : "var(--bg-surface)", color: sortDir === "desc" ? "var(--accent)" : "var(--text-secondary)" }}>
          {I.sortDesc} Z→A
        </button>
      </div>
      <input type="text" placeholder="Rechercher (Entrée = filtrer)..." value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === "Enter" && applySearch()} autoFocus />
      <div className="col-filter-list wms-scrollbar">
        <label className="col-filter-item" style={{ fontWeight: 600, color: "var(--text-primary)" }}>
          <input type="checkbox" checked={allChecked} onChange={() => { const n = new Set(local); if (allChecked) filtered.forEach((v) => n.delete(v)); else filtered.forEach((v) => n.add(v)); setLocal(n); }} />
          (Tout sélectionner)
        </label>
        {filtered.map((v) => (
          <label key={v} className="col-filter-item">
            <input type="checkbox" checked={local.has(v)} onChange={() => { const n = new Set(local); if (n.has(v)) n.delete(v); else n.add(v); setLocal(n); }} />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v || "(vide)"}</span>
          </label>
        ))}
      </div>
      <div className="col-filter-actions">
        <button onClick={() => { onApply(new Set(values)); onClose(); }} style={{ background: "var(--bg-surface)", color: "var(--text-secondary)" }}>Réinitialiser</button>
        <button onClick={applySearch} style={{ background: "var(--accent)", color: "#fff" }}>Appliquer</button>
      </div>
    </div>
  );
}

function FilterableHeader({ label, colKey, values, filterState, setFilterState, sortState, setSortState, align }: {
  label: string; colKey: string; values: string[];
  filterState: Record<string, Set<string>>; setFilterState: React.Dispatch<React.SetStateAction<Record<string, Set<string>>>>;
  sortState: { col: string; dir: SortDir }; setSortState: React.Dispatch<React.SetStateAction<{ col: string; dir: SortDir }>>;
  align?: "center" | "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const unique = useMemo(() => Array.from(new Set(values)).sort(), [values]);
  const isFiltered = filterState[colKey] && filterState[colKey].size < unique.length;
  const sortDir = sortState.col === colKey ? sortState.dir : null;
  return (
    <th style={{ position: "relative", textAlign: align || "left" }}>
      <div className="th-inner" style={{ justifyContent: align === "center" ? "center" : "space-between" }} onClick={() => setOpen(!open)}>
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
          {label}
          {sortDir === "asc" && I.sortAsc}
          {sortDir === "desc" && I.sortDesc}
        </span>
        <span style={{ color: isFiltered ? "var(--accent)" : "var(--text-muted)", display: "flex", alignItems: "center", gap: 2 }}>
          {isFiltered && I.filter}
          {I.chevronDown}
        </span>
      </div>
      {open && <ColumnFilter values={unique} selected={filterState[colKey] || new Set(unique)} onApply={(s) => setFilterState((p) => ({ ...p, [colKey]: s }))} onClose={() => setOpen(false)} sortDir={sortDir} onSort={(d) => setSortState({ col: colKey, dir: d })} />}
    </th>
  );
}

// ─────────────────────────────────────────────
// SUB-COMPONENTS
// ─────────────────────────────────────────────
function Spinner({ size = 16 }: { size?: number }) {
  return <div style={{ width: size, height: size, border: `2px solid var(--border)`, borderTopColor: "var(--accent)", borderRadius: "50%", animation: "spin .7s linear infinite", flexShrink: 0 }} />;
}
function EmptyState({ icon, title, sub }: { icon: React.ReactNode; title: string; sub: string }) {
  return (
    <div style={{ textAlign: "center", padding: "60px 24px", animation: "fadeIn .4s ease both" }}>
      <div style={{ color: "var(--text-muted)", marginBottom: 12, opacity: .5 }}>{icon}</div>
      <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 13, color: "var(--text-muted)" }}>{sub}</div>
    </div>
  );
}
function StatCard({ label, value, color, delay = 0 }: { label: string; value: string | number; color: string; delay?: number }) {
  return (
    <div className="stat-card" style={{ animationDelay: `${delay}ms` }}>
      <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: "-.5px", lineHeight: 1.1, color }}>{value}</div>
      <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6, fontWeight: 500 }}>{label}</div>
    </div>
  );
}
function MiniBarChart({ data, max }: { data: number[]; max: number }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 48 }}>
      {data.map((v, i) => <div key={i} style={{ flex: 1, height: `${Math.max(max > 0 ? (v / max) * 100 : 0, 4)}%`, background: "var(--accent)", opacity: .3 + (max > 0 ? (v / max) * .7 : 0), borderRadius: "3px 3px 0 0", transition: "height .4s ease", minWidth: 3 }} />)}
    </div>
  );
}

// ═════════════════════════════════════════════
// MAIN DASHBOARD
// ═════════════════════════════════════════════
export default function Dashboard() {
  const [session, setSession] = useState<odoo.OdooSession | null>(null);
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [url, setUrl] = useState("");
  const [db, setDb] = useState("");
  const [user, setUser] = useState("");
  const [pw, setPw] = useState("");
  const [tab, setTab] = useState<string>("alerts");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [alerts, setAlerts] = useState<StockAlert[]>([]);
  const [thresholds, setThresholds] = useState<Record<number, number>>({});
  const [conso, setConso] = useState<ConsoRow[]>([]);
  const [deliveries, setDeliveries] = useState<DeliveryRow[]>([]);
  const [moves, setMoves] = useState<MoveRow[]>([]);
  const [stockMap, setStockMap] = useState<Record<number, StockProduct>>({});
  const [consoMonths, setConsoMonths] = useState(6);
  const [delStart, setDelStart] = useState(() => { const d = new Date(); d.setDate(1); return d.toISOString().split("T")[0]; });
  const [delEnd, setDelEnd] = useState(() => new Date().toISOString().split("T")[0]);
  const [moveRef, setMoveRef] = useState("");
  const [moveSearched, setMoveSearched] = useState(false);
  const [moveStart, setMoveStart] = useState("");
  const [moveEnd, setMoveEnd] = useState("");
  const [editThresh, setEditThresh] = useState<number | null>(null);
  const [editVal, setEditVal] = useState("");
  const [stockSearch, setStockSearch] = useState("");
  const [thresholdsByRef, setThresholdsByRef] = useState<Record<string, number>>({});
  const [avgMonthlyByRef, setAvgMonthlyByRef] = useState<Record<string, number>>({});
  const [watchlist, setWatchlist] = useState<Set<string>>(new Set());
  const [watchlistMode, setWatchlistMode] = useState(false);
  const [consoSearch, setConsoSearch] = useState("");

  // Excel-like column filter states
  const [moveColFilters, setMoveColFilters] = useState<Record<string, Set<string>>>({});
  const [moveColSort, setMoveColSort] = useState<{ col: string; dir: SortDir }>({ col: "date", dir: "desc" });
  const [delColFilters, setDelColFilters] = useState<Record<string, Set<string>>>({});
  const [delColSort, setDelColSort] = useState<{ col: string; dir: SortDir }>({ col: "date", dir: "desc" });
  const [delPickingType, setDelPickingType] = useState<"all" | "out" | "pick">("all");
  const [prepStats, setPrepStats] = useState<{ name: string; picking: number; emballage: number; total: number }[]>([]);
  const [prepStatsLoading, setPrepStatsLoading] = useState(false);
  const [consoColSort, setConsoColSort] = useState<{ col: string; dir: SortDir }>({ col: "total", dir: "desc" });
  const [alertsUnderstockOpen, setAlertsUnderstockOpen] = useState(true);
  const [alertsOverstockOpen, setAlertsOverstockOpen] = useState(true);
  const [alertsWarningOpen, setAlertsWarningOpen] = useState(true);

  useEffect(() => { const s = loadSession(); if (s) setSession(s); const cfg = loadCfg(); if (cfg) { setUrl(cfg.u); setDb(cfg.d); } }, []);
  // Load thresholds from Supabase on login
  useEffect(() => {
    if (!session) return;
    supa.loadThresholds().then(t => {
      setThresholdsByRef(t);
      setSupaReady(true);
    }).catch(e => {
      setSupaError("Supabase: " + e.message);
      try { const t = localStorage.getItem("wms_thresholds"); if (t) setThresholds(JSON.parse(t)); } catch (e) {}
    });
    // Load avg_monthly from Supabase
    supa.loadAvgMonthly().then(avg => { setAvgMonthlyByRef(avg); }).catch(() => {});
    // Load cache ages
    supa.getStockCacheAge().then(d => setStockSyncedAt(d));
    supa.getConsoCacheAge().then(d => setConsoSyncedAt(d));
    supa.loadWatchlist().then(w => { setWatchlist(w); if (w.size > 0) setWatchlistMode(true); }).catch(() => {});
  }, [session]);

  const login = async () => { if (!url || !db || !user || !pw) return; setLoginLoading(true); setLoginError(""); try { const s = await odoo.authenticate({ url, db }, user, pw); saveSession(s); setSession(s); } catch (e: any) { setLoginError(e.message); } setLoginLoading(false); };
  const logout = () => { clearSession(); setSession(null); setAlerts([]); setConso([]); setDeliveries([]); setMoves([]); };
  const [supaReady, setSupaReady] = useState(false);
  const [supaError, setSupaError] = useState("");
  const [stockSyncedAt, setStockSyncedAt] = useState<Date | null>(null);
  const [consoSyncedAt, setConsoSyncedAt] = useState<Date | null>(null);
  const [syncing, setSyncing] = useState(false);

  const saveThresholdsLocal = async (t: Record<number, number>) => {
    setThresholds(t);
    // Also persist to Supabase (fire and forget with error handling)
    try {
      const items = Object.entries(t).map(([pid, threshold]) => {
        const prod = stockMap[Number(pid)];
        return { odoo_ref: prod?.ref || String(pid), threshold, product_name: prod?.name || "" };
      }).filter(i => i.odoo_ref && i.odoo_ref !== "0");
      await supa.saveThresholdsBulk(items);
    } catch (e: any) { console.warn("Supabase save failed:", e.message); }
  };

  // ── DATA LOADERS (logic 100% identical to original) ──

  const loadAlerts = useCallback(async () => {
    if (!session) return; setLoading(true); setError("");
    try {
      // 1. Load current stock from Odoo
      const quants = await odoo.searchRead(session, "stock.quant", [
        ["location_id.usage", "=", "internal"], ["quantity", ">", 0]
      ], ["product_id", "quantity"], 5000);

      const byProduct: Record<number, { name: string; ref: string; qty: number }> = {};
      for (const q of quants) {
        const pid = q.product_id[0];
        if (!byProduct[pid]) byProduct[pid] = { name: q.product_id[1], ref: "", qty: 0 };
        byProduct[pid].qty += q.quantity;
      }
      const pids = Object.keys(byProduct).map(Number);
      if (pids.length) {
        const prods = await odoo.searchRead(session, "product.product", [["id", "in", pids]], ["id", "default_code"], 5000);
        for (const p of prods) if (byProduct[p.id]) byProduct[p.id].ref = p.default_code || "";
      }

      const stockData: Record<number, { qty: number; name: string; ref: string }> = {};
      for (const [id, v] of Object.entries(byProduct)) stockData[Number(id)] = v;
      setStockMap(stockData);
      setStockSyncedAt(new Date());

      // 2. Load stored conso from Supabase (last 3 months average)
      const now = new Date();
      const consoMonthsList: string[] = [];
      for (let i = 1; i <= 3; i++) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        consoMonthsList.push(d.toISOString().substring(0, 7));
      }
      const consoCache = await supa.loadConsoCache(consoMonthsList);
      const consoByRef: Record<string, number> = {};
      const consoCountByRef: Record<string, number> = {};
      for (const cc of consoCache) {
        if (!consoByRef[cc.odoo_ref]) { consoByRef[cc.odoo_ref] = 0; consoCountByRef[cc.odoo_ref] = 0; }
        consoByRef[cc.odoo_ref] += cc.qty;
        consoCountByRef[cc.odoo_ref]++;
      }
      // Average monthly then daily
      const consoAvgDaily: Record<string, number> = {};
      for (const ref of Object.keys(consoByRef)) {
        const months = consoCountByRef[ref] || 1;
        consoAvgDaily[ref] = (consoByRef[ref] / months) / 30;
      }

      // 3. Match thresholds + calculate days left
      const t: Record<number, number> = {};
      for (const [pid, data] of Object.entries(stockData)) {
        if (data.ref && thresholdsByRef[data.ref] !== undefined) t[Number(pid)] = thresholdsByRef[data.ref];
      }
      setThresholds(t);

      const alertList: StockAlert[] = [];
      for (const [pidStr, data] of Object.entries(stockData)) {
        const pid = Number(pidStr);
        const thresh = t[pid];
        const avgDaily = consoAvgDaily[data.ref] || 0;
        const consoAvg = avgDaily * 30; // monthly
        const daysLeft = avgDaily > 0 ? Math.round(data.qty / avgDaily) : 9999;

        if (watchlistMode && watchlist.size > 0 && !watchlist.has(data.ref)) continue;
        // Alert if: has threshold and below OR has conso and < 45 days left
        const belowThreshold = thresh !== undefined && data.qty <= thresh;
        const lowDays = avgDaily > 0 && daysLeft < 45;
        if (belowThreshold || lowDays) {
          alertList.push({ productId: pid, ref: data.ref, name: data.name, qty: data.qty, threshold: thresh || 0, consoAvg: Math.round(consoAvg), daysLeft });
        }
      }
      alertList.sort((a, b) => a.daysLeft - b.daysLeft);
      setAlerts(alertList);

      // Save stock cache
      const cacheItems = Object.entries(stockData).map(([id, v]) => ({
        odoo_product_id: Number(id), odoo_ref: v.ref, product_name: v.name, qty_on_hand: v.qty
      }));
      supa.saveStockCache(cacheItems).catch(() => {});
    } catch (e: any) { setError(e.message); } finally { setLoading(false); }
  }, [session, thresholdsByRef]);


  const loadConso = useCallback(async () => {
    if (!session) return; setLoading(true); setError("");
    try {
      const months = monthsBack(consoMonths);
      const startDate = months[0] + "-01 00:00:00";
      const endDate = new Date().toISOString().split("T")[0] + " 23:59:59";

      // Get location IDs (fiable vs filtres dotted ignorés par Odoo XML-RPC)
      const [custLocs, intLocs] = await Promise.all([
        odoo.searchRead(session, "stock.location", [["usage", "=", "customer"]], ["id"], 100),
        odoo.searchRead(session, "stock.location", [["usage", "=", "internal"]], ["id"], 500),
      ]);
      const custLocIds = custLocs.map((l: any) => l.id);
      const intLocIds = intLocs.map((l: any) => l.id);

      const domain: any[] = [
        ["state", "=", "done"],
        ["picking_code", "=", "outgoing"],
        ["date", ">=", startDate],
        ["date", "<=", endDate],
      ];

      if (consoSearch.trim()) {
        const prods = await odoo.searchRead(session, "product.product", [
          "|",
          ["default_code", "=ilike", "%" + consoSearch.trim() + "%"],
          ["name", "=ilike", "%" + consoSearch.trim() + "%"],
        ], ["id"], 50);
        const searchedProdIds = prods.map((p: any) => p.id);
        if (!searchedProdIds.length) { setConso([]); setLoading(false); return; }
        domain.push(["product_id", "in", searchedProdIds]);
      }

      // Use stock.move (not stock.move.line) for reliable consumption data
      // stock.move has state field and correct source/dest locations
      const allMoves = await odoo.searchRead(session, "stock.move", domain,
        ["product_id", "product_uom_qty", "quantity_done", "date"], 10000);

      const byProd: Record<number, { name: string; ref: string; months: Record<string, number> }> = {};
      for (const mv of allMoves) {
        const pid = mv.product_id[0];
        const month = (mv.date || "").substring(0, 7);
        if (!month) continue;
        const qty = mv.quantity_done > 0 ? mv.quantity_done : mv.product_uom_qty || 0;
        if (!byProd[pid]) byProd[pid] = { name: mv.product_id[1], ref: "", months: {} };
        byProd[pid].months[month] = (byProd[pid].months[month] || 0) + qty;
      }

      const prodIds = Object.keys(byProd).map(Number);
      if (prodIds.length) {
        const prods = await odoo.searchRead(session, "product.product", [["id", "in", prodIds]], ["id", "default_code"], 2000);
        for (const p of prods) if (byProd[p.id]) byProd[p.id].ref = p.default_code || "";
      }

      const rows: ConsoRow[] = Object.entries(byProd).map(([, v]) => ({
        ref: v.ref, name: v.name, months: v.months,
        total: Object.values(v.months).reduce((s, n) => s + n, 0), avg: 0,
      }));
      rows.sort((a, b) => b.total - a.total);
      rows.forEach(r => { r.avg = consoMonths > 0 ? Math.round(r.total / consoMonths) : 0; });
      setConso(rows);

      // Async: save to Supabase cache in background (don't block UI)
      const cacheItems: supa.WmsConsoCache[] = [];
      for (const row of rows) {
        for (const [month, qty] of Object.entries(row.months)) {
          cacheItems.push({ odoo_ref: row.ref, product_name: row.name, month, qty });
        }
      }
      supa.saveConsoCache(cacheItems).catch(() => {});
      setConsoSyncedAt(new Date());
    } catch (e: any) { setError(e.message); } finally { setLoading(false); }
  }, [session, consoMonths, consoSearch]);


  const loadDeliveries = useCallback(async () => {
    if (!session) return; setLoading(true); setError(""); setPrepStats([]);
    try {
      // Get picking type IDs for OUT and PICK
      const pickingTypes = await odoo.searchRead(session, "stock.picking.type", [["code", "in", ["outgoing", "internal"]]], ["id", "code", "sequence_code", "name"], 50);
      const outTypeIds = pickingTypes.filter((t: any) => t.code === "outgoing").map((t: any) => t.id);
      const pickTypeIds = pickingTypes.filter((t: any) => t.sequence_code?.toLowerCase().includes("pick") || t.name?.toLowerCase().includes("pick")).map((t: any) => t.id);

      // Load OUT pickings
      const outPickings = outTypeIds.length ? await odoo.searchRead(session, "stock.picking", [["state", "=", "done"], ["picking_type_id", "in", outTypeIds], ["date_done", ">=", delStart + " 00:00:00"], ["date_done", "<=", delEnd + " 23:59:59"]], ["name", "date_done", "partner_id", "move_ids", "user_id", "write_uid"], 2000, "date_done desc") : [];

      // Load PICK pickings
      const pickPickings = pickTypeIds.length ? await odoo.searchRead(session, "stock.picking", [["state", "=", "done"], ["picking_type_id", "in", pickTypeIds], ["date_done", ">=", delStart + " 00:00:00"], ["date_done", "<=", delEnd + " 23:59:59"]], ["name", "date_done", "move_ids", "user_id", "write_uid"], 2000, "date_done desc") : [];

      const allPickings = [...outPickings.map((p: any) => ({ ...p, pickKind: "out" })), ...pickPickings.map((p: any) => ({ ...p, pickKind: "pick" }))];

      const byDate: Record<string, { count: number; lines: number }> = {};
      for (const p of allPickings) {
        const date = (p.date_done || "").substring(0, 10);
        if (!byDate[date]) byDate[date] = { count: 0, lines: 0 };
        byDate[date].count++;
        byDate[date].lines += (p.move_ids || []).length;
      }
      setDeliveries(Object.entries(byDate).sort(([a], [b]) => b.localeCompare(a)).map(([date, v]) => ({ date, ...v })));

      // Stats préparateurs
      const prepByUser: Record<string, { picking: number; emballage: number }> = {};
      for (const p of allPickings) {
        const name = (p.user_id?.[1] || p.write_uid?.[1]) || "Inconnu";
        if (!prepByUser[name]) prepByUser[name] = { picking: 0, emballage: 0 };
        if (p.pickKind === "pick") prepByUser[name].picking++;
        else prepByUser[name].emballage++;
      }
      const stats = Object.entries(prepByUser).map(([name, v]) => ({ name, ...v, total: v.picking + v.emballage }))
        .sort((a, b) => b.total - a.total);
      setPrepStats(stats);
      setDelColFilters({});
    } catch (e: any) { setError(e.message); } finally { setLoading(false); }
  }, [session, delStart, delEnd]);

  const loadMoves = useCallback(async () => {
    if (!session) return;
    // Must have either a ref or a date range
    const hasRef = moveRef.trim().length > 0;
    const hasDate = moveStart || moveEnd;
    if (!hasRef && !hasDate) return;

    setLoading(true); setError(""); setMoveSearched(true);
    try {
      // Build domain
      const domain: any[] = [["state", "=", "done"]];

      // Optional: filter by product
      if (hasRef) {
        let prods = await odoo.searchRead(session, "product.product", [["default_code", "=ilike", moveRef.trim()]], ["id", "name", "default_code"], 5);
        if (!prods.length) prods = await odoo.searchRead(session, "product.product", [["barcode", "=", moveRef.trim()]], ["id", "name", "default_code"], 5);
        if (!prods.length) { setError(`Référence "${moveRef}" introuvable`); setMoves([]); setLoading(false); return; }
        domain.push(["product_id", "=", prods[0].id]);
      }
      if (moveStart) domain.push(["date", ">=", moveStart + " 00:00:00"]);
      if (moveEnd) domain.push(["date", "<=", moveEnd + " 23:59:59"]);

      const rawMoves = await odoo.searchRead(session, "stock.move", domain,
        ["date", "picking_id", "location_id", "location_dest_id", "product_qty", "lot_ids", "name", "product_id"], 10000, "date desc");

      // Get location usages
      const locIds = Array.from(new Set(rawMoves.flatMap((m: any) => [m.location_id?.[0], m.location_dest_id?.[0]]).filter(Boolean))) as number[];
      const locs = locIds.length ? await odoo.searchRead(session, "stock.location", [["id", "in", locIds]], ["id", "usage"], 200) : [];
      const locUsage: Record<number, string> = Object.fromEntries(locs.map((l: any) => [l.id, l.usage]));

      // Get partner names from pickings
      const pickingIds = Array.from(new Set(rawMoves.map((m: any) => m.picking_id?.[0]).filter(Boolean))) as number[];
      const pickings = pickingIds.length ? await odoo.searchRead(session, "stock.picking", [["id", "in", pickingIds]], ["id", "partner_id"], 500) : [];
      const pickingPartner: Record<number, string> = {};
      for (const p of pickings) { pickingPartner[p.id] = p.partner_id ? p.partner_id[1] : "—"; }

      // Get product refs if global search (no specific ref)
      let prodRefs: Record<number, string> = {};
      if (!hasRef) {
        const prodIds = Array.from(new Set(rawMoves.map((m: any) => m.product_id?.[0]).filter(Boolean))) as number[];
        if (prodIds.length) {
          const prods = await odoo.searchRead(session, "product.product", [["id", "in", prodIds]], ["id", "default_code"], 500);
          prodRefs = Object.fromEntries(prods.map((p: any) => [p.id, p.default_code || ""]));
        }
      }

      setMoves(rawMoves.map((m: any) => {
        const fromU = locUsage[m.location_id?.[0]] || ""; const toU = locUsage[m.location_dest_id?.[0]] || "";
        const type = fromU === "supplier" || (toU === "internal" && fromU !== "internal") ? "Entrée"
          : toU === "customer" || (fromU === "internal" && toU !== "internal") ? "Sortie" : "Interne";
        const pickId = m.picking_id?.[0];
        const prodName = m.product_id?.[1] || "—";
        const prodRef = hasRef ? "" : (prodRefs[m.product_id?.[0]] || "");
        const productLabel = prodRef ? `[${prodRef}] ${prodName}` : prodName;
        return {
          date: m.date, type, qty: m.product_qty,
          lot: Array.isArray(m.lot_ids) ? m.lot_ids.join(", ") || "—" : "—",
          from: m.location_id?.[1] || "—", to: m.location_dest_id?.[1] || "—",
          picking: m.picking_id?.[1] || "—",
          partner: pickId ? (pickingPartner[pickId] || "—") : "—",
          product: productLabel,
        };
      }));
      setMoveColFilters({}); setMoveColSort({ col: "date", dir: "desc" });
    } catch (e: any) { setError(e.message); } finally { setLoading(false); }
  }, [session, moveRef, moveStart, moveEnd]);

  useEffect(() => { if (!session) return; if (tab === "alerts") { loadAlerts(); if (conso.length === 0) loadConso(); } if (tab === "conso") loadConso(); if (tab === "deliveries") loadDeliveries(); }, [tab, session]);

  // ── Computed ──
  const months = useMemo(() => monthsBack(consoMonths), [consoMonths]);
  const filteredMoves = useMemo(() => {
    let r = [...moves];
    for (const [col, allowed] of Object.entries(moveColFilters)) {
      if (!allowed.size) continue;
      r = r.filter((m) => {
        const v = col === "date" ? fmtDate(m.date) : col === "qty" ? String(m.qty) : (m as any)[col] || "";
        return allowed.has(v);
      });
    }
    if (moveColSort.dir) {
      const d = moveColSort.dir === "asc" ? 1 : -1;
      const c = moveColSort.col;
      r.sort((a, b) => c === "qty" ? d * (a.qty - b.qty) : d * String(c === "date" ? a.date : (a as any)[c] || "").localeCompare(String(c === "date" ? b.date : (b as any)[c] || "")));
    }
    return r;
  }, [moves, moveColFilters, moveColSort]);

  const filteredDel = useMemo(() => {
    let r = [...deliveries];
    for (const [col, allowed] of Object.entries(delColFilters)) { if (!allowed.size) continue; r = r.filter((d) => { const v = col === "date" ? fmtDate(d.date) : col === "count" ? String(d.count) : String(d.lines); return allowed.has(v); }); }
    if (delColSort.dir) { const d = delColSort.dir === "asc" ? 1 : -1; r.sort((a, b) => delColSort.col === "count" ? d * (a.count - b.count) : delColSort.col === "lines" ? d * (a.lines - b.lines) : d * a.date.localeCompare(b.date)); }
    return r;
  }, [deliveries, delColFilters, delColSort]);

  const sortedConso = useMemo(() => {
    let r = [...conso];
    if (consoColSort.dir) { const d = consoColSort.dir === "asc" ? 1 : -1; const c = consoColSort.col; r.sort((a, b) => c === "ref" ? d * (a.ref || "").localeCompare(b.ref || "") : c === "name" ? d * a.name.localeCompare(b.name) : c === "avg" ? d * (a.avg - b.avg) : c === "total" ? d * (a.total - b.total) : d * ((a.months[c] || 0) - (b.months[c] || 0))); }
    return r;
  }, [conso, consoColSort]);

  const MONO = "'JetBrains Mono', monospace";

  // ═══════════════════════════════════════
  // LOGIN
  // ═══════════════════════════════════════
  if (!session) return (
    <div className="wms-root" data-theme="light"><style>{GLOBAL_CSS}</style>
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
<div style={{ width: "100%", maxWidth: 420, padding: 24, animation: "fadeIn .5s ease both" }}>
          <div style={{ textAlign: "center", marginBottom: 36 }}>
            <div style={{ width: 56, height: 56, borderRadius: 12, background: "linear-gradient(135deg,var(--accent),#6366f1)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 18px", boxShadow: "0 8px 32px var(--accent-soft)", color: "#fff" }}>{I.warehouse}</div>
            <h1 style={{ fontSize: 24, fontWeight: 800, letterSpacing: "-.3px", marginBottom: 4 }}>WMS Dashboard</h1>
            <p style={{ fontSize: 14, color: "var(--text-muted)" }}>Rapports & Alertes stock · Odoo</p>
          </div>
          <div className="wms-card" style={{ padding: 28 }}>
            {[{ l: "URL Odoo", v: url, s: setUrl, p: "https://odoo.example.com" }, { l: "Base de données", v: db, s: setDb, p: "nom_base" }, { l: "Identifiant", v: user, s: setUser, p: "admin@company.com" }, { l: "Mot de passe", v: pw, s: setPw, p: "••••••••", t: "password" }].map((f) => (
              <div key={f.l} style={{ marginBottom: 16 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", display: "block", marginBottom: 6, letterSpacing: ".3px" }}>{f.l}</label>
                <input className="wms-input" type={f.t || "text"} value={f.v} onChange={(e) => f.s(e.target.value)} placeholder={f.p} onKeyDown={(e) => e.key === "Enter" && login()} />
              </div>
            ))}
            {loginError && <div style={{ background: "var(--danger-soft)", border: "1px solid var(--danger-border)", borderRadius: 8, padding: "10px 14px", fontSize: 13, color: "var(--danger)", marginBottom: 14 }}>{loginError}</div>}
            <button className="wms-btn wms-btn-primary" onClick={login} disabled={loginLoading} style={{ width: "100%", justifyContent: "center", padding: 14, fontSize: 15 }}>{loginLoading ? <Spinner /> : null} {loginLoading ? "Connexion..." : "Se connecter"}</button>
          </div>
        </div>
      </div>
    </div>
  );

  // ═══════════════════════════════════════
  // MAIN
  // ═══════════════════════════════════════
  return (
    <div className="wms-root" data-theme="light"><style>{GLOBAL_CSS}</style>

      {/* HEADER */}
      <header style={{ background: "var(--bg-raised)", borderBottom: "1px solid var(--border)", padding: "0 28px", display: "flex", alignItems: "center", justifyContent: "space-between", height: 60, position: "sticky", top: 0, zIndex: 20 }}>
        <a href="/" style={{ display: "flex", alignItems: "center", gap: 14, textDecoration: "none", color: "inherit" }}>
          <div style={{ width: 34, height: 34, borderRadius: 8, background: "linear-gradient(135deg,var(--accent),#6366f1)", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", flexShrink: 0 }}>{I.warehouse}</div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 800, letterSpacing: "-.2px", lineHeight: 1.2 }}>WMS Dashboard</div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: MONO }}>{session.name} · {session.config?.url?.replace("https://", "")}</div>
          </div>
        </a>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
<a href="/" className="wms-btn wms-btn-ghost" style={{ textDecoration: "none", padding: "8px 14px", fontSize: 13 }}>{I.scanner} Scanner</a>
          <button className="wms-btn wms-btn-danger" onClick={logout} style={{ padding: "8px 14px", fontSize: 13 }}>{I.logout} Déco.</button>
        </div>
      </header>

      {/* TABS */}
      <nav style={{ background: "var(--bg-raised)", borderBottom: "1px solid var(--border)", padding: "0 28px", display: "flex", gap: 2, overflowX: "auto" }} className="wms-scrollbar">
        {TABS.map((t) => <button key={t.key} className="wms-tab" data-active={tab === t.key} onClick={() => setTab(t.key)}><span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>{t.icon} {t.label}</span></button>)}
      </nav>

      {/* CONTENT */}
      <main style={{ maxWidth: 1260, margin: "0 auto", padding: "28px 28px 60px" }}>
        {supaError && <div style={{ background: "var(--warning-soft)", border: "1px solid var(--warning-border)", borderRadius: 12, padding: "10px 16px", fontSize: 13, color: "var(--warning)", marginBottom: 12 }}>⚠ {supaError} — mode dégradé localStorage</div>}
        {error && <div style={{ background: "var(--danger-soft)", border: "1px solid var(--danger-border)", borderRadius: 12, padding: "14px 18px", fontSize: 14, color: "var(--danger)", marginBottom: 24, display: "flex", alignItems: "center", gap: 10, animation: "fadeIn .3s ease both" }}>{I.alert}<span style={{ flex: 1 }}>{error}</span><button onClick={() => setError("")} style={{ background: "none", border: "none", color: "var(--danger)", cursor: "pointer", fontSize: 18, padding: 4 }}>×</button></div>}

        {/* ══════════ ALERTES ══════════ */}
        {tab === "alerts" && (() => {
          // Compute overstock items (>180 days of stock based on conso)
          const OVERSTOCK_DAYS = 180;
          const overstockItems = Object.entries(stockMap)
            .map(([pidStr, data]) => {
              const pid = Number(pidStr);
              const thresh = thresholds[pid];
              if (thresh === undefined) return null;
              if (data.qty <= thresh) return null; // already in alert, skip
              const consoRow = conso.find((c) => c.ref === data.ref);
              const dailyAvg = consoRow ? consoRow.avg / 30 : 0;
              if (dailyAvg <= 0) return null;
              const daysOfStock = Math.round(data.qty / dailyAvg);
              if (daysOfStock <= OVERSTOCK_DAYS) return null;
              return { pid, ref: data.ref, name: data.name, qty: data.qty, thresh, daysOfStock, avg: consoRow!.avg };
            })
            .filter(Boolean) as { pid: number; ref: string; name: string; qty: number; thresh: number; daysOfStock: number; avg: number }[];
          overstockItems.sort((a, b) => b.daysOfStock - a.daysOfStock);

          return (
          <div style={{ animation: "fadeIn .3s ease both" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 28, flexWrap: "wrap", gap: 12 }}>
              <div><h2 style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-.3px", marginBottom: 4 }}>Alertes stock</h2><p style={{ fontSize: 13, color: "var(--text-muted)" }}>Seuils min. configurables — jours restants estimés via la consommation moyenne</p></div>
              <button className="wms-btn wms-btn-primary" onClick={async () => { await loadAlerts(); if (conso.length === 0) await loadConso(); }} disabled={loading}>{loading ? <Spinner /> : I.refresh} Actualiser</button>
            </div>

            {(() => {
              // Split alerts: critical (< 25% seuil or < 7j), warning (7-30j), ok
              const criticalAlerts = alerts.filter(a => { const avg = avgMonthlyByRef[a.ref] || (conso.find(c => c.ref === a.ref)?.avg || 0); const d = avg / 30; const days = d > 0 ? Math.round(a.qty / d) : null; return days === null || days <= 7 || a.qty / a.threshold <= 0.25; });
              const warningAlerts = alerts.filter(a => !criticalAlerts.includes(a));

              const AccordionSection = ({ open, onToggle, color, dot, pulseAnim, title, count, children }: any) => (
                <div style={{ marginBottom: 12 }}>
                  <button onClick={onToggle} style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: open ? "10px 10px 0 0" : 10, cursor: "pointer", fontFamily: "inherit", transition: "border-radius .2s" }}>
                    <div style={{ width: 8, height: 8, borderRadius: "50%", background: color, flexShrink: 0, animation: pulseAnim ? "pulse-dot 1.5s ease-in-out infinite" : "none" }} />
                    <span style={{ fontSize: 12, fontWeight: 700, color, textTransform: "uppercase", letterSpacing: ".8px", flex: 1, textAlign: "left" }}>{title}</span>
                    <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-muted)", fontFamily: MONO }}>{count} article{count > 1 ? "s" : ""}</span>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2.5" style={{ transform: open ? "rotate(180deg)" : "rotate(0)", transition: "transform .2s", flexShrink: 0 }}><path d="M6 9l6 6 6-6"/></svg>
                  </button>
                  {open && <div style={{ border: "1px solid var(--border)", borderTop: "none", borderRadius: "0 0 10px 10px", padding: "12px", display: "grid", gap: 8 }}>{children}</div>}
                </div>
              );

              const AlertCard = ({ a }: { a: typeof alerts[0] }) => {
                const daysLeft = a.daysLeft;
                const color = daysLeft <= 7 ? "var(--danger)" : daysLeft <= 21 ? "var(--warning)" : "var(--orange)";
                const bg = daysLeft <= 7 ? "var(--danger-soft)" : daysLeft <= 21 ? "var(--warning-soft)" : "rgba(249,115,22,.06)";
                const daysLabel = daysLeft >= 9999 ? "—" : daysLeft <= 0 ? "Rupture !" : `${daysLeft}j`;
                const ratio = a.threshold > 0 ? a.qty / a.threshold : 1;
                return (
                  <div style={{ background: bg, borderLeft: `3px solid ${color}`, borderRadius: 8, padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                    <div style={{ flex: 1, minWidth: 200 }}>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{a.ref && <span style={{ fontFamily: MONO, color: "var(--accent)", marginRight: 8, fontSize: 11 }}>[{a.ref}]</span>}{a.name}</div>
                      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 12, color: "var(--text-secondary)", marginTop: 4 }}>
                        <span>Stock : <strong style={{ color }}>{a.qty}</strong></span>
                        {a.consoAvg > 0 && <span>Conso : <strong>{a.consoAvg}/mois</strong></span>}
                        {a.threshold > 0 && <span>Seuil : <strong>{a.threshold}</strong></span>}
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
                      <div style={{ height: 6, width: 80, background: "rgba(128,128,128,.15)", borderRadius: 3, overflow: "hidden" }}>
                        <div style={{ height: "100%", width: `${Math.min(ratio * 100, 100)}%`, background: color, borderRadius: 3 }} />
                      </div>
                      <span style={{ fontSize: 13, fontWeight: 800, color, fontFamily: MONO, minWidth: 52, textAlign: "right" }}>{daysLabel}</span>
                    </div>
                  </div>
                );
              };

              return <>
                {criticalAlerts.length > 0 && (
                  <AccordionSection open={alertsUnderstockOpen} onToggle={() => setAlertsUnderstockOpen(o => !o)} color="var(--danger)" dot pulseAnim title="Critique — rupture imminente" count={criticalAlerts.length}>
                    {criticalAlerts.map(a => <AlertCard key={a.productId} a={a} />)}
                  </AccordionSection>
                )}
                {warningAlerts.length > 0 && (
                  <AccordionSection open={alertsWarningOpen} onToggle={() => setAlertsWarningOpen(o => !o)} color="var(--warning)" dot={false} pulseAnim={false} title="Attention — stock bas" count={warningAlerts.length}>
                    {warningAlerts.map(a => <AlertCard key={a.productId} a={a} />)}
                  </AccordionSection>
                )}
                {overstockItems.length > 0 && (
                  <AccordionSection open={alertsOverstockOpen} onToggle={() => setAlertsOverstockOpen(o => !o)} color="var(--purple)" dot={false} pulseAnim={false} title={`Stock conséquent (>${OVERSTOCK_DAYS}j)`} count={overstockItems.length}>
                    {overstockItems.map(item => (
                      <div key={item.pid} style={{ background: "var(--purple-soft)", borderLeft: "3px solid var(--purple-border)", borderRadius: 8, padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                        <div style={{ flex: 1, minWidth: 200 }}>
                          <div style={{ fontSize: 13, fontWeight: 600 }}>{item.ref && <span style={{ fontFamily: MONO, color: "var(--accent)", marginRight: 8, fontSize: 11 }}>[{item.ref}]</span>}{item.name}</div>
                          <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4, display: "flex", gap: 16, flexWrap: "wrap" }}>
                            <span>Stock : <strong style={{ color: "var(--text-secondary)" }}>{item.qty}</strong></span>
                            <span>Seuil : <strong>{item.thresh}</strong></span>
                            <span>Moy : <strong>{item.avg}/mois</strong></span>
                          </div>
                        </div>
                        <div style={{ textAlign: "right", flexShrink: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--purple)", fontFamily: MONO }}>{item.daysOfStock}j de stock</div>
                          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>+{item.daysOfStock - OVERSTOCK_DAYS}j au-dessus</div>
                        </div>
                      </div>
                    ))}
                  </AccordionSection>
                )}
                {alerts.length === 0 && overstockItems.length === 0 && Object.keys(stockMap).length > 0 && (
                  <div style={{ background: "var(--success-soft)", border: "1px solid var(--success-border)", borderRadius: 12, padding: "22px 28px", marginBottom: 28, display: "flex", alignItems: "center", gap: 16, animation: "fadeIn .4s ease both" }}>
                    {I.check}<div><div style={{ fontSize: 15, fontWeight: 700, color: "var(--success)" }}>Tous les stocks sont OK</div><div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 2 }}>Aucun article en sous-stock ou surstock.</div></div>
                  </div>
                )}
              </>;
            })()}
            {/* Threshold manager */}
            <div className="wms-card" style={{ padding: 24 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 10 }}>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 700 }}>Gérer les seuils</div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
                    Seuil = conso 12 mois ÷ 12.
                    {watchlist.size > 0 && <span style={{ marginLeft: 8, color: "var(--accent)", fontWeight: 600 }}>📋 {watchlist.size} produits en surveillance</span>}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {/* Toggle watchlist mode */}
                  <button className="wms-btn" onClick={() => setWatchlistMode(m => !m)} style={{ padding: "8px 14px", fontSize: 13, background: watchlistMode ? "var(--accent-soft)" : "var(--bg-surface)", color: watchlistMode ? "var(--accent)" : "var(--text-muted)", border: `1px solid ${watchlistMode ? "var(--accent-border)" : "var(--border)"}` }}>
                    {watchlistMode ? "📋 Watchlist ON" : "📋 Tout afficher"}
                  </button>
                  {/* Upload watchlist Excel */}
                  <label className="wms-btn" style={{ background: "var(--accent-soft)", color: "var(--accent)", border: "1px solid var(--accent-border)", cursor: "pointer", padding: "8px 14px", fontSize: 13 }}>
                    📥 Ma liste produits
                    <input type="file" accept=".xlsx,.xls,.csv" style={{ display: "none" }} onChange={async (e) => {
                      const file = e.target.files?.[0]; if (!file) return;
                      try {
                        const XLSX = await import("xlsx");
                        const data = await file.arrayBuffer();
                        const wb = XLSX.read(data, { type: "array" });
                        const ws = wb.Sheets[wb.SheetNames[0]];
                        const rows: any[] = XLSX.utils.sheet_to_json(ws, { header: 1 });
                        // Col A = ref (skip header if text)
                        const items: supa.WmsWatchlistItem[] = [];
                        for (const row of rows) {
                          const ref = String(row[0] || "").trim();
                          if (!ref || ref.toLowerCase() === "ref" || ref.toLowerCase() === "référence") continue;
                          const name = String(row[1] || "").trim();
                          // Find product name from stockMap if not provided
                          const fromStock = Object.values(stockMap).find(s => s.ref === ref);
                          items.push({ odoo_ref: ref, product_name: name || fromStock?.name || "" });
                        }
                        await supa.saveWatchlist(items);
                        const newSet = new Set(items.map(i => i.odoo_ref));
                        setWatchlist(newSet);
                        setWatchlistMode(true);
                        alert(`✓ ${items.length} produit(s) chargés en surveillance.\nMode watchlist activé.`);
                        loadAlerts();
                      } catch (err: any) { alert("Erreur: " + err.message); }
                      e.target.value = "";
                    }} />
                  </label>
                  {/* Calculer et figer les seuils sur 12 mois */}
                  <button className="wms-btn" onClick={async () => {
                    if (!session) return;
                    setLoading(true); setError("");
                    try {
                      // MÊME LOGIQUE QUE loadConso — copie exacte
                      const ms = monthsBack(12);
                      const sd = ms[0] + "-01 00:00:00";
                      const ed = new Date().toISOString().split("T")[0] + " 23:59:59";

                      const [custLocs, intLocs] = await Promise.all([
                        odoo.searchRead(session, "stock.location", [["usage", "=", "customer"]], ["id"], 100),
                        odoo.searchRead(session, "stock.location", [["usage", "=", "internal"]], ["id"], 500),
                      ]);
                      const custLocIds = custLocs.map((l: any) => l.id);
                      const intLocIds = intLocs.map((l: any) => l.id);

                      // Récupère les product IDs depuis stockMap (filtrés watchlist si active)
                      const relevantRefs = watchlistMode && watchlist.size > 0
                        ? Array.from(watchlist)
                        : Object.values(stockMap).map(s => s.ref).filter(Boolean);

                      // Trouve les product IDs Odoo pour ces refs
                      const refChunks: string[][] = [];
                      for (let i = 0; i < relevantRefs.length; i += 100) refChunks.push(relevantRefs.slice(i, i + 100));

                      const byPid: Record<number, number> = {};

                      for (const chunk of refChunks) {
                        const prodsChunk = await odoo.searchRead(session, "product.product", [["default_code", "in", chunk]], ["id", "default_code"], chunk.length + 10);
                        const chunkPids = prodsChunk.map((p: any) => p.id);
                        if (!chunkPids.length) continue;

                        // Pour chaque chunk de produits, requête sur 12 mois d'un coup
                        const pickTypes = await odoo.searchRead(session, "stock.picking.type", [["code", "=", "outgoing"]], ["id"], 10);
                        const ptIds = pickTypes.map((pt: any) => pt.id);
                        const moves = await odoo.searchRead(session, "stock.move", [
                          ["state", "=", "done"],
                          ["product_id", "in", chunkPids],
                          ["picking_type_id", "in", ptIds],
                          ["date", ">=", sd],
                          ["date", "<=", ed],
                        ], ["product_id", "quantity_done", "product_uom_qty"], 10000);

                        for (const mv of moves) {
                          const qty = mv.quantity_done > 0 ? mv.quantity_done : mv.product_uom_qty || 0;
                          byPid[mv.product_id[0]] = (byPid[mv.product_id[0]] || 0) + qty;
                        }
                      }

                      // Refs + noms
                      const pids = Object.keys(byPid).map(Number);
                      const prods = pids.length ? await odoo.searchRead(session, "product.product", [["id", "in", pids]], ["id", "default_code", "name"], 2000) : [];
                      const prodMap: Record<number, { ref: string; name: string }> = Object.fromEntries(prods.map((p: any) => [p.id, { ref: p.default_code || "", name: p.name || "" }]));

                      // seuil = total 12 mois / 12 (= avg mensuel, identique à loadConso)
                      const supaItems: supa.WmsThreshold[] = [];
                      const nt: Record<number, number> = {};
                      for (const [pidStr, total] of Object.entries(byPid)) {
                        const pid = Number(pidStr);
                        const info = prodMap[pid];
                        if (!info?.ref) continue;
                        const seuil = Math.max(1, Math.round(total / 12));
                        nt[pid] = seuil;
                        supaItems.push({ odoo_ref: info.ref, threshold: seuil, product_name: info.name });
                      }

                      // Save to Supabase
                      await supa.saveThresholdsBulk(supaItems);
                      // Save avg_monthly
                      const avgItems: Record<string, number> = {};
                      for (const item of supaItems) avgItems[item.odoo_ref] = item.threshold;
                      await supa.saveAvgMonthlyBulk(avgItems);
                      setAvgMonthlyByRef(avgItems);
                      setThresholds(nt);
                      // Update thresholdsByRef
                      const newByRef: Record<string, number> = {};
                      for (const item of supaItems) newByRef[item.odoo_ref] = item.threshold;
                      setThresholdsByRef(newByRef);

                      alert(`✓ ${supaItems.length} seuils calculés et figés dans Supabase.\nFormule : conso 12 mois ÷ 12 = 1 mois de stock moyen.`);
                      loadAlerts();
                    } catch (e: any) { setError(e.message); }
                    finally { setLoading(false); }
                  }} disabled={loading} style={{ background: "var(--success-soft)", color: "var(--success)", border: "1px solid var(--success-border)", padding: "8px 14px", fontSize: 13 }}>
                    {loading ? <Spinner /> : "⚡"} Calculer & figer seuils
                  </button>
                  <label className="wms-btn" style={{ background: "var(--purple-soft)", color: "var(--purple)", border: "1px solid var(--purple-border)", cursor: "pointer", padding: "8px 14px", fontSize: 13 }}>
                    {I.upload} Importer Excel
                    <input type="file" accept=".xlsx,.xls,.csv" style={{ display: "none" }} onChange={async (e) => {
                      const file = e.target.files?.[0]; if (!file) return;
                      try { const XLSX = await import("xlsx"); const data = await file.arrayBuffer(); const wb = XLSX.read(data, { type: "array" }); const ws = wb.Sheets[wb.SheetNames[0]]; const rows: any[] = XLSX.utils.sheet_to_json(ws, { header: 1 }); const nt = { ...thresholds }; let imp = 0; for (const row of rows) { const ref = String(row[0] || "").trim(); const val = Number(row[1]); if (!ref || isNaN(val) || val < 0) continue; const match = Object.entries(stockMap).find(([, d]) => d.ref === ref); if (match) { nt[Number(match[0])] = val; imp++; } } saveThresholdsLocal(nt); alert(`${imp} seuil(s) importé(s)`); } catch { alert("Erreur lecture Excel"); } e.target.value = "";
                    }} />
                  </label>
                  {/* Export thresholds */}
                  <button className="wms-btn wms-btn-ghost" onClick={() => {
                    const lines = Object.entries(thresholds).map(([pid, thresh]) => {
                      const p = stockMap[Number(pid)];
                      return p ? `${p.ref}\t${thresh}\t${p.name}` : null;
                    }).filter(Boolean);
                    if (!lines.length) { alert("Aucun seuil défini"); return; }
                    const text = "Référence\tSeuil\tNom\n" + lines.join("\n");
                    navigator.clipboard.writeText(text).then(() => alert(`${lines.length} seuil(s) copiés dans le presse-papier`));
                  }} style={{ padding: "8px 14px", fontSize: 13 }}>
                    📋 Copier
                  </button>
                </div>
              </div>
              <input className="wms-input" value={stockSearch} onChange={(e) => setStockSearch(e.target.value)} placeholder="Filtrer par référence ou nom..." style={{ marginBottom: 16 }} />
              <div className="wms-scrollbar" style={{ maxHeight: 420, overflowY: "auto" }}>
                {Object.keys(stockMap).length === 0 && !loading && <EmptyState icon={I.refresh} title='Cliquez sur "Actualiser"' sub="pour charger les produits" />}
                {Object.entries(stockMap)
                  .filter(([, d]) => !watchlistMode || watchlist.size === 0 || watchlist.has(d.ref))
                  .filter(([, d]) => !stockSearch || d.ref.toLowerCase().includes(stockSearch.toLowerCase()) || d.name.toLowerCase().includes(stockSearch.toLowerCase()))
                  .map(([pidStr, data]) => {
                  const pid = Number(pidStr); const { qty, name, ref } = data; const thresh = thresholds[pid]; const isAlert = thresh !== undefined && qty <= thresh;
                  const consoRow = conso.find((c) => c.ref === ref);
                  const suggestedThresh = consoRow && consoRow.avg > 0 ? consoRow.avg : null;
                  return (
                    <div key={pid} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 0", borderBottom: "1px solid var(--border)" }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: thresh !== undefined ? 600 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {ref && <span style={{ fontFamily: MONO, color: "var(--accent)", fontWeight: 700, marginRight: 8, fontSize: 12 }}>[{ref}]</span>}{name}
                        </div>
                        <div style={{ fontSize: 12, color: isAlert ? "var(--danger)" : "var(--text-muted)", marginTop: 2 }}>
                          Stock : <strong>{qty}</strong>
                          {thresh !== undefined && ` · Seuil : ${thresh}`}
                          {suggestedThresh && thresh === undefined && <span style={{ marginLeft: 8, color: "var(--text-muted)" }}>conso moy: {suggestedThresh}/mois</span>}
                          {isAlert && <span style={{ marginLeft: 8, color: "var(--danger)", fontWeight: 700 }}>● Alerte</span>}
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 6, flexShrink: 0, alignItems: "center" }}>
                        {editThresh === pid ? (
                          <>
                            <input className="wms-input" value={editVal} onChange={(e) => setEditVal(e.target.value)} type="number" min="0" style={{ width: 80, padding: "6px 10px" }} autoFocus onKeyDown={(e) => { if (e.key === "Enter") { const v = Number(editVal); if (!isNaN(v) && v >= 0) saveThresholdsLocal({ ...thresholds, [pid]: v }); setEditThresh(null); } if (e.key === "Escape") setEditThresh(null); }} />
                            {suggestedThresh && <button className="wms-btn" onClick={() => setEditVal(String(suggestedThresh))} title={`= 1 mois conso (${suggestedThresh})`} style={{ padding: "6px 8px", fontSize: 11, background: "var(--accent-soft)", color: "var(--accent)", border: "1px solid var(--accent-border)" }}>⚡</button>}
                            <button className="wms-btn" onClick={() => { const v = Number(editVal); if (!isNaN(v) && v >= 0) saveThresholdsLocal({ ...thresholds, [pid]: v }); setEditThresh(null); }} style={{ background: "var(--success)", color: "#fff", padding: "6px 10px", fontSize: 13 }}>✓</button>
                            <button className="wms-btn wms-btn-danger" onClick={async () => { const t = { ...thresholds }; const ref = stockMap[pid]?.ref; delete t[pid]; setThresholds(t); if (ref) { try { await supa.deleteThreshold(ref); } catch {} } setEditThresh(null); }} style={{ padding: "6px 10px", fontSize: 12 }}>✕</button>
                          </>
                        ) : (
                          <button className="wms-btn" onClick={() => { setEditThresh(pid); setEditVal(thresh !== undefined ? String(thresh) : suggestedThresh ? String(suggestedThresh) : ""); }} style={{ flexShrink: 0, padding: "6px 14px", fontSize: 12, fontWeight: thresh !== undefined ? 700 : 400, fontFamily: thresh !== undefined ? MONO : "inherit", background: thresh !== undefined ? (isAlert ? "var(--danger-soft)" : "var(--warning-soft)") : "var(--bg-surface)", color: thresh !== undefined ? (isAlert ? "var(--danger)" : "var(--warning)") : "var(--text-muted)", border: `1px solid ${thresh !== undefined ? (isAlert ? "var(--danger-border)" : "var(--warning-border)") : "var(--border)"}` }}>
                            {thresh !== undefined ? `Seuil: ${thresh}` : suggestedThresh ? `+ ${suggestedThresh}` : "+ Seuil"}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
          );
        })()}

        {/* ══════════ CONSO ══════════ */}
        {tab === "conso" && (
          <div style={{ animation: "fadeIn .3s ease both" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 12 }}>
              <div><h2 style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-.3px", marginBottom: 4 }}>Consommation mensuelle</h2><p style={{ fontSize: 13, color: "var(--text-muted)" }}>Quantités sorties vers clients (hors transferts internes)</p></div>
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <select className="wms-select" value={consoMonths} onChange={(e) => setConsoMonths(Number(e.target.value))}>{[3, 6, 9, 12].map((n) => <option key={n} value={n}>{n} mois</option>)}</select>
                <button className="wms-btn wms-btn-primary" onClick={loadConso} disabled={loading}>{loading ? <Spinner /> : I.refresh} Charger</button>
                {conso.length > 0 && (
                  <button className="wms-btn wms-btn-ghost" onClick={async () => {
                    const XLSX = await import("xlsx");
                    const rows = sortedConso.map(r => {
                      const obj: any = { "Référence": r.ref, "Désignation": r.name };
                      months.forEach(m => { obj[fmtMonth(m)] = r.months[m] || 0; });
                      obj["Moy/mois"] = r.avg; obj["Total"] = r.total;
                      return obj;
                    });
                    const ws = XLSX.utils.json_to_sheet(rows);
                    const wb = XLSX.utils.book_new();
                    XLSX.utils.book_append_sheet(wb, ws, "Conso");
                    XLSX.writeFile(wb, `conso_${consoMonths}mois_${new Date().toISOString().split("T")[0]}.xlsx`);
                  }} style={{ padding: "10px 14px", fontSize: 13 }}>📥 Export Excel</button>
                )}
              </div>
            </div>
            <input className="wms-input" value={consoSearch} onChange={(e) => setConsoSearch(e.target.value)} onKeyDown={(e) => e.key === "Enter" && loadConso()} placeholder="Référence ou nom produit (Entrée pour chercher, vide = tout)..." style={{ marginBottom: 16 }} />
            {conso.length > 0 && (
              <div className="wms-card"><div className="wms-scrollbar" style={{ overflowX: "auto" }}>
                <table className="wms-table">
                  <thead><tr>
                    {[{ k: "ref", l: "Référence" }, { k: "name", l: "Désignation" }].map((h) => (
                      <th key={h.k} style={{ position: h.k === "ref" ? "sticky" as const : undefined, left: h.k === "ref" ? 0 : undefined, zIndex: h.k === "ref" ? 3 : 2 }}>
                        <div className="th-inner" onClick={() => setConsoColSort((p) => ({ col: h.k, dir: p.col === h.k ? (p.dir === "desc" ? "asc" : p.dir === "asc" ? null : "desc") : "desc" }))}>
                          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>{h.l}{consoColSort.col === h.k && consoColSort.dir === "asc" && I.sortAsc}{consoColSort.col === h.k && consoColSort.dir === "desc" && I.sortDesc}</span>{I.chevronDown}
                        </div>
                      </th>
                    ))}
                    {months.map((m) => (
                      <th key={m} style={{ textAlign: "center" }}>
                        <div className="th-inner" style={{ justifyContent: "center" }} onClick={() => setConsoColSort((p) => ({ col: m, dir: p.col === m ? (p.dir === "desc" ? "asc" : p.dir === "asc" ? null : "desc") : "desc" }))}>
                          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>{fmtMonth(m)}{consoColSort.col === m && consoColSort.dir === "asc" && I.sortAsc}{consoColSort.col === m && consoColSort.dir === "desc" && I.sortDesc}</span>
                        </div>
                      </th>
                    ))}
                    {[{ k: "avg", l: "Moy/mois", c: "var(--purple)" }, { k: "total", l: "Total", c: "var(--text-primary)" }].map((h) => (
                      <th key={h.k} style={{ textAlign: "center" }}>
                        <div className="th-inner" style={{ justifyContent: "center", color: h.c }} onClick={() => setConsoColSort((p) => ({ col: h.k, dir: p.col === h.k ? (p.dir === "desc" ? "asc" : p.dir === "asc" ? null : "desc") : "desc" }))}>
                          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>{h.l}{consoColSort.col === h.k && consoColSort.dir === "asc" && I.sortAsc}{consoColSort.col === h.k && consoColSort.dir === "desc" && I.sortDesc}</span>
                        </div>
                      </th>
                    ))}
                  </tr></thead>
                  <tbody>
                    {sortedConso.map((row, i) => {
                      const max = Math.max(...months.map((m) => row.months[m] || 0));
                      return (
                        <tr key={i}>
                          <td style={{ fontWeight: 700, fontFamily: MONO, color: "var(--accent)", fontSize: 12, whiteSpace: "nowrap", position: "sticky", left: 0, background: "var(--bg-raised)", zIndex: 1 }}>{row.ref || "—"}</td>
                          <td style={{ fontSize: 12 }}>{row.name.replace(/\[.*?\]\s*/, "")}</td>
                          {months.map((m) => { const val = row.months[m] || 0; const intensity = max > 0 ? val / max : 0; return (
                            <td key={m} style={{ textAlign: "center", background: val > 0 ? `rgba(var(--heat-color),${intensity * .2 + .04})` : "transparent", color: val > 0 ? "var(--text-primary)" : "var(--text-muted)", fontWeight: val > 0 ? 600 : 400, fontFamily: val > 0 ? MONO : "inherit", fontSize: 12 }}>{val > 0 ? val : "—"}</td>
                          ); })}
                          <td style={{ textAlign: "center", fontWeight: 600, color: "var(--purple)", fontFamily: MONO, fontSize: 12 }}>{row.avg > 0 ? row.avg : "—"}</td>
                          <td style={{ textAlign: "center", fontWeight: 800, fontFamily: MONO, fontSize: 13 }}>{row.total}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div></div>
            )}
            {conso.length === 0 && !loading && <EmptyState icon={I.chart} title='Cliquez sur "Charger"' sub="pour afficher la consommation mensuelle" />}
            {loading && <div style={{ textAlign: "center", padding: 40 }}><Spinner size={24} /></div>}
          </div>
        )}

        {/* ══════════ LIVRAISONS ══════════ */}
        {tab === "deliveries" && (
          <div style={{ animation: "fadeIn .3s ease both" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
              <div><h2 style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-.3px", marginBottom: 4 }}>Livraisons & Préparations</h2><p style={{ fontSize: 13, color: "var(--text-muted)" }}>Statistiques par période — Picking + Emballage</p></div>
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <input className="wms-input" type="date" value={delStart} onChange={(e) => setDelStart(e.target.value)} style={{ width: "auto" }} />
                <span style={{ color: "var(--text-muted)" }}>→</span>
                <input className="wms-input" type="date" value={delEnd} onChange={(e) => setDelEnd(e.target.value)} style={{ width: "auto" }} />
                <button className="wms-btn wms-btn-primary" onClick={loadDeliveries} disabled={loading}>{loading ? <Spinner /> : I.refresh} Charger</button>
                {deliveries.length > 0 && (
                  <button className="wms-btn wms-btn-ghost" onClick={async () => {
                    const XLSX = await import("xlsx");
                    const wb = XLSX.utils.book_new();
                    const wsD = XLSX.utils.json_to_sheet(filteredDel.map(d => ({ Date: fmtDate(d.date), Préparations: d.count, "Lignes articles": d.lines })));
                    XLSX.utils.book_append_sheet(wb, wsD, "Par jour");
                    if (prepStats.length) {
                      const wsP = XLSX.utils.json_to_sheet(prepStats.map(s => ({ Préparateur: s.name, Picking: s.picking, Emballage: s.emballage, Total: s.total })));
                      XLSX.utils.book_append_sheet(wb, wsP, "Préparateurs");
                    }
                    XLSX.writeFile(wb, `livraisons_${new Date().toISOString().split("T")[0]}.xlsx`);
                  }} style={{ padding: "10px 14px", fontSize: 13 }}>📥 Export Excel</button>
                )}
              </div>
            </div>

            {deliveries.length > 0 && <>
              {/* Stat cards */}
              <div style={{ display: "flex", gap: 12, marginBottom: 24, flexWrap: "wrap" }}>
                <StatCard label="Jours" value={filteredDel.length} color="var(--accent)" delay={0} />
                <StatCard label="Total prépa." value={filteredDel.reduce((s, d) => s + d.count, 0)} color="var(--success)" delay={50} />
                <StatCard label="Lignes totales" value={filteredDel.reduce((s, d) => s + d.lines, 0)} color="var(--purple)" delay={100} />
                <StatCard label="Moy./jour" value={filteredDel.length > 0 ? Math.round(filteredDel.reduce((s, d) => s + d.count, 0) / filteredDel.length) : 0} color="var(--warning)" delay={150} />
              </div>

              {/* Stats préparateurs */}
              {prepStats.length > 0 && (
                <div className="wms-card" style={{ marginBottom: 20 }}>
                  <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ fontSize: 14, fontWeight: 700 }}>👷 Stats par préparateur</div>
                    <div style={{ display: "flex", gap: 16, fontSize: 12, color: "var(--text-muted)" }}>
                      <span><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: "var(--accent)", marginRight: 5 }} />Picking (PICK)</span>
                      <span><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: "var(--success)", marginRight: 5 }} />Emballage (OUT)</span>
                    </div>
                  </div>
                  <div style={{ padding: "16px 20px", display: "grid", gap: 12 }}>
                    {prepStats.map((s, i) => {
                      const maxTotal = Math.max(...prepStats.map(x => x.total), 1);
                      return (
                        <div key={i} style={{ animation: `fadeIn .3s ease ${i * 40}ms both` }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                            <span style={{ fontSize: 13, fontWeight: 600 }}>{s.name}</span>
                            <div style={{ display: "flex", gap: 16, fontSize: 12 }}>
                              <span style={{ color: "var(--accent)" }}>Picking: <strong>{s.picking}</strong></span>
                              <span style={{ color: "var(--success)" }}>Emballage: <strong>{s.emballage}</strong></span>
                              <span style={{ color: "var(--text-secondary)", fontWeight: 700 }}>Total: <strong>{s.total}</strong></span>
                            </div>
                          </div>
                          <div style={{ height: 8, background: "var(--bg-surface)", borderRadius: 4, overflow: "hidden", display: "flex" }}>
                            <div style={{ width: `${(s.picking / maxTotal) * 100}%`, background: "var(--accent)", borderRadius: "4px 0 0 4px", transition: "width .6s ease" }} />
                            <div style={{ width: `${(s.emballage / maxTotal) * 100}%`, background: "var(--success)", borderRadius: "0 4px 4px 0", transition: "width .6s ease" }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Mini bar chart */}
              <div className="wms-card" style={{ padding: "18px 20px", marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", marginBottom: 10, textTransform: "uppercase", letterSpacing: ".5px" }}>Préparations / jour</div>
                <MiniBarChart data={[...filteredDel].reverse().map((d) => d.count)} max={Math.max(...filteredDel.map((d) => d.count), 1)} />
              </div>

              {/* Table */}
              <div className="wms-card"><div className="wms-scrollbar" style={{ overflowX: "auto" }}>
                <table className="wms-table">
                  <thead><tr>
                    <FilterableHeader label="Date" colKey="date" values={deliveries.map((d) => fmtDate(d.date))} filterState={delColFilters} setFilterState={setDelColFilters} sortState={delColSort} setSortState={setDelColSort} />
                    <FilterableHeader label="Préparations" colKey="count" values={deliveries.map((d) => String(d.count))} filterState={delColFilters} setFilterState={setDelColFilters} sortState={delColSort} setSortState={setDelColSort} align="center" />
                    <FilterableHeader label="Lignes articles" colKey="lines" values={deliveries.map((d) => String(d.lines))} filterState={delColFilters} setFilterState={setDelColFilters} sortState={delColSort} setSortState={setDelColSort} align="center" />
                  </tr></thead>
                  <tbody>
                    {filteredDel.map((d, i) => { const maxC = Math.max(...filteredDel.map((x) => x.count), 1); return (
                      <tr key={i}>
                        <td style={{ fontWeight: 600, fontFamily: MONO, fontSize: 12 }}>{fmtDate(d.date)}</td>
                        <td style={{ textAlign: "center" }}><div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}><div style={{ height: 6, width: `${(d.count / maxC) * 80}px`, borderRadius: 3, minWidth: 4, overflow: "hidden" }}><div className="bar-fill" style={{ background: "var(--accent)", animationDelay: `${i * 30}ms` }} /></div><span style={{ fontWeight: 700, fontFamily: MONO, fontSize: 13 }}>{d.count}</span></div></td>
                        <td style={{ textAlign: "center", fontWeight: 600, fontFamily: MONO, fontSize: 13, color: "var(--text-secondary)" }}>{d.lines}</td>
                      </tr>
                    ); })}
                  </tbody>
                </table>
              </div></div>
            </>}
            {deliveries.length === 0 && !loading && <EmptyState icon={I.truck} title="Sélectionnez une période" sub='puis cliquez sur "Charger"' />}
            {loading && <div style={{ textAlign: "center", padding: 40 }}><Spinner size={24} /></div>}
          </div>
        )}

        {/* ══════════ HISTORIQUE ══════════ */}
        {tab === "moves" && (
          <div style={{ animation: "fadeIn .3s ease both" }}>
            <div style={{ marginBottom: 24 }}>
              <h2 style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-.3px", marginBottom: 4 }}>Historique des mouvements</h2>
              <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 16 }}>Recherchez par référence et/ou par période. Au moins un critère requis.</p>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                <input className="wms-input" value={moveRef} onChange={(e) => setMoveRef(e.target.value)} placeholder="Référence ou code-barres (optionnel)..." onKeyDown={(e) => e.key === "Enter" && loadMoves()} style={{ flex: 1, minWidth: 200 }} />
                <input className="wms-input" type="date" value={moveStart} onChange={(e) => setMoveStart(e.target.value)} style={{ width: "auto" }} />
                <span style={{ color: "var(--text-muted)" }}>→</span>
                <input className="wms-input" type="date" value={moveEnd} onChange={(e) => setMoveEnd(e.target.value)} style={{ width: "auto" }} />
                <button className="wms-btn wms-btn-primary" onClick={loadMoves} disabled={loading || (!moveRef.trim() && !moveStart && !moveEnd)} style={{ opacity: (!moveRef.trim() && !moveStart && !moveEnd) ? .5 : 1 }}>{loading ? <Spinner /> : I.search} Rechercher</button>
                {moves.length > 0 && (
                  <button className="wms-btn wms-btn-ghost" onClick={async () => {
                    const XLSX = await import("xlsx");
                    const rows = filteredMoves.map(m => ({
                      Date: fmtDate(m.date), Type: m.type, Produit: m.product,
                      Client: m.partner, "BL/Transfert": m.picking, Qté: m.qty, Lot: m.lot, De: m.from, Vers: m.to
                    }));
                    const ws = XLSX.utils.json_to_sheet(rows);
                    const wb = XLSX.utils.book_new();
                    XLSX.utils.book_append_sheet(wb, ws, "Mouvements");
                    XLSX.writeFile(wb, `mouvements_${new Date().toISOString().split("T")[0]}.xlsx`);
                  }} style={{ padding: "10px 14px", fontSize: 13 }}>📥 Export Excel</button>
                )}
              </div>
            </div>
            {moves.length > 0 && (
              <div className="wms-card">
                <div style={{ padding: "12px 20px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, fontFamily: MONO }}>{filteredMoves.length}/{moves.length} mouvement{filteredMoves.length > 1 ? "s" : ""}</span>
                  <div style={{ display: "flex", gap: 8 }}>
                    {Object.keys(moveColFilters).some((k) => moveColFilters[k]?.size < new Set(moves.map((m) => { const v = k === "date" ? fmtDate(m.date) : k === "qty" ? String(m.qty) : (m as any)[k]; return v; })).size) && (
                      <button className="wms-btn wms-btn-ghost" onClick={() => setMoveColFilters({})} style={{ padding: "5px 12px", fontSize: 11 }}>{I.filter} Réinitialiser filtres</button>
                    )}
                  </div>
                </div>
                <div className="wms-scrollbar" style={{ overflowX: "auto" }}>
                  <table className="wms-table" style={{ tableLayout: "fixed", minWidth: 1100 }}>
                    <thead><tr>
                      <FilterableHeader label="Date" colKey="date" values={moves.map((m) => fmtDate(m.date))} filterState={moveColFilters} setFilterState={setMoveColFilters} sortState={moveColSort} setSortState={setMoveColSort} />
                      {!moveRef.trim() && <FilterableHeader label="Produit" colKey="product" values={moves.map((m) => m.product)} filterState={moveColFilters} setFilterState={setMoveColFilters} sortState={moveColSort} setSortState={setMoveColSort} />}
                      <FilterableHeader label="Type" colKey="type" values={moves.map((m) => m.type)} filterState={moveColFilters} setFilterState={setMoveColFilters} sortState={moveColSort} setSortState={setMoveColSort} />
                      <FilterableHeader label="Client" colKey="partner" values={moves.map((m) => m.partner)} filterState={moveColFilters} setFilterState={setMoveColFilters} sortState={moveColSort} setSortState={setMoveColSort} />
                      <FilterableHeader label="BL/Transfert" colKey="picking" values={moves.map((m) => m.picking)} filterState={moveColFilters} setFilterState={setMoveColFilters} sortState={moveColSort} setSortState={setMoveColSort} />
                      <FilterableHeader label="Qté" colKey="qty" values={moves.map((m) => String(m.qty))} filterState={moveColFilters} setFilterState={setMoveColFilters} sortState={moveColSort} setSortState={setMoveColSort} />
                      <FilterableHeader label="Lot" colKey="lot" values={moves.map((m) => m.lot)} filterState={moveColFilters} setFilterState={setMoveColFilters} sortState={moveColSort} setSortState={setMoveColSort} />
                      <FilterableHeader label="De" colKey="from" values={moves.map((m) => m.from)} filterState={moveColFilters} setFilterState={setMoveColFilters} sortState={moveColSort} setSortState={setMoveColSort} />
                      <FilterableHeader label="Vers" colKey="to" values={moves.map((m) => m.to)} filterState={moveColFilters} setFilterState={setMoveColFilters} sortState={moveColSort} setSortState={setMoveColSort} />
                    </tr></thead>
                    <tbody>
                      {filteredMoves.map((m, i) => {
                        const tc = m.type === "Sortie" ? { bg: "var(--danger-soft)", c: "var(--danger)" } : m.type === "Entrée" ? { bg: "var(--success-soft)", c: "var(--success)" } : { bg: "var(--accent-soft)", c: "var(--accent)" };
                        return (
                          <tr key={i}>
                            <td style={{ fontFamily: MONO, fontSize: 12, whiteSpace: "nowrap" }}>{fmtDate(m.date)}</td>
                            {!moveRef.trim() && <td style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={m.product}>{m.product}</td>}
                            <td><span className="wms-badge" style={{ background: tc.bg, color: tc.c }}>{m.type}</span></td>
                            <td style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 180 }} title={m.partner}>{m.partner}</td>
                            <td style={{ color: "var(--accent)", fontFamily: MONO, fontSize: 12, fontWeight: 600 }}>{m.picking}</td>
                            <td style={{ fontWeight: 800, fontFamily: MONO }}>{m.qty}</td>
                            <td style={{ fontFamily: MONO, fontSize: 12 }}>{m.lot}</td>
                            <td style={{ fontSize: 12, whiteSpace: "nowrap" }}>{m.from}</td>
                            <td style={{ fontSize: 12, whiteSpace: "nowrap" }}>{m.to}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                    {filteredMoves.length > 0 && (
                      <tfoot>
                        <tr style={{ background: "var(--bg-surface)", borderTop: "2px solid var(--border)" }}>
                          <td style={{ padding: "10px 16px", fontWeight: 700, fontSize: 12, color: "var(--text-secondary)" }}>{filteredMoves.length} mouv.</td>
                          {!moveRef.trim() && <td />}
                          <td />
                          <td />
                          <td />
                          <td style={{ padding: "10px 16px", fontWeight: 800, fontFamily: MONO, color: "var(--accent)", textAlign: "right" }}>
                            {filteredMoves.reduce((s, m) => s + m.qty, 0).toLocaleString("fr-FR")}
                          </td>
                          <td colSpan={3} style={{ padding: "10px 16px", fontSize: 11, color: "var(--text-muted)" }}>
                            Entrées: <strong style={{ color: "var(--success)" }}>{filteredMoves.filter(m => m.type === "Entrée").reduce((s,m) => s+m.qty,0).toLocaleString("fr-FR")}</strong>
                            {" · "}Sorties: <strong style={{ color: "var(--danger)" }}>{filteredMoves.filter(m => m.type === "Sortie").reduce((s,m) => s+m.qty,0).toLocaleString("fr-FR")}</strong>
                            {" · "}Internes: <strong>{filteredMoves.filter(m => m.type === "Interne").reduce((s,m) => s+m.qty,0).toLocaleString("fr-FR")}</strong>
                          </td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              </div>
            )}
            {moves.length === 0 && moveSearched && !loading && <EmptyState icon={I.search} title="Aucun mouvement trouvé" sub="Vérifiez vos critères et réessayez" />}
            {!moveSearched && !loading && <EmptyState icon={I.history} title="Entrez une référence ou une période" sub="pour afficher l'historique des mouvements" />}
            {loading && <div style={{ textAlign: "center", padding: 40 }}><Spinner size={24} /></div>}
          </div>
        )}
      </main>
    </div>
  );
}
