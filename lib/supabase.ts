// lib/supabase.ts
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const sb = createClient(url, key);

// ── Helper: paginated select pour contourner le cap 1000 lignes de Supabase ─────
// Usage: await fetchAllPaginated(() => sb.from("wms_conso_cache").select("..."))
//        await fetchAllPaginated((from,to) => sb.from("...").select("...").in("month",x).order("odoo_ref").range(from,to))
async function fetchAllPaginated<T = any>(
  builder: (from: number, to: number) => any,
  pageSize = 1000,
): Promise<T[]> {
  const out: T[] = [];
  let from = 0;
  // Boucle jusqu'à ce que la dernière page soit < pageSize (= fin)
  while (true) {
    const to = from + pageSize - 1;
    const { data, error } = await builder(from, to);
    if (error) throw new Error(error.message);
    const rows: T[] = data || [];
    out.push(...rows);
    if (rows.length < pageSize) break;
    from += pageSize;
    if (from > 100000) break; // garde-fou — jamais plus de 100k lignes
  }
  return out;
}

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
  // Paginé : Supabase cape à 1000 lignes par défaut
  const rows = await fetchAllPaginated<{ odoo_ref: string; threshold: number }>(
    (from, to) => sb.from("wms_thresholds").select("odoo_ref, threshold").order("odoo_ref").range(from, to)
  );
  return Object.fromEntries(rows.map((r) => [r.odoo_ref, r.threshold]));
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
  return await fetchAllPaginated<WmsStockCache>(
    (from, to) => sb.from("wms_stock_cache").select("*").order("odoo_ref").range(from, to)
  );
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
  // Paginé : avec 308 refs × 12 mois ≈ 3500 lignes, le cap 1000 de Supabase tronque
  return await fetchAllPaginated<WmsConsoCache>(
    (from, to) => sb.from("wms_conso_cache").select("*").in("month", months).order("odoo_ref").range(from, to)
  );
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

// ══════════════════════════════════════════
// INVENTAIRE TOURNANT (cross-device)
// ══════════════════════════════════════════

// Une ligne comptée. Le théorique Odoo est rapatriré au moment du "matching".
export interface WmsInventoryEntry {
  // Identité produit / lot comptés
  productId: number;
  productName: string;
  odooRef: string;          // default_code
  barcode: string;
  lotId: number | null;
  lotName: string;          // "" si pas de lot
  locationId: number | null;
  locationName: string;     // "" si mode scan libre
  // Saisie
  colis: number;            // nombre de colis
  unitsPerColis: number;    // unités par colis (product.packaging.qty), 0 si inconnu
  vrac: number;             // unités en vrac
  // Calculé / matching (rempli au moment du matching)
  counted: number;          // colis * unitsPerColis + vrac
  theoretical?: number;     // stock Odoo au moment du matching
  quantId?: number | null;  // id du stock.quant correspondant (pour appliquer la correction)
  quantQty?: number;        // qty propre du quant cible (scan libre → appliquer un DELTA, pas l'absolu)
  matchedAt?: string;       // ISO date du dernier matching
}

export interface WmsInventorySession {
  id: string;
  name: string;
  date: string;
  mode: "location" | "scan";
  status: "open" | "closed";
  entries: WmsInventoryEntry[];
  created_at: string;
  updated_at: string;
}

export async function loadInventorySessions(): Promise<WmsInventorySession[]> {
  const { data, error } = await sb
    .from("wms_inventory_sessions")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  return (data || []) as WmsInventorySession[];
}

export async function createInventorySession(name: string, mode: "location" | "scan"): Promise<WmsInventorySession> {
  const date = new Date().toISOString().slice(0, 10);
  const { data, error } = await sb
    .from("wms_inventory_sessions")
    .insert({ name, date, mode, entries: [] })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data as WmsInventorySession;
}

