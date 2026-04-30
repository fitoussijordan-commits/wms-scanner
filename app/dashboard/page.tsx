"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import * as odoo from "@/lib/odoo";
import { sb } from "@/lib/supabase";
import * as XLSX from "xlsx";

// ─────────── Types ───────────
interface DashRef { ref: string; product_name: string; }
interface DashRow {
  ref: string;
  name: string;
  odoo_id: number | null;
  stock: number;
  conso_avg: number;       // unités/mois (moyenne 3 derniers mois complets)
  threshold: number;       // seuil min en unités
  supplier_date: string | null; // ISO date si rupture fournisseur
  days_remaining: number;  // jours de stock restants (stock / (conso/30))
  days_until_delivery: number; // jours jusqu'à prochaine livraison
  next_delivery_label: string; // texte affiché
  status: "ok" | "alert" | "critical" | "no_data" | "not_found";
}
type StatusFilter = "all" | "critical" | "alert" | "ok";
type SortKey = "ref" | "name" | "stock" | "conso_avg" | "threshold" | "days_remaining" | "status";

// ─────────── Helpers ───────────
function loadCfg() {
  try { const c = localStorage.getItem("wms_c"); return c ? JSON.parse(c) : null; } catch { return null; }
}
function saveDashSession(s: odoo.OdooSession) {
  try { localStorage.setItem("wms_dash_s", JSON.stringify(s)); } catch {}
}
function loadDashSession(): odoo.OdooSession | null {
  try { const s = localStorage.getItem("wms_dash_s"); return s ? JSON.parse(s) : null; } catch { return null; }
}

// Prochain 15 du mois suivant
function nextDelivery(supplierDate?: string | null): { date: Date; label: string } {
  const today = new Date();
  if (supplierDate) {
    const d = new Date(supplierDate + "T00:00:00");
    return { date: d, label: `Fournisseur ${d.toLocaleDateString("fr-FR", { day: "2-digit", month: "short" })}` };
  }
  const d = new Date(today.getFullYear(), today.getMonth() + 1, 15);
  return { date: d, label: `15 ${d.toLocaleDateString("fr-FR", { month: "short", year: "numeric" })}` };
}

function daysUntil(d: Date): number {
  const ms = d.getTime() - new Date().setHours(0, 0, 0, 0);
  return Math.ceil(ms / 86400000);
}

function computeStatus(row: Pick<DashRow, "stock" | "conso_avg" | "threshold" | "days_remaining" | "days_until_delivery">): DashRow["status"] {
  if (row.conso_avg === 0 && row.stock === 0) return "no_data";
  if (row.days_remaining < row.days_until_delivery) return "critical";
  if (row.days_remaining < row.days_until_delivery + 14 || row.stock < row.threshold) return "alert";
  return "ok";
}

const STATUS_COLOR: Record<DashRow["status"], string> = {
  critical: "#ef4444",
  alert: "#f59e0b",
  ok: "#22c55e",
  no_data: "#9ca3af",
  not_found: "#d1d5db",
};
const STATUS_BG: Record<DashRow["status"], string> = {
  critical: "#fef2f2",
  alert: "#fffbeb",
  ok: "#f0fdf4",
  no_data: "#f9fafb",
  not_found: "#f3f4f6",
};
const STATUS_LABEL: Record<DashRow["status"], string> = {
  critical: "Critique",
  alert: "Alerte",
  ok: "OK",
  no_data: "Pas de données",
  not_found: "Introuvable",
};

// ─────────── Supabase ───────────
async function loadRefs(): Promise<DashRef[]> {
  const { data, error } = await sb.from("dashboard_refs").select("ref, product_name").order("ref");
  if (error) throw new Error(error.message);
  return data || [];
}
async function saveRefs(refs: DashRef[]): Promise<void> {
  // Upsert all
  const { error } = await sb.from("dashboard_refs").upsert(refs, { onConflict: "ref" });
  if (error) throw new Error(error.message);
}
async function deleteAllRefs(): Promise<void> {
  const { error } = await sb.from("dashboard_refs").delete().neq("ref", "___never___");
  if (error) throw new Error(error.message);
}
async function loadThresholdsMap(): Promise<Record<string, number>> {
  const { data, error } = await sb.from("dashboard_thresholds").select("ref, threshold");
  if (error) return {};
  return Object.fromEntries((data || []).map((r: any) => [r.ref, r.threshold]));
}
async function saveThresholdSupa(ref: string, threshold: number, name: string) {
  await sb.from("dashboard_thresholds").upsert({ ref, threshold, product_name: name, updated_at: new Date().toISOString() }, { onConflict: "ref" });
}
async function loadSupplierDates(): Promise<Record<string, string | null>> {
  const { data, error } = await sb.from("dashboard_supplier_dates").select("ref, supplier_date");
  if (error) return {};
  return Object.fromEntries((data || []).map((r: any) => [r.ref, r.supplier_date]));
}
async function saveSupplierDate(ref: string, date: string | null) {
  if (!date) {
    await sb.from("dashboard_supplier_dates").delete().eq("ref", ref);
  } else {
    await sb.from("dashboard_supplier_dates").upsert({ ref, supplier_date: date, updated_at: new Date().toISOString() }, { onConflict: "ref" });
  }
}

