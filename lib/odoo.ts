// lib/odoo.ts

export interface OdooConfig {
  url: string;
  db: string;
}

export interface OdooSession {
  uid: number;
  name: string;
  sessionId: string;
  config: OdooConfig;
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

// === AUTH ===
export async function authenticate(config: OdooConfig, login: string, password: string): Promise<OdooSession> {
  const { result, sessionId: cookieSessionId } = await rpc(config, "/web/session/authenticate", { db: config.db, login, password });
  if (!result || !result.uid || result.uid === false) throw new Error("Identifiants incorrects");
  return { uid: result.uid, name: result.name || result.username || login, sessionId: cookieSessionId || result.session_id || "", config };
}

// === GENERIC ===
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

// ============================================
// SMART SCAN
// ============================================

export type ScanResult =
  | { type: "location"; data: any }
  | { type: "product"; data: any }
  | { type: "lot"; data: { lot: any; product: any } }
  | { type: "not_found"; code: string };

export async function smartScan(session: OdooSession, code: string): Promise<ScanResult> {
  // 1. Emplacement
  const locations = await searchRead(session, "stock.location", [["barcode", "=", code]], ["id", "name", "complete_name", "barcode"], 1);
  if (locations.length > 0) return { type: "location", data: locations[0] };

  // 2. Produit par barcode
  const byBarcode = await searchRead(session, "product.product", [["barcode", "=", code]], ["id", "name", "barcode", "default_code", "uom_id", "tracking"], 1);
  if (byBarcode.length > 0) return { type: "product", data: byBarcode[0] };

  // 3. Produit par référence
  const byRef = await searchRead(session, "product.product", [["default_code", "=", code]], ["id", "name", "barcode", "default_code", "uom_id", "tracking"], 1);
  if (byRef.length > 0) return { type: "product", data: byRef[0] };

  // 4. Lot
  const lots = await searchRead(session, "stock.lot", [["name", "=", code]], ["id", "name", "product_id"], 1);
  if (lots.length > 0) {
    const prod = await searchRead(session, "product.product", [["id", "=", lots[0].product_id[0]]], ["id", "name", "barcode", "default_code", "uom_id", "tracking"], 1);
    return { type: "lot", data: { lot: lots[0], product: prod[0] || null } };
  }

  return { type: "not_found", code };
}

// ============================================
// LOOKUP - stock complet d'un produit sur tous les emplacements
// ============================================

export async function getAllStockForProduct(session: OdooSession, productId: number) {
  return searchRead(
    session,
    "stock.quant",
    [["product_id", "=", productId], ["quantity", "!=", 0]],
    ["location_id", "lot_id", "quantity", "reserved_quantity"],
    200,
    "location_id"
  );
}

// Stock sur un emplacement donné (pour le mode transfert)
export async function getStockAtLocation(session: OdooSession, productId: number, locationId: number) {
  return searchRead(session, "stock.quant", [["product_id", "=", productId], ["location_id", "=", locationId]], ["quantity", "lot_id", "reserved_quantity"]);
}

// Tous les produits d'un emplacement
export async function getProductsAtLocation(session: OdooSession, locationId: number) {
  return searchRead(
    session,
    "stock.quant",
    [["location_id", "=", locationId], ["quantity", "!=", 0]],
    ["product_id", "lot_id", "quantity", "reserved_quantity"],
    200,
    "product_id"
  );
}

export async function getLocations(session: OdooSession) {
  return searchRead(session, "stock.location", [["usage", "=", "internal"]], ["id", "name", "complete_name", "barcode"], 200, "complete_name");
}

// === TRANSFERT ===

export async function createInternalTransfer(
  session: OdooSession,
  sourceLocationId: number,
  destLocationId: number,
  lines: { productId: number; productName: string; qty: number; uomId: number; lotId?: number | null }[]
) {
  const pickingTypes = await searchRead(session, "stock.picking.type", [["code", "=", "internal"]], ["id"], 1);
  if (!pickingTypes.length) throw new Error("Aucun type d'opération interne trouvé");

  const pickingId = await create(session, "stock.picking", {
    picking_type_id: pickingTypes[0].id,
    location_id: sourceLocationId,
    location_dest_id: destLocationId,
    move_ids_without_package: lines.map((line) => [0, 0, {
      name: line.productName, product_id: line.productId, product_uom_qty: line.qty,
      product_uom: line.uomId, location_id: sourceLocationId, location_dest_id: destLocationId,
      ...(line.lotId ? { lot_id: line.lotId } : {}),
    }]),
  });

  await callMethod(session, "stock.picking", "action_confirm", [[pickingId]]);
  await callMethod(session, "stock.picking", "action_assign", [[pickingId]]);
  return pickingId;
}

export async function validatePicking(session: OdooSession, pickingId: number) {
  const result = await callMethod(session, "stock.picking", "button_validate", [[pickingId]]);
  if (result && typeof result === "object" && result.res_model) {
    const wizardModel = result.res_model;
    const wizardId = result.res_id;
    if (wizardModel === "stock.immediate.transfer") {
      await callMethod(session, "stock.immediate.transfer", "process", [[wizardId]]);
    } else if (wizardModel === "stock.backorder.confirmation") {
      await callMethod(session, "stock.backorder.confirmation", "process", [[wizardId]]);
    }
  }
  return result;
}
