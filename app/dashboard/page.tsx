"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import * as odoo from "@/lib/odoo";
import * as supa from "@/lib/supabase";
import type { WmsPendingOrder } from "@/lib/supabase";

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
  // Commande fournisseur en cours
  incomingQty?: number;
  incomingDate?: string;
  rawDaysLeft?: number; // daysLeft sans la commande (pour affichage)
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
  isInventory?: boolean; // ajustement d'inventaire (correction de stock)
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
  download: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>,
  filter: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>,
  sortAsc: <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 19V5M5 12l7-7 7 7"/></svg>,
  sortDesc: <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 5v14M5 12l7 7 7-7"/></svg>,
};

const TABS = [
  { key: "stock-monitor", label: "Suivi Stock", icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg> },
  { key: "deliveries", label: "Livraisons & Prépa.", icon: I.truck },
  { key: "moves", label: "Historique", icon: I.history },
  { key: "stock-tracking", label: "Suivi stock", icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg> },
  { key: "libre", label: "Mode Libre", icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg> },
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
  const [mounted, setMounted] = useState(false); // évite le flash avant lecture localStorage
  const [session, setSession] = useState<odoo.OdooSession | null>(null);
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [url, setUrl] = useState("");
  const [db, setDb] = useState("");
  const [user, setUser] = useState("");
  const [pw, setPw] = useState("");
  const [tab, setTab] = useState<string>("stock-monitor");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [alerts, setAlerts] = useState<StockAlert[]>([]);
  const [thresholds, setThresholds] = useState<Record<number, number>>({});
  const [conso, setConso] = useState<ConsoRow[]>([]);
  const [deliveries, setDeliveries] = useState<DeliveryRow[]>([]);
  const [moves, setMoves] = useState<MoveRow[]>([]);
  const [stockMap, setStockMap] = useState<Record<number, StockProduct>>({});
  const consoMonths = 12; // toujours 12 mois
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
  const [defaultThreshold, setDefaultThreshold] = useState<number>(() => {
    try { const v = localStorage.getItem("wms_default_threshold"); return v ? Number(v) : 1; } catch { return 1; }
  });
  const [consoSearch, setConsoSearch] = useState("");

  // Excel-like column filter states
  const [moveColFilters, setMoveColFilters] = useState<Record<string, Set<string>>>({});
  const [moveColSort, setMoveColSort] = useState<{ col: string; dir: SortDir }>({ col: "date", dir: "desc" });
  const [delColFilters, setDelColFilters] = useState<Record<string, Set<string>>>({});
  const [delColSort, setDelColSort] = useState<{ col: string; dir: SortDir }>({ col: "date", dir: "desc" });
  const [delPickingType, setDelPickingType] = useState<"all" | "out" | "pick">("all");
  const [prepStats, setPrepStats] = useState<{ name: string; picking: number; emballage: number; total: number }[]>([]);
  const [prepStatsLoading, setPrepStatsLoading] = useState(false);
  const [moveProductCurrentStock, setMoveProductCurrentStock] = useState<number | null>(null);
  const [moveProductName, setMoveProductName] = useState<string>("");
  const [consoColSort, setConsoColSort] = useState<{ col: string; dir: SortDir }>({ col: "total", dir: "desc" });
  const [alertsUnderstockOpen, setAlertsUnderstockOpen] = useState(true);
  const [alertsOverstockOpen, setAlertsOverstockOpen] = useState(true);
  const [alertsWarningOpen, setAlertsWarningOpen] = useState(true);

  // Mode Libre
  type LibreRefType = "product" | "lot" | "so" | "picking" | "unknown";
  type LibreRef = { raw: string; type: LibreRefType; id?: number; resolved?: any };
  type LibreCol = { id: string; label: string; key: string };
  const LIBRE_COLS: LibreCol[] = [
    { id: "stock_dispo", label: "Stock disponible (hors réservé)", key: "stock_dispo" },
    { id: "stock_total", label: "Quantité en stock (physique)", key: "stock_total" },
    { id: "nom_produit", label: "Nom du produit", key: "nom_produit" },
    { id: "ref_produit", label: "Référence produit", key: "ref_produit" },
    { id: "poids", label: "Poids (kg)", key: "poids" },
    { id: "dimensions", label: "Dimensions (L×l×h cm)", key: "dimensions" },
    { id: "ref_fournisseur", label: "Référence fournisseur", key: "ref_fournisseur" },
    { id: "lots_en_stock", label: "Lots en stock", key: "lots_en_stock" },
    { id: "lot_expiry", label: "Date d'expiration (lot)", key: "lot_expiry" },
    { id: "so_client", label: "Client (commande)", key: "so_client" },
    { id: "so_statut", label: "Statut commande", key: "so_statut" },
    { id: "so_montant", label: "Montant commande", key: "so_montant" },
    { id: "picking_statut", label: "Statut BL", key: "picking_statut" },
    { id: "picking_client", label: "Client BL", key: "picking_client" },
  ];
  const [libreText, setLibreText] = useState("");
  const [libreRefs, setLibreRefs] = useState<LibreRef[]>([]);
  const [libreCols, setLibreCols] = useState<LibreCol[]>([LIBRE_COLS[0]]);
  const [libreRows, setLibreRows] = useState<Record<string, any>[]>([]);
  const [libreLoading, setLibreLoading] = useState(false);
  const [libreAnalyzed, setLibreAnalyzed] = useState(false);

  useEffect(() => {
    const s = loadSession(); if (s) setSession(s);
    const cfg = loadCfg(); if (cfg) { setUrl(cfg.u); setDb(cfg.d); }
    setMounted(true); // localStorage lu → on peut render
  }, []);
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
  const [consoImporting, setConsoImporting] = useState(false);
  const [orderImporting, setOrderImporting] = useState(false);
  const [pendingOrders, setPendingOrders] = useState<WmsPendingOrder[]>([]);

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

      // 2. Seuils figés depuis Supabase wms_thresholds (mis à jour uniquement via "Màj conso Odoo")
      const frozenThresh: Record<string, number> = await supa.loadThresholds();
      setThresholdsByRef(frozenThresh);

      // consoAvgDaily = seuil / 30 (seuil = moy mensuelle)
      const consoAvgDaily: Record<string, number> = {};
      for (const [ref, avg] of Object.entries(frozenThresh)) {
        consoAvgDaily[ref] = avg / 30;
      }

      // t[pid] = seuil pour ce produit (figé ou défaut)
      const t: Record<number, number> = {};
      for (const [pid, data] of Object.entries(stockData)) {
        if (!data.ref) continue;
        t[Number(pid)] = frozenThresh[data.ref] !== undefined ? frozenThresh[data.ref] : defaultThreshold;
      }
      setThresholds(t);

      // 4. Charger les commandes fournisseur en cours
      let pendingByRef: Record<string, { qty: number; receptionDate: Date; dateStr: string }> = {};
      try {
        const pending = await supa.loadPendingOrders();
        setPendingOrders(pending);
        for (const o of pending) {
          if (!o.odoo_ref) continue;
          if (!pendingByRef[o.odoo_ref]) {
            const rd = new Date(o.expected_reception_date + "T12:00:00");
            pendingByRef[o.odoo_ref] = { qty: 0, receptionDate: rd, dateStr: rd.toLocaleDateString("fr-FR", { day: "2-digit", month: "short" }) };
          }
          pendingByRef[o.odoo_ref].qty += o.qty_incoming;
        }
      } catch {}

      const alertList: StockAlert[] = [];
      for (const [pidStr, data] of Object.entries(stockData)) {
        const pid = Number(pidStr);
        const thresh = t[pid];
        const avgDaily = consoAvgDaily[data.ref] || 0;
        const consoAvg = avgDaily * 30; // monthly
        const rawDaysLeft = avgDaily > 0 ? Math.round(data.qty / avgDaily) : 9999;

        // Recalculer les jours restants en tenant compte de la commande en cours
        let daysLeft = rawDaysLeft;
        let incomingQty: number | undefined;
        let incomingDate: string | undefined;
        const pending = pendingByRef[data.ref];
        if (pending && avgDaily > 0) {
          const daysUntilReception = Math.max(0, Math.round((pending.receptionDate.getTime() - Date.now()) / 86400000));
          const stockAtReception = Math.max(0, data.qty - avgDaily * daysUntilReception);
          daysLeft = daysUntilReception + Math.round((stockAtReception + pending.qty) / avgDaily);
          incomingQty = pending.qty;
          incomingDate = pending.dateStr;
        }

        if (watchlist.size > 0 && !watchlist.has(data.ref)) continue;

        // Règle d'alerte :
        // - Sans commande : alerte si qty < seuil OU couverture < 45j
        // - Avec commande : alerte UNIQUEMENT si la couverture effective (stock + réception) reste < 45j
        //   → si la commande compense suffisamment, le produit n'est plus à risque même si qty < seuil
        // Seuil effectif : seuil défini OU seuil par défaut global (tous les articles ont un seuil)
        const effectiveThresh = thresh !== undefined ? thresh : defaultThreshold;
        const belowThreshold = data.qty <= effectiveThresh;
        const lowDays = avgDaily > 0 && daysLeft < 45;
        const coveredByOrder = incomingQty !== undefined && !lowDays; // commande en cours ET couverture ok

        if ((belowThreshold || lowDays) && !coveredByOrder) {
          alertList.push({ productId: pid, ref: data.ref, name: data.name, qty: data.qty, threshold: effectiveThresh, consoAvg: Math.round(consoAvg), daysLeft, rawDaysLeft, incomingQty, incomingDate });
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
  }, [session, watchlist, defaultThreshold]);

  // ── IMPORT CONSO DEPUIS EXPORT ODOO (Tableau croisé dynamique) ──
  const importConsoFromOdoo = useCallback(async (file: File) => {
    setConsoImporting(true);
    try {
      const XLSX = await import("xlsx");
      const data = await file.arrayBuffer();
      const wb = XLSX.read(data, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1 });

      const FR_MONTHS: Record<string, string> = {
        "janvier": "01", "février": "02", "mars": "03", "avril": "04",
        "mai": "05", "juin": "06", "juillet": "07", "août": "08",
        "septembre": "09", "octobre": "10", "novembre": "11", "décembre": "12"
      };

      // Trouver la ligne d'en-têtes avec les noms de mois
      let monthCols: { col: number; month: string }[] = [];
      let dataStartRow = 4;
      for (let r = 0; r < Math.min(6, rows.length); r++) {
        const row = rows[r] || [];
        const cols: { col: number; month: string }[] = [];
        for (let c = 0; c < row.length; c++) {
          const cell = String(row[c] ?? "").trim().toLowerCase();
          const parts = cell.split(" ");
          if (parts.length === 2 && FR_MONTHS[parts[0]] && /^\d{4}$/.test(parts[1])) {
            cols.push({ col: c, month: `${parts[1]}-${FR_MONTHS[parts[0]]}` });
          }
        }
        if (cols.length > 0) { monthCols = cols; dataStartRow = r + 2; break; }
      }
      if (monthCols.length === 0) throw new Error("Colonnes de mois introuvables. Vérifiez le format du fichier (tableau croisé Odoo avec mois en français).");

      // Parser les lignes produit
      const items: supa.WmsConsoCache[] = [];
      for (let r = dataStartRow; r < rows.length; r++) {
        const row = rows[r] || [];
        const rawName = String(row[0] ?? "").trim();
        if (!rawName || rawName.toLowerCase() === "total") continue;
        const refMatch = rawName.match(/^\[([^\]]+)\]\s*(.*)/);
        if (!refMatch) continue;
        const ref = refMatch[1].trim();
        const name = refMatch[2].trim();
        for (const { col, month } of monthCols) {
          const qty = Number(row[col]) || 0;
          if (qty > 0) items.push({ odoo_ref: ref, product_name: name, month, qty });
        }
      }
      if (items.length === 0) throw new Error("Aucune ligne de consommation trouvée. Vérifiez que le fichier contient des lignes [REF] Produit.");

      await supa.saveConsoCache(items);

      // ── Calcul seuils automatiques : moyenne mensuelle des 12 derniers mois ──
      const now = new Date();
      const last12: string[] = [];
      for (let i = 1; i <= 12; i++) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        last12.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
      }
      const byRef12: Record<string, { name: string; total: number }> = {};
      for (const item of items) {
        if (!last12.includes(item.month)) continue;
        if (!byRef12[item.odoo_ref]) byRef12[item.odoo_ref] = { name: item.product_name, total: 0 };
        byRef12[item.odoo_ref].total += item.qty;
      }
      const thresholdItems: supa.WmsThreshold[] = [];
      const newThresholdsByRef: Record<string, number> = {};
      for (const [ref, v] of Object.entries(byRef12)) {
        const avgMonthly = Math.round(v.total / 12);
        if (avgMonthly > 0) {
          thresholdItems.push({ odoo_ref: ref, threshold: avgMonthly, product_name: v.name });
          newThresholdsByRef[ref] = avgMonthly;
        }
      }
      // Ajouter seuil = 1 pour tous les articles en stock sans historique conso
      let nbNoConso = 0;
      for (const data of Object.values(stockMap)) {
        if (!data.ref) continue;
        if (!newThresholdsByRef[data.ref]) {
          thresholdItems.push({ odoo_ref: data.ref, threshold: 1, product_name: data.name });
          newThresholdsByRef[data.ref] = 1;
          nbNoConso++;
        }
      }
      if (thresholdItems.length > 0) {
        await supa.saveThresholdsBulk(thresholdItems);
        setThresholdsByRef(newThresholdsByRef);
      }

      const avg = await supa.loadAvgMonthly();
      setAvgMonthlyByRef(avg);
      setConsoSyncedAt(new Date());
      const nbProducts = new Set(items.map(i => i.odoo_ref)).size;
      const nbMonths = new Set(items.map(i => i.month)).size;
      alert(`✓ Import réussi !\n${nbProducts} produits · ${nbMonths} mois importés.\n${thresholdItems.length - nbNoConso} seuils calculés (moy. 12 derniers mois).\n${nbNoConso} articles sans conso → seuil = 1.`);
      loadAlerts();
    } catch (err: any) {
      alert("Erreur import conso : " + err.message);
    } finally {
      setConsoImporting(false);
    }
  }, [loadAlerts, stockMap]);

  // ── IMPORT ORDER CONFIRMATION FOURNISSEUR ──
  const importOrderConfirmation = useCallback(async (file: File) => {
    if (!session) return;
    setOrderImporting(true);
    try {
      const XLSX = await import("xlsx");
      const data = await file.arrayBuffer();
      // cellDates:true → SheetJS auto-converts date serials to JS Date objects
      const wb = XLSX.read(data, { type: "array", cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      // raw:true (défaut) + cellDates:true → dates = JS Date objects, nombres = number natifs (pas de formatage string)
      const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1 });

      if (rows.length < 2) throw new Error("Fichier vide ou format non reconnu");

      // Détecter la ligne d'en-tête (contient "Article-No." ou "Article")
      let headerRow = 0;
      for (let r = 0; r < Math.min(5, rows.length); r++) {
        if (rows[r].some((c: any) => String(c || "").toLowerCase().includes("article"))) { headerRow = r; break; }
      }
      const headers = (rows[headerRow] || []).map((h: any) => String(h || "").toLowerCase().trim());
      const colArticle = headers.findIndex((h: string) => h.includes("article-no") || h.includes("article no") || h === "article-no.");
      const colQtyAvail = headers.findIndex((h: string) => h.includes("quantity available") || h.includes("qty available"));
      const colDesc = headers.findIndex((h: string) => h.includes("description"));
      const colOrderDate = headers.findIndex((h: string) => h.includes("order date"));

      if (colArticle === -1) throw new Error("Colonne 'Article-No.' introuvable dans le fichier");
      if (colQtyAvail === -1) throw new Error("Colonne 'Quantity available' introuvable dans le fichier");

      // Extraire date commande + articles
      const firstDataRow = rows[headerRow + 1];
      const rawOrderDate = colOrderDate >= 0 ? firstDataRow?.[colOrderDate] : undefined;
      let orderDate: Date;
      if (!rawOrderDate) {
        orderDate = new Date();
      } else if (rawOrderDate instanceof Date) {
        orderDate = rawOrderDate;
      } else if (typeof rawOrderDate === "number") {
        // Excel serial date (days since 1900-01-01 minus leap-year bug)
        orderDate = new Date((rawOrderDate - 25569) * 86400000);
      } else {
        // String date — try direct parse, fall back to today
        const parsed = new Date(String(rawOrderDate));
        orderDate = isNaN(parsed.getTime()) ? new Date() : parsed;
      }
      // Réception = 10 du mois suivant
      const receptionDate = new Date(orderDate.getFullYear(), orderDate.getMonth() + 1, 10);
      const batchId = `order_${orderDate.toISOString().split("T")[0]}`;

      const orderItems: { supplierRef: string; qty: number; name: string }[] = [];
      for (let r = headerRow + 1; r < rows.length; r++) {
        const row = rows[r];
        const supplierRef = String(row[colArticle] ?? "").trim();
        if (!supplierRef) continue;
        // Quantité : peut être un number natif ou une string "2 600" / "2\u00A0600" (espace insécable FR)
        // On garde uniquement les chiffres (les quantités sont toujours entières)
        const rawQtyVal = row[colQtyAvail];
        const qty = typeof rawQtyVal === "number"
          ? rawQtyVal
          : parseFloat(String(rawQtyVal ?? "0").replace(/[^\d]/g, "")) || 0;
        const name = colDesc >= 0 ? String(row[colDesc] ?? "").trim() : supplierRef;
        if (qty > 0 && supplierRef) orderItems.push({ supplierRef, qty, name });
      }
      if (orderItems.length === 0) throw new Error("Aucun article avec quantité > 0 trouvé");

      // Matcher les refs fournisseur avec les default_code Odoo via product.supplierinfo
      const supplierRefs = orderItems.map(i => i.supplierRef);
      const supplierToOdooRef: Record<string, string> = {};
      try {
        // product.supplierinfo → product_code = ref fournisseur, product_tmpl_id = product.template
        const supplierInfos = await odoo.searchRead(session, "product.supplierinfo",
          [["product_code", "in", supplierRefs]], ["product_code", "product_tmpl_id"], 5000);
        const tmplIds = Array.from(new Set(
          supplierInfos.map((si: any) => si.product_tmpl_id?.[0]).filter(Boolean)
        )) as number[];
        if (tmplIds.length) {
          // Fetch default_code from product.template (always populated for simple products)
          const templates = await odoo.searchRead(session, "product.template",
            [["id", "in", tmplIds]], ["id", "default_code"], 5000);
          const refByTmplId: Record<number, string> = {};
          for (const t of templates) refByTmplId[t.id] = t.default_code || "";
          for (const si of supplierInfos) {
            const tmplId = si.product_tmpl_id?.[0];
            if (si.product_code && tmplId && refByTmplId[tmplId]) {
              supplierToOdooRef[si.product_code] = refByTmplId[tmplId];
            }
          }
        }
      } catch (e) { console.warn("Odoo supplier ref matching failed:", e); }

      const pendingList: supa.WmsPendingOrder[] = orderItems.map(item => ({
        batch_id: batchId,
        supplier_ref: item.supplierRef,
        odoo_ref: supplierToOdooRef[item.supplierRef] || null,
        product_name: item.name,
        qty_incoming: Math.round(item.qty),
        order_date: orderDate.toISOString().split("T")[0],
        expected_reception_date: receptionDate.toISOString().split("T")[0],
        status: "pending" as const,
      }));

      await supa.savePendingOrders(pendingList);
      const loaded = await supa.loadPendingOrders();
      setPendingOrders(loaded);

      const matched = pendingList.filter(o => o.odoo_ref).length;
      const unmatched = pendingList.length - matched;
      alert(
        `✓ Commande importée !\n` +
        `${pendingList.length} articles · ${matched} matchés avec Odoo${unmatched > 0 ? ` · ${unmatched} sans correspondance` : ""}.\n` +
        `Réception prévue le ${receptionDate.toLocaleDateString("fr-FR", { day: "2-digit", month: "long", year: "numeric" })}.\n\n` +
        `Les alertes sont recalculées en intégrant ce stock entrant.`
      );
      loadAlerts();
    } catch (err: any) {
      alert("Erreur import commande : " + err.message);
    } finally {
      setOrderImporting(false);
    }
  }, [session, loadAlerts]);

  // ── Charge conso depuis cache Supabase (instantané, pas d'appel Odoo) ──
  const loadConsoFromCache = useCallback(async () => {
    if (!session) return; setLoading(true); setError("");
    try {
      const months12 = monthsBack(consoMonths);
      const cached = await supa.loadConsoCache(months12);
      if (!cached.length) { setConso([]); setLoading(false); return; }

      const byRef: Record<string, { name: string; months: Record<string, number> }> = {};
      for (const cc of cached) {
        if (!byRef[cc.odoo_ref]) byRef[cc.odoo_ref] = { name: cc.product_name, months: {} };
        byRef[cc.odoo_ref].months[cc.month] = (byRef[cc.odoo_ref].months[cc.month] || 0) + cc.qty;
      }
      const rows: ConsoRow[] = Object.entries(byRef).map(([ref, v]) => {
        const total = Object.values(v.months).reduce((s, n) => s + n, 0);
        return { ref, name: v.name, months: v.months, total, avg: Math.round(total / consoMonths) };
      });
      rows.sort((a, b) => b.total - a.total);
      setConso(rows);
    } catch (e: any) { setError(e.message); } finally { setLoading(false); }
  }, [session, consoMonths]);

  // ── Charge conso depuis Odoo + sauvegarde cache + fige les seuils ──
  const loadConso = useCallback(async () => {
    if (!session) return; setLoading(true); setError("");
    try {
      const months = monthsBack(consoMonths);
      const [custLocs, intLocs] = await Promise.all([
        odoo.searchRead(session, "stock.location", [["usage", "=", "customer"]], ["id"], 100),
        odoo.searchRead(session, "stock.location", [["usage", "=", "internal"]], ["id"], 500),
      ]);
      const custLocIds = custLocs.map((l: any) => l.id);
      const intLocIds = intLocs.map((l: any) => l.id);

      let allLines: any[] = [];
      for (const m of months) {
        const mStart = m + "-01 00:00:00";
        const [y, mo] = m.split("-").map(Number);
        const lastDay = new Date(y, mo, 0).getDate();
        const mEnd = m + "-" + String(lastDay).padStart(2, "0") + " 23:59:59";
        const page = await odoo.searchRead(session, "stock.move.line", [
          ["state", "=", "done"],
          ["location_id", "in", intLocIds],
          ["location_dest_id", "in", custLocIds],
          ["date", ">=", mStart],
          ["date", "<=", mEnd],
        ], ["product_id", "qty_done", "date"], 10000);
        allLines = allLines.concat(page);
      }

      const byProd: Record<number, { name: string; ref: string; months: Record<string, number> }> = {};
      for (const ml of allLines) {
        const pid = ml.product_id[0];
        const month = (ml.date || "").substring(0, 7);
        if (!month) continue;
        if (!byProd[pid]) byProd[pid] = { name: ml.product_id[1], ref: "", months: {} };
        byProd[pid].months[month] = (byProd[pid].months[month] || 0) + (ml.qty_done || 0);
      }
      const prodIds = Object.keys(byProd).map(Number);
      if (prodIds.length) {
        const prods = await odoo.searchRead(session, "product.product", [["id", "in", prodIds]], ["id", "default_code"], 2000);
        for (const p of prods) if (byProd[p.id]) byProd[p.id].ref = p.default_code || "";
      }

      const rows: ConsoRow[] = Object.entries(byProd).map(([, v]) => {
        const total = Object.values(v.months).reduce((s, n) => s + n, 0);
        return { ref: v.ref, name: v.name, months: v.months, total, avg: Math.round(total / consoMonths) };
      });
      rows.sort((a, b) => b.total - a.total);
      setConso(rows);

      // Sauvegarde cache Supabase — dédupliquer par (odoo_ref, month) avant upsert
      const cacheMap: Record<string, supa.WmsConsoCache> = {};
      for (const row of rows) {
        if (!row.ref) continue;
        for (const [month, qty] of Object.entries(row.months)) {
          const key = `${row.ref}__${month}`;
          if (!cacheMap[key]) cacheMap[key] = { odoo_ref: row.ref, product_name: row.name, month, qty: 0 };
          cacheMap[key].qty += qty;
        }
      }
      await supa.saveConsoCache(Object.values(cacheMap));
      setConsoSyncedAt(new Date());

      // Fige les seuils : total/12 par produit — dédupliquer par odoo_ref
      const newThreshByRef: Record<string, number> = {};
      for (const row of rows) {
        if (!row.ref) continue;
        const existing = newThreshByRef[row.ref] || 0;
        newThreshByRef[row.ref] = Math.max(1, Math.round((existing * consoMonths + row.total) / consoMonths));
      }
      // Seuil = 1 pour articles en stock sans historique conso
      for (const data of Object.values(stockMap)) {
        if (!data.ref || newThreshByRef[data.ref]) continue;
        newThreshByRef[data.ref] = 1;
      }
      const thresholdItems: supa.WmsThreshold[] = Object.entries(newThreshByRef).map(([ref, thresh]) => ({
        odoo_ref: ref, threshold: thresh, product_name: rows.find(r => r.ref === ref)?.name || stockMap[Object.keys(stockMap).find(k => stockMap[Number(k)]?.ref === ref) as any]?.name || ref,
      }));
      if (thresholdItems.length > 0) {
        await supa.saveThresholdsBulk(thresholdItems);
        setThresholdsByRef(newThreshByRef);
        // Mettre à jour thresholds[pid] immédiatement sans attendre loadAlerts
        const newT: Record<number, number> = {};
        for (const [pidStr, data] of Object.entries(stockMap)) {
          if (!data.ref) continue;
          newT[Number(pidStr)] = newThreshByRef[data.ref] ?? defaultThreshold;
        }
        setThresholds(newT);
      }
    } catch (e: any) { setError(e.message); } finally { setLoading(false); }
  }, [session, consoMonths, stockMap]);


  const loadDeliveries = useCallback(async () => {
    if (!session) return; setLoading(true); setError(""); setPrepStats([]);
    try {
      // Get picking type IDs for OUT and PICK (internal)
      // Note: picking type code "internal" covers PICK, PACK, etc. — we separate by name/sequence_code
      const pickingTypes = await odoo.searchRead(session, "stock.picking.type", [["code", "in", ["outgoing", "internal"]]], ["id", "code", "sequence_code", "name"], 50);
      const outTypeIds = pickingTypes.filter((t: any) => t.code === "outgoing").map((t: any) => t.id);

      // PICK types = internal types whose sequence_code or name contains "pick" or "prel" (prélèvement)
      // Falls back to ALL internal types if none match — avoids missing preps
      const pickCandidates = pickingTypes.filter((t: any) => {
        const sc = (t.sequence_code || "").toLowerCase();
        const nm = (t.name || "").toLowerCase();
        return sc.includes("pick") || nm.includes("pick") || sc.includes("prel") || nm.includes("prél") || nm.includes("prele");
      });
      // If no specific match, take all internal types to avoid losing data
      const pickTypeIds = (pickCandidates.length ? pickCandidates : pickingTypes.filter((t: any) => t.code === "internal")).map((t: any) => t.id);

      // Load OUT pickings — add write_uid (= user who validated, i.e. the actual preparer)
      const outPickings = outTypeIds.length ? await odoo.searchRead(session, "stock.picking", [["state", "=", "done"], ["picking_type_id", "in", outTypeIds], ["date_done", ">=", delStart + " 00:00:00"], ["date_done", "<=", delEnd + " 23:59:59"]], ["name", "date_done", "partner_id", "move_ids", "write_uid"], 2000, "date_done desc") : [];

      // Load PICK pickings
      const pickPickings = pickTypeIds.length ? await odoo.searchRead(session, "stock.picking", [["state", "=", "done"], ["picking_type_id", "in", pickTypeIds], ["date_done", ">=", delStart + " 00:00:00"], ["date_done", "<=", delEnd + " 23:59:59"]], ["name", "date_done", "move_ids", "write_uid"], 2000, "date_done desc") : [];

      const allPickings = [...outPickings.map((p: any) => ({ ...p, pickKind: "out" })), ...pickPickings.map((p: any) => ({ ...p, pickKind: "pick" }))];

      const byDate: Record<string, { count: number; lines: number }> = {};
      for (const p of allPickings.filter((p: any) => p.pickKind === "out")) {
        const date = (p.date_done || "").substring(0, 10);
        if (!byDate[date]) byDate[date] = { count: 0, lines: 0 };
        byDate[date].count++;
        byDate[date].lines += (p.move_ids || []).length;
      }
      setDeliveries(Object.entries(byDate).sort(([a], [b]) => b.localeCompare(a)).map(([date, v]) => ({ date, ...v })));

      // Stats préparateurs
      // write_uid = dernier utilisateur à avoir modifié le picking = celui qui a validé (préparé)
      // user_id = "Responsable" Odoo = souvent le vendeur, PAS le préparateur → on l'ignore
      const prepByUser: Record<string, { picking: number; emballage: number }> = {};
      for (const p of allPickings) {
        const name = p.write_uid?.[1] || "Inconnu";
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
        const isInventory = fromU === "inventory" || toU === "inventory";
        const type = fromU === "supplier" || (toU === "internal" && fromU !== "internal" && !isInventory) ? "Entrée"
          : toU === "customer" || (fromU === "internal" && toU !== "internal" && !isInventory) ? "Sortie"
          : isInventory ? (toU === "internal" ? "Ajustement +" : "Ajustement −") : "Interne";
        const pickId = m.picking_id?.[0];
        const prodName = m.product_id?.[1] || "—";
        const prodRef = hasRef ? "" : (prodRefs[m.product_id?.[0]] || "");
        const productLabel = prodRef ? `[${prodRef}] ${prodName}` : prodName;
        return {
          date: m.date, type, qty: m.product_qty, isInventory,
          lot: Array.isArray(m.lot_ids) ? m.lot_ids.join(", ") || "—" : "—",
          from: m.location_id?.[1] || "—", to: m.location_dest_id?.[1] || "—",
          picking: m.picking_id?.[1] || "—",
          partner: pickId ? (pickingPartner[pickId] || "—") : "—",
          product: productLabel,
        };
      }));

      // Si recherche par ref → fetcher le stock actuel Odoo pour le suivi
      if (hasRef) {
        try {
          const refTrimmed = moveRef.trim();
          const prodSearch = await odoo.searchRead(session, "product.product",
            [["default_code", "=ilike", refTrimmed]], ["id", "display_name"], 1);
          if (prodSearch.length) {
            const prodId = prodSearch[0].id;
            setMoveProductName(prodSearch[0].display_name || refTrimmed);
            const quants = await odoo.searchRead(session, "stock.quant",
              [["product_id", "=", prodId], ["location_id.usage", "=", "internal"]], ["qty_on_hand"], 500);
            const total = quants.reduce((s: number, q: any) => s + (q.qty_on_hand || 0), 0);
            setMoveProductCurrentStock(total);
          }
        } catch { setMoveProductCurrentStock(null); }
      } else {
        setMoveProductCurrentStock(null);
        setMoveProductName("");
      }

      setMoveColFilters({}); setMoveColSort({ col: "date", dir: "desc" });
    } catch (e: any) { setError(e.message); } finally { setLoading(false); }
  }, [session, moveRef, moveStart, moveEnd]);

  // ── Mode Libre ──
  const analyzeLibreText = useCallback(() => {
    if (!libreText.trim()) return;
    const text = libreText;
    const found = new Map<string, LibreRefType>();

    // Pickings WH/PICK/xxx WH/OUT/xxx etc.
    const pickingRe = /\bWH\/[A-Z]+\/\d+\b/g;
    let pm; while ((pm = pickingRe.exec(text)) !== null) found.set(pm[0], "picking");

    // SO: S suivi de 4+ chiffres
    const soRe = /\bS\d{4,}\b/g;
    let sm; while ((sm = soRe.exec(text)) !== null) if (!found.has(sm[0])) found.set(sm[0], "so");

    // Refs produit: séquences alphanumériques de 5-15 chars (pas déjà détectées)
    const refRe = /\b([A-Z0-9]{5,15})\b/g;
    let rm; while ((rm = refRe.exec(text)) !== null) {
      if (!found.has(rm[0]) && !/^\d+$/.test(rm[0])) found.set(rm[0], "product");
    }

    // Codes purement numériques 6-13 chiffres → ref produit, lot ou EAN
    const numRe = /\b\d{6,13}\b/g;
    let nm; while ((nm = numRe.exec(text)) !== null) if (!found.has(nm[0])) found.set(nm[0], "product");

    const refs: LibreRef[] = Array.from(found.entries()).map(([raw, type]) => ({ raw, type }));
    setLibreRefs(refs);
    setLibreRows([]);
    setLibreAnalyzed(true);
  }, [libreText]);

  const generateLibreTable = useCallback(async () => {
    if (!session || libreRefs.length === 0 || libreCols.length === 0) return;
    setLibreLoading(true);
    const rows: Record<string, any>[] = [];
    for (const ref of libreRefs) {
      const row: Record<string, any> = { "Référence": ref.raw, "Type": ref.type };
      try {
        if (ref.type === "product" || ref.type === "unknown") {
          const needsProduct = libreCols.some(c => ["stock_dispo","stock_total","nom_produit","ref_produit","poids","dimensions","ref_fournisseur","lots_en_stock"].includes(c.key));
          if (needsProduct) {
            const prods = await odoo.searchRead(session, "product.product",
              ["|", ["default_code", "=", ref.raw], ["barcode", "=", ref.raw]],
              ["id","name","default_code","weight","volume","product_tmpl_id"], 1);
            if (prods.length) {
              const p = prods[0];
              row["nom_produit"] = p.name;
              row["ref_produit"] = p.default_code || ref.raw;
              if (libreCols.some(c => c.key === "poids")) row["poids"] = p.weight ? String(p.weight).replace(".", ",") : "";
              if (libreCols.some(c => c.key === "dimensions")) {
                try {
                  const tmpl = await odoo.searchRead(session, "product.template",
                    [["id","=",p.product_tmpl_id[0]]], ["x_dimensions"], 1);
                  row["dimensions"] = tmpl[0]?.x_dimensions || "";
                } catch { row["dimensions"] = ""; }
              }
              if (libreCols.some(c => c.key === "ref_fournisseur")) {
                const suppliersT = await odoo.searchRead(session, "product.supplierinfo",
                  [["product_tmpl_id","=",p.product_tmpl_id[0]]], ["product_code","partner_id"], 1);
                row["ref_fournisseur"] = suppliersT[0]?.product_code || "";
              }
              if (libreCols.some(c => c.key === "stock_dispo" || c.key === "stock_total" || c.key === "lots_en_stock")) {
                const quants = await odoo.searchRead(session, "stock.quant",
                  [["product_id","=",p.id],["location_id.usage","=","internal"]],
                  ["quantity","reserved_quantity","lot_id"], 500);
                const total = quants.reduce((s: number, q: any) => s + q.quantity, 0);
                const reserved = quants.reduce((s: number, q: any) => s + (q.reserved_quantity||0), 0);
                row["stock_total"] = Math.round(total);
                row["stock_dispo"] = Math.round(total - reserved);
                if (libreCols.some(c => c.key === "lots_en_stock")) {
                  const lotMap: Record<string, number> = {};
                  for (const q of quants) {
                    if (q.lot_id && q.quantity > 0) {
                      const name = q.lot_id[1];
                      lotMap[name] = (lotMap[name] || 0) + q.quantity;
                    }
                  }
                  row["lots_en_stock"] = Object.entries(lotMap).map(([n,qty]) => `${n}: ${Math.round(qty as number)}`).join(" | ") || "";
                }
              }
            } else {
              row["_error"] = "Introuvable";
            }
          }
        } else if (ref.type === "lot") {
          const lots = await odoo.searchRead(session, "stock.lot",
            [["name","=",ref.raw]], ["id","name","product_id","expiration_date","use_date"], 1);
          if (lots.length) {
            const l = lots[0];
            row["lot_produit"] = l.product_id?.[1] || "";
            row["lot_expiry"] = l.expiration_date || l.use_date || "";
            if (libreCols.some(c => c.key === "stock_dispo" || c.key === "stock_total")) {
              const quants = await odoo.searchRead(session, "stock.quant",
                [["lot_id","=",l.id],["location_id.usage","=","internal"]],
                ["quantity","reserved_quantity"], 100);
              const total = quants.reduce((s: number, q: any) => s + q.quantity, 0);
              const reserved = quants.reduce((s: number, q: any) => s + (q.reserved_quantity||0), 0);
              row["stock_total"] = Math.round(total);
              row["stock_dispo"] = Math.round(total - reserved);
            }
          } else {
            row["_error"] = "Lot introuvable";
          }
        } else if (ref.type === "so") {
          const orders = await odoo.searchRead(session, "sale.order",
            [["name","=",ref.raw]], ["id","name","partner_id","state","amount_total"], 1);
          if (orders.length) {
            const o = orders[0];
            const stateMap: Record<string,string> = { draft:"Devis", sent:"Devis envoyé", sale:"Confirmée", done:"Clôturée", cancel:"Annulée" };
            row["so_client"] = o.partner_id?.[1] || "";
            row["so_statut"] = stateMap[o.state] || o.state;
            row["so_montant"] = o.amount_total?.toFixed(2) + " €";
          } else {
            row["_error"] = "Commande introuvable";
          }
        } else if (ref.type === "picking") {
          const picks = await odoo.searchRead(session, "stock.picking",
            [["name","=",ref.raw]], ["id","name","state","partner_id","carrier_id"], 1);
          if (picks.length) {
            const p = picks[0];
            const stateMap: Record<string,string> = { draft:"Brouillon", waiting:"En attente", confirmed:"Confirmé", assigned:"Prêt", done:"Terminé", cancel:"Annulé" };
            row["picking_statut"] = stateMap[p.state] || p.state;
            row["picking_client"] = p.partner_id?.[1] || "";
          } else {
            row["_error"] = "BL introuvable";
          }
        }
      } catch { row["_error"] = "Erreur requête"; }
      rows.push(row);
    }
    setLibreRows(rows);
    setLibreLoading(false);
  }, [session, libreRefs, libreCols]);

  const exportLibreExcel = useCallback(() => {
    if (libreRows.length === 0) return;
    const headers = ["Référence", ...libreCols.map(c => c.label)];
    const thStyle = `background:#1e293b;color:#fff;font-weight:700;padding:10px 14px;text-align:left;font-size:12px;letter-spacing:.3px;white-space:nowrap;border:1px solid #334155;`;
    const tdStyle = (i: number) => `padding:8px 14px;font-size:12px;border:1px solid #e2e8f0;background:${i % 2 === 0 ? "#fff" : "#f8fafc"};color:#1e293b;`;
    const refStyle = (i: number) => `${tdStyle(i)}font-weight:700;font-family:monospace;`;
    const rows = libreRows.map((row, i) => {
      const cells = [
        `<td style="${refStyle(i)}">${row["Référence"] ?? ""}</td>`,
        ...libreCols.map(col => {
          const val = row[col.key] ?? (row["_error"] ? `<span style="color:#ef4444">${row["_error"]}</span>` : "—");
          return `<td style="${tdStyle(i)}">${val}</td>`;
        }),
      ];
      return `<tr>${cells.join("")}</tr>`;
    }).join("");
    const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="UTF-8"><!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>Export</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]--></head><body><table><thead><tr>${headers.map(h => `<th style="${thStyle}">${h}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></body></html>`;
    const blob = new Blob([html], { type: "application/vnd.ms-excel;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `export_libre_${new Date().toISOString().split("T")[0]}.xls`;
    a.click(); URL.revokeObjectURL(url);
  }, [libreRows, libreCols]);

  useEffect(() => { if (!session) return; if (tab === "deliveries") loadDeliveries(); if (tab === "stock-monitor") smLoad(); }, [tab, session]); // eslint-disable-line react-hooks/exhaustive-deps

  // ══════════════════════════════════════════════════════
  // SUIVI STOCK — nouveau tab (remplace Alertes + Conso)
  // ══════════════════════════════════════════════════════
  interface SmRow { ref: string; name: string; stock: number; conso: number; threshold: number; daysLeft: number; daysUntilDeliv: number; delivLabel: string; supplierDate: string | null; status: "ok"|"alert"|"critical"|"no_data"|"not_found"; }

  const [smRefs, setSmRefs] = useState<{ref:string;name:string}[]>([]);
  const [smRows, setSmRows] = useState<SmRow[]>([]);
  const [smLoading, setSmLoading] = useState(false);
  const [smMsg, setSmMsg] = useState("");
  const [smSearch, setSmSearch] = useState("");
  const [smFilter, setSmFilter] = useState<"all"|"critical"|"alert"|"ok">("all");
  const [smEditThr, setSmEditThr] = useState<{ref:string;val:string}|null>(null);
  const [smSupModal, setSmSupModal] = useState<{ref:string;name:string;cur:string}|null>(null);
  const [smSupInput, setSmSupInput] = useState("");
  const smFileRef = useRef<HTMLInputElement>(null);

  const smNextDelivery = (supDate?: string|null): {date:Date;label:string} => {
    if (supDate) { const d=new Date(supDate+"T00:00:00"); return {date:d,label:`Fourn. ${d.toLocaleDateString("fr-FR",{day:"2-digit",month:"short"})}`}; }
    const d=new Date(new Date().getFullYear(),new Date().getMonth()+1,15);
    return {date:d,label:`15 ${d.toLocaleDateString("fr-FR",{month:"short",year:"numeric"})}`};
  };
  const smDaysUntil = (d:Date) => Math.ceil((d.getTime()-new Date().setHours(0,0,0,0))/86400000);
  const smStatus = (stock:number,conso:number,thr:number,daysLeft:number,daysDeliv:number): SmRow["status"] => {
    if (conso===0&&stock===0) return "no_data";
    if (daysLeft<daysDeliv) return "critical";
    if (daysLeft<daysDeliv+14||stock<thr) return "alert";
    return "ok";
  };

  const smBuildRows = useCallback((refs:{ref:string;name:string}[], stockByRef:Record<string,{id:number;name:string;qty:number}>, consoByRef:Record<string,number>, thrMap:Record<string,number>, supMap:Record<string,string|null>): SmRow[] => {
    return refs.map(({ref,name:rname}) => {
      const od=stockByRef[ref];
      if (!od) return {ref,name:rname||ref,stock:0,conso:0,threshold:thrMap[ref]??0,daysLeft:0,daysUntilDeliv:0,delivLabel:"-",supplierDate:supMap[ref]??null,status:"not_found"};
      const stock=od.qty, conso=consoByRef[ref]??0, threshold=thrMap[ref]??Math.round(conso);
      const {date:dd,label:dl}=smNextDelivery(supMap[ref]);
      const daysUntilDeliv=Math.max(0,smDaysUntil(dd));
      const daysLeft=conso>0?Math.round(stock*30/conso):(stock>0?999:0);
      return {ref,name:od.name,stock,conso:Math.round(conso*10)/10,threshold,daysLeft,daysUntilDeliv,delivLabel:dl,supplierDate:supMap[ref]??null,status:smStatus(stock,conso,threshold,daysLeft,daysUntilDeliv)};
    });
  },[]);

  const smLoad = useCallback(async () => {
    if (!session) return;
    setSmLoading(true); setSmMsg("Chargement références...");
    try {
      const [{data:refData},{data:thrData},{data:supData}] = await Promise.all([
        supa.sb.from("dashboard_refs").select("ref,product_name").order("ref"),
        supa.sb.from("dashboard_thresholds").select("ref,threshold"),
        supa.sb.from("dashboard_supplier_dates").select("ref,supplier_date"),
      ]);
      const refs=(refData||[]).map((r:any)=>({ref:r.ref,name:r.product_name}));
      const thrMap:Record<string,number>=Object.fromEntries((thrData||[]).map((r:any)=>[r.ref,r.threshold]));
      const supMap:Record<string,string|null>=Object.fromEntries((supData||[]).map((r:any)=>[r.ref,r.supplier_date]));
      setSmRefs(refs);
      if (!refs.length){setSmLoading(false);setSmMsg("");return;}
      setSmMsg("Stock Odoo...");
      const prods:any[]=await odoo.searchRead(session,"product.product",[["default_code","in",refs.map(r=>r.ref)],["active","in",[true,false]]],["id","name","default_code","qty_available"],0);
      const stockByRef:Record<string,{id:number;name:string;qty:number}>={};
      for(const p of prods) if(p.default_code) stockByRef[p.default_code]={id:p.id,name:p.name,qty:p.qty_available??0};
      setSmMsg("Consommation (3 mois)...");
      const today=new Date();
      const from=new Date(today.getFullYear(),today.getMonth()-3,1).toISOString().slice(0,10)+" 00:00:00";
      const curMonthStart=new Date(today.getFullYear(),today.getMonth(),1).toISOString().slice(0,10)+" 00:00:00";
      const pids=Object.values(stockByRef).map(p=>p.id);
      const consoByRef:Record<string,number>={};
      if(pids.length){
        const moves:any[]=await odoo.searchRead(session,"stock.move",[["state","=","done"],["product_id","in",pids],["date",">=",from],["date","<",curMonthStart],["location_id.usage","=","internal"],["location_dest_id.usage","=","customer"]],["product_id","product_uom_qty","date"],0);
        const byPidMonth:Record<number,Record<string,number>>={};
        for(const m of moves){const pid=Array.isArray(m.product_id)?m.product_id[0]:m.product_id;const mo=String(m.date||"").slice(0,7);if(!byPidMonth[pid])byPidMonth[pid]={};byPidMonth[pid][mo]=(byPidMonth[pid][mo]||0)+(m.product_uom_qty||0);}
        const months3:string[]=[];for(let i=3;i>=1;i--){const d=new Date(today.getFullYear(),today.getMonth()-i,1);months3.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`);}
        for(const [ref,info] of Object.entries(stockByRef)){const pid=info.id;const qtys=months3.map(m=>byPidMonth[pid]?.[m]??0);const nz=qtys.filter(q=>q>0).length;consoByRef[ref]=nz>0?qtys.reduce((a,b)=>a+b,0)/nz:0;}
      }
      const rows=smBuildRows(refs,stockByRef,consoByRef,thrMap,supMap);
      setSmRows(rows);
    } catch(e:any){setError(e.message);}
    finally{setSmLoading(false);setSmMsg("");}
  },[session,smBuildRows]);

  const smImportExcel = async (e:React.ChangeEvent<HTMLInputElement>) => {
    const file=e.target.files?.[0]; if(!file)return;
    const XLSX=(await import("xlsx"));
    setSmLoading(true);setSmMsg("Lecture Excel...");
    try{
      const buf=await file.arrayBuffer();
      const wb=XLSX.read(buf,{type:"array"});
      const ws=wb.Sheets[wb.SheetNames[0]];
      const data:any[][]=XLSX.utils.sheet_to_json(ws,{header:1});
      const headers=(data[0]||[]).map((h:any)=>String(h||"").toLowerCase().trim());
      const ri=headers.findIndex((h:string)=>h.includes("ref")||h.includes("code")||h.includes("sku")||h.includes("article"));
      const ni=headers.findIndex((h:string)=>h.includes("nom")||h.includes("name")||h.includes("désig")||h.includes("produit"));
      const rc=ri>=0?ri:0, nc=ni>=0?ni:-1;
      const newRefs:{ref:string;name:string}[]=[];
      for(let i=1;i<data.length;i++){const row=data[i];const ref=String(row[rc]??"").trim();if(!ref)continue;newRefs.push({ref,product_name:nc>=0?String(row[nc]??"").trim():""}as any);}
      if(!newRefs.length){setError("Aucune référence trouvée");return;}
      await supa.sb.from("dashboard_refs").delete().neq("ref","___x___");
      await supa.sb.from("dashboard_refs").upsert(newRefs.map(r=>({ref:r.ref,product_name:(r as any).product_name})),{onConflict:"ref"});
      setSmRefs(newRefs.map(r=>({ref:r.ref,name:(r as any).product_name})));
      setSmMsg(`${newRefs.length} refs importées — sync Odoo...`);
      await smLoad();
    }catch(e:any){setError("Import: "+e.message);}
    finally{setSmLoading(false);setSmMsg("");if(smFileRef.current)smFileRef.current.value="";}
  };

  const smSaveThr = async (ref:string,val:string,name:string) => {
    const n=parseFloat(val); if(isNaN(n)||n<0){setSmEditThr(null);return;}
    setSmRows(r=>r.map(row=>{if(row.ref!==ref)return row;const u={...row,threshold:n};u.status=smStatus(u.stock,u.conso,n,u.daysLeft,u.daysUntilDeliv);return u;}));
    setSmEditThr(null);
    await supa.sb.from("dashboard_thresholds").upsert({ref,threshold:n,product_name:name,updated_at:new Date().toISOString()},{onConflict:"ref"});
  };

  const smSaveSupDate = async () => {
    if(!smSupModal)return;
    const {ref}=smSupModal; const d=smSupInput||null;
    setSmRows(r=>r.map(row=>{if(row.ref!==ref)return row;const {date:dd,label:dl}=smNextDelivery(d);const dtu=Math.max(0,smDaysUntil(dd));const u={...row,supplierDate:d,daysUntilDeliv:dtu,delivLabel:dl};u.status=smStatus(u.stock,u.conso,u.threshold,u.daysLeft,dtu);return u;}));
    if(d) await supa.sb.from("dashboard_supplier_dates").upsert({ref,supplier_date:d,updated_at:new Date().toISOString()},{onConflict:"ref"});
    else await supa.sb.from("dashboard_supplier_dates").delete().eq("ref",ref);
    setSmSupModal(null);setSmSupInput("");
  };

  const smFiltered = useMemo(()=>{
    const ord:Record<string,number>={critical:0,alert:1,no_data:2,ok:3,not_found:4};
    return smRows.filter(r=>{
      if(smFilter==="critical"&&r.status!=="critical")return false;
      if(smFilter==="alert"&&r.status!=="alert")return false;
      if(smFilter==="ok"&&r.status!=="ok"&&r.status!=="no_data")return false;
      if(smSearch){const q=smSearch.toLowerCase();if(!r.ref.toLowerCase().includes(q)&&!r.name.toLowerCase().includes(q))return false;}
      return true;
    }).sort((a,b)=>ord[a.status]-ord[b.status]||(a.daysLeft-b.daysLeft));
  },[smRows,smFilter,smSearch]);

  const smCounts=useMemo(()=>({critical:smRows.filter(r=>r.status==="critical").length,alert:smRows.filter(r=>r.status==="alert").length,ok:smRows.filter(r=>r.status==="ok").length}),[smRows]);

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
    const search = consoSearch.trim().toLowerCase();
    let r = search
      ? conso.filter(row => row.ref.toLowerCase().includes(search) || row.name.toLowerCase().includes(search))
      : [...conso];
    if (consoColSort.dir) { const d = consoColSort.dir === "asc" ? 1 : -1; const c = consoColSort.col; r.sort((a, b) => c === "ref" ? d * (a.ref || "").localeCompare(b.ref || "") : c === "name" ? d * a.name.localeCompare(b.name) : c === "avg" ? d * (a.avg - b.avg) : c === "total" ? d * (a.total - b.total) : d * ((a.months[c] || 0) - (b.months[c] || 0))); }
    return r;
  }, [conso, consoColSort, consoSearch]);

  // ── Suivi stock : solde cumulatif chronologique ──
  const stockRunningBalance = useMemo(() => {
    if (!moveRef.trim() || !moves.length) return [];
    // Trier du plus ancien au plus récent
    const sorted = [...moves].sort((a, b) => a.date.localeCompare(b.date));
    let balance = 0;
    return sorted.map(m => {
      const delta = m.type === "Entrée" || m.type === "Ajustement +" ? m.qty
        : m.type === "Sortie" || m.type === "Ajustement −" ? -m.qty : 0;
      balance += delta;
      return { ...m, delta, balance };
    });
  }, [moves, moveRef]);

  // ── Anomalies de stock ──
  const stockAnomalies = useMemo(() => {
    if (!stockRunningBalance.length) return [];
    const anomalies: { date: string; label: string; severity: "error" | "warning"; qty?: number }[] = [];
    const qtys = stockRunningBalance.filter(m => m.delta !== 0).map(m => Math.abs(m.delta));
    const mean = qtys.reduce((s, v) => s + v, 0) / (qtys.length || 1);
    const stddev = Math.sqrt(qtys.reduce((s, v) => s + (v - mean) ** 2, 0) / (qtys.length || 1));
    for (const m of stockRunningBalance) {
      if (m.balance < 0)
        anomalies.push({ date: m.date, label: `Stock théorique négatif après ce mouvement (${Math.round(m.balance)})`, severity: "error", qty: m.qty });
      if (m.isInventory)
        anomalies.push({ date: m.date, label: `${m.type} : ajustement manuel de stock (${m.type === "Ajustement +" ? "+" : "−"}${m.qty})`, severity: "warning", qty: m.qty });
      if (stddev > 0 && Math.abs(m.delta) > mean + 3 * stddev)
        anomalies.push({ date: m.date, label: `Mouvement anormalement élevé (${m.qty} unités — ${Math.round(Math.abs(m.delta) / stddev)}σ)`, severity: "warning", qty: m.qty });
    }
    // Écart théorique vs stock Odoo actuel
    if (moveProductCurrentStock !== null) {
      const theoretical = stockRunningBalance[stockRunningBalance.length - 1].balance;
      const diff = moveProductCurrentStock - theoretical;
      if (Math.abs(diff) > 0.5)
        anomalies.push({ date: "Aujourd'hui", label: `Écart solde théorique (${Math.round(theoretical)}) vs stock Odoo actuel (${Math.round(moveProductCurrentStock)}) : ${diff > 0 ? "+" : ""}${Math.round(diff)} unités non expliquées`, severity: Math.abs(diff) > 10 ? "error" : "warning" });
    }
    return anomalies;
  }, [stockRunningBalance, moveProductCurrentStock]);

  // ── Stats livraisons enrichies ──
  const deliveryStatsEnriched = useMemo(() => {
    if (!filteredDel.length) return null;
    const sorted = [...filteredDel].sort((a, b) => b.count - a.count);
    const bestDay = sorted[0];
    const worstDay = sorted[sorted.length - 1];
    // Heatmap par jour de la semaine (0=dim, 1=lun, …)
    const DAYS_FR = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"];
    const byWeekday: Record<number, { total: number; count: number }> = {};
    for (const d of filteredDel) {
      const dow = new Date(d.date).getDay();
      if (!byWeekday[dow]) byWeekday[dow] = { total: 0, count: 0 };
      byWeekday[dow].total += d.count;
      byWeekday[dow].count++;
    }
    const weekdayAvg = Array.from({ length: 7 }, (_, i) =>
      ({ label: DAYS_FR[i], avg: byWeekday[i] ? Math.round(byWeekday[i].total / byWeekday[i].count) : 0, days: byWeekday[i]?.count || 0 }));
    const topPreparer = prepStats.length ? prepStats.reduce((a, b) => b.picking > a.picking ? b : a, prepStats[0]) : null;
    const topPacker = prepStats.length ? prepStats.reduce((a, b) => b.emballage > a.emballage ? b : a, prepStats[0]) : null;
    return { bestDay, worstDay, weekdayAvg, topPreparer, topPacker };
  }, [filteredDel, prepStats]);

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
  // Bloquer le render tant que localStorage n'a pas été lu (évite le flash FOUC)
  if (!mounted) return (
    <div className="wms-root" data-theme="light" style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", background: "var(--bg)" }}>
      <style>{GLOBAL_CSS}</style>
      <Spinner size={32} />
    </div>
  );

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

        {/* ══════════ SUIVI STOCK ══════════ */}
        {tab === "stock-monitor" && (
          <div style={{animation:"fadeIn .3s ease both"}}>
            {/* Supplier date modal */}
            {smSupModal&&<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.45)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000}}>
              <div style={{background:"#fff",borderRadius:14,padding:28,width:340,boxShadow:"0 8px 32px rgba(0,0,0,0.18)"}}>
                <div style={{fontSize:15,fontWeight:800,marginBottom:4}}>📅 Rupture fournisseur</div>
                <div style={{fontSize:12,color:"var(--text-muted)",marginBottom:16}}>{smSupModal.ref} — {smSupModal.name}</div>
                <label style={{fontSize:12,fontWeight:600,display:"flex",flexDirection:"column",gap:6}}>
                  Date de prochaine dispo fournisseur
                  <input type="date" value={smSupInput} onChange={e=>setSmSupInput(e.target.value)} style={{padding:"10px 12px",border:"1px solid var(--border)",borderRadius:8,fontSize:13,fontFamily:"inherit"}}/>
                </label>
                <div style={{fontSize:11,color:"var(--text-muted)",marginTop:8}}>Laisse vide → livraison standard (15 du mois prochain).</div>
                <div style={{display:"flex",gap:8,marginTop:18}}>
                  <button onClick={()=>{setSmSupModal(null);setSmSupInput("");}} className="wms-btn" style={{flex:1}}>Annuler</button>
                  <button onClick={smSaveSupDate} className="wms-btn wms-btn-primary" style={{flex:2}}>Enregistrer</button>
                </div>
                {smSupModal.cur&&<button onClick={()=>{setSmSupInput("");smSaveSupDate();}} style={{width:"100%",marginTop:8,padding:"8px 0",background:"#fef2f2",color:"var(--danger)",border:"1px solid #fecaca",borderRadius:8,cursor:"pointer",fontSize:12,fontFamily:"inherit"}}>Effacer la rupture</button>}
              </div>
            </div>}

            {/* Header */}
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20,flexWrap:"wrap",gap:12}}>
              <div>
                <h2 style={{fontSize:22,fontWeight:800,letterSpacing:"-.3px",marginBottom:4}}>Suivi Stock</h2>
                <p style={{fontSize:13,color:"var(--text-muted)"}}>Stock en temps réel · Conso moyenne 3 mois (OUT) · Livraison le 15 du mois suivant</p>
              </div>
              <div style={{display:"flex",gap:10,alignItems:"center"}}>
                <button className="wms-btn" onClick={()=>smLoad()} disabled={smLoading}>{smLoading?<Spinner/>:I.refresh} Actualiser</button>
                <input ref={smFileRef} type="file" accept=".xlsx,.xls,.csv" onChange={smImportExcel} style={{display:"none"}}/>
                <button className="wms-btn wms-btn-primary" onClick={()=>smFileRef.current?.click()} disabled={smLoading}>📤 Importer Excel refs</button>
              </div>
            </div>

            {smMsg&&<div style={{fontSize:13,color:"var(--accent)",marginBottom:12}}>⏳ {smMsg}</div>}

            {/* No refs */}
            {smRefs.length===0&&!smLoading&&(
              <div style={{background:"var(--bg)",border:"1px solid var(--border)",borderRadius:14,padding:48,textAlign:"center"}}>
                <div style={{fontSize:36,marginBottom:12}}>📋</div>
                <div style={{fontSize:16,fontWeight:700,marginBottom:8}}>Aucune référence chargée</div>
                <p style={{fontSize:13,color:"var(--text-muted)",marginBottom:20}}>Importe ton fichier Excel avec tes ~350 références à surveiller.</p>
                <p style={{fontSize:12,color:"var(--text-muted)",background:"#f8fafc",padding:"12px 16px",borderRadius:8,display:"inline-block",textAlign:"left"}}>
                  <strong>Format :</strong> colonne "Ref" (ou "Code", "SKU"…) avec les références Odoo. Colonne "Nom" optionnelle.
                </p>
              </div>
            )}

            {smRefs.length>0&&(
              <>
                {/* KPIs */}
                <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12,marginBottom:18}}>
                  {([
                    {label:"Références",val:smRefs.length,color:"#3b82f6",bg:"#eff6ff",f:null},
                    {label:"🔴 Critiques",val:smCounts.critical,color:"#ef4444",bg:"#fef2f2",f:"critical"},
                    {label:"🟡 Alertes",val:smCounts.alert,color:"#f59e0b",bg:"#fffbeb",f:"alert"},
                    {label:"🟢 OK",val:smCounts.ok,color:"#22c55e",bg:"#f0fdf4",f:"ok"},
                  ] as any[]).map(({label,val,color,bg,f})=>(
                    <div key={label} onClick={()=>f&&setSmFilter((p:any)=>p===f?"all":f)} style={{background:bg,border:`1px solid ${color}22`,borderRadius:12,padding:"14px 18px",cursor:f?"pointer":"default",outline:smFilter===f?`2px solid ${color}`:"none"}}>
                      <div style={{fontSize:11,fontWeight:700,color,textTransform:"uppercase",letterSpacing:.5}}>{label}</div>
                      <div style={{fontSize:30,fontWeight:900,color,lineHeight:1.2}}>{val}</div>
                    </div>
                  ))}
                </div>

                {/* Filters */}
                <div style={{display:"flex",gap:8,marginBottom:12,alignItems:"center",flexWrap:"wrap"}}>
                  {(["all","critical","alert","ok"] as const).map(f=>(
                    <button key={f} onClick={()=>setSmFilter(f)} className="wms-btn" style={{borderRadius:20,background:smFilter===f?"var(--accent)":"#fff",color:smFilter===f?"#fff":"var(--text-muted)",border:`1px solid ${smFilter===f?"var(--accent)":"var(--border)"}`}}>
                      {{all:"Tout",critical:"Critiques",alert:"Alertes",ok:"OK"}[f]}
                    </button>
                  ))}
                  <input placeholder="🔍 Ref ou nom..." value={smSearch} onChange={e=>setSmSearch(e.target.value)}
                    style={{marginLeft:"auto",padding:"7px 12px",border:"1px solid var(--border)",borderRadius:8,fontSize:13,fontFamily:"inherit",width:220,outline:"none"}}/>
                  <span style={{fontSize:12,color:"var(--text-muted)"}}>{smFiltered.length} ligne{smFiltered.length!==1?"s":""}</span>
                </div>

                {/* Table */}
                <div style={{background:"#fff",border:"1px solid var(--border)",borderRadius:14,overflow:"hidden"}}>
                  <div style={{overflowX:"auto",maxHeight:"calc(100vh - 360px)",overflowY:"auto"}}>
                    <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
                      <thead style={{position:"sticky",top:0,zIndex:5}}>
                        <tr style={{background:"var(--bg)",borderBottom:"1px solid var(--border)"}}>
                          {["Référence","Nom produit","Stock","Conso/mois","Seuil min ✏","Jours restants","Prochaine livraison","Statut","Rupture"].map(h=>(
                            <th key={h} style={{padding:"10px 12px",textAlign:"left",fontSize:11,fontWeight:700,color:"var(--text-muted)",whiteSpace:"nowrap"}}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {smFiltered.map((row,i)=>{
                          const sc={critical:"#ef4444",alert:"#f59e0b",ok:"#22c55e",no_data:"#9ca3af",not_found:"#d1d5db"};
                          const sb2={critical:"#fff5f5",alert:"#fffdf0",ok:"#fff",no_data:"#fafafa",not_found:"#f9fafb"};
                          const rowBg=i%2===0?sb2[row.status]:"#fafafa";
                          return(
                            <tr key={row.ref} style={{background:rowBg,borderBottom:"1px solid var(--border)"}}>
                              <td style={{padding:"10px 12px",fontWeight:700,fontFamily:"monospace",fontSize:12}}>{row.ref}</td>
                              <td style={{padding:"10px 12px",maxWidth:240,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{row.name}</td>
                              <td style={{padding:"10px 12px",textAlign:"right",fontWeight:600}}>{row.status==="not_found"?"—":row.stock}</td>
                              <td style={{padding:"10px 12px",textAlign:"right",color:"var(--text-muted)"}}>{row.status==="not_found"?"—":row.conso===0?<span style={{fontSize:11}}>n/a</span>:row.conso}</td>
                              <td style={{padding:"6px 12px",textAlign:"right"}}>
                                {row.status==="not_found"?"—":smEditThr?.ref===row.ref?(
                                  <input autoFocus type="number" value={smEditThr.val}
                                    onChange={e=>setSmEditThr(t=>t?{...t,val:e.target.value}:t)}
                                    onBlur={()=>smSaveThr(row.ref,smEditThr.val,row.name)}
                                    onKeyDown={e=>{if(e.key==="Enter")smSaveThr(row.ref,smEditThr.val,row.name);if(e.key==="Escape")setSmEditThr(null);}}
                                    style={{width:64,padding:"4px 8px",border:"1px solid var(--accent)",borderRadius:6,fontSize:13,fontFamily:"inherit",textAlign:"right",outline:"none"}}/>
                                ):(
                                  <button onClick={()=>setSmEditThr({ref:row.ref,val:String(row.threshold)})}
                                    style={{background:"transparent",border:"1px dashed var(--border)",borderRadius:6,padding:"3px 10px",cursor:"pointer",fontSize:13,fontFamily:"inherit",minWidth:44}}>
                                    {row.threshold}
                                  </button>
                                )}
                              </td>
                              <td style={{padding:"10px 12px",textAlign:"right",fontWeight:700,color:sc[row.status]}}>
                                {row.status==="not_found"?"—":row.daysLeft>=999?"∞":`${row.daysLeft}j`}
                              </td>
                              <td style={{padding:"10px 12px",fontSize:12,color:row.supplierDate?"var(--danger)":"var(--text-muted)",fontWeight:row.supplierDate?700:400}}>
                                {row.supplierDate&&"⚠️ "}{row.status!=="not_found"?`${row.delivLabel} (${row.daysUntilDeliv}j)`:"-"}
                              </td>
                              <td style={{padding:"10px 12px"}}>
                                <span style={{display:"inline-block",padding:"3px 10px",borderRadius:20,background:`${sc[row.status]}18`,color:sc[row.status],fontSize:11,fontWeight:700,border:`1px solid ${sc[row.status]}44`}}>
                                  {{ok:"OK",alert:"Alerte",critical:"Critique",no_data:"Pas de données",not_found:"Introuvable"}[row.status]}
                                </span>
                              </td>
                              <td style={{padding:"8px 12px"}}>
                                {row.status!=="not_found"&&(
                                  <button onClick={()=>{setSmSupModal({ref:row.ref,name:row.name,cur:row.supplierDate||""});setSmSupInput(row.supplierDate||"");}}
                                    style={{padding:"4px 10px",border:`1px solid ${row.supplierDate?"#ef4444":"var(--border)"}`,borderRadius:6,background:row.supplierDate?"#fef2f2":"#fff",color:row.supplierDate?"#ef4444":"var(--text-muted)",cursor:"pointer",fontSize:11,fontFamily:"inherit"}}>
                                    {row.supplierDate?"📅 Modif.":"📅 Rupture"}
                                  </button>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                        {smFiltered.length===0&&<tr><td colSpan={9} style={{padding:40,textAlign:"center",color:"var(--text-muted)"}}>
                          {smLoading?"Chargement...":"Aucun résultat"}
                        </td></tr>}
                      </tbody>
                    </table>
                  </div>
                </div>
                <div style={{display:"flex",gap:20,marginTop:10,fontSize:11,color:"var(--text-muted)",flexWrap:"wrap"}}>
                  <span>🔴 <strong>Critique</strong> : rupture avant la livraison</span>
                  <span>🟡 <strong>Alerte</strong> : moins de 14j de marge ou sous le seuil</span>
                  <span>🟢 <strong>OK</strong> : stock suffisant</span>
                  <span style={{marginLeft:"auto"}}>Seuils cliquables · Livraison standard = 15 du mois suivant</span>
                </div>
              </>
            )}
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
              {/* ── KPI row ── */}
              <div style={{ display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
                <StatCard label="Jours" value={filteredDel.length} color="var(--accent)" delay={0} />
                <StatCard label="Total prépa." value={filteredDel.reduce((s, d) => s + d.count, 0)} color="var(--success)" delay={50} />
                <StatCard label="Lignes totales" value={filteredDel.reduce((s, d) => s + d.lines, 0)} color="var(--purple)" delay={100} />
                <StatCard label="Moy./jour" value={filteredDel.length > 0 ? Math.round(filteredDel.reduce((s, d) => s + d.count, 0) / filteredDel.length) : 0} color="var(--warning)" delay={150} />
              </div>

              {/* ── Highlights : best/worst day + podium ── */}
              {deliveryStatsEnriched && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 12, marginBottom: 20 }}>
                  {/* Best day */}
                  <div className="wms-card" style={{ padding: "16px 20px", borderLeft: "3px solid var(--success)" }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: ".5px", marginBottom: 6 }}>📈 Meilleure journée</div>
                    <div style={{ fontSize: 22, fontWeight: 800, color: "var(--success)", fontFamily: MONO }}>{deliveryStatsEnriched.bestDay.count}</div>
                    <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>{fmtDate(deliveryStatsEnriched.bestDay.date)} · {deliveryStatsEnriched.bestDay.lines} lignes</div>
                  </div>
                  {/* Worst day */}
                  <div className="wms-card" style={{ padding: "16px 20px", borderLeft: "3px solid var(--warning)" }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: ".5px", marginBottom: 6 }}>📉 Journée la plus calme</div>
                    <div style={{ fontSize: 22, fontWeight: 800, color: "var(--warning)", fontFamily: MONO }}>{deliveryStatsEnriched.worstDay.count}</div>
                    <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>{fmtDate(deliveryStatsEnriched.worstDay.date)} · {deliveryStatsEnriched.worstDay.lines} lignes</div>
                  </div>
                  {/* Top préparateur */}
                  {deliveryStatsEnriched.topPreparer && (
                    <div className="wms-card" style={{ padding: "16px 20px", borderLeft: "3px solid var(--accent)" }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: ".5px", marginBottom: 6 }}>🥇 Top préparateur (Picking)</div>
                      <div style={{ fontSize: 15, fontWeight: 800, color: "var(--accent)" }}>{deliveryStatsEnriched.topPreparer.name}</div>
                      <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>{deliveryStatsEnriched.topPreparer.picking} picks · {deliveryStatsEnriched.topPreparer.total} total</div>
                    </div>
                  )}
                  {/* Top emballeur */}
                  {deliveryStatsEnriched.topPacker && (
                    <div className="wms-card" style={{ padding: "16px 20px", borderLeft: "3px solid var(--purple)" }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: ".5px", marginBottom: 6 }}>📦 Top emballeur (OUT)</div>
                      <div style={{ fontSize: 15, fontWeight: 800, color: "var(--purple)" }}>{deliveryStatsEnriched.topPacker.name}</div>
                      <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>{deliveryStatsEnriched.topPacker.emballage} colis · {deliveryStatsEnriched.topPacker.total} total</div>
                    </div>
                  )}
                </div>
              )}

              {/* ── Heatmap jours de la semaine ── */}
              {deliveryStatsEnriched && (() => {
                const wdData = deliveryStatsEnriched.weekdayAvg.filter(w => w.days > 0);
                const maxAvg = Math.max(...wdData.map(w => w.avg), 1);
                return wdData.length > 1 ? (
                  <div className="wms-card" style={{ padding: "18px 20px", marginBottom: 16 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 14 }}>📅 Activité moyenne par jour de semaine</div>
                    <div style={{ display: "flex", gap: 8, alignItems: "flex-end", height: 80 }}>
                      {wdData.map((w, i) => (
                        <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--accent)", fontFamily: MONO }}>{w.avg > 0 ? w.avg : ""}</div>
                          <div style={{ width: "100%", background: `rgba(59,130,246,${0.15 + (w.avg / maxAvg) * 0.75})`, borderRadius: 4, height: `${Math.max(6, (w.avg / maxAvg) * 60)}px`, transition: "height .5s ease" }} />
                          <div style={{ fontSize: 11, fontWeight: 600, color: w.avg === maxAvg ? "var(--accent)" : "var(--text-muted)" }}>{w.label}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null;
              })()}

              {/* ── Stats préparateurs (tableau complet) ── */}
              {prepStats.length > 0 && (
                <div className="wms-card" style={{ marginBottom: 20 }}>
                  <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ fontSize: 14, fontWeight: 700 }}>👷 Classement préparateurs</div>
                    <div style={{ display: "flex", gap: 16, fontSize: 12, color: "var(--text-muted)" }}>
                      <span><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: "var(--accent)", marginRight: 5 }} />Picking</span>
                      <span><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: "var(--success)", marginRight: 5 }} />Emballage</span>
                    </div>
                  </div>
                  <div style={{ padding: "16px 20px", display: "grid", gap: 12 }}>
                    {prepStats.map((s, i) => {
                      const maxTotal = Math.max(...prepStats.map(x => x.total), 1);
                      const medals = ["🥇", "🥈", "🥉"];
                      return (
                        <div key={i} style={{ animation: `fadeIn .3s ease ${i * 40}ms both` }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                            <span style={{ fontSize: 13, fontWeight: 600 }}>{medals[i] || `${i + 1}.`} {s.name}</span>
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

              {/* ── Mini bar chart + table ── */}
              <div className="wms-card" style={{ padding: "18px 20px", marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", marginBottom: 10, textTransform: "uppercase", letterSpacing: ".5px" }}>Préparations / jour</div>
                <MiniBarChart data={[...filteredDel].reverse().map((d) => d.count)} max={Math.max(...filteredDel.map((d) => d.count), 1)} />
              </div>

              <div className="wms-card"><div className="wms-scrollbar" style={{ overflowX: "auto" }}>
                <table className="wms-table">
                  <thead><tr>
                    <FilterableHeader label="Date" colKey="date" values={deliveries.map((d) => fmtDate(d.date))} filterState={delColFilters} setFilterState={setDelColFilters} sortState={delColSort} setSortState={setDelColSort} />
                    <FilterableHeader label="Préparations" colKey="count" values={deliveries.map((d) => String(d.count))} filterState={delColFilters} setFilterState={setDelColFilters} sortState={delColSort} setSortState={setDelColSort} align="center" />
                    <FilterableHeader label="Lignes articles" colKey="lines" values={deliveries.map((d) => String(d.lines))} filterState={delColFilters} setFilterState={setDelColFilters} sortState={delColSort} setSortState={setDelColSort} align="center" />
                  </tr></thead>
                  <tbody>
                    {filteredDel.map((d, i) => {
                      const maxC = Math.max(...filteredDel.map((x) => x.count), 1);
                      const isBest = d.count === deliveryStatsEnriched?.bestDay.count;
                      return (
                        <tr key={i} style={isBest ? { background: "var(--success-soft)" } : {}}>
                          <td style={{ fontWeight: 600, fontFamily: MONO, fontSize: 12 }}>{fmtDate(d.date)}</td>
                          <td style={{ textAlign: "center" }}>
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}>
                              <div style={{ height: 6, width: `${(d.count / maxC) * 80}px`, borderRadius: 3, minWidth: 4, overflow: "hidden" }}><div className="bar-fill" style={{ background: isBest ? "var(--success)" : "var(--accent)", animationDelay: `${i * 30}ms` }} /></div>
                              <span style={{ fontWeight: 700, fontFamily: MONO, fontSize: 13 }}>{d.count}</span>
                              {isBest && <span style={{ fontSize: 11 }}>🏆</span>}
                            </div>
                          </td>
                          <td style={{ textAlign: "center", fontWeight: 600, fontFamily: MONO, fontSize: 13, color: "var(--text-secondary)" }}>{d.lines}</td>
                        </tr>
                      );
                    })}
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

        {/* ══════════ SUIVI STOCK ══════════ */}
        {tab === "stock-tracking" && (
          <div style={{ animation: "fadeIn .3s ease both" }}>
            <div style={{ marginBottom: 24 }}>
              <h2 style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-.3px", marginBottom: 4 }}>Suivi de stock produit</h2>
              <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 16 }}>Entrez une référence pour tracer l'historique complet et détecter les anomalies.</p>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                <input className="wms-input" value={moveRef} onChange={(e) => setMoveRef(e.target.value)} placeholder="Référence produit..." onKeyDown={(e) => e.key === "Enter" && loadMoves()} style={{ flex: 1, minWidth: 200 }} />
                <input className="wms-input" type="date" value={moveStart} onChange={(e) => setMoveStart(e.target.value)} style={{ width: "auto" }} />
                <span style={{ color: "var(--text-muted)" }}>→</span>
                <input className="wms-input" type="date" value={moveEnd} onChange={(e) => setMoveEnd(e.target.value)} style={{ width: "auto" }} />
                <button className="wms-btn wms-btn-primary" onClick={loadMoves} disabled={loading || !moveRef.trim()} style={{ opacity: !moveRef.trim() ? .5 : 1 }}>{loading ? <Spinner /> : I.search} Analyser</button>
              </div>
            </div>

            {moveRef.trim() && stockRunningBalance.length > 0 && (() => {
              const totalEntrees = stockRunningBalance.filter(m => m.type === "Entrée" || m.type === "Ajustement +").reduce((s, m) => s + m.qty, 0);
              const totalSorties = stockRunningBalance.filter(m => m.type === "Sortie" || m.type === "Ajustement −").reduce((s, m) => s + m.qty, 0);
              const soldeTheorique = totalEntrees - totalSorties;
              const maxBalance = Math.max(...stockRunningBalance.map(m => m.balance), 1);
              const minBalance = Math.min(...stockRunningBalance.map(m => m.balance), 0);
              const range = maxBalance - minBalance || 1;
              const chartH = 140;
              return (
                <div style={{ display: "grid", gap: 16 }}>
                  {/* KPIs */}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 12 }}>
                    <div className="wms-card" style={{ padding: "16px 20px", borderLeft: "3px solid var(--success)" }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: ".4px", marginBottom: 6 }}>Entrées totales</div>
                      <div style={{ fontSize: 26, fontWeight: 800, color: "var(--success)", fontFamily: MONO }}>+{Math.round(totalEntrees).toLocaleString("fr-FR")}</div>
                    </div>
                    <div className="wms-card" style={{ padding: "16px 20px", borderLeft: "3px solid var(--danger)" }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: ".4px", marginBottom: 6 }}>Sorties totales</div>
                      <div style={{ fontSize: 26, fontWeight: 800, color: "var(--danger)", fontFamily: MONO }}>−{Math.round(totalSorties).toLocaleString("fr-FR")}</div>
                    </div>
                    <div className="wms-card" style={{ padding: "16px 20px", borderLeft: `3px solid ${soldeTheorique >= 0 ? "var(--accent)" : "var(--danger)"}` }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: ".4px", marginBottom: 6 }}>Solde théorique</div>
                      <div style={{ fontSize: 26, fontWeight: 800, color: soldeTheorique >= 0 ? "var(--accent)" : "var(--danger)", fontFamily: MONO }}>{Math.round(soldeTheorique).toLocaleString("fr-FR")}</div>
                    </div>
                    {moveProductCurrentStock !== null && (
                      <div className="wms-card" style={{ padding: "16px 20px", borderLeft: "3px solid #6366f1" }}>
                        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: ".4px", marginBottom: 6 }}>Stock Odoo actuel</div>
                        <div style={{ fontSize: 26, fontWeight: 800, color: "#6366f1", fontFamily: MONO }}>{Math.round(moveProductCurrentStock).toLocaleString("fr-FR")}</div>
                      </div>
                    )}
                    <div className="wms-card" style={{ padding: "16px 20px", borderLeft: "3px solid var(--border)" }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: ".4px", marginBottom: 6 }}>Mouvements</div>
                      <div style={{ fontSize: 26, fontWeight: 800, fontFamily: MONO }}>{stockRunningBalance.length}</div>
                    </div>
                  </div>

                  {/* Graphique */}
                  <div className="wms-card" style={{ padding: "20px 24px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 700 }}>Évolution du stock théorique</div>
                        {moveProductName && <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>{moveProductName}</div>}
                      </div>
                      <div style={{ display: "flex", gap: 12, fontSize: 11, color: "var(--text-muted)" }}>
                        <span>⬤ <span style={{ color: "var(--accent)" }}>Solde</span></span>
                        {stockAnomalies.length > 0 && <span>⬤ <span style={{ color: "var(--danger)" }}>Anomalie</span></span>}
                      </div>
                    </div>
                    {/* Labels axe Y */}
                    <div style={{ position: "relative" }}>
                      <div style={{ position: "absolute", right: "100%", top: 0, paddingRight: 6, fontSize: 10, color: "var(--text-muted)", fontFamily: MONO }}>{Math.round(maxBalance)}</div>
                      <div style={{ position: "absolute", right: "100%", top: "50%", paddingRight: 6, fontSize: 10, color: "var(--text-muted)", fontFamily: MONO, transform: "translateY(-50%)" }}>{Math.round((maxBalance + minBalance) / 2)}</div>
                      <div style={{ position: "absolute", right: "100%", bottom: 20, paddingRight: 6, fontSize: 10, color: "var(--text-muted)", fontFamily: MONO }}>{Math.round(minBalance)}</div>
                      <svg width="100%" height={chartH + 20} style={{ overflow: "visible", display: "block" }}>
                        <line x1="0" y1={chartH - ((0 - minBalance) / range) * chartH} x2="100%" y2={chartH - ((0 - minBalance) / range) * chartH} stroke="var(--border)" strokeDasharray="4,4" strokeWidth="1" />
                        {stockRunningBalance.length > 1 && (() => {
                          const pts = stockRunningBalance.map((m, i) => {
                            const x = (i / (stockRunningBalance.length - 1)) * 100;
                            const y = chartH - ((m.balance - minBalance) / range) * chartH;
                            return `${x}%,${y}`;
                          });
                          return (
                            <>
                              <defs>
                                <linearGradient id="stGrad" x1="0" y1="0" x2="0" y2="1">
                                  <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.3" />
                                  <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.02" />
                                </linearGradient>
                              </defs>
                              <polygon points={`0%,${chartH} ${pts.join(" ")} 100%,${chartH}`} fill="url(#stGrad)" />
                              <polyline points={pts.join(" ")} fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinejoin="round" />
                              {stockRunningBalance.map((m, i) => {
                                if (!m.isInventory && m.balance >= 0) return null;
                                const x = (i / (stockRunningBalance.length - 1)) * 100;
                                const y = chartH - ((m.balance - minBalance) / range) * chartH;
                                return <circle key={i} cx={`${x}%`} cy={y} r={6} fill={m.balance < 0 ? "var(--danger)" : "var(--warning)"} stroke="white" strokeWidth="1.5" />;
                              })}
                            </>
                          );
                        })()}
                      </svg>
                      {/* Axe X labels (premier et dernier) */}
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--text-muted)", fontFamily: MONO, marginTop: 4 }}>
                        <span>{fmtDate(stockRunningBalance[0].date)}</span>
                        <span>{fmtDate(stockRunningBalance[stockRunningBalance.length - 1].date)}</span>
                      </div>
                    </div>
                  </div>

                  {/* Anomalies */}
                  {stockAnomalies.length > 0 && (
                    <div className="wms-card" style={{ padding: "18px 20px" }}>
                      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 14 }}>⚠️ Anomalies détectées — {stockAnomalies.length}</div>
                      <div style={{ display: "grid", gap: 8 }}>
                        {stockAnomalies.map((a, i) => (
                          <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "12px 16px", background: a.severity === "error" ? "var(--danger-soft)" : "rgba(245,158,11,.08)", borderLeft: `3px solid ${a.severity === "error" ? "var(--danger)" : "var(--warning)"}`, borderRadius: 8 }}>
                            <span style={{ fontSize: 16, flexShrink: 0, marginTop: 1 }}>{a.severity === "error" ? "🔴" : "🟡"}</span>
                            <div>
                              <div style={{ fontSize: 13, fontWeight: 600, color: a.severity === "error" ? "var(--danger)" : "#b45309" }}>{a.label}</div>
                              <div style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: MONO, marginTop: 2 }}>{fmtDate(a.date)}</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Tableau détail mouvements */}
                  <div className="wms-card"><div className="wms-scrollbar" style={{ overflowX: "auto" }}>
                    <table className="wms-table">
                      <thead><tr>
                        <th>Date</th><th>Type</th><th style={{ textAlign: "right" }}>Qté</th><th style={{ textAlign: "right", color: "var(--accent)" }}>Solde</th><th>De</th><th>Vers</th><th>BL</th>
                      </tr></thead>
                      <tbody>
                        {[...stockRunningBalance].reverse().map((m, i) => {
                          const typeColors: Record<string, { bg: string; c: string }> = {
                            "Entrée": { bg: "var(--success-soft)", c: "var(--success)" },
                            "Sortie": { bg: "var(--danger-soft)", c: "var(--danger)" },
                            "Ajustement +": { bg: "rgba(245,158,11,.1)", c: "var(--warning)" },
                            "Ajustement −": { bg: "rgba(245,158,11,.1)", c: "var(--warning)" },
                            "Interne": { bg: "var(--bg-surface)", c: "var(--text-muted)" },
                          };
                          const tc = typeColors[m.type] || typeColors["Interne"];
                          return (
                            <tr key={i} style={m.balance < 0 ? { background: "var(--danger-soft)" } : m.isInventory ? { background: "rgba(245,158,11,.06)" } : {}}>
                              <td style={{ fontFamily: MONO, fontSize: 12, fontWeight: 600 }}>{fmtDate(m.date)}</td>
                              <td><span className="wms-badge" style={{ background: tc.bg, color: tc.c }}>{m.type}</span></td>
                              <td style={{ textAlign: "right", fontFamily: MONO, fontWeight: 700, color: m.delta > 0 ? "var(--success)" : m.delta < 0 ? "var(--danger)" : "var(--text-muted)" }}>
                                {m.delta > 0 ? "+" : ""}{Math.round(m.delta)}
                              </td>
                              <td style={{ textAlign: "right", fontFamily: MONO, fontWeight: 800, color: m.balance < 0 ? "var(--danger)" : "var(--accent)" }}>{Math.round(m.balance)}</td>
                              <td style={{ fontSize: 12, color: "var(--text-secondary)" }}>{m.from}</td>
                              <td style={{ fontSize: 12, color: "var(--text-secondary)" }}>{m.to}</td>
                              <td style={{ fontSize: 12, color: "var(--accent)", fontFamily: MONO }}>{m.picking}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div></div>
                </div>
              );
            })()}

            {moveRef.trim() && moves.length === 0 && moveSearched && !loading && <EmptyState icon={I.search} title="Aucun mouvement trouvé" sub={`Référence "${moveRef}" introuvable dans l'historique`} />}
            {!moveRef.trim() && <EmptyState icon={<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>} title="Entrez une référence produit" sub="pour analyser ses entrées, sorties et détecter les anomalies" />}
            {loading && <div style={{ textAlign: "center", padding: 40 }}><Spinner size={24} /></div>}
          </div>
        )}

        {tab === "libre" && (
          <div style={{ animation: "fadeIn .3s ease both" }}>
            <div style={{ marginBottom: 24 }}>
              <h2 style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-.3px", marginBottom: 4 }}>Mode Libre</h2>
              <p style={{ fontSize: 13, color: "var(--text-muted)" }}>Collez n'importe quel texte contenant des références Odoo — le tableau se construit automatiquement.</p>
            </div>

            {/* Step 1: Texte brut */}
            <div className="wms-card" style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: ".4px", marginBottom: 8 }}>1 · Coller le texte</div>
              <textarea
                value={libreText}
                onChange={e => { setLibreText(e.target.value); setLibreAnalyzed(false); setLibreRefs([]); setLibreRows([]); }}
                placeholder={"Colle ici un email, une liste, n'importe quel texte contenant des refs...\n\nEx: Commande S63165 — produit 1010120, lot ABC123, BL WH/PICK/36615"}
                rows={6}
                style={{ width: "100%", padding: "10px 12px", border: "1.5px solid var(--border)", borderRadius: 8, fontSize: 13, fontFamily: "inherit", resize: "vertical", background: "var(--bg-surface)", color: "var(--text-primary)", boxSizing: "border-box" }}
              />
              <button className="wms-btn wms-btn-primary" onClick={analyzeLibreText} disabled={!libreText.trim()} style={{ marginTop: 10, opacity: !libreText.trim() ? .5 : 1 }}>
                {I.search} Analyser le texte
              </button>
            </div>

            {/* Step 2: Refs détectées */}
            {libreAnalyzed && (
              <div className="wms-card" style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: ".4px", marginBottom: 12 }}>
                  2 · Références détectées ({libreRefs.length})
                </div>
                {libreRefs.length === 0 ? (
                  <div style={{ color: "var(--text-muted)", fontSize: 13 }}>Aucune référence détectée dans ce texte.</div>
                ) : (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {libreRefs.map((r, i) => {
                      const typeColors: Record<string, { bg: string; c: string; label: string }> = {
                        product: { bg: "var(--accent-soft)", c: "var(--accent)", label: "Produit" },
                        lot: { bg: "rgba(245,158,11,.12)", c: "var(--warning)", label: "Lot" },
                        so: { bg: "var(--success-soft)", c: "var(--success)", label: "Commande" },
                        picking: { bg: "rgba(139,92,246,.1)", c: "#7c3aed", label: "BL" },
                        unknown: { bg: "var(--bg-hover)", c: "var(--text-muted)", label: "?" },
                      };
                      const tc = typeColors[r.type];
                      return (
                        <div key={i} style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 10px", borderRadius: 20, background: tc.bg, border: `1px solid ${tc.c}20` }}>
                          <span style={{ fontSize: 11, fontWeight: 600, color: tc.c }}>{tc.label}</span>
                          <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)", fontFamily: MONO }}>{r.raw}</span>
                          <button onClick={() => setLibreRefs(prev => prev.filter((_, j) => j !== i))}
                            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: 14, lineHeight: 1, padding: 0, marginLeft: 2 }}>×</button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Step 3: Colonnes */}
            {libreAnalyzed && libreRefs.length > 0 && (
              <div className="wms-card" style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: ".4px", marginBottom: 12 }}>3 · Colonnes à récupérer</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
                  {libreCols.map((col, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 8, background: "var(--accent-soft)", border: "1.5px solid var(--accent)" }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: "var(--accent)" }}>{col.label}</span>
                      <button onClick={() => setLibreCols(prev => prev.filter((_, j) => j !== i))}
                        style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: 16, lineHeight: 1, padding: 0 }}>×</button>
                    </div>
                  ))}
                  <select
                    value=""
                    onChange={e => {
                      const col = LIBRE_COLS.find(c => c.id === e.target.value);
                      if (col && !libreCols.find(c => c.id === col.id)) setLibreCols(prev => [...prev, col]);
                    }}
                    style={{ padding: "6px 12px", borderRadius: 8, border: "1.5px dashed var(--border)", background: "var(--bg-surface)", color: "var(--text-secondary)", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                    <option value="">+ Ajouter une colonne</option>
                    {LIBRE_COLS.filter(c => !libreCols.find(lc => lc.id === c.id)).map(c => (
                      <option key={c.id} value={c.id}>{c.label}</option>
                    ))}
                  </select>
                </div>
                <button className="wms-btn wms-btn-primary" onClick={generateLibreTable} disabled={libreLoading || libreCols.length === 0}
                  style={{ opacity: libreCols.length === 0 ? .5 : 1 }}>
                  {libreLoading ? <><Spinner size={14} /> Chargement...</> : "⚡ Générer le tableau"}
                </button>
              </div>
            )}

            {/* Tableau résultat */}
            {libreRows.length > 0 && (
              <div className="wms-card">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>{libreRows.length} ligne(s)</div>
                  <button className="wms-btn" onClick={exportLibreExcel} style={{ gap: 6 }}>{I.download} Exporter Excel</button>
                </div>
                <div className="wms-scrollbar" style={{ overflowX: "auto" }}>
                  <table className="wms-table">
                    <thead><tr>
                      <th>Référence</th>
                      <th>Type</th>
                      {libreCols.map(c => <th key={c.id}>{c.label}</th>)}
                    </tr></thead>
                    <tbody>
                      {libreRows.map((row, i) => (
                        <tr key={i} style={row["_error"] ? { background: "var(--danger-soft)" } : {}}>
                          <td style={{ fontFamily: MONO, fontWeight: 700, fontSize: 12 }}>{row["Référence"]}</td>
                          <td>
                            {(() => {
                              const typeColors: Record<string, { bg: string; c: string; label: string }> = {
                                product: { bg: "var(--accent-soft)", c: "var(--accent)", label: "Produit" },
                                lot: { bg: "rgba(245,158,11,.12)", c: "var(--warning)", label: "Lot" },
                                so: { bg: "var(--success-soft)", c: "var(--success)", label: "Commande" },
                                picking: { bg: "rgba(139,92,246,.1)", c: "#7c3aed", label: "BL" },
                                unknown: { bg: "var(--bg-hover)", c: "var(--text-muted)", label: "?" },
                              };
                              const tc = typeColors[row["Type"]] || typeColors["unknown"];
                              return <span className="wms-badge" style={{ background: tc.bg, color: tc.c }}>{tc.label}</span>;
                            })()}
                          </td>
                          {libreCols.map(c => (
                            <td key={c.id} style={{ fontSize: 12 }}>
                              {row["_error"] && !row[c.key]
                                ? <span style={{ color: "var(--danger)", fontSize: 11 }}>{row["_error"]}</span>
                                : row[c.key] ?? <span style={{ color: "var(--text-muted)" }}>—</span>}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
