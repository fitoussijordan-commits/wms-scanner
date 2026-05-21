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

async function call(session: OdooSession, endpoint: string, params: any) {
  const { result } = await rpc(session.config, endpoint, params, session.sessionId);
  return result;
}

export async function searchRead(session: OdooSession, model: string, domain: any[], fields: string[], limit = 0, order = "") {
  return call(session, "/web/dataset/call_kw", { model, method: "search_read", args: [domain], kwargs: { fields, limit, order } });
}

export async function callMethod(session: OdooSession, model: string, method: string, args: any[] = [], kwargs: any = {}) {
  return call(session, "/web/dataset/call_kw", { model, method, args, kwargs });
}

export async function create(session: OdooSession, model: string, values: any) {
  return call(session, "/web/dataset/call_kw", { model, method: "create", args: [values], kwargs: {} });
}

export async function write(session: OdooSession, model: string, ids: number[], values: any) {
  return call(session, "/web/dataset/call_kw", { model, method: "write", args: [ids, values], kwargs: {} });
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
  return searchRead(session, "stock.location", [["usage", "in", ["internal", "transit"]]], ["id", "name", "complete_name", "barcode", "usage"], 2000, "complete_name");
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

export async function getWaitingPickings(session: OdooSession): Promise<any[]> {
  // Même picking types que getOutgoingPickings
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

  // Trouver l'ID du tag "Transmise" — seules ces commandes doivent apparaître
  const transmiseTags = await searchRead(session, "crm.tag", [["name", "ilike", "transmise"]], ["id", "name"], 10);
  const transmiseTagIds: number[] = transmiseTags.map((t: any) => t.id);

  const domain: any[] = [
    ["picking_type_id", "in", typeIds],
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

  // Même enrichissement date depuis OUT lié + sale.order (identique à getOutgoingPickings)
  const groupIds = Array.from(new Set(pickings.map((p: any) => p.group_id?.[0]).filter(Boolean)));
  if (groupIds.length > 0) {
    const outTypes = await searchRead(session, "stock.picking.type", [["code", "=", "outgoing"]], ["id"], 10);
    const outTypeIds = outTypes.map((t: any) => t.id);
    if (outTypeIds.length > 0) {
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
  match_method: "supplier_ref" | "barcode" | "name";
}

export async function matchEshopSkus(
  session: OdooSession,
  skus: string[]
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

// Apply inventory adjustment: set inventory_quantity then call action_apply_inventory
export async function applyInventoryAdjustment(
  session: OdooSession,
  quantId: number,
  newQty: number
): Promise<void> {
  await write(session, "stock.quant", [quantId], { inventory_quantity: newQty });
  await callMethod(session, "stock.quant", "action_apply_inventory", [[quantId]]);
}

// Create a new quant (for products with 0 stock not yet in a location)
export async function createInventoryAdjustment(
  session: OdooSession,
  productId: number,
  locationId: number,
  newQty: number,
  lotId?: number
): Promise<void> {
  const vals: any = {
    product_id: productId,
    location_id: locationId,
    inventory_quantity: newQty,
  };
  if (lotId) vals.lot_id = lotId;
  const quantId = await create(session, "stock.quant", vals);
  await callMethod(session, "stock.quant", "action_apply_inventory", [[quantId]]);
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

  // 3. Lier le package au picking via stock.package.level
  //    C'est le modèle prévu pour associer un colis à un picking proprement,
  //    sans créer de ligne de stock visible (contrairement à une move line fantôme).
  //    package_ids sur stock.picking est calculé depuis move_line_ids.result_package_id
  //    ET package_level_ids.package_id — donc ça apparaît bien dans Odoo.
  try {
    await create(session, "stock.package.level", {
      package_id: packageId,
      picking_id: pickingId,
      is_done: true,
    });
  } catch {
    // stock.package.level peut ne pas exister dans certaines versions —
    // fallback: move line fantôme (moins propre mais fonctionnel)
    try {
      const existingLines = await searchRead(
        session, "stock.move.line",
        [["picking_id", "=", pickingId]],
        ["id", "product_id", "product_uom_id", "move_id", "location_id", "location_dest_id"],
        1
      );
      if (existingLines.length > 0) {
        const ref = existingLines[0];
        await create(session, "stock.move.line", {
          picking_id: pickingId,
          move_id: ref.move_id?.[0] || false,
          product_id: ref.product_id[0],
          product_uom_id: ref.product_uom_id?.[0] || 1,
          qty_done: 0,
          location_id: ref.location_id[0],
          location_dest_id: ref.location_dest_id[0],
          result_package_id: packageId,
        });
      }
    } catch {}
  }

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
  const templates = await searchRead(
    session, "product.template",
    [["x_studio_code_produit_fournisseur", "in", articleCodes]],
    ["id", "name", "default_code", "x_studio_code_produit_fournisseur", "product_variant_ids", "uom_id"],
    0
  );
  const map: Record<string, any> = {};
  for (const t of templates) {
    const code = t.x_studio_code_produit_fournisseur;
    const productId = Array.isArray(t.product_variant_ids) ? t.product_variant_ids[0] : null;
    if (code && productId) {
      map[String(code).trim()] = {
        templateId: t.id,
        productId,
        name: t.name,
        defaultCode: t.default_code || "",
        uomId: Array.isArray(t.uom_id) ? t.uom_id[0] : t.uom_id,
        uomName: Array.isArray(t.uom_id) ? t.uom_id[1] : "",
      };
    }
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
  lotId: number;
  lotName: string;
  qty: number;
  uomId: number;
}

/** Affecte lots et quantités aux lignes de mouvement de la réception */
export async function setReceptionLots(
  session: OdooSession,
  pickingId: number,
  locationId: number,
  locationDestId: number,
  lines: ReceptionLotLine[]
): Promise<void> {
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

  for (const line of lines) {
    const pool = mlPool[line.productId];
    const ml = pool?.shift();

    if (ml) {
      // lot_id (many2one) + lot_name (char) pour forcer l'affectation dans Odoo
      await write(session, "stock.move.line", [ml.id], {
        lot_id: line.lotId,
        lot_name: line.lotName,
      });
    } else {
      // Créer une nouvelle ligne de mouvement (produit avec plusieurs lots)
      const move = moves.find((m: any) => {
        const pid = Array.isArray(m.product_id) ? m.product_id[0] : m.product_id;
        return pid === line.productId;
      });
      if (!move) continue; // Skip si pas de mouvement trouvé
      await create(session, "stock.move.line", {
        picking_id: pickingId,
        move_id: move.id,
        product_id: line.productId,
        product_uom_id: line.uomId,
        lot_id: line.lotId,
        lot_name: line.lotName,
        location_id: locationId,
        location_dest_id: locationDestId,
      });
    }
  }
}

// validatePicking est déjà défini plus haut dans ce fichier (ligne ~710) — on réutilise l'existant.

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
export async function bulkUpdateMinQuantity(
  session: OdooSession,
  updates: { id: number; value: number }[]
): Promise<void> {
  await Promise.all(
    updates.map(u => write(session, "product.template", [u.id], { temp_min_quantity: u.value }))
  );
}
