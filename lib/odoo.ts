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

  // Read move lines — include reserved_uom_qty so we set the correct portion per line
  // (Odoo may split one product across multiple move lines when stock is in different locations)
  const moveLines = await searchRead(session, "stock.move.line",
    [["picking_id", "=", pickingId]],
    ["id", "product_id", "lot_id", "qty_done", "reserved_uom_qty"]
  );

  // Write qty_done per line using reserved_uom_qty (not the full requested qty)
  // so that when Odoo splits a product across multiple lines each gets its own portion
  for (const ml of moveLines) {
    const matchingLine = lines.find(l => l.productId === ml.product_id[0]);
    if (matchingLine) {
      const lineQty = (ml.reserved_uom_qty as number) || 0;
      const updates: any = { qty_done: lineQty > 0 ? lineQty : matchingLine.qty };
      // Only set lot if the user specified one and Odoo hasn't already assigned one
      if (matchingLine.lotId && !ml.lot_id) updates.lot_id = matchingLine.lotId;
      await write(session, "stock.move.line", [ml.id], updates);
    }
  }

  return pickingId;
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
  lines: WalaPOLine[]
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

  const poId = await create(session, "purchase.order", {
    partner_id: partnerId,
    order_line: groupedLines.map(l => [0, 0, {
      product_id: l.productId,
      product_qty: l.qty,
      price_unit: l.price || 0,
      name: l.name,
      date_planned: today,
      product_uom: l.uomId,
    }]),
  });

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
      // On affecte uniquement le lot — pas qty_done pour éviter la validation automatique
      await write(session, "stock.move.line", [ml.id], {
        lot_id: line.lotId,
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
        location_id: locationId,
        location_dest_id: locationDestId,
      });
    }
  }
}

// validatePicking est déjà défini plus haut dans ce fichier (ligne ~710) — on réutilise l'existant.
