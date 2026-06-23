// lib/odoo.ts

export interface OdooConfig { url: string; db: string; }
export interface OdooSession { uid: number; name: string; login: string; sessionId: string; config: OdooConfig; }

// Comptes avec accès aux fonctions admin du WMS
const ADMIN_LOGINS = ["j.fitoussi@drhauschka.fr"];
export function isAdmin(session: OdooSession): boolean {
  return ADMIN_LOGINS.includes(session.login?.toLowerCase());
}

async function rpc(config: OdooConfig, endpoint: string, params: any, sessionId?: string) {
  const res = await fetch("/api/odoo/proxy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ odooUrl: config.url, endpoint, params, sessionId }),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || `Erreur ${res.status}`);
  return { result: data.result, sessionId: data.sessionId };
}

export async function authenticate(config: OdooConfig, login: string, password: string): Promise<OdooSession> {
  const { result, sessionId: sid } = await rpc(config, "/web/session/authenticate", { db: config.db, login, password });
  if (!result || !result.uid || result.uid === false) throw new Error("Identifiants incorrects");
  return { uid: result.uid, name: result.name || result.username || login, login: login.toLowerCase(), sessionId: sid || result.session_id || "", config };
}

// Clés localStorage où les pages persistent la session (dashboard + app principale)
const SESSION_STORAGE_KEYS = ["wms_dash_s", "wms_s"];

// Odoo fait tourner le cookie session_id à chaque requête. On persiste la valeur
// rafraîchie pour ne pas continuer à envoyer un session_id périmé (→ "Session Expired").
function persistRefreshedSession(session: OdooSession, newSessionId?: string | null) {
  if (!newSessionId || newSessionId === session.sessionId) return;
  // Mutation en place : les états React tiennent une référence vers cet objet,
  // donc les appels suivants utiliseront automatiquement le sessionId à jour.
  session.sessionId = newSessionId;
  if (typeof window === "undefined") return;
  for (const key of SESSION_STORAGE_KEYS) {
    try {
      const raw = window.localStorage.getItem(key) || window.sessionStorage.getItem(key);
      if (!raw) continue;
      const stored = JSON.parse(raw);
      if (stored && stored.sessionId !== undefined) {
        stored.sessionId = newSessionId;
        const serialized = JSON.stringify(stored);
        if (window.localStorage.getItem(key)) window.localStorage.setItem(key, serialized);
        if (window.sessionStorage.getItem(key)) window.sessionStorage.setItem(key, serialized);
      }
    } catch {}
  }
}

async function call(session: OdooSession, endpoint: string, params: any) {
  const { result, sessionId: refreshed } = await rpc(session.config, endpoint, params, session.sessionId);
  persistRefreshedSession(session, refreshed);
  return result;
}

export async function searchRead(session: OdooSession, model: string, domain: any[], fields: string[], limit = 0, order = "") {
  return call(session, "/web/dataset/call_kw", { model, method: "search_read", args: [domain], kwargs: { fields, limit, order } });
}

export async function callMethod(session: OdooSession, model: string, method: string, args: any[] = [], kwargs: any = {}) {
  return call(session, "/web/dataset/call_kw", { model, method, args, kwargs });
}

export async function getInventoryFields(session: OdooSession): Promise<string[]> {
  const fields = await call(session, "/web/dataset/call_kw", {
    model: "stock.quant", method: "fields_get", args: [], kwargs: { attributes: ["string", "type"] }
  });
  return Object.keys(fields || {}).filter((k: string) => k.includes("inventor") || k.includes("reason") || k.includes("adjustment"));
}

export async function create(session: OdooSession, model: string, values: any) {
  return call(session, "/web/dataset/call_kw", { model, method: "create", args: [values], kwargs: {} });
}

export async function write(session: OdooSession, model: string, ids: number[], values: any) {
  return call(session, "/web/dataset/call_kw", { model, method: "write", args: [ids, values], kwargs: {} });
}
export async function unlink(session: OdooSession, model: string, ids: number[]) {
  return call(session, "/web/dataset/call_kw", { model, method: "unlink", args: [ids], kwargs: {} });
}

// ============================================
// PRODUCT FIELDS
// ============================================
const PRODUCT_FIELDS = ["id", "name", "barcode", "default_code", "uom_id", "tracking", "active", "weight"];

// ============================================
// SMART SCAN — with archived product fallback
// ============================================
export type ScanResult =
  | { type: "location"; data: any }
  | { type: "product"; data: any }
  | { type: "lot"; data: { lot: any; product: any } }
  | { type: "not_found"; code: string };

export async function smartScan(session: OdooSession, code: string): Promise<ScanResult> {
  const trimmed = code.trim();
  const upper = trimmed.toUpperCase();

  // 1. Location by barcode (exact then case-insensitive)
  const locs = await searchRead(session, "stock.location", [["barcode", "=", trimmed]], ["id", "name", "complete_name", "barcode"], 1);
  if (locs.length) return { type: "location", data: locs[0] };
  if (upper !== trimmed) {
    const locsU = await searchRead(session, "stock.location", [["barcode", "=", upper]], ["id", "name", "complete_name", "barcode"], 1);
    if (locsU.length) return { type: "location", data: locsU[0] };
  }
  const locsI = await searchRead(session, "stock.location", [["barcode", "ilike", trimmed]], ["id", "name", "complete_name", "barcode"], 1);
  if (locsI.length) return { type: "location", data: locsI[0] };

  // 2. Product by barcode (exact — EAN codes are numeric, case doesn't matter)
  const byBC = await searchRead(session, "product.product", [["barcode", "=", trimmed]], PRODUCT_FIELDS, 1);
  if (byBC.length) return { type: "product", data: byBC[0] };

  // 3. Product by reference — exact, then uppercase, then ilike
  const byRef = await searchRead(session, "product.product", [["default_code", "=", trimmed]], PRODUCT_FIELDS, 1);
  if (byRef.length) return { type: "product", data: byRef[0] };
  if (upper !== trimmed) {
    const byRefU = await searchRead(session, "product.product", [["default_code", "=", upper]], PRODUCT_FIELDS, 1);
    if (byRefU.length) return { type: "product", data: byRefU[0] };
  }
  const byRefI = await searchRead(session, "product.product", [["default_code", "=ilike", trimmed]], PRODUCT_FIELDS, 1);
  if (byRefI.length) return { type: "product", data: byRefI[0] };

  // 4. Lot — exact, then uppercase, then ilike
  const LOT_FIELDS = ["id", "name", "product_id", "expiration_date", "use_date", "removal_date"];
  let lots = await searchRead(session, "stock.lot", [["name", "=", trimmed]], LOT_FIELDS, 1);
  if (!lots.length && upper !== trimmed) lots = await searchRead(session, "stock.lot", [["name", "=", upper]], LOT_FIELDS, 1);
  if (!lots.length) lots = await searchRead(session, "stock.lot", [["name", "ilike", trimmed]], LOT_FIELDS, 1);
  if (lots.length) {
    let prod = await searchRead(session, "product.product", [["id", "=", lots[0].product_id[0]]], PRODUCT_FIELDS, 1);
    // Fallback: archived product
    if (!prod.length) prod = await searchRead(session, "product.product", [["id", "=", lots[0].product_id[0]], ["active", "=", false]], PRODUCT_FIELDS, 1);
    return { type: "lot", data: { lot: lots[0], product: prod[0] || null } };
  }

  // 5. Fallback: archived product by barcode
  const archivedBC = await searchRead(session, "product.product", [["barcode", "=", trimmed], ["active", "=", false]], PRODUCT_FIELDS, 1);
  if (archivedBC.length) return { type: "product", data: archivedBC[0] };

  // 6. Fallback: archived product by reference (case-insensitive)
  let archivedRef = await searchRead(session, "product.product", [["default_code", "=ilike", trimmed], ["active", "=", false]], PRODUCT_FIELDS, 1);
  if (archivedRef.length) return { type: "product", data: archivedRef[0] };

  return { type: "not_found", code: trimmed };
}

// ============================================
// GLOBAL SEARCH — all categories in parallel
// ============================================

export type GlobalSearchResult =
  | { type: "location"; data: any }
  | { type: "product"; data: any; matchedBy: "ref" | "name" | "barcode" }
  | { type: "lot"; data: { lot: any; product: any } }
  | { type: "supplier_ref"; data: any; supplierRef: string };

export async function globalSearch(session: OdooSession, query: string): Promise<GlobalSearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed || trimmed.length < 2) return [];

  // Fire all searches in parallel — limits kept small to reduce Odoo response time
  const [locs, productsByRefOrName, productsByBarcode, lots, supplierInfos] = await Promise.all([
    // Locations by complete_name (internal + transit)
    searchRead(session, "stock.location",
      [["complete_name", "ilike", trimmed], ["usage", "in", ["internal", "transit"]]],
      ["id", "name", "complete_name", "barcode", "usage"], 6),
    // Products by internal ref OR name
    searchRead(session, "product.product",
      ["|", ["default_code", "ilike", trimmed], ["name", "ilike", trimmed]],
      PRODUCT_FIELDS, 8),
    // Products by barcode (exact — only if query looks like a barcode)
    trimmed.length >= 6 ? searchRead(session, "product.product",
      [["barcode", "=", trimmed]], PRODUCT_FIELDS, 2) : Promise.resolve([]),
    // Lots by name
    searchRead(session, "stock.lot",
      [["name", "ilike", trimmed]],
      ["id", "name", "product_id", "expiration_date"], 6),
    // Supplier refs
    searchRead(session, "product.supplierinfo",
      [["product_code", "ilike", trimmed]],
      ["id", "product_code", "product_id", "product_tmpl_id"], 8),
  ]);

  const results: GlobalSearchResult[] = [];
  const seenProductIds = new Set<number>();

  // 1. Locations
  for (const loc of locs) {
    results.push({ type: "location", data: loc });
  }

  // 2. Products (barcode first for priority, then ref/name, dedup by id)
  for (const p of [...productsByBarcode, ...productsByRefOrName]) {
    if (!seenProductIds.has(p.id)) {
      seenProductIds.add(p.id);
      const matchedBy: "ref" | "name" | "barcode" =
        productsByBarcode.some((x: any) => x.id === p.id) ? "barcode"
        : (p.default_code || "").toLowerCase().includes(trimmed.toLowerCase()) ? "ref"
        : "name";
      results.push({ type: "product", data: p, matchedBy });
    }
  }

  // 3. Supplier refs → resolve product IDs from supplierinfos
  const supplierRefMap: Record<number, string> = {}; // productId → product_code

  // Fetch template → variant mapping (product_tmpl_id MUST be in fields for the match to work)
  const tmplIds = supplierInfos
    .filter((si: any) => !si.product_id && si.product_tmpl_id)
    .map((si: any) => si.product_tmpl_id[0]);
  let tmplProducts: any[] = [];
  if (tmplIds.length > 0) {
    tmplProducts = await searchRead(session, "product.product",
      [["product_tmpl_id", "in", tmplIds]],
      [...PRODUCT_FIELDS, "product_tmpl_id"],   // ← include product_tmpl_id for matching
      tmplIds.length * 3);
  }

  for (const si of supplierInfos) {
    if (!si.product_code) continue;
    let productId: number | null = null;
    if (si.product_id) {
      productId = si.product_id[0];
    } else if (si.product_tmpl_id) {
      const tmplId = si.product_tmpl_id[0];
      const found = tmplProducts.find((p: any) => {
        const t = Array.isArray(p.product_tmpl_id) ? p.product_tmpl_id[0] : p.product_tmpl_id;
        return t === tmplId;
      });
      if (found) productId = found.id;
    }
    if (productId && !supplierRefMap[productId]) {
      supplierRefMap[productId] = si.product_code;
    }
  }

  // Annotate already-found products with supplier ref badge, add new ones as supplier_ref type
  const newSupplierIds = new Set<number>();
  for (const [pidStr, ref] of Object.entries(supplierRefMap)) {
    const pid = Number(pidStr);
    if (seenProductIds.has(pid)) {
      // Product already in results → add supplierRef to it
      for (const r of results) {
        if (r.type === "product" && r.data.id === pid) {
          (r as any).supplierRef = ref;
        }
      }
    } else {
      newSupplierIds.add(pid);
    }
  }

  if (newSupplierIds.size > 0) {
    const newProds = await searchRead(session, "product.product",
      [["id", "in", Array.from(newSupplierIds)]], PRODUCT_FIELDS, newSupplierIds.size);
    for (const p of newProds) {
      seenProductIds.add(p.id);
      results.push({ type: "supplier_ref", data: p, supplierRef: supplierRefMap[p.id] || "" });
    }
  }

  // 4. Lots — product name/id comes from lot.product_id many2one, no extra fetch needed
  for (const lot of lots) {
    results.push({ type: "lot", data: { lot, product: null } });
  }

  return results;
}

// ============================================
// STOCK QUERIES — INTERNAL LOCATIONS ONLY
// ============================================

// All stock for a product across all internal locations
export async function getAllStockForProduct(session: OdooSession, productId: number) {
  const quants = await searchRead(
    session, "stock.quant",
    [["product_id", "=", productId], ["quantity", "!=", 0], ["location_id.usage", "=", "internal"]],
    ["location_id", "lot_id", "quantity", "reserved_quantity"],
    500, "location_id"
  );

  // Enrich with lot expiration dates
  const lotIds = Array.from(new Set(quants.filter((q: any) => q.lot_id).map((q: any) => q.lot_id[0])));
  if (lotIds.length > 0) {
    const lots = await searchRead(session, "stock.lot", [["id", "in", lotIds]], ["id", "name", "expiration_date", "use_date", "removal_date"], lotIds.length);
    const lotMap: Record<number, any> = {};
    for (const l of lots) lotMap[l.id] = l;
    for (const q of quants) {
      if (q.lot_id) {
        const lot = lotMap[q.lot_id[0]];
        if (lot) {
          q.expiration_date = lot.expiration_date || lot.use_date || lot.removal_date || "";
          q.lot_name = lot.name; // clean lot name without date suffix
        }
      }
    }
  }

  return quants;
}

// Stock for a specific lot across internal locations
export async function getStockForLot(session: OdooSession, lotId: number, productId: number) {
  return searchRead(
    session, "stock.quant",
    [["lot_id", "=", lotId], ["product_id", "=", productId], ["quantity", "!=", 0], ["location_id.usage", "=", "internal"]],
    ["location_id", "lot_id", "quantity", "reserved_quantity"],
    200, "location_id"
  );
}

// Stock at a specific location (for transfer mode)
export async function getStockAtLocation(session: OdooSession, productId: number, locationId: number) {
  return searchRead(
    session, "stock.quant",
    [["product_id", "=", productId], ["location_id", "=", locationId]],
    ["quantity", "lot_id", "reserved_quantity"]
  );
}

// All products at a location
export async function getProductsAtLocation(session: OdooSession, locationId: number) {
  const quants = await searchRead(
    session, "stock.quant",
    [["location_id", "=", locationId], ["quantity", "!=", 0]],
    ["id", "product_id", "location_id", "lot_id", "quantity", "reserved_quantity", "inventory_quantity"],
    500, "product_id"
  );
  // Enrich with lot expiration dates
  const lotIds = Array.from(new Set(quants.filter((q: any) => q.lot_id).map((q: any) => q.lot_id[0])));
  if (lotIds.length > 0) {
    const lots = await searchRead(session, "stock.lot", [["id", "in", lotIds]], ["id", "name", "expiration_date", "use_date", "removal_date"], lotIds.length);
    const lotMap: Record<number, any> = {};
    for (const l of lots) lotMap[l.id] = l;
    for (const q of quants) {
      if (q.lot_id) {
        const lot = lotMap[q.lot_id[0]];
        if (lot) {
          q.expiration_date = lot.expiration_date || lot.use_date || lot.removal_date || "";
          q.lot_name = lot.name;
        }
      }
    }
  }
  // Enrich with product barcode and default_code
  const productIds = Array.from(new Set(quants.map((q: any) => q.product_id[0])));
  if (productIds.length > 0) {
    const products = await searchRead(session, "product.product", [["id", "in", productIds]], ["id", "barcode", "default_code"], productIds.length);
    const prodMap: Record<number, any> = {};
    for (const p of products) prodMap[p.id] = p;
    for (const q of quants) {
      const prod = prodMap[q.product_id[0]];
      if (prod) {
        q.product_barcode = prod.barcode || "";
        q.product_ref = prod.default_code || "";
      }
    }
  }
  return quants;
}

export async function getLocations(session: OdooSession) {
  return searchRead(session, "stock.location", [["usage", "in", ["internal", "transit"]]], ["id", "name", "complete_name", "barcode", "usage", "location_id"], 2000, "complete_name");
}

// ============================================
// CREATE LOCATION (gestion emplacements depuis le scan)
// ============================================
export interface NewLocation {
  name: string;
  barcode?: string;
  parentId: number;        // location_id (emplacement parent, requis par Odoo)
  usage?: string;          // "internal" par défaut
}
export async function createLocation(session: OdooSession, loc: NewLocation): Promise<number> {
  const vals: any = {
    name: loc.name.trim(),
    location_id: loc.parentId,
    usage: loc.usage || "internal",
  };
  if (loc.barcode && loc.barcode.trim()) vals.barcode = loc.barcode.trim();
  const id = await create(session, "stock.location", vals);
  return id as number;
}

// Vérifie si un code-barres d'emplacement existe déjà (évite les doublons de scan).
export async function locationBarcodeExists(session: OdooSession, barcode: string): Promise<boolean> {
  const b = barcode.trim();
  if (!b) return false;
  const found = await searchRead(session, "stock.location", [["barcode", "=", b]], ["id"], 1);
  return found.length > 0;
}

// ============================================
// RENAME LOCATION
// ============================================
export async function renameLocation(session: OdooSession, locationId: number, newName: string) {
  return write(session, "stock.location", [locationId], { name: newName });
}

// ============================================
// COMMANDES EN ATTENTE — même logique que getOutgoingPickings, état != assigned
// ============================================

// Cache module-level des IDs statiques (picking types + tag "Transmise")
// Clé = sessionId pour isoler les différentes instances Odoo
const _waitingCache: Record<string, {
  pickTypeIds: number[];
  outTypeIds: number[];
  transmiseTagIds: number[];
}> = {};

async function _resolveWaitingIds(session: OdooSession) {
  const key = session.config.url + "|" + session.config.db;
  if (_waitingCache[key]) return _waitingCache[key];

  // Résolution picking type PICK + outgoing + tag "Transmise" en parallèle
  const [pickTypesResult, outTypesResult, transmiseTagsResult] = await Promise.all([
    // Picking type PICK (cascade 3 essais regroupés)
    searchRead(session, "stock.picking.type", [["code", "=", "internal"], ["name", "ilike", "pick"]], ["id"], 10)
      .then(async (t: any[]) => {
        if (t.length) return t;
        const t2 = await searchRead(session, "stock.picking.type", [["sequence_code", "=", "PICK"]], ["id"], 10);
        if (t2.length) return t2;
        return searchRead(session, "stock.picking.type", [["code", "=", "outgoing"]], ["id"], 10);
      }),
    // Picking type OUT (pour l'enrichissement date)
    searchRead(session, "stock.picking.type", [["code", "=", "outgoing"]], ["id"], 10),
    // Tag "Transmise"
    searchRead(session, "crm.tag", [["name", "ilike", "transmise"]], ["id"], 10),
  ]);

  const result = {
    pickTypeIds: (pickTypesResult as any[]).map((t: any) => t.id),
    outTypeIds: (outTypesResult as any[]).map((t: any) => t.id),
    transmiseTagIds: (transmiseTagsResult as any[]).map((t: any) => t.id),
  };
  _waitingCache[key] = result;
  return result;
}

/** Invalide le cache (utile si les picking types changent côté Odoo) */
export function invalidateWaitingCache() {
  for (const k of Object.keys(_waitingCache)) delete _waitingCache[k];
}

export async function getWaitingPickings(session: OdooSession): Promise<any[]> {
  const { pickTypeIds, outTypeIds, transmiseTagIds } = await _resolveWaitingIds(session);
  if (!pickTypeIds.length) return [];

  const domain: any[] = [
    ["picking_type_id", "in", pickTypeIds],
    ["state", "in", ["confirmed", "waiting", "partially_available"]],
  ];
  if (transmiseTagIds.length > 0) {
    domain.push(["x_studio_etiquettes_commande", "in", transmiseTagIds]);
  }

  const pickings = await searchRead(
    session, "stock.picking",
    domain,
    PICKING_FIELDS,
    200,
    "scheduled_date asc, date_deadline asc, id asc"
  );

  // Enrichissement date depuis OUT lié + sale.order
  const groupIds = Array.from(new Set(pickings.map((p: any) => p.group_id?.[0]).filter(Boolean)));
  if (groupIds.length > 0 && outTypeIds.length > 0) {
    const outPickings = await searchRead(
      session, "stock.picking",
      [["group_id", "in", groupIds], ["picking_type_id", "in", outTypeIds]],
      ["id", "group_id", "scheduled_date", "date_deadline", "origin"],
      500
    );
    const outByGroup: Record<number, any> = {};
    for (const op of outPickings) { if (op.group_id) outByGroup[op.group_id[0]] = op; }

    const soNames = Array.from(new Set(outPickings.map((op: any) => op.origin).filter(Boolean)));
    const salesMap: Record<string, any> = {};
    if (soNames.length > 0) {
      const sales = await searchRead(session, "sale.order",
        [["name", "in", soNames]], ["id", "name", "commitment_date", "expected_date"], soNames.length);
      for (const s of sales) salesMap[s.name] = s;
    }
    for (const p of pickings) {
      const gid = p.group_id?.[0];
      if (gid && outByGroup[gid]) {
        const outP = outByGroup[gid];
        const sale = outP.origin ? salesMap[outP.origin] : null;
        p.shipping_date = sale?.commitment_date || sale?.expected_date || outP.date_deadline || outP.scheduled_date || null;
        if (!p.origin && outP.origin) p.origin = outP.origin;
      }
    }
  }

  for (const p of pickings) {
    if (!p.shipping_date) {
      p.shipping_date = p.x_studio_date_dexpdition_prvue || p.date_deadline || p.scheduled_date || null;
    } else if (p.x_studio_date_dexpdition_prvue) {
      p.shipping_date = p.x_studio_date_dexpdition_prvue;
    }
  }

  pickings.sort((a: any, b: any) => {
    const da = a.shipping_date || "9999";
    const db = b.shipping_date || "9999";
    return da < db ? -1 : da > db ? 1 : 0;
  });

  return pickings;
}