// ─────────── Odoo fetch ───────────
async function fetchOdooData(session: odoo.OdooSession, refs: string[]): Promise<{
  stockByRef: Record<string, { id: number; name: string; qty: number }>;
  consoByRef: Record<string, number[]>; // 3 derniers mois
}> {
  if (!refs.length) return { stockByRef: {}, consoByRef: {} };

  // 1. Produits + stock
  const products: any[] = await odoo.searchRead(
    session, "product.product",
    [["default_code", "in", refs], ["active", "in", [true, false]]],
    ["id", "name", "default_code", "qty_available"],
    0
  );
  const stockByRef: Record<string, { id: number; name: string; qty: number }> = {};
  for (const p of products) {
    if (p.default_code) stockByRef[p.default_code] = { id: p.id, name: p.name, qty: p.qty_available ?? 0 };
  }

  // 2. Mouvements OUT des 3 derniers mois complets
  const today = new Date();
  const threeMonthsAgo = new Date(today.getFullYear(), today.getMonth() - 3, 1);
  const dateFrom = threeMonthsAgo.toISOString().slice(0, 10) + " 00:00:00";
  const currentMonthStart = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10) + " 00:00:00";
  const productIds = Object.values(stockByRef).map(p => p.id);

  const consoByRef: Record<string, number[]> = {};
  if (productIds.length > 0) {
    const moves: any[] = await odoo.searchRead(
      session, "stock.move",
      [
        ["state", "=", "done"],
        ["product_id", "in", productIds],
        ["date", ">=", dateFrom],
        ["date", "<", currentMonthStart], // exclure le mois en cours
        ["location_id.usage", "=", "internal"],
        ["location_dest_id.usage", "=", "customer"],
      ],
      ["product_id", "product_uom_qty", "date"],
      0
    );

    // Grouper par produit + mois
    const byProductMonth: Record<number, Record<string, number>> = {};
    for (const m of moves) {
      const pid = Array.isArray(m.product_id) ? m.product_id[0] : m.product_id;
      const month = String(m.date || "").slice(0, 7); // "2026-01"
      if (!byProductMonth[pid]) byProductMonth[pid] = {};
      byProductMonth[pid][month] = (byProductMonth[pid][month] || 0) + (m.product_uom_qty || 0);
    }

    // Construire les 3 mois complets
    const months: string[] = [];
    for (let i = 3; i >= 1; i--) {
      const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
      months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    }

    for (const [ref, info] of Object.entries(stockByRef)) {
      const pid = info.id;
      const monthQtys = months.map(m => byProductMonth[pid]?.[m] ?? 0);
      consoByRef[ref] = monthQtys;
    }
  }

  return { stockByRef, consoByRef };
}

