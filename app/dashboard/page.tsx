"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import * as odoo from "@/lib/odoo";

// ─────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────
interface StockAlert {
  productId: number;
  ref: string;
  name: string;
  qty: number;
  threshold: number;
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

type ThemeMode = "dark" | "light";
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
function loadTheme(): ThemeMode {
  try {
    return (localStorage.getItem("wms_theme") as ThemeMode) || "dark";
  } catch {
    return "dark";
  }
}
function saveTheme(t: ThemeMode) {
  try {
    localStorage.setItem("wms_theme", t);
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

[data-theme="dark"] {
  --bg-base: #0c0e12;
  --bg-raised: #13161c;
  --bg-surface: #191d25;
  --bg-hover: #1e2330;
  --bg-input: #111419;
  --border: #232830;
  --text-primary: #e8ecf4;
  --text-secondary: #8a93a6;
  --text-muted: #555d6e;
  --accent: #3b82f6;
  --accent-soft: rgba(59,130,246,0.12);
  --accent-border: rgba(59,130,246,0.25);
  --success: #22c55e;
  --success-soft: rgba(34,197,94,0.10);
  --success-border: rgba(34,197,94,0.25);
  --warning: #f59e0b;
  --warning-soft: rgba(245,158,11,0.10);
  --warning-border: rgba(245,158,11,0.25);
  --danger: #ef4444;
  --danger-soft: rgba(239,68,68,0.10);
  --danger-border: rgba(239,68,68,0.25);
  --purple: #a855f7;
  --purple-soft: rgba(168,85,247,0.10);
  --purple-border: rgba(168,85,247,0.25);
  --orange: #f97316;
  --shadow-popup: 0 8px 32px rgba(0,0,0,0.6);
  --table-row-alt: rgba(255,255,255,0.015);
  --heat-color: 59,130,246;
}

[data-theme="light"] {
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

.theme-toggle { width:36px; height:36px; border-radius:8px; display:flex; align-items:center; justify-content:center; background:var(--bg-surface); border:1px solid var(--border); cursor:pointer; color:var(--text-secondary); transition:all .18s; }
.theme-toggle:hover { background:var(--bg-hover); color:var(--text-primary); }

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
  sun: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>,
  moon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>,
  chevronDown: <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6"/></svg>,
  filter: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>,
  sortAsc: <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 19V5M5 12l7-7 7 7"/></svg>,
  sortDesc: <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 5v14M5 12l7 7 7-7"/></svg>,
};

const TABS = [
  { key: "alerts", label: "Alertes stock", icon: I.alert },
  { key: "conso", label: "Consommation", icon: I.chart },
  { key: "deliveries", label: "Livraisons", icon: I.truck },
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
  const [theme, setTheme] = useState<ThemeMode>("dark");
  const toggleTheme = () => { const t = theme === "dark" ? "light" : "dark"; setTheme(t); saveTheme(t); };

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
  const [consoSearch, setConsoSearch] = useState("");

  // Excel-like column filter states
  const [moveColFilters, setMoveColFilters] = useState<Record<string, Set<string>>>({});
  const [moveColSort, setMoveColSort] = useState<{ col: string; dir: SortDir }>({ col: "date", dir: "desc" });
  const [delColFilters, setDelColFilters] = useState<Record<string, Set<string>>>({});
  const [delColSort, setDelColSort] = useState<{ col: string; dir: SortDir }>({ col: "date", dir: "desc" });
  const [consoColSort, setConsoColSort] = useState<{ col: string; dir: SortDir }>({ col: "total", dir: "desc" });

  useEffect(() => { setTheme(loadTheme()); const s = loadSession(); if (s) setSession(s); const cfg = loadCfg(); if (cfg) { setUrl(cfg.u); setDb(cfg.d); } }, []);
  useEffect(() => { try { const t = localStorage.getItem("wms_thresholds"); if (t) setThresholds(JSON.parse(t)); } catch {} }, []);

  const login = async () => { if (!url || !db || !user || !pw) return; setLoginLoading(true); setLoginError(""); try { const s = await odoo.authenticate({ url, db }, user, pw); saveSession(s); setSession(s); } catch (e: any) { setLoginError(e.message); } setLoginLoading(false); };
  const logout = () => { clearSession(); setSession(null); setAlerts([]); setConso([]); setDeliveries([]); setMoves([]); };
  const saveThresholdsLocal = (t: Record<number, number>) => { setThresholds(t); try { localStorage.setItem("wms_thresholds", JSON.stringify(t)); } catch {} };

  // ── DATA LOADERS (logic 100% identical to original) ──

  const loadAlerts = useCallback(async () => {
    if (!session) return; setLoading(true); setError("");
    try {
      const quants = await odoo.searchRead(session, "stock.quant", [["location_id.usage", "=", "internal"], ["quantity", ">", 0]], ["product_id", "quantity", "location_id"], 2000);
      const byProduct: Record<number, { name: string; ref: string; qty: number }> = {};
      for (const q of quants) { const pid = q.product_id[0]; if (!byProduct[pid]) byProduct[pid] = { name: q.product_id[1], ref: "", qty: 0 }; byProduct[pid].qty += q.quantity; }
      const pids = Object.keys(byProduct).map(Number);
      if (pids.length) { const prods = await odoo.searchRead(session, "product.product", [["id", "in", pids]], ["id", "default_code"], 2000); for (const p of prods) if (byProduct[p.id]) byProduct[p.id].ref = p.default_code || ""; }
      setStockMap(Object.fromEntries(Object.entries(byProduct).map(([id, v]) => [id, { qty: v.qty, name: v.name, ref: v.ref }])));
      const alertList: StockAlert[] = [];
      for (const [idStr, data] of Object.entries(byProduct)) { const pid = Number(idStr); const thresh = thresholds[pid]; if (thresh !== undefined && data.qty <= thresh) alertList.push({ productId: pid, ref: data.ref, name: data.name, qty: data.qty, threshold: thresh }); }
      alertList.sort((a, b) => (a.qty / a.threshold) - (b.qty / b.threshold));
      setAlerts(alertList);
    } catch (e: any) { setError(e.message); } finally { setLoading(false); }
  }, [session, thresholds]);

  /*
   * loadConso — Consommation mensuelle
   * Direct query on stock.move: outgoing moves done in period.
   * Uses picking_code relational filter to get only outgoing (delivery) moves.
   * product_uom_qty = demanded qty = what Odoo shows in pivot for outgoing pickings.
   */
  const loadConso = useCallback(async () => {
    if (!session) return; setLoading(true); setError("");
    try {
      const months = monthsBack(consoMonths);
      const startDate = months[0] + "-01 00:00:00";
      const endDate = new Date().toISOString().split("T")[0] + " 23:59:59";

      // Single query: outgoing done moves in period
      const allMoves = await odoo.searchRead(session, "stock.move", [
        ["state", "=", "done"],
        ["picking_code", "=", "outgoing"],
        ["date", ">=", startDate],
        ["date", "<=", endDate],
      ], ["product_id", "product_uom_qty", "date"], 10000);

      const byProd: Record<number, { name: string; ref: string; months: Record<string, number> }> = {};
      for (const m of allMoves) {
        const pid = m.product_id[0];
        const month = (m.date || "").substring(0, 7);
        if (!month) continue;
        if (!byProd[pid]) byProd[pid] = { name: m.product_id[1], ref: "", months: {} };
        byProd[pid].months[month] = (byProd[pid].months[month] || 0) + (m.product_uom_qty || 0);
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
      rows.forEach(r => {
        const active = Object.values(r.months).filter(v => v > 0).length;
        r.avg = active > 0 ? Math.round(r.total / active) : 0;
      });
      setConso(rows);
    } catch (e: any) { setError(e.message); } finally { setLoading(false); }
  }, [session, consoMonths]);

  const loadDeliveries = useCallback(async () => {
    if (!session) return; setLoading(true); setError("");
    try {
      const pickings = await odoo.searchRead(session, "stock.picking", [["state", "=", "done"], ["picking_type_code", "=", "outgoing"], ["date_done", ">=", delStart + " 00:00:00"], ["date_done", "<=", delEnd + " 23:59:59"]], ["name", "date_done", "partner_id", "move_ids"], 1000, "date_done desc");
      const byDate: Record<string, { count: number; lines: number }> = {};
      for (const p of pickings) { const date = (p.date_done || "").substring(0, 10); if (!byDate[date]) byDate[date] = { count: 0, lines: 0 }; byDate[date].count++; byDate[date].lines += (p.move_ids || []).length; }
      setDeliveries(Object.entries(byDate).sort(([a], [b]) => b.localeCompare(a)).map(([date, v]) => ({ date, ...v })));
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
        ["date", "picking_id", "location_id", "location_dest_id", "product_qty", "lot_ids", "name", "product_id"], 500, "date desc");

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
    let r = conso.filter((row) => !consoSearch || row.ref.toLowerCase().includes(consoSearch.toLowerCase()) || row.name.toLowerCase().includes(consoSearch.toLowerCase()));
    if (consoColSort.dir) { const d = consoColSort.dir === "asc" ? 1 : -1; const c = consoColSort.col; r = [...r].sort((a, b) => c === "ref" ? d * (a.ref || "").localeCompare(b.ref || "") : c === "name" ? d * a.name.localeCompare(b.name) : c === "avg" ? d * (a.avg - b.avg) : c === "total" ? d * (a.total - b.total) : d * ((a.months[c] || 0) - (b.months[c] || 0))); }
    return r;
  }, [conso, consoSearch, consoColSort]);

  const MONO = "'JetBrains Mono', monospace";

  // ═══════════════════════════════════════
  // LOGIN
  // ═══════════════════════════════════════
  if (!session) return (
    <div className="wms-root" data-theme={theme}><style>{GLOBAL_CSS}</style>
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ position: "absolute", top: 16, right: 16 }}><button className="theme-toggle" onClick={toggleTheme}>{theme === "dark" ? I.sun : I.moon}</button></div>
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
    <div className="wms-root" data-theme={theme}><style>{GLOBAL_CSS}</style>

      {/* HEADER */}
      <header style={{ background: "var(--bg-raised)", borderBottom: "1px solid var(--border)", padding: "0 28px", display: "flex", alignItems: "center", justifyContent: "space-between", height: 60, position: "sticky", top: 0, zIndex: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 34, height: 34, borderRadius: 8, background: "linear-gradient(135deg,var(--accent),#6366f1)", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", flexShrink: 0 }}>{I.warehouse}</div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 800, letterSpacing: "-.2px", lineHeight: 1.2 }}>WMS Dashboard</div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: MONO }}>{session.name} · {session.config?.url?.replace("https://", "")}</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button className="theme-toggle" onClick={toggleTheme} title={theme === "dark" ? "Mode clair" : "Mode sombre"}>{theme === "dark" ? I.sun : I.moon}</button>
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
              <button className="wms-btn wms-btn-primary" onClick={loadAlerts} disabled={loading}>{loading ? <Spinner /> : I.refresh} Actualiser</button>
            </div>

            {/* Under-stock alerts */}
            {alerts.length > 0 && (
              <div style={{ marginBottom: 28 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "var(--danger)", marginBottom: 14, textTransform: "uppercase", letterSpacing: "1px", display: "flex", alignItems: "center", gap: 8 }}><div style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--danger)", animation: "pulse-dot 1.5s ease-in-out infinite" }} />{alerts.length} article{alerts.length > 1 ? "s" : ""} en sous-stock</div>
                <div style={{ display: "grid", gap: 10 }}>
                  {alerts.map((a, idx) => {
                    const ratio = a.qty / a.threshold; const color = ratio <= .25 ? "var(--danger)" : ratio <= .75 ? "var(--warning)" : "var(--orange)"; const bg = ratio <= .25 ? "var(--danger-soft)" : ratio <= .75 ? "var(--warning-soft)" : "rgba(249,115,22,.08)";
                    const consoRow = conso.find((c) => c.ref === a.ref); const dailyAvg = consoRow ? consoRow.avg / 30 : 0; const daysLeft = dailyAvg > 0 ? Math.round(a.qty / dailyAvg) : null;
                    const daysLabel = daysLeft === null ? "Conso inconnue" : daysLeft <= 0 ? "Rupture imminente" : `${daysLeft}j restant${daysLeft > 1 ? "s" : ""}`;
                    return (
                      <div key={a.productId} className="alert-card" style={{ background: bg, borderLeftColor: color, animationDelay: `${idx * 50}ms` }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6 }}>{a.ref && <span style={{ fontFamily: MONO, color: "var(--accent)", marginRight: 8, fontSize: 12 }}>[{a.ref}]</span>}{a.name}</div>
                            <div style={{ display: "flex", gap: 20, flexWrap: "wrap", fontSize: 13, color: "var(--text-secondary)" }}>
                              <span>Stock : <strong style={{ color, fontSize: 15 }}>{a.qty}</strong></span><span>Seuil : <strong>{a.threshold}</strong></span>{consoRow && <span>Moy : <strong>{consoRow.avg}/mois</strong></span>}
                            </div>
                          </div>
                          <div style={{ fontSize: 12, fontWeight: 700, color, whiteSpace: "nowrap", fontFamily: MONO }}>{daysLabel}</div>
                        </div>
                        <div style={{ height: 4, background: "rgba(128,128,128,.15)", borderRadius: 2, marginTop: 14, overflow: "hidden" }}><div className="bar-fill" style={{ width: `${Math.min(ratio * 100, 100)}%`, background: color, animationDelay: `${idx * 50 + 200}ms` }} /></div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Overstock alerts — calmer styling */}
            {overstockItems.length > 0 && (
              <div style={{ marginBottom: 28 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "var(--purple)", marginBottom: 14, textTransform: "uppercase", letterSpacing: "1px", display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--purple)" }} />
                  {overstockItems.length} article{overstockItems.length > 1 ? "s" : ""} en surstock ({`>${OVERSTOCK_DAYS}j`})
                </div>
                <div style={{ display: "grid", gap: 8 }}>
                  {overstockItems.map((item, idx) => (
                    <div key={item.pid} style={{ background: "var(--purple-soft)", borderLeft: "3px solid var(--purple-border)", borderRadius: 10, padding: "14px 18px", animation: "fadeIn .3s ease both", animationDelay: `${idx * 40}ms` }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 600 }}>
                            {item.ref && <span style={{ fontFamily: MONO, color: "var(--accent)", marginRight: 8, fontSize: 12 }}>[{item.ref}]</span>}{item.name}
                          </div>
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
                    </div>
                  ))}
                </div>
              </div>
            )}

            {alerts.length === 0 && overstockItems.length === 0 && Object.keys(stockMap).length > 0 && <div style={{ background: "var(--success-soft)", border: "1px solid var(--success-border)", borderRadius: 12, padding: "22px 28px", marginBottom: 28, display: "flex", alignItems: "center", gap: 16, animation: "fadeIn .4s ease both" }}>{I.check}<div><div style={{ fontSize: 15, fontWeight: 700, color: "var(--success)" }}>Tous les stocks sont OK</div><div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 2 }}>Aucun article en sous-stock ou surstock.</div></div></div>}
            {/* Threshold manager */}
            <div className="wms-card" style={{ padding: 24 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 12 }}>
                <div><div style={{ fontSize: 15, fontWeight: 700 }}>Gérer les seuils</div><div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>Import Excel : col A = référence, col B = seuil</div></div>
                <label className="wms-btn" style={{ background: "var(--purple-soft)", color: "var(--purple)", border: "1px solid var(--purple-border)", cursor: "pointer", padding: "8px 14px", fontSize: 13 }}>
                  {I.upload} Importer Excel
                  <input type="file" accept=".xlsx,.xls,.csv" style={{ display: "none" }} onChange={async (e) => {
                    const file = e.target.files?.[0]; if (!file) return;
                    try { const XLSX = await import("xlsx"); const data = await file.arrayBuffer(); const wb = XLSX.read(data, { type: "array" }); const ws = wb.Sheets[wb.SheetNames[0]]; const rows: any[] = XLSX.utils.sheet_to_json(ws, { header: 1 }); const nt = { ...thresholds }; let imp = 0; for (const row of rows) { const ref = String(row[0] || "").trim(); const val = Number(row[1]); if (!ref || isNaN(val) || val < 0) continue; const match = Object.entries(stockMap).find(([, d]) => d.ref === ref); if (match) { nt[Number(match[0])] = val; imp++; } } saveThresholdsLocal(nt); alert(`${imp} seuil(s) importé(s)`); } catch { alert("Erreur lecture Excel"); } e.target.value = "";
                  }} />
                </label>
              </div>
              <input className="wms-input" value={stockSearch} onChange={(e) => setStockSearch(e.target.value)} placeholder="Filtrer par référence ou nom..." style={{ marginBottom: 16 }} />
              <div className="wms-scrollbar" style={{ maxHeight: 420, overflowY: "auto" }}>
                {Object.keys(stockMap).length === 0 && !loading && <EmptyState icon={I.refresh} title='Cliquez sur "Actualiser"' sub="pour charger les produits" />}
                {Object.entries(stockMap).filter(([, d]) => !stockSearch || d.ref.toLowerCase().includes(stockSearch.toLowerCase()) || d.name.toLowerCase().includes(stockSearch.toLowerCase())).map(([pidStr, data]) => {
                  const pid = Number(pidStr); const { qty, name, ref } = data; const thresh = thresholds[pid]; const isAlert = thresh !== undefined && qty <= thresh;
                  return (
                    <div key={pid} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 0", borderBottom: "1px solid var(--border)" }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: thresh !== undefined ? 600 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {ref && <span style={{ fontFamily: MONO, color: "var(--accent)", fontWeight: 700, marginRight: 8, fontSize: 12 }}>[{ref}]</span>}{name}
                        </div>
                        <div style={{ fontSize: 12, color: isAlert ? "var(--danger)" : "var(--text-muted)", marginTop: 2 }}>Stock : <strong>{qty}</strong>{thresh !== undefined && ` · Seuil : ${thresh}`}{isAlert && <span style={{ marginLeft: 8, color: "var(--danger)", fontWeight: 700 }}>● Alerte</span>}</div>
                      </div>
                      {editThresh === pid ? (
                        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                          <input className="wms-input" value={editVal} onChange={(e) => setEditVal(e.target.value)} type="number" min="0" style={{ width: 80, padding: "6px 10px" }} autoFocus onKeyDown={(e) => { if (e.key === "Enter") { const v = Number(editVal); if (!isNaN(v) && v >= 0) saveThresholdsLocal({ ...thresholds, [pid]: v }); setEditThresh(null); } if (e.key === "Escape") setEditThresh(null); }} />
                          <button className="wms-btn" onClick={() => { const v = Number(editVal); if (!isNaN(v) && v >= 0) saveThresholdsLocal({ ...thresholds, [pid]: v }); setEditThresh(null); }} style={{ background: "var(--success)", color: "#fff", padding: "6px 10px", fontSize: 13 }}>✓</button>
                          <button className="wms-btn wms-btn-danger" onClick={() => { const t = { ...thresholds }; delete t[pid]; saveThresholdsLocal(t); setEditThresh(null); }} style={{ padding: "6px 10px", fontSize: 12 }}>✕</button>
                        </div>
                      ) : (
                        <button className="wms-btn" onClick={() => { setEditThresh(pid); setEditVal(thresh !== undefined ? String(thresh) : ""); }} style={{ flexShrink: 0, padding: "6px 14px", fontSize: 12, fontWeight: thresh !== undefined ? 700 : 400, fontFamily: thresh !== undefined ? MONO : "inherit", background: thresh !== undefined ? (isAlert ? "var(--danger-soft)" : "var(--warning-soft)") : "var(--bg-surface)", color: thresh !== undefined ? (isAlert ? "var(--danger)" : "var(--warning)") : "var(--text-muted)", border: `1px solid ${thresh !== undefined ? (isAlert ? "var(--danger-border)" : "var(--warning-border)") : "var(--border)"}` }}>
                          {thresh !== undefined ? `Seuil: ${thresh}` : "+ Seuil"}
                        </button>
                      )}
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
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24, flexWrap: "wrap", gap: 12 }}>
              <div><h2 style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-.3px", marginBottom: 4 }}>Consommation mensuelle</h2><p style={{ fontSize: 13, color: "var(--text-muted)" }}>Quantités sorties vers clients (hors transferts internes)</p></div>
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <select className="wms-select" value={consoMonths} onChange={(e) => setConsoMonths(Number(e.target.value))}>{[3, 6, 9, 12].map((n) => <option key={n} value={n}>{n} mois</option>)}</select>
                <button className="wms-btn wms-btn-primary" onClick={loadConso} disabled={loading}>{loading ? <Spinner /> : I.refresh} Charger</button>
              </div>
            </div>
            {conso.length > 0 && <input className="wms-input" value={consoSearch} onChange={(e) => setConsoSearch(e.target.value)} placeholder="Filtrer par référence ou désignation..." style={{ marginBottom: 16 }} />}
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
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24, flexWrap: "wrap", gap: 12 }}>
              <div><h2 style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-.3px", marginBottom: 4 }}>Livraisons par période</h2><p style={{ fontSize: 13, color: "var(--text-muted)" }}>Bons de livraison validés, groupés par jour</p></div>
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <input className="wms-input" type="date" value={delStart} onChange={(e) => setDelStart(e.target.value)} style={{ width: "auto" }} />
                <span style={{ color: "var(--text-muted)" }}>→</span>
                <input className="wms-input" type="date" value={delEnd} onChange={(e) => setDelEnd(e.target.value)} style={{ width: "auto" }} />
                <button className="wms-btn wms-btn-primary" onClick={loadDeliveries} disabled={loading}>{loading ? <Spinner /> : I.refresh} Charger</button>
              </div>
            </div>
            {deliveries.length > 0 && <>
              <div style={{ display: "flex", gap: 12, marginBottom: 24, flexWrap: "wrap" }}>
                <StatCard label="Jours" value={filteredDel.length} color="var(--accent)" delay={0} />
                <StatCard label="Livraisons" value={filteredDel.reduce((s, d) => s + d.count, 0)} color="var(--success)" delay={50} />
                <StatCard label="Lignes totales" value={filteredDel.reduce((s, d) => s + d.lines, 0)} color="var(--purple)" delay={100} />
                <StatCard label="Moy./jour" value={filteredDel.length > 0 ? Math.round(filteredDel.reduce((s, d) => s + d.count, 0) / filteredDel.length) : 0} color="var(--warning)" delay={150} />
              </div>
              <div className="wms-card" style={{ padding: "18px 20px", marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", marginBottom: 10, textTransform: "uppercase", letterSpacing: ".5px" }}>Livraisons / jour</div>
                <MiniBarChart data={[...filteredDel].reverse().map((d) => d.count)} max={Math.max(...filteredDel.map((d) => d.count), 1)} />
              </div>
              <div className="wms-card"><div className="wms-scrollbar" style={{ overflowX: "auto" }}>
                <table className="wms-table">
                  <thead><tr>
                    <FilterableHeader label="Date" colKey="date" values={deliveries.map((d) => fmtDate(d.date))} filterState={delColFilters} setFilterState={setDelColFilters} sortState={delColSort} setSortState={setDelColSort} />
                    <FilterableHeader label="Livraisons" colKey="count" values={deliveries.map((d) => String(d.count))} filterState={delColFilters} setFilterState={setDelColFilters} sortState={delColSort} setSortState={setDelColSort} align="center" />
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