/** Version légère pour le polling — ne récupère que les champs nécessaires à la détection de nouvelles commandes */
export async function getWaitingPickingsLight(session: OdooSession): Promise<{ id: number; name: string; shipping_date: string | null; scheduled_date: string | null; date_deadline: string | null; x_studio_date_dexpdition_prvue: string | null }[]> {
  const { pickTypeIds, transmiseTagIds } = await _resolveWaitingIds(session);
  if (!pickTypeIds.length) return [];

  const domain: any[] = [
    ["picking_type_id", "in", pickTypeIds],
    ["state", "in", ["confirmed", "waiting", "partially_available"]],
  ];
  if (transmiseTagIds.length > 0) {
    domain.push(["x_studio_etiquettes_commande", "in", transmiseTagIds]);
  }

  const pickings = await searchRead(
    session, "stock.picking",
    domain,
    ["id", "name", "scheduled_date", "date_deadline", "x_studio_date_dexpdition_prvue", "origin"],
    200
  );

  for (const p of pickings) {
    p.shipping_date = p.x_studio_date_dexpdition_prvue || p.date_deadline || p.scheduled_date || null;
  }

  return pickings;
}

/**
 * Vérifie la dispo d'un picking (action_assign), relit son état,
 * et retourne l'état résultant + les move lines manquantes si partiel.
 */
export async function checkAvailabilityAndGetResult(
  session: OdooSession,
  pickingId: number
): Promise<{ state: string; missingLines: any[] }> {
  await callMethod(session, "stock.picking", "action_assign", [[pickingId]]);

  const [picking] = await searchRead(session, "stock.picking",
    [["id", "=", pickingId]], ["state"], 1);
  const state = picking?.state || "confirmed";

  // Toujours vérifier les manquants — même si Odoo retourne "assigned",
  // il peut y avoir des lignes avec stock insuffisant (stock négatif, erreur Odoo…).
  // On compare la demande (product_uom_qty) à ce qui est vraiment réservé (reserved_availability).
  const moves = await searchRead(session, "stock.move",
    [["picking_id", "=", pickingId], ["state", "!=", "cancel"]],
    ["product_id", "product_uom_qty", "reserved_availability"], 200);
  const missingLines = moves.filter((m: any) =>
    Math.round(((m.product_uom_qty || 0) - (m.reserved_availability || 0)) * 1000) > 0
  ).map((m: any) => ({
    product: m.product_id[1],
    needed: m.product_uom_qty,
    available: m.reserved_availability || 0,
    missing: Math.round(((m.product_uom_qty || 0) - (m.reserved_availability || 0)) * 100) / 100,
  }));

  // Si Odoo dit "assigned" mais qu'on détecte des manquants → corriger le state
  const effectiveState = (state === "assigned" && missingLines.length > 0)
    ? "partially_available"
    : state;

  return { state: effectiveState, missingLines };
}

/**
 * Liste tous les rapports PDF disponibles pour stock.picking.
 * Utilisé dans les Paramètres pour choisir le bon de préparation.
 */
export async function getPickingReportList(session: OdooSession): Promise<{ id: number; name: string; report_name: string }[]> {
  // Passer lang: fr_FR pour obtenir les noms traduits (ex: "Bon de préparation simplifié 2")
  return call(session, "/web/dataset/call_kw", {
    model: "ir.actions.report",
    method: "search_read",
    args: [[["model", "=", "stock.picking"], ["report_type", "ilike", "qweb"]]],
    kwargs: { fields: ["id", "name", "report_name"], limit: 50, order: "name asc", context: { lang: "fr_FR" } },
  });
}

const PREP_REPORT_KEY = "wms_prep_report_name";
export function getSavedPrepReportName(): string {
  try { return localStorage.getItem(PREP_REPORT_KEY) || "stock.report_picking"; } catch { return "stock.report_picking"; }
}
export function savePrepReportName(reportName: string): void {
  try { localStorage.setItem(PREP_REPORT_KEY, reportName); } catch {}
}

/**
 * Récupère le bon de préparation en base64 via l'endpoint HTTP /report/pdf/ d'Odoo.
 * Plus fiable que _render_qweb_pdf (compatible toutes versions Odoo).
 */
export async function getPickingReportBase64(
  session: OdooSession,
  pickingId: number,
  reportName?: string,
  overlayDate?: string,
  overlayIndex?: number,
  overlayTotal?: number
): Promise<string> {
  const name = reportName || getSavedPrepReportName();

  const res = await fetch("/api/odoo/report", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      odooUrl: session.config.url,
      sessionId: session.sessionId,
      reportName: name,
      recordId: pickingId,
      overlayDate,
      overlayIndex,
      overlayTotal,
    }),
  });

  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data.error || `Erreur rapport ${res.status}`);
  }
  if (!data.base64) {
    throw new Error("PDF vide retourné par Odoo");
  }
  return data.base64;
}

// Impression directe serveur : Odoo PDF → overlay → PrintNode (sans passer par le navigateur)
export async function printPickingReportDirect(
  session: OdooSession,
  pickingId: number,
  printerId: number,
  options: {
    reportName?: string;
    title?: string;
    overlayDate?: string;
    overlayIndex?: number;
    overlayTotal?: number;
  } = {}
): Promise<{ success: boolean; jobId?: number; error?: string }> {
  try {
    const res = await fetch("/api/odoo/print-bl", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        odooUrl: session.config.url,
        sessionId: session.sessionId,
        reportName: options.reportName || getSavedPrepReportName(),
        recordId: pickingId,
        printerId,
        title: options.title,
        overlayDate: options.overlayDate,
        overlayIndex: options.overlayIndex,
        overlayTotal: options.overlayTotal,
      }),
    });
    const data = await res.json();
    if (!res.ok || data.error) return { success: false, error: data.error || `Erreur ${res.status}` };
    return { success: true, jobId: data.jobId };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

// ============================================
// PREPARATION — Outgoing pickings
// ============================================

const PICKING_FIELDS = [
  "id", "name", "state", "scheduled_date", "date_deadline", "date",
  "partner_id", "origin", "picking_type_id", "group_id",
  "move_ids_without_package", "location_id", "location_dest_id",
  "x_studio_date_dexpdition_prvue", "x_studio_etiquettes_commande", "carrier_id",
  "user_id",
];

// Get pick-type pickings in confirmed/assigned state (preparation)
export async function getOutgoingPickings(session: OdooSession) {
  // Find pick picking type(s) — preparation before delivery
  const types = await searchRead(session, "stock.picking.type", [["code", "=", "internal"], ["name", "ilike", "pick"]], ["id", "name"], 10);
  let typeIds = types.map((t: any) => t.id);
  if (!typeIds.length) {
    const types2 = await searchRead(session, "stock.picking.type", [["sequence_code", "=", "PICK"]], ["id"], 10);
    typeIds = types2.map((t: any) => t.id);
  }
  if (!typeIds.length) {
    const types3 = await searchRead(session, "stock.picking.type", [["code", "=", "outgoing"]], ["id"], 10);
    typeIds = types3.map((t: any) => t.id);
  }
  if (!typeIds.length) return [];

  const pickings = await searchRead(
    session, "stock.picking",
    [
      ["picking_type_id", "in", typeIds],
      ["state", "=", "assigned"],
    ],
    PICKING_FIELDS,
    200,
    "date_deadline asc, scheduled_date asc, id asc"
  );

  // Enrich with shipping date from related OUT picking (via group_id) or sale order
  const groupIds = Array.from(new Set(pickings.map((p: any) => p.group_id?.[0]).filter(Boolean)));
  if (groupIds.length > 0) {
    // Find outgoing pickings with same group_id
    const outTypes = await searchRead(session, "stock.picking.type", [["code", "=", "outgoing"]], ["id"], 10);
    const outTypeIds = outTypes.map((t: any) => t.id);
    if (outTypeIds.length > 0) {
      const outPickings = await searchRead(
        session, "stock.picking",
        [["group_id", "in", groupIds], ["picking_type_id", "in", outTypeIds]],
        ["id", "group_id", "scheduled_date", "date_deadline", "origin"],
        500
      );
      // Map group_id → OUT picking
      const outByGroup: Record<number, any> = {};
      for (const op of outPickings) {
        if (op.group_id) outByGroup[op.group_id[0]] = op;
      }
      // Also try to get sale order dates from OUT picking origins
      const soNames = Array.from(new Set(outPickings.map((op: any) => op.origin).filter(Boolean)));
      const salesMap: Record<string, any> = {};
      if (soNames.length > 0) {
        const sales = await searchRead(
          session, "sale.order",
          [["name", "in", soNames]],
          ["id", "name", "commitment_date", "expected_date"],
          soNames.length
        );
        for (const s of sales) salesMap[s.name] = s;
      }

      for (const p of pickings) {
        const gid = p.group_id?.[0];
        if (gid && outByGroup[gid]) {
          const outP = outByGroup[gid];
          const sale = outP.origin ? salesMap[outP.origin] : null;
          // Priority: sale.commitment_date > OUT.date_deadline > OUT.scheduled_date
          p.shipping_date = sale?.commitment_date || sale?.expected_date || outP.date_deadline || outP.scheduled_date || null;
          if (!p.origin && outP.origin) p.origin = outP.origin; // show SO ref
        }
      }
    }
  }

  // Filter out pickings tagged "En attente" via x_studio_etiquettes_commande
  const tagIds = Array.from(new Set(
    pickings.flatMap((p: any) => p.x_studio_etiquettes_commande || [])
  )) as number[];
  let excludeTagIds: number[] = [];
  if (tagIds.length > 0) {
    const tags = await searchRead(session, "crm.tag", [["id", "in", tagIds]], ["id", "name"], tagIds.length);
    excludeTagIds = tags.filter((t: any) => t.name?.toLowerCase().includes("en attente")).map((t: any) => t.id);
  }
  const filteredPickings = excludeTagIds.length > 0
    ? pickings.filter((p: any) => {
        const pTags: number[] = p.x_studio_etiquettes_commande || [];
        return !pTags.some((tid: number) => excludeTagIds.includes(tid));
      })
    : pickings;

  // Use x_studio_date_dexpdition_prvue as primary date if available
  for (const p of filteredPickings) {
    if (p.x_studio_date_dexpdition_prvue) p.shipping_date = p.x_studio_date_dexpdition_prvue;
  }

  // Sort by shipping_date asc, no date → end
  filteredPickings.sort((a: any, b: any) => {
    const da = a.shipping_date || a.date_deadline || a.scheduled_date || "9999";
    const db = b.shipping_date || b.date_deadline || b.scheduled_date || "9999";
    return da < db ? -1 : da > db ? 1 : 0;
  });

  return filteredPickings;
}

// Get move lines for a picking (what needs to be prepared)
export async function getPickingMoveLines(session: OdooSession, pickingId: number) {
  return searchRead(
    session, "stock.move.line",
    [["picking_id", "=", pickingId]],
    ["id", "product_id", "lot_id", "location_id", "location_dest_id", "qty_done", "reserved_uom_qty", "picking_id", "move_id", "product_uom_id"],
    200,
    "product_id"
  );
}

// Crée une nouvelle ligne de mouvement pour un lot scanné différent du lot réservé.
// C'est l'approche correcte dans Odoo : ne pas changer le lot_id d'une ligne réservée,
// mais créer une nouvelle ligne pour le lot réellement prélevé.
export async function createDeviationMoveLine(session: OdooSession, params: {
  moveId: number; pickingId: number; productId: number; productUomId: number;
  lotId: number; locationId: number; locationDestId: number;
}): Promise<number> {
  return create(session, "stock.move.line", {
    move_id: params.moveId,
    picking_id: params.pickingId,
    product_id: params.productId,
    product_uom_id: params.productUomId,
    lot_id: params.lotId,
    location_id: params.locationId,
    location_dest_id: params.locationDestId,
    qty_done: 0,
    reserved_uom_qty: 0,
  });
}

// Get stock.moves for a picking (demand info)
export async function getPickingMoves(session: OdooSession, pickingId: number) {
  return searchRead(
    session, "stock.move",
    [["picking_id", "=", pickingId]],
    ["id", "product_id", "product_uom_qty", "quantity_done", "product_uom", "state", "location_id", "location_dest_id", "move_line_ids"],
    200,
    "product_id"
  );
}

// Check availability (action_assign)
export async function checkAvailability(session: OdooSession, pickingId: number) {
  return callMethod(session, "stock.picking", "action_assign", [[pickingId]]);
}

// Set qty_done on a move line
export async function setMoveLineQtyDone(session: OdooSession, moveLineId: number, qtyDone: number, lotId?: number | null) {
  const vals: any = { qty_done: qtyDone };
  if (lotId) vals.lot_id = lotId;
  return write(session, "stock.move.line", [moveLineId], vals);
}

// Auto-fill all move lines qty_done = reserved_uom_qty
export async function autoFillPicking(session: OdooSession, pickingId: number) {
  const moveLines = await getPickingMoveLines(session, pickingId);
  for (const ml of moveLines) {
    if ((!ml.qty_done || ml.qty_done === 0) && ml.reserved_uom_qty > 0) {
      await write(session, "stock.move.line", [ml.id], { qty_done: ml.reserved_uom_qty });
    }
  }
  return moveLines.length;
}

// Get the PDF report for a picking (bon de livraison)
export function getPickingReportUrl(session: OdooSession, pickingId: number): string {
  // Standard Odoo delivery slip report
  return `${session.config.url}/report/pdf/stock.report_deliveryslip/${pickingId}`;
}

// ============================================
// INTERNAL TRANSFER — Odoo 16 compatible
// ============================================
export async function createInternalTransfer(
  session: OdooSession,
  sourceLocationId: number,
  destLocationId: number,
  lines: { productId: number; productName: string; qty: number; uomId: number; lotId?: number | null }[]
) {
  const pickingTypes = await searchRead(session, "stock.picking.type", [["code", "=", "internal"]], ["id"], 1);
  if (!pickingTypes.length) throw new Error("Aucun type d'opération interne trouvé");

  // Create picking + moves
  const pickingId = await create(session, "stock.picking", {
    picking_type_id: pickingTypes[0].id,
    location_id: sourceLocationId,
    location_dest_id: destLocationId,
    move_ids_without_package: lines.map((line) => [0, 0, {
      name: line.productName,
      product_id: line.productId,
      product_uom_qty: line.qty,
      product_uom: line.uomId,
      location_id: sourceLocationId,
      location_dest_id: destLocationId,
    }]),
  });

  // Confirm moves (state: draft → confirmed)
  await callMethod(session, "stock.picking", "action_confirm", [[pickingId]]);

  // Odoo auto-creates move lines after action_confirm (splits by lot/location from available stock).
  // Delete them all — we'll create the correct ones manually with explicit source + lot.
  const autoMoveLines = await searchRead(session, "stock.move.line",
    [["picking_id", "=", pickingId]],
    ["id"], 500
  );
  if (autoMoveLines.length) {
    await callMethod(session, "stock.move.line", "unlink", [autoMoveLines.map((ml: any) => ml.id)]);
  }

  // Get moves (one per product, or multiple if same product appears twice with different lots)
  const moves = await searchRead(session, "stock.move",
    [["picking_id", "=", pickingId]],
    ["id", "product_id", "product_uom"],
    200
  );

  // Build ordered list of moves per product (to handle same product + multiple lots)
  const movesByProduct: Record<number, any[]> = {};
  for (const move of moves) {
    const pid = Array.isArray(move.product_id) ? move.product_id[0] : move.product_id;
    if (!movesByProduct[pid]) movesByProduct[pid] = [];
    movesByProduct[pid].push(move);
  }

  // Create one move line per entry in lines — handles multiple lots for same product
  const usedMoveIdx: Record<number, number> = {};
  for (const line of lines) {
    const movesForProduct = movesByProduct[line.productId] || [];
    const idx = usedMoveIdx[line.productId] || 0;
    const move = movesForProduct[idx] || movesForProduct[0];
    if (!move) continue;
    usedMoveIdx[line.productId] = idx + 1;

    const uomId = Array.isArray(move.product_uom) ? move.product_uom[0] : move.product_uom;
    const mlData: any = {
      picking_id:       pickingId,
      move_id:          move.id,
      product_id:       line.productId,
      product_uom_id:   uomId || line.uomId,
      location_id:      sourceLocationId,   // ← source forcée, jamais écrasée par Odoo
      location_dest_id: destLocationId,
      qty_done:         line.qty,
      reserved_uom_qty: 0,
    };
    if (line.lotId) mlData.lot_id = line.lotId;

    await create(session, "stock.move.line", mlData);
  }

  return pickingId;
}

// Variante : un seul picking interne avec une destination différente par ligne.
// Chaque stock.move a son propre location_dest_id → Odoo gère ça nativement.
// Utilisé pour les retours : tous les produits partent de WH/Sortie mais
// vont chacun à leur emplacement d'origine (un seul transfert au lieu de N).
export async function createMultiDestTransfer(
  session: OdooSession,
  sourceLocationId: number,
  fallbackDestLocationId: number,
  lines: { productId: number; productName: string; qty: number; uomId: number; lotId?: number | null; destLocationId: number }[]
): Promise<number> {
  const pickingTypes = await searchRead(session, "stock.picking.type", [["code", "=", "internal"]], ["id"], 1);
  if (!pickingTypes.length) throw new Error("Aucun type d'opération interne trouvé");

  // Un seul picking — location_dest_id = fallback (écrasé au niveau move/move_line)
  const pickingId = await create(session, "stock.picking", {
    picking_type_id: pickingTypes[0].id,
    location_id: sourceLocationId,
    location_dest_id: fallbackDestLocationId,
    move_ids_without_package: lines.map((line) => [0, 0, {
      name: line.productName,
      product_id: line.productId,
      product_uom_qty: line.qty,
      product_uom: line.uomId,
      location_id: sourceLocationId,
      location_dest_id: line.destLocationId,  // destination spécifique par produit
    }]),
  });

  await callMethod(session, "stock.picking", "action_confirm", [[pickingId]]);

  // Supprimer les lignes auto-créées par Odoo (mauvaises sources/lots)
  const autoMoveLines = await searchRead(session, "stock.move.line",
    [["picking_id", "=", pickingId]], ["id"], 500);
  if (autoMoveLines.length) {
    await callMethod(session, "stock.move.line", "unlink", [autoMoveLines.map((ml: any) => ml.id)]);
  }

  // Récupérer les moves créés (un par ligne, dans l'ordre d'insertion)
  const moves = await searchRead(session, "stock.move",
    [["picking_id", "=", pickingId]],
    ["id", "product_id", "product_uom", "location_dest_id"],
    200
  );

  // Associer chaque ligne à son move (même produit → plusieurs moves possibles)
  const movesByProduct: Record<number, any[]> = {};
  for (const move of moves) {
    const pid = Array.isArray(move.product_id) ? move.product_id[0] : move.product_id;
    if (!movesByProduct[pid]) movesByProduct[pid] = [];
    movesByProduct[pid].push(move);
  }

  const usedMoveIdx: Record<number, number> = {};
  for (const line of lines) {
    const movesForProduct = movesByProduct[line.productId] || [];
    const idx = usedMoveIdx[line.productId] || 0;
    const move = movesForProduct[idx] || movesForProduct[0];
    if (!move) continue;
    usedMoveIdx[line.productId] = idx + 1;

    const uomId = Array.isArray(move.product_uom) ? move.product_uom[0] : move.product_uom;
    const mlData: any = {
      picking_id:       pickingId,
      move_id:          move.id,
      product_id:       line.productId,
      product_uom_id:   uomId || line.uomId,
      location_id:      sourceLocationId,
      location_dest_id: line.destLocationId,
      qty_done:         line.qty,
      reserved_uom_qty: 0,
    };
    if (line.lotId) mlData.lot_id = line.lotId;
    await create(session, "stock.move.line", mlData);
  }

  return pickingId;
}

// ============================================
// EMBALLAGE — Pack & Ship
// ============================================

/** OUT pickings en état "assigned" prêts à emballer (stock disponible en Sortie) */
export async function getPackablePickings(session: OdooSession): Promise<any[]> {
  return searchRead(session, "stock.picking",
    [["picking_type_code", "=", "outgoing"], ["state", "=", "assigned"]],
    ["id", "name", "state", "origin", "x_studio_cde_client", "partner_id", "scheduled_date",
     "date_deadline", "move_ids_without_package", "carrier_id"],
    200, "date_deadline asc, scheduled_date asc, id asc"
  );
}

