// lib/supabase.ts
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const sb = createClient(url, key);

// ── Types ──────────────────────────────────────────────────────────────────────
export interface WmsThreshold {
  odoo_ref: string;
  threshold: number;
  product_name: string;
  updated_at?: string;
}
export interface WmsStockCache {
  odoo_product_id: number;
  odoo_ref: string;
  product_name: string;
  qty_on_hand: number;
  synced_at?: string;
}
export interface WmsConsoCache {
  odoo_ref: string;
  product_name: string;
  month: string;
  qty: number;
  synced_at?: string;
}

// ══════════════════════════════════════════
// SEUILS
// ══════════════════════════════════════════

export async function loadThresholds(): Promise<Record<string, number>> {
  const { data, error } = await sb.from("wms_thresholds").select("odoo_ref, threshold");
  if (error) throw new Error(error.message);
  return Object.fromEntries((data || []).map((r) => [r.odoo_ref, r.threshold]));
}

export async function saveThreshold(odoo_ref: string, threshold: number, product_name: string): Promise<void> {
  const { error } = await sb.from("wms_thresholds").upsert({ odoo_ref, threshold, product_name, updated_at: new Date().toISOString() }, { onConflict: "odoo_ref" });
  if (error) throw new Error(error.message);
}

export async function deleteThreshold(odoo_ref: string): Promise<void> {
  const { error } = await sb.from("wms_thresholds").delete().eq("odoo_ref", odoo_ref);
  if (error) throw new Error(error.message);
}

export async function saveThresholdsBulk(thresholds: WmsThreshold[]): Promise<void> {
  if (!thresholds.length) return;
  const now = new Date().toISOString();
  for (let i = 0; i < thresholds.length; i += 500) {
    const batch = thresholds.slice(i, i + 500);
    const { error } = await sb.from("wms_thresholds").upsert(
      batch.map(t => ({ ...t, updated_at: now })),
      { onConflict: "odoo_ref" }
    );
    if (error) throw new Error(error.message);
  }
}

// ══════════════════════════════════════════
// STOCK CACHE
// ══════════════════════════════════════════

export async function loadStockCache(): Promise<WmsStockCache[]> {
  const { data, error } = await sb.from("wms_stock_cache").select("*").order("odoo_ref");
  if (error) throw new Error(error.message);
  return data || [];
}

export async function getStockCacheAge(): Promise<Date | null> {
  const { data } = await sb.from("wms_sync_meta").select("value").eq("key", "stock_synced_at").single();
  return data?.value ? new Date(data.value) : null;
}

export async function saveStockCache(items: WmsStockCache[]): Promise<void> {
  if (!items.length) return;
  // Upsert in batches of 500
  for (let i = 0; i < items.length; i += 500) {
    const batch = items.slice(i, i + 500);
    const { error } = await sb.from("wms_stock_cache").upsert(
      batch.map((item) => ({ ...item, synced_at: new Date().toISOString() })),
      { onConflict: "odoo_product_id" }
    );
    if (error) throw new Error(error.message);
  }
  // Update sync metadata
  await sb.from("wms_sync_meta").upsert(
    { key: "stock_synced_at", value: new Date().toISOString(), updated_at: new Date().toISOString() },
    { onConflict: "key" }
  );
}

// ══════════════════════════════════════════
// CONSO CACHE
// ══════════════════════════════════════════

export async function getCachedConsoMonthsCount(): Promise<number> {
  const { data } = await sb.from("wms_sync_meta").select("value").eq("key", "conso_months_count").single();
  return data?.value ? Number(data.value) : 0;
}

export async function loadConsoCache(months: string[]): Promise<WmsConsoCache[]> {
  const { data, error } = await sb.from("wms_conso_cache").select("*").in("month", months);
  if (error) throw new Error(error.message);
  return data || [];
}

export async function getConsoCacheAge(): Promise<Date | null> {
  const { data } = await sb.from("wms_sync_meta").select("value").eq("key", "conso_synced_at").single();
  return data?.value ? new Date(data.value) : null;
}

export async function saveConsoCache(items: WmsConsoCache[]): Promise<void> {
  if (!items.length) return;
  // Vider toute la table, puis réécrire proprement
  const { error: delError } = await sb.from("wms_conso_cache").delete().neq("odoo_ref", "");
  if (delError) throw new Error(delError.message);
  for (let i = 0; i < items.length; i += 500) {
    const batch = items.slice(i, i + 500);
    const { error } = await sb.from("wms_conso_cache").insert(
      batch.map((item) => ({ ...item, synced_at: new Date().toISOString() }))
    );
    if (error) throw new Error(error.message);
  }
  const months = Array.from(new Set(items.map(i => i.month)));
  await sb.from("wms_sync_meta").upsert([
    { key: "conso_synced_at", value: new Date().toISOString(), updated_at: new Date().toISOString() },
    { key: "conso_months_count", value: String(months.length), updated_at: new Date().toISOString() },
  ], { onConflict: "key" });
}