export async function updateInventoryEntries(id: string, entries: WmsInventoryEntry[]): Promise<void> {
  const { error } = await sb
    .from("wms_inventory_sessions")
    .update({ entries, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(error.message);
}

export async function setInventoryStatus(id: string, status: "open" | "closed"): Promise<void> {
  const { error } = await sb
    .from("wms_inventory_sessions")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(error.message);
}

export async function deleteInventorySession(id: string): Promise<void> {
  const { error } = await sb.from("wms_inventory_sessions").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

// ══════════════════════════════════════════
// CARTONS D'EMBALLAGE (partagés via wms_sync_meta, communs à tous les postes)
// ══════════════════════════════════════════
export interface CartonDims { l: string; w: string; h: string; }
export interface CartonsConfig { petit: CartonDims; grand: CartonDims; petitCm3: number; grandCm3: number; }
const cartonCm3 = (d: CartonDims) => (parseFloat(d.l) || 0) * (parseFloat(d.w) || 0) * (parseFloat(d.h) || 0);

export async function getCartonsConfig(): Promise<CartonsConfig> {
  const empty = { l: "", w: "", h: "" };
  try {
    const { data } = await sb.from("wms_sync_meta").select("value").eq("key", "cartons").single();
    if (data?.value) {
      const o = JSON.parse(data.value);
      const petit = o.petit || empty;
      const grand = o.grand || empty;
      return { petit, grand, petitCm3: cartonCm3(petit), grandCm3: cartonCm3(grand) };
    }
  } catch {}
  return { petit: empty, grand: empty, petitCm3: 0, grandCm3: 0 };
}

export async function saveCartonsConfig(petit: CartonDims, grand: CartonDims): Promise<void> {
  const { error } = await sb.from("wms_sync_meta").upsert(
    { key: "cartons", value: JSON.stringify({ petit, grand }), updated_at: new Date().toISOString() },
    { onConflict: "key" }
  );
  if (error) throw new Error(error.message);
}

// ══════════════════════════════════════════
// MAPPING MANUEL Shopware → Odoo (corrections mémorisées, partagées)
// { [refShopware]: { productId, odooRef, productName } }
// ══════════════════════════════════════════
export type EshopMappingOverrides = Record<string, { productId: number; odooRef: string; productName: string }>;

export async function getEshopMappingOverrides(): Promise<EshopMappingOverrides> {
  try {
    const { data } = await sb.from("wms_sync_meta").select("value").eq("key", "eshop_mapping").single();
    if (data?.value) return JSON.parse(data.value);
  } catch {}
  return {};
}

export async function saveEshopMappingOverride(ref: string, productId: number, odooRef: string, productName: string): Promise<void> {
  const current = await getEshopMappingOverrides();
  current[ref] = { productId, odooRef, productName };
  const { error } = await sb.from("wms_sync_meta").upsert(
    { key: "eshop_mapping", value: JSON.stringify(current), updated_at: new Date().toISOString() },
    { onConflict: "key" }
  );
  if (error) throw new Error(error.message);
}

// ══════════════════════════════════════════
// RÉFS "SERVICE" (carte cadeau, etc.) — vues à part, hors champ principal
// ══════════════════════════════════════════
export async function getServiceRefs(): Promise<string[]> {
  try {
    const { data } = await sb.from("wms_sync_meta").select("value").eq("key", "eshop_service_refs").single();
    if (data?.value) return JSON.parse(data.value);
  } catch {}
  return [];
}
export async function addServiceRef(ref: string): Promise<void> {
  const list = await getServiceRefs();
  if (!list.includes(ref)) list.push(ref);
  const { error } = await sb.from("wms_sync_meta").upsert(
    { key: "eshop_service_refs", value: JSON.stringify(list), updated_at: new Date().toISOString() },
    { onConflict: "key" }
  );
  if (error) throw new Error(error.message);
}

// ══════════════════════════════════════════
// STOCK CHARIOT eShop (compteur géré dans l'app, par SKU) — partagé via wms_sync_meta
// ══════════════════════════════════════════
export type ChariotStock = Record<string, number>; // sku → quantité restante

export async function getChariotStock(): Promise<ChariotStock> {
  try {
    const { data } = await sb.from("wms_sync_meta").select("value").eq("key", "eshop_chariot_stock").single();
    if (data?.value) return JSON.parse(data.value);
  } catch {}
  return {};
}

export async function saveChariotStock(stock: ChariotStock): Promise<void> {
  const { error } = await sb.from("wms_sync_meta").upsert(
    { key: "eshop_chariot_stock", value: JSON.stringify(stock), updated_at: new Date().toISOString() },
    { onConflict: "key" }
  );
  if (error) throw new Error(error.message);
}

// Définit le stock d'un SKU (valeur absolue).
export async function setChariotStock(sku: string, qty: number): Promise<ChariotStock> {
  const stock = await getChariotStock();
  stock[sku] = Math.max(0, Math.round(qty));
  await saveChariotStock(stock);
  return stock;
}

// Décrémente plusieurs SKU d'un coup (lors d'une sortie e-shop).
// Renvoie { stock, shortages } — shortages = SKU dont le stock était insuffisant.
export async function decrementChariotStock(
  deductions: { sku: string; qty: number }[]
): Promise<{ stock: ChariotStock; shortages: { sku: string; demande: number; dispo: number }[] }> {
  const stock = await getChariotStock();
  const shortages: { sku: string; demande: number; dispo: number }[] = [];
  for (const d of deductions) {
    const dispo = stock[d.sku] ?? 0;
    if (d.qty > dispo) shortages.push({ sku: d.sku, demande: d.qty, dispo });
    stock[d.sku] = Math.max(0, dispo - d.qty); // ne descend jamais sous 0
  }
  await saveChariotStock(stock);
  return { stock, shortages };
}

// ══════════════════════════════════════════
// CACHE MAPPING AUTO (réf Shopware → produit Odoo) — évite de relancer le matching
// ══════════════════════════════════════════
export type EshopMappingCache = Record<string, { product_id: number; default_code: string; product_name: string }>;

export async function getEshopMappingCache(): Promise<EshopMappingCache> {
  try {
    const { data } = await sb.from("wms_sync_meta").select("value").eq("key", "eshop_mapping_cache").single();
    if (data?.value) return JSON.parse(data.value);
  } catch {}
  return {};
}

export async function saveEshopMappingCache(cache: EshopMappingCache): Promise<void> {
  const { error } = await sb.from("wms_sync_meta").upsert(
    { key: "eshop_mapping_cache", value: JSON.stringify(cache), updated_at: new Date().toISOString() },
    { onConflict: "key" }
  );
  if (error) throw new Error(error.message);
}

// ══════════════════════════════════════════
// GARDE-FOU : commandes e-shop déjà sorties (devis créé) — anti double déduction
// Table wms_eshop_processed : { order_number, devis, processed_at }
// ══════════════════════════════════════════
export async function getProcessedEshopOrders(orderNumbers: string[]): Promise<Set<string>> {
  if (!orderNumbers.length) return new Set();
  const { data } = await sb.from("wms_eshop_processed").select("order_number").in("order_number", orderNumbers);
  return new Set((data || []).map((r: any) => r.order_number));
}

export async function markEshopOrdersProcessed(orderNumbers: string[], devis: string): Promise<void> {
  if (!orderNumbers.length) return;
  const rows = orderNumbers.map(n => ({ order_number: n, devis, processed_at: new Date().toISOString() }));
  const { error } = await sb.from("wms_eshop_processed").upsert(rows, { onConflict: "order_number" });
  if (error) throw new Error(error.message);
}

// ══════════════════════════════════════════
// IMPORT MARKETPLACE IMPARFAITE — garde-fou anti-doublon (réfs de commande déjà importées)
// Réutilise la table wms_eshop_processed avec un préfixe "IMP:" pour ne pas mélanger.
// ══════════════════════════════════════════
const IMP_PREFIX = "IMP:";
export async function getProcessedImparfaiteOrders(orderRefs: string[]): Promise<Set<string>> {
  if (!orderRefs.length) return new Set();
  const keys = orderRefs.map(r => IMP_PREFIX + r);
  const { data } = await sb.from("wms_eshop_processed").select("order_number").in("order_number", keys);
  // on renvoie les réfs SANS préfixe
  return new Set((data || []).map((r: any) => String(r.order_number).slice(IMP_PREFIX.length)));
}
export async function markImparfaiteProcessed(orderRefs: string[], odooOrder: string): Promise<void> {
  if (!orderRefs.length) return;
  const rows = orderRefs.map(r => ({ order_number: IMP_PREFIX + r, devis: odooOrder, processed_at: new Date().toISOString() }));
  const { error } = await sb.from("wms_eshop_processed").upsert(rows, { onConflict: "order_number" });
  if (error) throw new Error(error.message);
}

// ══════════════════════════════════════════
// NOTIFICATIONS (cloche header — partagées entre postes)
// ══════════════════════════════════════════

export interface WmsNotification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  meta: any;
  created_at: string;
}

/** Enregistre une notification (ex : substitution de lot en préparation). */
export async function createNotification(n: { type?: string; title: string; body?: string; meta?: any }): Promise<void> {
  const { error } = await sb.from("wms_notifications").insert({
    type: n.type || "lot_substitution",
    title: n.title,
    body: n.body ?? null,
    meta: n.meta ?? null,
  });
  if (error) throw new Error(error.message);
}

/** Charge les notifications du jour (depuis minuit), les plus récentes d'abord. */
export async function loadTodayNotifications(): Promise<WmsNotification[]> {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const { data, error } = await sb
    .from("wms_notifications")
    .select("*")
    .gte("created_at", start.toISOString())
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(error.message);
  return (data || []) as WmsNotification[];
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
  // Paginé : Supabase cape à 1000 lignes par défaut, et avec 308 refs × 12 mois ≈ 3500 lignes
  // la moyenne calculée tombait à 0 pour les refs hors des 1000 premières lignes → conso "n/a"
  const data = await fetchAllPaginated<{ odoo_ref: string; month: string; qty: number }>(
    (from, to) => sb.from("wms_conso_cache").select("odoo_ref, month, qty").in("month", Array.from(validMonths)).order("odoo_ref").range(from, to)
  );
  const byRef: Record<string, { total: number; months: Set<string> }> = {};
  for (const r of data) {
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
  const rows = await fetchAllPaginated<{ odoo_ref: string; avg_monthly: number }>(
    (from, to) => sb.from("wms_dlv_avg").select("odoo_ref, avg_monthly").order("odoo_ref").range(from, to)
  );
  return Object.fromEntries(rows.map(r => [r.odoo_ref, r.avg_monthly || 0]));
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