/** Trouve le OUT picking lié à un PICK picking via group_id */
export async function findOutPickingFromPick(session: OdooSession, pickId: number): Promise<any | null> {
  const [pick] = await searchRead(session, "stock.picking", [["id", "=", pickId]], ["group_id"], 1);
  if (!pick?.group_id) return null;
  const groupId = Array.isArray(pick.group_id) ? pick.group_id[0] : pick.group_id;
  const outs = await searchRead(session, "stock.picking",
    [["group_id", "=", groupId], ["picking_type_code", "=", "outgoing"],
     ["state", "in", ["assigned", "confirmed", "waiting", "partially_available"]]],
    ["id", "name", "state", "origin", "partner_id", "scheduled_date", "date_deadline",
     "carrier_id", "move_ids_without_package"],
    1
  );
  return outs[0] || null;
}

/** Workflow complet emballage + expédition pour un OUT picking.
 *  1. action_assign  2. qty_done = réservé  3. crée N colis avec poids
 *  4. valide  5. send_to_shipper  6. retourne les pièces jointes PDF (étiquettes)
 */
export async function packAndShipOut(
  session: OdooSession,
  outPickingId: number,
  packageWeights: number[],
  printOptions?: { blPrinterId?: number; labelPrinterId?: number; blReportName?: string; overlayDate?: string }
): Promise<{ pickingName: string; labelAttachments: { id: number; name: string; datas: string }[]; labelsPending: boolean; blPrinted: boolean; blError?: string }> {
  const nPackages = packageWeights.length;
  if (!nPackages) throw new Error("Au moins un colis requis");

  // 1. Snapshot + pickInfo + action_assign + move lines — tout en parallèle
  //    Le picking est déjà "assigned" (c'est ainsi qu'on l'a trouvé), action_assign est quasi no-op
  const [before, pickInfo, , moveLines] = await Promise.all([
    searchRead(session, "ir.attachment",
      [["res_model", "=", "stock.picking"], ["res_id", "=", outPickingId], ["mimetype", "ilike", "pdf"]],
      ["id"], 100),
    searchRead(session, "stock.picking", [["id", "=", outPickingId]], ["name", "carrier_id"], 1),
    callMethod(session, "stock.picking", "action_assign", [[outPickingId]]).catch(() => null),
    searchRead(session, "stock.move.line",
      [["picking_id", "=", outPickingId], ["state", "not in", ["done", "cancel"]]],
      ["id", "reserved_uom_qty"], 500),
  ]);
  const existingIds  = new Set(before.map((a: any) => a.id));
  const pickingName  = pickInfo[0]?.name || `OUT-${outPickingId}`;
  const hasCarrier   = !!pickInfo[0]?.carrier_id;

  // 4. Créer les N colis EN PARALLÈLE, puis forcer le poids par write()
  //    (certaines versions Odoo ignorent shipping_weight au create — le write est obligatoire)
  const totalWeight = packageWeights.reduce((s, w) => s + w, 0);
  const packageIds = await Promise.all(
    packageWeights.map(() =>
      create(session, "stock.quant.package", {}) as Promise<number>
    )
  );
  // Écriture explicite du poids sur chaque colis
  await Promise.all(
    packageIds.map((pkgId, i) =>
      write(session, "stock.quant.package", [pkgId], { shipping_weight: packageWeights[i] }).catch(() => null)
    )
  );

  // 5+6+7. Tout le reste en parallèle : qty_done sur move lines, result_package sur colis 1,
  //         package.level pour colis 2..N, mise à jour nb colis + poids total
  const tasks: Promise<any>[] = [];

  // 5. qty_done = reserved (1 seul write batch au lieu d'un par ligne)
  const mlsToFill = moveLines.filter((ml: any) => ml.reserved_uom_qty > 0);
  if (mlsToFill.length) {
    // On groupe par qté pour batcher quand possible
    const byQty: Record<number, number[]> = {};
    for (const ml of mlsToFill) {
      const q = ml.reserved_uom_qty;
      if (!byQty[q]) byQty[q] = [];
      byQty[q].push(ml.id);
    }
    for (const [qtyStr, ids] of Object.entries(byQty)) {
      tasks.push(write(session, "stock.move.line", ids, { qty_done: parseFloat(qtyStr) }));
    }
  }

  // 6. Distribuer les move lines en round-robin sur les N colis
  //    → chaque colis reçoit du contenu → TNT génère 1 étiquette par colis
  if (moveLines.length && packageIds.length) {
    // Grouper par colis cible pour batcher les writes
    const mlsByPkg: Record<number, number[]> = {};
    for (let i = 0; i < moveLines.length; i++) {
      const pkgId = packageIds[i % packageIds.length];
      if (!mlsByPkg[pkgId]) mlsByPkg[pkgId] = [];
      mlsByPkg[pkgId].push(moveLines[i].id);
    }
    for (const [pkgId, ids] of Object.entries(mlsByPkg)) {
      tasks.push(write(session, "stock.move.line", ids, { result_package_id: Number(pkgId) }));
    }
  }

  // 7. Si nPackages > moveLines.length, certains colis n'ont pas de lignes → stock.package.level
  const assignedCount = Math.min(moveLines.length, packageIds.length);
  for (let i = assignedCount; i < packageIds.length; i++) {
    tasks.push(
      create(session, "stock.package.level", {
        package_id: packageIds[i], picking_id: outPickingId, is_done: true,
      }).catch(() => null)
    );
  }

  // 8. Mettre à jour nb colis + poids total sur le picking
  tasks.push(
    write(session, "stock.picking", [outPickingId], {
      number_of_packages: nPackages,
      shipping_weight: totalWeight,
    }).catch(() =>
      // number_of_packages peut ne pas exister — fallback poids seul
      write(session, "stock.picking", [outPickingId], { shipping_weight: totalWeight }).catch(() => null)
    )
  );

  await Promise.all(tasks);

  // 9. Valider le picking OUT
  await validatePicking(session, outPickingId);

  // 10. Polling étiquettes (helper interne) — intervalle 200ms pour réactivité
  const pollLabels = async (maxMs: number): Promise<any[]> => {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      const atts = await searchRead(session, "ir.attachment",
        [["res_model", "=", "stock.picking"], ["res_id", "=", outPickingId], ["mimetype", "ilike", "pdf"]],
        ["id", "name", "datas", "create_date"], 100);
      const fresh = atts.filter((a: any) => !existingIds.has(a.id));
      if (fresh.length > 0) return fresh;
      await new Promise(r => setTimeout(r, 200));
    }
    return [];
  };

  // 11. BL en parallèle avec le polling étiquette
  const blPromise = printOptions?.blPrinterId
    ? printPickingReportDirect(session, outPickingId, printOptions.blPrinterId, {
        reportName: printOptions.blReportName || getSavedPrepReportName(),
        title: `BL_${pickingName}.pdf`,
        overlayDate: printOptions.overlayDate,
      })
    : Promise.resolve({ success: false, error: undefined as string | undefined });

  // 12. Étiquettes transporteur — poll rapide (1.5s), si rien → fallback send_to_shipper async
  //     On ne bloque PAS l'UI sur le polling long : on renvoie labelsPending=true et
  //     le client relance fetchLabels() en arrière-plan si nécessaire.
  let labelAttachments: any[] = [];
  const quickLabels = await pollLabels(1500);
  if (quickLabels.length > 0) {
    labelAttachments = quickLabels;
  } else if (hasCarrier) {
    // Lancer send_to_shipper + poll en arrière-plan (non-bloquant)
    // → la fonction retourne tout de suite avec labelsPending=true
    // → le caller poll via fetchLabelAttachments() séparément
    (async () => {
      try { await callMethod(session, "stock.picking", "send_to_shipper", [[outPickingId]]); } catch {}
    })();
  }

  const blResultRaw = await blPromise;
  const blPrinted = blResultRaw.success;
  const blError: string | undefined = !blResultRaw.success
    ? (blResultRaw.error || (printOptions?.blPrinterId ? "Échec impression BL (raison inconnue)" : undefined))
    : undefined;

  return {
    pickingName,
    labelAttachments,
    labelsPending: hasCarrier && labelAttachments.length === 0,
    blPrinted,
    blError,
  };
}

/** Valide un picking satellite (commande groupée) SANS transporteur.
 *  Pas de colis créé, pas de send_to_shipper — juste qty_done + validate + impression BL optionnelle.
 */
export async function validateSatellitePicking(
  session: OdooSession,
  pickingId: number,
  printOptions?: { blPrinterId?: number; blReportName?: string; overlayDate?: string }
): Promise<{ name: string; blPrinted: boolean; blError?: string }> {
  const [info] = await searchRead(session, "stock.picking", [["id", "=", pickingId]], ["name"], 1);
  const pickingName = info?.name || `OUT-${pickingId}`;

  await callMethod(session, "stock.picking", "action_assign", [[pickingId]]);

  const moveLines = await searchRead(session, "stock.move.line",
    [["picking_id", "=", pickingId], ["state", "not in", ["done", "cancel"]]],
    ["id", "reserved_uom_qty"], 500);

  const mlsToFill = moveLines.filter((ml: any) => ml.reserved_uom_qty > 0);
  if (mlsToFill.length) {
    const byQty: Record<number, number[]> = {};
    for (const ml of mlsToFill) {
      const q = ml.reserved_uom_qty;
      if (!byQty[q]) byQty[q] = [];
      byQty[q].push(ml.id);
    }
    await Promise.all(
      Object.entries(byQty).map(([qtyStr, ids]) =>
        write(session, "stock.move.line", ids, { qty_done: parseFloat(qtyStr) })
      )
    );
  }

  await validatePicking(session, pickingId);

  let blPrinted = false;
  let blError: string | undefined;
  if (printOptions?.blPrinterId) {
    const blResult = await printPickingReportDirect(session, pickingId, printOptions.blPrinterId, {
      reportName: printOptions.blReportName || getSavedPrepReportName(),
      title: `BL_${pickingName}.pdf`,
      overlayDate: printOptions.overlayDate,
    });
    blPrinted = blResult.success;
    if (!blResult.success) blError = blResult.error || "Échec impression BL";
  }

  return { name: pickingName, blPrinted, blError };
}

// Recherche les OUT validés (state=done) par nom/origine/partenaire
export async function searchDoneOutPickings(session: OdooSession, query: string): Promise<any[]> {
  const domain: any[] = [["state", "=", "done"], ["picking_type_code", "=", "outgoing"]];
  const trimmed = query.trim();
  if (trimmed) {
    domain.push("|", "|", "|",
      ["name", "ilike", trimmed],
      ["origin", "ilike", trimmed],
      ["partner_id.name", "ilike", trimmed],
      ["carrier_tracking_ref", "ilike", trimmed],
    );
  }
  return searchRead(session, "stock.picking",
    domain,
    ["id", "name", "origin", "partner_id", "carrier_id", "carrier_tracking_ref", "date_done", "state"],
    50, "date_done desc"
  );
}

// Recherche un OUT par numéro de commande (origin) ou numéro OUT — tous états
// Cherche UNIQUEMENT sur origin et name pour éviter les faux-positifs sur partenaire/tracking
export async function searchPickingByCommande(session: OdooSession, ref: string): Promise<any[]> {
  const trimmed = ref.trim();
  const domain: any[] = [
    ["picking_type_code", "=", "outgoing"],
    ["state", "in", ["done", "assigned", "waiting", "confirmed"]],
    "|",
      ["origin", "=", trimmed],      // correspondance exacte d'abord
      ["name", "=", trimmed],
  ];
  let results = await searchRead(session, "stock.picking",
    domain,
    ["id", "name", "origin", "partner_id", "carrier_id", "carrier_tracking_ref", "date_done", "state"],
    20, "date_done desc"
  );
  // Si rien en exact, fallback ilike sur origin + name seulement (pas partenaire/tracking)
  if (results.length === 0) {
    const domain2: any[] = [
      ["picking_type_code", "=", "outgoing"],
      ["state", "in", ["done", "assigned", "waiting", "confirmed"]],
      "|",
        ["origin", "ilike", trimmed],
        ["name", "ilike", trimmed],
    ];
    results = await searchRead(session, "stock.picking",
      domain2,
      ["id", "name", "origin", "partner_id", "carrier_id", "carrier_tracking_ref", "date_done", "state"],
      20, "date_done desc"
    );
  }
  return results;
}

// Récupère les pièces jointes PDF d'un picking (labels transporteur)
export async function getPickingAttachments(session: OdooSession, pickingId: number): Promise<any[]> {
  return searchRead(session, "ir.attachment",
    [["res_model", "=", "stock.picking"], ["res_id", "=", pickingId], ["mimetype", "ilike", "pdf"]],
    ["id", "name", "datas", "mimetype", "create_date"],
    20
  );
}

// Re-déclenche l'envoi au transporteur (peut fonctionner si le picking est toujours accessible)
export async function resendToShipper(session: OdooSession, pickingId: number): Promise<void> {
  await callMethod(session, "stock.picking", "send_to_shipper", [[pickingId]]);
}

export async function validatePicking(session: OdooSession, pickingId: number) {
  const result = await callMethod(session, "stock.picking", "button_validate", [[pickingId]]);

  // Handle Odoo wizards
  if (result && typeof result === "object" && result.res_model) {
    const wizardModel = result.res_model;
    const wizardId = result.res_id;
    const ctx = result.context || {};

    if (wizardModel === "stock.immediate.transfer") {
      await call(session, "/web/dataset/call_kw", {
        model: "stock.immediate.transfer", method: "process", args: [[wizardId]], kwargs: { context: ctx },
      });
    } else if (wizardModel === "stock.backorder.confirmation") {
      await call(session, "/web/dataset/call_kw", {
        model: "stock.backorder.confirmation", method: "process", args: [[wizardId]], kwargs: { context: ctx },
      });
    }
  }

  return result;
}

// Comme validatePicking mais REFUSE de créer un reliquat.
// Lève une erreur avec la liste des articles manquants si Odoo veut un backorder.
export async function validatePickingStrict(session: OdooSession, pickingId: number): Promise<void> {
  const result = await callMethod(session, "stock.picking", "button_validate", [[pickingId]]);

  if (result && typeof result === "object" && result.res_model) {
    const wizardModel = result.res_model;
    const wizardId = result.res_id;
    const ctx = result.context || {};

    if (wizardModel === "stock.immediate.transfer") {
      // Qtés non renseignées → OK, on force avec les qtés réservées
      await call(session, "/web/dataset/call_kw", {
        model: "stock.immediate.transfer", method: "process", args: [[wizardId]], kwargs: { context: ctx },
      });
    } else if (wizardModel === "stock.backorder.confirmation") {
      // Récupérer les lignes incomplètes pour afficher un message utile
      const missing = await searchRead(session, "stock.move.line",
        [["picking_id", "=", pickingId], ["state", "not in", ["done", "cancel"]]],
        ["product_id", "qty_done", "reserved_uom_qty"], 10
      );
      const names = missing
        .filter((l: any) => (l.qty_done || 0) < (l.reserved_uom_qty || 0))
        .slice(0, 3)
        .map((l: any) => `${l.product_id?.[1] || "?"} (${l.qty_done || 0}/${l.reserved_uom_qty})`)
        .join(", ");
      throw new Error(`Reliquat détecté — articles incomplets : ${names || "vérifiez le picking"}`);
    }
  }
}

// ============================================
// PACKING LIST — Match supplier refs to internal products
// ============================================

// Match supplier references to internal products via product.supplierinfo
export async function matchSupplierRefs(session: OdooSession, supplierRefs: string[]) {
  if (!supplierRefs.length) return {};

  const supplierInfos = await searchRead(
    session, "product.supplierinfo",
    [["product_code", "in", supplierRefs]],
    ["id", "product_code", "product_id", "product_tmpl_id"],
    supplierRefs.length * 2
  );

  const refToProduct: Record<string, any> = {};
  const productIds = new Set<number>();

  for (const si of supplierInfos) {
    if (si.product_id) {
      refToProduct[si.product_code] = { product_id: si.product_id[0], product_name: si.product_id[1] };
      productIds.add(si.product_id[0]);
    } else if (si.product_tmpl_id) {
      refToProduct[si.product_code] = { product_tmpl_id: si.product_tmpl_id[0], product_name: si.product_tmpl_id[1] };
    }
  }

  // For template-only matches, find the product.product
  const tmplOnlyRefs = Object.entries(refToProduct).filter(([_, v]) => v.product_tmpl_id && !v.product_id);
  if (tmplOnlyRefs.length > 0) {
    const tmplIds = tmplOnlyRefs.map(([_, v]) => v.product_tmpl_id);
    const products = await searchRead(
      session, "product.product",
      [["product_tmpl_id", "in", tmplIds]],
      ["id", "name", "product_tmpl_id", "default_code", "barcode"],
      tmplIds.length * 2
    );
    const tmplToProduct: Record<number, any> = {};
    for (const p of products) tmplToProduct[p.product_tmpl_id[0]] = p;

    for (const [ref, val] of tmplOnlyRefs) {
      const prod = tmplToProduct[val.product_tmpl_id];
      if (prod) {
        refToProduct[ref] = { product_id: prod.id, product_name: prod.name, default_code: prod.default_code, barcode: prod.barcode };
        productIds.add(prod.id);
      }
    }
  }

  // Enrich product info
  if (productIds.size > 0) {
    const products = await searchRead(
      session, "product.product",
      [["id", "in", Array.from(productIds)]],
      ["id", "name", "default_code", "barcode"],
      productIds.size
    );
    const prodMap: Record<number, any> = {};
    for (const p of products) prodMap[p.id] = p;

    for (const [ref, val] of Object.entries(refToProduct)) {
      if (val.product_id && prodMap[val.product_id]) {
        const p = prodMap[val.product_id];
        refToProduct[ref] = { ...val, product_name: p.name, default_code: p.default_code, barcode: p.barcode };
      }
    }
  }

  return refToProduct;
}

// ─── Matching E-shop SKU → produit Odoo (3 stratégies en cascade) ──────────────
//
// 1. Référence fournisseur (product.supplierinfo.product_code)
// 2. EAN / barcode (product.product.barcode)
// 3. Nom similaire (ilike sur product.template.name)
//
export interface EshopMatchResult {
  product_id: number;
  product_name: string;
  default_code: string;
  barcode: string;
  match_method: "supplier_ref" | "ref" | "barcode" | "name";
}

