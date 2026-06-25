"use client";

import { useState, useEffect, useCallback, useMemo, useRef, Fragment } from "react";
import * as odoo from "@/lib/odoo";
import * as supa from "@/lib/supabase";
import type { WmsPendingOrder } from "@/lib/supabase";

// Noms des départements français (métropole + DOM) pour le ranking transport
const FR_DEPTS: Record<string, string> = {
  "01": "Ain", "02": "Aisne", "03": "Allier", "04": "Alpes-de-Hte-Provence", "05": "Hautes-Alpes",
  "06": "Alpes-Maritimes", "07": "Ardèche", "08": "Ardennes", "09": "Ariège", "10": "Aube",
  "11": "Aude", "12": "Aveyron", "13": "Bouches-du-Rhône", "14": "Calvados", "15": "Cantal",
  "16": "Charente", "17": "Charente-Maritime", "18": "Cher", "19": "Corrèze", "2A": "Corse-du-Sud",
  "2B": "Haute-Corse", "21": "Côte-d'Or", "22": "Côtes-d'Armor", "23": "Creuse", "24": "Dordogne",
  "25": "Doubs", "26": "Drôme", "27": "Eure", "28": "Eure-et-Loir", "29": "Finistère",
  "30": "Gard", "31": "Haute-Garonne", "32": "Gers", "33": "Gironde", "34": "Hérault",
  "35": "Ille-et-Vilaine", "36": "Indre", "37": "Indre-et-Loire", "38": "Isère", "39": "Jura",
  "40": "Landes", "41": "Loir-et-Cher", "42": "Loire", "43": "Haute-Loire", "44": "Loire-Atlantique",
  "45": "Loiret", "46": "Lot", "47": "Lot-et-Garonne", "48": "Lozère", "49": "Maine-et-Loire",
  "50": "Manche", "51": "Marne", "52": "Haute-Marne", "53": "Mayenne", "54": "Meurthe-et-Moselle",
  "55": "Meuse", "56": "Morbihan", "57": "Moselle", "58": "Nièvre", "59": "Nord",
  "60": "Oise", "61": "Orne", "62": "Pas-de-Calais", "63": "Puy-de-Dôme", "64": "Pyrénées-Atlantiques",
  "65": "Hautes-Pyrénées", "66": "Pyrénées-Orientales", "67": "Bas-Rhin", "68": "Haut-Rhin", "69": "Rhône",
  "70": "Haute-Saône", "71": "Saône-et-Loire", "72": "Sarthe", "73": "Savoie", "74": "Haute-Savoie",
  "75": "Paris", "76": "Seine-Maritime", "77": "Seine-et-Marne", "78": "Yvelines", "79": "Deux-Sèvres",
  "80": "Somme", "81": "Tarn", "82": "Tarn-et-Garonne", "83": "Var", "84": "Vaucluse",
  "85": "Vendée", "86": "Vienne", "87": "Haute-Vienne", "88": "Vosges", "89": "Yonne",
  "90": "Territoire de Belfort", "91": "Essonne", "92": "Hauts-de-Seine", "93": "Seine-St-Denis",
  "94": "Val-de-Marne", "95": "Val-d'Oise", "971": "Guadeloupe", "972": "Martinique",
  "973": "Guyane", "974": "La Réunion", "976": "Mayotte",
};

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
  // Icônes pour Suivi Stock (remplacent emojis)
  calendar: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>,
  package: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16.5 9.4l-9-5.19"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>,
  inbox: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>,
  trash: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1.5 14a2 2 0 0 1-2 1.84H8.5A2 2 0 0 1 6.5 20L5 6"/><path d="M10 11v6M14 11v6"/></svg>,
  pencil: <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>,
  ban: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>,
  alertTri: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>,
  rotate: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>,
  clock: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>,
  close: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>,
};

const TABS = [
  { key: "stock-monitor", label: "Suivi Stock", icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg> },
  { key: "deliveries", label: "Livraisons & Prépa.", icon: I.truck },
  { key: "moves", label: "Historique", icon: I.history },
  { key: "stock-tracking", label: "Suivi stock", icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg> },
  { key: "catalogue", label: "Catalogue", icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg> },
  { key: "libre", label: "Mode Libre", icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg> },
  { key: "dlv", label: "Suivi DLV", icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><circle cx="12" cy="16" r="2" fill="currentColor"/></svg> },
  { key: "transporteurs", label: "Analyse transporteurs", icon: I.truck },
  { key: "bmv", label: "Analyse BMV", icon: I.truck },
  { key: "reception", label: "Réception", icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg> },
] as const;

