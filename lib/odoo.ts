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
// PRODUCT FIELDS
// ============================================
const PRODUCT_FIELDS = ["id", "name", "barcode", "default_code", "uom_id", "tracking", "active"];

// ============================================
// SMART SCAN — with archived product fallback
// ============================================
export type ScanResult =
  | { type: "location"; data: any }
  | { type: "product"; data: any }
  | { type: "lot"; data: { lot: any; product: any } }
  | { type: "not_found"; code: string };

export async function smartScan(session: OdooSession, code: string): Promise<ScanResult> {
  // 1. Location by barcode
  const locs = await searchRead(session, "stock.location", [["barcode", "=", code]], ["id", "name", "complete_name", "barcode"], 1);
  if (locs.length) return { type: "location", data: locs[0] };

  // 2. Product by barcode (active)
  const byBC = await searchRead(session, "product.product", [["barcode", "=", code]], PRODUCT_FIELDS, 1);
  if (byBC.length) return { type: "product", data: byBC[0] };

  // 3. Product by reference (active)
  const byRef = await searchRead(session, "product.product", [["default_code", "=", code]], PRODUCT_FIELDS, 1);
  if (byRef.length) return { type: "product", data: byRef[0] };

  // 4. Lot
  const lots = await searchRead(session, "stock.lot", [["name", "=", code]], ["id", "name", "product_id", "expiration_date", "use_date", "removal_date"], 1);
  if (lots.length) {
    let prod = await searchRead(session, "product.product", [["id", "=", lots[0].product_id[0]]], PRODUCT_FIELDS, 1);
    // Fallback: archived product
    if (!prod.length) prod = await searchRead(session, "product.product", [["id", "=", lots[0].product_id[0]], ["active", "=", false]], PRODUCT_FIELDS, 1);
    return { type: "lot", data: { lot: lots[0], product: prod[0] || null } };
  }

  // 5. Fallback: archived product by barcode
  const archivedBC = await searchRead(session, "product.product", [["barcode", "=", code], ["active", "=", false]], PRODUCT_FIELDS, 1);
  if (archivedBC.length) return { type: "product", data: archivedBC[0] };

  // 6. Fallback: archived product by reference
  const archivedRef = await searchRead(session, "product.product", [["default_code", "=", code], ["active", "=", false]], PRODUCT_FIELDS, 1);
  if (archivedRef.length) return { type: "product", data: archivedRef[0] };

  return { type: "not_found", code };
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
  return searchRead(
    session, "stock.quant",
    [["location_id", "=", locationId], ["quantity", "!=", 0]],
    ["product_id", "lot_id", "quantity", "reserved_quantity"],
    500, "product_id"
  );
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
// PREPARATION — Outgoing pickings
// ============================================

const PICKING_FIELDS = [
  "id", "name", "state", "scheduled_date", "date_deadline",
  "partner_id", "origin", "picking_type_id",
  "move_ids_without_package", "location_id", "location_dest_id",
];

// Get pick-type pickings in confirmed/assigned state (preparation)
export async function getOutgoingPickings(session: OdooSession) {
  // Find pick picking type(s) — preparation before delivery
  const types = await searchRead(session, "stock.picking.type", [["code", "=", "internal"], ["name", "ilike", "pick"]], ["id", "name"], 10);
  // Fallback: if no "pick" type found, try sequence_code or all internal
  let typeIds = types.map((t: any) => t.id);
  if (!typeIds.length) {
    // Try by sequence_code
    const types2 = await searchRead(session, "stock.picking.type", [["sequence_code", "=", "PICK"]], ["id"], 10);
    typeIds = types2.map((t: any) => t.id);
  }
  if (!typeIds.length) {
    // Last resort: outgoing
    const types3 = await searchRead(session, "stock.picking.type", [["code", "=", "outgoing"]], ["id"], 10);
    typeIds = types3.map((t: any) => t.id);
  }
  if (!typeIds.length) return [];

  return searchRead(
    session, "stock.picking",
    [
      ["picking_type_id", "in", typeIds],
      ["state", "in", ["confirmed", "assigned"]],
    ],
    PICKING_FIELDS,
    200,
    "scheduled_date asc, id asc"
  );
}

// Get move lines for a picking (what needs to be prepared)
export async function getPickingMoveLines(session: OdooSession, pickingId: number) {
  return searchRead(
    session, "stock.move.line",
    [["picking_id", "=", pickingId]],
    ["id", "product_id", "lot_id", "location_id", "location_dest_id", "qty_done", "reserved_uom_qty"],
    200,
    "product_id"
  );
}

// Get stock.moves for a picking (demand info)
export async function getPickingMoves(session: OdooSession, pickingId: number) {
  return searchRead(
    session, "stock.move",
    [["picking_id", "=", pickingId]],
    ["id", "product_id", "product_uom_qty", "quantity_done", "product_uom", "state"],
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

  // Read move lines — Odoo 16: only safe fields (no product_uom_qty on stock.move.line)
  const moveLines = await searchRead(session, "stock.move.line",
    [["picking_id", "=", pickingId]],
    ["id", "product_id", "lot_id", "qty_done"]
  );

  // Write qty_done and lot on each move line
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