export async function matchEshopSkus(
  session: OdooSession,
  skus: string[],
  // Libellés Shopware par SKU — utilisés pour conserver le nom d'origine
  // (ex: "… (avantage fidélité)") sur les articles préfixés LR.
  descriptions?: Record<string, string>
): Promise<Record<string, EshopMatchResult>> {
  if (!skus.length) return {};

  const result: Record<string, EshopMatchResult> = {};
  const remaining = new Set(skus);

  // Helper — enrichit un product.product et le met dans result
  const addMatch = (sku: string, prod: any, method: EshopMatchResult["match_method"]) => {
    result[sku] = {
      product_id: prod.id,
      product_name: prod.name,
      default_code: prod.default_code || "",
      barcode: prod.barcode || "",
      match_method: method,
    };
    remaining.delete(sku);
  };

  // ── Stratégie 1 : référence fournisseur ──────────────────────────────────
  const supplierInfos = await searchRead(
    session, "product.supplierinfo",
    [["product_code", "in", skus]],
    ["id", "product_code", "product_id", "product_tmpl_id"],
    skus.length * 3
  );

  const tmplIds: number[] = [];
  const tmplToSku: Record<number, string> = {};

  for (const si of supplierInfos) {
    const sku = si.product_code;
    if (!remaining.has(sku)) continue;
    if (si.product_id) {
      // On a déjà un product.product — on enrichit après
      result[sku] = { product_id: si.product_id[0], product_name: si.product_id[1], default_code: "", barcode: "", match_method: "supplier_ref" };
      remaining.delete(sku);
    } else if (si.product_tmpl_id) {
      tmplIds.push(si.product_tmpl_id[0]);
      tmplToSku[si.product_tmpl_id[0]] = sku;
    }
  }

  // Résoudre les template → product.product
  if (tmplIds.length > 0) {
    const variants = await searchRead(
      session, "product.product",
      [["product_tmpl_id", "in", tmplIds]],
      ["id", "name", "product_tmpl_id", "default_code", "barcode"],
      tmplIds.length * 3
    );
    for (const v of variants) {
      const tmplId = Array.isArray(v.product_tmpl_id) ? v.product_tmpl_id[0] : v.product_tmpl_id;
      const sku = tmplToSku[tmplId];
      if (sku && remaining.has(sku)) addMatch(sku, v, "supplier_ref");
    }
  }

  // Enrichir les matchs supplier_ref qui n'ont pas encore default_code/barcode
  const needsEnrich = Object.entries(result).filter(([_, v]) => v.match_method === "supplier_ref" && !v.default_code && !v.barcode);
  if (needsEnrich.length > 0) {
    const ids = needsEnrich.map(([_, v]) => v.product_id);
    const products = await searchRead(session, "product.product", [["id", "in", ids]], ["id", "name", "default_code", "barcode"], ids.length);
    const pMap: Record<number, any> = {};
    for (const p of products) pMap[p.id] = p;
    for (const [sku, val] of needsEnrich) {
      const p = pMap[val.product_id];
      if (p) { result[sku].default_code = p.default_code || ""; result[sku].barcode = p.barcode || ""; result[sku].product_name = p.name; }
    }
  }

  if (remaining.size === 0) return result;

  // ── Stratégie 1bis : référence Odoo (default_code) ───────────────────────
  // Si la réf fournisseur n'a rien donné, on tente la réf interne Odoo.
  const remainingForRef = Array.from(remaining);
  const byDefaultCode = await searchRead(
    session, "product.product",
    [["default_code", "in", remainingForRef]],
    ["id", "name", "default_code", "barcode"],
    remainingForRef.length
  );
  for (const p of byDefaultCode) {
    const sku = remainingForRef.find(s => s === p.default_code);
    if (sku && remaining.has(sku)) addMatch(sku, p, "ref");
  }

  if (remaining.size === 0) return result;

  // ── Stratégie 2 : EAN / barcode ──────────────────────────────────────────
  const remainingArr = Array.from(remaining);
  const byBarcode = await searchRead(
    session, "product.product",
    [["barcode", "in", remainingArr]],
    ["id", "name", "default_code", "barcode"],
    remainingArr.length
  );
  for (const p of byBarcode) {
    const sku = remainingArr.find(s => s === p.barcode);
    if (sku) addMatch(sku, p, "barcode");
  }

  if (remaining.size === 0) return result;

  // ── Stratégie 2bis : réf fournisseur / réf Odoo insensible casse-format ───
  // Repli quand "=" exact a raté (casse, espaces parasites, zéro initial…).
  for (const sku of Array.from(remaining)) {
    const s = sku.trim();
    if (!s) continue;
    // a) réf fournisseur (product.supplierinfo.product_code) en =ilike
    const si = await searchRead(
      session, "product.supplierinfo",
      [["product_code", "=ilike", s]],
      ["product_id", "product_tmpl_id"], 1
    );
    let prod: any = null;
    if (si.length && si[0].product_id) {
      const pid = si[0].product_id[0];
      const ps = await searchRead(session, "product.product", [["id", "=", pid]], ["id", "name", "default_code", "barcode"], 1);
      if (ps.length) prod = ps[0];
    } else if (si.length && si[0].product_tmpl_id) {
      const ps = await searchRead(session, "product.product", [["product_tmpl_id", "=", si[0].product_tmpl_id[0]]], ["id", "name", "default_code", "barcode"], 1);
      if (ps.length) prod = ps[0];
    }
    // b) sinon réf Odoo (default_code) en =ilike, actifs ou archivés
    if (!prod) {
      const ps = await searchRead(session, "product.product", [["default_code", "=ilike", s], ["active", "in", [true, false]]], ["id", "name", "default_code", "barcode"], 1);
      if (ps.length) prod = ps[0];
    }
    if (prod) addMatch(sku, prod, "ref");
  }

  if (remaining.size === 0) return result;

  // ── Stratégie 3 : nom similaire (ilike) ──────────────────────────────────
  // On cherche chaque SKU restant comme fragment de nom — on prend le meilleur match
  for (const sku of Array.from(remaining)) {
    // Nettoyer le SKU pour en faire un fragment de nom utilisable
    const fragment = sku.replace(/[-_]/g, " ").replace(/\s+/g, " ").trim();
    if (fragment.length < 3) continue;
    const found = await searchRead(
      session, "product.product",
      [["name", "ilike", fragment], ["active", "in", [true, false]]],
      ["id", "name", "default_code", "barcode"],
      1
    );
    if (found.length > 0) addMatch(sku, found[0], "name");
  }

  if (remaining.size === 0) return result;

  // ── Stratégie 4 : SKU "avantage fidélité" préfixé LR ──────────────────────
  // Certains produits Shopware ont pour code : "LR" + référence fournisseur
  // (ex: LR12345 → réf fournisseur 12345). On retire le préfixe LR et on
  // rebranche sur la réf fournisseur (puis réf interne / barcode en secours).
  const lrSkus = Array.from(remaining).filter(s => /^LR\d/i.test(s.trim()));
  if (lrSkus.length > 0) {
    // map code nettoyé → sku original (pour réattribuer le résultat au bon SKU)
    const cleanToSku: Record<string, string> = {};
    for (const sku of lrSkus) {
      const clean = sku.trim().replace(/^LR/i, "");
      if (clean) cleanToSku[clean] = sku;
    }
    const cleans = Object.keys(cleanToSku);

    // a) réf fournisseur sur le code nettoyé
    const sInfos = await searchRead(
      session, "product.supplierinfo",
      [["product_code", "in", cleans]],
      ["id", "product_code", "product_id", "product_tmpl_id"],
      cleans.length * 3
    );
    const lrTmplIds: number[] = [];
    const lrTmplToSku: Record<number, string> = {};
    for (const si of sInfos) {
      const sku = cleanToSku[si.product_code];
      if (!sku || !remaining.has(sku)) continue;
      if (si.product_id) {
        result[sku] = { product_id: si.product_id[0], product_name: si.product_id[1], default_code: "", barcode: "", match_method: "supplier_ref" };
        remaining.delete(sku);
      } else if (si.product_tmpl_id) {
        lrTmplIds.push(si.product_tmpl_id[0]);
        lrTmplToSku[si.product_tmpl_id[0]] = sku;
      }
    }
    if (lrTmplIds.length > 0) {
      const variants = await searchRead(
        session, "product.product",
        [["product_tmpl_id", "in", lrTmplIds]],
        ["id", "name", "product_tmpl_id", "default_code", "barcode"],
        lrTmplIds.length * 3
      );
      for (const v of variants) {
        const tmplId = Array.isArray(v.product_tmpl_id) ? v.product_tmpl_id[0] : v.product_tmpl_id;
        const sku = lrTmplToSku[tmplId];
        if (sku && remaining.has(sku)) addMatch(sku, v, "supplier_ref");
      }
    }

    // Enrichir les matchs LR sans default_code/barcode
    const lrNeedsEnrich = lrSkus.filter(s => result[s] && !result[s].default_code && !result[s].barcode);
    if (lrNeedsEnrich.length > 0) {
      const ids = lrNeedsEnrich.map(s => result[s].product_id);
      const products = await searchRead(session, "product.product", [["id", "in", ids]], ["id", "name", "default_code", "barcode"], ids.length);
      const pMap: Record<number, any> = {};
      for (const p of products) pMap[p.id] = p;
      for (const s of lrNeedsEnrich) {
        const p = pMap[result[s].product_id];
        if (p) { result[s].default_code = p.default_code || ""; result[s].barcode = p.barcode || ""; result[s].product_name = p.name; }
      }
    }

    // b) secours : réf interne (default_code) puis barcode sur le code nettoyé
    const stillLr = lrSkus.filter(s => remaining.has(s));
    for (const sku of stillLr) {
      const clean = sku.trim().replace(/^LR/i, "");
      if (!clean) continue;
      let found = await searchRead(
        session, "product.product",
        [["default_code", "=ilike", clean], ["active", "in", [true, false]]],
        ["id", "name", "default_code", "barcode"], 1
      );
      if (!found.length) {
        found = await searchRead(
          session, "product.product",
          [["barcode", "=", clean]],
          ["id", "name", "default_code", "barcode"], 1
        );
      }
      if (found.length > 0) addMatch(sku, found[0], "supplier_ref");
    }

    // Conserver le libellé Shopware d'origine (ex: "… (avantage fidélité)")
    // pour les articles LR qui ont matché — on garde la réf/barcode Odoo mais le nom Shopware.
    if (descriptions) {
      for (const sku of lrSkus) {
        const m = result[sku];
        const desc = descriptions[sku];
        if (m && desc && desc.trim()) m.product_name = desc.trim();
      }
    }
  }

  return result;
}

// Get main stock location for product IDs (where most qty is stored)
export async function getProductLocations(session: OdooSession, productIds: number[]) {
  if (!productIds.length) return {};

  const quants = await searchRead(
    session, "stock.quant",
    [["product_id", "in", productIds], ["quantity", ">", 0], ["location_id.usage", "=", "internal"]],
    ["product_id", "location_id", "quantity"],
    2000,
    "quantity desc"
  );

  // Exclure les zones de sortie/expédition (usage=internal mais nom trompeur)
  const EXCLUDE_LOC = /sortie|output|expéd|dispatch|transit/i;

  const prodLocMap: Record<number, { location_id: number; location_name: string; quantity: number }> = {};
  for (const q of quants) {
    const locName: string = q.location_id[1] || "";
    if (EXCLUDE_LOC.test(locName)) continue; // skip sortie-type locations
    const pid = q.product_id[0];
    if (!prodLocMap[pid] || q.quantity > prodLocMap[pid].quantity) {
      prodLocMap[pid] = { location_id: q.location_id[0], location_name: locName, quantity: q.quantity };
    }
  }

  return prodLocMap;
}

// ============================================
// ESHOP PREPARED ORDERS — shared via ir.attachment, reset daily
// ============================================

export async function savePreparedOrders(session: OdooSession, orderNumbers: string[]) {
  const today = new Date().toISOString().split("T")[0];
  const jsonStr = JSON.stringify({ date: today, orders: orderNumbers });
  const bytes = new TextEncoder().encode(jsonStr);
  let b64 = "";
  for (let i = 0; i < bytes.length; i += 8192)
    b64 += String.fromCharCode(...Array.from(bytes.slice(i, i + 8192)));
  b64 = btoa(b64);
  const fileName = "eshop_prepared_orders.json";
  const existing = await searchRead(session, "ir.attachment", [["name", "=", fileName]], ["id"], 1);
  if (existing.length > 0) {
    await write(session, "ir.attachment", [existing[0].id], { datas: b64 });
  } else {
    await create(session, "ir.attachment", { name: fileName, type: "binary", datas: b64, mimetype: "application/json", public: true });
  }
}

export async function loadPreparedOrders(session: OdooSession): Promise<string[]> {
  const today = new Date().toISOString().split("T")[0];
  const attachments = await searchRead(session, "ir.attachment", [["name", "=", "eshop_prepared_orders.json"]], ["datas"], 1);
  if (!attachments.length || !attachments[0].datas) return [];
  const binary = atob(attachments[0].datas);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const data = JSON.parse(new TextDecoder().decode(bytes));
  // Reset if not today
  if (data.date !== today) return [];
  return data.orders || [];
}

// ============================================
// ARRIVAGE RANGEMENT STATE — persisted per packing list
// ============================================
export async function saveRangedState(session: OdooSession, packingName: string, rangedKeys: string[]): Promise<void> {
  const fileName = `arrivage_ranged_${packingName}.json`;
  const jsonStr = JSON.stringify({ keys: rangedKeys, updatedAt: new Date().toISOString() });
  const bytes = new TextEncoder().encode(jsonStr);
  let b64 = "";
  for (let i = 0; i < bytes.length; i += 8192)
    b64 += String.fromCharCode(...Array.from(bytes.slice(i, i + 8192)));
  b64 = btoa(b64);
  const existing = await searchRead(session, "ir.attachment", [["name", "=", fileName]], ["id"], 1);
  if (existing.length > 0) {
    await write(session, "ir.attachment", [existing[0].id], { datas: b64 });
  } else {
    await create(session, "ir.attachment", { name: fileName, type: "binary", datas: b64, mimetype: "application/json", public: true });
  }
}

export async function loadRangedState(session: OdooSession, packingName: string): Promise<string[]> {
  const fileName = `arrivage_ranged_${packingName}.json`;
  const attachments = await searchRead(session, "ir.attachment", [["name", "=", fileName]], ["datas"], 1);
  if (!attachments.length || !attachments[0].datas) return [];
  try {
    const binary = atob(attachments[0].datas);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const data = JSON.parse(new TextDecoder().decode(bytes));
    return data.keys || [];
  } catch { return []; }
}

export async function deleteRangedState(session: OdooSession, packingName: string): Promise<void> {
  const fileName = `arrivage_ranged_${packingName}.json`;
  const existing = await searchRead(session, "ir.attachment", [["name", "=", fileName]], ["id"], 1);
  if (existing.length) await callMethod(session, "ir.attachment", "unlink", [[existing[0].id]]);
}

// ESHOP CHARIOT SKUS — shared list via ir.attachment
// ============================================

export async function saveChariotSkus(session: OdooSession, skus: string[]) {
  const jsonStr = JSON.stringify(skus);
  const bytes = new TextEncoder().encode(jsonStr);
  let b64 = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    b64 += String.fromCharCode(...Array.from(bytes.slice(i, i + 8192)));
  }
  b64 = btoa(b64);
  const fileName = "eshop_chariot_skus.json";
  const existing = await searchRead(session, "ir.attachment", [["name", "=", fileName]], ["id"], 1);
  if (existing.length > 0) {
    await write(session, "ir.attachment", [existing[0].id], { datas: b64 });
    return;
  }
  await create(session, "ir.attachment", { name: fileName, type: "binary", datas: b64, mimetype: "application/json", public: true });
}

export async function loadChariotSkus(session: OdooSession): Promise<string[]> {
  const attachments = await searchRead(session, "ir.attachment", [["name", "=", "eshop_chariot_skus.json"]], ["datas"], 1);
  if (!attachments.length || !attachments[0].datas) return [];
  const binary = atob(attachments[0].datas);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return JSON.parse(new TextDecoder().decode(bytes));
}

// Ajoute une réf à la liste chariot eShop (lit, ajoute si absente, sauve).
export async function addChariotSku(session: OdooSession, sku: string): Promise<void> {
  const list = await loadChariotSkus(session);
  if (!list.includes(sku)) { list.push(sku); await saveChariotSkus(session, list); }
}

// PACKING LIST STORAGE — Save/load parsed packing lists via Odoo ir.attachment
// ============================================

export async function savePackingList(session: OdooSession, name: string, data: any) {
  const jsonStr = JSON.stringify(data);
  // Encode to base64 safely (handle unicode)
  const bytes = new TextEncoder().encode(jsonStr);
  let b64 = "";
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    b64 += String.fromCharCode(...Array.from(bytes.slice(i, i + chunk)));
  }
  b64 = btoa(b64);

  const fileName = `packing_${name}.json`;

  // Check if one already exists with same name
  const existing = await searchRead(session, "ir.attachment", [["name", "=", fileName]], ["id"], 1);
  if (existing.length > 0) {
    await write(session, "ir.attachment", [existing[0].id], { datas: b64 });
    return existing[0].id;
  }

  // Create new — no res_model/res_id to avoid permission issues
  return create(session, "ir.attachment", {
    name: fileName,
    type: "binary",
    datas: b64,
    mimetype: "application/json",
    public: true,
  });
}

export async function loadPackingList(session: OdooSession, name: string) {
  const fileName = `packing_${name}.json`;
  const attachments = await searchRead(
    session, "ir.attachment",
    [["name", "=", fileName]],
    ["id", "name", "datas", "write_date"],
    1, "write_date desc"
  );
  if (!attachments.length) return null;
  const b64 = attachments[0].datas;
  // Decode base64 safely
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const jsonStr = new TextDecoder().decode(bytes);
  return { ...JSON.parse(jsonStr), _attachmentId: attachments[0].id, _savedAt: attachments[0].write_date };
}

export async function listPackingLists(session: OdooSession) {
  return searchRead(
    session, "ir.attachment",
    [["name", "ilike", "packing_"], ["name", "ilike", ".json"]],
    ["id", "name", "write_date", "create_date"],
    50, "write_date desc"
  );
}

export async function deletePackingList(session: OdooSession, attachmentId: number) {
  return callMethod(session, "ir.attachment", "unlink", [[attachmentId]]);
}

// ============================================
// INVENTORY ADJUSTMENTS
// ============================================

// Get all stock.quant ids for a product (with optional lot filter)
export async function getQuantsForProduct(session: OdooSession, productId: number): Promise<any[]> {
  const quants = await searchRead(
    session, "stock.quant",
    [["product_id", "=", productId], ["location_id.usage", "=", "internal"]],
    ["id", "location_id", "lot_id", "quantity", "reserved_quantity", "inventory_quantity"],
    500, "location_id"
  );

  // Enrich lot expiry
  const lotIds = Array.from(new Set(quants.filter((q: any) => q.lot_id).map((q: any) => q.lot_id[0]))) as number[];
  if (lotIds.length > 0) {
    const lots = await searchRead(session, "stock.lot", [["id", "in", lotIds]], ["id", "name", "expiration_date", "use_date"], lotIds.length);
    const lotMap: Record<number, any> = {};
    for (const l of lots) lotMap[l.id] = l;
    for (const q of quants) {
      if (q.lot_id) {
        const lot = lotMap[q.lot_id[0]];
        if (lot) q.expiry = lot.expiration_date || lot.use_date || "";
      }
    }
  }

  return quants;
}

// ============================================
// VOLUME COMMANDE → reco emballage
// ============================================

// Parse "165mm x 28mm x 36mm" (ou "16,5 x 2,8 x 3,6 cm") → volume en cm³.
// Retourne 0 si non parsable.
export function parseDimsToCm3(raw: string): number {
  if (!raw) return 0;
  const s = String(raw).toLowerCase();
  const nums = (s.match(/[\d]+(?:[.,]\d+)?/g) || []).map(n => parseFloat(n.replace(",", ".")));
  if (nums.length < 3) return 0;
  let [l, w, h] = nums;
  // unité : mm par défaut si "mm" présent, sinon cm
  if (/mm/.test(s)) { l /= 10; w /= 10; h /= 10; }
  const v = l * w * h;
  return isFinite(v) && v > 0 ? v : 0;
}

// Calcule le volume total (cm³) d'un ensemble de lignes { productId, quantity }.
// Lit x_dimensions sur product.template (fallback volume m³ si dispo).
export async function getOrderVolumeCm3(
  session: OdooSession,
  lines: { productId: number; quantity: number }[]
): Promise<{ totalCm3: number; missing: number[] }> {
  const ids = Array.from(new Set(lines.map(l => l.productId).filter(Boolean)));
  if (!ids.length) return { totalCm3: 0, missing: [] };
  const prods = await searchRead(
    session, "product.product",
    [["id", "in", ids]],
    ["id", "product_tmpl_id", "volume"], ids.length
  );
  const tmplIds = Array.from(new Set(prods.map((p: any) => p.product_tmpl_id?.[0]).filter(Boolean)));
  const tmpls = tmplIds.length
    ? await searchRead(session, "product.template", [["id", "in", tmplIds]], ["id", "x_dimensions", "volume"], tmplIds.length)
    : [];
  const tmplMap: Record<number, any> = {};
  for (const t of tmpls) tmplMap[t.id] = t;
  const volByProduct: Record<number, number> = {};
  for (const p of prods) {
    const t = tmplMap[p.product_tmpl_id?.[0]];
    let cm3 = parseDimsToCm3(t?.x_dimensions || "");
    if (!cm3) {
      const m3 = parseFloat(String(t?.volume ?? p.volume ?? 0));
      if (m3 > 0) cm3 = m3 * 1_000_000; // m³ → cm³
    }
    volByProduct[p.id] = cm3;
  }
  let total = 0;
  const missing: number[] = [];
  for (const l of lines) {
    const v = volByProduct[l.productId] || 0;
    if (!v) missing.push(l.productId);
    total += v * Math.max(1, l.quantity);
  }
  return { totalCm3: total, missing };
}

// Recommande un carton selon le volume total. marge = fraction utilisable (0.8 = -20%).
export interface CartonReco { carton: "petit" | "grand"; count: number; label: string; }
export function recommendCarton(
  totalCm3: number,
  petitCm3: number,
  grandCm3: number,
  marge = 0.8
): CartonReco {
  const petit = Math.max(1, petitCm3 * marge);
  const grand = Math.max(1, grandCm3 * marge);
  if (totalCm3 <= petit) return { carton: "petit", count: 1, label: "Petit carton" };
  if (totalCm3 <= grand) return { carton: "grand", count: 1, label: "Grand carton" };
  const count = Math.ceil(totalCm3 / grand);
  return { carton: "grand", count, label: `${count} grands cartons` };
}

// Apply inventory adjustment: set inventory_quantity then call action_apply_inventory
export async function applyInventoryAdjustment(
  session: OdooSession,
  quantId: number,
  newQty: number,
  reason?: string
): Promise<void> {
  // 1. Toujours écrire la quantité sur le quant
  await write(session, "stock.quant", [quantId], { inventory_quantity: newQty });

  if (reason?.trim()) {
    // 2a. Avec raison : laisser le wizard appliquer ET nommer (ne pas appeler action_apply_inventory)
    // Le wizard stock.inventory.adjustment.name.action_apply() fait les deux en une fois
    try {
      const wizardId = await create(session, "stock.inventory.adjustment.name", {
        inventory_adjustment_name: reason.trim(),
        quant_ids: [[6, 0, [quantId]]],
      }) as number;
      await callMethod(session, "stock.inventory.adjustment.name", "action_apply", [[wizardId]]);
      return;
    } catch {
      // Si le wizard échoue → fallback sans raison
    }
  }

  // 2b. Sans raison (ou fallback) : appel direct
  await callMethod(session, "stock.quant", "action_apply_inventory", [[quantId]]);
}

// Applique un DELTA (écart) sur un quant : nouvelle qty = qty propre du quant + delta.
// Indispensable en SCAN LIBRE où le théorique = somme de tous les emplacements mais
// la correction ne porte que sur UN quant : il faut ajuster du net, pas réécrire l'absolu.
export async function applyInventoryDelta(
  session: OdooSession,
  quantId: number,
  quantOwnQty: number,
  delta: number,
  reason?: string
): Promise<void> {
  const target = Math.max(0, quantOwnQty + delta); // jamais négatif sur ce quant
  await applyInventoryAdjustment(session, quantId, target, reason);
}

// Create a new quant (for products with 0 stock not yet in a location)
export async function createInventoryAdjustment(
  session: OdooSession,
  productId: number,
  locationId: number,
  newQty: number,
  lotId?: number,
  reason?: string
): Promise<void> {
  const vals: any = {
    product_id: productId,
    location_id: locationId,
    inventory_quantity: newQty,
  };
  if (lotId) vals.lot_id = lotId;
  const quantId = await create(session, "stock.quant", vals) as number;
  await callMethod(session, "stock.quant", "action_apply_inventory", [[quantId]]);
  if (reason?.trim()) {
    try {
      const moves = await searchRead(
        session, "stock.move",
        [["state", "=", "done"], ["product_id", "=", productId],
         ["|", ["location_id", "=", locationId], ["location_dest_id", "=", locationId]]],
        ["id"], 1, "date desc"
      );
      if (moves.length) await write(session, "stock.move", [moves[0].id], { reference: reason.trim() });
    } catch {}
  }
}