// ══════════════════════════════════════════
// PRINT CONFIG (partagée entre tous les postes)
// ══════════════════════════════════════════

export interface WmsPrintConfig {
  type: string;
  printer_id: number | null;
  label_width_mm: number;
  label_height_mm: number;
  updated_at?: string;
}

export async function loadPrintConfigs(): Promise<Record<string, WmsPrintConfig>> {
  const { data, error } = await sb.from("wms_print_config").select("*");
  if (error) throw new Error(error.message);
  return Object.fromEntries((data || []).map((r: WmsPrintConfig) => [r.type, r]));
}

export async function savePrintConfig(
  type: string,
  printerId: number | null,
  labelWidthMM: number,
  labelHeightMM: number
): Promise<void> {
  const { error } = await sb.from("wms_print_config").upsert(
    { type, printer_id: printerId, label_width_mm: labelWidthMM, label_height_mm: labelHeightMM, updated_at: new Date().toISOString() },
    { onConflict: "type" }
  );
  if (error) throw new Error(error.message);
}

// ══════════════════════════════════════════
// UTILS
// ══════════════════════════════════════════

// ══════════════════════════════════════════
// SCAN LIBRE SESSIONS
// ══════════════════════════════════════════

export interface WmsScanEntry {
  barcode: string;
  qty: number;
  odooRef: string;
  productName: string;
  matched: boolean;
}

export interface WmsScanSession {
  id: string;
  name: string;
  date: string;
  entries: WmsScanEntry[];
  created_at: string;
  updated_at: string;
}

export async function loadScanSessions(): Promise<WmsScanSession[]> {
  const { data, error } = await sb
    .from("wms_scan_sessions")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  return (data || []) as WmsScanSession[];
}

export async function createScanSession(name: string): Promise<WmsScanSession> {
  const date = new Date().toISOString().slice(0, 10);
  const { data, error } = await sb
    .from("wms_scan_sessions")
    .insert({ name, date, entries: [] })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data as WmsScanSession;
}