// ─── CATALOGUE — définition des colonnes disponibles ────────────────────────
const CAT_COL_DEFS = [
  // Identité
  { key: "default_code",      label: "Réf. interne",        group: "Identité",          w: 120 },
  { key: "barcode",           label: "EAN / Code-barres",   group: "Identité",          w: 140 },
  { key: "sup_ref",           label: "Réf. fournisseur",    group: "Identité",          w: 140 },
  { key: "sup_name",          label: "Fournisseur",         group: "Identité",          w: 160 },
  { key: "sup_product_name",  label: "Nom art. fournisseur",group: "Identité",          w: 170 },
  { key: "sup_code",          label: "Code abrégé fourn.",  group: "Identité",          w: 130 },
  // Caractéristiques
  { key: "categ",             label: "Famille / Catégorie", group: "Caractéristiques",  w: 150 },
  { key: "weight",            label: "Poids (kg)",          group: "Caractéristiques",  w: 90  },
  { key: "volume",            label: "Volume (L)",          group: "Caractéristiques",  w: 90  },
  { key: "length",            label: "Longueur (cm)",       group: "Caractéristiques",  w: 100 },
  { key: "width",             label: "Largeur (cm)",        group: "Caractéristiques",  w: 90  },
  { key: "height",            label: "Hauteur (cm)",        group: "Caractéristiques",  w: 90  },
  { key: "uom",               label: "Unité de mesure",     group: "Caractéristiques",  w: 100 },
  { key: "packaging_qty",     label: "Colisage",            group: "Caractéristiques",  w: 80  },
  { key: "tracking",          label: "Suivi (lot/série)",   group: "Caractéristiques",  w: 110 },
  // Stock
  { key: "qty_available",     label: "Stock disponible",    group: "Stock",             w: 110 },
  { key: "qty_virtual",       label: "Stock prévisionnel",  group: "Stock",             w: 120 },
  { key: "locations",         label: "Emplacements",        group: "Stock",             w: 220 },
  { key: "lots",              label: "Lots",                group: "Stock",             w: 160 },
  { key: "dluo",              label: "DLUO / Expiration",   group: "Stock",             w: 130 },
  // Achat
  { key: "standard_price",    label: "Prix achat (€)",      group: "Achat",             w: 110 },
  { key: "sup_price",         label: "Prix fournisseur (€)","group": "Achat",           w: 110 },
  { key: "sup_delay",         label: "Délai fourn. (j)",    group: "Achat",             w: 110 },
  { key: "sup_min_qty",       label: "Qté min commande",    group: "Achat",             w: 120 },
  { key: "sup_currency",      label: "Devise fourn.",       group: "Achat",             w: 90  },
  // Vente
  { key: "list_price",        label: "Prix vente HT (€)",   group: "Vente",             w: 120 },
] as const;
type CatColKey = typeof CAT_COL_DEFS[number]["key"];
const CAT_DEFAULT_COLS: CatColKey[] = ["default_code","sup_ref","sup_name","categ","weight","qty_available"];

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

  // ─── Réception fournisseur ───────────────────────────────────────────────
  interface RecepRow { odooRef: string; supplierRef: string; productName: string; qty: number; lot: string; pickingName: string; date: string; }
  const [recVendors, setRecVendors] = useState<{ id: number; name: string }[]>([]);
  const [recVendorId, setRecVendorId] = useState<number | null>(null);
  const [recPickings, setRecPickings] = useState<{ id: number; name: string; date: string }[]>([]);
  const [recPickingId, setRecPickingId] = useState<number | null>(null);
  const [recRows, setRecRows] = useState<RecepRow[]>([]);
  const [recLoading, setRecLoading] = useState(false);
  const [recPickingsLoading, setRecPickingsLoading] = useState(false);
  const [recVendorsLoading, setRecVendorsLoading] = useState(false);

  // ─── Analyse transporteurs ───────────────────────────────────────────────
  interface CarrierLigne { ref: string; date: string; zone: string; tracking: string; weight: number; transport: number; options?: number; total: number; coutReel?: number; mois?: string }
  interface CarrierCommande { ref: string; date: string; zone: string; colis: number; weight: number; transport: number; options?: number; total: number; coutReel?: number; mois?: string }
  interface CarrierFacture { num: string; mois_label: string; mois_key: string; periode_debut: string; periode_fin: string; stats: CarrierStats }
  interface CarrierStats { nb_lignes: number; nb_commandes: number; total_transport: number; total_facture: number; total_options?: number; surcharge_carburant?: number; surcharge_taux?: number; total_general_ht?: number }
  // coutReel = transport + options + quote-part de surcharge carburant (coût réel tout compris)
  interface CarrierCrossed extends CarrierCommande { client: string; partnerRef?: string; montantHT: number; montantTTC: number; coutReel: number; pct: number | null; matched: boolean; alert: boolean; cp?: string; ville?: string; dept?: string; groupe?: string[]; groupeDetail?: { ref: string; montantHT: number; montantTTC: number }[] }
  const [carLoading, setCarLoading] = useState(false);
  const [carPdfName, setCarPdfName] = useState("");
  const [carLignes, setCarLignes] = useState<CarrierLigne[]>([]);
  const [carCommandes, setCarCommandes] = useState<CarrierCommande[]>([]);
  const [carStats, setCarStats] = useState<CarrierStats | null>(null);
  const [carFactures, setCarFactures] = useState<CarrierFacture[]>([]);
  const [carLignesOmises, setCarLignesOmises] = useState(false);
  const [carOdoo, setCarOdoo] = useState<odoo.CarrierSaleOrder[]>([]);
  const [carOdooLoaded, setCarOdooLoaded] = useState(false);
  const [carSearching, setCarSearching] = useState(false);
  const [carSearch, setCarSearch] = useState("");
  const [carView, setCarView] = useState<"commandes" | "lignes" | "croise">("commandes");
  const [carStart, setCarStart] = useState("");
  const [carEnd, setCarEnd] = useState("");
  const [carError, setCarError] = useState("");
  const [carDrag, setCarDrag] = useState(false);
  const [carExpanded, setCarExpanded] = useState<Set<string>>(new Set());

  // ── BMV (autre transporteur — facture annexe) ──────────────────────────────
  interface BmvExped { recep: string; date: string; date_iso: string; ref: string; dest: string; dpt: string; ville: string; transport: number; options: number; colis: number; coutReel: number; mois?: string; }
  interface BmvStats { num: string; date_facture: string; nb_expeditions: number; total_transport: number; surcharge_carburant: number; surcharge_taux: number; total_general_ht: number; avec_ref: number; sans_ref: number; }
  interface BmvFacture { num: string; mois: string; nb_expeditions: number; total_transport: number; surcharge_carburant: number; total_general_ht: number; }
  interface BmvCrossed extends BmvExped { client: string; partnerRef?: string; montantHT: number; montantTTC: number; pct: number | null; matched: boolean; approx: boolean; alert: boolean; matchedRef: string; groupe?: string[]; groupeDetail?: { ref: string; montantHT: number; montantTTC: number }[]; }
  const [bmvLoading, setBmvLoading] = useState(false);
  const [bmvPdfName, setBmvPdfName] = useState("");
  const [bmvExped, setBmvExped] = useState<BmvExped[]>([]);
  const [bmvStats, setBmvStats] = useState<BmvStats | null>(null);
  const [bmvFactures, setBmvFactures] = useState<BmvFacture[]>([]);
  const [bmvOdoo, setBmvOdoo] = useState<Map<string, odoo.CarrierSaleOrder>>(new Map());
  const [bmvNameMatch, setBmvNameMatch] = useState<Map<string, odoo.BmvNameMatch>>(new Map());
  const [bmvOdooLoaded, setBmvOdooLoaded] = useState(false);
  const [bmvSearching, setBmvSearching] = useState(false);
  const [bmvSearch, setBmvSearch] = useState("");
  const [bmvError, setBmvError] = useState("");
  const [bmvDrag, setBmvDrag] = useState(false);
  const bmvPdfInput = useRef<HTMLInputElement>(null);

  const MOIS_FR = ["", "Janvier", "Février", "Mars", "Avril", "Mai", "Juin", "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"];
  const bmvMoisLabel = (dateFacture: string) => {
    const m = (dateFacture || "").match(/^(\d{4})-(\d{2})/);
    return m ? `${MOIS_FR[parseInt(m[2], 10)]} ${m[1]}` : (dateFacture || "Facture");
  };

  // Gère 1..N PDF (un par mois) → fusionne les expéditions, vue annuelle.
  async function bmvHandlePdfs(files: File[]) {
    if (!files.length) return;
    setBmvLoading(true); setBmvError("");
    setBmvPdfName(files.length === 1 ? files[0].name : `${files.length} factures`);
    setBmvOdoo(new Map()); setBmvNameMatch(new Map()); setBmvOdooLoaded(false);
    try {
      const allExps: BmvExped[] = [];
      const factures: BmvFacture[] = [];
      let totTransport = 0, totCarb = 0, totGeneral = 0, totAvec = 0, totSans = 0;
      for (const file of files) {
        const buf = await file.arrayBuffer();
        const res = await fetch("/api/bmv-extract", { method: "POST", headers: { "Content-Type": "application/pdf" }, body: buf });
        const ct = res.headers.get("content-type") || "";
        if (!ct.includes("application/json")) {
          const txt = (await res.text()).slice(0, 200);
          setBmvError(res.status === 404 ? "L'extraction PDF n'est disponible qu'en ligne (Vercel)." : `Réponse inattendue (HTTP ${res.status}) : ${txt}`);
          return;
        }
        const data = await res.json();
        if (data.error) { setBmvError(`Erreur extraction (${file.name}) : ` + data.error); return; }
        const st: BmvStats = data.stats;
        const mois = bmvMoisLabel(st?.date_facture || "");
        const exps: BmvExped[] = (data.expeditions || []).map((e: BmvExped) => ({ ...e, mois }));
        allExps.push(...exps);
        factures.push({ num: st?.num || "", mois, nb_expeditions: st?.nb_expeditions || exps.length, total_transport: st?.total_transport || 0, surcharge_carburant: st?.surcharge_carburant || 0, total_general_ht: st?.total_general_ht || 0 });
        totTransport += st?.total_transport || 0; totCarb += st?.surcharge_carburant || 0;
        totGeneral += st?.total_general_ht || 0; totAvec += st?.avec_ref || 0; totSans += st?.sans_ref || 0;
      }
      // tri des factures par mois chronologique
      factures.sort((a, b) => a.mois.localeCompare(b.mois));
      const r2 = (n: number) => Math.round(n * 100) / 100;
      setBmvExped(allExps);
      setBmvFactures(factures);
      setBmvStats({
        num: factures.length === 1 ? factures[0].num : `${factures.length} factures`,
        date_facture: factures.length === 1 ? (factures[0].mois) : `${factures[0]?.mois} → ${factures[factures.length - 1]?.mois}`,
        nb_expeditions: allExps.length, total_transport: r2(totTransport), surcharge_carburant: r2(totCarb),
        surcharge_taux: 0, total_general_ht: r2(totGeneral), avec_ref: totAvec, sans_ref: totSans,
      });
      if (session && allExps.length) {
        setBmvSearching(true);
        try { await bmvCross(allExps); } finally { setBmvSearching(false); }
      }
    } catch (e) { setBmvError("Erreur réseau : " + String(e)); } finally { setBmvLoading(false); }
  }
  // compat : un seul fichier
  const bmvHandlePdf = (file: File) => bmvHandlePdfs([file]);

  async function bmvCross(exps: BmvExped[]) {
    if (!session) return;
    // 1) match par réf Odoo (S…) pour les expéds qui en ont une
    const withRef = exps.filter(e => e.ref);
    const refMap = new Map<string, odoo.CarrierSaleOrder>();
    if (withRef.length) {
      const rows = await odoo.fetchCarrierSaleOrders(session, withRef.map(e => e.ref));
      for (const r of rows) refMap.set(r.ref, r);
    }
    setBmvOdoo(refMap);
    // 2) match par nom + date pour les expéds SANS réf
    const without = exps.filter(e => !e.ref).map(e => ({ recep: e.recep, dest: e.dest, date_iso: e.date_iso }));
    const nameMap = new Map<string, odoo.BmvNameMatch>();
    if (without.length) {
      // réfs déjà attribuées par le match direct (S…) → à ne pas réutiliser
      const usedRefs = Array.from(refMap.keys());
      // fenêtre asymétrique : commande jusqu'à 21j avant l'expédition, 3j après
      const matches = await odoo.fetchBmvByNameDate(session, without, 21, 3, usedRefs);
      for (const m of matches) nameMap.set(m.recep, m);
    }
    setBmvNameMatch(nameMap);
    setBmvOdooLoaded(true);
  }

  const bmvCroise: BmvCrossed[] = useMemo(() => {
    return bmvExped.map(e => {
      let client = "", partnerRef: string | undefined, montantHT = 0, montantTTC = 0, matched = false, approx = false, matchedRef = e.ref;
      let groupe: string[] | undefined, groupeDetail: { ref: string; montantHT: number; montantTTC: number }[] | undefined;
      if (e.ref && bmvOdoo.has(e.ref)) {
        const o = bmvOdoo.get(e.ref)!;
        // montantHT/TTC sont DÉJÀ cumulés avec les commandes jointes par fetchCarrierSaleOrders
        client = o.client; partnerRef = o.partnerRef; montantHT = o.montantHT; montantTTC = o.montantTTC; matched = true;
        groupe = o.groupe; groupeDetail = o.groupeDetail;
      } else if (!e.ref && bmvNameMatch.has(e.recep)) {
        const m = bmvNameMatch.get(e.recep)!;
        client = m.client; partnerRef = m.partnerRef; montantHT = m.montantHT; montantTTC = m.montantTTC; matched = true; approx = true;
        matchedRef = m.ref; // réf Odoo (S…) retrouvée par nom+date
      }
      const alert = e.coutReel > 0 && montantHT <= 0;
      return { ...e, client, partnerRef, montantHT, montantTTC, matched, approx, alert, matchedRef, groupe, groupeDetail, pct: montantHT > 0 ? e.coutReel / montantHT : null };
    });
  }, [bmvExped, bmvOdoo, bmvNameMatch]);

  const bmvFiltered = useMemo(() => {
    const q = bmvSearch.trim().toLowerCase();
    if (!q) return bmvCroise;
    return bmvCroise.filter(r => r.ref.toLowerCase().includes(q) || r.dest.toLowerCase().includes(q) || (r.client || "").toLowerCase().includes(q));
  }, [bmvCroise, bmvSearch]);

  function bmvReset() {
    setBmvExped([]); setBmvStats(null); setBmvFactures([]); setBmvOdoo(new Map()); setBmvNameMatch(new Map());
    setBmvOdooLoaded(false); setBmvPdfName(""); setBmvError(""); setBmvSearch("");
  }

  async function bmvExportXlsx() {
    const ExcelJS = (await import("exceljs")).default;
    const round2 = (n: number) => Math.round(n * 100) / 100;
    const wb = new ExcelJS.Workbook();
    wb.creator = "WMS Scanner"; wb.created = new Date();

    const C = {
      dark: "FF1E293B", accent: "FF2563EB", white: "FFFFFFFF", zebra: "FFF1F5F9",
      green: "FFDCFCE7", greenT: "FF166534", amber: "FFFEF3C7", amberT: "FF92400E",
      red: "FFFEE2E2", redT: "FFB91C1C", kpiBg: "FFEFF6FF", border: "FFE2E8F0",
    };
    const thin = { style: "thin" as const, color: { argb: C.border } };
    const allBorders = { top: thin, left: thin, bottom: thin, right: thin };
    const eurFmt = '#,##0.00 €';
    const pctNumFmt = '0.0 "%"';
    const styleHeader = (ws: any) => {
      const h = ws.getRow(1); h.height = 22;
      h.eachCell((cell: any) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.dark } };
        cell.font = { bold: true, color: { argb: C.white }, size: 11 };
        cell.alignment = { vertical: "middle", horizontal: "center" };
        cell.border = allBorders;
      });
      ws.views = [{ state: "frozen", ySplit: 1 }];
    };
    const zebra = (ws: any) => {
      for (let r = 2; r <= ws.rowCount; r++) {
        const row = ws.getRow(r);
        if (r % 2 === 0) row.eachCell((c: any) => { if (!c.fill || c.fill.type !== "pattern") c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.zebra } }; });
        row.eachCell((c: any) => { c.border = allBorders; });
      }
    };

    const matched = bmvCroise.filter(c => c.matched && c.montantHT > 0);
    const anomalies = bmvCroise.filter(c => c.alert);
    const totalHT = matched.reduce((s, c) => s + c.montantHT, 0);
    const coutReelMatched = matched.reduce((s, c) => s + c.coutReel, 0);
    const coutAnomalies = anomalies.reduce((s, c) => s + c.coutReel, 0);
    const pctMoyen = totalHT > 0 ? coutReelMatched / totalHT : 0;
    const nbApprox = bmvCroise.filter(c => c.matched && c.approx).length;

    // ── Synthèse ──
    const wsS = wb.addWorksheet("Synthèse");
    wsS.columns = [{ width: 40 }, { width: 26 }];
    wsS.mergeCells("A1:B1");
    const title = wsS.getCell("A1");
    title.value = "ANALYSE BMV"; title.font = { bold: true, size: 16, color: { argb: C.white } };
    title.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.accent } };
    title.alignment = { vertical: "middle", horizontal: "center" };
    wsS.getRow(1).height = 30;
    wsS.mergeCells("A2:B2");
    const sub = wsS.getCell("A2");
    sub.value = `Facture ${bmvStats?.num || "—"} · ${bmvStats?.date_facture || "—"}`;
    sub.font = { italic: true, color: { argb: "FF64748B" } }; sub.alignment = { horizontal: "center" };
    const kpi = (label: string, value: string | number, danger = false, good = false) => {
      const row = wsS.addRow([label, value]);
      const lc = row.getCell(1), vc = row.getCell(2);
      lc.font = { bold: true, color: { argb: "FF334155" } };
      lc.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.kpiBg } };
      vc.font = { bold: true, size: 12, color: { argb: danger ? C.redT : good ? C.greenT : "FF0F172A" } };
      if (danger) vc.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.red } };
      vc.alignment = { horizontal: "right" };
      lc.border = allBorders; vc.border = allBorders;
      return row;
    };
    wsS.addRow([]);
    kpi("Nombre d'expéditions", bmvStats?.nb_expeditions ?? 0);
    kpi("Transport pur", round2(bmvStats?.total_transport ?? 0)).getCell(2).numFmt = eurFmt;
    if (bmvStats?.surcharge_carburant) kpi(`Surcharge carburant (${bmvStats?.surcharge_taux}%)`, round2(bmvStats.surcharge_carburant)).getCell(2).numFmt = eurFmt;
    kpi("TOTAL FACTURÉ HT", round2(bmvStats?.total_general_ht ?? 0), false, true).getCell(2).numFmt = eurFmt;
    wsS.addRow([]);
    const sep = wsS.addRow(["── CROISEMENT ODOO ──", ""]); sep.getCell(1).font = { bold: true, color: { argb: C.accent } };
    const found = bmvCroise.filter(c => c.matched).length;
    kpi("Expéditions trouvées dans Odoo", `${found} / ${bmvCroise.length}`, false, found === bmvCroise.length);
    kpi("dont par réf (S…)", found - nbApprox);
    kpi("dont par nom + date (approx.)", nbApprox);
    kpi("Expéditions absentes d'Odoo", bmvCroise.length - found, bmvCroise.length - found > 0);
    kpi("Expéditions SANS montant (à perte)", anomalies.length, anomalies.length > 0);
    kpi("Transport payé à perte", round2(coutAnomalies), coutAnomalies > 0).getCell(2).numFmt = eurFmt;
    kpi("Montant commandes HT total", round2(totalHT), false, true).getCell(2).numFmt = eurFmt;
    kpi("% transport / CA moyen (pondéré)", round2(pctMoyen * 100)).getCell(2).numFmt = pctNumFmt;

    // ── Croisé Odoo ──
    const ws = wb.addWorksheet("Croisé Odoo");
    ws.columns = [
      { header: "Réf Odoo", key: "ref", width: 12 }, { header: "N° Récep", key: "recep", width: 11 },
      { header: "Client", key: "client", width: 30 }, { header: "Date", key: "date", width: 9 },
      { header: "Dpt", key: "dpt", width: 6 }, { header: "Ville", key: "ville", width: 20 },
      { header: "Colis", key: "colis", width: 7 }, { header: "Transport €", key: "transport", width: 13 },
      { header: "Coût réel €", key: "coutreel", width: 13 }, { header: "Montant HT €", key: "ht", width: 14 },
      { header: "Montant TTC €", key: "ttc", width: 14 }, { header: "% Transp.", key: "pct", width: 11 },
      { header: "Match", key: "statut", width: 16 },
    ];
    for (const c of bmvCroise) {
      ws.addRow({
        ref: c.matchedRef || "", recep: c.recep, client: c.client || "(absent Odoo)", date: c.date,
        dpt: c.dpt, ville: c.ville, colis: c.colis, transport: round2(c.transport), coutreel: round2(c.coutReel),
        ht: c.montantHT || null, ttc: c.montantTTC || null, pct: c.pct !== null ? round2(c.pct * 100) : null,
        statut: !c.matched ? "ABSENT" : c.alert ? "À PERTE (0 €)" : c.approx ? "≈ nom+date" : c.pct! > 0.15 ? "⚠ ÉLEVÉ" : "OK réf",
      });
    }
    styleHeader(ws); zebra(ws);
    for (const k of ["transport", "coutreel", "ht", "ttc"]) ws.getColumn(k).numFmt = eurFmt;
    ws.getColumn("pct").numFmt = pctNumFmt;
    for (let r = 2; r <= ws.rowCount; r++) {
      const c = bmvCroise[r - 2];
      const pctCell = ws.getCell(r, 12); const statCell = ws.getCell(r, 13);
      let bg = "", fg = "";
      if (!c.matched || c.alert) { bg = C.red; fg = C.redT; }
      else if (c.approx) { bg = C.amber; fg = C.amberT; }
      else if (c.pct! > 0.15) { bg = C.red; fg = C.redT; }
      else if (c.pct! > 0.08) { bg = C.amber; fg = C.amberT; }
      else { bg = C.green; fg = C.greenT; }
      for (const cell of [pctCell, statCell]) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bg } };
        cell.font = { bold: true, color: { argb: fg } };
        cell.alignment = { horizontal: "center" }; cell.border = allBorders;
      }
    }

    // ── À perte ──
    if (anomalies.length) {
      const wa = wb.addWorksheet("⚠ À perte");
      wa.columns = [
        { header: "Réf / Récep", key: "ref", width: 13 }, { header: "Destinataire", key: "dest", width: 30 },
        { header: "Date", key: "date", width: 9 }, { header: "Colis", key: "colis", width: 7 },
        { header: "Transport payé €", key: "transport", width: 16 }, { header: "Statut", key: "statut", width: 18 },
      ];
      for (const c of anomalies) wa.addRow({ ref: c.matchedRef || c.recep, dest: c.dest, date: c.date, colis: c.colis, transport: round2(c.coutReel), statut: c.matched ? "Trouvée, montant 0" : "Absente d'Odoo" });
      styleHeader(wa); zebra(wa);
      wa.getColumn("transport").numFmt = eurFmt;
      for (let r = 2; r <= wa.rowCount; r++) wa.getRow(r).eachCell((c: any) => { c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.red } }; c.font = { color: { argb: C.redT } }; c.border = allBorders; });
    }

    // ── Détail jointes (livraisons groupées) ──
    const grouped = bmvCroise.filter(c => c.groupeDetail && c.groupeDetail.length > 1);
    if (grouped.length) {
      const wg = wb.addWorksheet("Détail jointes");
      wg.columns = [
        { header: "Réf facturée", key: "parent", width: 13 }, { header: "Client", key: "client", width: 30 },
        { header: "Coût réel €", key: "cout", width: 13 }, { header: "Cde du groupe", key: "ref", width: 14 },
        { header: "Type", key: "type", width: 12 }, { header: "Montant HT €", key: "ht", width: 14 },
        { header: "Montant TTC €", key: "ttc", width: 14 },
      ];
      for (const c of grouped) {
        c.groupeDetail!.forEach((d, idx) => {
          wg.addRow({
            parent: idx === 0 ? c.matchedRef : "", client: idx === 0 ? c.client : "", cout: idx === 0 ? round2(c.coutReel) : null,
            ref: d.ref, type: d.ref === c.matchedRef ? "facturée" : "jointe", ht: d.montantHT, ttc: d.montantTTC,
          });
        });
      }
      styleHeader(wg); zebra(wg);
      wg.getColumn("cout").numFmt = eurFmt; wg.getColumn("ht").numFmt = eurFmt; wg.getColumn("ttc").numFmt = eurFmt;
      for (let r = 2; r <= wg.rowCount; r++) {
        const typeCell = wg.getCell(r, 5);
        if (typeCell.value === "facturée") wg.getRow(r).eachCell((cc: any) => { cc.font = { bold: true, color: { argb: "FF5B21B6" } }; });
        else { const rc = wg.getCell(r, 4); rc.font = { color: { argb: "FF7C3AED" } }; }
      }
    }

    // ── Par client ──
    const byClient = new Map<string, { client: string; partnerRef: string; cdes: number; colis: number; cout: number; ht: number }>();
    for (const c of bmvCroise) {
      const key = c.client || "(absent Odoo)";
      if (!byClient.has(key)) byClient.set(key, { client: key, partnerRef: c.partnerRef || "", cdes: 0, colis: 0, cout: 0, ht: 0 });
      const g = byClient.get(key)!;
      if (!g.partnerRef && c.partnerRef) g.partnerRef = c.partnerRef;
      g.cdes += 1; g.colis += c.colis; g.cout = round2(g.cout + c.coutReel); g.ht = round2(g.ht + c.montantHT);
    }
    const wc = wb.addWorksheet("Par client");
    wc.columns = [
      { header: "N° Client", key: "partnerRef", width: 14 }, { header: "Client", key: "client", width: 32 },
      { header: "Expéd.", key: "cdes", width: 8 }, { header: "Colis", key: "colis", width: 8 },
      { header: "Coût réel €", key: "cout", width: 14 }, { header: "Montant HT €", key: "ht", width: 15 },
      { header: "% Transp.", key: "pct", width: 11 },
    ];
    for (const g of Array.from(byClient.values()).sort((a, b) => b.cout - a.cout)) {
      wc.addRow({ partnerRef: g.partnerRef || null, client: g.client, cdes: g.cdes, colis: g.colis, cout: g.cout, ht: g.ht || null, pct: g.ht > 0 ? round2((g.cout / g.ht) * 100) : null });
    }
    styleHeader(wc); zebra(wc);
    wc.getColumn("cout").numFmt = eurFmt; wc.getColumn("ht").numFmt = eurFmt; wc.getColumn("pct").numFmt = pctNumFmt;

    // ── Top départements ──
    const byDept = new Map<string, { dept: string; cdes: number; colis: number; cout: number; ht: number }>();
    for (const c of bmvCroise) {
      const key = c.dpt || "??";
      if (!byDept.has(key)) byDept.set(key, { dept: key, cdes: 0, colis: 0, cout: 0, ht: 0 });
      const g = byDept.get(key)!; g.cdes += 1; g.colis += c.colis; g.cout = round2(g.cout + c.coutReel); g.ht = round2(g.ht + c.montantHT);
    }
    const totCout = Array.from(byDept.values()).reduce((s, g) => s + g.cout, 0) || 1;
    const wd = wb.addWorksheet("Top départements");
    wd.columns = [
      { header: "Dépt", key: "dept", width: 7 }, { header: "Expéd.", key: "cdes", width: 9 },
      { header: "Colis", key: "colis", width: 8 }, { header: "Coût réel €", key: "cout", width: 14 },
      { header: "% du coût", key: "part", width: 11 }, { header: "% transp/CA", key: "pct", width: 12 },
    ];
    for (const g of Array.from(byDept.values()).sort((a, b) => b.cout - a.cout)) {
      wd.addRow({ dept: g.dept, cdes: g.cdes, colis: g.colis, cout: g.cout, part: round2((g.cout / totCout) * 100), pct: g.ht > 0 ? round2((g.cout / g.ht) * 100) : null });
    }
    styleHeader(wd); zebra(wd);
    wd.getColumn("cout").numFmt = eurFmt; wd.getColumn("part").numFmt = pctNumFmt; wd.getColumn("pct").numFmt = pctNumFmt;
    if (wd.rowCount > 1) wd.addConditionalFormatting({ ref: `D2:D${wd.rowCount}`, rules: [{ type: "dataBar", cfvo: [{ type: "num", value: 0 }, { type: "max" }], color: { argb: "FF2563EB" } } as any] });

    // ── Feuilles PAR MOIS (plusieurs factures) ──
    if (bmvFactures.length > 1) {
      // Nom de feuille UNIQUE (ExcelJS refuse les doublons → ex. 2 factures "Juillet 2025").
      const usedSheetNames = new Set<string>();
      const uniqueSheetName = (base: string) => {
        let name = base.replace(/[\\/?*[\]:]/g, "").slice(0, 31) || "Feuille";
        if (!usedSheetNames.has(name)) { usedSheetNames.add(name); return name; }
        let i = 2;
        while (usedSheetNames.has(`${name.slice(0, 27)} (${i})`)) i++;
        const out = `${name.slice(0, 27)} (${i})`;
        usedSheetNames.add(out); return out;
      };
      // Synthèse annuelle en tête de la Synthèse
      wsS.addRow([]);
      const sepA = wsS.addRow(["── PAR MOIS ──", ""]); sepA.getCell(1).font = { bold: true, color: { argb: C.accent } };
      for (const f of bmvFactures) kpi(`${f.mois} (${f.num || "—"})`, round2(f.total_general_ht)).getCell(2).numFmt = eurFmt;
      // une feuille détaillée par mois
      for (const f of bmvFactures) {
        const rowsM = bmvCroise.filter(c => c.mois === f.mois);
        if (!rowsM.length) continue;
        // nom = mois + n° facture pour distinguer 2 factures du même mois
        const wm = wb.addWorksheet(uniqueSheetName(`${f.mois}${f.num ? " " + f.num : ""}`), { properties: { tabColor: { argb: "FF7C3AED" } } });
        wm.columns = [
          { header: "Réf Odoo", key: "ref", width: 12 }, { header: "Client", key: "client", width: 28 },
          { header: "Date", key: "date", width: 9 }, { header: "Colis", key: "colis", width: 7 },
          { header: "Coût réel €", key: "cout", width: 13 }, { header: "Montant HT €", key: "ht", width: 14 },
          { header: "% Transp.", key: "pct", width: 11 }, { header: "Match", key: "statut", width: 14 },
        ];
        for (const c of rowsM) wm.addRow({
          ref: c.matchedRef || c.recep, client: c.client || "(absent Odoo)", date: c.date, colis: c.colis,
          cout: round2(c.coutReel), ht: c.montantHT || null, pct: c.pct !== null ? round2(c.pct * 100) : null,
          statut: !c.matched ? "ABSENT" : c.alert ? "À PERTE" : c.approx ? "≈ nom+date" : "OK réf",
        });
        styleHeader(wm); zebra(wm);
        wm.getColumn("cout").numFmt = eurFmt; wm.getColumn("ht").numFmt = eurFmt; wm.getColumn("pct").numFmt = pctNumFmt;
        const tot = wm.addRow({ ref: "TOTAL", client: f.mois, colis: rowsM.reduce((s, c) => s + c.colis, 0), cout: round2(f.total_general_ht || rowsM.reduce((s, c) => s + c.coutReel, 0)) });
        tot.eachCell((cc: any) => { cc.font = { bold: true }; cc.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEDE9FE" } }; });
      }
    }

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `analyse_bmv_${bmvStats?.num || new Date().toISOString().slice(0, 10)}.xlsx`;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  }
  const carPdfInput = useRef<HTMLInputElement>(null);

  // Convertit une date FedEx "jj/mm" (année courante) en "YYYY-MM-DD"
  const carParseDate = (d: string): string | null => {
    const m = d.match(/^(\d{2})\/(\d{2})(?:\/(\d{2,4}))?$/);
    if (!m) return null;
    const [, dd, mm, yy] = m;
    let year = new Date().getFullYear();
    if (yy) year = yy.length === 2 ? 2000 + parseInt(yy, 10) : parseInt(yy, 10);
    return `${year}-${mm}-${dd}`;
  };

  async function carHandlePdf(file: File) {
    setCarLoading(true); setCarError(""); setCarPdfName(file.name);
    setCarOdoo([]); setCarOdooLoaded(false); setCarView("commandes");
    try {
      const buf = await file.arrayBuffer();
      const res = await fetch("/api/pdf-extract", { method: "POST", headers: { "Content-Type": "application/pdf" }, body: buf });
      const ct = res.headers.get("content-type") || "";
      if (!ct.includes("application/json")) {
        const txt = (await res.text()).slice(0, 200);
        setCarError(res.status === 404
          ? "L'extraction PDF n'est disponible qu'en ligne (Vercel), pas en local. Teste depuis l'URL déployée."
          : `Réponse inattendue du serveur (HTTP ${res.status}) : ${txt}`);
        return;
      }
      const data = await res.json();
      if (data.error) { setCarError("Erreur extraction : " + data.error); return; }
      setCarLignes(data.lignes); setCarCommandes(data.commandes); setCarStats(data.stats);
      setCarFactures(data.factures || []);
      setCarLignesOmises(!!data.lignes_omises);
      // Bornes de dates (juste pour l'entête de l'export, plus de filtre)
      const isoDates = (data.lignes as CarrierLigne[]).map(l => carParseDate(l.date)).filter(Boolean) as string[];
      if (isoDates.length) { isoDates.sort(); setCarStart(isoDates[0]); setCarEnd(isoDates[isoDates.length - 1]); }
      // Recherche Odoo automatique par référence (S…), sans filtre de date
      const refs = (data.commandes as CarrierCommande[]).map(c => c.ref);
      if (session && refs.length) {
        setCarSearching(true);
        try {
          const rows = await odoo.fetchCarrierSaleOrders(session, refs);
          setCarOdoo(rows); setCarOdooLoaded(true); setCarView("croise");
        } catch (e: any) {
          setCarError("Erreur recherche Odoo : " + (e?.message || String(e)));
        } finally { setCarSearching(false); }
      }
    } catch (e) { setCarError("Erreur réseau : " + String(e)); } finally { setCarLoading(false); }
  }

  async function carSearchOdoo() {
    if (!session || !carCommandes.length) return;
    setCarSearching(true); setCarError("");
    try {
      const refs = carCommandes.map(c => c.ref);
      const rows = await odoo.fetchCarrierSaleOrders(session, refs);
      setCarOdoo(rows); setCarOdooLoaded(true); setCarView("croise");
    } catch (e: any) {
      setCarError("Erreur recherche Odoo : " + (e?.message || String(e)));
    } finally { setCarSearching(false); }
  }

  const carCroise: CarrierCrossed[] = useMemo(() => {
    if (!carCommandes.length) return [];
    const map = new Map(carOdoo.map(o => [o.ref, o]));
    // Répartition de la surcharge carburant proportionnellement au transport de chaque commande,
    // pour un coût réel tout compris qui réconcilie au centime avec le total HT de la facture.
    const totT = carStats?.total_transport || 0;
    const surch = carStats?.surcharge_carburant || 0;
    return carCommandes.map(c => {
      const o = map.get(c.ref);
      const montantHT = o?.montantHT ?? 0;
      // coutReel fourni par le parser (réparti par mois) ; fallback calcul global si absent.
      const carbShare = totT > 0 ? surch * (c.transport / totT) : 0;
      const coutReel = c.coutReel ?? Math.round((c.total + carbShare) * 100) / 100;
      // Anomalie : on a payé du transport mais la commande n'a aucun montant (absente Odoo ou montant 0)
      const alert = coutReel > 0 && montantHT <= 0;
      return { ...c, client: o?.client ?? "", partnerRef: o?.partnerRef, montantHT, montantTTC: o?.montantTTC ?? 0, coutReel, matched: !!o, alert, cp: o?.cp, ville: o?.ville, dept: o?.dept, groupe: o?.groupe, groupeDetail: o?.groupeDetail, pct: montantHT > 0 ? coutReel / montantHT : null };
    });
  }, [carCommandes, carOdoo, carStats]);

  const carFiltered = useMemo(() => {
    const q = carSearch.trim().toLowerCase();
    const filt = <T extends { ref: string }>(arr: T[]) => (q ? arr.filter(r => r.ref.toLowerCase().includes(q)) : arr);
    if (carView === "lignes") return filt(carLignes);
    if (carView === "croise") return filt(carCroise);
    return filt(carCommandes);
  }, [carView, carSearch, carLignes, carCommandes, carCroise]);

  const carInsights = useMemo(() => {
    const withPct = carCroise.filter(c => c.pct !== null && c.montantHT > 0);
    if (!withPct.length) return null;
    const topPct = [...withPct].sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0))[0];
    const matched = carCroise.filter(c => c.matched && c.montantHT > 0);
    const totT = matched.reduce((s, c) => s + c.coutReel, 0);
    const totHT = matched.reduce((s, c) => s + c.montantHT, 0);
    const pctGlobal = totHT > 0 ? totT / totHT : 0;
    const byClient = new Map<string, number>();
    for (const c of carCroise) if (c.client) byClient.set(c.client, (byClient.get(c.client) ?? 0) + c.coutReel);
    const topClient = Array.from(byClient.entries()).sort((a, b) => b[1] - a[1])[0];
    return { topPct, pctGlobal, topClient };
  }, [carCroise]);

  function carReset() {
    setCarLignes([]); setCarCommandes([]); setCarStats(null); setCarFactures([]); setCarLignesOmises(false); setCarOdoo([]); setCarOdooLoaded(false);
    setCarPdfName(""); setCarSearch(""); setCarView("commandes"); setCarStart(""); setCarEnd(""); setCarError("");
  }

  async function carExportXlsx() {
    const ExcelJS = (await import("exceljs")).default;
    const round2 = (n: number) => Math.round(n * 100) / 100;
    const wb = new ExcelJS.Workbook();
    wb.creator = "WMS Scanner"; wb.created = new Date();

    // Palette
    const C = {
      dark: "FF1E293B", accent: "FF2563EB", white: "FFFFFFFF",
      zebra: "FFF1F5F9", green: "FFDCFCE7", greenT: "FF166534",
      amber: "FFFEF3C7", amberT: "FF92400E", red: "FFFEE2E2", redT: "FFB91C1C",
      kpiBg: "FFEFF6FF", border: "FFE2E8F0",
    };
    const thin = { style: "thin" as const, color: { argb: C.border } };
    const allBorders = { top: thin, left: thin, bottom: thin, right: thin };
    const eurFmt = '#,##0.00 €';
    const pctNumFmt = '0.0 "%"';

    // Style l'entête d'une feuille
    const styleHeader = (ws: any) => {
      const h = ws.getRow(1); h.height = 22;
      h.eachCell((cell: any) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.dark } };
        cell.font = { bold: true, color: { argb: C.white }, size: 11 };
        cell.alignment = { vertical: "middle", horizontal: "center" };
        cell.border = allBorders;
      });
      ws.views = [{ state: "frozen", ySplit: 1 }];
    };
    const zebra = (ws: any) => {
      for (let r = 2; r <= ws.rowCount; r++) {
        const row = ws.getRow(r);
        if (r % 2 === 0) row.eachCell((c: any) => { if (!c.fill || c.fill.type !== "pattern" || c.fill.fgColor?.argb === undefined) c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.zebra } }; });
        row.eachCell((c: any) => { c.border = allBorders; });
      }
    };

    // ── Feuille SYNTHÈSE ────────────────────────────────────────────
    const matched = carCroise.filter(c => c.matched && c.montantHT > 0);
    const totalTransp = carStats?.total_transport ?? 0;
    const totalHT = matched.reduce((s, c) => s + c.montantHT, 0);
    const anomalies = carCroise.filter(c => c.alert);
    const coutAnomalies = anomalies.reduce((s, c) => s + c.coutReel, 0);
    const coutReelMatched = matched.reduce((s, c) => s + c.coutReel, 0);
    const pctMoyen = totalHT > 0 ? (coutReelMatched / totalHT) : 0;

    const wsS = wb.addWorksheet("Synthèse");
    wsS.columns = [{ width: 40 }, { width: 26 }];
    wsS.mergeCells("A1:B1");
    const title = wsS.getCell("A1");
    title.value = "ANALYSE TRANSPORTEURS"; title.font = { bold: true, size: 16, color: { argb: C.white } };
    title.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.accent } };
    title.alignment = { vertical: "middle", horizontal: "center" };
    wsS.getRow(1).height = 30;
    wsS.mergeCells("A2:B2");
    const sub = wsS.getCell("A2");
    sub.value = `Période : ${carStart || "—"}  →  ${carEnd || "—"}`;
    sub.font = { italic: true, color: { argb: "FF64748B" } }; sub.alignment = { horizontal: "center" };

    const kpi = (label: string, value: string | number, danger = false, good = false) => {
      const row = wsS.addRow([label, value]);
      const lc = row.getCell(1), vc = row.getCell(2);
      lc.font = { bold: true, color: { argb: "FF334155" } };
      lc.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.kpiBg } };
      vc.font = { bold: true, size: 12, color: { argb: danger ? C.redT : good ? C.greenT : "FF0F172A" } };
      if (danger) vc.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.red } };
      vc.alignment = { horizontal: "right" };
      lc.border = allBorders; vc.border = allBorders;
      return row;
    };
    wsS.addRow([]);
    kpi("Nombre de commandes", carStats?.nb_commandes ?? 0);
    kpi("Nombre de colis", carStats?.nb_lignes ?? 0);
    kpi("Coût transport pur", round2(totalTransp)).getCell(2).numFmt = eurFmt;
    if (carStats?.total_options) kpi("Options & services", round2(carStats.total_options)).getCell(2).numFmt = eurFmt;
    if (carStats?.surcharge_carburant) kpi("Surcharge carburant", round2(carStats.surcharge_carburant)).getCell(2).numFmt = eurFmt;
    kpi("TOTAL FACTURÉ HT", round2(carStats?.total_general_ht ?? carStats?.total_facture ?? 0), false, true).getCell(2).numFmt = eurFmt;
    {
      const tg = carStats?.total_general_ht ?? carStats?.total_facture ?? 0;
      const nc = carStats?.nb_lignes || 0, ncmd = carStats?.nb_commandes || 0;
      wsS.addRow([]);
      const sep0 = wsS.addRow(["── INDICATEURS ──", ""]); sep0.getCell(1).font = { bold: true, color: { argb: C.accent } };
      if (carStats?.surcharge_taux) kpi("Taux carburant du mois", `${carStats.surcharge_taux} %`);
      kpi("Coût moyen / colis", nc ? round2(tg / nc) : 0).getCell(2).numFmt = eurFmt;
      kpi("Coût moyen / commande", ncmd ? round2(tg / ncmd) : 0).getCell(2).numFmt = eurFmt;
      kpi("Colis moyen / commande", ncmd ? round2(nc / ncmd) : 0);
    }
    if (carOdooLoaded) {
      wsS.addRow([]);
      const sep = wsS.addRow(["── CROISEMENT ODOO ──", ""]);
      sep.getCell(1).font = { bold: true, color: { argb: C.accent } };
      const foundCount = carCroise.filter(c => c.matched).length;
      kpi("Commandes trouvées dans Odoo", `${foundCount} / ${carCommandes.length}`, false, foundCount === carCommandes.length);
      kpi("Commandes absentes d'Odoo", carCommandes.length - foundCount, carCommandes.length - foundCount > 0);
      kpi("dont avec un montant valide", matched.length);
      kpi("Commandes SANS montant (à perte)", anomalies.length, anomalies.length > 0);
      kpi("Transport payé à perte", round2(coutAnomalies), coutAnomalies > 0).getCell(2).numFmt = eurFmt;
      kpi("Montant commandes HT total", round2(totalHT), false, true).getCell(2).numFmt = eurFmt;
      kpi("% transport / CA moyen (pondéré)", round2(pctMoyen * 100)).getCell(2).numFmt = pctNumFmt;
    }

    // ── Feuille CROISÉ ODOO (ou COMMANDES) ──────────────────────────
    if (carOdooLoaded) {
      const ws = wb.addWorksheet("Croisé Odoo");
      ws.columns = [
        { header: "Référence", key: "ref", width: 12 }, { header: "Client", key: "client", width: 30 },
        { header: "Date", key: "date", width: 9 }, { header: "Zone", key: "zone", width: 6 },
        { header: "Colis", key: "colis", width: 7 }, { header: "Poids (kg)", key: "weight", width: 10 },
        { header: "Transport nu €", key: "transport", width: 13 }, { header: "Coût réel €", key: "coutreel", width: 13 },
        { header: "Montant HT €", key: "ht", width: 14 },
        { header: "Montant TTC €", key: "ttc", width: 14 }, { header: "% Transp.", key: "pct", width: 11 },
        { header: "Cdes jointes", key: "groupe", width: 20 }, { header: "Statut", key: "statut", width: 16 },
      ];
      for (const c of carCroise) {
        ws.addRow({
          ref: c.ref, client: c.client || "(absent Odoo)", date: c.date, zone: c.zone, colis: c.colis,
          weight: c.weight, transport: round2(c.transport), coutreel: round2(c.coutReel), ht: c.montantHT || null, ttc: c.montantTTC || null,
          pct: c.pct !== null ? round2(c.pct * 100) : null,
          groupe: c.groupe && c.groupe.length > 1 ? c.groupe.join(" + ") : "",
          statut: !c.matched ? "ABSENT" : c.alert ? "À PERTE (0 €)" : c.pct! > 0.15 ? "⚠ ÉLEVÉ" : c.pct! > 0.08 ? "Moyen" : "OK",
        });
      }
      styleHeader(ws); zebra(ws);
      ws.getColumn("transport").numFmt = eurFmt; ws.getColumn("coutreel").numFmt = eurFmt; ws.getColumn("ht").numFmt = eurFmt;
      ws.getColumn("ttc").numFmt = eurFmt; ws.getColumn("pct").numFmt = pctNumFmt;
      // Coloration conditionnelle ligne par ligne
      for (let r = 2; r <= ws.rowCount; r++) {
        const c = carCroise[r - 2];
        const pctCell = ws.getCell(r, 11); const statCell = ws.getCell(r, 13);
        let bg = "", fg = "";
        if (!c.matched || c.alert) { bg = C.red; fg = C.redT; }
        else if (c.pct! > 0.15) { bg = C.red; fg = C.redT; }
        else if (c.pct! > 0.08) { bg = C.amber; fg = C.amberT; }
        else { bg = C.green; fg = C.greenT; }
        for (const cell of [pctCell, statCell]) {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bg } };
          cell.font = { bold: true, color: { argb: fg } };
          cell.alignment = { horizontal: "center" };
          cell.border = allBorders;
        }
        if (c.alert) {
          // surligne montant HT/TTC en rouge pour les "à perte"
          for (const ci of [9, 10]) { const cc = ws.getCell(r, ci); cc.font = { bold: true, color: { argb: C.redT } }; cc.value = cc.value ?? 0; }
        }
      }
    } else {
      const ws = wb.addWorksheet("Commandes");
      ws.columns = [
        { header: "Référence", key: "ref", width: 12 }, { header: "Date", key: "date", width: 9 },
        { header: "Zone", key: "zone", width: 6 }, { header: "Colis", key: "colis", width: 7 },
        { header: "Poids (kg)", key: "weight", width: 10 }, { header: "Transport €", key: "transport", width: 13 },
        { header: "Total facturé €", key: "total", width: 14 },
      ];
      for (const c of carCommandes) ws.addRow({ ref: c.ref, date: c.date, zone: c.zone, colis: c.colis, weight: c.weight, transport: round2(c.transport), total: round2(c.total) });
      styleHeader(ws); zebra(ws);
      ws.getColumn("transport").numFmt = eurFmt; ws.getColumn("total").numFmt = eurFmt;
    }

    // ── Feuille ANOMALIES (transport à perte) ───────────────────────
    if (carOdooLoaded && anomalies.length) {
      const ws = wb.addWorksheet("⚠ À perte");
      ws.columns = [
        { header: "Référence", key: "ref", width: 12 }, { header: "Client", key: "client", width: 30 },
        { header: "Date", key: "date", width: 9 }, { header: "Colis", key: "colis", width: 7 },
        { header: "Transport payé €", key: "transport", width: 16 }, { header: "Montant cde", key: "ht", width: 14 },
        { header: "Statut Odoo", key: "statut", width: 16 },
      ];
      for (const c of anomalies) ws.addRow({ ref: c.ref, client: c.client || "(absent Odoo)", date: c.date, colis: c.colis, transport: round2(c.coutReel), ht: 0, statut: c.matched ? "Trouvée, montant 0" : "Absente d'Odoo" });
      styleHeader(ws); zebra(ws);
      ws.getColumn("transport").numFmt = eurFmt; ws.getColumn("ht").numFmt = eurFmt;
      for (let r = 2; r <= ws.rowCount; r++) ws.getRow(r).eachCell((c: any) => { c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.red } }; c.font = { color: { argb: C.redT }, bold: false }; c.border = allBorders; });
    }

    // ── Feuille DÉTAIL JOINTES (commandes groupées détaillées) ──────
    if (carOdooLoaded) {
      const grouped = carCroise.filter(c => c.groupeDetail && c.groupeDetail.length > 1);
      if (grouped.length) {
        const ws = wb.addWorksheet("Détail jointes");
        ws.columns = [
          { header: "Réf facturée", key: "parent", width: 13 }, { header: "Client", key: "client", width: 30 },
          { header: "Transport €", key: "transport", width: 13 }, { header: "Cde du groupe", key: "ref", width: 14 },
          { header: "Type", key: "type", width: 12 }, { header: "Montant HT €", key: "ht", width: 14 },
          { header: "Montant TTC €", key: "ttc", width: 14 }, { header: "% Transp. cumulé", key: "pct", width: 15 },
        ];
        for (const c of grouped) {
          c.groupeDetail!.forEach((d, idx) => {
            ws.addRow({
              parent: idx === 0 ? c.ref : "", client: idx === 0 ? c.client : "", transport: idx === 0 ? round2(c.coutReel) : null,
              ref: d.ref, type: d.ref === c.ref ? "facturée" : "jointe", ht: d.montantHT, ttc: d.montantTTC,
              pct: idx === 0 && c.pct !== null ? round2(c.pct * 100) : null,
            });
          });
        }
        styleHeader(ws); zebra(ws);
        ws.getColumn("transport").numFmt = eurFmt; ws.getColumn("ht").numFmt = eurFmt; ws.getColumn("ttc").numFmt = eurFmt; ws.getColumn("pct").numFmt = pctNumFmt;
        // surligne les lignes "facturée" (début de groupe)
        for (let r = 2; r <= ws.rowCount; r++) {
          const typeCell = ws.getCell(r, 5);
          if (typeCell.value === "facturée") ws.getRow(r).eachCell((cc: any) => { cc.font = { bold: true, color: { argb: "FF5B21B6" } }; });
          else { const rc = ws.getCell(r, 4); rc.font = { color: { argb: "FF7C3AED" } }; }
        }
      }
    }

    // ── Feuille PAR CLIENT ──────────────────────────────────────────
    if (carOdooLoaded) {
      const byClient = new Map<string, { client: string; partnerRef: string; cdes: number; colis: number; transport: number; ht: number }>();
      for (const c of carCroise) {
        const key = c.client || "(absent Odoo)";
        if (!byClient.has(key)) byClient.set(key, { client: key, partnerRef: c.partnerRef || "", cdes: 0, colis: 0, transport: 0, ht: 0 });
        const g = byClient.get(key)!;
        if (!g.partnerRef && c.partnerRef) g.partnerRef = c.partnerRef;
        g.cdes += 1; g.colis += c.colis; g.transport = round2(g.transport + c.coutReel); g.ht = round2(g.ht + c.montantHT);
      }
      const ws = wb.addWorksheet("Par client");
      ws.columns = [
        { header: "N° Client", key: "partnerRef", width: 14 }, { header: "Client", key: "client", width: 32 },
        { header: "Cdes", key: "cdes", width: 8 }, { header: "Colis", key: "colis", width: 8 },
        { header: "Transport €", key: "transport", width: 14 }, { header: "Montant HT €", key: "ht", width: 15 },
        { header: "% Transp.", key: "pct", width: 11 },
      ];
      for (const g of Array.from(byClient.values()).sort((a, b) => b.transport - a.transport)) {
        ws.addRow({ partnerRef: g.partnerRef || null, client: g.client, cdes: g.cdes, colis: g.colis, transport: g.transport, ht: g.ht || null, pct: g.ht > 0 ? round2((g.transport / g.ht) * 100) : null });
      }
      styleHeader(ws); zebra(ws);
      ws.getColumn("transport").numFmt = eurFmt; ws.getColumn("ht").numFmt = eurFmt; ws.getColumn("pct").numFmt = pctNumFmt;
      for (let r = 2; r <= ws.rowCount; r++) {
        const pc = ws.getCell(r, 7); const v = typeof pc.value === "number" ? pc.value / 100 : null;
        if (v !== null) { const bg = v > 0.15 ? C.red : v > 0.08 ? C.amber : C.green; const fg = v > 0.15 ? C.redT : v > 0.08 ? C.amberT : C.greenT; pc.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bg } }; pc.font = { bold: true, color: { argb: fg } }; pc.alignment = { horizontal: "center" }; pc.border = allBorders; }
      }
    }

    // ── Feuille TOP DÉPARTEMENTS (coût d'expédition) ────────────────
    if (carOdooLoaded) {
      const byDept = new Map<string, { dept: string; cdes: number; colis: number; cout: number; ht: number }>();
      for (const c of carCroise) {
        const key = c.dept || "??";
        if (!byDept.has(key)) byDept.set(key, { dept: key, cdes: 0, colis: 0, cout: 0, ht: 0 });
        const g = byDept.get(key)!; g.cdes += 1; g.colis += c.colis; g.cout = round2(g.cout + c.coutReel); g.ht = round2(g.ht + c.montantHT);
      }
      const totCout = Array.from(byDept.values()).reduce((s, g) => s + g.cout, 0) || 1;
      const ws = wb.addWorksheet("Top départements");
      ws.columns = [
        { header: "Dépt", key: "dept", width: 7 }, { header: "Département", key: "nom", width: 24 },
        { header: "Commandes", key: "cdes", width: 11 }, { header: "Colis", key: "colis", width: 8 },
        { header: "Coût réel €", key: "cout", width: 14 }, { header: "% du coût", key: "part", width: 11 },
        { header: "Coût / colis €", key: "cpc", width: 13 }, { header: "% transp/CA", key: "pct", width: 12 },
      ];
      for (const g of Array.from(byDept.values()).sort((a, b) => b.cout - a.cout)) {
        ws.addRow({ dept: g.dept, nom: FR_DEPTS[g.dept] || (g.dept === "??" ? "(inconnu)" : g.dept), cdes: g.cdes, colis: g.colis, cout: g.cout, part: round2((g.cout / totCout) * 100), cpc: g.colis ? round2(g.cout / g.colis) : 0, pct: g.ht > 0 ? round2((g.cout / g.ht) * 100) : null });
      }
      styleHeader(ws); zebra(ws);
      ws.getColumn("cout").numFmt = eurFmt; ws.getColumn("cpc").numFmt = eurFmt;
      ws.getColumn("part").numFmt = pctNumFmt; ws.getColumn("pct").numFmt = pctNumFmt;
      // Barre de données (heatmap intégrée) sur le coût réel.
      if (ws.rowCount > 1) ws.addConditionalFormatting({ ref: `E2:E${ws.rowCount}`, rules: [{ type: "dataBar", cfvo: [{ type: "num", value: 0 }, { type: "max" }], color: { argb: "FF2563EB" } } as any] });
    }

    // ── Feuille TOP COMMANDEURS (qui commande le plus) ──────────────
    if (carOdooLoaded) {
      const byCli = new Map<string, { client: string; cdes: number; colis: number; cout: number; ht: number; ville: string }>();
      for (const c of carCroise) {
        const key = c.client || "(absent Odoo)";
        if (!byCli.has(key)) byCli.set(key, { client: key, cdes: 0, colis: 0, cout: 0, ht: 0, ville: c.ville || "" });
        const g = byCli.get(key)!; g.cdes += 1; g.colis += c.colis; g.cout = round2(g.cout + c.coutReel); g.ht = round2(g.ht + c.montantHT); if (!g.ville && c.ville) g.ville = c.ville;
      }
      const ws = wb.addWorksheet("Top commandeurs");
      ws.columns = [
        { header: "Client", key: "client", width: 30 }, { header: "Ville", key: "ville", width: 18 },
        { header: "Commandes", key: "cdes", width: 11 }, { header: "Colis", key: "colis", width: 8 },
        { header: "CA HT €", key: "ht", width: 14 }, { header: "Coût transp €", key: "cout", width: 14 },
        { header: "% transp/CA", key: "pct", width: 12 },
      ];
      for (const g of Array.from(byCli.values()).sort((a, b) => b.cdes - a.cdes)) {
        ws.addRow({ client: g.client, ville: g.ville, cdes: g.cdes, colis: g.colis, ht: g.ht || null, cout: g.cout, pct: g.ht > 0 ? round2((g.cout / g.ht) * 100) : null });
      }
      styleHeader(ws); zebra(ws);
      ws.getColumn("ht").numFmt = eurFmt; ws.getColumn("cout").numFmt = eurFmt; ws.getColumn("pct").numFmt = pctNumFmt;
      if (ws.rowCount > 1) ws.addConditionalFormatting({ ref: `C2:C${ws.rowCount}`, rules: [{ type: "dataBar", cfvo: [{ type: "num", value: 0 }, { type: "max" }], color: { argb: "FF16A34A" } } as any] });
    }

    // ── Feuilles PAR MOIS (fichier multi-factures) ──────────────────
    if (carFactures.length > 1) {
      const usedSheetNames = new Set<string>();
      const uniqueSheetName = (base: string) => {
        let name = base.replace(/[\\/?*[\]:]/g, "").slice(0, 31) || "Feuille";
        if (!usedSheetNames.has(name)) { usedSheetNames.add(name); return name; }
        let i = 2;
        while (usedSheetNames.has(`${name.slice(0, 27)} (${i})`)) i++;
        const out = `${name.slice(0, 27)} (${i})`;
        usedSheetNames.add(out); return out;
      };
      for (const f of carFactures) {
        const rowsM = carCroise.filter(c => c.mois === f.mois_label);
        if (!rowsM.length) continue;
        const ws = wb.addWorksheet(uniqueSheetName(`${f.mois_label}${f.num ? " " + f.num : ""}`), { properties: { tabColor: { argb: "FF7C3AED" } } });
        ws.columns = [
          { header: "Référence", key: "ref", width: 12 }, { header: "Client", key: "client", width: 28 },
          { header: "Colis", key: "colis", width: 7 }, { header: "Coût réel €", key: "cout", width: 13 },
          { header: "Montant HT €", key: "ht", width: 14 }, { header: "% Transp.", key: "pct", width: 11 },
          { header: "Statut", key: "statut", width: 15 },
        ];
        for (const c of rowsM) ws.addRow({
          ref: c.ref, client: c.client || "(absent Odoo)", colis: c.colis, cout: round2(c.coutReel),
          ht: c.montantHT || null, pct: c.pct !== null ? round2(c.pct * 100) : null,
          statut: !c.matched ? "ABSENT" : c.alert ? "À PERTE" : c.pct! > 0.15 ? "⚠ ÉLEVÉ" : c.pct! > 0.08 ? "Moyen" : "OK",
        });
        styleHeader(ws); zebra(ws);
        ws.getColumn("cout").numFmt = eurFmt; ws.getColumn("ht").numFmt = eurFmt; ws.getColumn("pct").numFmt = pctNumFmt;
        // ligne total du mois
        const tot = ws.addRow({ ref: "TOTAL", client: f.mois_label, colis: rowsM.reduce((s, c) => s + c.colis, 0), cout: round2(f.stats.total_general_ht || rowsM.reduce((s, c) => s + c.coutReel, 0)) });
        tot.eachCell((cc: any) => { cc.font = { bold: true }; cc.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEDE9FE" } }; });
      }
    }

    // ── Feuille LIGNES DÉTAIL (omise sur les très gros fichiers) ────
    if (carLignes.length) {
      const wsD = wb.addWorksheet("Lignes détail");
      wsD.columns = [
        { header: "Référence", key: "ref", width: 12 }, { header: "Date", key: "date", width: 9 },
        { header: "Zone", key: "zone", width: 6 }, { header: "Tracking", key: "tracking", width: 22 },
        { header: "Poids (kg)", key: "weight", width: 10 }, { header: "Transport €", key: "transport", width: 13 },
        { header: "Total €", key: "total", width: 12 },
      ];
      for (const l of carLignes) wsD.addRow({ ref: l.ref, date: l.date, zone: l.zone, tracking: l.tracking, weight: l.weight, transport: round2(l.transport), total: round2(l.total) });
      styleHeader(wsD); zebra(wsD);
      wsD.getColumn("transport").numFmt = eurFmt; wsD.getColumn("total").numFmt = eurFmt;
    }

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `analyse_transport_${new Date().toISOString().slice(0, 10)}.xlsx`;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  }

  // Carte de France interactive (choroplèthe coût d'expédition par département) en HTML autonome.
  function carExportCarte() {
    const byDept: Record<string, { cout: number; cdes: number; colis: number; nom: string }> = {};
    for (const c of carCroise) {
      const k = c.dept || "";
      if (!k) continue;
      if (!byDept[k]) byDept[k] = { cout: 0, cdes: 0, colis: 0, nom: FR_DEPTS[k] || k };
      byDept[k].cout = Math.round((byDept[k].cout + c.coutReel) * 100) / 100;
      byDept[k].cdes += 1; byDept[k].colis += c.colis;
    }
    const periode = `${carStart || "—"} → ${carEnd || "—"}`;
    const html = `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>Carte coût transport</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<script src="https://cdn.jsdelivr.net/npm/d3@7"></script>
<style>
 body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#f8fafc;color:#0f172a}
 header{padding:18px 24px;background:#1e293b;color:#fff}
 header h1{margin:0;font-size:18px} header p{margin:4px 0 0;font-size:13px;color:#94a3b8}
 #wrap{display:flex;gap:16px;padding:20px;flex-wrap:wrap}
 #map{flex:1;min-width:480px;background:#fff;border:1px solid #e2e8f0;border-radius:12px}
 #side{width:320px;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:14px;max-height:640px;overflow:auto}
 #side h2{font-size:13px;text-transform:uppercase;color:#64748b;margin:0 0 10px}
 .row{display:flex;justify-content:space-between;padding:6px 8px;border-radius:6px;font-size:13px}
 .row:nth-child(even){background:#f1f5f9}
 .dn{font-weight:600}.dv{font-weight:700;color:#2563eb}
 .dept{stroke:#fff;stroke-width:.5;cursor:pointer;transition:opacity .1s}
 .dept:hover{opacity:.75;stroke:#0f172a;stroke-width:1.2}
 #tt{position:fixed;pointer-events:none;background:#0f172a;color:#fff;padding:8px 10px;border-radius:8px;font-size:12px;opacity:0;transition:opacity .1s;z-index:9}
 .legend text{font-size:11px;fill:#475569}
</style></head><body>
<header><h1>Coût d'expédition par département</h1><p>Période ${periode} · coût réel tout compris (transport + frais + carburant réparti)</p></header>
<div id="wrap"><div id="map"></div><div id="side"><h2>Top départements coûteux</h2><div id="ranking"></div></div></div>
<div id="tt"></div>
<script>
const DATA = ${JSON.stringify(byDept)};
const tt = document.getElementById('tt');
const eur = n => (n||0).toLocaleString('fr-FR',{minimumFractionDigits:2,maximumFractionDigits:2})+' €';
const vals = Object.values(DATA).map(d=>d.cout);
const maxV = d3.max(vals)||1;
const color = d3.scaleSequential(d3.interpolateYlOrRd).domain([0,maxV]);
const W=640,H=640;
const svg=d3.select('#map').append('svg').attr('viewBox','0 0 '+W+' '+H).attr('width','100%');
d3.json('https://cdn.jsdelivr.net/gh/gregoiredavid/france-geojson@master/departements.geojson').then(geo=>{
  const proj=d3.geoConicConformal().center([2.5,46.5]).scale(2600).translate([W/2,H/2]);
  const path=d3.geoPath().projection(proj);
  svg.selectAll('path').data(geo.features).join('path')
    .attr('d',path).attr('class','dept')
    .attr('fill',f=>{const d=DATA[f.properties.code];return d?color(d.cout):'#e2e8f0';})
    .on('mousemove',(e,f)=>{const d=DATA[f.properties.code];tt.style.opacity=1;tt.style.left=(e.clientX+14)+'px';tt.style.top=(e.clientY+14)+'px';
      tt.innerHTML='<b>'+f.properties.code+' · '+f.properties.nom+'</b><br>'+(d?eur(d.cout)+'<br>'+d.cdes+' cde · '+d.colis+' colis':'aucune expédition');})
    .on('mouseleave',()=>tt.style.opacity=0);
  // légende
  const lg=svg.append('g').attr('class','legend').attr('transform','translate(20,'+(H-40)+')');
  const lw=200;const ls=d3.scaleLinear().domain([0,maxV]).range([0,lw]);
  const grad=svg.append('defs').append('linearGradient').attr('id','g');
  d3.range(0,1.01,.1).forEach(t=>grad.append('stop').attr('offset',(t*100)+'%').attr('stop-color',color(t*maxV)));
  lg.append('rect').attr('width',lw).attr('height',10).attr('fill','url(#g)').attr('rx',3);
  lg.append('text').attr('y',26).text('0 €');lg.append('text').attr('x',lw).attr('y',26).attr('text-anchor','end').text(eur(maxV));
});
const rank=Object.entries(DATA).sort((a,b)=>b[1].cout-a[1].cout);
document.getElementById('ranking').innerHTML=rank.map(([k,d])=>'<div class="row"><span class="dn">'+k+' '+d.nom+'</span><span class="dv">'+eur(d.cout)+'</span></div>').join('');
</script></body></html>`;
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `carte_transport_${new Date().toISOString().slice(0, 10)}.html`;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  }
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

  // ── Suivi DLV ────────────────────────────────────────────────────────────
  type DlvRow = { productId: number; ref: string; name: string; lotId: number; lotName: string; qty: number; qtyDispo: number; dlvDate: string; sellByDate: Date; daysToSellBy: number; avgMonthly: number; unitsSellable: number; unitsAtRisk: number; status: "overdue" | "critical" | "risk" | "watch" | "ok" | "unknown"; marginMonths: number; nbMonths: number };
  const [dlvRows, setDlvRows] = useState<DlvRow[]>([]);
  const [dlvLoading, setDlvLoading] = useState(false);
  const [dlvSearch, setDlvSearch] = useState("");
  const [dlvFilter, setDlvFilter] = useState<"all" | "alert" | "ok" | "overdue" | "critical" | "risk" | "watch" | "ok-only" | "unknown">("alert");
  const DLV_SELL_MARGIN_MONTHS = 12;  // règle standard : DLV - 12 mois
  const DLV_FLEX_MARGIN_MONTHS = 4;   // règle souple : échantillons, miniatures, testeurs
  // Mots-clés produits flex (case-insensitive)
  const DLV_FLEX_KEYWORDS = ["échantillon", "echantillon", "miniature", "testeur", "tester", "sample", "mini "];
  const getDlvMargin = (name: string): number => {
    const n = name.toLowerCase();
    return DLV_FLEX_KEYWORDS.some(k => n.includes(k)) ? DLV_FLEX_MARGIN_MONTHS : DLV_SELL_MARGIN_MONTHS;
  };
  const [dlvColWidths, setDlvColWidths] = useState<Record<string, number>>({ "Statut": 115, "Ref": 100, "Produit": 210, "Lot": 120, "DLV": 120, "Sell-by": 120, "J. restants": 90, "Qté stock": 85, "Stock dispo": 85, "Conso/mois": 92, "Vendable": 85, "À risque": 85 });
  const dlvResizingRef = useRef<{ col: string; startX: number; startW: number } | null>(null);
  const [dlvAvgMonthlyByRef, setDlvAvgMonthlyByRef] = useState<Record<string, number>>({});
  const [dlvAvgNbMonths, setDlvAvgNbMonths] = useState<Record<string, number>>({});
  const [dlvAvgSyncedAt, setDlvAvgSyncedAt] = useState<Date | null>(null);
  const [dlvConsoImporting, setDlvConsoImporting] = useState(false);
  const dlvFileRef = useRef<HTMLInputElement>(null);
  const DLV_MIN_MONTHS = 3; // moins de 3 mois d'historique → statut "unknown" (données insuffisantes)
  // Popup détail produit DLV
  type DlvDetailQuant = { locationId: number; locationName: string; locationFullName: string; lotId: number | null; lotName: string; dlvDate: string | null; qty: number; reservedQty: number };
  const [dlvDetailProduct, setDlvDetailProduct] = useState<{ productId: number; ref: string; name: string } | null>(null);
  const [dlvDetailLoading, setDlvDetailLoading] = useState(false);
  const [dlvDetailData, setDlvDetailData] = useState<DlvDetailQuant[]>([]);

  // ── Assistant IA Odoo ────────────────────────────────────────────────────
  type AiMessage = { role: "user" | "assistant"; text: string; model?: string; queriesRun?: number; rawData?: { description: string; model: string; rows: any[] }[] };
  const [aiMessages, setAiMessages] = useState<AiMessage[]>([]);
  const [aiInput, setAiInput] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const aiBottomRef = useRef<HTMLDivElement>(null);

  const aiSend = async (question?: string) => {
    const q = (question ?? aiInput).trim();
    if (!q || aiLoading || !session) return;
    setAiInput("");
    setAiMessages(prev => [...prev, { role: "user", text: q }]);
    setAiLoading(true);
    try {
      const resp = await fetch("/api/ai-odoo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, odooUrl: session.config.url, sessionId: session.sessionId, history: aiMessages }),
      });
      const data = await resp.json();
      if (data.error) throw new Error(data.error);
      setAiMessages(prev => [...prev, { role: "assistant", text: data.answer, model: data.model, queriesRun: data.queriesRun, rawData: data.rawData }]);
    } catch (e: any) {
      setAiMessages(prev => [...prev, { role: "assistant", text: `❌ Erreur : ${e.message}` }]);
    }
    setAiLoading(false);
  };

  useEffect(() => { aiBottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [aiMessages, aiLoading]);

  const aiExportExcel = (rawData: { description: string; model: string; rows: any[] }[]) => {
    const allRows = rawData.flatMap(r => r.rows);
    if (!allRows.length) return;
    // Récupérer toutes les colonnes (union de toutes les clés)
    const keys = Array.from(new Set(allRows.flatMap(r => Object.keys(r)))).filter(k => k !== "id");
    const thStyle = "background:#1e3a5f;color:#fff;font-weight:bold;padding:6px 10px;border:1px solid #ccc;";
    const tdStyle = "padding:5px 10px;border:1px solid #ddd;";
    const formatVal = (v: any): string => {
      if (v === null || v === undefined || v === false) return "";
      if (Array.isArray(v)) return v[1] ?? v[0] ?? "";
      return String(v);
    };
    const headers = keys.map(k => `<th style="${thStyle}">${k}</th>`).join("");
    const rows = allRows.map(row =>
      `<tr>${keys.map(k => `<td style="${tdStyle}">${formatVal(row[k])}</td>`).join("")}</tr>`
    ).join("");
    const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="UTF-8"></head><body><table><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table></body></html>`;
    const blob = new Blob(["﻿" + html], { type: "application/vnd.ms-excel;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url;
    a.download = `assistant_ia_${new Date().toISOString().split("T")[0]}.xls`;
    a.click(); URL.revokeObjectURL(url);
  };

  // ── Commandes à emballer du jour ─────────────────────────────────────────
  const [todayOutPending, setTodayOutPending] = useState<number | null>(null);
  const [todayOutDone, setTodayOutDone]       = useState<number | null>(null);

  const loadTodayOut = useCallback(async () => {
    if (!session) return;
    try {
      const today = new Date().toISOString().split("T")[0];
      const tomorrow = new Date(Date.now() + 86400000).toISOString().split("T")[0];
      const [pending, done] = await Promise.all([
        odoo.searchRead(session, "stock.picking",
          [["picking_type_code","=","outgoing"],
           ["state","in",["assigned","partially_available","confirmed","waiting"]],
           ["scheduled_date",">=",`${today} 00:00:00`],
           ["scheduled_date","<",`${tomorrow} 00:00:00`]],
          ["id"], 500
        ),
        odoo.searchRead(session, "stock.picking",
          [["picking_type_code","=","outgoing"],
           ["state","=","done"],
           ["date_done",">=",`${today} 00:00:00`],
           ["date_done","<",`${tomorrow} 00:00:00`]],
          ["id"], 500
        ),
      ]);
      setTodayOutPending(pending.length);
      setTodayOutDone(done.length);
    } catch {}
  }, [session]);

  useEffect(() => {
    if (!session) return;
    loadTodayOut();
    const t = setInterval(loadTodayOut, 2 * 60 * 1000); // refresh toutes les 2 min
    return () => clearInterval(t);
  }, [session, loadTodayOut]);

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

  // ── Catalogue ──────────────────────────────────────────────────────────────
  const [catQuery, setCatQuery]           = useState("");
  const [catRows, setCatRows]             = useState<Record<string,any>[]>([]);
  const [catLoading, setCatLoading]       = useState(false);
  const [catMsg, setCatMsg]               = useState("");
  const [catCols, setCatCols]             = useState<Set<CatColKey>>(new Set(CAT_DEFAULT_COLS));
  const [catColsOpen, setCatColsOpen]     = useState(false);
  const [catSelected, setCatSelected]     = useState<Set<number>>(new Set());
  const catSearchRef                      = useRef<ReturnType<typeof setTimeout>|null>(null);
  // Inline editing catalogue
  const [catEdit, setCatEdit]             = useState<{rowId:number; field:string; value:string} | null>(null);
  const [catSaving, setCatSaving]         = useState<string>(""); // "rowId:field" en cours de save

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
    supa.loadAvgMonthly().then(({ avg, nbMonths }) => {
      setAvgMonthlyByRef(avg);
      // nbMonths from wms_conso_cache sert aussi pour DLV (historique suffisant ?)
      setDlvAvgNbMonths(prev => ({ ...nbMonths, ...prev }));
    }).catch(() => {});
    // Load DLV avg (séparé du suivi stock — fallback pour produits hors wms_thresholds)
    supa.loadDlvAvg().then(avg => { setDlvAvgMonthlyByRef(avg); }).catch(() => {});
    supa.getDlvAvgAge().then(d => setDlvAvgSyncedAt(d)).catch(() => {});
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

  // ── SUIVI DLV ──
  const loadDlv = useCallback(async () => {
    if (!session) return;
    setDlvLoading(true);
    try {
      const lots = await odoo.getDlvStockLots(session);
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const rows: DlvRow[] = lots.map(lot => {
        const marginMonths = getDlvMargin(lot.name);
        // Normalise la date (peut être "YYYY-MM-DD HH:MM:SS" ou "YYYY-MM-DDTHH:MM:SS")
        const dlvRaw = lot.dlvDate.split(" ")[0].split("T")[0];
        const dlvDate = new Date(dlvRaw + "T00:00:00");
        const sellByDate = new Date(dlvDate);
        sellByDate.setMonth(sellByDate.getMonth() - marginMonths);
        const daysToSellBy = Math.floor((sellByDate.getTime() - today.getTime()) / 86400000);
        // wms_conso_cache (avgMonthlyByRef) est prioritaire — même source que Suivi Stock
        // dlvAvgMonthlyByRef (wms_dlv_avg) = fallback pour produits hors wms_thresholds
        const avgMonthly = avgMonthlyByRef[lot.ref] || dlvAvgMonthlyByRef[lot.ref] || 0;
        const nbMonths = dlvAvgNbMonths[lot.ref] || 0;
        const hasEnoughHistory = avgMonthly === 0 ? false : (nbMonths === 0 || nbMonths >= DLV_MIN_MONTHS);
        const monthsToSellBy = Math.max(0, daysToSellBy / 30);
        const unitsSellable = avgMonthly > 0 ? Math.floor(monthsToSellBy * avgMonthly) : 0;
        const unitsAtRisk = Math.max(0, lot.qtyDispo - (avgMonthly > 0 ? unitsSellable : 0));

        let status: DlvRow["status"];
        if (avgMonthly === 0 || !hasEnoughHistory) status = "unknown";
        else if (daysToSellBy <= 0) status = "overdue";
        else if (daysToSellBy < 30) status = "critical";
        else if (unitsAtRisk > 0) status = "risk";
        else if (daysToSellBy < 90) status = "watch";
        else status = "ok";

        return { ...lot, sellByDate, daysToSellBy, avgMonthly, unitsSellable: avgMonthly > 0 ? unitsSellable : lot.qtyDispo, unitsAtRisk: avgMonthly > 0 ? unitsAtRisk : 0, status, marginMonths, nbMonths };
      });
      // Trier : hors délai → critiques → risques → attention → ok → inconnus
      const ORDER = { overdue: 0, critical: 1, risk: 2, watch: 3, ok: 4, unknown: 5 };
      rows.sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.daysToSellBy - b.daysToSellBy);
      setDlvRows(rows);
    } catch (e: any) { setError(e.message); }
    setDlvLoading(false);
  }, [session, dlvAvgMonthlyByRef, dlvAvgNbMonths, avgMonthlyByRef, DLV_SELL_MARGIN_MONTHS, DLV_MIN_MONTHS]);

  // ── EXPORT DLV EXCEL ──
  const exportDlvExcel = useCallback(async (rows: DlvRow[]) => {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    wb.creator = "WMS";
    wb.created = new Date();
    const ws = wb.addWorksheet("Suivi DLV", { views: [{ state: "frozen", ySplit: 1 }] });

    // Couleurs par statut
    const STATUS_COLORS: Record<string, { bg: string; fg: string; label: string }> = {
      overdue:  { bg: "FFFEF2F2", fg: "FF7C2D12", label: "⛔ Hors délai" },
      critical: { bg: "FFFEF2F2", fg: "FFDC2626", label: "🔴 Critique"  },
      risk:     { bg: "FFFFF7ED", fg: "FFC2410C", label: "🟠 Risque"    },
      watch:    { bg: "FFFEFCE8", fg: "FFB45309", label: "🟡 Attention" },
      ok:       { bg: "FFF0FDF4", fg: "FF15803D", label: "🟢 OK"        },
      unknown:  { bg: "FFF8FAFC", fg: "FF64748B", label: "⚪ Sans conso" },
    };

    // En-têtes
    ws.columns = [
      { header: "Statut",      key: "statut",    width: 16 },
      { header: "Ref",         key: "ref",        width: 14 },
      { header: "Produit",     key: "name",       width: 30 },
      { header: "Lot",         key: "lot",        width: 16 },
      { header: "DLV",         key: "dlv",        width: 14 },
      { header: "Sell-by",     key: "sellby",     width: 14 },
      { header: "J. restants", key: "days",       width: 12 },
      { header: "Qté stock",    key: "qty_total",  width: 11 },
      { header: "Stock dispo",  key: "qty",        width: 11 },
      { header: "Conso/mois",  key: "conso",      width: 11 },
      { header: "Vendable",    key: "vendable",   width: 11 },
      { header: "À risque",    key: "arisque",    width: 11 },
    ];

    // Style en-tête
    const headerRow = ws.getRow(1);
    headerRow.eachCell(cell => {
      cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E293B" } };
      cell.alignment = { vertical: "middle", horizontal: "center" };
      cell.border = { bottom: { style: "medium", color: { argb: "FF334155" } } };
    });
    headerRow.height = 28;

    // Lignes
    const fmtD = (d: Date) => d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });
    for (const r of rows) {
      const cfg = STATUS_COLORS[r.status];
      const row = ws.addRow({
        statut:  cfg.label,
        ref:     r.ref || "",
        name:    r.name,
        lot:     r.lotName,
        dlv:     fmtD(new Date(r.dlvDate.split(" ")[0] + "T00:00:00")),
        sellby:  fmtD(r.sellByDate),
        days:    r.daysToSellBy <= 0 ? "Dépassé" : r.daysToSellBy,
        qty_total: Math.round(r.qty),
        qty:     Math.round(r.qtyDispo),
        conso:   r.avgMonthly || "",
        vendable: r.avgMonthly > 0 ? r.unitsSellable : "",
        arisque: r.avgMonthly > 0 ? Math.round(r.unitsAtRisk) : "",
      });
      row.height = 22;
      row.eachCell(cell => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: cfg.bg } };
        cell.alignment = { vertical: "middle" };
        cell.border = { bottom: { style: "thin", color: { argb: "FFE2E8F0" } } };
      });
      // Colonne statut : couleur texte + gras
      const statCell = row.getCell("statut");
      statCell.font = { bold: true, color: { argb: cfg.fg }, size: 11 };
      // Colonne "À risque" : rouge si > 0, vert si 0
      const riskCell = row.getCell("arisque");
      if (r.avgMonthly > 0) {
        riskCell.font = { bold: true, color: { argb: r.unitsAtRisk > 0 ? "FFDC2626" : "FF15803D" }, size: 11 };
        riskCell.value = r.unitsAtRisk > 0 ? `⚠ ${Math.round(r.unitsAtRisk)}` : "✓ 0";
      }
      // Colonnes numériques alignées à droite
      (["qty","conso","vendable"] as const).forEach(k => { row.getCell(k).alignment = { vertical: "middle", horizontal: "right" }; });
      row.getCell("days").alignment = { vertical: "middle", horizontal: "center" };
    }

    // Téléchargement
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `suivi-dlv-${new Date().toISOString().slice(0,10)}.xlsx`; a.click();
    URL.revokeObjectURL(url);
  }, []);

  // ── IMPORT CONSO DLV (séparé du suivi stock) ──
  // Import conso DLV depuis Excel (tableau croisé Odoo) — source de vérité principale
  const importDlvConso = useCallback(async (file: File) => {
    setDlvConsoImporting(true);
    try {
      const XLSX = await import("xlsx");
      const data = await file.arrayBuffer();
      const wb = XLSX.read(data, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
      const FR_MONTHS: Record<string, string> = { janvier:"01",février:"02",mars:"03",avril:"04",mai:"05",juin:"06",juillet:"07",août:"08",septembre:"09",octobre:"10",novembre:"11",décembre:"12" };
      let monthCols: { col: number; month: string }[] = [];
      let dataStartRow = 0;
      for (let r = 0; r < rows.length; r++) {
        const cols: { col: number; month: string }[] = [];
        for (let c = 0; c < rows[r].length; c++) {
          const cell = String(rows[r][c]).trim().toLowerCase();
          const parts = cell.split(" ");
          if (parts.length === 2 && FR_MONTHS[parts[0]] && /^\d{4}$/.test(parts[1]))
            cols.push({ col: c, month: `${parts[1]}-${FR_MONTHS[parts[0]]}` });
        }
        if (cols.length > 0) { monthCols = cols; dataStartRow = r + 2; break; }
      }
      if (monthCols.length === 0) throw new Error("Colonnes de mois introuvables dans le fichier.");
      const now = new Date();
      const last12: string[] = [];
      for (let i = 1; i <= 12; i++) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        last12.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
      }
      const byRef: Record<string, { name: string; total: number; nbMonths: number }> = {};
      for (let r = dataStartRow; r < rows.length; r++) {
        const cell0 = String(rows[r][0] || "").trim();
        const m = cell0.match(/^\[([^\]]+)\]/);
        if (!m) continue;
        const ref = m[1].trim();
        const name = cell0.replace(/^\[[^\]]+\]\s*/, "").trim();
        if (!byRef[ref]) byRef[ref] = { name, total: 0, nbMonths: 0 };
        for (const { col, month } of monthCols) {
          if (!last12.includes(month)) continue;
          const qty = parseFloat(String(rows[r][col] || "0").replace(",", ".")) || 0;
          if (qty > 0) { byRef[ref].total += qty; byRef[ref].nbMonths++; }
        }
      }
      const items: supa.WmsDlvAvg[] = [];
      const newAvg: Record<string, number> = {};
      const newNbMonths: Record<string, number> = {};
      for (const [ref, v] of Object.entries(byRef)) {
        const avg = Math.round(v.total / 12); // toujours divisé par 12 — fenêtre fixe
        if (avg > 0) {
          items.push({ odoo_ref: ref, avg_monthly: avg, product_name: v.name });
          newAvg[ref] = avg;
          newNbMonths[ref] = v.nbMonths;
        }
      }
      if (items.length === 0) throw new Error("Aucune consommation trouvée dans le fichier.");
      await supa.saveDlvAvg(items);
      setDlvAvgMonthlyByRef(prev => ({ ...prev, ...newAvg }));
      setDlvAvgNbMonths(prev => ({ ...prev, ...newNbMonths }));
      setDlvAvgSyncedAt(new Date());
      if (dlvRows.length > 0) setTimeout(() => loadDlv(), 100);
    } catch (e: any) { setError(`Import conso DLV : ${e.message}`); }
    setDlvConsoImporting(false);
  }, [dlvRows.length]);

  // Sync conso DLV directement depuis Odoo — même logique que Suivi Stock
  const syncDlvConsoFromOdoo = useCallback(async () => {
    if (!session) return;
    setDlvConsoImporting(true);
    try {
      const today = new Date();
      const from = new Date(today.getFullYear(), today.getMonth() - 12, 1).toISOString().slice(0, 10) + " 00:00:00";
      const curMonthStart = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10) + " 00:00:00";

      // Même query que smSyncOdoo : internal → customer, product_uom_qty, hors mois courant
      const moves: any[] = await odoo.searchRead(
        session, "stock.move",
        [["state","=","done"],["date",">=",from],["date","<",curMonthStart],
         ["location_id.usage","=","internal"],["location_dest_id.usage","=","customer"]],
        ["product_id","product_uom_qty","date"],
        0
      );
      if (moves.length === 0) throw new Error("Aucune sortie trouvée dans Odoo sur les 12 derniers mois.");

      // Récupérer les refs produit
      const pids = Array.from(new Set(moves.map((m:any) => Array.isArray(m.product_id) ? m.product_id[0] : m.product_id)));
      const prods: any[] = await odoo.searchRead(session, "product.product",
        [["id","in",pids],["active","in",[true,false]]],
        ["id","name","default_code"], 0);
      const pidToRef: Record<number, { ref: string; name: string }> = {};
      for (const p of prods) if (p.default_code) pidToRef[p.id] = { ref: p.default_code, name: p.name };

      // Agréger par ref
      const byRef: Record<string, { name: string; total: number; months: Set<string> }> = {};
      for (const m of moves) {
        const pid = Array.isArray(m.product_id) ? m.product_id[0] : m.product_id;
        const info = pidToRef[pid];
        if (!info) continue;
        const mo = String(m.date || "").slice(0, 7);
        if (!byRef[info.ref]) byRef[info.ref] = { name: info.name, total: 0, months: new Set() };
        byRef[info.ref].total += (m.product_uom_qty || 0);
        byRef[info.ref].months.add(mo);
      }

      const items: supa.WmsDlvAvg[] = [];
      const newAvg: Record<string, number> = {};
      const newNbMonths: Record<string, number> = {};
      for (const [ref, v] of Object.entries(byRef)) {
        const avg = Math.round(v.total / 12); // fenêtre fixe 12 mois
        if (avg > 0) {
          items.push({ odoo_ref: ref, avg_monthly: avg, product_name: v.name });
          newAvg[ref] = avg;
          newNbMonths[ref] = v.months.size;
        }
      }
      if (items.length === 0) throw new Error("Aucune consommation calculée.");
      await supa.saveDlvAvg(items);
      setDlvAvgMonthlyByRef(prev => ({ ...prev, ...newAvg }));
      setDlvAvgNbMonths(prev => ({ ...prev, ...newNbMonths }));
      setDlvAvgSyncedAt(new Date());
      // Recharger les lots DLV si déjà chargés
      if (dlvRows.length > 0) setTimeout(() => loadDlv(), 100);
    } catch (e: any) { setError(e.message); }
    setDlvConsoImporting(false);
  }, [session, dlvRows.length]);

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

      const { avg, nbMonths: nb } = await supa.loadAvgMonthly();
      setAvgMonthlyByRef(avg);
      setDlvAvgNbMonths(prev => ({ ...nb, ...prev }));
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


  // ── Réception : liste des fournisseurs ayant des réceptions « Fait » ──
  const loadRecVendors = useCallback(async () => {
    if (!session) return;
    setRecVendorsLoading(true); setError("");
    try {
      // Types de transfert "entrée" (incoming)
      const inTypes = await odoo.searchRead(session, "stock.picking.type", [["code", "=", "incoming"]], ["id"], 50);
      const inTypeIds = inTypes.map((t: any) => t.id);
      // Pickings reçus (done) → on récupère les partenaires distincts
      const pickings = await odoo.searchRead(
        session, "stock.picking",
        [["picking_type_id", "in", inTypeIds], ["state", "=", "done"]],
        ["partner_id"], 5000, "id desc"
      );
      const byId: Record<number, string> = {};
      for (const p of pickings) {
        if (Array.isArray(p.partner_id) && p.partner_id[0]) byId[p.partner_id[0]] = p.partner_id[1];
      }
      const vendors = Object.entries(byId).map(([id, name]) => ({ id: Number(id), name }))
        .sort((a, b) => a.name.localeCompare(b.name));
      setRecVendors(vendors);
    } catch (e: any) { setError(e.message); } finally { setRecVendorsLoading(false); }
  }, [session]);

  // ── Réception : charge la liste des réceptions (pickings) du fournisseur ──
  const loadRecPickings = useCallback(async () => {
    if (!session || !recVendorId) return;
    setRecPickingsLoading(true); setError(""); setRecPickings([]); setRecPickingId(null); setRecRows([]);
    try {
      const inTypes = await odoo.searchRead(session, "stock.picking.type", [["code", "=", "incoming"]], ["id"], 50);
      const inTypeIds = inTypes.map((t: any) => t.id);
      const pickings = await odoo.searchRead(
        session, "stock.picking",
        [["picking_type_id", "in", inTypeIds], ["state", "=", "done"], ["partner_id", "=", recVendorId]],
        ["id", "name", "date_done", "scheduled_date"], 5000, "date_done desc"
      );
      // Tri : réception la plus récente en haut
      const list = pickings
        .map((p: any) => ({ id: p.id, name: p.name, date: (p.date_done || p.scheduled_date || "").substring(0, 10) }))
        .sort((a: any, b: any) => (b.date || "").localeCompare(a.date || "") || b.id - a.id);
      setRecPickings(list);
    } catch (e: any) { setError(e.message); } finally { setRecPickingsLoading(false); }
  }, [session, recVendorId]);

  // ── Réception : charge les lignes reçues pour la réception sélectionnée ──
  const loadReceptions = useCallback(async () => {
    if (!session || !recPickingId) return;
    setRecLoading(true); setError(""); setRecRows([]);
    try {
      const pickings = await odoo.searchRead(
        session, "stock.picking",
        [["id", "=", recPickingId]],
        ["id", "name", "date_done", "scheduled_date"], 1
      );
      if (!pickings.length) { setRecRows([]); setRecLoading(false); return; }
      const pickById: Record<number, any> = {};
      for (const p of pickings) pickById[p.id] = p;
      const pickIds = pickings.map((p: any) => p.id);

      // Lignes de mouvement réellement reçues (qté + lot)
      const mls = await odoo.searchRead(
        session, "stock.move.line",
        [["picking_id", "in", pickIds], ["state", "=", "done"]],
        ["product_id", "qty_done", "lot_id", "lot_name", "picking_id"], 20000
      );

      // Détails produits : ref Odoo (default_code) + template pour code fournisseur custom
      const prodIds = Array.from(new Set(mls.map((m: any) => Array.isArray(m.product_id) ? m.product_id[0] : null).filter(Boolean)));
      const prodById: Record<number, any> = {};
      const tmplIds = new Set<number>();
      if (prodIds.length) {
        const prods = await odoo.searchRead(session, "product.product", [["id", "in", prodIds]], ["id", "default_code", "name", "product_tmpl_id"], 5000);
        for (const p of prods) { prodById[p.id] = p; if (Array.isArray(p.product_tmpl_id)) tmplIds.add(p.product_tmpl_id[0]); }
      }

      // Réf Odoo (default_code sur le template) + réf fournisseur custom
      const supRefByTmpl: Record<number, string> = {};
      const odooRefByTmpl: Record<number, string> = {};
      if (tmplIds.size) {
        try {
          const tmpls = await odoo.searchRead(session, "product.template", [["id", "in", Array.from(tmplIds)]], ["id", "default_code", "x_studio_code_produit_fournisseur"], 5000);
          for (const t of tmpls) {
            if (t.default_code) odooRefByTmpl[t.id] = String(t.default_code);
            if (t.x_studio_code_produit_fournisseur) supRefByTmpl[t.id] = String(t.x_studio_code_produit_fournisseur);
          }
        } catch { /* champ custom absent : on retombe sur default_code variante */ }
      }
      // Réf fournisseur — source 2 : product.supplierinfo de CE fournisseur
      const supRefByTmpl2: Record<number, string> = {};
      const supRefByProd: Record<number, string> = {};
      if (tmplIds.size) {
        try {
          const sis = await odoo.searchRead(
            session, "product.supplierinfo",
            [["partner_id", "=", recVendorId], ["product_tmpl_id", "in", Array.from(tmplIds)]],
            ["product_code", "product_tmpl_id", "product_id"], 10000
          );
          for (const si of sis) {
            const code = String(si.product_code || "").trim();
            if (!code) continue;
            if (Array.isArray(si.product_id) && si.product_id[0]) supRefByProd[si.product_id[0]] = code;
            else if (Array.isArray(si.product_tmpl_id) && si.product_tmpl_id[0]) supRefByTmpl2[si.product_tmpl_id[0]] = code;
          }
        } catch { /* ignore */ }
      }

      const rows: RecepRow[] = mls.map((m: any) => {
        const pid = Array.isArray(m.product_id) ? m.product_id[0] : null;
        const prod = pid ? prodById[pid] : null;
        const tmplId = prod && Array.isArray(prod.product_tmpl_id) ? prod.product_tmpl_id[0] : null;
        const supplierRef = (pid && supRefByProd[pid]) || (tmplId && supRefByTmpl2[tmplId]) || (tmplId && supRefByTmpl[tmplId]) || "";
        const pick = Array.isArray(m.picking_id) ? pickById[m.picking_id[0]] : null;
        const lot = (Array.isArray(m.lot_id) ? m.lot_id[1] : "") || m.lot_name || "";
        // Réf Odoo = Référence interne (default_code) : template d'abord, sinon variante
        const odooRef = (tmplId && odooRefByTmpl[tmplId]) || prod?.default_code || "";
        return {
          odooRef,
          supplierRef,
          productName: prod?.name || (Array.isArray(m.product_id) ? m.product_id[1] : ""),
          qty: m.qty_done || 0,
          lot,
          pickingName: pick?.name || "",
          date: (pick?.date_done || pick?.scheduled_date || "").substring(0, 10),
        };
      });
      rows.sort((a, b) => (a.productName || "").localeCompare(b.productName || ""));
      setRecRows(rows);
    } catch (e: any) { setError(e.message); } finally { setRecLoading(false); }
  }, [session, recPickingId, recVendorId]);

  const recExportExcel = async () => {
    if (!recRows.length) return;
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Réception", { views: [{ state: "frozen", ySplit: 1 }] });
    ws.columns = [
      { header: "Réf Odoo", key: "odooRef", width: 16 },
      { header: "Réf fournisseur", key: "supplierRef", width: 18 },
      { header: "Nom du produit", key: "productName", width: 46 },
      { header: "Qté reçue", key: "qty", width: 12 },
      { header: "Lot reçu", key: "lot", width: 16 },
      { header: "Réception", key: "pickingName", width: 16 },
      { header: "Date", key: "date", width: 12 },
    ];
    ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF7C3AED" } };
    ws.getRow(1).alignment = { vertical: "middle" };
    for (const r of recRows) ws.addRow(r);
    ws.getColumn("qty").numFmt = "#,##0";
    const vendorName = recVendors.find(v => v.id === recVendorId)?.name || "fournisseur";
    const safe = vendorName.replace(/[^\w]+/g, "_").slice(0, 30);
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `reception_${safe}_${new Date().toISOString().slice(0, 10)}.xlsx`;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  };

  const loadDeliveries = useCallback(async () => {
    if (!session) return; setLoading(true); setError(""); setPrepStats([]);
    try {
      // Get picking type IDs for OUT and PICK (internal)
      // Note: picking type code "internal" covers PICK, PACK, etc. — we separate by name/sequence_code
      const pickingTypes = await odoo.searchRead(session, "stock.picking.type", [["code", "in", ["outgoing", "internal"]]], ["id", "code", "sequence_code", "name"], 50);
      const outTypeIds = pickingTypes.filter((t: any) => t.code === "outgoing").map((t: any) => t.id);

      // PICK types = internal types whose sequence_code or name contains "pick" or "prel" (prélèvement)
      // On ne fait PAS de fallback sur tous les internes — sinon les mvts internes admin (Raynald) faussent les stats
      const pickCandidates = pickingTypes.filter((t: any) => {
        const sc = (t.sequence_code || "").toLowerCase();
        const nm = (t.name || "").toLowerCase();
        return sc.includes("pick") || nm.includes("pick") || sc.includes("prel") || nm.includes("prél") || nm.includes("prele") || nm.includes("prépa") || nm.includes("prepa");
      });
      const pickTypeIds = pickCandidates.map((t: any) => t.id);

      // Load OUT pickings
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

      // ── Stats préparateurs via mail.tracking.value ──────────────────────────
      // On cherche QUI a passé l'état à "done" dans l'historique Odoo (chatter)
      // = l'auteur du message "Prêt → Fait (État)" — plus fiable que write_uid
      // qui peut être écrasé par des opérations post-validation (send_to_shipper, etc.)
      const allPickingIds = allPickings.map((p: any) => p.id);
      const pickingAuthorMap: Record<number, string> = {};

      // ── Identifier le valideur par proximité temporelle avec date_done ────────
      // Le message de changement d'état est créé dans la même transaction que la validation
      // → son date ≈ date_done. On prend le message le plus proche, sans dépendre de
      // tracking_value_ids (incompatible certaines versions Odoo) ni de new_value_char (traduit).
      if (allPickingIds.length > 0) {
        try {
          const allMsgs = await odoo.searchRead(
            session, "mail.message",
            [
              ["model", "=", "stock.picking"],
              ["res_id", "in", allPickingIds],
              ["author_id", "!=", false],
            ],
            ["id", "res_id", "author_id", "date"],
            15000
          );

          // date_done par picking (en ms UTC)
          const doneDateMs: Record<number, number> = {};
          for (const p of allPickings) {
            if (p.date_done) doneDateMs[p.id] = new Date(p.date_done).getTime();
          }

          // Groupe messages par picking, exclut les bots
          const msgsByPicking: Record<number, any[]> = {};
          for (const msg of allMsgs) {
            const authorName = (msg.author_id?.[1] || "").toLowerCase();
            if (authorName.includes("bot") || authorName === "odoobot") continue;
            if (!msgsByPicking[msg.res_id]) msgsByPicking[msg.res_id] = [];
            msgsByPicking[msg.res_id].push(msg);
          }

          // Pour chaque picking, message le plus proche de date_done (dans la fenêtre ±30 min)
          for (const [pickingIdStr, msgs] of Object.entries(msgsByPicking)) {
            const pickingId = Number(pickingIdStr);
            const doneMs = doneDateMs[pickingId];
            if (!doneMs) continue;
            let closest: any = null;
            let closestDiff = Infinity;
            for (const msg of msgs) {
              const diff = Math.abs(new Date(msg.date).getTime() - doneMs);
              if (diff < closestDiff && diff < 30 * 60 * 1000) {
                closestDiff = diff;
                closest = msg;
              }
            }
            if (closest) pickingAuthorMap[pickingId] = closest.author_id[1] || "Inconnu";
          }
        } catch {
          // fallback write_uid si mail inaccessible
        }
      }

      const prepByUser: Record<string, { picking: number; emballage: number }> = {};
      for (const p of allPickings) {
        const name = pickingAuthorMap[p.id] || p.write_uid?.[1] || "Inconnu";
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

  useEffect(() => {
    if (!session) return;
    if (tab === "deliveries") loadDeliveries();
    if (tab === "stock-monitor" && smRows.length === 0) smLoad(smDeliveryMonth);
    if (tab === "dlv" && dlvRows.length === 0) loadDlv();
    if (tab === "reception" && recVendors.length === 0) loadRecVendors();
  }, [tab, session]); // eslint-disable-line react-hooks/exhaustive-deps

  // ══════════════════════════════════════════════════════
  // SUIVI STOCK — nouveau tab (remplace Alertes + Conso)
  // ══════════════════════════════════════════════════════
  interface SmRow { ref: string; name: string; stock: number; conso: number; threshold: number; daysLeft: number; daysUntilDeliv: number; delivLabel: string; supplierDate: string | null; expected_qty: number; status: "ok"|"alert"|"critical"|"no_data"|"not_found"; }

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
  const smOrderFileRef = useRef<HTMLInputElement>(null);
  const [smSelected, setSmSelected] = useState<Set<string>>(new Set());
  const [smExpected, setSmExpected] = useState<Record<string,number>>({});
  // Date de prochaine livraison globale (15 du mois choisi) — mémorisée en localStorage
  const smDefaultDelivery = (): string => {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth()+1);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
  };
  const [smDeliveryMonth, setSmDeliveryMonth] = useState<string>(()=>{
    try{return localStorage.getItem("wms_delivery_month")||smDefaultDelivery();}catch{return smDefaultDelivery();}
  });
  const smSetDeliveryMonth = (v:string)=>{
    setSmDeliveryMonth(v);
    try{localStorage.setItem("wms_delivery_month",v);}catch{}
  };

  const smNextDelivery = (supDate?: string|null, delivMonth?: string): {date:Date;label:string} => {
    if (supDate) { const d=new Date(supDate+"T00:00:00"); return {date:d,label:`Fourn. ${d.toLocaleDateString("fr-FR",{day:"2-digit",month:"short"})}`}; }
    const m = delivMonth || smDefaultDelivery();
    const [y,mo] = m.split("-").map(Number);
    const d = new Date(y, mo-1, 15);
    return {date:d,label:`15 ${d.toLocaleDateString("fr-FR",{month:"short",year:"numeric"})}`};
  };
  const smDaysUntil = (d:Date) => Math.ceil((d.getTime()-new Date().setHours(0,0,0,0))/86400000);
  const smStatus = (stock:number,conso:number,thr:number,daysLeft:number,daysDeliv:number,expected:number=0,hasOrderConf:boolean=false): SmRow["status"] => {
    if (conso===0&&stock===0) return "no_data";
    // Si order conf chargé mais produit absent → vraie livraison = mois suivant (+30j)
    const effectiveDaysDeliv = (hasOrderConf && expected===0) ? daysDeliv+30 : daysDeliv;
    const effStock = stock + expected;
    const effDaysLeft = conso>0 ? Math.round(effStock*30/conso) : (effStock>0?999:0);
    if (effDaysLeft < effectiveDaysDeliv) return "critical";
    return "ok";
  };

  const smBuildRows = useCallback((refs:{ref:string;name:string}[], stockByRef:Record<string,{id:number;name:string;qty:number}>, consoByRef:Record<string,number>, thrMap:Record<string,number>, supMap:Record<string,string|null>, delivMonth?:string, expectedMap?:Record<string,number>, hasOrderConf?:boolean): SmRow[] => {
    const orderConf = hasOrderConf ?? false;
    return refs.map(({ref,name:rname}) => {
      const od=stockByRef[ref];
      const expected=expectedMap?.[ref]??0;
      if (!od) return {ref,name:rname||ref,stock:0,conso:0,threshold:thrMap[ref]??0,daysLeft:0,daysUntilDeliv:0,delivLabel:"-",supplierDate:supMap[ref]??null,expected_qty:expected,status:"not_found"};
      const stock=od.qty, conso=consoByRef[ref]??0, threshold=thrMap[ref]??Math.round(conso);
      const {date:dd,label:dl}=smNextDelivery(supMap[ref], delivMonth);
      const daysUntilDeliv=Math.max(0,smDaysUntil(dd));
      const daysLeft=conso>0?Math.round(stock*30/conso):(stock>0?999:0);
      // Si order conf chargé et produit absent, indiquer que la livraison réelle = mois suivant
      const delivLabel = (orderConf && expected===0 && !supMap[ref]) ? dl+" →+1m" : dl;
      return {ref,name:od.name,stock,conso:Math.round(conso*10)/10,threshold,daysLeft,daysUntilDeliv,delivLabel,supplierDate:supMap[ref]??null,expected_qty:expected,status:smStatus(stock,conso,threshold,daysLeft,daysUntilDeliv,expected,orderConf)};
    });
  },[]);

  // ── Sync Odoo (stock + conso) pour une liste de refs donnée ──────────────
  const smSyncOdoo = useCallback(async (
    refs:{ref:string;name:string}[],
    thrMap:Record<string,number>,
    supMap:Record<string,string|null>,
    delivMonth?:string,
    expectedMap?:Record<string,number>,
    cachedConso?:Record<string,number>   // si fourni → pas de requête Odoo pour la conso
  ) => {
    if (!session || !refs.length) return;
    setSmMsg("Stock Odoo...");
    const prods:any[]=await odoo.searchRead(session,"product.product",[["default_code","in",refs.map(r=>r.ref)],["active","in",[true,false]]],["id","name","default_code","qty_available"],0);
    const stockByRef:Record<string,{id:number;name:string;qty:number}>={};
    for(const p of prods) if(p.default_code) stockByRef[p.default_code]={id:p.id,name:p.name,qty:p.qty_available??0};

    let consoByRef:Record<string,number>={};
    if(cachedConso) {
      // Utiliser la conso en cache — pas de requête Odoo
      for(const ref of Object.keys(stockByRef)) consoByRef[ref]=cachedConso[ref]??0;
    } else {
      // Pas de cache → fetch Odoo + sauvegarder
      setSmMsg("Consommation (12 mois depuis Odoo)...");
      const today=new Date();
      const from=new Date(today.getFullYear(),today.getMonth()-12,1).toISOString().slice(0,10)+" 00:00:00";
      const curMonthStart=new Date(today.getFullYear(),today.getMonth(),1).toISOString().slice(0,10)+" 00:00:00";
      const pids=Object.values(stockByRef).map(p=>p.id);
      if(pids.length){
        const moves:any[]=await odoo.searchRead(session,"stock.move",[["state","=","done"],["product_id","in",pids],["date",">=",from],["date","<",curMonthStart],["location_id.usage","=","internal"],["location_dest_id.usage","=","customer"]],["product_id","product_uom_qty","date"],0);
        const byPidMonth:Record<number,Record<string,number>>={};
        for(const m of moves){const pid=Array.isArray(m.product_id)?m.product_id[0]:m.product_id;const mo=String(m.date||"").slice(0,7);if(!byPidMonth[pid])byPidMonth[pid]={};byPidMonth[pid][mo]=(byPidMonth[pid][mo]||0)+(m.product_uom_qty||0);}
        // Agréger par ref+mois pour la sauvegarde
        const consoItems:supa.WmsConsoCache[]=[];
        for(const [ref,info] of Object.entries(stockByRef)){
          const pid=info.id; let total=0;
          for(let i=12;i>=1;i--){
            const d=new Date(today.getFullYear(),today.getMonth()-i,1);
            const mo=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
            const qty=(byPidMonth[pid]?.[mo]??0);
            if(qty>0) consoItems.push({odoo_ref:ref,product_name:info.name,month:mo,qty});
            total+=qty;
          }
          consoByRef[ref]=Math.round(total/12);
        }
        // Sauvegarder en cache Supabase (DELETE+INSERT par mois — pas de cumul)
        if(consoItems.length) supa.saveConsoCache(consoItems).then(()=>supa.getConsoCacheAge().then(d=>{if(d)setConsoSyncedAt(d);})).catch(()=>{});
        // Mettre à jour avgMonthlyByRef en mémoire
        setAvgMonthlyByRef(prev=>({...prev,...consoByRef}));

        // ── Persister les seuils dans wms_thresholds : seuil = moyenne mensuelle (12 mois)
        // C'est CE bloc qui manquait : sans ça, le seuil affiché à l'écran (fallback
        // sur la conso en mémoire) disparaissait au reload, puisque wms_thresholds
        // n'était jamais mis à jour par cette fonction.
        try {
          setSmMsg("Sauvegarde seuils Supabase...");
          // On préserve supplier_date / expected_qty existants pour ne pas écraser
          // les saisies utilisateur dans la table wms_thresholds.
          const refsToSave = Object.keys(stockByRef);
          const existMap:Record<string,{supplier_date:string|null;expected_qty:number}>={};
          for(let i=0;i<refsToSave.length;i+=500){
            const slice=refsToSave.slice(i,i+500);
            const {data:existing}=await supa.sb.from("wms_thresholds")
              .select("odoo_ref,supplier_date,expected_qty").in("odoo_ref",slice);
            for(const r of (existing||[])) existMap[r.odoo_ref]={supplier_date:r.supplier_date,expected_qty:r.expected_qty??0};
          }
          const now=new Date().toISOString();
          const thresholdItems=Object.entries(stockByRef).map(([ref,info])=>({
            odoo_ref:ref,
            // seuil = conso mensuelle moyenne (12 mois) — minimum 1 pour articles sans historique
            threshold:Math.max(1,consoByRef[ref]||0),
            product_name:info.name,
            supplier_date:existMap[ref]?.supplier_date??null,
            expected_qty:existMap[ref]?.expected_qty??0,
            updated_at:now,
          }));
          for(let i=0;i<thresholdItems.length;i+=500){
            const {error}=await supa.sb.from("wms_thresholds")
              .upsert(thresholdItems.slice(i,i+500),{onConflict:"odoo_ref"});
            if(error) throw new Error(error.message);
          }
          // Mettre à jour thrMap (passé par référence) pour que smBuildRows utilise
          // les nouvelles valeurs sauvegardées, et l'état global pour les alertes.
          for(const it of thresholdItems) thrMap[it.odoo_ref]=it.threshold;
          const updatesByRef=Object.fromEntries(thresholdItems.map(t=>[t.odoo_ref,t.threshold]));
          setThresholdsByRef(prev=>({...prev,...updatesByRef}));
        } catch(e:any) {
          console.warn("Save thresholds failed:",e.message);
          setError("Seuils non sauvegardés : "+e.message);
        }
      }
    }
    const hasOrderConf=Object.keys(expectedMap||{}).length>0;
    const rows=smBuildRows(refs,stockByRef,consoByRef,thrMap,supMap,delivMonth,expectedMap,hasOrderConf);
    setSmRows(rows);
  },[session,smBuildRows]);

  // ── Chargement complet depuis Supabase puis Odoo ──────────────────────────

  // ── Catalogue inline edit save ────────────────────────────────────────────
  const catSaveField = useCallback(async (row: Record<string,any>, field: string, value: string) => {
    if (!session) return;
    const key = `${row._id}:${field}`;
    setCatSaving(key);
    try {
      if (field === "name" || field === "weight") {
        // Écriture sur product.template
        const writeVal = field === "weight" ? (parseFloat(value.replace(",",".")) || 0) : value.trim();
        await odoo.write(session, "product.template", [row._tmpl], { [field]: writeVal });
        setCatRows(prev => prev.map(r => r._id === row._id ? { ...r, [field]: writeVal } : r));
      } else if (field === "barcode") {
        // Écriture sur product.product (variant)
        await odoo.write(session, "product.product", [row._id], { barcode: value.trim() || false });
        setCatRows(prev => prev.map(r => r._id === row._id ? { ...r, barcode: value.trim() } : r));
      }
    } catch (e: any) {
      alert(`Erreur sauvegarde : ${e?.message || e}`);
    } finally {
      setCatSaving("");
      setCatEdit(null);
    }
  }, [session]);

  // ── Catalogue search ──────────────────────────────────────────────────────
  const catSearch = useCallback(async (q: string, cols: Set<CatColKey>) => {
    if (!session || q.trim().length < 2) { setCatRows([]); setCatMsg(""); return; }
    setCatLoading(true); setCatMsg("Recherche...");
    try {
      // 1. Recherche produits de base
      const needDims = cols.has("length") || cols.has("width") || cols.has("height");
      const baseFields = ["id","name","default_code","barcode","weight","volume","categ_id","uom_id",
        "qty_available","virtual_available","tracking","list_price","standard_price","product_tmpl_id"];
      const query: any[] = ["|", ["name","ilike",q], "|", ["default_code","ilike",q], ["barcode","ilike",q]];
      let prods: any[];
      let hasDims = false;
      try {
        prods = await odoo.searchRead(session, "product.product", query,
          needDims ? [...baseFields,"x_length","x_width","x_height"] : baseFields, 300);
        hasDims = needDims;
      } catch(e1: any) {
        if (needDims && String(e1?.message).includes("x_length")) {
          prods = await odoo.searchRead(session, "product.product", query, baseFields, 300);
        } else throw e1;
      }

      // Packaging (colisage)
      let pkgByTmpl: Record<number,number> = {};
      if (prods.length) {
        const tmplIds = Array.from(new Set(prods.map((p:any) => Array.isArray(p.product_tmpl_id)?p.product_tmpl_id[0]:p.product_tmpl_id).filter(Boolean)));
        try {
          const pkgs = await odoo.searchRead(session,"product.packaging",[["product_id","in",tmplIds]],["product_id","qty"],200);
          for (const pk of pkgs) { const tid=Array.isArray(pk.product_id)?pk.product_id[0]:pk.product_id; if(!pkgByTmpl[tid]) pkgByTmpl[tid]=pk.qty; }
        } catch {}
      }

      const rows: Record<string,any>[] = prods.map((p:any) => {
        const tmplId = Array.isArray(p.product_tmpl_id)?p.product_tmpl_id[0]:p.product_tmpl_id;
        return {
          _id: p.id, _tmpl: tmplId,
          name: p.name,
          default_code: p.default_code||"",
          barcode: p.barcode||"",
          categ: Array.isArray(p.categ_id)?p.categ_id[1]:"",
          uom: Array.isArray(p.uom_id)?p.uom_id[1]:"",
          weight: p.weight||"",
          volume: p.volume?(p.volume*1000).toFixed(3):"",
          length: hasDims?(p.x_length||""):"", width: hasDims?(p.x_width||""):"", height: hasDims?(p.x_height||""):"",
          qty_available: p.qty_available??0,
          qty_virtual: p.virtual_available??0,
          tracking: p.tracking==="lot"?"Lot":p.tracking==="serial"?"Série":"Aucun",
          list_price: p.list_price||"",
          standard_price: p.standard_price||"",
          packaging_qty: pkgByTmpl[tmplId]||"",
          // enriched later:
          sup_ref:"", sup_name:"", sup_product_name:"", sup_code:"",
          sup_price:"", sup_delay:"", sup_min_qty:"", sup_currency:"",
          locations:"", lots:"", dluo:"",
        };
      });

      setCatRows(rows);
      setCatSelected(new Set());
      setCatMsg(`${rows.length} produit${rows.length>1?"s":""} trouvé${rows.length>1?"s":""}`);

      const ids = prods.map((p:any)=>p.id);
      if (!ids.length) return;

      // 2. Enrichissement fournisseur (si colonnes visibles)
      const needSup = (["sup_ref","sup_name","sup_product_name","sup_code","sup_price","sup_delay","sup_min_qty","sup_currency"] as CatColKey[]).some(k=>cols.has(k));
      if (needSup) {
        setCatMsg("Infos fournisseurs...");
        try {
          const tmplIdsArr = Array.from(new Set(prods.map((p:any)=>Array.isArray(p.product_tmpl_id)?p.product_tmpl_id[0]:p.product_tmpl_id).filter(Boolean)));
          const sis = await odoo.searchRead(session,"product.supplierinfo",
            [["product_tmpl_id","in",tmplIdsArr]],
            ["product_tmpl_id","product_code","product_name","partner_id","price","delay","min_qty","currency_id"],
            tmplIdsArr.length*3
          );
          // Prendre le premier fournisseur par template
          const supByTmpl: Record<number,any> = {};
          for (const si of sis) {
            const tid = Array.isArray(si.product_tmpl_id)?si.product_tmpl_id[0]:si.product_tmpl_id;
            if (!supByTmpl[tid]) supByTmpl[tid] = si;
          }
          setCatRows(r => r.map(row => {
            const si = supByTmpl[row._tmpl];
            if (!si) return row;
            return { ...row,
              sup_ref: si.product_code||"",
              sup_name: Array.isArray(si.partner_id)?si.partner_id[1]:"",
              sup_product_name: si.product_name||"",
              sup_code: si.product_code||"",
              sup_price: si.price||"",
              sup_delay: si.delay||"",
              sup_min_qty: si.min_qty||"",
              sup_currency: Array.isArray(si.currency_id)?si.currency_id[1]:"",
            };
          }));
        } catch {}
      }

      // 3. Emplacements (stock.quant)
      if (cols.has("locations")) {
        setCatMsg("Emplacements...");
        try {
          const quants = await odoo.searchRead(session,"stock.quant",
            [["product_id","in",ids],["location_id.usage","=","internal"],["quantity",">",0]],
            ["product_id","location_id","quantity"],ids.length*5
          );
          const locByProd: Record<number,string[]> = {};
          for (const q of quants) {
            const pid = Array.isArray(q.product_id)?q.product_id[0]:q.product_id;
            const loc = Array.isArray(q.location_id)?q.location_id[1]:String(q.location_id);
            // Exclure emplacements virtuels / sortie / entrée inutiles
            if (/sortie|virtual|output|input|scrap|rebut/i.test(loc)) continue;
            const qty = Math.round(q.quantity*100)/100;
            if (!locByProd[pid]) locByProd[pid]=[];
            locByProd[pid].push(`${loc} (${qty})`);
          }
          setCatRows(r => r.map(row => ({ ...row, locations: (locByProd[row._id]||[]).join(" | ")||"—" })));
        } catch {}
      }

      // 4. Lots + DLUO
      const needLots = cols.has("lots")||cols.has("dluo");
      if (needLots) {
        setCatMsg("Lots / DLUO...");
        try {
          const lots = await odoo.searchRead(session,"stock.lot",
            [["product_id","in",ids]],
            ["product_id","name","expiration_date","use_expiration_date"],
            ids.length*10
          );
          const lotsByProd: Record<number,{name:string;exp:string}[]> = {};
          for (const l of lots) {
            const pid = Array.isArray(l.product_id)?l.product_id[0]:l.product_id;
            if (!lotsByProd[pid]) lotsByProd[pid]=[];
            const exp = l.expiration_date||l.use_expiration_date||"";
            lotsByProd[pid].push({name:l.name, exp: exp?new Date(exp).toLocaleDateString("fr-FR"):""});
          }
          setCatRows(r => r.map(row => {
            const ls = lotsByProd[row._id]||[];
            return { ...row,
              lots: ls.map(l=>l.name).join(", ")||"—",
              dluo: ls.filter(l=>l.exp).map(l=>`${l.name}: ${l.exp}`).join(" | ")||"—",
            };
          }));
        } catch {}
      }

      setCatMsg(`${rows.length} produit${rows.length>1?"s":""} trouvé${rows.length>1?"s":""}`);
    } catch(e:any) { setCatMsg("Erreur: "+e.message); }
    finally { setCatLoading(false); }
  }, [session]);

  const catTrigger = useCallback((q: string, cols: Set<CatColKey>) => {
    if (catSearchRef.current) clearTimeout(catSearchRef.current);
    catSearchRef.current = setTimeout(()=>catSearch(q, cols), 380);
  }, [catSearch]);

  const catToggleCol = (key: CatColKey) => {
    setCatCols(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      catTrigger(catQuery, next);
      return next;
    });
  };

  const catExportXlsx = async () => {
    if (!catRows.length) return;
    const XLSX = await import("xlsx");
    const visibleCols = CAT_COL_DEFS.filter(c => catCols.has(c.key));
    const header = ["Nom produit", ...visibleCols.map(c=>c.label)];
    const exportRows = catSelected.size > 0 ? catRows.filter(r=>catSelected.has(r._id)) : catRows;
    const data = exportRows.map(r => [r.name, ...visibleCols.map(c => r[c.key] ?? "")]);
    const ws = XLSX.utils.aoa_to_sheet([header, ...data]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Catalogue");
    XLSX.writeFile(wb, `catalogue_${new Date().toISOString().slice(0,10)}.xlsx`);
  };

  // ── wms_thresholds : table existante, on y stocke refs + seuils + supplier_date ──
  // Structure : odoo_ref, threshold, product_name, supplier_date (colonne à ajouter)

  const smLoadAll = async (): Promise<{refs:{ref:string;name:string}[];thrMap:Record<string,number>;supMap:Record<string,string|null>;expectedMap:Record<string,number>}> => {
    // Paginé : Supabase cape les select() à 1000 lignes par défaut → au-dessus, refs invisibles
    const rows:any[]=[];
    let offset=0; const pageSize=1000;
    while(true){
      const {data,error}=await supa.sb.from("wms_thresholds").select("odoo_ref,threshold,product_name,supplier_date,expected_qty").order("odoo_ref").range(offset,offset+pageSize-1);
      if (error) throw new Error("wms_thresholds: "+error.message);
      const batch=data||[];
      rows.push(...batch);
      if(batch.length<pageSize) break;
      offset+=pageSize;
      if(offset>100000) break;
    }
    const refs=rows.map((r:any)=>({ref:r.odoo_ref,name:r.product_name||r.odoo_ref}));
    const thrMap:Record<string,number>=Object.fromEntries(rows.map((r:any)=>[r.odoo_ref,r.threshold]));
    const supMap:Record<string,string|null>=Object.fromEntries(rows.filter((r:any)=>r.supplier_date).map((r:any)=>[r.odoo_ref,r.supplier_date]));
    const expectedMap:Record<string,number>=Object.fromEntries(rows.filter((r:any)=>r.expected_qty>0).map((r:any)=>[r.odoo_ref,r.expected_qty]));
    return {refs,thrMap,supMap,expectedMap};
  };

  // ── Chargement complet depuis wms_thresholds ─────────────────────────────
  const smLoad = useCallback(async (delivMonth?:string, forceConsoSync=false) => {
    if (!session) return;
    setSmLoading(true); setSmMsg("Chargement références...");
    try {
      const {refs,thrMap,supMap,expectedMap}=await smLoadAll();
      setSmRefs(refs);
      setSmExpected(expectedMap);
      if (!refs.length){setSmLoading(false);setSmMsg("");return;}

      let consoToUse:Record<string,number>|undefined = undefined;

      if (forceConsoSync) {
        // Sync forcée : fetch Odoo + écrase le cache (DELETE+INSERT)
        consoToUse = undefined;
      } else {
        // Utiliser la conso en mémoire — si vide, tenter Supabase avant de toucher Odoo
        let cached = avgMonthlyByRef;
        if (Object.keys(cached).length === 0) {
          try {
            const { avg, nbMonths: nb } = await supa.loadAvgMonthly();
            if (Object.keys(avg).length > 0) {
              setAvgMonthlyByRef(avg);
              setDlvAvgNbMonths(prev => ({ ...nb, ...prev }));
              cached = avg;
            }
          } catch {}
        }
        // Si toujours vide → pas de cache Supabase → sync Odoo inévitable
        consoToUse = Object.keys(cached).length > 0 ? cached : undefined;
      }

      await smSyncOdoo(refs,thrMap,supMap,delivMonth||smDeliveryMonth,expectedMap,consoToUse);
    } catch(e:any){setError(e.message);}
    finally{setSmLoading(false);setSmMsg("");}
  },[session,smSyncOdoo,avgMonthlyByRef]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Import Excel → upsert dans wms_thresholds (garde seuils existants) ──
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
      for(let i=1;i<data.length;i++){const row=data[i];const ref=String(row[rc]??"").trim();if(!ref)continue;newRefs.push({ref,name:nc>=0?String(row[nc]??"").trim():""});}
      if(!newRefs.length){setError("Aucune référence trouvée");return;}

      setSmMsg(`${newRefs.length} refs — sauvegarde Supabase...`);
      // Garde seuils/ruptures existants pour ces refs, supprime tout le reste
      const {data:existing}=await supa.sb.from("wms_thresholds").select("odoo_ref,threshold,supplier_date");
      const existMap:Record<string,{threshold:number;supplier_date:string|null}>=Object.fromEntries((existing||[]).map((r:any)=>[r.odoo_ref,{threshold:r.threshold,supplier_date:r.supplier_date}]));

      // Supprimer les anciennes refs qui ne sont plus dans la nouvelle liste
      const newRefSet=new Set(newRefs.map(r=>r.ref));
      const toDelete=(existing||[]).filter((r:any)=>!newRefSet.has(r.odoo_ref)).map((r:any)=>r.odoo_ref);
      for(let i=0;i<toDelete.length;i+=100){
        await supa.sb.from("wms_thresholds").delete().in("odoo_ref",toDelete.slice(i,i+100));
      }

      const upsertRows=newRefs.map(r=>({
        odoo_ref:r.ref,
        product_name:r.name,
        threshold:existMap[r.ref]?.threshold??0,
        updated_at:new Date().toISOString(),
      }));
      // Upsert par batch de 500
      for(let i=0;i<upsertRows.length;i+=500){
        const {error}=await supa.sb.from("wms_thresholds").upsert(upsertRows.slice(i,i+500),{onConflict:"odoo_ref"});
        if(error) throw new Error(error.message);
      }

      setSmRefs(newRefs);
      setSmMsg(`${newRefs.length} refs — sync Odoo...`);
      const thrMap:Record<string,number>=Object.fromEntries(newRefs.map(r=>[r.ref,existMap[r.ref]?.threshold??0]));
      const supMap:Record<string,string|null>=Object.fromEntries(newRefs.filter(r=>existMap[r.ref]?.supplier_date).map(r=>[r.ref,existMap[r.ref]?.supplier_date]));
      // Recharge expected depuis Supabase pour ne pas perdre l'order conf après un import refs
      let expMap=smExpected;
      try{const {expectedMap}=await smLoadAll().then(r=>r).catch(()=>({expectedMap:{}} as any));if(Object.keys(expectedMap||{}).length)expMap=expectedMap;}catch{}
      await smSyncOdoo(newRefs,thrMap,supMap,smDeliveryMonth,expMap);
    }catch(e:any){setError("Import: "+e.message);}
    finally{setSmLoading(false);setSmMsg("");if(smFileRef.current)smFileRef.current.value="";}
  };

  const smSaveThr = async (ref:string,val:string,name:string) => {
    const n=parseFloat(val); if(isNaN(n)||n<0){setSmEditThr(null);return;}
    setSmRows(r=>r.map(row=>{if(row.ref!==ref)return row;const u={...row,threshold:n};u.status=smStatus(u.stock,u.conso,n,u.daysLeft,u.daysUntilDeliv);return u;}));
    setSmEditThr(null);
    try {
      const {error}=await supa.sb.from("wms_thresholds").upsert({odoo_ref:ref,threshold:n,product_name:name,updated_at:new Date().toISOString()},{onConflict:"odoo_ref"});
      if(error) throw new Error(error.message);
    } catch(e:any) { setError("Erreur sauvegarde seuil : "+e.message); }
  };

  const smResetThresholds = async () => {
    const toUpdate=smRows.filter(r=>r.conso>0&&r.status!=="not_found");
    if(!toUpdate.length)return;
    const newVal=toUpdate.map(r=>Math.round(r.conso));
    // Mise à jour UI immédiate
    setSmRows(rows=>rows.map(row=>{
      const idx=toUpdate.findIndex(r=>r.ref===row.ref);
      if(idx<0)return row;
      const n=newVal[idx];
      const u={...row,threshold:n};
      u.status=smStatus(u.stock,u.conso,n,u.daysLeft,u.daysUntilDeliv);
      return u;
    }));
    try {
      const now=new Date().toISOString();
      const items=toUpdate.map((r,i)=>({odoo_ref:r.ref,threshold:newVal[i],product_name:r.name,supplier_date:r.supplierDate??null,expected_qty:r.expected_qty??0,updated_at:now}));
      for(let i=0;i<items.length;i+=500){
        const {error}=await supa.sb.from("wms_thresholds").upsert(items.slice(i,i+500),{onConflict:"odoo_ref"});
        if(error) throw new Error(error.message);
      }
    } catch(e:any) { setError("Erreur sauvegarde seuils : "+e.message); }
  };

  // Import Order Confirmation allemagne → colonne "Attendu"
  const smImportOrder = async (e:React.ChangeEvent<HTMLInputElement>) => {
    const file=e.target.files?.[0]; if(!file)return;
    if(!session){setSmMsg("Connecte-toi d'abord à Odoo");return;}
    const XLSX=(await import("xlsx"));
    setSmLoading(true);setSmMsg("Lecture order confirmation...");
    try{
      const buf=await file.arrayBuffer();
      const wb=XLSX.read(buf,{type:"array"});
      const ws=wb.Sheets[wb.SheetNames[0]];
      const data:any[][]=XLSX.utils.sheet_to_json(ws,{header:1,raw:true});
      if(!data.length)throw new Error("Fichier vide");

      // Colonnes connues : G=6 (Article-No.), I=8 (EAN), K=10 (Quantity available)
      const headers=(data[0]||[]).map((h:any)=>String(h||"").toLowerCase().trim());
      const eanIdx=headers.findIndex((h:string)=>h.includes("ean")||h.includes("barcode")||h.includes("gtin"));
      const qtyIdx=headers.findIndex((h:string)=>h.includes("available"));
      const ei=eanIdx>=0?eanIdx:8;   // col I
      const qi=qtyIdx>=0?qtyIdx:10;  // col K

      // Helpers
      const parseQty=(v:any):number=>{
        if(typeof v==="number") return v;
        // Supprime espaces normaux, NBSP (U+00A0), espace fine (U+202F) utilisés comme séparateurs de milliers
        const s=String(v??"").replace(/[\s  ]/g,"").replace(",",".");
        return parseFloat(s)||0;
      };
      const parseEan=(v:any):string=>String(v??"").trim().replace(/\.0+$/,"").replace(/\s/g,"");

      // Parse EAN → qty
      const eanQty:Record<string,number>={};
      for(let i=1;i<data.length;i++){
        const row=data[i];
        const ean=parseEan(row[ei]);
        const qty=parseQty(row[qi]);
        if(ean&&ean.length>=8&&qty>0) eanQty[ean]=(eanQty[ean]||0)+qty;
      }
      const eans=Object.keys(eanQty);
      if(!eans.length)throw new Error("Aucune ligne valide trouvée (EAN vide ou qté=0)");
      setSmMsg(`${eans.length} EAN — matching Odoo barcodes...`);

      // Matching via barcode sur product.product
      const byBarcode:any[]=await odoo.searchRead(
        session,"product.product",
        [["barcode","in",eans],["active","in",[true,false]]],
        ["id","default_code","barcode"],0
      );

      // Construit barcode → default_code
      const barcodeToCode:Record<string,string>={};
      for(const p of byBarcode) if(p.barcode&&p.default_code) barcodeToCode[String(p.barcode)]=p.default_code;

      // Si certains EAN pas trouvés sur product.product, essai sur product.template
      const missing=eans.filter(e=>!barcodeToCode[e]);
      if(missing.length){
        const byTmpl:any[]=await odoo.searchRead(
          session,"product.template",
          [["barcode","in",missing]],
          ["id","default_code","barcode"],0
        );
        // Pour chaque template trouvé, récupère les variants
        const tmplIds=byTmpl.map(t=>t.id);
        if(tmplIds.length){
          const variants:any[]=await odoo.searchRead(
            session,"product.product",
            [["product_tmpl_id","in",tmplIds],["active","in",[true,false]]],
            ["id","default_code","product_tmpl_id"],0
          );
          const tmplToCode:Record<number,string>={};
          for(const v of variants) if(v.default_code) tmplToCode[v.product_tmpl_id[0]??v.product_tmpl_id]=v.default_code;
          for(const t of byTmpl) if(t.barcode&&tmplToCode[t.id]) barcodeToCode[String(t.barcode)]=tmplToCode[t.id];
        }
      }

      // Construit expectedMap odoo_ref → qty
      const newExp:Record<string,number>={};
      let matched=0,unmatched=0;
      for(const [ean,qty] of Object.entries(eanQty)){
        const odooRef=barcodeToCode[ean];
        if(odooRef){newExp[odooRef]=(newExp[odooRef]||0)+qty;matched++;}
        else unmatched++;
      }

      if(!matched)throw new Error(`Aucun EAN matchés dans Odoo — vérifie que les barcodes sont saisis sur les produits (${unmatched} EAN non trouvés)`);

      setSmMsg(`Sauvegarde Supabase...`);
      // Remet expected_qty=0 pour toutes les refs, puis met à jour celles matchées
      try{
        await supa.sb.from("wms_thresholds").update({expected_qty:0}).not("odoo_ref","is",null);
        const toUpsert=Object.entries(newExp).map(([odoo_ref,qty])=>({odoo_ref,expected_qty:Math.round(qty),updated_at:new Date().toISOString()}));
        for(let i=0;i<toUpsert.length;i+=200){
          await supa.sb.from("wms_thresholds").upsert(toUpsert.slice(i,i+200),{onConflict:"odoo_ref"});
        }
      }catch{}

      setSmExpected(newExp);
      setSmMsg(`✅ ${matched} refs matchées${unmatched>0?` · ${unmatched} EAN non trouvés`:""}`);
      setSmRows(rows=>rows.map(row=>{
        const exp=newExp[row.ref]??0;
        return {...row,expected_qty:exp,status:smStatus(row.stock,row.conso,row.threshold,row.daysLeft,row.daysUntilDeliv,exp)};
      }));
    }catch(e:any){setSmMsg("❌ "+e.message);}
    finally{setSmLoading(false);setTimeout(()=>setSmMsg(""),8000);if(smOrderFileRef.current)smOrderFileRef.current.value="";}
  };

  // Vide l'order confirmation (remet expected_qty à 0 partout)
  const smClearOrderConf = async () => {
    setSmExpected({});
    // hasOrderConf=false après vidage → on recalcule avec daysDeliv normal
    setSmRows(rows=>rows.map(row=>{
      const {date:dd,label:dl}=smNextDelivery(row.supplierDate,smDeliveryMonth);
      const dtu=Math.max(0,smDaysUntil(dd));
      return {...row,expected_qty:0,daysUntilDeliv:dtu,delivLabel:dl,status:smStatus(row.stock,row.conso,row.threshold,row.daysLeft,dtu,0,false)};
    }));
    try{ await supa.sb.from("wms_thresholds").update({expected_qty:0}).not("odoo_ref","is",null); }catch{}
  };

  const smSaveSupDate = async (overrideDate?:string|null) => {
    if(!smSupModal)return;
    const {ref}=smSupModal;
    const d=overrideDate!==undefined?overrideDate:(smSupInput||null);
    setSmRows(r=>r.map(row=>{if(row.ref!==ref)return row;const {date:dd,label:dl}=smNextDelivery(d,smDeliveryMonth);const dtu=Math.max(0,smDaysUntil(dd));const u={...row,supplierDate:d,daysUntilDeliv:dtu,delivLabel:dl};u.status=smStatus(u.stock,u.conso,u.threshold,u.daysLeft,dtu,u.expected_qty);return u;}));
    try { await supa.sb.from("wms_thresholds").update({supplier_date:d,updated_at:new Date().toISOString()}).eq("odoo_ref",ref); } catch {}
    setSmSupModal(null);setSmSupInput("");
  };

  // Recalcule les rows quand le mois de livraison ou les attendus changent
  useEffect(()=>{
    if(!smRows.length) return;
    const hasOrderConf=Object.keys(smExpected).length>0;
    setSmRows(rows=>rows.map(row=>{
      const {date:dd,label:dl}=smNextDelivery(row.supplierDate,smDeliveryMonth);
      const dtu=Math.max(0,smDaysUntil(dd));
      const exp=smExpected[row.ref]??row.expected_qty??0;
      // Label: si order conf chargé et produit absent, indiquer livraison mois suivant
      const delivLabel=(hasOrderConf && exp===0 && !row.supplierDate) ? dl+" →+1m" : dl;
      return {...row,daysUntilDeliv:dtu,delivLabel,expected_qty:exp,status:smStatus(row.stock,row.conso,row.threshold,row.daysLeft,dtu,exp,hasOrderConf)};
    }));
  },[smDeliveryMonth,smExpected]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Options mois pour le sélecteur (mois courant + 5 suivants)
  const smMonthOptions = useMemo(()=>{
    const opts=[];
    const now=new Date();
    for(let i=0;i<6;i++){
      const d=new Date(now.getFullYear(),now.getMonth()+i,1);
      const val=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
      const label=`15 ${d.toLocaleDateString("fr-FR",{month:"long",year:"numeric"})}`;
      opts.push({val,label});
    }
    return opts;
  },[]);

  // Export Excel stylé des lignes sélectionnées (ou toutes si rien sélectionné)
  const smExportExcel = () => {
    const toExport = smFiltered.filter(r => smSelected.size === 0 || smSelected.has(r.ref));
    const today = new Date().toLocaleDateString("fr-FR",{day:"2-digit",month:"long",year:"numeric"});

    // Couleurs par statut — appliquées sur chaque <td> individuellement pour compatibilité Excel
    const BG: Record<string,string> = {
      ok:        "#d1fae5",
      alert:     "#fef3c7",
      critical:  "#fee2e2",
      no_data:   "#f1f5f9",
      not_found: "#f1f5f9",
    };
    const FG: Record<string,string> = {
      ok:        "#065f46",
      alert:     "#92400e",
      critical:  "#991b1b",
      no_data:   "#64748b",
      not_found: "#64748b",
    };
    const LABEL: Record<string,string> = {
      ok:"✅ OK", alert:"⚠️ Alerte", critical:"🔴 Critique", no_data:"— Sans données", not_found:"Introuvable"
    };

    // Widths en pixels pour les colonnes (hint Excel)
    const colWidths = [90, 240, 60, 80, 70, 70, 90, 160, 90, 130];

    const BASE_TD  = "font-family:Arial,sans-serif;font-size:11px;padding:6px 10px;border:1px solid #d1d5db;vertical-align:middle;";
    const HEADER_TD = "font-family:Arial,sans-serif;font-size:11px;font-weight:700;color:#ffffff;background:#1e3a5f;padding:8px 10px;border:1px solid #1e3a5f;white-space:nowrap;vertical-align:middle;";

    const headers = ["Référence","Nom","Stock","Conso/mois","Attendu","Seuil min","Jours restants","Prochaine livraison","Statut","Date rupture fourn."];

    const colgroup = colWidths.map(w => `<col style="width:${w}px">`).join("");

    const headerRow = headers.map((h,i) =>
      `<td style="${HEADER_TD}width:${colWidths[i]}px;">${h}</td>`
    ).join("");

    const dataRows = toExport.map((r, idx) => {
      const bg  = BG[r.status]  || "#ffffff";
      const fg  = FG[r.status]  || "#111827";
      const alt = idx % 2 === 1 && !BG[r.status] ? "#f8fafc" : bg; // léger zébrage si pas de couleur statut
      const cellBg = BG[r.status] ? bg : (idx % 2 === 1 ? "#f8fafc" : "#ffffff");

      const cell = (val: string|number, extra="") =>
        `<td style="${BASE_TD}background:${cellBg};${extra}">${val ?? ""}</td>`;

      const daysLeft = r.daysLeft >= 999 ? "∞" : String(r.daysLeft);
      const daysColor = r.daysLeft <= 7 ? "color:#991b1b;font-weight:700;" :
                        r.daysLeft <= 30 ? "color:#92400e;font-weight:700;" : "";

      return `<tr>
        ${cell(r.ref,  "font-weight:700;font-size:12px;color:#1e3a5f;")}
        ${cell(r.name, "font-weight:600;")}
        ${cell(r.stock, "text-align:center;")}
        ${cell(r.conso, "text-align:center;")}
        ${cell(r.expected_qty || "", "text-align:center;")}
        ${cell(r.threshold, "text-align:center;")}
        ${cell(daysLeft, `text-align:center;${daysColor}`)}
        ${cell(r.delivLabel || "")}
        <td style="${BASE_TD}background:${bg};color:${fg};font-weight:700;text-align:center;">${LABEL[r.status] || r.status}</td>
        ${cell(r.supplierDate || "", "text-align:center;")}
      </tr>`;
    }).join("\n");

    // Ligne résumé comptages
    const nCritical = toExport.filter(r=>r.status==="critical").length;
    const nAlert    = toExport.filter(r=>r.status==="alert").length;
    const nOk       = toExport.filter(r=>r.status==="ok").length;
    const summaryRow = `<tr>
      <td colspan="10" style="${BASE_TD}background:#f8fafc;font-style:italic;color:#475569;font-size:10px;border-top:2px solid #94a3b8;">
        ${toExport.length} produits — 🔴 ${nCritical} critique(s) · ⚠️ ${nAlert} alerte(s) · ✅ ${nOk} OK
      </td>
    </tr>`;

    const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="UTF-8">
<!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet>
<x:Name>Suivi Stock</x:Name>
<x:WorksheetOptions><x:FreezePanes/><x:SplitHorizontal>2</x:SplitHorizontal><x:TopRowBottomPane>2</x:TopRowBottomPane></x:WorksheetOptions>
</x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->
<style>td,th{mso-number-format:"\@";}</style>
</head>
<body>
<table style="border-collapse:collapse;">
  <colgroup>${colgroup}</colgroup>
  <tr>
    <td colspan="10" style="background:#1e3a5f;color:#ffffff;font-family:Arial,sans-serif;font-size:15px;font-weight:700;padding:12px 16px;border:none;letter-spacing:0.5px;">
      📦 Suivi de Stock — Exporté le ${today}
    </td>
  </tr>
  <tr>${headerRow}</tr>
  ${dataRows}
  ${summaryRow}
</table>
</body></html>`;

    const blob = new Blob(["﻿" + html], { type: "application/vnd.ms-excel;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `suivi_stock_${new Date().toISOString().slice(0,10)}.xls`;
    a.click();
    URL.revokeObjectURL(url);
  };

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
  // Bloquer le render tant que localStorage n'a pas été lu (évite le flash FOUC)
  // DOIT être avant le garde !session, sinon l'écran de login flashe une frame.
  if (!mounted) return (
    <div className="wms-root" data-theme="light" style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", background: "var(--bg)" }}>
      <style>{GLOBAL_CSS}</style>
      <Spinner size={32} />
    </div>
  );

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
  return (
    <div className="wms-root" data-theme="light"><style>{GLOBAL_CSS}</style>

      {/* HEADER */}
      <header style={{ background: "#fff", borderBottom: "1px solid var(--border)", padding: "0 20px", display: "flex", alignItems: "center", justifyContent: "space-between", height: 56, position: "sticky", top: 0, zIndex: 20, boxShadow: "0 1px 0 var(--border)" }}>
        {/* Left: home + logo + badge */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <a href="/" title="Retour au scanner" style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 34, height: 34, borderRadius: 8, border: "1px solid var(--border)", color: "var(--text-muted)", textDecoration: "none", background: "var(--bg-raised)", flexShrink: 0, fontSize: 15 }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
          </a>
          <img src="/logo-dr-hauschka.png" alt="Dr. Hauschka" style={{ height: 26, objectFit: "contain" }} />
          <span style={{ fontSize: 10, fontWeight: 700, color: "var(--accent)", background: "var(--accent-soft)", padding: "2px 7px", borderRadius: 5, letterSpacing: ".04em" }}>WMS</span>
        </div>
        {/* Right: user + actions */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{ width: 7, height: 7, borderRadius: "50%", background: "#22c55e", boxShadow: "0 0 5px #22c55e" }} />
            <span style={{ fontSize: 12, color: "var(--text-secondary)", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{session.name}</span>
            <span style={{ fontSize: 11, color: "var(--text-muted)", display: "none" }}>·</span>
            <span style={{ fontSize: 11, color: "var(--text-muted)", maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{session.config?.url?.replace("https://", "")}</span>
          </div>
          <a href="/" title="Scanner" style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 34, height: 34, borderRadius: 8, border: "1px solid var(--border)", color: "var(--text-muted)", textDecoration: "none", background: "var(--bg-raised)", flexShrink: 0 }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
          </a>
          <button onClick={logout} title="Déconnexion" style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 34, height: 34, borderRadius: 8, border: "1px solid #fecaca", color: "#ef4444", background: "#fff5f5", cursor: "pointer", flexShrink: 0 }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
          </button>
        </div>
      </header>

      {/* TABS */}
      <nav style={{ background: "var(--bg-raised)", borderBottom: "1px solid var(--border)", padding: "0 28px", display: "flex", gap: 2, overflowX: "auto" }} className="wms-scrollbar">
        {TABS.map((t) => <button key={t.key} className="wms-tab" data-active={tab === t.key} onClick={() => setTab(t.key)}><span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>{t.icon} {t.label}</span></button>)}
      </nav>


      {/* CONTENT */}
      <main style={{ maxWidth: tab === "dlv" || tab === "stock-monitor" ? "100%" : 1260, margin: "0 auto", padding: "28px 28px 60px" }}>
        {supaError && <div style={{ background: "var(--warning-soft)", border: "1px solid var(--warning-border)", borderRadius: 12, padding: "10px 16px", fontSize: 13, color: "var(--warning)", marginBottom: 12 }}>⚠ {supaError} — mode dégradé localStorage</div>}
        {error && <div style={{ background: "var(--danger-soft)", border: "1px solid var(--danger-border)", borderRadius: 12, padding: "14px 18px", fontSize: 14, color: "var(--danger)", marginBottom: 24, display: "flex", alignItems: "center", gap: 10, animation: "fadeIn .3s ease both" }}>{I.alert}<span style={{ flex: 1 }}>{error}</span><button onClick={() => setError("")} style={{ background: "none", border: "none", color: "var(--danger)", cursor: "pointer", fontSize: 18, padding: 4 }}>×</button></div>}

        {/* ══════════ SUIVI STOCK ══════════ */}
        {tab === "stock-monitor" && (
          <div style={{animation:"fadeIn .3s ease both"}}>
            {/* Supplier date modal */}
            {smSupModal&&<div style={{position:"fixed",inset:0,background:"rgba(15,23,42,0.5)",backdropFilter:"blur(2px)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000,animation:"fadeIn .15s ease both"}}>
              <div style={{background:"#fff",borderRadius:12,padding:24,width:380,boxShadow:"0 20px 60px rgba(0,0,0,0.2)",border:"1px solid var(--border)"}}>
                <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:4}}>
                  <span style={{width:32,height:32,borderRadius:8,background:"var(--bg)",display:"inline-flex",alignItems:"center",justifyContent:"center",color:"var(--text-muted)"}}>{I.calendar}</span>
                  <div style={{fontSize:15,fontWeight:600,color:"#0f172a"}}>Rupture fournisseur</div>
                </div>
                <div style={{fontSize:12,color:"var(--text-muted)",marginBottom:18,marginLeft:42}}>{smSupModal.ref} — {smSupModal.name}</div>
                {smSupModal.cur==="9999-12-31"&&(
                  <div style={{background:"#fef2f2",border:"1px solid #fecaca",borderRadius:8,padding:"10px 12px",fontSize:12,color:"#dc2626",fontWeight:600,marginBottom:14,display:"flex",alignItems:"center",gap:8}}>{I.ban} Ce produit est actuellement en rupture définitive</div>
                )}
                <label style={{fontSize:12,fontWeight:600,display:"flex",flexDirection:"column",gap:6,color:"#0f172a"}}>
                  Date de prochaine dispo fournisseur
                  <input type="date" value={smSupInput==="9999-12-31"?"":smSupInput} onChange={e=>setSmSupInput(e.target.value)} style={{padding:"9px 12px",border:"1px solid var(--border)",borderRadius:8,fontSize:13,fontFamily:"inherit"}}/>
                </label>
                <div style={{fontSize:11,color:"var(--text-muted)",marginTop:8}}>Vide = livraison standard (15 du mois choisi)</div>
                <div style={{display:"flex",gap:8,marginTop:18}}>
                  <button onClick={()=>{setSmSupModal(null);setSmSupInput("");}} className="wms-btn" style={{flex:1}}>Annuler</button>
                  <button onClick={()=>smSaveSupDate()} className="wms-btn wms-btn-primary" style={{flex:2}}>Enregistrer</button>
                </div>
                <div style={{display:"flex",gap:8,marginTop:8}}>
                  <button onClick={()=>smSaveSupDate("9999-12-31")}
                    style={{flex:1,padding:"8px 0",background:"#0f172a",color:"#fff",border:"none",borderRadius:8,cursor:"pointer",fontSize:12,fontFamily:"inherit",fontWeight:600,display:"inline-flex",alignItems:"center",justifyContent:"center",gap:6}}>
                    {I.ban} Rupture définitive
                  </button>
                  {smSupModal.cur&&<button onClick={()=>smSaveSupDate(null)}
                    style={{flex:1,padding:"8px 0",background:"#fff",color:"var(--text-muted)",border:"1px solid var(--border)",borderRadius:8,cursor:"pointer",fontSize:12,fontFamily:"inherit",display:"inline-flex",alignItems:"center",justifyContent:"center",gap:6}}>
                    {I.close} Effacer
                  </button>}
                </div>
              </div>
            </div>}

            {/* Header */}
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:24,flexWrap:"wrap",gap:16}}>
              <div>
                <h2 style={{fontSize:20,fontWeight:700,letterSpacing:"-.2px",marginBottom:4,color:"#0f172a"}}>Suivi stock</h2>
                <p style={{fontSize:12.5,color:"var(--text-muted)",lineHeight:1.5}}>Stock temps réel · Conso moyenne 12 mois · Livraison standard le 15 du mois</p>
              </div>
              <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                <div style={{display:"flex",alignItems:"center",gap:6,padding:"6px 10px",border:"1px solid var(--border)",borderRadius:8,background:"#fff"}}>
                  <span style={{color:"var(--text-muted)",display:"inline-flex"}}>{I.package}</span>
                  <span style={{fontSize:12,color:"var(--text-muted)",whiteSpace:"nowrap"}}>Prochaine récep.</span>
                  <select value={smDeliveryMonth} onChange={e=>smSetDeliveryMonth(e.target.value)}
                    style={{padding:"3px 4px",border:"none",fontSize:13,fontFamily:"inherit",cursor:"pointer",outline:"none",background:"transparent",fontWeight:600,color:"#0f172a"}}>
                    {smMonthOptions.map(o=><option key={o.val} value={o.val}>{o.label}</option>)}
                  </select>
                </div>
                <button className="wms-btn" onClick={()=>smLoad(smDeliveryMonth)} disabled={smLoading} title="Refresh stock Odoo — utilise la conso en cache">{smLoading?<Spinner/>:I.refresh} Actualiser</button>
                <button className="wms-btn" onClick={()=>smLoad(smDeliveryMonth,true)} disabled={smLoading}
                  title={consoSyncedAt ? `Sync conso 12 mois (màj ${consoSyncedAt.toLocaleDateString("fr-FR")})` : "Sync conso 12 mois depuis Odoo"}>
                  {smLoading?<Spinner/>:I.rotate} Sync conso{consoSyncedAt&&<span style={{fontSize:10,opacity:.6,marginLeft:4,fontWeight:500}}>{consoSyncedAt.toLocaleDateString("fr-FR")}</span>}
                </button>
                <input ref={smFileRef} type="file" accept=".xlsx,.xls,.csv" onChange={smImportExcel} style={{display:"none"}}/>
                <button className="wms-btn wms-btn-primary" onClick={()=>smFileRef.current?.click()} disabled={smLoading}>{I.upload} Importer refs</button>
                <input ref={smOrderFileRef} type="file" accept=".xlsx,.xls,.csv" onChange={smImportOrder} style={{display:"none"}}/>
                <button className="wms-btn" onClick={()=>smOrderFileRef.current?.click()} disabled={smLoading} title="Order confirmation fournisseur → colonne Attendu">{I.package} Order conf.</button>
                {Object.keys(smExpected).length>0&&(
                  <button className="wms-btn" onClick={smClearOrderConf} title="Vider l'order confirmation" style={{color:"#dc2626"}}>{I.trash} Vider</button>
                )}
              </div>
            </div>

            {smMsg&&<div style={{display:"inline-flex",alignItems:"center",gap:6,fontSize:12.5,color:"var(--accent)",marginBottom:14,padding:"6px 12px",background:"var(--accent-soft)",borderRadius:6}}>{I.clock} {smMsg}</div>}

            {/* No refs */}
            {smRefs.length===0&&!smLoading&&(
              <div style={{background:"#fff",border:"1px solid var(--border)",borderRadius:12,padding:56,textAlign:"center"}}>
                <div style={{width:48,height:48,borderRadius:12,background:"var(--bg)",display:"inline-flex",alignItems:"center",justifyContent:"center",color:"var(--text-muted)",marginBottom:14}}>{I.inbox}</div>
                <div style={{fontSize:15,fontWeight:600,marginBottom:6,color:"#0f172a"}}>Aucune référence chargée</div>
                <p style={{fontSize:13,color:"var(--text-muted)",marginBottom:20}}>Importez votre fichier Excel avec les références à surveiller.</p>
                <p style={{fontSize:12,color:"var(--text-muted)",background:"var(--bg)",padding:"10px 14px",borderRadius:8,display:"inline-block",textAlign:"left",border:"1px solid var(--border)"}}>
                  <strong style={{color:"#0f172a"}}>Format :</strong> colonne "Ref" (ou "Code", "SKU"…) avec les références Odoo. Colonne "Nom" optionnelle.
                </p>
              </div>
            )}

            {smRefs.length>0&&(
              <>
                {/* KPIs — design épuré, fond blanc, indicateur point coloré */}
                <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:18}}>
                  {([
                    {label:"Références",val:smRefs.length,color:"#64748b",f:null},
                    {label:"Critiques",val:smCounts.critical,color:"#dc2626",f:"critical"},
                    {label:"Alertes",val:smCounts.alert,color:"#d97706",f:"alert"},
                    {label:"OK",val:smCounts.ok,color:"#16a34a",f:"ok"},
                  ] as any[]).map(({label,val,color,f})=>{
                    const active=smFilter===f;
                    return(
                      <div key={label} onClick={()=>f&&setSmFilter((p:any)=>p===f?"all":f)}
                        style={{background:"#fff",border:`1px solid ${active?color:"var(--border)"}`,borderRadius:10,padding:"12px 16px",cursor:f?"pointer":"default",transition:"border-color .15s, box-shadow .15s",boxShadow:active?`0 0 0 1px ${color}`:"none"}}>
                        <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:6}}>
                          <span style={{width:6,height:6,borderRadius:"50%",background:color,display:"inline-block"}}/>
                          <div style={{fontSize:11.5,fontWeight:500,color:"var(--text-muted)",letterSpacing:.1}}>{label}</div>
                        </div>
                        <div style={{fontSize:22,fontWeight:700,color:"#0f172a",lineHeight:1.1,fontVariantNumeric:"tabular-nums"}}>{val}</div>
                      </div>
                    );
                  })}
                </div>

                {/* Filters — segmented control + search clean */}
                <div style={{display:"flex",gap:8,marginBottom:12,alignItems:"center",flexWrap:"wrap"}}>
                  <div style={{display:"inline-flex",background:"var(--bg)",borderRadius:8,padding:3,border:"1px solid var(--border)"}}>
                    {(["all","critical","alert","ok"] as const).map(f=>(
                      <button key={f} onClick={()=>setSmFilter(f)}
                        style={{padding:"5px 14px",border:"none",background:smFilter===f?"#fff":"transparent",color:smFilter===f?"#0f172a":"var(--text-muted)",fontSize:12.5,fontWeight:smFilter===f?600:500,fontFamily:"inherit",borderRadius:6,cursor:"pointer",boxShadow:smFilter===f?"0 1px 2px rgba(0,0,0,.06)":"none",transition:"all .15s"}}>
                        {{all:"Tout",critical:"Critiques",alert:"Alertes",ok:"OK"}[f]}
                      </button>
                    ))}
                  </div>
                  <div style={{marginLeft:"auto",display:"inline-flex",alignItems:"center",gap:6,padding:"6px 10px",border:"1px solid var(--border)",borderRadius:8,background:"#fff",width:240}}>
                    <span style={{color:"var(--text-muted)",display:"inline-flex"}}>{I.search}</span>
                    <input placeholder="Référence ou nom" value={smSearch} onChange={e=>setSmSearch(e.target.value)}
                      style={{border:"none",fontSize:13,fontFamily:"inherit",outline:"none",flex:1,background:"transparent"}}/>
                  </div>
                  <span style={{fontSize:12,color:"var(--text-muted)",fontVariantNumeric:"tabular-nums"}}>{smFiltered.length} ligne{smFiltered.length!==1?"s":""}</span>
                  <button className="wms-btn" onClick={smExportExcel} style={{whiteSpace:"nowrap"}}>
                    {I.download} {smSelected.size>0?`Exporter ${smSelected.size}`:"Exporter tout"}
                  </button>
                  <button className="wms-btn" onClick={smResetThresholds} title="Remet tous les seuils à 1× conso/mois" style={{whiteSpace:"nowrap"}}>
                    {I.rotate} Seuils = conso
                  </button>
                </div>

                {/* Table */}
                <div style={{background:"#fff",border:"1px solid var(--border)",borderRadius:14,overflow:"hidden"}}>
                  <div style={{overflowX:"auto",maxHeight:"calc(100vh - 360px)",overflowY:"auto"}}>
                    <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
                      <thead style={{position:"sticky",top:0,zIndex:5}}>
                        <tr style={{background:"var(--bg)",borderBottom:"1px solid var(--border)"}}>
                          <th style={{padding:"10px 12px",width:36}}>
                            <input type="checkbox"
                              checked={smSelected.size===smFiltered.length&&smFiltered.length>0}
                              ref={el=>{if(el)el.indeterminate=smSelected.size>0&&smSelected.size<smFiltered.length;}}
                              onChange={e=>setSmSelected(e.target.checked?new Set(smFiltered.map(r=>r.ref)):new Set())}
                              style={{cursor:"pointer",width:15,height:15}}/>
                          </th>
                          {["Référence","Nom produit","Stock","Conso/mois","Attendu","Seuil min ✏","Jours restants","Prochaine livraison","Statut","Rupture"].map(h=>(
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
                              <td style={{padding:"10px 12px",width:36}}>
                                <input type="checkbox" checked={smSelected.has(row.ref)}
                                  onChange={e=>{const s=new Set(smSelected);e.target.checked?s.add(row.ref):s.delete(row.ref);setSmSelected(s);}}
                                  style={{cursor:"pointer",width:15,height:15}}/>
                              </td>
                              <td style={{padding:"10px 12px",fontWeight:700,fontFamily:"monospace",fontSize:12}}>{row.ref}</td>
                              <td style={{padding:"10px 12px",maxWidth:240,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{row.name}</td>
                              <td style={{padding:"10px 12px",textAlign:"right",fontWeight:600}}>{row.status==="not_found"?"—":row.stock}</td>
                              <td style={{padding:"10px 12px",textAlign:"right",color:"var(--text-muted)"}}>{row.status==="not_found"?"—":row.conso===0?<span style={{fontSize:11}}>n/a</span>:row.conso}</td>
                              <td style={{padding:"10px 12px",textAlign:"right"}}>
                                {row.expected_qty>0
                                  ? <span style={{fontWeight:700,color:"#8b5cf6"}}>+{row.expected_qty}</span>
                                  : <span style={{color:"#d1d5db",fontSize:11}}>—</span>}
                              </td>
                              <td style={{padding:"6px 12px",textAlign:"right"}}>
                                {row.status==="not_found"?"—":smEditThr?.ref===row.ref?(
                                  <input autoFocus type="number" value={smEditThr.val}
                                    onChange={e=>setSmEditThr(t=>t?{...t,val:e.target.value}:t)}
                                    onBlur={()=>smSaveThr(row.ref,smEditThr.val,row.name)}
                                    onKeyDown={e=>{if(e.key==="Enter")smSaveThr(row.ref,smEditThr.val,row.name);if(e.key==="Escape")setSmEditThr(null);}}
                                    style={{width:64,padding:"4px 8px",border:"1px solid var(--accent)",borderRadius:6,fontSize:13,fontFamily:"inherit",textAlign:"right",outline:"none"}}/>
                                ):(
                                  <div style={{display:"flex",alignItems:"center",gap:4,justifyContent:"flex-end"}}>
                                    {row.conso>0&&row.threshold>0&&(row.threshold<row.conso*0.5||row.threshold>row.conso*2)&&(
                                      <span title={`Conso = ${row.conso} — seuil semble incorrect`} style={{cursor:"default",color:"#d97706",display:"inline-flex"}}>{I.alertTri}</span>
                                    )}
                                    <button onClick={()=>setSmEditThr({ref:row.ref,val:String(row.threshold)})}
                                      style={{background:"transparent",border:"1px dashed var(--border)",borderRadius:6,padding:"3px 10px",cursor:"pointer",fontSize:13,fontFamily:"inherit",minWidth:44}}>
                                      {row.threshold}
                                    </button>
                                  </div>
                                )}
                              </td>
                              <td style={{padding:"10px 12px",textAlign:"right",fontWeight:700,color:sc[row.status]}}>
                                {row.status==="not_found"?"—":row.daysLeft>=999?"∞":`${row.daysLeft}j`}
                              </td>
                              <td style={{padding:"10px 12px",fontSize:12,color:row.supplierDate==="9999-12-31"?"#0f172a":row.supplierDate?"var(--danger)":"var(--text-muted)",fontWeight:row.supplierDate?600:400}}>
                                {row.supplierDate==="9999-12-31"
                                  ? <span style={{display:"inline-flex",alignItems:"center",gap:5}}>{I.ban} Rupture déf.</span>
                                  : row.supplierDate
                                    ? <span style={{display:"inline-flex",alignItems:"center",gap:5}}>{I.alertTri} {row.delivLabel} ({row.daysUntilDeliv}j)</span>
                                    : row.status!=="not_found" ? `${row.delivLabel} (${row.daysUntilDeliv}j)` : "—"}
                              </td>
                              <td style={{padding:"10px 12px"}}>
                                <span style={{display:"inline-flex",alignItems:"center",gap:6,padding:"3px 9px 3px 8px",borderRadius:6,background:`${sc[row.status]}10`,color:sc[row.status],fontSize:11.5,fontWeight:600,border:`1px solid ${sc[row.status]}33`}}>
                                  <span style={{width:5,height:5,borderRadius:"50%",background:sc[row.status],display:"inline-block"}}/>
                                  {{ok:"OK",alert:"Alerte",critical:"Critique",no_data:"Pas de données",not_found:"Introuvable"}[row.status]}
                                </span>
                              </td>
                              <td style={{padding:"8px 12px"}}>
                                {row.status!=="not_found"&&(
                                  <button onClick={()=>{setSmSupModal({ref:row.ref,name:row.name,cur:row.supplierDate||""});setSmSupInput(row.supplierDate||"");}}
                                    title={row.supplierDate?"Modifier la rupture fournisseur":"Déclarer une rupture fournisseur"}
                                    style={{display:"inline-flex",alignItems:"center",gap:5,padding:"4px 9px",border:`1px solid ${row.supplierDate?"#fecaca":"var(--border)"}`,borderRadius:6,background:row.supplierDate?"#fef2f2":"#fff",color:row.supplierDate?"#dc2626":"var(--text-muted)",cursor:"pointer",fontSize:11.5,fontFamily:"inherit",fontWeight:500}}>
                                    {I.calendar}{row.supplierDate?"Modifier":"Rupture"}
                                  </button>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                        {smFiltered.length===0&&<tr><td colSpan={11} style={{padding:40,textAlign:"center",color:"var(--text-muted)"}}>
                          {smLoading?"Chargement...":"Aucun résultat"}
                        </td></tr>}
                      </tbody>
                    </table>
                  </div>
                </div>
                <div style={{display:"flex",gap:18,marginTop:12,fontSize:11.5,color:"var(--text-muted)",flexWrap:"wrap",alignItems:"center"}}>
                  <span style={{display:"inline-flex",alignItems:"center",gap:6}}><span style={{width:6,height:6,borderRadius:"50%",background:"#dc2626"}}/><strong style={{color:"#0f172a",fontWeight:600}}>Critique</strong> : rupture avant la livraison</span>
                  <span style={{display:"inline-flex",alignItems:"center",gap:6}}><span style={{width:6,height:6,borderRadius:"50%",background:"#d97706"}}/><strong style={{color:"#0f172a",fontWeight:600}}>Alerte</strong> : moins de 14j de marge ou sous le seuil</span>
                  <span style={{display:"inline-flex",alignItems:"center",gap:6}}><span style={{width:6,height:6,borderRadius:"50%",background:"#16a34a"}}/><strong style={{color:"#0f172a",fontWeight:600}}>OK</strong> : stock suffisant</span>
                  <span style={{marginLeft:"auto",opacity:.7}}>Seuils cliquables · Livraison standard = 15 du mois</span>
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

        {/* ══════════════════ CATALOGUE ══════════════════ */}
        {tab === "catalogue" && (
          <div style={{ animation: "fadeIn .3s ease both", padding: "0 24px 24px" }}>

            {/* Barre recherche + boutons */}
            <div style={{ display:"flex", gap:12, alignItems:"center", marginBottom:16, flexWrap:"wrap" }}>
              <div style={{ position:"relative", flex:1, minWidth:260 }}>
                <span style={{ position:"absolute", left:12, top:"50%", transform:"translateY(-50%)", color:"var(--text-muted)", pointerEvents:"none" }}>
                  {I.search}
                </span>
                <input
                  className="wms-input"
                  style={{ paddingLeft:36, fontSize:15 }}
                  placeholder="Rechercher un article… (nom, référence, EAN)"
                  value={catQuery}
                  onChange={e => { setCatQuery(e.target.value); catTrigger(e.target.value, catCols); }}
                  autoFocus
                />
              </div>

              {/* Colonnes toggle */}
              <div style={{ position:"relative" }}>
                <button className="wms-btn wms-btn-ghost" onClick={()=>setCatColsOpen(v=>!v)} style={{ gap:6 }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
                  Colonnes <span style={{ background:"var(--accent)", color:"#fff", borderRadius:10, padding:"1px 7px", fontSize:11 }}>{catCols.size}</span>
                </button>
                {catColsOpen && (
                  <div style={{ position:"absolute", top:"calc(100% + 6px)", right:0, zIndex:50, background:"var(--bg-raised)", border:"1px solid var(--border)", borderRadius:12, boxShadow:"var(--shadow-popup)", padding:16, minWidth:320, animation:"dropIn .15s ease both" }}>
                    {(["Identité","Caractéristiques","Stock","Achat","Vente"] as const).map(grp => (
                      <div key={grp} style={{ marginBottom:12 }}>
                        <div style={{ fontSize:10, fontWeight:700, color:"var(--text-muted)", textTransform:"uppercase", letterSpacing:".5px", marginBottom:6 }}>{grp}</div>
                        <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
                          {CAT_COL_DEFS.filter(c=>c.group===grp).map(c=>(
                            <label key={c.key} style={{ display:"inline-flex", alignItems:"center", gap:5, padding:"4px 10px", borderRadius:6, background: catCols.has(c.key)?"var(--accent-soft)":"var(--bg-surface)", border:`1px solid ${catCols.has(c.key)?"var(--accent-border)":"var(--border)"}`, cursor:"pointer", fontSize:12, color: catCols.has(c.key)?"var(--accent)":"var(--text-secondary)", transition:"all .15s" }}>
                              <input type="checkbox" checked={catCols.has(c.key)} onChange={()=>catToggleCol(c.key)} style={{ accentColor:"var(--accent)", width:12, height:12 }}/>
                              {c.label}
                            </label>
                          ))}
                        </div>
                      </div>
                    ))}
                    <div style={{ display:"flex", gap:8, paddingTop:8, borderTop:"1px solid var(--border)", marginTop:4 }}>
                      <button className="wms-btn wms-btn-ghost" style={{ fontSize:12, padding:"6px 12px" }} onClick={()=>{ setCatCols(new Set(CAT_DEFAULT_COLS)); catTrigger(catQuery, new Set(CAT_DEFAULT_COLS)); }}>Réinitialiser</button>
                      <button className="wms-btn wms-btn-primary" style={{ fontSize:12, padding:"6px 12px", flex:1 }} onClick={()=>setCatColsOpen(false)}>Fermer</button>
                    </div>
                  </div>
                )}
              </div>

              <button className="wms-btn wms-btn-ghost" onClick={catExportXlsx} disabled={!catRows.length} title={catSelected.size>0?`Exporter ${catSelected.size} ligne(s) sélectionnée(s)`:"Exporter tous les résultats"}>
                {I.download} Excel{catSelected.size>0?` (${catSelected.size})`:""}
              </button>
              {catSelected.size>0&&<button className="wms-btn wms-btn-ghost" style={{fontSize:12,padding:"6px 10px",color:"var(--text-muted)"}} onClick={()=>setCatSelected(new Set())}>✕ Déselect.</button>}
            </div>

            {/* Message statut */}
            {catMsg && (
              <div style={{ fontSize:12, color: catLoading?"var(--text-muted)":"var(--success)", marginBottom:12, display:"flex", alignItems:"center", gap:8 }}>
                {catLoading && <span style={{ width:12, height:12, border:"2px solid var(--border)", borderTopColor:"var(--accent)", borderRadius:"50%", display:"inline-block", animation:"spin .7s linear infinite" }}/>}
                {catMsg}
              </div>
            )}

            {/* Tableau résultats */}
            {catRows.length > 0 && (
              <div className="wms-card" style={{ overflow:"auto" }}>
                <table className="wms-table" style={{ minWidth: 600 }}>
                  <thead>
                    <tr>
                      <th style={{width:32,padding:"0 8px"}}><input type="checkbox" style={{accentColor:"var(--accent)"}} checked={catRows.length>0&&catSelected.size===catRows.length} onChange={e=>{if(e.target.checked)setCatSelected(new Set(catRows.map(r=>r._id)));else setCatSelected(new Set());}}/></th>
                      <th><div className="th-inner" style={{ minWidth:180 }}>Nom produit</div></th>
                      {CAT_COL_DEFS.filter(c=>catCols.has(c.key)).map(c=>(
                        <th key={c.key}><div className="th-inner" style={{ minWidth:c.w }}>{c.label}</div></th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {catRows.map((row,i)=>{
                      const mkEditCell = (field: string, value: string, style?: React.CSSProperties) => {
                        const editKey = `${row._id}:${field}`;
                        const isEditing = catEdit?.rowId === row._id && catEdit?.field === field;
                        const isSavingThis = catSaving === editKey;
                        if (isEditing) {
                          return (
                            <input
                              autoFocus
                              defaultValue={catEdit!.value}
                              style={{ width:"100%", minWidth:80, border:"1.5px solid var(--accent)", borderRadius:6, padding:"2px 6px", fontSize:13, background:"var(--bg-surface)", color:"var(--text-primary)", outline:"none", ...style }}
                              onBlur={e => catSaveField(row, field, e.target.value)}
                              onKeyDown={e => {
                                if (e.key==="Enter") catSaveField(row, field, (e.target as HTMLInputElement).value);
                                if (e.key==="Escape") setCatEdit(null);
                              }}
                            />
                          );
                        }
                        return (
                          <span
                            onClick={() => setCatEdit({ rowId: row._id, field, value: String(value??"") })}
                            title="Cliquer pour modifier"
                            style={{ cursor:"pointer", display:"inline-flex", alignItems:"center", gap:4, borderRadius:4, padding:"1px 4px", transition:"background .15s", ...style }}
                            onMouseEnter={e=>(e.currentTarget.style.background="var(--accent-soft)")}
                            onMouseLeave={e=>(e.currentTarget.style.background="transparent")}
                          >
                            {isSavingThis ? <span style={{opacity:.5}}>…</span> : (value||"—")}
                            {!isSavingThis && <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2.5" style={{flexShrink:0,opacity:.5}}><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>}
                          </span>
                        );
                      };
                      return (
                      <tr key={row._id ?? i} style={{background:catSelected.has(row._id)?"var(--accent-soft)":""}}>
                        <td style={{width:32,padding:"0 8px"}}><input type="checkbox" style={{accentColor:"var(--accent)"}} checked={catSelected.has(row._id)} onChange={e=>{setCatSelected(prev=>{const n=new Set(prev);e.target.checked?n.add(row._id):n.delete(row._id);return n;})}}/></td>
                        <td style={{ fontWeight:600, color:"var(--text-primary)", fontSize:13 }}>
                          {mkEditCell("name", row.name)}
                        </td>
                        {CAT_COL_DEFS.filter(c=>catCols.has(c.key)).map(c=>{
                          const v = row[c.key];
                          // Champs éditables inline
                          if (c.key==="weight") {
                            return <td key={c.key}>{mkEditCell("weight", v!==""&&v!==undefined?String(v):"", {fontFamily:"'JetBrains Mono',monospace",fontSize:12})}</td>;
                          }
                          if (c.key==="barcode") {
                            return <td key={c.key}>{mkEditCell("barcode", v||"", {fontSize:12})}</td>;
                          }
                          // Mise en forme contextuelle
                          if (c.key==="qty_available"||c.key==="qty_virtual") {
                            const n = Number(v);
                            const col = n<=0?"var(--danger)":n<5?"var(--warning)":"var(--success)";
                            return <td key={c.key} style={{ color:col, fontWeight:600 }}>{n}</td>;
                          }
                          if (c.key==="tracking") {
                            const bg = v==="Lot"?"rgba(217,119,6,.1)":v==="Série"?"rgba(124,58,237,.1)":"var(--bg-surface)";
                            const color = v==="Lot"?"var(--warning)":v==="Série"?"var(--purple)":"var(--text-muted)";
                            return <td key={c.key}><span className="wms-badge" style={{ background:bg, color }}>{v||"—"}</span></td>;
                          }
                          if (c.key==="dluo") {
                            const parts = String(v||"").split(" | ");
                            return <td key={c.key} style={{ fontSize:11 }}>
                              {parts.map((p,pi)=>{
                                const dateStr = p.match(/\d{2}\/\d{2}\/\d{4}/)?.[0];
                                const isExpired = dateStr ? new Date(dateStr.split("/").reverse().join("-")) < new Date() : false;
                                const isSoon = dateStr ? (new Date(dateStr.split("/").reverse().join("-")).getTime()-Date.now()) < 30*86400000 : false;
                                const c2 = isExpired?"var(--danger)":isSoon?"var(--warning)":"var(--text-secondary)";
                                return <span key={pi} style={{ color:c2, display:"block" }}>{p}</span>;
                              })}
                            </td>;
                          }
                          if ((c.key==="sup_price"||c.key==="list_price"||c.key==="standard_price") && v!=="") {
                            return <td key={c.key} style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:12 }}>{Number(v).toFixed(2)} €</td>;
                          }
                          if (c.key==="locations") {
                            const s = v===""||v===undefined?"—":String(v);
                            return <td key={c.key} style={{ fontSize:11, maxWidth:240, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }} title={s}>{s}</td>;
                          }
                          return <td key={c.key} style={{ fontSize:12 }}>{v===""||v===undefined?"—":String(v)}</td>;
                        })}
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* Etat vide */}
            {!catLoading && catQuery.trim().length >= 2 && catRows.length===0 && catMsg && !catMsg.startsWith("Erreur") && (
              <div style={{ textAlign:"center", padding:"60px 0", color:"var(--text-muted)" }}>
                <div style={{ fontSize:32, marginBottom:8 }}>🔍</div>
                <div style={{ fontWeight:600 }}>Aucun produit trouvé pour « {catQuery} »</div>
              </div>
            )}
            {!catLoading && catQuery.trim().length < 2 && (
              <div style={{ textAlign:"center", padding:"80px 0", color:"var(--text-muted)" }}>
                <div style={{ fontSize:40, marginBottom:12 }}>🔎</div>
                <div style={{ fontWeight:600, fontSize:16, marginBottom:6 }}>Recherche dans le catalogue Odoo</div>
                <div style={{ fontSize:13 }}>Tapez au moins 2 caractères — nom, référence, EAN…</div>
                <div style={{ fontSize:12, marginTop:8, color:"var(--text-muted)" }}>Cochez les colonnes à afficher, puis exportez en Excel</div>
              </div>
            )}
          </div>
        )}

        {tab === "libre" && (
          <div style={{ animation: "fadeIn .3s ease both", maxWidth: 860, margin: "0 auto" }}>
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

        {/* ══════════════════ SUIVI DLV ══════════════════ */}
        {tab === "dlv" && (() => {
          const fmtDate = (d: Date) => d.toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
          const fmtDays = (n: number) => n <= 0 ? "Dépassé" : n < 30 ? `${n}j` : n < 365 ? `${Math.round(n / 30)}mois` : `${(n / 365).toFixed(1)}ans`;
          // Palette epuree — couleurs plus sourdes, badges avec point colore (pas d'emojis)
          const STATUS_CFG: Record<DlvRow["status"], { label: string; color: string }> = {
            overdue:  { label: "Hors delai",  color: "#7c2d12" },
            critical: { label: "Critique",    color: "#dc2626" },
            risk:     { label: "Risque",      color: "#c2410c" },
            watch:    { label: "Attention",   color: "#b45309" },
            ok:       { label: "OK",          color: "#16a34a" },
            unknown:  { label: "Sans conso",  color: "#64748b" },
          };
          const statusBadge = (s: DlvRow["status"]) => {
            const cfg = STATUS_CFG[s];
            return (
              <span style={{display:"inline-flex",alignItems:"center",gap:6,padding:"3px 9px 3px 8px",borderRadius:6,background:`${cfg.color}10`,color:cfg.color,fontSize:11.5,fontWeight:600,border:`1px solid ${cfg.color}33`,whiteSpace:"nowrap"}}>
                <span style={{width:5,height:5,borderRadius:"50%",background:cfg.color,display:"inline-block"}}/>
                {cfg.label}
              </span>
            );
          };
          const search = dlvSearch.trim().toLowerCase();
          const filtered = dlvRows.filter(r => {
            const matchSearch = !search || r.ref.toLowerCase().includes(search) || r.name.toLowerCase().includes(search) || r.lotName.toLowerCase().includes(search);
            const matchFilter =
              dlvFilter === "all" ||
              (dlvFilter === "alert" && ["overdue","critical","risk","watch"].includes(r.status)) ||
              (dlvFilter === "ok" && ["ok","unknown"].includes(r.status)) ||
              (dlvFilter === "ok-only" && r.status === "ok") ||
              r.status === dlvFilter;
            return matchSearch && matchFilter;
          });
          const counts = { overdue: 0, critical: 0, risk: 0, watch: 0, ok: 0, unknown: 0 };
          for (const r of dlvRows) counts[r.status]++;
          const nbAlert = counts.overdue + counts.critical + counts.risk + counts.watch;

          return (
            <div style={{ animation: "fadeIn .3s ease both" }}>
              {/* Header */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24, flexWrap: "wrap", gap: 16 }}>
                <div>
                  <h2 style={{ fontSize: 20, fontWeight: 700, letterSpacing: "-.2px", marginBottom: 4, color: "#0f172a" }}>Suivi DLV</h2>
                  <p style={{ fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.5 }}>Regle standard : DLV &minus; 12 mois · Souplesse (echantillons / miniatures / testeurs) : DLV &minus; 4 mois · Min. {DLV_MIN_MONTHS} mois d&apos;historique requis</p>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
                  <button className="wms-btn" onClick={syncDlvConsoFromOdoo} disabled={dlvConsoImporting}
                    title={dlvAvgSyncedAt ? `Sync conso 12 mois (maj ${dlvAvgSyncedAt.toLocaleDateString("fr-FR")})` : "Sync conso 12 mois depuis Odoo"}>
                    {dlvConsoImporting ? <Spinner /> : I.rotate} Sync conso{dlvAvgSyncedAt && <span style={{ fontSize: 10, opacity: .6, marginLeft: 4, fontWeight: 500 }}>{dlvAvgSyncedAt.toLocaleDateString("fr-FR")}</span>}
                  </button>
                  <button className="wms-btn wms-btn-primary" onClick={loadDlv} disabled={dlvLoading}>
                    {dlvLoading ? <Spinner /> : I.refresh} Charger les lots
                  </button>
                </div>
              </div>

              {/* KPI cards — design epure, fond blanc, point colore */}
              {dlvRows.length > 0 && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 10, marginBottom: 18 }}>
                  {(["overdue","critical","risk","watch","ok","unknown"] as DlvRow["status"][]).map(s => {
                    const active = dlvFilter === s || (s === "ok" && dlvFilter === "ok-only");
                    const color = STATUS_CFG[s].color;
                    const isEmpty = counts[s] === 0;
                    return (
                      <div key={s} onClick={() => !isEmpty && setDlvFilter(active ? "all" : s as any)}
                        style={{ background: "#fff", border: `1px solid ${active ? color : "var(--border)"}`, borderRadius: 10, padding: "12px 16px", cursor: isEmpty ? "default" : "pointer", opacity: isEmpty ? .5 : 1, transition: "border-color .15s, box-shadow .15s", boxShadow: active ? `0 0 0 1px ${color}` : "none" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                          <span style={{ width: 6, height: 6, borderRadius: "50%", background: color, display: "inline-block" }} />
                          <div style={{ fontSize: 11.5, fontWeight: 500, color: "var(--text-muted)" }}>{STATUS_CFG[s].label}</div>
                        </div>
                        <div style={{ fontSize: 22, fontWeight: 700, color: "#0f172a", lineHeight: 1.1, fontVariantNumeric: "tabular-nums" }}>{counts[s]}</div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Filtres + recherche — segmented control + search clean */}
              {dlvRows.length > 0 && (
                <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
                  <div style={{ display: "inline-flex", background: "var(--bg)", borderRadius: 8, padding: 3, border: "1px solid var(--border)" }}>
                    {(["all","alert","ok"] as const).map(f => {
                      const active = dlvFilter === f || (f === "ok" && dlvFilter === "ok-only");
                      return (
                        <button key={f} onClick={() => setDlvFilter(f)}
                          style={{ padding: "5px 14px", border: "none", background: active ? "#fff" : "transparent", color: active ? "#0f172a" : "var(--text-muted)", fontSize: 12.5, fontWeight: active ? 600 : 500, fontFamily: "inherit", borderRadius: 6, cursor: "pointer", boxShadow: active ? "0 1px 2px rgba(0,0,0,.06)" : "none", transition: "all .15s" }}>
                          {f === "all" ? `Tous (${dlvRows.length})` : f === "alert" ? `Alertes (${nbAlert})` : `OK (${counts.ok + counts.unknown})`}
                        </button>
                      );
                    })}
                  </div>
                  <div style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 10px", border: "1px solid var(--border)", borderRadius: 8, background: "#fff", width: 260 }}>
                    <span style={{ color: "var(--text-muted)", display: "inline-flex" }}>{I.search}</span>
                    <input value={dlvSearch} onChange={e => setDlvSearch(e.target.value)} placeholder="Reference, nom ou lot"
                      style={{ border: "none", fontSize: 13, fontFamily: "inherit", outline: "none", flex: 1, background: "transparent" }} />
                  </div>
                  <span style={{ fontSize: 12, color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>{filtered.length} lot{filtered.length !== 1 ? "s" : ""}</span>
                  <button onClick={() => exportDlvExcel(filtered)} className="wms-btn" style={{ marginLeft: "auto" }}>
                    {I.download} Export Excel
                  </button>
                </div>
              )}

              {/* Empty state */}
              {dlvRows.length === 0 && !dlvLoading && (
                <div style={{ background: "#fff", border: "1px solid var(--border)", borderRadius: 12, padding: 56, textAlign: "center" }}>
                  <div style={{ width: 48, height: 48, borderRadius: 12, background: "var(--bg)", display: "inline-flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", marginBottom: 14 }}>{I.calendar}</div>
                  <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6, color: "#0f172a" }}>Aucune donnee chargee</div>
                  <div style={{ fontSize: 13, color: "var(--text-muted)" }}>Cliquez sur «&nbsp;Charger les lots&nbsp;» pour recuperer les DLV depuis Odoo.</div>
                  {Object.keys(dlvAvgMonthlyByRef).length === 0 && (
                    <div style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "#b45309", marginTop: 14, padding: "6px 12px", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 6 }}>
                      {I.alertTri} Cliquez d&apos;abord sur «&nbsp;Sync conso&nbsp;» pour charger les consommations depuis Odoo.
                    </div>
                  )}
                </div>
              )}

              {/* Table — pleine largeur */}
              {filtered.length > 0 && (() => {
                const COLS: { key: string; label: string; align: "left"|"right"|"center" }[] = [
                  { key: "Statut",     label: "Statut",      align: "left"   },
                  { key: "Ref",        label: "Ref",         align: "left"   },
                  { key: "Produit",    label: "Produit",     align: "left"   },
                  { key: "Lot",        label: "Lot",         align: "left"   },
                  { key: "DLV",        label: "DLV",         align: "left"   },
                  { key: "Sell-by",    label: "Sell-by",     align: "left"   },
                  { key: "J. restants",label: "J. restants", align: "center" },
                  { key: "Qté stock",  label: "Qté stock",   align: "right"  },
                  { key: "Stock dispo",  label: "Stock dispo",   align: "right"  },
                  { key: "Conso/mois", label: "Conso/mois",  align: "right"  },
                  { key: "Vendable",   label: "Vendable",    align: "right"  },
                  { key: "À risque",   label: "À risque",    align: "right"  },
                ];
                const startResize = (col: string, e: React.MouseEvent) => {
                  e.preventDefault();
                  dlvResizingRef.current = { col, startX: e.clientX, startW: dlvColWidths[col] || 100 };
                  const onMove = (ev: MouseEvent) => {
                    if (!dlvResizingRef.current) return;
                    const newW = Math.max(50, dlvResizingRef.current.startW + ev.clientX - dlvResizingRef.current.startX);
                    setDlvColWidths(prev => ({ ...prev, [dlvResizingRef.current!.col]: newW }));
                  };
                  const onUp = () => { dlvResizingRef.current = null; document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
                  document.addEventListener("mousemove", onMove);
                  document.addEventListener("mouseup", onUp);
                };
                return (
                  <div className="wms-card" style={{ padding: 0, overflow: "hidden" }}>
                    <div style={{ overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 360px)" }}>
                      <table style={{ borderSpacing: 0, borderCollapse: "separate", fontSize: 13, tableLayout: "fixed", width: `max(100%, ${COLS.reduce((s, c) => s + (dlvColWidths[c.key] || 100), 0)}px)` }}>
                        <colgroup>{COLS.map(c => <col key={c.key} style={{ width: dlvColWidths[c.key] || 100 }} />)}</colgroup>
                        <thead>
                          <tr>
                            {COLS.map(c => (
                              <th key={c.key} style={{ padding: "10px 14px", textAlign: c.align, fontSize: 11, fontWeight: 700, color: "var(--text-muted)", whiteSpace: "nowrap", position: "sticky", top: 0, zIndex: 2, background: "var(--bg-raised)", userSelect: "none", overflow: "hidden", boxShadow: "0 2px 0 var(--border)" }}>
                                {c.label}
                                <div onMouseDown={e => startResize(c.key, e)} style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 5, cursor: "col-resize", background: "transparent" }} onMouseEnter={e => (e.currentTarget.style.background = "var(--border)")} onMouseLeave={e => (e.currentTarget.style.background = "transparent")} />
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {filtered.map((r, i) => {
                            const cfg = STATUS_CFG[r.status];
                            const rowBg = (r.status === "overdue" || r.status === "critical") ? "#fffbfb" : r.status === "risk" ? "#fffdf8" : undefined;
                            return (
                              <tr key={`${r.productId}_${r.lotId}`} style={{ borderBottom: "1px solid var(--border)", background: i % 2 === 0 ? (rowBg || "var(--bg-surface)") : (rowBg || "var(--bg-raised)") }}>
                                <td style={{ padding: "10px 14px", overflow: "hidden" }}>
                                  <div style={{ display: "flex", flexDirection: "column", gap: 3, alignItems: "flex-start" }}>
                                    {statusBadge(r.status)}
                                    {r.marginMonths < DLV_SELL_MARGIN_MONTHS && (
                                      <span style={{ background: "#f5f3ff", color: "#6d28d9", border: "1px solid #ddd6fe", borderRadius: 5, padding: "1px 6px", fontSize: 10, fontWeight: 500, whiteSpace: "nowrap" }}>souple {r.marginMonths}m</span>
                                    )}
                                  </div>
                                </td>
                                <td style={{ padding: "10px 14px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                  <button onClick={async () => {
                                    setDlvDetailProduct({ productId: r.productId, ref: r.ref, name: r.name });
                                    setDlvDetailData([]);
                                    setDlvDetailLoading(true);
                                    try {
                                      const detail = await odoo.getProductStockDetail(session!, r.productId);
                                      setDlvDetailData(detail);
                                    } catch (e: any) { setError(e.message); }
                                    setDlvDetailLoading(false);
                                  }} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontWeight: 700, color: "var(--accent)", fontFamily: "inherit", fontSize: "inherit", textDecoration: "underline", textDecorationStyle: "dotted", textUnderlineOffset: 3 }}>
                                    {r.ref || "—"}
                                  </button>
                                </td>
                                <td style={{ padding: "10px 14px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.name}>{r.name}</td>
                                <td style={{ padding: "10px 14px", fontFamily: "monospace", fontSize: 12, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.lotName}</td>
                                <td style={{ padding: "10px 14px", whiteSpace: "nowrap", fontWeight: 600, overflow: "hidden" }}>{fmtDate(new Date(r.dlvDate.split(" ")[0] + "T00:00:00"))}</td>
                                <td style={{ padding: "10px 14px", whiteSpace: "nowrap", overflow: "hidden", color: r.daysToSellBy <= 0 ? "#dc2626" : r.daysToSellBy < 90 ? "#c2410c" : "var(--text-primary)", fontWeight: 600 }}>{fmtDate(r.sellByDate)}</td>
                                <td style={{ padding: "10px 14px", whiteSpace: "nowrap", textAlign: "center", fontWeight: 700, overflow: "hidden", color: r.daysToSellBy <= 0 ? "#dc2626" : r.daysToSellBy < 30 ? "#dc2626" : r.daysToSellBy < 90 ? "#c2410c" : "var(--text-primary)" }}>{fmtDays(r.daysToSellBy)}</td>
                                <td style={{ padding: "10px 14px", textAlign: "right", fontWeight: 600, overflow: "hidden" }}>{Math.round(r.qty)}</td>
                                <td style={{ padding: "10px 14px", textAlign: "right", fontWeight: 600, overflow: "hidden" }}>{Math.round(r.qtyDispo)}</td>
                                <td style={{ padding: "10px 14px", textAlign: "right", overflow: "hidden" }}>
                                  {r.avgMonthly === 0 ? <span style={{ color: "var(--text-muted)" }}>—</span> : (
                                    <div>
                                      <span style={{ color: "var(--text-primary)", fontVariantNumeric: "tabular-nums" }}>{r.avgMonthly}</span>
                                      {r.nbMonths > 0 && r.nbMonths < DLV_MIN_MONTHS && (
                                        <div style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 10, color: "#d97706", marginTop: 1, justifyContent: "flex-end", width: "100%" }}>{I.alertTri}{r.nbMonths} mois seul.</div>
                                      )}
                                      {r.nbMonths >= DLV_MIN_MONTHS && (
                                        <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 1 }}>{r.nbMonths} mois</div>
                                      )}
                                    </div>
                                  )}
                                </td>
                                <td style={{ padding: "10px 14px", textAlign: "right", overflow: "hidden", color: "var(--text-muted)" }}>{r.avgMonthly === 0 ? "?" : r.unitsSellable}</td>
                                <td style={{ padding: "10px 14px", textAlign: "right", fontWeight: 600, overflow: "hidden", color: r.unitsAtRisk > 0 ? "#dc2626" : r.status === "unknown" ? "var(--text-muted)" : "#16a34a" }}>
                                  {r.status === "unknown"
                                    ? <span style={{ fontWeight: 500 }}>—</span>
                                    : r.unitsAtRisk > 0
                                      ? <span style={{ display: "inline-flex", alignItems: "center", gap: 4, justifyContent: "flex-end", fontVariantNumeric: "tabular-nums" }}>{I.alertTri}{Math.round(r.unitsAtRisk)}</span>
                                      : <span style={{ fontVariantNumeric: "tabular-nums" }}>0</span>}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <div style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-muted)", borderTop: "1px solid var(--border)" }}>
                      {filtered.length} lot{filtered.length > 1 ? "s" : ""} affiché{filtered.length > 1 ? "s" : ""} · Glisser le bord des colonnes pour redimensionner · Vendable = mois restants × conso/mois
                    </div>
                  </div>
                );
              })()}

              {filtered.length === 0 && dlvRows.length > 0 && (
                <div style={{ textAlign: "center", padding: "40px 20px", color: "var(--text-muted)", fontSize: 14 }}>Aucun lot ne correspond au filtre.</div>
              )}

              {/* ── Popup détail produit ── */}
              {dlvDetailProduct && (
                <div onClick={() => setDlvDetailProduct(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
                  <div onClick={e => e.stopPropagation()} style={{ background: "var(--bg-surface)", borderRadius: 16, boxShadow: "0 24px 64px rgba(0,0,0,.25)", width: "100%", maxWidth: 680, maxHeight: "85vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
                    {/* Header popup */}
                    <div style={{ padding: "20px 24px 16px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "flex-start", gap: 12 }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--accent)", letterSpacing: ".05em", textTransform: "uppercase", marginBottom: 4 }}>{dlvDetailProduct.ref}</div>
                        <div style={{ fontSize: 17, fontWeight: 800, color: "var(--text-primary)", lineHeight: 1.3 }}>{dlvDetailProduct.name}</div>
                      </div>
                      <button onClick={() => setDlvDetailProduct(null)} style={{ background: "var(--bg-raised)", border: "none", borderRadius: 8, width: 32, height: 32, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", flexShrink: 0 }}>{I.close}</button>
                    </div>

                    {/* Lots DLV pour ce produit (depuis les données déjà chargées) */}
                    {(() => {
                      const productLots = dlvRows.filter(r => r.productId === dlvDetailProduct.productId);
                      if (!productLots.length) return null;
                      return (
                        <div style={{ padding: "16px 24px 0" }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 10 }}>Lots &amp; DLV</div>
                          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 16 }}>
                            {productLots.map(lot => {
                              return (
                                <div key={lot.lotId} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderRadius: 8, background: "var(--bg-raised)", border: "1px solid var(--border)" }}>
                                  {statusBadge(lot.status)}
                                  <span style={{ fontFamily: "monospace", fontSize: 12, color: "var(--text-muted)", minWidth: 100 }}>{lot.lotName}</span>
                                  <span style={{ fontSize: 13, fontWeight: 600 }}>DLV {fmtDate(new Date(lot.dlvDate.split(" ")[0] + "T00:00:00"))}</span>
                                  <span style={{ fontSize: 12, color: "var(--text-muted)" }}>→ sell-by {fmtDate(lot.sellByDate)}</span>
                                  <span style={{ marginLeft: "auto", fontWeight: 700, color: lot.daysToSellBy <= 0 ? "#dc2626" : lot.daysToSellBy < 30 ? "#dc2626" : lot.daysToSellBy < 90 ? "#c2410c" : "var(--text-primary)" }}>
                                    {fmtDays(lot.daysToSellBy)}
                                  </span>
                                  <span style={{ fontSize: 12, color: "var(--text-muted)", minWidth: 60, textAlign: "right" }}>Qté {Math.round(lot.qty)}</span>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })()}

                    {/* Stock par emplacement */}
                    <div style={{ flex: 1, overflowY: "auto", padding: "0 24px 20px" }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 10 }}>Stock par emplacement</div>
                      {dlvDetailLoading && (
                        <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text-muted)", fontSize: 13, padding: "16px 0" }}>
                          <Spinner /> Chargement…
                        </div>
                      )}
                      {!dlvDetailLoading && dlvDetailData.length === 0 && (
                        <div style={{ color: "var(--text-muted)", fontSize: 13, padding: "12px 0" }}>Aucun stock interne trouvé.</div>
                      )}
                      {!dlvDetailLoading && dlvDetailData.length > 0 && (() => {
                        // Grouper par emplacement
                        const byLoc: Record<string, { name: string; rows: DlvDetailQuant[] }> = {};
                        for (const q of dlvDetailData) {
                          const k = q.locationFullName || q.locationName;
                          if (!byLoc[k]) byLoc[k] = { name: k, rows: [] };
                          byLoc[k].rows.push(q);
                        }
                        const totalQty = dlvDetailData.reduce((s, q) => s + q.qty, 0);
                        const totalReserved = dlvDetailData.reduce((s, q) => s + q.reservedQty, 0);
                        return (
                          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                            {Object.values(byLoc).map(loc => (
                              <div key={loc.name} style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
                                <div style={{ padding: "8px 14px", background: "var(--bg-raised)", fontSize: 12, fontWeight: 700, color: "var(--text-secondary)", display: "flex", alignItems: "center", gap: 6 }}>
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                                  {loc.name}
                                  <span style={{ marginLeft: "auto", fontWeight: 800, color: "var(--text-primary)" }}>
                                    {Math.round(loc.rows.reduce((s, r) => s + r.qty, 0))} unités
                                  </span>
                                </div>
                                {loc.rows.map((q, i) => (
                                  <div key={i} style={{ padding: "8px 14px 8px 28px", borderTop: i > 0 ? "1px solid var(--border)" : undefined, display: "flex", alignItems: "center", gap: 8, background: "var(--bg-surface)", fontSize: 13 }}>
                                    {q.lotName ? (
                                      <span style={{ fontFamily: "monospace", fontSize: 11, color: "var(--text-muted)", background: "var(--bg-raised)", borderRadius: 4, padding: "1px 6px", border: "1px solid var(--border)" }}>
                                        {q.lotName}
                                      </span>
                                    ) : (
                                      <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Sans lot</span>
                                    )}
                                    {q.dlvDate && (
                                      <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                                        DLV {fmtDate(new Date(q.dlvDate.split(" ")[0] + "T00:00:00"))}
                                      </span>
                                    )}
                                    <span style={{ marginLeft: "auto", fontWeight: 700 }}>{Math.round(q.qty)}</span>
                                    {q.reservedQty > 0 && (
                                      <span style={{ fontSize: 11, color: "#c2410c", background: "#fff7ed", borderRadius: 4, padding: "1px 6px" }}>
                                        {Math.round(q.reservedQty)} réservé
                                      </span>
                                    )}
                                  </div>
                                ))}
                              </div>
                            ))}
                            <div style={{ fontSize: 12, color: "var(--text-muted)", paddingTop: 4, display: "flex", gap: 16 }}>
                              <span>Total : <strong style={{ color: "var(--text-primary)" }}>{Math.round(totalQty)}</strong> unités</span>
                              {totalReserved > 0 && <span>Réservé : <strong style={{ color: "#c2410c" }}>{Math.round(totalReserved)}</strong></span>}
                              <span>Disponible : <strong style={{ color: "#15803d" }}>{Math.round(totalQty - totalReserved)}</strong></span>
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })()}

        {/* ══════════════════ ANALYSE TRANSPORTEURS ══════════════════ */}
        {tab === "transporteurs" && (() => {
          const eur = (n: number) => n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
          const pctFmt = (n: number | null) => (n === null ? "—" : (n * 100).toFixed(1) + " %");
          const pctColor = (p: number) => (p > 0.15 ? "var(--danger, #dc2626)" : p > 0.08 ? "#d97706" : "#16a34a");
          const hasData = carCommandes.length > 0;
          const nbMatched = carCroise.filter(c => c.matched).length;
          const nbAlertes = carCroise.filter(c => c.pct !== null && c.pct > 0.15).length;
          const anomalies = carCroise.filter(c => c.alert);
          const nbAnomalies = anomalies.length;
          const coutAnomalies = anomalies.reduce((s, c) => s + c.coutReel, 0);
          return (
            <div style={{ maxWidth: 1200, margin: "0 auto" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "18px 0 16px" }}>
                <div>
                  <div style={{ fontWeight: 800, fontSize: 17, color: "var(--text-primary)" }}>Analyse transporteurs</div>
                  <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>Facture transporteur (FedEx / TNT) croisée avec tes commandes Odoo</div>
                </div>
                {hasData && (
                  <button onClick={carReset} style={{ display: "flex", alignItems: "center", gap: 7, padding: "8px 14px", border: "1.5px solid var(--border)", borderRadius: 8, background: "var(--bg-raised)", color: "var(--text-secondary)", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
                    {I.rotate} Nouvelle facture
                  </button>
                )}
              </div>

              {carError && (
                <div style={{ marginBottom: 14, padding: "10px 14px", borderRadius: 10, background: "rgba(220,38,38,.08)", border: "1px solid rgba(220,38,38,.25)", color: "#dc2626", fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
                  {I.alertTri} {carError}
                </div>
              )}

              {!hasData && (
                <div
                  onClick={() => carPdfInput.current?.click()}
                  onDragOver={e => { e.preventDefault(); setCarDrag(true); }}
                  onDragLeave={() => setCarDrag(false)}
                  onDrop={e => { e.preventDefault(); setCarDrag(false); const f = e.dataTransfer.files[0]; if (f) carHandlePdf(f); }}
                  style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, padding: "70px 24px", border: `2px dashed ${carDrag ? "var(--accent)" : "var(--border)"}`, borderRadius: 16, background: carDrag ? "var(--accent-soft)" : "var(--bg-raised)", cursor: "pointer", transition: "all .2s" }}
                >
                  <input ref={carPdfInput} type="file" accept="application/pdf" hidden onChange={e => e.target.files?.[0] && carHandlePdf(e.target.files[0])} />
                  {carLoading ? (
                    <>
                      <div style={{ width: 44, height: 44, border: "3px solid var(--border)", borderTopColor: "var(--accent)", borderRadius: "50%", animation: "spin 1s linear infinite" }} />
                      <div style={{ textAlign: "center" }}>
                        <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)" }}>Extraction en cours…</div>
                        <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 3 }}>Analyse du PDF page par page</div>
                      </div>
                    </>
                  ) : (
                    <>
                      <div style={{ width: 60, height: 60, borderRadius: 16, background: "var(--accent-soft)", color: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center" }}>{I.upload}</div>
                      <div style={{ textAlign: "center" }}>
                        <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary)" }}>Dépose ta facture transporteur</div>
                        <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 3 }}>Format PDF — ou clique pour parcourir</div>
                      </div>
                      <div style={{ fontSize: 12, color: "var(--text-muted)" }}>Étape suivante : bornage par date + recherche directe dans Odoo</div>
                    </>
                  )}
                </div>
              )}

              {hasData && carStats && (
                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  {/* Cartes stats */}
                  <div style={{ display: "grid", gridTemplateColumns: `repeat(${carOdooLoaded ? 5 : 4}, 1fr)`, gap: 12 }}>
                    {[
                      { label: "Commandes", value: String(carStats.nb_commandes), sub: `${carStats.nb_lignes} colis`, accent: false, danger: false },
                      { label: "Transport total", value: eur(carStats.total_transport), sub: "coût pur", accent: true, danger: false },
                      { label: "Total facturé HT", value: eur(carStats.total_general_ht ?? carStats.total_facture), sub: carStats.surcharge_carburant ? `dont ${eur(carStats.surcharge_carburant)} carburant` : "transporteur", accent: false, danger: false },
                      { label: "Croisé Odoo", value: carOdooLoaded ? `${nbMatched}/${carCommandes.length}` : "—", sub: carOdooLoaded ? `${nbAlertes} alerte${nbAlertes > 1 ? "s" : ""} >15%` : "lance la recherche", accent: false, danger: false },
                      ...(carOdooLoaded ? [{ label: "Sans montant", value: String(nbAnomalies), sub: `${eur(coutAnomalies)} de transport à perte`, accent: false, danger: nbAnomalies > 0 }] : []),
                    ].map((s, i) => (
                      <div key={i} style={{ padding: 16, borderRadius: 14, border: `1px solid ${s.danger ? "#dc2626" : "var(--border)"}`, background: s.danger ? "rgba(220,38,38,0.06)" : "var(--bg-raised)" }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", marginBottom: 8 }}>{s.label}</div>
                        <div style={{ fontSize: 22, fontWeight: 800, color: s.danger ? "#dc2626" : s.accent ? "var(--accent)" : "var(--text-primary)" }}>{s.value}</div>
                        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>{s.sub}</div>
                      </div>
                    ))}
                  </div>

                  {/* Insights */}
                  {carInsights && (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
                      <div style={{ padding: 14, borderRadius: 12, border: "1px solid var(--border)", background: "var(--bg-raised)" }}>
                        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)" }}>% transport / CA global</div>
                        <div style={{ fontSize: 16, fontWeight: 800, color: "var(--accent)", marginTop: 2 }}>{(carInsights.pctGlobal * 100).toFixed(1)} %</div>
                        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>sur les commandes croisées</div>
                      </div>
                      <div style={{ padding: 14, borderRadius: 12, border: "1px solid var(--border)", background: "var(--bg-raised)" }}>
                        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)" }}>Commande la + coûteuse</div>
                        <div style={{ fontSize: 16, fontWeight: 800, color: "#dc2626", marginTop: 2 }}>{carInsights.topPct.ref}</div>
                        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{(carInsights.topPct.pct! * 100).toFixed(0)} % · {carInsights.topPct.client || "—"}</div>
                      </div>
                      {carInsights.topClient && (
                        <div style={{ padding: 14, borderRadius: 12, border: "1px solid var(--border)", background: "var(--bg-raised)" }}>
                          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)" }}>Client le + coûteux</div>
                          <div style={{ fontSize: 16, fontWeight: 800, color: "var(--text-primary)", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{carInsights.topClient[0]}</div>
                          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{eur(carInsights.topClient[1])} de transport</div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Détail par mois (fichier multi-factures) */}
                  {carFactures.length > 1 && (
                    <div style={{ border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
                      <div style={{ padding: "10px 14px", background: "var(--bg-raised)", fontSize: 12, fontWeight: 700, color: "var(--text-secondary)", display: "flex", alignItems: "center", gap: 8 }}>
                        📅 {carFactures.length} factures · vue annuelle — les cartes ci-dessus cumulent tous les mois
                      </div>
                      <table className="wms-table">
                        <thead><tr><th><div className="th-inner">Mois</div></th><th><div className="th-inner">Commandes</div></th><th><div className="th-inner">Colis</div></th><th><div className="th-inner">Transport</div></th><th><div className="th-inner">Carburant</div></th><th><div className="th-inner">Total HT</div></th><th><div className="th-inner">Part</div></th></tr></thead>
                        <tbody>
                          {carFactures.map((f, i) => {
                            const totAn = carStats?.total_general_ht || 1;
                            const part = (f.stats.total_general_ht || 0) / totAn;
                            return (
                              <tr key={i}>
                                <td style={{ fontWeight: 700, color: "var(--accent)" }}>{f.mois_label}</td>
                                <td style={{ textAlign: "right" }}>{f.stats.nb_commandes}</td>
                                <td style={{ textAlign: "right" }}>{f.stats.nb_lignes}</td>
                                <td style={{ textAlign: "right" }}>{eur(f.stats.total_transport)}</td>
                                <td style={{ textAlign: "right", color: "var(--text-muted)" }}>{eur(f.stats.surcharge_carburant || 0)}</td>
                                <td style={{ textAlign: "right", fontWeight: 700 }}>{eur(f.stats.total_general_ht || 0)}</td>
                                <td style={{ textAlign: "right" }}>{(part * 100).toFixed(0)} %</td>
                              </tr>
                            );
                          })}
                          <tr style={{ background: "var(--bg-raised)", fontWeight: 800 }}>
                            <td>ANNÉE</td>
                            <td style={{ textAlign: "right" }}>{carStats?.nb_commandes}</td>
                            <td style={{ textAlign: "right" }}>{carStats?.nb_lignes}</td>
                            <td style={{ textAlign: "right" }}>{eur(carStats?.total_transport || 0)}</td>
                            <td style={{ textAlign: "right" }}>{eur(carStats?.surcharge_carburant || 0)}</td>
                            <td style={{ textAlign: "right" }}>{eur(carStats?.total_general_ht || 0)}</td>
                            <td style={{ textAlign: "right" }}>100 %</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  )}

                  {/* Recherche Odoo (par réf S…, sans filtre de date) */}
                  <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, padding: 14, borderRadius: 12, border: "1px solid var(--border)", background: "var(--bg-raised)" }}>
                    <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                      {carOdooLoaded ? <>Croisement Odoo effectué par référence — <b style={{ color: "var(--text-primary)" }}>{nbMatched}/{carCommandes.length}</b> trouvées</> : "Le croisement Odoo se lance automatiquement après le dépôt."}
                    </div>
                    <button onClick={carSearchOdoo} disabled={carSearching || !session} style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 16px", background: "var(--accent)", color: "#fff", border: "none", borderRadius: 8, fontWeight: 700, fontSize: 13, cursor: carSearching ? "wait" : "pointer", opacity: carSearching || !session ? 0.6 : 1, fontFamily: "inherit" }}>
                      {carSearching ? "Recherche…" : <>{I.search} {carOdooLoaded ? "Relancer" : "Rechercher dans Odoo"}</>}
                    </button>
                    <div style={{ flex: 1 }} />
                    {carOdooLoaded && (
                      <button onClick={carExportCarte} style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 16px", background: "#7c3aed", color: "#fff", border: "none", borderRadius: 8, fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>
                        🗺️ Carte France
                      </button>
                    )}
                    <button onClick={carExportXlsx} style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 16px", background: "#16a34a", color: "#fff", border: "none", borderRadius: 8, fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>
                      {I.download} Export Excel
                    </button>
                  </div>

                  {/* Vues + recherche */}
                  <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
                    <div style={{ display: "flex", gap: 4, padding: 4, border: "1px solid var(--border)", borderRadius: 10, background: "var(--bg-raised)" }}>
                      {(["commandes", "lignes", "croise"] as const).map(v => (
                        <button key={v} onClick={() => setCarView(v)} style={{ padding: "6px 14px", borderRadius: 7, border: "none", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", textTransform: "capitalize", background: carView === v ? "var(--accent)" : "transparent", color: carView === v ? "#fff" : "var(--text-secondary)" }}>
                          {v === "croise" ? "Croisé Odoo" : v}
                        </button>
                      ))}
                    </div>
                    <div style={{ flex: 1, minWidth: 180, position: "relative" }}>
                      <input value={carSearch} onChange={e => setCarSearch(e.target.value)} placeholder="Rechercher une réf (S…)" style={{ width: "100%", padding: "8px 12px", border: "1.5px solid var(--border)", borderRadius: 8, fontSize: 13, fontFamily: "inherit", background: "var(--bg-input)", color: "var(--text-primary)" }} />
                    </div>
                    <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{carFiltered.length} ligne{carFiltered.length > 1 ? "s" : ""}{carPdfName ? ` · ${carPdfName}` : ""}</div>
                  </div>

                  {carView === "lignes" && carLignesOmises && (
                    <div style={{ padding: "10px 14px", borderRadius: 10, background: "rgba(217,119,6,.08)", border: "1px solid rgba(217,119,6,.25)", color: "#92400e", fontSize: 12.5 }}>
                      Le détail par colis est masqué sur les gros fichiers (&gt; 8 000 colis) pour rester rapide. L'analyse par commande et le croisement Odoo restent complets ; utilise la vue « Commandes » ou « Croisé Odoo ».
                    </div>
                  )}

                  {/* Tableau */}
                  <div style={{ border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
                    <div style={{ maxHeight: "58vh", overflow: "auto" }}>
                      <table className="wms-table">
                        <thead>
                          <tr>
                            {carView === "lignes" ? (
                              <><th><div className="th-inner">Réf</div></th><th><div className="th-inner">Date</div></th><th><div className="th-inner">Zone</div></th><th><div className="th-inner">Tracking</div></th><th><div className="th-inner">Poids</div></th><th><div className="th-inner">Transport</div></th><th><div className="th-inner">Total</div></th></>
                            ) : carView === "croise" ? (
                              <><th><div className="th-inner">Réf</div></th><th><div className="th-inner">Client</div></th><th><div className="th-inner">Colis</div></th><th><div className="th-inner" title="Total facturé de la ligne (transport + options/frais) + quote-part surcharge carburant">Coût réel</div></th><th><div className="th-inner">Montant HT</div></th><th><div className="th-inner">Montant TTC</div></th><th><div className="th-inner">% Transp.</div></th><th><div className="th-inner">Odoo</div></th></>
                            ) : (
                              <><th><div className="th-inner">Réf</div></th><th><div className="th-inner">Date</div></th><th><div className="th-inner">Zone</div></th><th><div className="th-inner">Colis</div></th><th><div className="th-inner">Poids</div></th><th><div className="th-inner">Transport</div></th><th><div className="th-inner">Total</div></th></>
                            )}
                          </tr>
                        </thead>
                        <tbody>
                          {carView === "lignes" && (carFiltered as CarrierLigne[]).map((r, i) => (
                            <tr key={i}><td style={{ fontWeight: 600, color: "var(--accent)" }}>{r.ref}</td><td>{r.date}</td><td>{r.zone}</td><td style={{ color: "var(--text-muted)", fontFamily: "monospace", fontSize: 12 }}>{r.tracking}</td><td style={{ textAlign: "right" }}>{r.weight}</td><td style={{ textAlign: "right" }}>{eur(r.transport)}</td><td style={{ textAlign: "right" }}>{eur(r.total)}</td></tr>
                          ))}
                          {carView === "commandes" && (carFiltered as CarrierCommande[]).map((r, i) => (
                            <tr key={i}><td style={{ fontWeight: 600, color: "var(--accent)" }}>{r.ref}</td><td>{r.date}</td><td>{r.zone}</td><td style={{ textAlign: "right" }}>{r.colis}</td><td style={{ textAlign: "right" }}>{r.weight}</td><td style={{ textAlign: "right" }}>{eur(r.transport)}</td><td style={{ textAlign: "right" }}>{eur(r.total)}</td></tr>
                          ))}
                          {carView === "croise" && (carFiltered as CarrierCrossed[]).map((r, i) => {
                            const grouped = !!(r.groupeDetail && r.groupeDetail.length > 1);
                            const open = carExpanded.has(r.ref);
                            const toggle = () => { if (!grouped) return; setCarExpanded(prev => { const n = new Set(prev); n.has(r.ref) ? n.delete(r.ref) : n.add(r.ref); return n; }); };
                            return (
                            <Fragment key={i}>
                            <tr style={r.alert ? { background: "rgba(220,38,38,0.07)" } : undefined}>
                              <td style={{ fontWeight: 600, color: "var(--accent)" }}>
                                <span onClick={toggle} style={grouped ? { cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4 } : undefined}>
                                  {grouped && <span style={{ fontSize: 10, color: "#7c3aed", transform: open ? "rotate(90deg)" : "none", transition: "transform .15s" }}>▶</span>}
                                  {r.ref}
                                  {grouped && (
                                    <span title={`Montant cumulé : ${r.groupe!.join(" + ")}`} style={{ fontSize: 10, fontWeight: 700, color: "#7c3aed", background: "rgba(124,58,237,0.12)", padding: "1px 6px", borderRadius: 10 }}>+{r.groupe!.length - 1} jointe{r.groupe!.length - 1 > 1 ? "s" : ""}</span>
                                  )}
                                </span>
                              </td>
                              <td>{r.client || <span style={{ color: "var(--text-muted)" }}>—</span>}</td>
                              <td style={{ textAlign: "right" }}>{r.colis}</td>
                              <td style={{ textAlign: "right" }} title={`Transport ${eur(r.transport)}${r.options ? ` + options ${eur(r.options)}` : ""} + carburant`}>{eur(r.coutReel)}</td>
                              <td style={{ textAlign: "right" }}>{r.montantHT ? eur(r.montantHT) : <span style={{ color: "#dc2626", fontWeight: 700 }}>0,00 €</span>}</td>
                              <td style={{ textAlign: "right" }}>{r.montantTTC ? eur(r.montantTTC) : <span style={{ color: "#dc2626", fontWeight: 700 }}>0,00 €</span>}</td>
                              <td style={{ textAlign: "right" }}>
                                {r.alert ? <span style={{ color: "#dc2626", fontWeight: 800 }}>⚠ à perte</span> : r.pct === null ? <span style={{ color: "var(--text-muted)" }}>—</span> : (
                                  <span style={{ fontWeight: 700, color: pctColor(r.pct) }}>{pctFmt(r.pct)}</span>
                                )}
                              </td>
                              <td style={{ textAlign: "center" }}>
                                {!r.matched ? <span style={{ color: "#dc2626", fontSize: 11, fontWeight: 600 }}>absent</span> : r.alert ? <span style={{ color: "#dc2626", fontWeight: 700 }}>0 €</span> : <span style={{ color: "#16a34a", fontWeight: 700 }}>✓</span>}
                              </td>
                            </tr>
                            {grouped && open && r.groupeDetail!.map((d, j) => (
                              <tr key={`${i}-d-${j}`} style={{ background: "rgba(124,58,237,0.05)" }}>
                                <td style={{ paddingLeft: 26, fontSize: 12, color: d.ref === r.ref ? "var(--text-secondary)" : "#7c3aed", fontWeight: 600 }}>↳ {d.ref}{d.ref === r.ref ? " (facturée)" : ""}</td>
                                <td colSpan={3} style={{ fontSize: 12, color: "var(--text-muted)" }}>commande du groupe</td>
                                <td style={{ textAlign: "right", fontSize: 12 }}>{eur(d.montantHT)}</td>
                                <td style={{ textAlign: "right", fontSize: 12 }}>{eur(d.montantTTC)}</td>
                                <td colSpan={2} />
                              </tr>
                            ))}
                            </Fragment>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })()}

        {/* ══════════════════ ANALYSE BMV ══════════════════ */}
        {tab === "bmv" && (() => {
          const eur = (n: number) => (n || 0).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
          const pctFmt = (n: number | null) => (n === null ? "—" : (n * 100).toFixed(1) + " %");
          const pctColor = (p: number) => (p > 0.15 ? "#dc2626" : p > 0.08 ? "#d97706" : "#16a34a");
          const hasData = bmvExped.length > 0;
          const nbMatched = bmvCroise.filter(c => c.matched).length;
          const nbApprox = bmvCroise.filter(c => c.matched && c.approx).length;
          const anomalies = bmvCroise.filter(c => c.alert);
          return (
            <div style={{ maxWidth: 1200, margin: "0 auto" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "18px 0 16px" }}>
                <div>
                  <div style={{ fontWeight: 800, fontSize: 17, color: "var(--text-primary)" }}>Analyse BMV</div>
                  <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>Facture BMV croisée avec Odoo — par réf (S…) ou, à défaut, par nom client + date</div>
                </div>
                {hasData && (
                  <button onClick={bmvReset} style={{ display: "flex", alignItems: "center", gap: 7, padding: "8px 14px", border: "1.5px solid var(--border)", borderRadius: 8, background: "var(--bg-raised)", color: "var(--text-secondary)", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
                    {I.rotate} Nouvelle facture
                  </button>
                )}
              </div>

              {bmvError && (
                <div style={{ marginBottom: 14, padding: "10px 14px", borderRadius: 10, background: "rgba(220,38,38,.08)", border: "1px solid rgba(220,38,38,.25)", color: "#dc2626", fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
                  {I.alertTri} {bmvError}
                </div>
              )}

              {!hasData && (
                <div
                  onClick={() => bmvPdfInput.current?.click()}
                  onDragOver={e => { e.preventDefault(); setBmvDrag(true); }}
                  onDragLeave={() => setBmvDrag(false)}
                  onDrop={e => { e.preventDefault(); setBmvDrag(false); const fs = Array.from(e.dataTransfer.files).filter(f => f.type === "application/pdf"); if (fs.length) bmvHandlePdfs(fs); }}
                  style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, padding: "70px 24px", border: `2px dashed ${bmvDrag ? "var(--accent)" : "var(--border)"}`, borderRadius: 16, background: bmvDrag ? "var(--accent-soft)" : "var(--bg-raised)", cursor: "pointer", transition: "all .2s" }}
                >
                  <input ref={bmvPdfInput} type="file" accept="application/pdf" multiple hidden onChange={e => { const fs = Array.from(e.target.files || []); if (fs.length) bmvHandlePdfs(fs); }} />
                  {bmvLoading ? (
                    <>
                      <div style={{ width: 44, height: 44, border: "3px solid var(--border)", borderTopColor: "var(--accent)", borderRadius: "50%", animation: "spin 1s linear infinite" }} />
                      <div style={{ textAlign: "center" }}>
                        <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)" }}>Extraction en cours…</div>
                        <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 3 }}>Analyse de la facture BMV</div>
                      </div>
                    </>
                  ) : (
                    <>
                      <div style={{ width: 60, height: 60, borderRadius: 16, background: "var(--accent-soft)", color: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center" }}>{I.upload}</div>
                      <div style={{ textAlign: "center" }}>
                        <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary)" }}>Dépose tes factures BMV</div>
                        <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 3 }}>1 ou plusieurs PDF (un par mois) — vision annuelle</div>
                      </div>
                      <div style={{ fontSize: 12, color: "var(--text-muted)" }}>Croisement Odoo automatique (réf S… puis nom + date d'expédition)</div>
                    </>
                  )}
                </div>
              )}

              {hasData && bmvStats && (
                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  {/* Cartes stats */}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12 }}>
                    {[
                      { label: "Expéditions", value: String(bmvStats.nb_expeditions), sub: `facture ${bmvStats.num || "—"}`, danger: false },
                      { label: "Transport total", value: eur(bmvStats.total_transport), sub: "hors carburant", danger: false },
                      { label: "Total facturé HT", value: eur(bmvStats.total_general_ht), sub: `dont ${eur(bmvStats.surcharge_carburant)} carburant (${bmvStats.surcharge_taux}%)`, danger: false },
                      { label: "Croisé Odoo", value: bmvOdooLoaded ? `${nbMatched}/${bmvStats.nb_expeditions}` : "—", sub: bmvOdooLoaded ? `${nbApprox} par nom+date` : "lance la recherche", danger: false },
                      { label: "Sans montant", value: String(anomalies.length), sub: "transport à perte", danger: anomalies.length > 0 },
                    ].map((s, i) => (
                      <div key={i} style={{ padding: 16, borderRadius: 14, border: `1px solid ${s.danger ? "#dc2626" : "var(--border)"}`, background: s.danger ? "rgba(220,38,38,0.06)" : "var(--bg-raised)" }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", marginBottom: 8 }}>{s.label}</div>
                        <div style={{ fontSize: 22, fontWeight: 800, color: s.danger ? "#dc2626" : "var(--text-primary)" }}>{s.value}</div>
                        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>{s.sub}</div>
                      </div>
                    ))}
                  </div>

                  {/* Vue par mois (plusieurs factures) */}
                  {bmvFactures.length > 1 && (
                    <div style={{ border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
                      <div style={{ padding: "10px 14px", background: "var(--bg-raised)", fontSize: 12, fontWeight: 700, color: "var(--text-secondary)", display: "flex", alignItems: "center", gap: 8 }}>
                        📅 {bmvFactures.length} factures · vue annuelle — les cartes ci-dessus cumulent tous les mois
                      </div>
                      <table className="wms-table">
                        <thead><tr><th><div className="th-inner">Mois</div></th><th><div className="th-inner">N° facture</div></th><th><div className="th-inner">Expéd.</div></th><th><div className="th-inner">Transport</div></th><th><div className="th-inner">Carburant</div></th><th><div className="th-inner">Total HT</div></th><th><div className="th-inner">Part</div></th></tr></thead>
                        <tbody>
                          {bmvFactures.map((f, i) => {
                            const part = (f.total_general_ht || 0) / (bmvStats.total_general_ht || 1);
                            return (
                              <tr key={i}>
                                <td style={{ fontWeight: 700, color: "var(--accent)" }}>{f.mois}</td>
                                <td style={{ color: "var(--text-muted)" }}>{f.num || "—"}</td>
                                <td style={{ textAlign: "right" }}>{f.nb_expeditions}</td>
                                <td style={{ textAlign: "right" }}>{eur(f.total_transport)}</td>
                                <td style={{ textAlign: "right", color: "var(--text-muted)" }}>{eur(f.surcharge_carburant)}</td>
                                <td style={{ textAlign: "right", fontWeight: 700 }}>{eur(f.total_general_ht)}</td>
                                <td style={{ textAlign: "right" }}>{(part * 100).toFixed(0)} %</td>
                              </tr>
                            );
                          })}
                          <tr style={{ background: "var(--bg-raised)", fontWeight: 800 }}>
                            <td colSpan={2}>ANNÉE</td>
                            <td style={{ textAlign: "right" }}>{bmvStats.nb_expeditions}</td>
                            <td style={{ textAlign: "right" }}>{eur(bmvStats.total_transport)}</td>
                            <td style={{ textAlign: "right" }}>{eur(bmvStats.surcharge_carburant)}</td>
                            <td style={{ textAlign: "right" }}>{eur(bmvStats.total_general_ht)}</td>
                            <td style={{ textAlign: "right" }}>100 %</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  )}

                  {/* Barre actions */}
                  <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, padding: 14, borderRadius: 12, border: "1px solid var(--border)", background: "var(--bg-raised)" }}>
                    <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                      {bmvOdooLoaded ? <>Croisement effectué — <b style={{ color: "var(--text-primary)" }}>{nbMatched}/{bmvStats.nb_expeditions}</b> trouvées ({nbApprox} approx.)</> : "Le croisement se lance après le dépôt."}
                    </div>
                    <button onClick={() => bmvCross(bmvExped)} disabled={bmvSearching || !session} style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 16px", background: "var(--accent)", color: "#fff", border: "none", borderRadius: 8, fontWeight: 700, fontSize: 13, cursor: bmvSearching ? "wait" : "pointer", opacity: bmvSearching || !session ? 0.6 : 1, fontFamily: "inherit" }}>
                      {bmvSearching ? "Recherche…" : <>{I.search} {bmvOdooLoaded ? "Relancer" : "Rechercher dans Odoo"}</>}
                    </button>
                    <div style={{ flex: 1 }} />
                    <button onClick={bmvExportXlsx} style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 16px", background: "#16a34a", color: "#fff", border: "none", borderRadius: 8, fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>
                      {I.download} Export
                    </button>
                  </div>

                  {/* Recherche */}
                  <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
                    <div style={{ flex: 1, minWidth: 180 }}>
                      <input value={bmvSearch} onChange={e => setBmvSearch(e.target.value)} placeholder="Rechercher (réf, destinataire, client)…" style={{ width: "100%", padding: "8px 12px", border: "1.5px solid var(--border)", borderRadius: 8, fontSize: 13, fontFamily: "inherit", background: "var(--bg-input)", color: "var(--text-primary)", boxSizing: "border-box" }} />
                    </div>
                    <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{bmvFiltered.length} expédition{bmvFiltered.length > 1 ? "s" : ""}{bmvPdfName ? ` · ${bmvPdfName}` : ""}</div>
                  </div>

                  {/* Tableau croisé */}
                  <div style={{ border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
                    <div style={{ maxHeight: "58vh", overflow: "auto" }}>
                      <table className="wms-table">
                        <thead>
                          <tr>
                            <th><div className="th-inner">Réf / Récep</div></th>
                            <th><div className="th-inner">Date</div></th>
                            <th><div className="th-inner">Destinataire</div></th>
                            <th><div className="th-inner">Dpt</div></th>
                            <th><div className="th-inner">Colis</div></th>
                            <th><div className="th-inner" title="Transport + quote-part surcharge carburant">Coût réel</div></th>
                            <th><div className="th-inner">Montant HT</div></th>
                            <th><div className="th-inner">% Transp.</div></th>
                            <th><div className="th-inner">Match</div></th>
                          </tr>
                        </thead>
                        <tbody>
                          {bmvFiltered.map((r, i) => (
                            <tr key={i} style={r.alert ? { background: "rgba(220,38,38,0.07)" } : undefined}>
                              <td style={{ fontWeight: 600, color: "var(--accent)" }}>
                                {r.matchedRef
                                  ? <span title={r.approx ? `Réf retrouvée par nom+date · récep ${r.recep}` : `Récep ${r.recep}`}>{r.matchedRef}{r.approx && <span style={{ color: "#d97706", fontSize: 10, fontWeight: 700 }}> ≈</span>}</span>
                                  : <span style={{ color: "var(--text-muted)", fontWeight: 500 }}>{r.recep}</span>}
                                {r.groupe && r.groupe.length > 1 && (
                                  <span title={`Montant cumulé : ${r.groupe.join(" + ")}`} style={{ marginLeft: 5, fontSize: 10, fontWeight: 700, color: "#7c3aed", background: "rgba(124,58,237,0.12)", padding: "1px 6px", borderRadius: 10 }}>+{r.groupe.length - 1} jointe{r.groupe.length - 1 > 1 ? "s" : ""}</span>
                                )}
                              </td>
                              <td>{r.date}</td>
                              <td title={r.ville}>{r.client || r.dest || <span style={{ color: "var(--text-muted)" }}>—</span>}</td>
                              <td>{r.dpt}</td>
                              <td style={{ textAlign: "right" }}>{r.colis}</td>
                              <td style={{ textAlign: "right" }} title={`Transport ${eur(r.transport)} + carburant`}>{eur(r.coutReel)}</td>
                              <td style={{ textAlign: "right" }}>{r.montantHT ? eur(r.montantHT) : <span style={{ color: "#dc2626", fontWeight: 700 }}>0,00 €</span>}</td>
                              <td style={{ textAlign: "right" }}>
                                {r.alert ? <span style={{ color: "#dc2626", fontWeight: 800 }}>⚠ à perte</span> : r.pct === null ? <span style={{ color: "var(--text-muted)" }}>—</span> : <span style={{ fontWeight: 700, color: pctColor(r.pct) }}>{pctFmt(r.pct)}</span>}
                              </td>
                              <td style={{ textAlign: "center" }}>
                                {!r.matched ? <span style={{ color: "#dc2626", fontSize: 11, fontWeight: 600 }}>absent</span>
                                  : r.approx ? <span title="Trouvé par nom + date — à vérifier" style={{ color: "#d97706", fontSize: 11, fontWeight: 700 }}>≈ nom+date</span>
                                  : <span style={{ color: "#16a34a", fontWeight: 700 }}>✓ réf</span>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })()}

        {/* ══════════════════ RÉCEPTION FOURNISSEUR ══════════════════ */}
        {tab === "reception" && (
          <div style={{ animation: "fadeIn .3s ease both" }}>
            {/* Header */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24, flexWrap: "wrap", gap: 16 }}>
              <div>
                <h2 style={{ fontSize: 20, fontWeight: 700, letterSpacing: "-.2px", marginBottom: 4, color: "#0f172a" }}>Réception</h2>
                <p style={{ fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.5 }}>Réceptions terminées (Fait) par fournisseur — réf Odoo, réf fournisseur, qté reçue et lot.</p>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
                {/* Liste 1 : fournisseur → charge les réceptions */}
                <select
                  value={recVendorId ?? ""}
                  onChange={(e) => { const v = e.target.value ? Number(e.target.value) : null; setRecVendorId(v); setRecPickings([]); setRecPickingId(null); setRecRows([]); }}
                  style={{ minWidth: 220, padding: "8px 12px", borderRadius: 10, border: "1px solid var(--border)", fontSize: 13, background: "var(--bg-raised)", color: "var(--text-primary)" }}
                  disabled={recVendorsLoading}
                >
                  <option value="">{recVendorsLoading ? "Chargement…" : "— Fournisseur —"}</option>
                  {recVendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                </select>
                <button className="wms-btn" onClick={loadRecPickings} disabled={!recVendorId || recPickingsLoading}>
                  {recPickingsLoading ? <Spinner /> : I.refresh} Charger
                </button>
                {/* Liste 2 : réception (la plus récente en haut) → affiche le détail */}
                <select
                  value={recPickingId ?? ""}
                  onChange={(e) => { const v = e.target.value ? Number(e.target.value) : null; setRecPickingId(v); setRecRows([]); }}
                  style={{ minWidth: 240, padding: "8px 12px", borderRadius: 10, border: "1px solid var(--border)", fontSize: 13, background: "var(--bg-raised)", color: "var(--text-primary)" }}
                  disabled={!recPickings.length}
                >
                  <option value="">{recPickings.length ? `— Réception (${recPickings.length}) —` : "— Réception —"}</option>
                  {recPickings.map(p => <option key={p.id} value={p.id}>{p.name}{p.date ? ` · ${p.date}` : ""}</option>)}
                </select>
                <button className="wms-btn wms-btn-primary" onClick={loadReceptions} disabled={!recPickingId || recLoading}>
                  {recLoading ? <Spinner /> : I.refresh} Afficher
                </button>
                <button className="wms-btn" onClick={recExportExcel} disabled={!recRows.length}>
                  Export Excel
                </button>
              </div>
            </div>

            {/* Résumé */}
            {recRows.length > 0 && (
              <div style={{ display: "flex", gap: 16, marginBottom: 16, fontSize: 13, color: "var(--text-muted)" }}>
                <span><strong style={{ color: "var(--text-primary)" }}>{recRows.length}</strong> lignes reçues</span>
                <span><strong style={{ color: "var(--text-primary)" }}>{new Set(recRows.map(r => r.odooRef || r.productName)).size}</strong> produits distincts</span>
                <span><strong style={{ color: "var(--text-primary)" }}>{Math.round(recRows.reduce((s, r) => s + r.qty, 0)).toLocaleString("fr-FR")}</strong> unités au total</span>
                {recRows.some(r => !r.supplierRef) && (
                  <span style={{ color: "#d97706", fontWeight: 600 }}>⚠ {recRows.filter(r => !r.supplierRef).length} sans réf fournisseur</span>
                )}
              </div>
            )}

            {/* Tableau */}
            {recRows.length > 0 ? (
              <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 14, overflow: "hidden" }}>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: "var(--bg-subtle, #f8fafc)", textAlign: "left" }}>
                        {["Réf Odoo", "Réf fournisseur", "Nom du produit", "Qté reçue", "Lot reçu", "Réception"].map((h, i) => (
                          <th key={i} style={{ padding: "10px 14px", fontWeight: 700, color: "var(--text-muted)", whiteSpace: "nowrap", borderBottom: "1px solid var(--border)", textAlign: i === 3 ? "right" : "left" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {recRows.map((r, i) => (
                        <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
                          <td style={{ padding: "9px 14px", fontFamily: "monospace", fontWeight: 600, color: "#0f172a", whiteSpace: "nowrap" }}>{r.odooRef || "—"}</td>
                          <td style={{ padding: "9px 14px", fontFamily: "monospace", color: r.supplierRef ? "#0f172a" : "#dc2626", whiteSpace: "nowrap" }}>{r.supplierRef || "(manquant)"}</td>
                          <td style={{ padding: "9px 14px", color: "var(--text-primary)" }}>{r.productName}</td>
                          <td style={{ padding: "9px 14px", textAlign: "right", fontWeight: 600, color: "#0f172a" }}>{Math.round(r.qty).toLocaleString("fr-FR")}</td>
                          <td style={{ padding: "9px 14px", fontFamily: "monospace", color: "var(--text-muted)", whiteSpace: "nowrap" }}>{r.lot || "—"}</td>
                          <td style={{ padding: "9px 14px", color: "var(--text-muted)", whiteSpace: "nowrap" }}>{r.pickingName}{r.date ? ` · ${r.date}` : ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <div style={{ padding: "40px 0", textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
                {recLoading ? "Chargement…" : recPickingId ? "Aucune ligne pour cette réception." : recPickings.length ? "Choisissez une réception dans la liste puis cliquez sur « Afficher »." : "Choisissez un fournisseur, cliquez « Charger », puis sélectionnez une réception."}
              </div>
            )}
          </div>
        )}

        {/* ══════════════════ ASSISTANT IA ODOO ══════════════════ */}
        {tab === "assistant" && (
          <div style={{ maxWidth: 780, margin: "0 auto", display: "flex", flexDirection: "column", height: "calc(100vh - 160px)" }}>
            {/* Header */}
            <div style={{ padding: "20px 0 12px", display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
              <div style={{ width: 36, height: 36, borderRadius: 10, background: "var(--accent-soft)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>🤖</div>
              <div>
                <div style={{ fontWeight: 800, fontSize: 16, color: "var(--text-primary)" }}>Assistant IA Odoo</div>
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>Pose une question en français — l&apos;IA cherche dans ta base Odoo</div>
              </div>
            </div>

            {/* Messages */}
            <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 12, padding: "4px 0 16px" }}>
              {aiMessages.length === 0 && !aiLoading && (
                <div style={{ textAlign: "center", paddingTop: 40 }}>
                  <div style={{ fontSize: 40, marginBottom: 12 }}>🤖</div>
                  <div style={{ fontSize: 14, color: "var(--text-secondary)", marginBottom: 20 }}>Exemples de questions :</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center" }}>
                    {[
                      "Quel est le prix du coffret Noël 2024 ?",
                      "Donne-moi tous les échantillons en stock",
                      "Quels OUT sont en attente de validation ?",
                      "Stock disponible de la crème solaire",
                      "Liste des lots qui expirent dans 3 mois",
                      "Combien de commandes fournisseur en cours ?",
                    ].map(ex => (
                      <button key={ex} onClick={() => aiSend(ex)}
                        style={{ padding: "6px 12px", border: "1.5px solid var(--border)", borderRadius: 20, background: "var(--bg-raised)", cursor: "pointer", fontSize: 12, color: "var(--text-secondary)", fontFamily: "inherit", transition: "all .15s" }}
                        onMouseEnter={e => { (e.target as HTMLElement).style.borderColor = "var(--accent)"; (e.target as HTMLElement).style.color = "var(--accent)"; }}
                        onMouseLeave={e => { (e.target as HTMLElement).style.borderColor = "var(--border)"; (e.target as HTMLElement).style.color = "var(--text-secondary)"; }}>
                        {ex}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {aiMessages.map((msg, i) => (
                <div key={i} style={{ display: "flex", justifyContent: msg.role === "user" ? "flex-end" : "flex-start", gap: 8 }}>
                  {msg.role === "assistant" && (
                    <div style={{ width: 28, height: 28, borderRadius: 8, background: "var(--accent-soft)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, flexShrink: 0, marginTop: 2 }}>🤖</div>
                  )}
                  <div style={{ maxWidth: "80%", display: "flex", flexDirection: "column", gap: 3 }}>
                    <div style={{
                      padding: "10px 14px",
                      borderRadius: msg.role === "user" ? "16px 16px 4px 16px" : "4px 16px 16px 16px",
                      background: msg.role === "user" ? "var(--accent)" : "var(--bg-raised)",
                      color: msg.role === "user" ? "#fff" : "var(--text-primary)",
                      fontSize: 13,
                      lineHeight: 1.6,
                      border: msg.role === "assistant" ? "1px solid var(--border)" : "none",
                      whiteSpace: "pre-wrap",
                      boxShadow: "0 1px 3px rgba(0,0,0,.06)",
                    }}>
                      {msg.text}
                    </div>
                    {msg.role === "assistant" && msg.model && (
                      <div style={{ fontSize: 10, color: "var(--text-muted)", paddingLeft: 4, display: "flex", alignItems: "center", gap: 8 }}>
                        <span>⚡ {msg.model} · {msg.queriesRun} requête{(msg.queriesRun ?? 0) > 1 ? "s" : ""} Odoo</span>
                        {msg.rawData && msg.rawData.some(r => r.rows?.length > 0) && (
                          <button onClick={() => aiExportExcel(msg.rawData!)}
                            style={{ padding: "2px 8px", background: "#16a34a", color: "#fff", border: "none", borderRadius: 5, fontSize: 10, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                            ⬇ Excel
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))}

              {aiLoading && (
                <div style={{ display: "flex", gap: 8 }}>
                  <div style={{ width: 28, height: 28, borderRadius: 8, background: "var(--accent-soft)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, flexShrink: 0 }}>🤖</div>
                  <div style={{ padding: "10px 14px", borderRadius: "4px 16px 16px 16px", background: "var(--bg-raised)", border: "1px solid var(--border)", display: "flex", gap: 4, alignItems: "center" }}>
                    {[0, 1, 2].map(j => (
                      <div key={j} style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--accent)", opacity: 0.6, animation: `pulse 1.2s ease-in-out ${j * 0.2}s infinite` }} />
                    ))}
                  </div>
                </div>
              )}
              <div ref={aiBottomRef} />
            </div>

            {/* Input */}
            <div style={{ flexShrink: 0, paddingBottom: 16 }}>
              <form onSubmit={e => { e.preventDefault(); aiSend(); }} style={{ display: "flex", gap: 8 }}>
                <input
                  value={aiInput}
                  onChange={e => setAiInput(e.target.value)}
                  placeholder="Ex: Quel est le stock des échantillons ?"
                  disabled={aiLoading}
                  style={{ flex: 1, padding: "10px 14px", border: "1.5px solid var(--border)", borderRadius: 12, fontSize: 13, fontFamily: "inherit", background: "var(--bg-input)", color: "var(--text-primary)", outline: "none", transition: "border-color .15s" }}
                  onFocus={e => (e.target.style.borderColor = "var(--accent)")}
                  onBlur={e => (e.target.style.borderColor = "var(--border)")}
                />
                <button type="submit" disabled={aiLoading || !aiInput.trim()}
                  style={{ padding: "10px 18px", background: "var(--accent)", color: "#fff", border: "none", borderRadius: 12, fontWeight: 700, fontSize: 13, cursor: aiLoading || !aiInput.trim() ? "not-allowed" : "pointer", opacity: aiLoading || !aiInput.trim() ? 0.5 : 1, fontFamily: "inherit", transition: "opacity .15s" }}>
                  Envoyer
                </button>
              </form>
              {!process.env.NEXT_PUBLIC_HAS_AI && aiMessages.length === 0 && (
                <div style={{ marginTop: 8, fontSize: 11, color: "var(--text-muted)", textAlign: "center" }}>
                  ⚙️ Nécessite la variable d&apos;environnement <code>ANTHROPIC_API_KEY</code> dans Vercel
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