// Tous les emplacements avec stock négatif (pour corrections)
export async function getNegativeStockQuants(session: OdooSession): Promise<any[]> {
  const quants = await searchRead(
    session, "stock.quant",
    [["quantity", "<", 0], ["location_id.usage", "=", "internal"]],
    ["id", "product_id", "location_id", "lot_id", "quantity", "reserved_quantity"],
    500
  );
  // Grouper par emplacement
  const byLoc: Record<number, { locationId: number; locationName: string; quants: any[] }> = {};
  for (const q of quants) {
    const locId = q.location_id[0];
    const locName = q.location_id[1];
    if (!byLoc[locId]) byLoc[locId] = { locationId: locId, locationName: locName, quants: [] };
    byLoc[locId].quants.push(q);
  }
  return Object.values(byLoc).sort((a, b) => a.locationName.localeCompare(b.locationName));
}

// ============================================
// CONFIG PARAMETERS (shared settings via Odoo)
// ============================================

export async function getConfigParam(session: OdooSession, key: string): Promise<string | null> {
  const res = await searchRead(session, "ir.config_parameter", [["key", "=", key]], ["value"], 1);
  return res.length ? res[0].value : null;
}

export async function setConfigParam(session: OdooSession, key: string, value: string): Promise<void> {
  const res = await searchRead(session, "ir.config_parameter", [["key", "=", key]], ["id"], 1);
  if (res.length) {
    await write(session, "ir.config_parameter", [res[0].id], { value });
  } else {
    await create(session, "ir.config_parameter", { key, value });
  }
}


// ============================================
// COLIS / PUT IN PACK
// ============================================

export async function putInPack(session: OdooSession, pickingId: number, moveLineIds: number[]): Promise<any> {
  // Set result_package_id to create a new package for selected lines
  // First call action_put_in_pack on the picking with selected move line ids
  const result = await call(session, "/web/dataset/call_kw", {
    model: "stock.picking",
    method: "action_put_in_pack",
    args: [[pickingId]],
    kwargs: {
      context: { default_move_line_ids: moveLineIds },
    },
  });
  return result;
}

/**
 * Crée un vrai stock.quant.package dans Odoo et retourne son id + name.
 * C'est la méthode fiable pour créer un colis — action_put_in_pack retourne
 * un wizard interactif quand aucune ligne n'est sélectionnée.
 */
export async function createPackage(session: OdooSession): Promise<{ id: number; name: string }> {
  const pkgId = await call(session, "/web/dataset/call_kw", {
    model: "stock.quant.package",
    method: "create",
    args: [{}],
    kwargs: {},
  });
  // Read back name (Odoo auto-generates it)
  const pkgs = await searchRead(session, "stock.quant.package", [["id", "=", pkgId]], ["name"], 1);
  const name = pkgs[0]?.name || `PACK${pkgId}`;
  return { id: pkgId, name };
}

/**
 * Assigne une liste de move lines à un package en écrivant result_package_id.
 * Doit être appelé quand on ferme un colis pour persister dans Odoo.
 */
export async function assignLinesToPackage(session: OdooSession, moveLineIds: number[], packageId: number): Promise<void> {
  if (!moveLineIds.length) return;
  await call(session, "/web/dataset/call_kw", {
    model: "stock.move.line",
    method: "write",
    args: [moveLineIds, { result_package_id: packageId }],
    kwargs: {},
  });
}

export async function getPickingPackages(session: OdooSession, pickingId: number): Promise<any[]> {
  const lines = await searchRead(
    session,
    "stock.move.line",
    [["picking_id", "=", pickingId], ["result_package_id", "!=", false]],
    ["result_package_id", "product_id", "lot_id", "qty_done", "reserved_uom_qty"],
    200
  );
  // Group by package
  const packages: Record<number, any> = {};
  for (const line of lines) {
    const pkgId = line.result_package_id[0];
    const pkgName = line.result_package_id[1];
    if (!packages[pkgId]) packages[pkgId] = { id: pkgId, name: pkgName, lines: [] };
    packages[pkgId].lines.push(line);
  }
  return Object.values(packages);
}

export async function setPackageWeight(session: OdooSession, packageId: number, weight: number) {
  return write(session, "stock.quant.package", [packageId], { shipping_weight: weight });
}

// ============================================
// COLIS TNT — Ajout d'un colis sur un OUT validé + envoi transporteur
// ============================================

/**
 * Crée un nouveau colis (stock.quant.package) avec le poids donné,
 * l'associe à un picking validé via une move line (result_package_id),
 * appelle send_to_shipper pour générer une nouvelle étiquette TNT.
 *
 * Stratégie : `package_ids` sur stock.picking est un champ calculé —
 * on ne peut pas l'écrire directement. La seule façon de lier un package
 * à un picking est via stock.move.line.result_package_id. On crée donc
 * une ligne "fantôme" (qty_done=0) sur une move existante pour exposer
 * le nouveau colis au transporteur.
 */
export async function addPackageAndSendToShipper(
  session: OdooSession,
  pickingId: number,
  weightKg: number
): Promise<{ packageId: number; attachments: any[] }> {
  // 1. Snapshot des pièces jointes avant
  const attachmentsBefore = await searchRead(
    session, "ir.attachment",
    [["res_model", "=", "stock.picking"], ["res_id", "=", pickingId], ["mimetype", "ilike", "pdf"]],
    ["id"], 100
  );
  const existingIds = new Set(attachmentsBefore.map((a: any) => a.id));

  // 2. Créer le package avec le poids
  const packageId = await create(session, "stock.quant.package", {
    shipping_weight: weightKg,
  }) as number;

  // 3. Lier le package au picking :
  //    a) Écrire result_package_id sur les move lines done du picking
  //       → package_ids (computed) inclut ces packages → apparaît dans Odoo
  //    b) Créer aussi un stock.package.level pour les versions Odoo qui le lisent
  try {
    const doneLines = await searchRead(
      session, "stock.move.line",
      [["picking_id", "=", pickingId]],
      ["id"],
      500
    );
    if (doneLines.length > 0) {
      const ids = doneLines.map((l: any) => l.id);
      await write(session, "stock.move.line", ids, { result_package_id: packageId });
    }
  } catch { /* best-effort */ }

  try {
    await create(session, "stock.package.level", {
      package_id: packageId,
      picking_id: pickingId,
      is_done: true,
    });
  } catch { /* stock.package.level peut ne pas exister dans toutes les versions */ }

  // 4. Incrémenter number_of_packages sur le picking pour TNT
  try {
    const picking = await searchRead(session, "stock.picking",
      [["id", "=", pickingId]],
      ["shipping_weight", "number_of_packages"],
      1
    );
    if (picking.length > 0) {
      const currentWeight = picking[0].shipping_weight || 0;
      const currentPkgs = picking[0].number_of_packages || 1;
      await write(session, "stock.picking", [pickingId], {
        shipping_weight: currentWeight + weightKg,
        number_of_packages: currentPkgs + 1,
      });
    }
  } catch {}

  // 5. Appeler send_to_shipper
  await callMethod(session, "stock.picking", "send_to_shipper", [[pickingId]]);

  // 6. Attendre puis récupérer les nouvelles pièces jointes
  await new Promise(resolve => setTimeout(resolve, 2000));
  const attachmentsAfter = await searchRead(
    session, "ir.attachment",
    [["res_model", "=", "stock.picking"], ["res_id", "=", pickingId], ["mimetype", "ilike", "pdf"]],
    ["id", "name", "datas", "create_date"],
    100
  );
  const newAttachments = attachmentsAfter.filter((a: any) => !existingIds.has(a.id));

  return {
    packageId,
    attachments: newAttachments.length > 0 ? newAttachments : attachmentsAfter,
  };
}

// ============================================================
// IMPORT FOURNISSEUR WALA — Commande + Lots + Réception
// ============================================================

/** Recherche les produits Odoo par code article WALA (x_studio_code_produit_fournisseur) */
export async function matchWalaArticles(
  session: OdooSession,
  articleCodes: string[]
): Promise<Record<string, { templateId: number; productId: number; name: string; defaultCode: string; uomId: number; uomName: string }>> {
  if (!articleCodes.length) return {};
  const map: Record<string, any> = {};

  // ── Passe 1 (PRIORITAIRE) : Référence Fournisseur standard (product.supplierinfo.product_code) ──
  // C'est le champ que l'utilisateur tient à jour. La réf custom est figée → ne jamais la privilégier.
  {
    const sis = await searchRead(
      session, "product.supplierinfo",
      [["product_code", "in", articleCodes]],
      ["id", "product_code", "product_id", "product_tmpl_id"],
      0
    );
    // Récupère les détails template (et variant orphelins) en une fois.
    const tmplIds = new Set<number>();
    const orphanVariantIds = new Set<number>();
    for (const si of sis) {
      if (Array.isArray(si.product_tmpl_id)) tmplIds.add(si.product_tmpl_id[0]);
      else if (Array.isArray(si.product_id)) orphanVariantIds.add(si.product_id[0]);
    }
    const tmplById: Record<number, any> = {};
    if (tmplIds.size) {
      const tmpls = await searchRead(
        session, "product.template",
        [["id", "in", Array.from(tmplIds)]],
        ["id", "name", "default_code", "uom_id", "product_variant_ids"], 0
      );
      for (const t of tmpls) tmplById[t.id] = t;
    }
    // Pour les supplierinfo sans product_tmpl_id : on résout le template via le variant.
    const variantToTmpl: Record<number, any> = {};
    if (orphanVariantIds.size) {
      const prods = await searchRead(
        session, "product.product",
        [["id", "in", Array.from(orphanVariantIds)]],
        ["id", "name", "default_code", "uom_id", "product_tmpl_id"], 0
      );
      for (const p of prods) variantToTmpl[p.id] = p;
    }
    for (const si of sis) {
      const code = String(si.product_code || "").trim();
      if (!code || map[code]) continue;
      const tmplId = Array.isArray(si.product_tmpl_id) ? si.product_tmpl_id[0] : null;
      const variantId = Array.isArray(si.product_id) ? si.product_id[0] : null;
      let templateId = 0, productId = 0, name = "", defaultCode = "", uomId: any = null, uomName = "";
      if (tmplId && tmplById[tmplId]) {
        const t = tmplById[tmplId];
        templateId = t.id;
        productId = variantId || (Array.isArray(t.product_variant_ids) ? t.product_variant_ids[0] : 0);
        name = t.name; defaultCode = t.default_code || "";
        uomId = Array.isArray(t.uom_id) ? t.uom_id[0] : t.uom_id;
        uomName = Array.isArray(t.uom_id) ? t.uom_id[1] : "";
      } else if (variantId && variantToTmpl[variantId]) {
        const p = variantToTmpl[variantId];
        templateId = Array.isArray(p.product_tmpl_id) ? p.product_tmpl_id[0] : 0;
        productId = p.id; name = p.name; defaultCode = p.default_code || "";
        uomId = Array.isArray(p.uom_id) ? p.uom_id[0] : p.uom_id;
        uomName = Array.isArray(p.uom_id) ? p.uom_id[1] : "";
      }
      if (templateId && productId) {
        map[code] = { templateId, productId, name, defaultCode, uomId, uomName };
      }
    }
  }

  // ── Passe 2 (FALLBACK) : champ custom figé x_studio_code_produit_fournisseur ──
  // Uniquement pour les codes non résolus via la Référence Fournisseur ci-dessus.
  const remaining = articleCodes.filter(c => !(String(c).trim() in map));
  if (remaining.length) {
    try {
      const templates = await searchRead(
        session, "product.template",
        [["x_studio_code_produit_fournisseur", "in", remaining]],
        ["id", "name", "default_code", "x_studio_code_produit_fournisseur", "product_variant_ids", "uom_id"],
        0
      );
      for (const t of templates) {
        const code = String(t.x_studio_code_produit_fournisseur || "").trim();
        const productId = Array.isArray(t.product_variant_ids) ? t.product_variant_ids[0] : null;
        if (code && productId && !map[code]) {
          map[code] = {
            templateId: t.id,
            productId,
            name: t.name,
            defaultCode: t.default_code || "",
            uomId: Array.isArray(t.uom_id) ? t.uom_id[0] : t.uom_id,
            uomName: Array.isArray(t.uom_id) ? t.uom_id[1] : "",
          };
        }
      }
    } catch { /* champ custom absent sur cette base : on ignore */ }
  }

  return map;
}

/** Récupère l'ID Odoo du fournisseur WALA */
export async function getWalaPartnerId(session: OdooSession): Promise<number> {
  const partners = await searchRead(
    session, "res.partner",
    [["name", "=", "WALA Heilmittel GmbH"]],
    ["id", "name"], 1
  );
  if (!partners.length) throw new Error("Fournisseur 'WALA Heilmittel GmbH' introuvable dans Odoo");
  return partners[0].id;
}

export interface WalaPOLine {
  productId: number;
  qty: number;
  price: number;
  name: string;
  uomId: number;
}

export interface WalaPOOptions {
  partnerRef?: string; // Référence fournisseur (Invoice No.)
}

export interface WalaPOResult {
  poId: number;
  poName: string;
  pickingId: number;
  pickingName: string;
  locationId: number;
  locationDestId: number;
}

/** Crée et confirme un bon de commande fournisseur, retourne le BL créé automatiquement */
export async function createAndConfirmPO(
  session: OdooSession,
  partnerId: number,
  lines: WalaPOLine[],
  options: WalaPOOptions = {}
): Promise<WalaPOResult> {
  const today = new Date().toISOString().replace("T", " ").split(".")[0];

  // Grouper les lignes par produit (cumul des qté si même produit)
  const grouped: Record<number, WalaPOLine> = {};
  for (const l of lines) {
    if (grouped[l.productId]) {
      grouped[l.productId].qty += l.qty;
    } else {
      grouped[l.productId] = { ...l };
    }
  }
  const groupedLines = Object.values(grouped);

  const poValues: any = {
    partner_id: partnerId,
    order_line: groupedLines.map(l => [0, 0, {
      product_id: l.productId,
      product_qty: l.qty,
      price_unit: l.price || 0,
      name: l.name,
      date_planned: today,
      product_uom: l.uomId,
    }]),
  };
  if (options.partnerRef) poValues.partner_ref = options.partnerRef;

  const poId = await create(session, "purchase.order", poValues);

  const poRecords = await searchRead(session, "purchase.order", [["id", "=", poId]], ["id", "name"], 1);
  const poName = poRecords[0]?.name || `PO-${poId}`;

  // Confirmer le bon de commande
  await callMethod(session, "purchase.order", "button_confirm", [[poId]]);

  // Récupérer la réception générée
  const pickings = await searchRead(
    session, "stock.picking",
    [["purchase_id", "=", poId]],
    ["id", "name", "location_id", "location_dest_id"],
    5
  );
  if (!pickings.length) throw new Error("Aucune réception trouvée après confirmation du bon de commande");

  const picking = pickings[0];
  return {
    poId,
    poName,
    pickingId: picking.id,
    pickingName: picking.name,
    locationId: Array.isArray(picking.location_id) ? picking.location_id[0] : picking.location_id,
    locationDestId: Array.isArray(picking.location_dest_id) ? picking.location_dest_id[0] : picking.location_dest_id,
  };
}

/** Annule puis supprime un bon de commande (rollback en cas d'échec d'import) */
export async function cancelAndDeletePO(session: OdooSession, poId: number): Promise<void> {
  try {
    await callMethod(session, "purchase.order", "button_cancel", [[poId]]);
  } catch {} // ignore si déjà annulé
  try {
    await unlink(session, "purchase.order", [poId]);
  } catch {} // ignore si non supprimable
}

/** Vérifie si un lot existe, le crée sinon. Retourne {id, existed} */
export async function getOrCreateLot(
  session: OdooSession,
  productId: number,
  lotName: string,
  expiryDate: string
): Promise<{ id: number; existed: boolean }> {
  const existing = await searchRead(
    session, "stock.lot",
    [["name", "=", lotName], ["product_id", "=", productId]],
    ["id", "name"], 1
  );
  if (existing.length) return { id: existing[0].id, existed: true };

  const values: any = { name: lotName, product_id: productId, company_id: 1 };
  if (expiryDate) values.expiration_date = expiryDate + " 00:00:00";

  const id = await create(session, "stock.lot", values);
  return { id, existed: false };
}

export interface ReceptionLotLine {
  productId: number;
  lotId: number | null; // null = ligne sans numéro de lot
  lotName: string;
  qty: number;
  uomId: number;
}

/** Affecte lots et quantités aux lignes de mouvement de la réception.
 *  IMPORTANT : écrit qty_done sur CHAQUE ligne. Sans ça, à la validation Odoo
 *  remplit la demande totale du move (groupée par produit) sur la première
 *  ligne → les produits multi-lots finissent avec tout le stock sur un seul lot. */
export async function setReceptionLots(
  session: OdooSession,
  pickingId: number,
  locationId: number,
  locationDestId: number,
  lines: ReceptionLotLine[]
): Promise<void> {
  // Fusionner les lignes même produit + même lot (packing lists avec lignes dupliquées)
  const mergedMap: Record<string, ReceptionLotLine> = {};
  for (const l of lines) {
    const key = `${l.productId}|${l.lotId ?? "nolot"}`;
    if (mergedMap[key]) mergedMap[key].qty += l.qty;
    else mergedMap[key] = { ...l };
  }
  const mergedLines = Object.values(mergedMap);

  // Récupérer les mouvements et lignes de mouvement existants
  const moves = await searchRead(
    session, "stock.move",
    [["picking_id", "=", pickingId]],
    ["id", "product_id", "product_qty", "product_uom"],
    0
  );
  const moveLines = await searchRead(
    session, "stock.move.line",
    [["picking_id", "=", pickingId]],
    ["id", "product_id", "qty_done", "lot_id", "move_id", "product_uom_id"],
    0
  );

  // Pool de move lines disponibles par produit
  const mlPool: Record<number, any[]> = {};
  for (const ml of moveLines) {
    const pid = Array.isArray(ml.product_id) ? ml.product_id[0] : ml.product_id;
    if (!mlPool[pid]) mlPool[pid] = [];
    mlPool[pid].push(ml);
  }

  // Index des moves par produit — une ligne ne peut être rattachée qu'à un move
  // du MÊME produit. On ne réutilise jamais le move d'un autre produit.
  const moveByProduct: Record<number, any> = {};
  for (const m of moves) {
    const pid = Array.isArray(m.product_id) ? m.product_id[0] : m.product_id;
    if (pid != null && !(pid in moveByProduct)) moveByProduct[pid] = m;
  }

  // Lignes qu'on n'a pas pu rattacher à un mouvement de leur propre produit :
  // on REFUSE de les affecter ailleurs (sinon lot/qté d'un produit atterrit sur un autre).
  const orphans: ReceptionLotLine[] = [];

  for (const line of mergedLines) {
    const pool = mlPool[line.productId];
    const ml = pool?.shift();

    if (ml) {
      // Sécurité : la move.line doit bien appartenir au produit attendu.
      const mlPid = Array.isArray(ml.product_id) ? ml.product_id[0] : ml.product_id;
      if (mlPid !== line.productId) { orphans.push(line); continue; }
      // lot_id (many2one) + lot_name (char) pour forcer l'affectation dans Odoo,
      // et qty_done = quantité de CE lot (pas la demande totale du move)
      const vals: any = { qty_done: line.qty };
      if (line.lotId) {
        vals.lot_id = line.lotId;
        vals.lot_name = line.lotName;
      }
      await write(session, "stock.move.line", [ml.id], vals);
    } else {
      // Pas de move.line dispo : on crée une nouvelle ligne SUR LE MOVE DU MÊME PRODUIT.
      const move = moveByProduct[line.productId];
      if (!move) {
        // Aucun mouvement pour ce produit dans la réception → on NE fusionne PAS
        // sur un autre produit. On collecte l'orphelin pour signaler une erreur claire.
        orphans.push(line);
        continue;
      }
      const vals: any = {
        picking_id: pickingId,
        move_id: move.id,
        product_id: line.productId,
        product_uom_id: line.uomId,
        qty_done: line.qty,
        location_id: locationId,
        location_dest_id: locationDestId,
      };
      if (line.lotId) {
        vals.lot_id = line.lotId;
        vals.lot_name = line.lotName;
      }
      await create(session, "stock.move.line", vals);
    }
  }

  if (orphans.length) {
    // Cause typique : deux codes fournisseur différents matchés vers le MÊME produit
    // Odoo, donc le bon de commande n'a pas de ligne distincte pour chacun.
    const detail = orphans.map(o => `produit #${o.productId}${o.lotName ? ` (lot ${o.lotName}, ${o.qty})` : ` (${o.qty})`}`).join(", ");
    throw new Error(
      `Réception incomplète : ${orphans.length} ligne(s) sans mouvement dédié dans le bon de commande — ` +
      `quantités NON affectées (risque de fusion sur un autre produit). ` +
      `Vérifiez le matching fournisseur (un même produit Odoo reçoit plusieurs codes WALA). Détail : ${detail}`
    );
  }
}

// validatePicking est déjà défini plus haut dans ce fichier (ligne ~710) — on réutilise l'existant.

// ============================================
// DLV — lots avec dates d'expiration en stock
// ============================================

/** Retourne tous les lots en stock (emplacements internes) qui ont une date d'expiration.
 *  Agrège les quantités par produit+lot (plusieurs emplacements → 1 ligne). */
