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
  // Exclure les entrées qui partagent la même table mais ne sont pas des sessions de scan :
  // prépas libres ("PREP::") et prépas collaboratives ("COPREP::").
  return (data || []).filter((d: any) => {
    const n = String(d.name || "");
    return !n.startsWith("PREP::") && !n.startsWith("COPREP::");
  }) as WmsScanSession[];
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
// PRÉPA LIBRE PARTAGÉE — réutilise wms_scan_sessions avec un nom préfixé "PRÉPA:".
// entries = lignes de prépa { ref, qty, name, location, stock, found, checked }.
// ══════════════════════════════════════════
export interface WmsPrepLine { ref: string; qty: number; name: string; location: string; stock: number; found: boolean; checked?: boolean; }
export interface WmsPrepList { id: string; name: string; date: string; entries: WmsPrepLine[]; }
const PREP_PREFIX = "PREP::"; // ASCII only (un préfixe accentué cassait le filtre .like)

export async function loadPrepLists(): Promise<WmsPrepList[]> {
  // Filtre client-side (robuste) plutôt que .like server-side.
  const { data, error } = await sb.from("wms_scan_sessions").select("*").order("created_at", { ascending: false }).limit(100);
  if (error) throw new Error(error.message);
  return (data || [])
    .filter((d: any) => String(d.name || "").startsWith(PREP_PREFIX))
    .map((d: any) => ({ ...d, name: String(d.name).slice(PREP_PREFIX.length) })) as WmsPrepList[];
}
export async function createPrepList(name: string, entries: WmsPrepLine[]): Promise<WmsPrepList> {
  const date = new Date().toISOString().slice(0, 10);
  const { data, error } = await sb.from("wms_scan_sessions").insert({ name: PREP_PREFIX + name, date, entries }).select().single();
  if (error) throw new Error(error.message);
  return { ...(data as any), name: String((data as any).name).slice(PREP_PREFIX.length) };
}
export async function updatePrepEntries(id: string, entries: WmsPrepLine[]): Promise<void> {
  const { error } = await sb.from("wms_scan_sessions").update({ entries, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) throw new Error(error.message);
}
export async function deletePrepList(id: string): Promise<void> {
  const { error } = await sb.from("wms_scan_sessions").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

// ══════════════════════════════════════════
// DROITS UTILISATEURS (par login Odoo) — qui voit quels outils
// Table wms_user_permissions : { login (text, PK), tools (jsonb = string[]), updated_at }
// ══════════════════════════════════════════

export interface WmsUserPerm { login: string; tools: string[]; }

// Charge tous les droits (map login → liste d'outils autorisés).
export async function loadUserPermissions(): Promise<Record<string, string[]>> {
  const { data, error } = await sb.from("wms_user_permissions").select("login, tools").limit(1000);
  if (error) throw new Error(error.message);
  const out: Record<string, string[]> = {};
  for (const r of (data || [])) out[String(r.login).toLowerCase()] = Array.isArray(r.tools) ? r.tools : [];
  return out;
}

// Droits d'UN utilisateur (null = aucune config enregistrée pour lui).
export async function loadUserPermission(login: string): Promise<string[] | null> {
  const { data, error } = await sb.from("wms_user_permissions")
    .select("tools").eq("login", login.toLowerCase()).limit(1);
  if (error) throw new Error(error.message);
  if (!data || !data.length) return null;
  return Array.isArray(data[0].tools) ? data[0].tools : [];
}

// Enregistre/écrase les droits d'un utilisateur.
export async function saveUserPermission(login: string, tools: string[]): Promise<void> {
  const { error } = await sb.from("wms_user_permissions")
    .upsert({ login: login.toLowerCase(), tools, updated_at: new Date().toISOString() }, { onConflict: "login" });
  if (error) throw new Error(error.message);
}

// ══════════════════════════════════════════
// PRÉPARATION COLLABORATIVE À 2 (début / fin)
// Réutilise wms_scan_sessions avec un nom préfixé "COPREP::<picking>".
// entries[0] porte tout l'état : participants + progression par ligne.
// ══════════════════════════════════════════

const COPREP_PREFIX = "COPREP::";

// Progression d'une ligne de move (clé = id de la stock.move.line).
export interface CoPrepLineState { mlId: number; qtyDone: number; by: string; at: number; }
export interface CoPrepParticipant { name: string; role: "start" | "end"; joinedAt: number; }
export interface CoPrepState {
  id: string;                 // id Supabase de la session
  picking: string;            // nom du picking (WH/PICK/…)
  participants: CoPrepParticipant[];
  lines: Record<string, CoPrepLineState>; // mlId(string) → état
  status: "open" | "done";
}

// payload stocké dans wms_scan_sessions.entries (un seul objet)
interface CoPrepPayload { picking: string; participants: CoPrepParticipant[]; lines: Record<string, CoPrepLineState>; status: "open" | "done"; }

function rowToCoPrep(d: any): CoPrepState {
  const p = (Array.isArray(d.entries) ? d.entries[0] : d.entries) as CoPrepPayload | undefined;
  return {
    id: d.id,
    picking: p?.picking || String(d.name || "").slice(COPREP_PREFIX.length),
    participants: p?.participants || [],
    lines: p?.lines || {},
    status: p?.status || "open",
  };
}

// Trouve une session collaborative ouverte pour ce picking (s'il y en a une).
export async function findCoPrep(picking: string): Promise<CoPrepState | null> {
  const name = COPREP_PREFIX + picking;
  const { data, error } = await sb.from("wms_scan_sessions")
    .select("*").eq("name", name).order("created_at", { ascending: false }).limit(1);
  if (error) throw new Error(error.message);
  if (!data || !data.length) return null;
  const st = rowToCoPrep(data[0]);
  return st.status === "done" ? null : st;
}

// Crée la session (1er préparateur = rôle "start").
export async function createCoPrep(picking: string, starterName: string): Promise<CoPrepState> {
  const payload: CoPrepPayload = {
    picking,
    participants: [{ name: starterName, role: "start", joinedAt: Date.now() }],
    lines: {},
    status: "open",
  };
  const { data, error } = await sb.from("wms_scan_sessions")
    .insert({ name: COPREP_PREFIX + picking, date: new Date().toISOString().slice(0, 10), entries: [payload] })
    .select().single();
  if (error) throw new Error(error.message);
  return rowToCoPrep(data);
}

// Rejoint une session existante (2e préparateur = rôle "end"). Max 2.
export async function joinCoPrep(id: string, joinerName: string): Promise<CoPrepState> {
  const { data: cur, error: e1 } = await sb.from("wms_scan_sessions").select("*").eq("id", id).single();
  if (e1) throw new Error(e1.message);
  const st = rowToCoPrep(cur);
  if (!st.participants.find(p => p.name === joinerName)) {
    if (st.participants.length >= 2) throw new Error("Déjà 2 préparateurs sur cette commande");
    const role: "start" | "end" = st.participants.some(p => p.role === "start") ? "end" : "start";
    st.participants.push({ name: joinerName, role, joinedAt: Date.now() });
    await writeCoPrep(id, st);
  }
  return st;
}

// Écrit l'état complet (participants + lignes + statut).
async function writeCoPrep(id: string, st: CoPrepState): Promise<void> {
  const payload: CoPrepPayload = { picking: st.picking, participants: st.participants, lines: st.lines, status: st.status };
  const { error } = await sb.from("wms_scan_sessions")
    .update({ entries: [payload], updated_at: new Date().toISOString() }).eq("id", id);
  if (error) throw new Error(error.message);
}

// Marque une ligne comme prélevée (verrou simple : on relit avant d'écrire).
// Renvoie { ok:false, takenBy } si la ligne a déjà été prise par l'autre entre-temps.
export async function setCoPrepLine(
  id: string, mlId: number, qtyDone: number, by: string
): Promise<{ ok: boolean; takenBy?: string; state: CoPrepState }> {
  const { data: cur, error } = await sb.from("wms_scan_sessions").select("*").eq("id", id).single();
  if (error) throw new Error(error.message);
  const st = rowToCoPrep(cur);
  const existing = st.lines[String(mlId)];
  // Verrou : si quelqu'un d'AUTRE a déjà complété cette ligne, on refuse.
  if (existing && existing.by !== by && existing.qtyDone >= qtyDone && qtyDone > 0) {
    return { ok: false, takenBy: existing.by, state: st };
  }
  st.lines[String(mlId)] = { mlId, qtyDone, by, at: Date.now() };
  await writeCoPrep(id, st);
  return { ok: true, state: st };
}

// Clôt la session collaborative (après validation Odoo).
export async function closeCoPrep(id: string): Promise<void> {
  const { data: cur, error } = await sb.from("wms_scan_sessions").select("*").eq("id", id).single();
  if (!error && cur) { const st = rowToCoPrep(cur); st.status = "done"; await writeCoPrep(id, st); }
  // on supprime carrément pour ne pas polluer
  await sb.from("wms_scan_sessions").delete().eq("id", id);
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
// SUIVI DU CRON eshop-out-cron — historique des N derniers runs (date, résultat, erreur)
// Permet de vérifier depuis l'app que le cron tourne bien, sans attendre le lendemain,
// ET de ne pas perdre un échec écrasé par le run suivant si le cron tourne souvent (ex: toutes les 3h).
// ══════════════════════════════════════════
export interface CronRunStatus {
  ranAt: string;
  ok: boolean;
  summary: string; // résumé humain (ex: "2 commande(s) → S00456")
  error?: string;
}
const CRON_HISTORY_MAX = 20;

export async function saveCronRunStatus(status: CronRunStatus): Promise<void> {
  const history = await getCronRunHistory();
  const next = [status, ...history].slice(0, CRON_HISTORY_MAX);
  const { error } = await sb.from("wms_sync_meta").upsert(
    { key: "eshop_cron_history", value: JSON.stringify(next), updated_at: new Date().toISOString() },
    { onConflict: "key" }
  );
  if (error) throw new Error(error.message);
}
export async function getCronRunHistory(): Promise<CronRunStatus[]> {
  try {
    const { data } = await sb.from("wms_sync_meta").select("value").eq("key", "eshop_cron_history").single();
    if (data?.value) return JSON.parse(data.value);
  } catch {}
  return [];
}
// Dernier run uniquement (compat écran existant / vue rapide).
export async function getCronRunStatus(): Promise<CronRunStatus | null> {
  const history = await getCronRunHistory();
  return history[0] || null;
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

export async function markEshopOrdersProcessed(orderNumbers: string[], devis: string, source: "manual" | "cron" = "manual"): Promise<void> {
  if (!orderNumbers.length) return;
  const rows = orderNumbers.map(n => ({ order_number: n, devis, processed_at: new Date().toISOString(), source }));
  const { error } = await sb.from("wms_eshop_processed").upsert(rows, { onConflict: "order_number" });
  if (error) throw new Error(error.message);
}

// Dernières commandes e-shop sorties (devis créé), les plus récentes d'abord.
// Regroupe par devis (un devis peut couvrir plusieurs order_number Shopware).
export interface RecentEshopOrder { devis: string; orderNumbers: string[]; processedAt: string; source: "manual" | "cron"; }
export async function getLastProcessedEshopOrders(limit = 5): Promise<RecentEshopOrder[]> {
  const { data, error } = await sb
    .from("wms_eshop_processed")
    .select("order_number, devis, processed_at, source")
    .order("processed_at", { ascending: false })
    .limit(200); // large fenêtre pour pouvoir regrouper par devis avant de couper à `limit`
  if (error) throw new Error(error.message);
  const byDevis: Record<string, RecentEshopOrder> = {};
  const order: string[] = [];
  for (const r of (data || [])) {
    const key = r.devis || r.order_number;
    if (!byDevis[key]) { byDevis[key] = { devis: key, orderNumbers: [], processedAt: r.processed_at, source: (r.source as any) || "manual" }; order.push(key); }
    byDevis[key].orderNumbers.push(r.order_number);
    if (r.processed_at > byDevis[key].processedAt) { byDevis[key].processedAt = r.processed_at; byDevis[key].source = (r.source as any) || "manual"; }
  }
  return order.map(k => byDevis[k]).slice(0, limit);
}

// ══════════════════════════════════════════
// COMMANDES E-SHOP MASQUÉES (fantômes/tests SendCloud) — partagé via wms_sync_meta
// ══════════════════════════════════════════
export async function getHiddenEshopOrders(): Promise<string[]> {
  try {
    const { data } = await sb.from("wms_sync_meta").select("value").eq("key", "eshop_hidden_orders").single();
    if (data?.value) return JSON.parse(data.value);
  } catch {}
  return [];
}
export async function hideEshopOrder(orderNumber: string): Promise<string[]> {
  const list = await getHiddenEshopOrders();
  if (!list.includes(orderNumber)) list.push(orderNumber);
  const { error } = await sb.from("wms_sync_meta").upsert(
    { key: "eshop_hidden_orders", value: JSON.stringify(list), updated_at: new Date().toISOString() },
    { onConflict: "key" }
  );
  if (error) throw new Error(error.message);
  return list;
}
export async function unhideEshopOrder(orderNumber: string): Promise<string[]> {
  let list = await getHiddenEshopOrders();
  list = list.filter(n => n !== orderNumber);
  const { error } = await sb.from("wms_sync_meta").upsert(
    { key: "eshop_hidden_orders", value: JSON.stringify(list), updated_at: new Date().toISOString() },
    { onConflict: "key" }
  );
  if (error) throw new Error(error.message);
  return list;
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

// ══════════════════════════════════════════
// MAPPING DES CHAMPS ODOO (paramétrage sans code — cf. lib/fieldMap.ts)
// Stocké dans wms_sync_meta / clé "odoo_field_map" = JSON { [FieldKey]: "nom_technique" }
// Seuls les champs RÉELLEMENT modifiés (≠ défaut) sont enregistrés.
// ══════════════════════════════════════════

/** Charge les overrides de champs Odoo (map cléLogique → nom technique). */
export async function loadFieldOverrides(): Promise<Record<string, string>> {
  try {
    const { data } = await sb.from("wms_sync_meta").select("value").eq("key", "odoo_field_map").single();
    if (data?.value) {
      const parsed = JSON.parse(data.value);
      if (parsed && typeof parsed === "object") return parsed as Record<string, string>;
    }
  } catch {}
  return {};
}

/** Enregistre l'intégralité des overrides (écrase). Passer {} pour tout réinitialiser. */
export async function saveFieldOverrides(overrides: Record<string, string>): Promise<void> {
  const { error } = await sb.from("wms_sync_meta").upsert(
    { key: "odoo_field_map", value: JSON.stringify(overrides), updated_at: new Date().toISOString() },
    { onConflict: "key" }
  );
  if (error) throw new Error(error.message);
}

// ══════════════════════════════════════════
// MAPPING DES MODÈLES ODOO (cf. lib/fieldMap.ts — M())
// Stocké dans wms_sync_meta / clé "odoo_model_map" = JSON { [ModelKey]: "nom.modele" }
// ══════════════════════════════════════════

export async function loadModelOverrides(): Promise<Record<string, string>> {
  try {
    const { data } = await sb.from("wms_sync_meta").select("value").eq("key", "odoo_model_map").single();
    if (data?.value) {
      const parsed = JSON.parse(data.value);
      if (parsed && typeof parsed === "object") return parsed as Record<string, string>;
    }
  } catch {}
  return {};
}

export async function saveModelOverrides(overrides: Record<string, string>): Promise<void> {
  const { error } = await sb.from("wms_sync_meta").upsert(
    { key: "odoo_model_map", value: JSON.stringify(overrides), updated_at: new Date().toISOString() },
    { onConflict: "key" }
  );
  if (error) throw new Error(error.message);
}

// ══════════════════════════════════════════
// PLANNING VS COMMANDE — synthèse mensuelle (par année)
// Stocké dans wms_sync_meta / clé "planning_synthese_<année>" = JSON { [mois]: {...totaux} }
// ══════════════════════════════════════════

export interface PlanningMonth {
  month: string; forecast: number; order: number; received: number;
  budgetOrder: number; ruptEuro: number; accuracy: number; accuracyJordan?: number; nbNonCmd: number;
  // Enrichissements : planification Sissi (qté + €) et variances vs commandé.
  budgetSissi?: number;        // qté planifiée Sissi (F)
  budgetSissiEur?: number;     // budget Sissi en € (F * coût)
  budgetForecastEur?: number;  // budget forecast Jordan en €
  varBudgetQty?: number;       // commandé - Sissi (qté)
  varBudgetEur?: number;       // budget commandé - budget Sissi (€)
}

export async function loadPlanningSynthese(year: number): Promise<PlanningMonth[]> {
  try {
    const { data } = await sb.from("wms_sync_meta").select("value").eq("key", `planning_synthese_${year}`).single();
    if (data?.value) {
      const obj = JSON.parse(data.value);
      return Object.values(obj) as PlanningMonth[];
    }
  } catch {}
  return [];
}

export async function savePlanningMonth(year: number, m: PlanningMonth): Promise<void> {
  // Charge l'existant, remplace le mois, réécrit.
  let obj: Record<string, PlanningMonth> = {};
  try {
    const { data } = await sb.from("wms_sync_meta").select("value").eq("key", `planning_synthese_${year}`).single();
    if (data?.value) obj = JSON.parse(data.value);
  } catch {}
  obj[m.month] = m;
  const { error } = await sb.from("wms_sync_meta").upsert(
    { key: `planning_synthese_${year}`, value: JSON.stringify(obj), updated_at: new Date().toISOString() },
    { onConflict: "key" }
  );
  if (error) throw new Error(error.message);
}

// ── DÉTAIL d'un mois (toutes les lignes calculées) — pour l'export fichier complet.
// Clé "planning_detail_<année>_<mois>" = JSON des lignes.
export async function savePlanningDetail(year: number, month: string, rows: any[]): Promise<void> {
  const { error } = await sb.from("wms_sync_meta").upsert(
    { key: `planning_detail_${year}_${month}`, value: JSON.stringify(rows), updated_at: new Date().toISOString() },
    { onConflict: "key" }
  );
  if (error) throw new Error(error.message);
}

export async function loadPlanningDetail(year: number, month: string): Promise<any[]> {
  try {
    const { data } = await sb.from("wms_sync_meta").select("value").eq("key", `planning_detail_${year}_${month}`).single();
    if (data?.value) return JSON.parse(data.value);
  } catch {}
  return [];
}