export async function updateScanSessionEntries(id: string, entries: WmsScanEntry[]): Promise<void> {
  const { error } = await sb
    .from("wms_scan_sessions")
    .update({ entries, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(error.message);
}

export async function deleteScanSession(id: string): Promise<void> {
  const { error } = await sb.from("wms_scan_sessions").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

/** Returns true if cache is older than maxAgeMinutes */
export function isCacheStale(syncedAt: Date | null, maxAgeMinutes: number): boolean {
  if (!syncedAt) return true;
  return (Date.now() - syncedAt.getTime()) > maxAgeMinutes * 60 * 1000;
}

// ══════════════════════════════════════════
// WATCHLIST
// ══════════════════════════════════════════

export interface WmsWatchlistItem {
  odoo_ref: string;
  product_name: string;
  added_at?: string;
}

export async function loadWatchlist(): Promise<Set<string>> {
  const { data, error } = await sb.from("wms_watchlist").select("odoo_ref");
  if (error) throw new Error(error.message);
  return new Set((data || []).map((r) => r.odoo_ref));
}

export async function saveWatchlist(items: WmsWatchlistItem[]): Promise<void> {
  // Replace entire watchlist
  await sb.from("wms_watchlist").delete().neq("odoo_ref", "");
  if (!items.length) return;
  const { error } = await sb.from("wms_watchlist").insert(items.map(i => ({ ...i, added_at: new Date().toISOString() })));
  if (error) throw new Error(error.message);
}

// ══════════════════════════════════════════
// AVG MONTHLY (consommation moyenne par ref)
// ══════════════════════════════════════════

export async function loadAvgMonthly(): Promise<{ avg: Record<string, number>; nbMonths: Record<string, number> }> {
  // Fenêtre fixe : 12 mois complets avant le mois courant (même fenêtre que smSyncOdoo)
  const today = new Date();
  const validMonths = new Set<string>();
  for (let i = 1; i <= 12; i++) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    validMonths.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  const { data, error } = await sb.from("wms_conso_cache").select("odoo_ref, month, qty").in("month", Array.from(validMonths));
  if (error) throw new Error(error.message);
  const byRef: Record<string, { total: number; months: Set<string> }> = {};
  for (const r of (data || [])) {
    if (!byRef[r.odoo_ref]) byRef[r.odoo_ref] = { total: 0, months: new Set() };
    byRef[r.odoo_ref].total += (r.qty || 0);
    byRef[r.odoo_ref].months.add(r.month);
  }
  const avg: Record<string, number> = {};
  const nbMonths: Record<string, number> = {};
  for (const [ref, v] of Object.entries(byRef)) {
    avg[ref] = Math.round(v.total / 12);
    nbMonths[ref] = v.months.size;
  }
  return { avg, nbMonths };
}

// ══════════════════════════════════════════
// COMMANDES FOURNISSEUR EN COURS
// ══════════════════════════════════════════

export interface WmsPendingOrder {
  id?: string;
  batch_id: string;          // identifiant du lot = "order_YYYY-MM-DD"
  supplier_ref: string;      // Article-No. fournisseur
  odoo_ref?: string | null;  // default_code Odoo (matchée via product.supplierinfo)
  product_name: string;
  qty_incoming: number;
  order_date: string;               // YYYY-MM-DD
  expected_reception_date: string;  // YYYY-MM-DD
  status: "pending" | "received";
  created_at?: string;
}

/** Remplace toutes les lignes d'un batch (même batch_id) et insère les nouvelles */
export async function savePendingOrders(orders: WmsPendingOrder[]): Promise<void> {
  if (!orders.length) return;
  await sb.from("wms_pending_orders").delete().eq("batch_id", orders[0].batch_id);
  const { error } = await sb.from("wms_pending_orders").insert(orders);
  if (error) throw new Error(error.message);
}

export async function loadPendingOrders(): Promise<WmsPendingOrder[]> {
  const { data, error } = await sb
    .from("wms_pending_orders")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data || []) as WmsPendingOrder[];
}

/** Supprime tout un batch (utilisé à la réception) */
export async function deletePendingOrderBatch(batch_id: string): Promise<void> {
  const { error } = await sb.from("wms_pending_orders").delete().eq("batch_id", batch_id);
  if (error) throw new Error(error.message);
}

// ══════════════════════════════════════════
// DLV AVG — conso mensuelle dédiée suivi DLV
// ══════════════════════════════════════════

export interface WmsDlvAvg {
  odoo_ref: string;
  avg_monthly: number;
  product_name: string;
  updated_at?: string;
}

export async function saveDlvAvg(items: WmsDlvAvg[]): Promise<void> {
  if (!items.length) return;
  // Vider toute la table, puis réécrire proprement
  await sb.from("wms_dlv_avg").delete().neq("odoo_ref", "");
  for (let i = 0; i < items.length; i += 500) {
    const batch = items.slice(i, i + 500);
    const { error } = await sb.from("wms_dlv_avg").insert(
      batch.map(item => ({ ...item, updated_at: new Date().toISOString() }))
    );
    if (error) throw new Error(error.message);
  }
  await sb.from("wms_sync_meta").upsert(
    { key: "dlv_avg_synced_at", value: new Date().toISOString(), updated_at: new Date().toISOString() },
    { onConflict: "key" }
  );
}

export async function loadDlvAvg(): Promise<Record<string, number>> {
  const { data, error } = await sb.from("wms_dlv_avg").select("odoo_ref, avg_monthly");
  if (error) throw new Error(error.message);
  return Object.fromEntries((data || []).map(r => [r.odoo_ref, r.avg_monthly || 0]));
}

export async function getDlvAvgAge(): Promise<Date | null> {
  const { data } = await sb.from("wms_sync_meta").select("value").eq("key", "dlv_avg_synced_at").single();
  return data?.value ? new Date(data.value) : null;
}

export async function saveAvgMonthlyBulk(input: { odoo_ref: string; avg_monthly: number }[] | Record<string, number>): Promise<void> {
  const items = Array.isArray(input) ? input : Object.entries(input).map(([odoo_ref, avg_monthly]) => ({ odoo_ref, avg_monthly }));
  for (let i = 0; i < items.length; i += 500) {
    const batch = items.slice(i, i + 500);
    const { error } = await sb.from("wms_avg_monthly").upsert(
      batch.map((item) => ({ ...item, updated_at: new Date().toISOString() })),
      { onConflict: "odoo_ref" }
    );
    if (error) {
      // Table might not exist, silently skip
      console.warn("saveAvgMonthlyBulk:", error.message);
      return;
    }
  }
}