export async function getDlvStockLots(session: OdooSession): Promise<{
  productId: number;
  ref: string;
  name: string;
  lotId: number;
  lotName: string;
  qty: number;
  qtyDispo: number;
  dlvDate: string; // "YYYY-MM-DD HH:MM:SS" ou "YYYY-MM-DD"
}[]> {
  // 1. Quants internes avec lot, quantité positive
  const quants: any[] = await searchRead(
    session, "stock.quant",
    [["location_id.usage", "=", "internal"], ["lot_id", "!=", false], ["quantity", ">", 0]],
    ["product_id", "lot_id", "quantity", "reserved_quantity"],
    5000
  );
  if (!quants?.length) return [];

  // 2. Lots → dates d'expiration
  const lotIds = Array.from(new Set(quants.map((q: any) => q.lot_id[0]))) as number[];
  const lots: any[] = await searchRead(
    session, "stock.lot",
    [["id", "in", lotIds]],
    ["id", "name", "expiration_date", "use_date", "removal_date"],
    lotIds.length
  );
  const lotMap: Record<number, any> = {};
  for (const l of lots) lotMap[l.id] = l;

  // 3. Garder uniquement les lots avec une date
  const withDlv = quants.filter((q: any) => {
    const lot = lotMap[q.lot_id[0]];
    return lot && (lot.expiration_date || lot.use_date || lot.removal_date);
  });
  if (!withDlv.length) return [];

  // 4. Produits → ref + nom
  const productIds = Array.from(new Set(withDlv.map((q: any) => q.product_id[0]))) as number[];
  const products: any[] = await searchRead(
    session, "product.product",
    [["id", "in", productIds]],
    ["id", "default_code", "name"],
    productIds.length
  );
  const productMap: Record<number, any> = {};
  for (const p of products) productMap[p.id] = p;

  // 5. Agréger qty par produit+lot
  const byKey: Record<string, { productId: number; ref: string; name: string; lotId: number; lotName: string; qty: number; qtyDispo: number; dlvDate: string }> = {};
  for (const q of withDlv) {
    const pid = q.product_id[0];
    const lid = q.lot_id[0];
    const key = `${pid}_${lid}`;
    const lot = lotMap[lid];
    const dlvDate: string = lot.expiration_date || lot.use_date || lot.removal_date;
    if (!byKey[key]) {
      const prod = productMap[pid];
      byKey[key] = { productId: pid, ref: prod?.default_code || "", name: prod?.name || "", lotId: lid, lotName: lot.name || "", qty: 0, qtyDispo: 0, dlvDate };
    }
    byKey[key].qty += q.quantity;
    byKey[key].qtyDispo += Math.max(0, q.quantity - (q.reserved_quantity || 0));
  }
  return Object.values(byKey).filter(v => v.qty > 0);
}

// ============================================
// ANALYSE FEFO — détecte les sorties d'un lot récent alors qu'un lot plus ancien
// (DLUO plus proche) était encore en stock à cette date. Lecture seule.
// ============================================

export interface FefoAnomaly {
  productId: number;
  productRef: string;
  productName: string;
  date: string;            // date de la sortie (YYYY-MM-DD)
  pickingRef: string;      // référence du bon (origin/picking)
  soldLot: string;         // lot sorti
  soldDluo: string;        // DLUO du lot sorti
  soldQty: number;
  olderLot: string;        // lot plus ancien qui était dispo
  olderDluo: string;       // DLUO (plus proche) du lot plus ancien
  olderStockAtDate: number;// stock de ce lot plus ancien au moment de la sortie
  olderStockNow: number;   // stock RESTANT aujourd'hui de ce lot plus ancien
}

/**
 * Analyse les sorties CLIENT sur une période et repère les écarts FEFO.
 * @param productId  optionnel — limiter à un produit.
 */
export async function analyzeFefo(
  session: OdooSession,
  dateStart: string,   // "YYYY-MM-DD"
  dateEnd: string,     // "YYYY-MM-DD"
  productId?: number
): Promise<{ anomalies: FefoAnomaly[]; nbSorties: number; nbProduits: number }> {
  const startDT = `${dateStart} 00:00:00`;
  const endDT = `${dateEnd} 23:59:59`;

  // 1) Sorties CLIENT (move lines done, avec lot) de la période.
  const outDomain: any[] = [
    ["state", "=", "done"],
    ["location_dest_id.usage", "=", "customer"],
    ["date", ">=", startDT],
    ["date", "<=", endDT],
    ["lot_id", "!=", false],
  ];
  if (productId) outDomain.push(["product_id", "=", productId]);
  const outLines: any[] = await searchRead(
    session, "stock.move.line", outDomain,
    ["product_id", "lot_id", "qty_done", "date", "reference", "origin"], 20000, "date asc"
  );
  if (!outLines.length) return { anomalies: [], nbSorties: 0, nbProduits: 0 };

  const productIds = Array.from(new Set(outLines.map((l: any) => l.product_id[0]))) as number[];

  // 2) Produits → ref/nom.
  const products = await searchRead(session, "product.product", [["id", "in", productIds]], ["id", "default_code", "name"], productIds.length);
  const prodMap: Record<number, { ref: string; name: string }> = {};
  for (const p of products) prodMap[p.id] = { ref: p.default_code || "", name: p.name || "" };

  // 3) Lots de ces produits → DLUO.
  const allLots = await searchRead(session, "stock.lot", [["product_id", "in", productIds]], ["id", "name", "product_id", "expiration_date", "use_date", "removal_date"], 50000);
  const lotMap: Record<number, { name: string; dluo: string; productId: number }> = {};
  for (const l of allLots) {
    const dluo = l.expiration_date || l.use_date || l.removal_date || "";
    lotMap[l.id] = { name: l.name, dluo: dluo ? String(dluo).slice(0, 10) : "", productId: Array.isArray(l.product_id) ? l.product_id[0] : l.product_id };
  }

  // 3bis) Stock ACTUEL par lot (emplacements internes) → pour ne signaler que les
  //       anomalies où il reste encore du stock du lot plus ancien AUJOURD'HUI.
  const curQuants = await searchRead(
    session, "stock.quant",
    [["product_id", "in", productIds], ["location_id.usage", "=", "internal"], ["lot_id", "!=", false], ["quantity", ">", 0]],
    ["lot_id", "quantity"], 50000
  );
  const currentStockByLot: Record<number, number> = {};
  for (const q of curQuants) {
    const lid = Array.isArray(q.lot_id) ? q.lot_id[0] : q.lot_id;
    if (lid) currentStockByLot[lid] = (currentStockByLot[lid] || 0) + (q.quantity || 0);
  }

  // 4) TOUS les mouvements internes (done) de ces produits, par lot, pour reconstruire
  //    le stock par lot dans le temps. On regarde l'impact sur le stock INTERNE :
  //    +qty quand ça ENTRE en interne, -qty quand ça SORT de l'interne.
  const moveLines: any[] = await searchRead(
    session, "stock.move.line",
    [["state", "=", "done"], ["product_id", "in", productIds], ["lot_id", "!=", false], ["date", "<=", endDT]],
    ["product_id", "lot_id", "qty_done", "date", "location_id", "location_usage", "location_dest_id", "location_dest_usage"],
    50000, "date asc"
  );
  // location_usage / location_dest_usage ne sont pas toujours dispo → on récupère l'usage des emplacements.
  const locIds = new Set<number>();
  for (const m of moveLines) {
    if (Array.isArray(m.location_id)) locIds.add(m.location_id[0]);
    if (Array.isArray(m.location_dest_id)) locIds.add(m.location_dest_id[0]);
  }
  const locs = await searchRead(session, "stock.location", [["id", "in", Array.from(locIds)]], ["id", "usage"], locIds.size || 1);
  const locUsage: Record<number, string> = {};
  for (const l of locs) locUsage[l.id] = l.usage;

  // Timeline d'événements par lot : { lotId, date, delta } (delta sur le stock interne).
  interface Evt { lotId: number; date: string; delta: number; }
  const events: Evt[] = [];
  for (const m of moveLines) {
    const lotId = Array.isArray(m.lot_id) ? m.lot_id[0] : m.lot_id;
    const qty = m.qty_done || 0;
    if (!lotId || !qty) continue;
    const srcUsage = Array.isArray(m.location_id) ? locUsage[m.location_id[0]] : "";
    const dstUsage = Array.isArray(m.location_dest_id) ? locUsage[m.location_dest_id[0]] : "";
    const inInternal = dstUsage === "internal";
    const outInternal = srcUsage === "internal";
    let delta = 0;
    if (inInternal && !outInternal) delta = qty;        // entrée nette en interne
    else if (outInternal && !inInternal) delta = -qty;  // sortie nette de l'interne
    else delta = 0;                                      // transfert interne→interne : ignoré
    if (delta !== 0) events.push({ lotId, date: m.date, delta });
  }
  events.sort((a, b) => a.date.localeCompare(b.date));

  // 5) Pour chaque sortie analysée, on rejoue les événements JUSQU'À sa date pour
  //    connaître le stock de chaque lot, puis on cherche un lot DLUO plus ancien dispo.
  // Index des événements par produit, triés.
  const evtByProduct: Record<number, Evt[]> = {};
  for (const e of events) {
    const pid = lotMap[e.lotId]?.productId;
    if (pid == null) continue;
    (evtByProduct[pid] ||= []).push(e);
  }

  const anomalies: FefoAnomaly[] = [];
  for (const line of outLines) {
    const pid = line.product_id[0];
    const soldLotId = Array.isArray(line.lot_id) ? line.lot_id[0] : line.lot_id;
    const soldLot = lotMap[soldLotId];
    if (!soldLot || !soldLot.dluo) continue; // sans DLUO on ne peut pas juger
    const lineDate = line.date;
    // Stock par lot juste AVANT cette sortie (on rejoue les events < lineDate, et ceux à la même
    // date mais on s'arrête avant les sorties — approximation : events strictement antérieurs).
    const stockByLot: Record<number, number> = {};
    for (const e of (evtByProduct[pid] || [])) {
      if (e.date < lineDate) stockByLot[e.lotId] = (stockByLot[e.lotId] || 0) + e.delta;
      else break;
    }
    // Cherche un lot du même produit, DLUO plus PROCHE (plus ancien à consommer), avec stock > 0.
    let worst: { lotId: number; dluo: string; stock: number } | null = null;
    for (const [lotIdStr, st] of Object.entries(stockByLot)) {
      const lid = Number(lotIdStr);
      if (lid === soldLotId) continue;
      const lot = lotMap[lid];
      if (!lot || !lot.dluo) continue;
      if (st <= 0) continue;
      // CONDITION : il doit RESTER du stock de ce lot plus ancien AUJOURD'HUI
      // (sinon ce n'était pas une vraie erreur ou elle a été rattrapée depuis).
      if ((currentStockByLot[lid] || 0) <= 0) continue;
      if (lot.dluo < soldLot.dluo) { // DLUO plus tôt = à sortir en priorité
        if (!worst || lot.dluo < worst.dluo) worst = { lotId: lid, dluo: lot.dluo, stock: st };
      }
    }
    if (worst) {
      const p = prodMap[pid] || { ref: "", name: "" };
      anomalies.push({
        productId: pid, productRef: p.ref, productName: p.name,
        date: String(lineDate).slice(0, 10),
        pickingRef: line.reference || line.origin || "",
        soldLot: soldLot.name, soldDluo: soldLot.dluo, soldQty: line.qty_done || 0,
        olderLot: lotMap[worst.lotId].name, olderDluo: worst.dluo, olderStockAtDate: Math.round(worst.stock),
        olderStockNow: Math.round(currentStockByLot[worst.lotId] || 0),
      });
    }
  }
  anomalies.sort((a, b) => a.date.localeCompare(b.date));
  return { anomalies, nbSorties: outLines.length, nbProduits: productIds.length };
}

// ============================================
// CONSO MENSUELLE DEPUIS ODOO (pour DLV + Suivi Stock)
// ============================================

/**
 * Tire les sorties réelles (stock.move done, vers client) des N derniers mois.
 * Retourne { odoo_ref, product_name, month, qty, nbMonths } par produit.
 * nbMonths = nombre de mois distincts où il y a eu au moins 1 sortie.
 */
export async function getMonthlyConsumptionFromOdoo(
  session: OdooSession,
  nbMonths = 12
): Promise<{ odoo_ref: string; product_name: string; month: string; qty: number }[]> {
  // Calcul des bornes de dates
  const now = new Date();
  const dateFrom = new Date(now.getFullYear(), now.getMonth() - nbMonths, 1);
  const dateFromStr = dateFrom.toISOString().slice(0, 10) + " 00:00:00";

  // 1. Mouvements de stock done, vers emplacement client
  const moves: any[] = await searchRead(
    session, "stock.move",
    [
      ["state", "=", "done"],
      ["location_dest_id.usage", "=", "customer"],
      ["date", ">=", dateFromStr],
    ],
    ["product_id", "product_qty", "date"],
    50000
  );
  if (!moves.length) return [];

  // 2. Produits → ref + nom
  const productIds = Array.from(new Set(moves.map((m: any) => m.product_id[0]))) as number[];
  const products: any[] = await searchRead(
    session, "product.product",
    [["id", "in", productIds]],
    ["id", "default_code", "name"],
    productIds.length
  );
  const prodMap: Record<number, { ref: string; name: string }> = {};
  for (const p of products) prodMap[p.id] = { ref: p.default_code || "", name: p.name || "" };

  // 3. Agréger par ref + mois
  const byKey: Record<string, { odoo_ref: string; product_name: string; month: string; qty: number }> = {};
  for (const m of moves) {
    const prod = prodMap[m.product_id[0]];
    if (!prod?.ref) continue;
    const month = String(m.date || "").slice(0, 7); // "YYYY-MM"
    if (!month || month.length < 7) continue;
    const key = `${prod.ref}_${month}`;
    if (!byKey[key]) byKey[key] = { odoo_ref: prod.ref, product_name: prod.name, month, qty: 0 };
    byKey[key].qty += m.product_qty || 0;
  }

  return Object.values(byKey).filter(v => v.qty > 0);
}

// ============================================
// DLV PRODUCT STOCK DETAIL
// ============================================

export async function getProductStockDetail(session: OdooSession, productId: number): Promise<{
  locationId: number;
  locationName: string;
  locationFullName: string;
  lotId: number | null;
  lotName: string;
  dlvDate: string | null;
  qty: number;
  reservedQty: number;
}[]> {
  // Quants internes pour ce produit
  const quants: any[] = await searchRead(
    session, "stock.quant",
    [["product_id", "=", productId], ["location_id.usage", "=", "internal"], ["quantity", ">", 0]],
    ["location_id", "lot_id", "quantity", "reserved_quantity"],
    500
  );
  if (!quants.length) return [];

  // Lots → dates d'expiration
  const lotIds = Array.from(new Set(quants.filter((q: any) => q.lot_id).map((q: any) => q.lot_id[0]))) as number[];
  const lotMap: Record<number, { name: string; dlvDate: string | null }> = {};
  if (lotIds.length) {
    const lots: any[] = await searchRead(
      session, "stock.lot",
      [["id", "in", lotIds]],
      ["id", "name", "expiration_date", "use_date"],
      lotIds.length
    );
    for (const l of lots) {
      lotMap[l.id] = { name: l.name, dlvDate: l.expiration_date || l.use_date || null };
    }
  }

  // Locations → nom complet
  const locIds = Array.from(new Set(quants.map((q: any) => q.location_id[0]))) as number[];
  const locMap: Record<number, string> = {};
  if (locIds.length) {
    const locs: any[] = await searchRead(
      session, "stock.location",
      [["id", "in", locIds]],
      ["id", "complete_name"],
      locIds.length
    );
    for (const l of locs) locMap[l.id] = l.complete_name;
  }

  return quants.map((q: any) => {
    const lotInfo = q.lot_id ? (lotMap[q.lot_id[0]] || null) : null;
    return {
      locationId: q.location_id[0],
      locationName: Array.isArray(q.location_id) ? q.location_id[1] : "",
      locationFullName: locMap[q.location_id[0]] || (Array.isArray(q.location_id) ? q.location_id[1] : ""),
      lotId: q.lot_id ? q.lot_id[0] : null,
      lotName: lotInfo?.name || (q.lot_id ? q.lot_id[1] || "" : ""),
      dlvDate: lotInfo?.dlvDate || null,
      qty: q.quantity,
      reservedQty: q.reserved_quantity || 0,
    };
  }).sort((a, b) => a.locationFullName.localeCompare(b.locationFullName));
}

// ============================================
// ARTICLE CREATOR — codification + création Odoo
// ============================================

/** Tous les default_code qui commencent par le préfixe donné (pour anti-doublon + prochain seq) */
export async function getProductsByCodePrefix(session: OdooSession, prefix: string): Promise<string[]> {
  const products = await searchRead(
    session, "product.template",
    [["default_code", "=like", `${prefix}%`]],
    ["default_code"],
    200
  );
  return (products || []).map((p: any) => p.default_code as string).filter(Boolean);
}

/** Unités de mesure disponibles dans Odoo */
export async function getUoMs(session: OdooSession): Promise<{ id: number; name: string }[]> {
  const uoms = await searchRead(session, "uom.uom", [["active", "=", true]], ["id", "name"], 100);
  return (uoms || []).map((u: any) => ({ id: u.id, name: u.name }));
}

/** Crée un product.template dans Odoo et retourne l'ID créé */
export async function createProductTemplate(session: OdooSession, data: {
  name: string;
  default_code: string;
  barcode?: string;
  uom_id: number;
  tracking: "none" | "lot" | "serial";
  weight?: number;
  sale_ok?: boolean;
  purchase_ok?: boolean;
}): Promise<number> {
  const vals: any = {
    name: data.name,
    default_code: data.default_code,
    type: "product",          // storable
    uom_id: data.uom_id,
    uom_po_id: data.uom_id,
    tracking: data.tracking,
    sale_ok: data.sale_ok ?? true,
    purchase_ok: data.purchase_ok ?? true,
  };
  if (data.barcode) vals.barcode = data.barcode;
  if (data.weight) vals.weight = data.weight;
  return create(session, "product.template", vals);
}

/** Recherche des produits par liste de références (default_code) ou mots-clés.
 *  Retourne id, default_code, name, temp_min_quantity.
 */
export async function searchProductsForThreshold(
  session: OdooSession,
  refs: string[]
): Promise<{ id: number; default_code: string; name: string; temp_min_quantity: number }[]> {
  if (!refs.length) return [];
  // Chercher par code exact d'abord, puis fallback nom contient
  const byCode = await searchRead(
    session, "product.template",
    [["default_code", "in", refs]],
    ["id", "default_code", "name", "temp_min_quantity"],
    500
  );
  const foundCodes = new Set((byCode || []).map((p: any) => p.default_code));
  const notFound = refs.filter(r => !foundCodes.has(r));
  let byName: any[] = [];
  if (notFound.length > 0) {
    // Cherche par nom partiel pour les refs non trouvées par code
    const domain: any[] = ["|", ...notFound.flatMap(r => [["name", "ilike", r], ["default_code", "ilike", r]])];
    byName = await searchRead(session, "product.template", domain, ["id", "default_code", "name", "temp_min_quantity"], 200);
  }
  const all = [...(byCode || []), ...(byName || [])];
  // Déduplication par id
  const seen = new Set<number>();
  return all.filter((p: any) => { if (seen.has(p.id)) return false; seen.add(p.id); return true; })
    .map((p: any) => ({
      id: p.id,
      default_code: p.default_code || "",
      name: p.name || "",
      temp_min_quantity: typeof p.temp_min_quantity === "number" ? p.temp_min_quantity : 0,
    }));
}

/** Recherche live par query partielle (nom ou ref) — pour autocomplete */
export async function searchProductsByQuery(
  session: OdooSession,
  query: string,
  limit = 20
): Promise<{ id: number; default_code: string; name: string; temp_min_quantity: number }[]> {
  if (!query.trim()) return [];
  const domain: any[] = ["|", ["default_code", "ilike", query], ["name", "ilike", query]];
  const res = await searchRead(session, "product.template", domain, ["id", "default_code", "name", "temp_min_quantity"], limit);
  return (res || []).map((p: any) => ({
    id: p.id,
    default_code: p.default_code || "",
    name: p.name || "",
    temp_min_quantity: typeof p.temp_min_quantity === "number" ? p.temp_min_quantity : 0,
  }));
}

/** Met à jour temp_min_quantity sur plusieurs product.template en une fois */
// ============================================
// SORTIES ORPHELINES — stock en WH/Sortie sans livraison active
// ============================================

/** Retourne tout le stock dans les emplacements output (WH/Sortie)
 *  en croisant avec les pickings actifs pour identifier ceux sans livraison en cours. */
