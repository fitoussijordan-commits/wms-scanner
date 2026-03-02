// lib/odoo.ts

export interface OdooConfig { url: string; db: string; }
export interface OdooSession { uid: number; name: string; sessionId: string; config: OdooConfig; }

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
  return { uid: result.uid, name: result.name || result.username || login, sessionId: sid || result.session_id || "", config };
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
// SMART SCAN
// ============================================
export type ScanResult =
  | { type: "location"; data: any }
  | { type: "product"; data: any }
  | { type: "lot"; data: { lot: any; product: any } }
  | { type: "not_found"; code: string };

export async function smartScan(session: OdooSession, code: string): Promise<ScanResult> {
  const locs = await searchRead(session, "stock.location", [["barcode", "=", code]], ["id", "name", "complete_name", "barcode"], 1);
  if (locs.length) return { type: "location", data: locs[0] };

  const byBC = await searchRead(session, "product.product", [["barcode", "=", code]], ["id", "name", "barcode", "default_code", "uom_id", "tracking"], 1);
  if (byBC.length) return { type: "product", data: byBC[0] };

  const byRef = await searchRead(session, "product.product", [["default_code", "=", code]], ["id", "name", "barcode", "default_code", "uom_id", "tracking"], 1);
  if (byRef.length) return { type: "product", data: byRef[0] };

  const lots = await searchRead(session, "stock.lot", [["name", "=", code]], ["id", "name", "product_id"], 1);
  if (lots.length) {
    const prod = await searchRead(session, "product.product", [["id", "=", lots[0].product_id[0]]], ["id", "name", "barcode", "default_code", "uom_id", "tracking"], 1);
    return { type: "lot", data: { lot: lots[0], product: prod[0] || null } };
  }
  return { type: "not_found", code };
}

// ============================================
// STOCK QUERIES - ONLY INTERNAL LOCATIONS
// ============================================

// Stock d'un produit sur TOUS les emplacements internes
export async function getAllStockForProduct(session: OdooSession, productId: number) {
  return searchRead(
    session,
    "stock.quant",
    [
      ["product_id", "=", productId],
      ["quantity", "!=", 0],
      ["location_id.usage", "=", "internal"],
    ],
    ["location_id", "lot_id", "quantity", "reserved_quantity"],
    500,
    "location_id"
  );
}

// Stock d'un lot spécifique sur tous les emplacements internes
export async function getStockForLot(session: OdooSession, lotId: number, productId: number) {
  return searchRead(
    session,
    "stock.quant",
    [
      ["lot_id", "=", lotId],
      ["product_id", "=", productId],
      ["quantity", "!=", 0],
      ["location_id.usage", "=", "internal"],
    ],
    ["location_id", "lot_id", "quantity", "reserved_quantity"],
    200,
    "location_id"
  );
}

// Stock sur un emplacement donné (pour le mode transfert)
export async function getStockAtLocation(session: OdooSession, productId: number, locationId: number) {
  return searchRead(
    session,
    "stock.quant",
    [["product_id", "=", productId], ["location_id", "=", locationId]],
    ["quantity", "lot_id", "reserved_quantity"]
  );
}

// Tous les produits d'un emplacement
export async function getProductsAtLocation(session: OdooSession, locationId: number) {
  return searchRead(
    session,
    "stock.quant",
    [["location_id", "=", locationId], ["quantity", "!=", 0]],
    ["product_id", "lot_id", "quantity", "reserved_quantity"],
    500,
    "product_id"
  );
}

export async function getLocations(session: OdooSession) {
  return searchRead(session, "stock.location", [["usage", "=", "internal"]], ["id", "name", "complete_name", "barcode"], 500, "complete_name");
}

// ============================================
// RENAME LOCATION
// ============================================
export async function renameLocation(session: OdooSession, locationId: number, newName: string) {
  return write(session, "stock.location", [locationId], { name: newName });
}

// ============================================
// TRANSFER
// ============================================
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
      name: line.productName,
      product_id: line.productId,
      product_uom_qty: line.qty,
      product_uom: line.uomId,
      location_id: sourceLocationId,
      location_dest_id: destLocationId,
    }]),
  });

  await callMethod(session, "stock.picking", "action_confirm", [[pickingId]]);
  await callMethod(session, "stock.picking", "action_assign", [[pickingId]]);

  // Écrire les qty_done et les lots sur les move lines
  const moveLines = await searchRead(session, "stock.move.line",
    [["picking_id", "=", pickingId]],
    ["id", "product_id", "lot_id", "product_uom_qty", "qty_done"]
  );

  for (const ml of moveLines) {
    const matchingLine = lines.find(l => l.productId === ml.product_id[0]);
    if (matchingLine) {
      const updates: any = { qty_done: matchingLine.qty };
      if (matchingLine.lotId) updates.lot_id = matchingLine.lotId;
      await write(session, "stock.move.line", [ml.id], updates);
    }
  }

  return pickingId;
}

export async function validatePicking(session: OdooSession, pickingId: number) {
  const result = await callMethod(session, "stock.picking", "button_validate", [[pickingId]]);

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
