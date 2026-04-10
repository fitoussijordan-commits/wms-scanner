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

  const prodLocMap: Record<number, { location_id: number; location_name: string; quantity: number }> = {};
  for (const q of quants) {
    const pid = q.product_id[0];
    if (!prodLocMap[pid] || q.quantity > prodLocMap[pid].quantity) {
      prodLocMap[pid] = { location_id: q.location_id[0], location_name: q.location_id[1], quantity: q.quantity };
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