export async function getOrphanMoves(session: OdooSession): Promise<{
  id: number;
  quantId: number;
  productId: number;
  ref: string;
  name: string;
  lotName: string;
  qty: number;
  reservedQty: number;
  uncoveredQty: number;
  state: string;
  date: string;
  locationName: string;
  locationDestName: string;
  pickingState: string;
  reason: string;
}[]> {
  // 0. Trouver explicitement les emplacements "output" / "Sortie"
  //    → usage="output" OU nom contient "sortie" (certains Odoo ont usage="internal" sur WH/Sortie)
  const outputLocs: any[] = await searchRead(
    session, "stock.location",
    ["|", ["usage", "=", "output"], ["complete_name", "ilike", "sortie"]],
    ["id", "complete_name", "usage"],
    100
  );
  if (!outputLocs.length) return [];
  const outputLocIds = outputLocs.map((l: any) => l.id as number);

  // 1. Tous les quants dans ces emplacements avec qty > 0
  const quants: any[] = await searchRead(
    session, "stock.quant",
    [["location_id", "in", outputLocIds], ["quantity", ">", 0]],
    ["id", "product_id", "location_id", "lot_id", "quantity", "reserved_quantity"],
    2000
  );
  if (!quants.length) return [];

  // 2. Pickings actifs (assigned/waiting/confirmed) depuis ces emplacements
  const quantLocIds = Array.from(new Set(quants.map((q: any) => q.location_id[0]))) as number[];
  const activePicking: any[] = await searchRead(
    session, "stock.picking",
    [["state", "in", ["assigned", "waiting", "confirmed"]], ["location_id", "in", quantLocIds]],
    ["id", "name", "state", "location_id", "scheduled_date"],
    500
  );
  const activePickingIds = new Set(activePicking.map((p: any) => p.id));

  // 3. Move.lines actifs depuis ces pickings → produit+lot couverts
  type CoveredKey = string;
  const coveredQty: Record<CoveredKey, number> = {};
  if (activePicking.length) {
    const moveLines: any[] = await searchRead(
      session, "stock.move.line",
      [["picking_id", "in", Array.from(activePickingIds)], ["state", "not in", ["done", "cancel"]]],
      ["product_id", "lot_id", "location_id", "reserved_uom_qty"],
      5000
    );
    for (const l of moveLines) {
      const k = `${l.product_id[0]}_${l.location_id[0]}_${l.lot_id ? l.lot_id[0] : 0}`;
      coveredQty[k] = (coveredQty[k] || 0) + (l.reserved_uom_qty || 0);
    }
  }

  // 4. Enrichir produits
  const productIds = Array.from(new Set(quants.map((q: any) => q.product_id[0]))) as number[];
  const products: any[] = await searchRead(
    session, "product.product",
    [["id", "in", productIds]],
    ["id", "default_code", "name"],
    productIds.length
  );
  const prodMap: Record<number, any> = {};
  for (const p of products) prodMap[p.id] = p;

  // 5. Enrichir lots
  const lotIds = Array.from(new Set(quants.filter((q: any) => q.lot_id).map((q: any) => q.lot_id[0]))) as number[];
  const lotMap: Record<number, string> = {};
  if (lotIds.length) {
    const lots: any[] = await searchRead(session, "stock.lot", [["id", "in", lotIds]], ["id", "name"], lotIds.length);
    for (const l of lots) lotMap[l.id] = l.name;
  }

  // 6. Calculer qté non couverte par un picking actif
  const result: {
    id: number; productId: number; ref: string; name: string; lotName: string;
    qty: number; reservedQty: number; uncoveredQty: number; state: string; date: string;
    locationName: string; locationDestName: string; pickingState: string; reason: string; quantId: number;
  }[] = [];

  for (const q of quants) {
    const k = `${q.product_id[0]}_${q.location_id[0]}_${q.lot_id ? q.lot_id[0] : 0}`;
    const covered = coveredQty[k] || 0;
    const uncovered = Math.max(0, q.quantity - covered);
    if (uncovered <= 0) continue; // entièrement couvert par un picking actif
    const prod = prodMap[q.product_id[0]];
    result.push({
      id: q.id,
      quantId: q.id,
      productId: q.product_id[0],
      ref: prod?.default_code || "",
      name: prod?.name || q.product_id[1] || "",
      lotName: q.lot_id ? (lotMap[q.lot_id[0]] || q.lot_id[1] || "") : "",
      qty: q.quantity,
      reservedQty: q.reserved_quantity || 0,
      uncoveredQty: uncovered,
      state: "stranded",
      date: "",
      locationName: Array.isArray(q.location_id) ? q.location_id[1] : "",
      locationDestName: "",
      pickingState: "",
      reason: covered > 0 ? `${Math.round(covered)} couverts / ${Math.round(uncovered)} sans livraison` : "Aucune livraison active",
    });
  }

  result.sort((a, b) => b.uncoveredQty - a.uncoveredQty);
  return result;
}

/** Annule une liste de stock.move orphelins (passe à state=cancel + libère réservation) */
export async function cancelOrphanMoves(session: OdooSession, moveIds: number[]): Promise<void> {
  if (!moveIds.length) return;
  await write(session, "stock.move", moveIds, { state: "draft" });
  await write(session, "stock.move", moveIds, { state: "cancel" });
}

/**
 * Applique une correction inventaire sur des quants orphelins.
 * Pour chaque item : écrit inventory_quantity = currentQty - correctionQty
 * puis appelle action_apply_inventory.
 * correctionQty = nb d'unités à retirer de WH/Sortie (0 = pas de correction).
 */
export async function applyOrphanCorrections(
  session: OdooSession,
  corrections: { quantId: number; currentQty: number; correctionQty: number }[]
): Promise<void> {
  const toApply = corrections.filter(c => c.correctionQty > 0);
  if (!toApply.length) return;
  // Appliquer une par une pour éviter les conflits de lots
  for (const c of toApply) {
    const newQty = Math.max(0, c.currentQty - c.correctionQty);
    await write(session, "stock.quant", [c.quantId], { inventory_quantity: newQty });
    await callMethod(session, "stock.quant", "action_apply_inventory", [[c.quantId]]);
  }
}

export async function bulkUpdateMinQuantity(
  session: OdooSession,
  updates: { id: number; value: number }[]
): Promise<void> {
  await Promise.all(
    updates.map(u => write(session, "product.template", [u.id], { temp_min_quantity: u.value }))
  );
}

// ============================================
// ANALYSE TRANSPORTEURS — croisement facture transporteur × commandes Odoo
// ============================================

export interface CarrierSaleOrder {
  ref: string;          // name de la commande (S####)
  client: string;       // nom du partenaire
  partnerRef?: string;  // ref du partenaire (code client Odoo, champ ref de res.partner)
  montantHT: number;    // amount_untaxed (CUMULÉ avec les commandes jointes)
  montantTTC: number;   // amount_total  (CUMULÉ avec les commandes jointes)
  dateOrder: string;    // date_order (YYYY-MM-DD)
  state: string;
  cp?: string;          // code postal du client (livraison)
  ville?: string;       // ville du client
  dept?: string;        // n° de département (2 premiers chiffres du CP, FR)
  groupe?: string[];    // réfs des commandes du groupe incluses dans le montant (self compris si groupé)
  groupeDetail?: { ref: string; montantHT: number; montantTTC: number }[]; // détail par commande du groupe
}

/**
 * Découvre le nom technique du champ "Commandes jointes" sur sale.order
 * (libellé saisi par l'utilisateur, nom technique inconnu et variable).
 * Renvoie { name, type } ou null si introuvable.
 */
async function discoverJoinedField(session: OdooSession): Promise<{ name: string; type: string } | null> {
  try {
    const fg = await callMethod(session, "sale.order", "fields_get", [], { attributes: ["string", "type", "relation"] });
    const norm = (s: string) => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
    for (const [name, def] of Object.entries<any>(fg)) {
      const label = norm(def?.string);
      if (label === "commandes jointes" || (label.includes("command") && label.includes("joint"))) {
        return { name, type: def?.type || "" };
      }
    }
  } catch { /* champ non dispo → on ignore le groupage */ }
  return null;
}

/**
 * Recherche dans Odoo les commandes client (sale.order) correspondant aux
 * références extraites d'une facture transporteur.
 *
 * Logique "Filtre + match réf" : on borne la recherche sur date_order entre
 * dateStart et dateEnd (inclus) ET on matche les noms de commandes présents
 * dans la facture. Le bornage par date réduit fortement le volume scanné et
 * sécurise le matching (deux commandes ne peuvent pas partager le même nom).
 *
 * @param refs        liste de références S#### extraites de la facture
 * @param dateStart   borne basse "YYYY-MM-DD" (optionnelle)
 * @param dateEnd     borne haute "YYYY-MM-DD" (optionnelle, incluse)
 */
export async function fetchCarrierSaleOrders(
  session: OdooSession,
  refs: string[],
  dateStart?: string,
  dateEnd?: string
): Promise<CarrierSaleOrder[]> {
  const uniqueRefs = Array.from(new Set(refs.map(r => r.trim()).filter(Boolean)));
  if (!uniqueRefs.length) return [];

  // Champ "Commandes jointes" (nom technique découvert dynamiquement).
  const joined = await discoverJoinedField(session);
  const joinedName = joined?.name;
  const joinedRelational = joined ? ["many2many", "one2many", "many2one"].includes(joined.type) : false;

  const fields = ["name", "partner_id", "partner_shipping_id", "amount_untaxed", "amount_total", "date_order", "state"];
  if (joinedName) fields.push(joinedName);

  // Stocke la valeur brute du champ joint par réf (ids ou texte) pour résolution ultérieure.
  const rawJoined = new Map<string, any>();
  // Partenaire de livraison par réf → enrichissement CP/ville ensuite.
  const refToShip = new Map<string, number>();
  // Partenaire client (partner_id) par réf → enrichissement code client (ref) ensuite.
  const refToPartner = new Map<string, number>();

  const toRow = (r: any): CarrierSaleOrder => {
    if (joinedName) rawJoined.set(r.name, r[joinedName]);
    const shipId = Array.isArray(r.partner_shipping_id) ? r.partner_shipping_id[0]
      : Array.isArray(r.partner_id) ? r.partner_id[0] : null;
    if (shipId) refToShip.set(r.name, shipId);
    const partnerId = Array.isArray(r.partner_id) ? r.partner_id[0] : null;
    if (partnerId) refToPartner.set(r.name, partnerId);
    return {
      ref: r.name,
      client: Array.isArray(r.partner_id) ? r.partner_id[1] : "",
      montantHT: r.amount_untaxed || 0,
      montantTTC: r.amount_total || 0,
      dateOrder: r.date_order ? String(r.date_order).split(" ")[0] : "",
      state: r.state || "",
    };
  };

  // Recherche par lots (évite des domaines trop volumineux côté Odoo).
  async function searchByNames(names: string[], useDate: boolean): Promise<CarrierSaleOrder[]> {
    const res: CarrierSaleOrder[] = [];
    const CHUNK = 200;
    for (let i = 0; i < names.length; i += CHUNK) {
      const chunk = names.slice(i, i + CHUNK);
      const domain: any[] = [["name", "in", chunk]];
      if (useDate && dateStart) domain.push(["date_order", ">=", `${dateStart} 00:00:00`]);
      if (useDate && dateEnd) domain.push(["date_order", "<=", `${dateEnd} 23:59:59`]);
      const rows = await searchRead(session, "sale.order", domain, fields, 0, "date_order desc");
      for (const r of rows) res.push(toRow(r));
    }
    return res;
  }

  // En cas de doublons, on garde la commande au montant le plus élevé.
  const byRef = new Map<string, CarrierSaleOrder>();
  const collect = (rows: CarrierSaleOrder[]) => {
    for (const o of rows) {
      const ex = byRef.get(o.ref);
      if (!ex || o.montantHT > ex.montantHT) byRef.set(o.ref, o);
    }
  };

  // Passe 1 : nom + bornage date (commandes dont date_order tombe dans la plage).
  collect(await searchByNames(uniqueRefs, true));

  // Passe 2 (rattrapage) : pour les réfs encore introuvables, on cherche par
  // nom SANS contrainte de date. Indispensable car la date d'expédition de la
  // facture ≠ date_order : une commande expédiée en avril a pu être passée en
  // mars. Le nom étant unique, ce rattrapage est sûr.
  if (dateStart || dateEnd) {
    const missing = uniqueRefs.filter(r => !byRef.has(r));
    if (missing.length) collect(await searchByNames(missing, false));
  }

  // ── Cumul des commandes jointes ────────────────────────────────────────
  // Pour les livraisons groupées, la facture transporteur ne porte qu'une
  // seule réf (ex : S67223) alors que le colis couvre plusieurs commandes
  // (S67223 + S66983). On ajoute le montant des commandes jointes.
  if (joinedName) {
    try {
      // 1. Récolte des identifiants joints (ids si relationnel, sinon noms texte).
      const joinedIds = new Set<number>();
      const joinedNames = new Set<string>();
      for (const ref of Array.from(byRef.keys())) {
        const v = rawJoined.get(ref);
        if (v == null || v === false) continue;
        if (joinedRelational && Array.isArray(v)) {
          // many2one => [id, "S####"] ; m2m/o2m => [id, id, ...]
          if (v.length === 2 && typeof v[1] === "string") joinedIds.add(v[0]);
          else for (const id of v) if (typeof id === "number") joinedIds.add(id);
        } else if (typeof v === "string") {
          for (const m of v.match(/S\d{4,}/g) || []) joinedNames.add(m);
        }
      }

      // 2. Résolution des montants des commandes jointes (par id puis par nom).
      const amtByName = new Map<string, { ht: number; ttc: number }>();
      const idToName = new Map<number, string>();
      const readJoined = async (domain: any[]) => {
        const rows = await searchRead(session, "sale.order", domain, ["id", "name", "amount_untaxed", "amount_total"], 0, "");
        for (const r of rows) { amtByName.set(r.name, { ht: r.amount_untaxed || 0, ttc: r.amount_total || 0 }); idToName.set(r.id, r.name); }
      };
      const idList = Array.from(joinedIds);
      for (let i = 0; i < idList.length; i += 200) await readJoined([["id", "in", idList.slice(i, i + 200)]]);
      const nameList = Array.from(joinedNames);
      for (let i = 0; i < nameList.length; i += 200) await readJoined([["name", "in", nameList.slice(i, i + 200)]]);
      // On a aussi les montants des commandes facturées elles-mêmes.
      for (const o of Array.from(byRef.values())) amtByName.set(o.ref, { ht: o.montantHT, ttc: o.montantTTC });

      // 3. Cumul sur chaque commande facturée (dédoublonné, self inclus).
      for (const [ref, o] of Array.from(byRef.entries())) {
        const v = rawJoined.get(ref);
        const siblings: string[] = [];
        if (v != null && v !== false) {
          if (joinedRelational && Array.isArray(v)) {
            const ids = (v.length === 2 && typeof v[1] === "string") ? [v[0]] : v.filter((x: any) => typeof x === "number");
            for (const id of ids) { const nm = idToName.get(id); if (nm) siblings.push(nm); }
          } else if (typeof v === "string") {
            for (const m of v.match(/S\d{4,}/g) || []) siblings.push(m);
          }
        }
        const groupe = Array.from(new Set([ref, ...siblings])).filter(n => amtByName.has(n));
        if (groupe.length > 1) {
          let ht = 0, ttc = 0;
          const detail: { ref: string; montantHT: number; montantTTC: number }[] = [];
          for (const n of groupe) { const a = amtByName.get(n)!; ht += a.ht; ttc += a.ttc; detail.push({ ref: n, montantHT: a.ht, montantTTC: a.ttc }); }
          o.montantHT = Math.round(ht * 100) / 100;
          o.montantTTC = Math.round(ttc * 100) / 100;
          o.groupe = groupe;
          o.groupeDetail = detail;
        }
      }
    } catch { /* en cas d'échec on garde les montants simples */ }
  }

  // ── Enrichissement CP / ville / département (adresse de livraison) ──────
  try {
    const shipIds = Array.from(new Set(Array.from(byRef.keys()).map(ref => refToShip.get(ref)).filter((x): x is number => typeof x === "number")));
    if (shipIds.length) {
      const partById = new Map<number, { cp: string; ville: string }>();
      for (let i = 0; i < shipIds.length; i += 200) {
        const rows = await searchRead(session, "res.partner", [["id", "in", shipIds.slice(i, i + 200)]], ["id", "zip", "city"], 0, "");
        for (const p of rows) partById.set(p.id, { cp: p.zip || "", ville: p.city || "" });
      }
      for (const [ref, o] of Array.from(byRef.entries())) {
        const sid = refToShip.get(ref);
        const p = sid != null ? partById.get(sid) : undefined;
        if (p) {
          o.cp = p.cp; o.ville = p.ville;
          const m = (p.cp || "").trim().match(/^(\d{2})\d{3}$/);
          o.dept = m ? m[1] : "";
        }
      }
    }
  } catch { /* enrichissement best-effort */ }

  // ── Enrichissement code client (ref de res.partner) ─────────────────────
  try {
    const partnerIds = Array.from(new Set(Array.from(byRef.keys()).map(ref => refToPartner.get(ref)).filter((x): x is number => typeof x === "number")));
    if (partnerIds.length) {
      const refById = new Map<number, string>();
      for (let i = 0; i < partnerIds.length; i += 200) {
        const rows = await searchRead(session, "res.partner", [["id", "in", partnerIds.slice(i, i + 200)]], ["id", "ref"], 0, "");
        for (const p of rows) if (p.ref) refById.set(p.id, p.ref);
      }
      for (const [orderRef, o] of Array.from(byRef.entries())) {
        const pid = refToPartner.get(orderRef);
        if (pid != null) {
          const r = refById.get(pid);
          if (r) o.partnerRef = r;
        }
      }
    }
  } catch { /* enrichissement best-effort */ }

  return Array.from(byRef.values());
}

// ════════════════════════════════════════════════════════════════════════════
// BMV — matching des expéditions SANS réf Odoo, par nom client + date (±N jours)
// ════════════════════════════════════════════════════════════════════════════

export interface BmvNameMatch {
  recep: string;       // n° de réception BMV (identifiant côté facture)
  ref: string;         // name de la commande Odoo trouvée
  client: string;
  partnerRef?: string;
  montantHT: number;
  montantTTC: number;
  dateOrder: string;
  cp?: string;
  ville?: string;
  dept?: string;
  approx: boolean;     // true = match par nom+date (à vérifier), pas par réf exacte
}

// Normalise un nom client pour comparaison tolérante (accents, casse, ponctuation).
function normName(s: string): string {
  return (s || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\b(SA|SAS|SARL|EURL|CD2|PLATEFORME)\b/g, " ")
    .replace(/\s+/g, " ").trim();
}