// ─────────── Main component ───────────
export default function DashboardPage() {
  const [session, setSession] = useState<odoo.OdooSession | null>(null);
  const [loginForm, setLoginForm] = useState({ url: "", db: "", login: "", password: "" });
  const [loginErr, setLoginErr] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);

  const [refs, setRefs] = useState<DashRef[]>([]);
  const [rows, setRows] = useState<DashRow[]>([]);
  const [thresholds, setThresholds] = useState<Record<string, number>>({});
  const [supplierDates, setSupplierDates] = useState<Record<string, string | null>>({});
  const [loading, setLoading] = useState(false);
  const [loadMsg, setLoadMsg] = useState("");
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const [toast, setToast] = useState("");

  const [filter, setFilter] = useState<StatusFilter>("all");
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("status");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  // Editing states
  const [editThreshold, setEditThreshold] = useState<{ ref: string; val: string } | null>(null);
  const [supplierModal, setSupplierModal] = useState<{ ref: string; name: string; current: string } | null>(null);
  const [supplierInput, setSupplierInput] = useState("");
  const [uploadLoading, setUploadLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-login
  useEffect(() => {
    const s = loadDashSession();
    if (s) {
      setSession(s);
    } else {
      const cfg = loadCfg();
      if (cfg) setLoginForm(f => ({ ...f, url: cfg.u || "", db: cfg.d || "" }));
    }
  }, []);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 3000);
  };

  // Build rows from refs + odoo data + thresholds + supplier dates
  const buildRows = useCallback((
    refList: DashRef[],
    stockByRef: Record<string, { id: number; name: string; qty: number }>,
    consoByRef: Record<string, number[]>,
    thr: Record<string, number>,
    supDates: Record<string, string | null>
  ): DashRow[] => {
    return refList.map(({ ref, product_name }) => {
      const odooInfo = stockByRef[ref];
      if (!odooInfo) {
        return {
          ref, name: product_name || ref, odoo_id: null, stock: 0, conso_avg: 0,
          threshold: thr[ref] ?? 0, supplier_date: supDates[ref] ?? null,
          days_remaining: 0, days_until_delivery: 0, next_delivery_label: "-",
          status: "not_found",
        };
      }
      const stock = odooInfo.qty;
      const monthQtys = consoByRef[ref] || [0, 0, 0];
      const nonZeroMonths = monthQtys.filter(q => q > 0).length;
      const conso_avg = nonZeroMonths > 0 ? monthQtys.reduce((a, b) => a + b, 0) / nonZeroMonths : 0;
      const threshold = thr[ref] ?? Math.round(conso_avg);
      const { date: delivDate, label: delivLabel } = nextDelivery(supDates[ref]);
      const days_until_delivery = Math.max(0, daysUntil(delivDate));
      const days_remaining = conso_avg > 0 ? Math.round(stock * 30 / conso_avg) : (stock > 0 ? 999 : 0);
      const status = computeStatus({ stock, conso_avg, threshold, days_remaining, days_until_delivery });
      return {
        ref, name: odooInfo.name, odoo_id: odooInfo.id, stock,
        conso_avg: Math.round(conso_avg * 10) / 10,
        threshold, supplier_date: supDates[ref] ?? null,
        days_remaining, days_until_delivery,
        next_delivery_label: delivLabel, status,
      };
    });
  }, []);

  // Full data load from Odoo
  const syncData = useCallback(async (sess: odoo.OdooSession, refList: DashRef[], thr: Record<string, number>, supDates: Record<string, string | null>) => {
    setLoading(true);
    setLoadMsg("Chargement stock Odoo...");
    try {
      const { stockByRef, consoByRef } = await fetchOdooData(sess, refList.map(r => r.ref));
      setLoadMsg("Calcul...");
      const built = buildRows(refList, stockByRef, consoByRef, thr, supDates);
      setRows(built);
      setLastSync(new Date());
    } catch (e: any) {
      showToast("Erreur Odoo: " + e.message);
    } finally {
      setLoading(false);
      setLoadMsg("");
    }
  }, [buildRows]);

  // Initial load after login
  const loadAll = useCallback(async (sess: odoo.OdooSession) => {
    setLoading(true);
    setLoadMsg("Chargement références...");
    try {
      const [refList, thr, supDates] = await Promise.all([loadRefs(), loadThresholdsMap(), loadSupplierDates()]);
      setRefs(refList);
      setThresholds(thr);
      setSupplierDates(supDates);
      if (refList.length > 0) {
        await syncData(sess, refList, thr, supDates);
      } else {
        setLoading(false);
        setLoadMsg("");
      }
    } catch (e: any) {
      showToast("Erreur: " + e.message);
      setLoading(false);
      setLoadMsg("");
    }
  }, [syncData]);

  useEffect(() => {
    if (session) loadAll(session);
  }, [session, loadAll]);

  // Login
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginLoading(true);
    setLoginErr("");
    try {
      const cfg = { url: loginForm.url.replace(/\/$/, ""), db: loginForm.db };
      const s = await odoo.authenticate(cfg, loginForm.login, loginForm.password);
      saveDashSession(s);
      setSession(s);
    } catch (err: any) {
      setLoginErr(err.message);
    } finally {
      setLoginLoading(false);
    }
  };

  // Excel upload: parse refs
  const handleExcelUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadLoading(true);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const data: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1 });

      // Détecter la colonne ref (cherche header "ref", "reference", "code", "default_code" etc.)
      const headers: string[] = (data[0] || []).map((h: any) => String(h || "").toLowerCase().trim());
      const refIdx = headers.findIndex(h => h.includes("ref") || h.includes("code") || h.includes("sku") || h.includes("article"));
      const nameIdx = headers.findIndex(h => h.includes("nom") || h.includes("name") || h.includes("désig") || h.includes("produit") || h.includes("label"));

      if (refIdx === -1 && data.length > 1) {
        // Pas d'en-tête détecté → prendre la 1ère colonne
      }

      const colRef = refIdx >= 0 ? refIdx : 0;
      const colName = nameIdx >= 0 ? nameIdx : -1;

      const newRefs: DashRef[] = [];
      for (let i = 1; i < data.length; i++) {
        const row = data[i];
        const ref = String(row[colRef] ?? "").trim();
        if (!ref) continue;
        const product_name = colName >= 0 ? String(row[colName] ?? "").trim() : "";
        newRefs.push({ ref, product_name });
      }

      if (newRefs.length === 0) { showToast("Aucune référence trouvée dans le fichier"); return; }

      // Remplacer toutes les refs
      await deleteAllRefs();
      await saveRefs(newRefs);
      setRefs(newRefs);
      showToast(`✓ ${newRefs.length} références importées`);

      if (session) await syncData(session, newRefs, thresholds, supplierDates);
    } catch (err: any) {
      showToast("Erreur import: " + err.message);
    } finally {
      setUploadLoading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  // Save threshold inline
  const commitThreshold = async (ref: string, val: string, name: string) => {
    const n = parseFloat(val);
    if (isNaN(n) || n < 0) { setEditThreshold(null); return; }
    const newThr = { ...thresholds, [ref]: n };
    setThresholds(newThr);
    setRows(r => r.map(row => {
      if (row.ref !== ref) return row;
      const updated = { ...row, threshold: n };
      updated.status = computeStatus(updated);
      return updated;
    }));
    setEditThreshold(null);
    try { await saveThresholdSupa(ref, n, name); } catch { showToast("Erreur sauvegarde seuil"); }
  };

  // Save supplier date
  const commitSupplierDate = async () => {
    if (!supplierModal) return;
    const { ref, name } = supplierModal;
    const dateVal = supplierInput || null;
    const newDates = { ...supplierDates, [ref]: dateVal };
    setSupplierDates(newDates);
    setRows(r => r.map(row => {
      if (row.ref !== ref) return row;
      const { date: delivDate, label: delivLabel } = nextDelivery(dateVal);
      const days_until_delivery = Math.max(0, daysUntil(delivDate));
      const updated = { ...row, supplier_date: dateVal, days_until_delivery, next_delivery_label: delivLabel };
      updated.status = computeStatus(updated);
      return updated;
    }));
    setSupplierModal(null);
    setSupplierInput("");
    try { await saveSupplierDate(ref, dateVal); showToast(dateVal ? `Date rupture enregistrée pour ${ref}` : `Rupture effacée pour ${ref}`); } catch { showToast("Erreur sauvegarde"); }
  };

  // Sort
  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("asc"); }
  };

  // Filtered + sorted rows
  const filteredRows = useMemo(() => {
    const statusOrder: Record<DashRow["status"], number> = { critical: 0, alert: 1, no_data: 2, ok: 3, not_found: 4 };
    let res = rows.filter(r => {
      if (filter === "critical" && r.status !== "critical") return false;
      if (filter === "alert" && r.status !== "alert") return false;
      if (filter === "ok" && (r.status !== "ok" && r.status !== "no_data")) return false;
      if (search) {
        const q = search.toLowerCase();
        if (!r.ref.toLowerCase().includes(q) && !r.name.toLowerCase().includes(q)) return false;
      }
      return true;
    });
    res = [...res].sort((a, b) => {
      let va: any, vb: any;
      if (sortKey === "status") { va = statusOrder[a.status]; vb = statusOrder[b.status]; }
      else if (sortKey === "ref") { va = a.ref; vb = b.ref; }
      else if (sortKey === "name") { va = a.name; vb = b.name; }
      else { va = (a as any)[sortKey] ?? 0; vb = (b as any)[sortKey] ?? 0; }
      if (va < vb) return sortDir === "asc" ? -1 : 1;
      if (va > vb) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
    return res;
  }, [rows, filter, search, sortKey, sortDir]);

  const counts = useMemo(() => ({
    total: rows.filter(r => r.status !== "not_found").length,
    critical: rows.filter(r => r.status === "critical").length,
    alert: rows.filter(r => r.status === "alert").length,
    ok: rows.filter(r => r.status === "ok").length,
    not_found: rows.filter(r => r.status === "not_found").length,
  }), [rows]);

  // ─────────── Styles ───────────
  const C = {
    bg: "#f8fafc", card: "#ffffff", border: "#e2e8f0",
    text: "#0f172a", textSec: "#64748b",
    red: "#ef4444", amber: "#f59e0b", green: "#22c55e", blue: "#3b82f6",
  };

  // ─────────── LOGIN SCREEN ───────────
  if (!session) {
    return (
      <div style={{ minHeight: "100vh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Inter', system-ui, sans-serif" }}>
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 16, padding: 40, width: 360, boxShadow: "0 4px 24px rgba(0,0,0,0.07)" }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: C.text, marginBottom: 6 }}>📦 Stock Monitor</div>
          <div style={{ fontSize: 13, color: C.textSec, marginBottom: 28 }}>Connexion Odoo</div>
          <form onSubmit={handleLogin} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {[
              { label: "URL Odoo", key: "url", placeholder: "https://mon-odoo.com" },
              { label: "Base de données", key: "db", placeholder: "ma-base" },
              { label: "Login", key: "login", placeholder: "utilisateur@email.com" },
              { label: "Mot de passe", key: "password", type: "password", placeholder: "••••••••" },
            ].map(({ label, key, placeholder, type }) => (
              <label key={key} style={{ fontSize: 12, fontWeight: 600, color: C.textSec, display: "flex", flexDirection: "column", gap: 4 }}>
                {label}
                <input
                  type={type || "text"} placeholder={placeholder}
                  value={(loginForm as any)[key]}
                  onChange={e => setLoginForm(f => ({ ...f, [key]: e.target.value }))}
                  style={{ padding: "10px 12px", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", outline: "none" }}
                />
              </label>
            ))}
            {loginErr && <div style={{ fontSize: 12, color: C.red, background: "#fef2f2", padding: "8px 12px", borderRadius: 6 }}>{loginErr}</div>}
            <button type="submit" disabled={loginLoading}
              style={{ padding: "12px 0", background: C.blue, color: "#fff", border: "none", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: loginLoading ? "not-allowed" : "pointer", fontFamily: "inherit", marginTop: 4 }}>
              {loginLoading ? "Connexion..." : "Se connecter"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  // ─────────── SortHeader component ───────────
  const SortTh = ({ label, k, style }: { label: string; k: SortKey; style?: React.CSSProperties }) => (
    <th onClick={() => toggleSort(k)} style={{ padding: "10px 12px", textAlign: "left", fontSize: 11, fontWeight: 700, color: C.textSec, cursor: "pointer", userSelect: "none", whiteSpace: "nowrap", background: "#f8fafc", borderBottom: `1px solid ${C.border}`, ...style }}>
      {label} {sortKey === k ? (sortDir === "asc" ? "↑" : "↓") : ""}
    </th>
  );

  // ─────────── DASHBOARD ───────────
  return (
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: "'Inter', system-ui, sans-serif", color: C.text }}>
      {/* Toast */}
      {toast && (
        <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", background: "#1e293b", color: "#fff", padding: "10px 20px", borderRadius: 10, fontSize: 13, zIndex: 9999, boxShadow: "0 4px 16px rgba(0,0,0,0.2)" }}>
          {toast}
        </div>
      )}

      {/* Supplier date modal */}
      {supplierModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, padding: 28, width: 340, boxShadow: "0 8px 32px rgba(0,0,0,0.15)" }}>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>📅 Rupture fournisseur</div>
            <div style={{ fontSize: 12, color: C.textSec, marginBottom: 18 }}>{supplierModal.ref} — {supplierModal.name}</div>
            <label style={{ fontSize: 12, fontWeight: 600, color: C.textSec, display: "flex", flexDirection: "column", gap: 6 }}>
              Date de prochaine dispo fournisseur
              <input type="date" value={supplierInput}
                onChange={e => setSupplierInput(e.target.value)}
                style={{ padding: "10px 12px", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit" }}
              />
            </label>
            <div style={{ fontSize: 11, color: C.textSec, marginTop: 8 }}>
              Laisse vide pour revenir à la livraison standard (15 du mois prochain).
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 20 }}>
              <button onClick={() => { setSupplierModal(null); setSupplierInput(""); }}
                style={{ flex: 1, padding: "10px 0", border: `1px solid ${C.border}`, borderRadius: 8, background: C.card, cursor: "pointer", fontSize: 13, fontFamily: "inherit" }}>
                Annuler
              </button>
              <button onClick={commitSupplierDate}
                style={{ flex: 2, padding: "10px 0", background: C.blue, color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 700, fontFamily: "inherit" }}>
                Enregistrer
              </button>
            </div>
            {supplierModal.current && (
              <button onClick={() => { setSupplierInput(""); commitSupplierDate(); }}
                style={{ width: "100%", marginTop: 8, padding: "8px 0", background: "#fef2f2", color: C.red, border: `1px solid #fecaca`, borderRadius: 8, cursor: "pointer", fontSize: 12, fontFamily: "inherit" }}>
                Effacer la date de rupture
              </button>
            )}
          </div>
        </div>
      )}

      {/* Header */}
      <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, padding: "0 24px", display: "flex", alignItems: "center", gap: 16, height: 56 }}>
        <div style={{ fontSize: 16, fontWeight: 800 }}>📦 Stock Monitor</div>
        <div style={{ flex: 1 }} />
        {lastSync && <div style={{ fontSize: 11, color: C.textSec }}>Sync {lastSync.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</div>}
        <button onClick={() => session && loadAll(session)} disabled={loading}
          style={{ padding: "7px 14px", border: `1px solid ${C.border}`, borderRadius: 8, background: C.card, cursor: loading ? "not-allowed" : "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit", display: "flex", alignItems: "center", gap: 6 }}>
          {loading ? "⏳" : "🔄"} {loading ? loadMsg || "Chargement..." : "Actualiser"}
        </button>
        <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" onChange={handleExcelUpload} style={{ display: "none" }} />
        <button onClick={() => fileInputRef.current?.click()} disabled={uploadLoading || loading}
          style={{ padding: "7px 14px", background: C.blue, color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 12, fontWeight: 700, fontFamily: "inherit" }}>
          {uploadLoading ? "Import..." : "📤 Importer Excel"}
        </button>
        <button onClick={() => { localStorage.removeItem("wms_dash_s"); setSession(null); }}
          style={{ padding: "7px 14px", border: `1px solid ${C.border}`, borderRadius: 8, background: C.card, cursor: "pointer", fontSize: 12, color: C.textSec, fontFamily: "inherit" }}>
          Déco
        </button>
      </div>

      <div style={{ padding: "20px 24px", maxWidth: 1400, margin: "0 auto" }}>
        {/* KPI cards */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 20 }}>
          {[
            { label: "Références", val: refs.length, sub: `${counts.not_found} introuvables`, color: C.blue, bg: "#eff6ff" },
            { label: "🔴 Critiques", val: counts.critical, sub: "rupture avant livraison", color: C.red, bg: "#fef2f2", filter: "critical" as StatusFilter },
            { label: "🟡 Alertes", val: counts.alert, sub: "stock bas ou sous seuil", color: C.amber, bg: "#fffbeb", filter: "alert" as StatusFilter },
            { label: "🟢 OK", val: counts.ok, sub: "stock suffisant", color: C.green, bg: "#f0fdf4", filter: "ok" as StatusFilter },
          ].map(({ label, val, sub, color, bg, filter: f }) => (
            <div key={label} onClick={() => f && setFilter(prev => prev === f ? "all" : f)}
              style={{ background: bg, border: `1px solid ${color}22`, borderRadius: 12, padding: "16px 20px", cursor: f ? "pointer" : "default", transition: "transform 0.1s", ...(filter === f ? { boxShadow: `0 0 0 2px ${color}` } : {}) }}>
              <div style={{ fontSize: 11, fontWeight: 700, color, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
              <div style={{ fontSize: 32, fontWeight: 900, color, lineHeight: 1.2 }}>{val}</div>
              <div style={{ fontSize: 11, color }}>{sub}</div>
            </div>
          ))}
        </div>

        {/* No refs state */}
        {refs.length === 0 && !loading && (
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, padding: 48, textAlign: "center" }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>📋</div>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>Aucune référence chargée</div>
            <div style={{ fontSize: 13, color: C.textSec, marginBottom: 20 }}>Importe ton fichier Excel avec la liste des ~350 références à surveiller.</div>
            <div style={{ fontSize: 12, color: C.textSec, background: "#f8fafc", border: `1px solid ${C.border}`, borderRadius: 8, padding: "12px 16px", display: "inline-block", textAlign: "left" }}>
              <strong>Format attendu :</strong> une colonne "Ref" (ou "Code", "SKU"…) avec les références Odoo.<br />
              Une colonne "Nom" (optionnelle) avec le nom du produit.
            </div>
          </div>
        )}

        {/* Filter bar */}
        {refs.length > 0 && (
          <>
            <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center" }}>
              {([["all", "Tout"], ["critical", "Critiques"], ["alert", "Alertes"], ["ok", "OK"]] as [StatusFilter, string][]).map(([f, label]) => (
                <button key={f} onClick={() => setFilter(f)}
                  style={{ padding: "6px 14px", borderRadius: 20, border: `1px solid ${filter === f ? C.blue : C.border}`, background: filter === f ? C.blue : C.card, color: filter === f ? "#fff" : C.textSec, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
                  {label}
                </button>
              ))}
              <div style={{ flex: 1 }} />
              <input
                placeholder="🔍 Rechercher ref ou nom..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                style={{ padding: "7px 12px", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 13, fontFamily: "inherit", width: 240, outline: "none" }}
              />
              <div style={{ fontSize: 12, color: C.textSec }}>{filteredRows.length} ligne{filteredRows.length !== 1 ? "s" : ""}</div>
            </div>

            {/* Table */}
            <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, overflow: "hidden" }}>
              <div style={{ overflowX: "auto", maxHeight: "calc(100vh - 320px)", overflowY: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead style={{ position: "sticky", top: 0, zIndex: 10 }}>
                    <tr>
                      <SortTh label="Référence" k="ref" />
                      <SortTh label="Nom produit" k="name" style={{ minWidth: 200 }} />
                      <SortTh label="Stock" k="stock" style={{ textAlign: "right" as const }} />
                      <SortTh label="Conso/mois" k="conso_avg" style={{ textAlign: "right" as const }} />
                      <th style={{ padding: "10px 12px", textAlign: "right", fontSize: 11, fontWeight: 700, color: C.textSec, background: "#f8fafc", borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap" }}>
                        Seuil min ✏️
                      </th>
                      <SortTh label="Jours restants" k="days_remaining" style={{ textAlign: "right" as const }} />
                      <th style={{ padding: "10px 12px", fontSize: 11, fontWeight: 700, color: C.textSec, background: "#f8fafc", borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap" }}>
                        Prochaine livraison
                      </th>
                      <SortTh label="Statut" k="status" />
                      <th style={{ padding: "10px 12px", fontSize: 11, fontWeight: 700, color: C.textSec, background: "#f8fafc", borderBottom: `1px solid ${C.border}` }}>
                        Rupture
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRows.map((row, i) => {
                      const isEven = i % 2 === 0;
                      const rowBg = row.status === "critical" ? "#fff5f5" : row.status === "alert" ? "#fffdf0" : isEven ? C.card : "#fafafa";
                      const daysColor = row.status === "critical" ? C.red : row.status === "alert" ? C.amber : C.text;
                      return (
                        <tr key={row.ref} style={{ background: rowBg, borderBottom: `1px solid ${C.border}` }}>
                          {/* Ref */}
                          <td style={{ padding: "10px 12px", fontWeight: 700, fontFamily: "monospace", fontSize: 12 }}>{row.ref}</td>
                          {/* Nom */}
                          <td style={{ padding: "10px 12px", color: row.status === "not_found" ? C.textSec : C.text, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {row.name}
                          </td>
                          {/* Stock */}
                          <td style={{ padding: "10px 12px", textAlign: "right", fontWeight: 600 }}>
                            {row.status === "not_found" ? "—" : row.stock}
                          </td>
                          {/* Conso */}
                          <td style={{ padding: "10px 12px", textAlign: "right", color: C.textSec }}>
                            {row.status === "not_found" ? "—" : row.conso_avg === 0 ? <span style={{ color: C.textSec, fontSize: 11 }}>n/a</span> : row.conso_avg}
                          </td>
                          {/* Seuil — éditable */}
                          <td style={{ padding: "6px 12px", textAlign: "right" }}>
                            {row.status === "not_found" ? "—" : editThreshold?.ref === row.ref ? (
                              <input
                                autoFocus
                                type="number" value={editThreshold.val}
                                onChange={e => setEditThreshold(t => t ? { ...t, val: e.target.value } : t)}
                                onBlur={() => commitThreshold(row.ref, editThreshold.val, row.name)}
                                onKeyDown={e => { if (e.key === "Enter") commitThreshold(row.ref, editThreshold.val, row.name); if (e.key === "Escape") setEditThreshold(null); }}
                                style={{ width: 64, padding: "4px 8px", border: `1px solid ${C.blue}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", textAlign: "right", outline: "none" }}
                              />
                            ) : (
                              <button onClick={() => setEditThreshold({ ref: row.ref, val: String(row.threshold) })}
                                style={{ background: "transparent", border: `1px dashed ${C.border}`, borderRadius: 6, padding: "3px 10px", cursor: "pointer", fontSize: 13, fontFamily: "inherit", color: C.text, minWidth: 48 }}>
                                {row.threshold}
                              </button>
                            )}
                          </td>
                          {/* Jours restants */}
                          <td style={{ padding: "10px 12px", textAlign: "right", fontWeight: 700, color: daysColor }}>
                            {row.status === "not_found" ? "—" : row.days_remaining >= 999 ? "∞" : `${row.days_remaining}j`}
                          </td>
                          {/* Prochaine livraison */}
                          <td style={{ padding: "10px 12px", fontSize: 12 }}>
                            <span style={{
                              display: "inline-flex", alignItems: "center", gap: 4,
                              color: row.supplier_date ? C.red : C.textSec,
                              fontWeight: row.supplier_date ? 700 : 400
                            }}>
                              {row.supplier_date && "⚠️ "}{row.next_delivery_label}
                              {row.status !== "not_found" && <span style={{ color: C.textSec, fontWeight: 400 }}> ({row.days_until_delivery}j)</span>}
                            </span>
                          </td>
                          {/* Statut */}
                          <td style={{ padding: "10px 12px" }}>
                            <span style={{
                              display: "inline-block", padding: "3px 10px", borderRadius: 20,
                              background: STATUS_BG[row.status], color: STATUS_COLOR[row.status],
                              fontSize: 11, fontWeight: 700, border: `1px solid ${STATUS_COLOR[row.status]}44`
                            }}>
                              {STATUS_LABEL[row.status]}
                            </span>
                          </td>
                          {/* Action rupture */}
                          <td style={{ padding: "8px 12px" }}>
                            {row.status !== "not_found" && (
                              <button
                                onClick={() => { setSupplierModal({ ref: row.ref, name: row.name, current: row.supplier_date || "" }); setSupplierInput(row.supplier_date || ""); }}
                                style={{
                                  padding: "4px 10px", border: `1px solid ${row.supplier_date ? C.red : C.border}`,
                                  borderRadius: 6, background: row.supplier_date ? "#fef2f2" : C.card,
                                  color: row.supplier_date ? C.red : C.textSec, cursor: "pointer", fontSize: 11, fontFamily: "inherit",
                                }}>
                                {row.supplier_date ? "📅 Modifier" : "📅 Rupture"}
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                    {filteredRows.length === 0 && (
                      <tr>
                        <td colSpan={9} style={{ padding: 40, textAlign: "center", color: C.textSec, fontSize: 13 }}>
                          {loading ? "Chargement..." : "Aucun résultat pour ce filtre"}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Legend */}
            <div style={{ display: "flex", gap: 20, marginTop: 12, fontSize: 11, color: C.textSec }}>
              <span>🔴 <strong>Critique</strong> : rupture avant la prochaine livraison</span>
              <span>🟡 <strong>Alerte</strong> : stock bas (&lt;14j de marge) ou sous le seuil minimum</span>
              <span>🟢 <strong>OK</strong> : stock suffisant jusqu'à la prochaine livraison</span>
              <span style={{ marginLeft: "auto" }}>Seuils cliquables pour édition • Livraison standard : 15 du mois prochain</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
