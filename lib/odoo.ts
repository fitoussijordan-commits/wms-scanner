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
    ["product_id", "lot_id", "quantity", "reserved_quantity"],
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
// PREPARATION — Outgoing pickings
// ============================================

const PICKING_FIELDS = [
  "id", "name", "state", "scheduled_date", "date_deadline", "date",
  "partner_id", "origin", "picking_type_id", "group_id",
  "move_ids_without_package", "location_id", "location_dest_id",
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

  // Sort by shipping_date, then date_deadline, then scheduled_date
  pickings.sort((a: any, b: any) => {
    const da = a.shipping_date || a.date_deadline || a.scheduled_date || "";
    const db = b.shipping_date || b.date_deadline || b.scheduled_date || "";
    return da < db ? -1 : da > db ? 1 : 0;
  });

  return pickings;
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