// Pour chaque expédition {recep, dest, date_iso}, cherche dans Odoo une sale.order
// dont le partenaire ressemble au destinataire ET date_order proche (±toleranceDays).
export async function fetchBmvByNameDate(
  session: OdooSession,
  shipments: { recep: string; dest: string; date_iso: string }[],
  // Fenêtre ASYMÉTRIQUE : la date BMV est la date d'EXPÉDITION ; la commande Odoo
  // (date_order) la PRÉCÈDE, parfois de plusieurs jours → on autorise un large
  // décalage "avant", et un petit décalage "après".
  daysBefore = 21,
  daysAfter = 3,
  // réfs déjà attribuées (ex: par le match direct S…) — à ne pas réutiliser
  alreadyUsed: string[] = []
): Promise<BmvNameMatch[]> {
  const out: BmvNameMatch[] = [];
  const targets = shipments.filter(s => s.dest && s.date_iso);
  if (!targets.length) return out;
  // Une commande Odoo ne peut être attribuée qu'à UNE seule expédition.
  const used = new Set<string>(alreadyUsed);

  // Bornes globales de dates (pour ne charger qu'une fenêtre de commandes).
  const dates = targets.map(t => t.date_iso).sort();
  const minD = new Date(dates[0]); minD.setDate(minD.getDate() - daysBefore);
  const maxD = new Date(dates[dates.length - 1]); maxD.setDate(maxD.getDate() + daysAfter);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  // Charge les commandes confirmées de la fenêtre, avec partenaire + date.
  const rows = await searchRead(session, "sale.order",
    [["state", "in", ["sale", "done"]],
     ["date_order", ">=", `${fmt(minD)} 00:00:00`],
     ["date_order", "<=", `${fmt(maxD)} 23:59:59`]],
    ["name", "partner_id", "partner_shipping_id", "amount_untaxed", "amount_total", "date_order"], 0, "date_order desc"
  );
  interface Cand { ref: string; client: string; norm: string; montantHT: number; montantTTC: number; dateOrder: string; }
  const candidates: Cand[] = rows.map((r: any) => ({
    ref: r.name,
    client: Array.isArray(r.partner_id) ? r.partner_id[1] : "",
    norm: normName(Array.isArray(r.partner_id) ? r.partner_id[1] : ""),
    montantHT: r.amount_untaxed || 0,
    montantTTC: r.amount_total || 0,
    dateOrder: r.date_order ? String(r.date_order).split(" ")[0] : "",
  }));

  // signedDiff = (date_order - date_expedition) en jours :
  //   négatif = commande AVANT l'expédition (cas normal), positif = après.
  const signedDiff = (orderDate: string, shipDate: string) =>
    (new Date(orderDate).getTime() - new Date(shipDate).getTime()) / 86400000;

  // On traite les expéditions par date croissante → attribution déterministe.
  const ordered = [...targets].sort((a, b) => a.date_iso.localeCompare(b.date_iso));
  for (const s of ordered) {
    const nd = normName(s.dest);
    if (!nd) continue;
    // candidats dont le nom correspond ET non déjà attribués, dans la fenêtre asymétrique
    const pool = candidates.filter(c => {
      if (used.has(c.ref) || !c.norm) return false;
      const nameOk = c.norm.includes(nd) || nd.includes(c.norm) || nd.split(" ")[0] === c.norm.split(" ")[0];
      if (!nameOk) return false;
      const diff = signedDiff(c.dateOrder, s.date_iso); // <0 = avant l'expé
      return diff >= -daysBefore && diff <= daysAfter;
    });
    if (!pool.length) continue;
    // meilleur = écart absolu le plus faible à la date d'expédition
    pool.sort((a, b) => Math.abs(signedDiff(a.dateOrder, s.date_iso)) - Math.abs(signedDiff(b.dateOrder, s.date_iso)));
    const best = pool[0];
    used.add(best.ref); // consommé → indisponible pour les autres expéditions
    out.push({
      recep: s.recep, ref: best.ref, client: best.client,
      montantHT: best.montantHT, montantTTC: best.montantTTC,
      dateOrder: best.dateOrder, approx: true,
    });
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// ÉDITION RAPIDE FICHE PRODUIT (desktop admin) — alternative légère à Odoo
// ════════════════════════════════════════════════════════════════════════════

export interface ProductQuickEditData {
  product: any;
  tmplId: number;
  // Champ dimensions texte (ex: x_dimensions "165mm x 28mm x 36mm" — base Dr. Hauschka)
  dimTextField: string | null;
  dimTextLabel: string;
  dimText: string;
  // Champs dimensions numériques éventuels (module product_dimension ou équivalent)
  dimFields: string[];
  dimLabels: Record<string, string>;
  dims: Record<string, number>;
  suppliers: Array<{ id: number; partner_id: [number, string]; product_code: string | false; product_name: string | false }>;
}

export async function getProductQuickEdit(session: OdooSession, productId: number): Promise<ProductQuickEditData> {
  const prods = await searchRead(session, "product.product",
    [["id", "=", productId]],
    ["id", "name", "default_code", "barcode", "sale_ok", "weight", "volume", "product_tmpl_id", "active"], 1);
  const prod = prods[0];
  if (!prod) throw new Error("Produit introuvable");
  const tmplId = prod.product_tmpl_id[0];

  // Détecte dynamiquement les champs dimensions disponibles sur cette base
  // — x_dimensions (char, custom Dr. Hauschka) en priorité, puis champs numériques standards
  let dimTextField: string | null = null;
  let dimTextLabel = "Dimensions";
  let dimText = "";
  let dimFields: string[] = [];
  const dimLabels: Record<string, string> = {};
  const dims: Record<string, number> = {};
  try {
    const fg = await callMethod(session, "product.template", "fields_get",
      [["x_dimensions", "product_length", "product_width", "product_height"]], { attributes: ["string", "type"] });
    const found = fg || {};
    if (found.x_dimensions) {
      dimTextField = "x_dimensions";
      dimTextLabel = (found.x_dimensions.string as string) || "Dimensions H x L x P";
    }
    dimFields = Object.keys(found).filter(f => f !== "x_dimensions" && found[f]?.type === "float");
    for (const f of dimFields) dimLabels[f] = (found[f]?.string as string) || f;
    const toRead = [...(dimTextField ? [dimTextField] : []), ...dimFields];
    if (toRead.length) {
      const tmpls = await searchRead(session, "product.template", [["id", "=", tmplId]], toRead, 1);
      if (tmpls[0]) {
        if (dimTextField) dimText = tmpls[0][dimTextField] || "";
        for (const f of dimFields) dims[f] = tmpls[0][f] || 0;
      }
    }
  } catch { dimFields = []; dimTextField = null; }

  // Lignes fournisseur (variante OU template)
  const suppliers = await searchRead(session, "product.supplierinfo",
    ["|", ["product_id", "=", productId], "&", ["product_id", "=", false], ["product_tmpl_id", "=", tmplId]],
    ["id", "partner_id", "product_code", "product_name"], 10);

  return { product: prod, tmplId, dimTextField, dimTextLabel, dimText, dimFields, dimLabels, dims, suppliers };
}

export async function saveProductQuickEdit(session: OdooSession, params: {
  productId: number; tmplId: number;
  barcode?: string;
  saleOk?: boolean;
  weight?: number;
  volume?: number;
  dimTextField?: string | null;
  dimText?: string;
  dims?: Record<string, number>;
  supplierCodes?: Array<{ id: number; product_code: string }>;
}) {
  const { productId, tmplId, barcode, saleOk, weight, volume, dimTextField, dimText, dims, supplierCodes } = params;

  // EAN → product.product (false pour effacer)
  if (barcode !== undefined) {
    await write(session, "product.product", [productId], { barcode: barcode.trim() || false });
  }

  // Vendable / poids / volume / dimensions → product.template
  const tmplVals: any = {};
  if (saleOk !== undefined) tmplVals.sale_ok = saleOk;
  if (weight !== undefined && !isNaN(weight)) tmplVals.weight = weight;
  if (volume !== undefined && !isNaN(volume)) tmplVals.volume = volume;
  if (dimTextField && dimText !== undefined) tmplVals[dimTextField] = dimText.trim() || false;
  if (dims) for (const [k, v] of Object.entries(dims)) { if (!isNaN(v)) tmplVals[k] = v; }
  if (Object.keys(tmplVals).length) await write(session, "product.template", [tmplId], tmplVals);

  // Réf fournisseur → product.supplierinfo
  if (supplierCodes?.length) {
    await Promise.all(supplierCodes.map(s =>
      write(session, "product.supplierinfo", [s.id], { product_code: s.product_code.trim() || false })
    ));
  }
  return true;
}

// ============================================
// INVENTAIRE TOURNANT
// ============================================

// Unités par colis (product.packaging.qty) pour une liste de produits.
// Retourne un map productId -> qty (la plus grande quantité de packaging trouvée).
export async function getPackagingQtyForProducts(
  session: OdooSession,
  productIds: number[]
): Promise<Record<number, number>> {
  const out: Record<number, number> = {};
  if (!productIds.length) return out;
  try {
    const packs = await searchRead(
      session, "product.packaging",
      [["product_id", "in", productIds], ["qty", ">", 0]],
      ["product_id", "qty"],
      1000
    );
    for (const p of packs) {
      const pid = Array.isArray(p.product_id) ? p.product_id[0] : p.product_id;
      const q = Number(p.qty) || 0;
      // garde la plus grande (colis le plus représentatif)
      if (q > 0 && (!out[pid] || q > out[pid])) out[pid] = q;
    }
  } catch {
    // product.packaging peut être indisponible selon la config → pas bloquant
  }
  return out;
}

// Emplacement(s) internes correspondant à un nom/code d'allée (recherche partielle).
export async function findLocationsByName(session: OdooSession, query: string): Promise<any[]> {
  const q = query.trim();
  if (!q) return [];
  // exact barcode d'abord
  const byBc = await searchRead(
    session, "stock.location",
    [["barcode", "=", q], ["usage", "=", "internal"]],
    ["id", "name", "complete_name", "barcode"], 5
  );
  if (byBc.length) return byBc;
  // sinon recherche par nom complet (ilike) — utile pour "Allée A", "A-", etc.
  return searchRead(
    session, "stock.location",
    ["|", ["complete_name", "ilike", q], ["name", "ilike", q], ["usage", "=", "internal"]],
    ["id", "name", "complete_name", "barcode"], 50, "complete_name"
  );
}

// Théorique pour une liste de combinaisons (produit/lot/emplacement).
// Retourne pour chaque clé: { quantId, theoretical } d'après stock.quant temps réel.
export interface TheoreticalRow { productId: number; lotId: number | null; locationId: number | null; quantId: number | null; theoretical: number; quantQty?: number; }

export async function getInventoryTheoretical(
  session: OdooSession,
  keys: { productId: number; lotId: number | null; locationId: number | null }[]
): Promise<TheoreticalRow[]> {
  if (!keys.length) return [];
  const productIds = Array.from(new Set(keys.map(k => k.productId)));
  // On récupère tous les quants internes des produits concernés en une requête
  const quants = await searchRead(
    session, "stock.quant",
    [["product_id", "in", productIds], ["location_id.usage", "=", "internal"]],
    ["id", "product_id", "lot_id", "location_id", "quantity"],
    2000
  );
  const qKey = (pid: number, lot: number | null, loc: number | null) => `${pid}|${lot ?? 0}|${loc ?? 0}`;
  // Map scommande exacte produit+lot+emplacement
  const exact: Record<string, { quantId: number; qty: number }> = {};
  // Agrégat produit+lot (tous emplacements) pour le mode scan libre (locationId null)
  // bestQty = qty du quant choisi comme cible (le plus rempli) → sert à appliquer un DELTA.
  const byProdLot: Record<string, { quantId: number; qty: number; bestQty: number }> = {};
  for (const q of quants) {
    const pid = Array.isArray(q.product_id) ? q.product_id[0] : q.product_id;
    const lot = q.lot_id ? (Array.isArray(q.lot_id) ? q.lot_id[0] : q.lot_id) : null;
    const loc = q.location_id ? (Array.isArray(q.location_id) ? q.location_id[0] : q.location_id) : null;
    const qty = Number(q.quantity) || 0;
    exact[qKey(pid, lot, loc)] = { quantId: q.id, qty };
    const plKey = `${pid}|${lot ?? 0}`;
    if (!byProdLot[plKey]) byProdLot[plKey] = { quantId: q.id, qty: 0, bestQty: qty };
    byProdLot[plKey].qty += qty;
    // garde le quant avec le plus de stock comme cible de correction par défaut
    if (qty >= byProdLot[plKey].bestQty) { byProdLot[plKey].quantId = q.id; byProdLot[plKey].bestQty = qty; }
  }
  return keys.map(k => {
    if (k.locationId != null) {
      const hit = exact[qKey(k.productId, k.lotId, k.locationId)];
      return { ...k, quantId: hit?.quantId ?? null, theoretical: hit?.qty ?? 0, quantQty: hit?.qty ?? 0 };
    }
    // mode scan libre : somme sur tous les emplacements pour ce produit+lot
    const hit = byProdLot[`${k.productId}|${k.lotId ?? 0}`];
    return { ...k, quantId: hit?.quantId ?? null, theoretical: hit?.qty ?? 0, quantQty: hit?.bestQty ?? 0 };
  });
}

// ============================================
// DEVIS E-SHOP (sale.order) — sorties du jour Shopware
// ============================================

export interface EshopQuoteLine { productId: number; qty: number; name?: string; orders?: string; }

// Crée un DEVIS (sale.order, état brouillon — non confirmé) pour les ventes e-shop
// du jour, sur le client e-shop donné. Retourne {id, name}.
export async function createEshopQuotation(
  session: OdooSession,
  partnerId: number,
  lines: EshopQuoteLine[],
  origin?: string,
  // confirm = true → confirme la commande (génère le bon de préparation / pick)
  confirm: boolean = false
): Promise<{ id: number; name: string }> {
  // Cumul des qtés par produit
  const grouped: Record<number, EshopQuoteLine> = {};
  for (const l of lines) {
    if (grouped[l.productId]) grouped[l.productId].qty += l.qty;
    else grouped[l.productId] = { ...l };
  }
  const vals: any = {
    partner_id: partnerId,
    order_line: Object.values(grouped).map(l => {
      // Description = nom produit + liste des commandes Shopware concernées (traçabilité)
      const desc = l.orders ? `${l.name || ""}\nCommandes : ${l.orders}`.trim() : l.name;
      return [0, 0, {
        product_id: l.productId,
        product_uom_qty: l.qty,
        ...(desc ? { name: desc } : {}),
      }];
    }),
  };
  if (origin) vals.origin = origin;

  // Date d'expédition prévue = aujourd'hui (champ custom date x_studio_date_dexpdition_prvue)
  try {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    vals.x_studio_date_dexpdition_prvue = today; // champ "date" → YYYY-MM-DD
    vals.commitment_date = `${today} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  } catch {}

  // Étiquettes (crm.tag) : "import eShop" + "Transmise" — trouvées ou créées
  try {
    const findOrCreateTag = async (name: string): Promise<number | null> => {
      const t = await searchRead(session, "crm.tag", [["name", "=", name]], ["id"], 1);
      if (t.length) return t[0].id;
      return await create(session, "crm.tag", { name }) as number;
    };
    const tagIds = (await Promise.all([findOrCreateTag("import eShop"), findOrCreateTag("Transmise")]))
      .filter((x): x is number => typeof x === "number");
    if (tagIds.length) vals.tag_ids = [[6, 0, tagIds]];
  } catch {}

  const id = await create(session, "sale.order", vals) as number;

  // Confirme la commande → génère le bon de préparation (stock.picking)
  if (confirm) {
    try { await callMethod(session, "sale.order", "action_confirm", [[id]]); }
    catch (e) { /* en cas d'échec, la commande reste en devis (non bloquant) */ }
  }

  const recs = await searchRead(session, "sale.order", [["id", "=", id]], ["id", "name"], 1);
  return { id, name: recs[0]?.name || String(id) };
}

// ============================================
// IMPORT MARKETPLACE (Imparfaite) — 1 commande = 1 nouveau client + 1 sale.order
// ============================================
export interface MarketplaceClient {
  name: string;
  ref?: string;          // numéro client = réf de commande
  email?: string;
  phone?: string;
  company?: string;
  street?: string;
  street2?: string;
  zip?: string;
  city?: string;
  countryCode?: string;  // ISO2 (ex: "FR")
  // Type de compte (champ custom many2one x_type_de_compte_id) → résolu par nom, ex: "Imparfaite"
  typeCompteName?: string;
}
export interface MarketplaceLine { productId: number; qty: number; name?: string; price?: number; }

// Crée un nouveau client (res.partner). Toujours nouveau (1 commande = 1 client).
export async function createMarketplaceClient(session: OdooSession, c: MarketplaceClient): Promise<number> {
  const vals: any = {
    name: c.name || "Client marketplace",
    company_type: "person",
    customer_rank: 1,
  };
  if (c.ref) vals.ref = c.ref;                       // numéro client = réf commande
  if (c.email) vals.email = c.email;
  if (c.phone) vals.phone = c.phone;
  if (c.street) vals.street = c.street;
  if (c.street2) vals.street2 = c.street2;
  if (c.zip) vals.zip = c.zip;
  if (c.city) vals.city = c.city;
  // Type de compte (x_type_de_compte_id, many2one vers x_type_de_compte) → résoudre par nom.
  // On lit TOUS les enregistrements et on matche en JS (insensible casse/accents),
  // car le champ "nom" du modèle custom peut varier (x_name, name, display_name…).
  if (c.typeCompteName) {
    try {
      const norm = (s: any) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
      const target = norm(c.typeCompteName);
      const recs = await searchRead(session, "x_type_de_compte", [], ["id", "display_name"], 300).catch(() => [] as any[]);
      // match exact normalisé, sinon "contient"
      let hit = recs.find((r: any) => norm(r.display_name) === target);
      if (!hit) hit = recs.find((r: any) => norm(r.display_name).includes(target));
      let typeId: number | undefined = hit?.id;
      // s'il n'existe pas, on crée l'option
      if (!typeId) {
        try { typeId = await create(session, "x_type_de_compte", { x_name: c.typeCompteName }) as number; }
        catch { try { typeId = await create(session, "x_type_de_compte", { name: c.typeCompteName }) as number; } catch {} }
      }
      if (typeId) vals.x_type_de_compte_id = typeId;
    } catch {}
  }
  // Pays via code ISO2
  if (c.countryCode) {
    try {
      const co = await searchRead(session, "res.country", [["code", "=", c.countryCode.toUpperCase()]], ["id"], 1);
      if (co.length) vals.country_id = co[0].id;
    } catch {}
  }
  return await create(session, "res.partner", vals) as number;
}

// Crée une commande de vente marketplace pour un client donné.
// confirm → confirme (génère le BL) ; assign → réserve le stock sur le BL.
// Lignes à 0 € si price non fourni (mode "suivi/destockage").
export async function createMarketplaceOrder(
  session: OdooSession,
  partnerId: number,
  lines: MarketplaceLine[],
  opts: { origin?: string; confirm?: boolean; assign?: boolean; tag?: string; price0?: boolean; pricelistName?: string } = {}
): Promise<{ id: number; name: string }> {
  const vals: any = {
    partner_id: partnerId,
    user_id: false, // vendeur vide (règle Imparfaite)
    order_line: lines.map(l => {
      const line: any = { product_id: l.productId, product_uom_qty: l.qty };
      if (l.name) line.name = l.name;
      if (opts.price0) line.price_unit = 0;
      else if (l.price != null) line.price_unit = l.price;
      return [0, 0, line];
    }),
  };
  if (opts.origin) vals.origin = opts.origin;
  // Liste de prix (ex: "WALAOFFERT_2026" → met les prix à 0). Recherche tolérante.
  let pricelistId: number | null = null;
  if (opts.pricelistName) {
    try {
      let pl = await searchRead(session, "product.pricelist", [["name", "=", opts.pricelistName]], ["id"], 1);
      if (!pl.length) pl = await searchRead(session, "product.pricelist", [["name", "ilike", opts.pricelistName]], ["id"], 1);
      if (pl.length) { pricelistId = pl[0].id; vals.pricelist_id = pricelistId; }
    } catch {}
  }
  // Date d'expédition prévue = aujourd'hui (champ custom date x_studio_date_dexpdition_prvue)
  try {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    vals.x_studio_date_dexpdition_prvue = today; // champ "date" → YYYY-MM-DD
    vals.commitment_date = `${today} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  } catch {}
  // Étiquette (crm.tag)
  if (opts.tag) {
    try {
      const t = await searchRead(session, "crm.tag", [["name", "=", opts.tag]], ["id"], 1);
      const tagId = t.length ? t[0].id : await create(session, "crm.tag", { name: opts.tag }) as number;
      if (tagId) vals.tag_ids = [[6, 0, [tagId]]];
    } catch {}
  }

  const id = await create(session, "sale.order", vals) as number;

  // La pricelist est READONLY une fois la commande confirmée (state=sale).
  // On la (ré)impose donc TANT QU'ON EST EN BROUILLON, puis on recalcule les prix.
  if (pricelistId) {
    try {
      await write(session, "sale.order", [id], { pricelist_id: pricelistId });
      try { await callMethod(session, "sale.order", "action_update_prices", [[id]]); }
      catch { try { await callMethod(session, "sale.order", "update_prices", [[id]]); } catch {} }
    } catch {}
  }

  if (opts.confirm) {
    try {
      await callMethod(session, "sale.order", "action_confirm", [[id]]);
      // réservation du stock sur le(s) picking(s) générés
      if (opts.assign) {
        try {
          const picks = await searchRead(session, "stock.picking", [["sale_id", "=", id], ["state", "not in", ["done", "cancel"]]], ["id"], 10);
          for (const p of picks) { try { await callMethod(session, "stock.picking", "action_assign", [[p.id]]); } catch {} }
        } catch {}
      }
    } catch {}
  }

  const recs = await searchRead(session, "sale.order", [["id", "=", id]], ["id", "name"], 1);
  return { id, name: recs[0]?.name || String(id) };
}

// Stock disponible (quantity - reserved) par référence interne Odoo. Pour la synchro Shopware.
export async function getStockByRef(session: OdooSession, ref: string): Promise<{ productId: number; name: string; available: number } | null> {
  const prods = await searchRead(session, "product.product",
    ["|", ["default_code", "=", ref], ["barcode", "=", ref]],
    ["id", "name", "default_code", "qty_available"], 1);
  if (!prods.length) return null;
  const p = prods[0];
  // qty_available = stock physique ; on retire le réservé via les quants internes
  const quants = await searchRead(session, "stock.quant",
    [["product_id", "=", p.id], ["location_id.usage", "=", "internal"]],
    ["quantity", "reserved_quantity"], 200);
  const available = quants.reduce((s: number, q: any) => s + ((q.quantity || 0) - (q.reserved_quantity || 0)), 0);
  return { productId: p.id, name: p.name, available: Math.round(available) };
}

// Stock dispo (quantity - reserved) pour PLUSIEURS produits d'un coup → map productId → dispo.
export async function getAvailableStockBatch(session: OdooSession, productIds: number[]): Promise<Record<number, number>> {
  const out: Record<number, number> = {};
  if (!productIds.length) return out;
  for (const id of productIds) out[id] = 0;
  // Une seule requête quants pour tous les produits internes
  const quants = await searchRead(session, "stock.quant",
    [["product_id", "in", productIds], ["location_id.usage", "=", "internal"]],
    ["product_id", "quantity", "reserved_quantity"], 5000);
  for (const q of quants) {
    const pid = Array.isArray(q.product_id) ? q.product_id[0] : q.product_id;
    out[pid] = (out[pid] || 0) + ((q.quantity || 0) - (q.reserved_quantity || 0));
  }
  for (const id of productIds) out[id] = Math.round(out[id]);
  return out;
}

// Vérifie qu'un client (res.partner) existe par id ou numéro/nom, retourne {id, name}.
export async function findEshopPartner(session: OdooSession, idOrRef: string): Promise<{ id: number; name: string } | null> {
  const q = idOrRef.trim();
  // Plusieurs contacts peuvent partager la même réf (eSHOP + Aline CASSIBI + adresses de
  // livraison). On veut LA SOCIÉTÉ. Priorité : nom exact société > ref société > nom exact > ref.
  const fields = ["id", "name"];
  // 1) Nom exact ET société (ex: "eSHOP")
  let r = await searchRead(session, "res.partner", [["name", "=", q], ["is_company", "=", true]], fields, 1);
  if (r.length) return { id: r[0].id, name: r[0].name };
  // 2) Réf exacte ET société
  r = await searchRead(session, "res.partner", [["ref", "=", q], ["is_company", "=", true]], fields, 1);
  if (r.length) return { id: r[0].id, name: r[0].name };
  // 3) Nom exact (toute fiche)
  r = await searchRead(session, "res.partner", [["name", "=", q]], fields, 1);
  if (r.length) return { id: r[0].id, name: r[0].name };
  // 4) Id interne si purement numérique
  if (/^\d+$/.test(q)) {
    r = await searchRead(session, "res.partner", [["id", "=", Number(q)]], fields, 1);
    if (r.length) return { id: r[0].id, name: r[0].name };
  }
  // 5) Réf exacte (dernier recours — peut être ambigu)
  r = await searchRead(session, "res.partner", [["ref", "=", q]], fields, 1);
  if (r.length) return { id: r[0].id, name: r[0].name };
  return null;
}
