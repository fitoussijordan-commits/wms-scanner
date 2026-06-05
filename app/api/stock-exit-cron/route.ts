// app/api/stock-exit-cron/route.ts
// Cron 22h — Déduit du stock Odoo toutes les commandes Shopware préparées dans la journée
// (status "Ready for delivery" = orderStatusId 5)
// Exclut les articles "chariot eshop" (stockés dans Odoo ir.attachment)
//
// Appel : POST /api/stock-exit-cron
//         Authorization: Bearer {CRON_SECRET}

import { NextRequest, NextResponse } from "next/server";
import { fetchT } from "@/lib/fetchTimeout";

// ─── Config ─────────────────────────────────────────────────────────────────

const SW_URL   = process.env.SHOPWARE_URL    || "";
const SW_USER  = process.env.SHOPWARE_USER   || "";
const SW_KEY   = process.env.SHOPWARE_API_KEY || "";

const ODOO_URL  = process.env.ODOO_URL  || "";
const ODOO_DB   = process.env.ODOO_DB   || "";
const ODOO_USER = process.env.ODOO_LOGIN || "";
const ODOO_PASS = process.env.ODOO_PASSWORD || "";

// Statuts Shopware correspondant aux commandes préparées (Ready for delivery)
const PREPARED_STATUS_IDS = [5];

// ─── Helpers Shopware ───────────────────────────────────────────────────────

async function swFetch(path: string): Promise<any> {
  const auth = Buffer.from(`${SW_USER}:${SW_KEY}`).toString("base64");
  const res = await fetchT(`${SW_URL.replace(/\/$/, "")}/api/v1${path}`, {
    headers: { Accept: "application/json", Authorization: `Basic ${auth}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Shopware ${res.status}: ${path}`);
  return res.json();
}

// Récupère toutes les commandes d'un jour (YYYY-MM-DD) avec un des statuts donnés
async function getShopwareOrdersForDay(date: string): Promise<any[]> {
  const allOrders: any[] = [];
  let page = 1;
  const limit = 100;

  while (true) {
    const qs = new URLSearchParams({
      limit: String(limit),
      start: String((page - 1) * limit),
      "sort[0][property]": "orderTime",
      "sort[0][direction]": "DESC",
      "filter[0][property]": "orderTime",
      "filter[0][expression]": "LIKE",
      "filter[0][value]": `${date}%`,
    });

    const data = await swFetch(`/orders?${qs}`);
    const orders: any[] = data.data || [];
    if (!orders.length) break;

    // Garde uniquement les commandes avec un statut "préparée"
    const prepared = orders.filter((o: any) =>
      PREPARED_STATUS_IDS.includes(o.orderStatusId)
    );
    allOrders.push(...prepared);

    if (orders.length < limit) break; // dernière page
    page++;
  }

  return allOrders;
}

// Récupère le détail complet d'une commande (lignes incluses)
async function getShopwareOrderDetail(orderId: number): Promise<any> {
  const data = await swFetch(`/orders/${orderId}`);
  return data.data || null;
}

// ─── Helpers Odoo (direct JSON-RPC, sans passer par le proxy client) ────────

interface OdooSession { uid: number; sessionId: string; }

async function odooRpc(endpoint: string, params: any, sessionId?: string): Promise<any> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (sessionId) headers["Cookie"] = `session_id=${sessionId}`;

  const res = await fetchT(`${ODOO_URL.replace(/\/$/, "")}${endpoint}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", id: Date.now(), params }),
  });

  const json = await res.json();
  if (json.error) throw new Error(json.error.data?.message || json.error.message || JSON.stringify(json.error));
  return json.result;
}

async function odooAuth(): Promise<OdooSession> {
  const res = await fetchT(`${ODOO_URL.replace(/\/$/, "")}/web/session/authenticate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", method: "call", id: 1,
      params: { db: ODOO_DB, login: ODOO_USER, password: ODOO_PASS },
    }),
  });
  const json = await res.json();
  if (!json.result?.uid) throw new Error("Authentification Odoo échouée");
  const setCookie = res.headers.get("set-cookie") || "";
  const sid = setCookie.match(/session_id=([^;]+)/)?.[1] || json.result.session_id || "";
  return { uid: json.result.uid, sessionId: sid };
}

async function odooCall(sess: OdooSession, model: string, method: string, args: any[], kwargs: any = {}): Promise<any> {
  return odooRpc("/web/dataset/call_kw", {
    model, method, args, kwargs: { context: {}, ...kwargs },
  }, sess.sessionId);
}

async function odooSearch(sess: OdooSession, model: string, domain: any[], fields: string[], limit = 0): Promise<any[]> {
  return odooCall(sess, model, "search_read", [domain], { fields, limit: limit || 0 });
}

async function odooCreate(sess: OdooSession, model: string, vals: any): Promise<number> {
  return odooCall(sess, model, "create", [vals]);
}

async function odooWrite(sess: OdooSession, model: string, ids: number[], vals: any): Promise<void> {
  return odooCall(sess, model, "write", [ids, vals]);
}

// ─── Chariot SKUs (exceptions) ──────────────────────────────────────────────

async function loadChariotSkus(sess: OdooSession): Promise<Set<string>> {
  const atts = await odooSearch(
    sess, "ir.attachment",
    [["name", "=", "eshop_chariot_skus.json"]],
    ["datas"], 1
  );
  if (!atts.length || !atts[0].datas) return new Set();
  const binary = Buffer.from(atts[0].datas, "base64").toString("utf-8");
  const skus: string[] = JSON.parse(binary);
  return new Set(skus.map((s: string) => s.toLowerCase()));
}

// ─── Matching SKU → product Odoo ────────────────────────────────────────────

interface OdooProduct {
  product_id: number;
  product_name: string;
  uom_id: number;
}

async function matchSkusToOdoo(
  sess: OdooSession,
  skus: string[]
): Promise<Record<string, OdooProduct>> {
  const result: Record<string, OdooProduct> = {};
  const remaining = new Set(skus);

  // 1. Référence fournisseur → product.supplierinfo.product_code
  const supplierInfos = await odooSearch(
    sess, "product.supplierinfo",
    [["product_code", "in", skus]],
    ["id", "product_code", "product_id", "product_tmpl_id"],
    skus.length * 3
  );

  const tmplIds: number[] = [];
  const tmplToSku: Record<number, string> = {};

  for (const si of supplierInfos) {
    const sku = si.product_code as string;
    if (!remaining.has(sku)) continue;

    if (si.product_id) {
      const prodId = Array.isArray(si.product_id) ? si.product_id[0] : si.product_id;
      result[sku] = { product_id: prodId, product_name: Array.isArray(si.product_id) ? si.product_id[1] : "", uom_id: 1 };
      remaining.delete(sku);
    } else if (si.product_tmpl_id) {
      const tmplId = Array.isArray(si.product_tmpl_id) ? si.product_tmpl_id[0] : si.product_tmpl_id;
      tmplIds.push(tmplId);
      tmplToSku[tmplId] = sku;
    }
  }

  // Résoudre templates → product.product
  if (tmplIds.length) {
    const variants = await odooSearch(
      sess, "product.product",
      [["product_tmpl_id", "in", tmplIds]],
      ["id", "name", "product_tmpl_id", "uom_id"],
      tmplIds.length * 3
    );
    for (const v of variants) {
      const tmplId = Array.isArray(v.product_tmpl_id) ? v.product_tmpl_id[0] : v.product_tmpl_id;
      const sku = tmplToSku[tmplId];
      if (sku && remaining.has(sku)) {
        result[sku] = {
          product_id: v.id,
          product_name: v.name,
          uom_id: Array.isArray(v.uom_id) ? v.uom_id[0] : (v.uom_id || 1),
        };
        remaining.delete(sku);
      }
    }
  }

  // 2. EAN / barcode — fallback
  if (remaining.size) {
    const byBarcode = await odooSearch(
      sess, "product.product",
      [["barcode", "in", Array.from(remaining)]],
      ["id", "name", "barcode", "uom_id"],
      remaining.size
    );
    for (const p of byBarcode) {
      const sku = p.barcode as string;
      if (remaining.has(sku)) {
        result[sku] = {
          product_id: p.id,
          product_name: p.name,
          uom_id: Array.isArray(p.uom_id) ? p.uom_id[0] : (p.uom_id || 1),
        };
        remaining.delete(sku);
      }
    }
  }

  // Enrichir uom_id pour les matchés via supplierinfo (sans uom encore)
  const needsUom = Object.entries(result).filter(([, v]) => v.uom_id === 1);
  if (needsUom.length) {
    const prodIds = needsUom.map(([, v]) => v.product_id);
    const prods = await odooSearch(sess, "product.product", [["id", "in", prodIds]], ["id", "uom_id"], prodIds.length);
    const uomById: Record<number, number> = {};
    for (const p of prods) uomById[p.id] = Array.isArray(p.uom_id) ? p.uom_id[0] : (p.uom_id || 1);
    for (const [, v] of needsUom) v.uom_id = uomById[v.product_id] || 1;
  }

  return result;
}

// ─── Créer + valider un picking OUT dans Odoo ───────────────────────────────

async function createAndValidateDelivery(
  sess: OdooSession,
  lines: { productId: number; productName: string; qty: number; uomId: number }[],
  origin: string
): Promise<number> {
  // Trouver le picking type "outgoing"
  const ptypes = await odooSearch(
    sess, "stock.picking.type",
    [["code", "=", "outgoing"], ["active", "=", true]],
    ["id", "default_location_src_id", "default_location_dest_id", "warehouse_id"],
    1
  );
  if (!ptypes.length) throw new Error("Aucun type d'opération de sortie trouvé dans Odoo");

  const ptype = ptypes[0];
  const srcLocId = Array.isArray(ptype.default_location_src_id) ? ptype.default_location_src_id[0] : ptype.default_location_src_id;
  const dstLocId = Array.isArray(ptype.default_location_dest_id) ? ptype.default_location_dest_id[0] : ptype.default_location_dest_id;

  // Créer le picking
  const pickingId: number = await odooCreate(sess, "stock.picking", {
    picking_type_id: ptype.id,
    location_id: srcLocId,
    location_dest_id: dstLocId,
    origin,
    move_ids_without_package: lines.map((l) => [0, 0, {
      name: l.productName,
      product_id: l.productId,
      product_uom_qty: l.qty,
      product_uom: l.uomId,
      location_id: srcLocId,
      location_dest_id: dstLocId,
    }]),
  });

  // Confirmer + réserver
  await odooCall(sess, "stock.picking", "action_confirm", [[pickingId]]);
  await odooCall(sess, "stock.picking", "action_assign",  [[pickingId]]);

  // Lire les move lines et mettre qty_done
  const moveLines = await odooSearch(
    sess, "stock.move.line",
    [["picking_id", "=", pickingId]],
    ["id", "product_id", "reserved_uom_qty"]
  );
  for (const ml of moveLines) {
    const prodId = Array.isArray(ml.product_id) ? ml.product_id[0] : ml.product_id;
    const line = lines.find((l) => l.productId === prodId);
    if (!line) continue;
    const reserved = (ml.reserved_uom_qty as number) || 0;
    await odooWrite(sess, "stock.move.line", [ml.id], {
      qty_done: reserved > 0 ? reserved : line.qty,
    });
  }

  // Valider — gérer les wizards éventuels
  const validateResult = await odooCall(sess, "stock.picking", "button_validate", [[pickingId]]);
  if (validateResult && typeof validateResult === "object" && validateResult.res_model) {
    const wModel = validateResult.res_model;
    const wId    = validateResult.res_id;
    const ctx    = validateResult.context || {};
    if (wModel === "stock.immediate.transfer") {
      await odooCall(sess, "stock.immediate.transfer", "process", [[wId]], { context: ctx });
    } else if (wModel === "stock.backorder.confirmation") {
      await odooCall(sess, "stock.backorder.confirmation", "process", [[wId]], { context: ctx });
    }
  }

  return pickingId;
}

// ─── Route principale ────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // Vérification Bearer token
  const authHeader = req.headers.get("authorization") || "";
  const cronSecret = process.env.CRON_SECRET || "";
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Non autorisé" }, { status: 401 });
  }

  // Date à traiter (par défaut aujourd'hui, peut être forcée via query ?date=YYYY-MM-DD)
  const { searchParams } = new URL(req.url);
  const dateParam = searchParams.get("date");
  const today = dateParam || new Date().toISOString().slice(0, 10);

  const log: string[] = [];
  const logLine = (s: string) => { console.log(s); log.push(s); };

  try {
    // 1. Auth Odoo
    logLine(`[cron] Authentification Odoo...`);
    const sess = await odooAuth();
    logLine(`[cron] Odoo uid=${sess.uid}`);

    // 2. Chariot SKUs (exceptions)
    logLine(`[cron] Chargement chariot SKUs...`);
    const chariotSkus = await loadChariotSkus(sess);
    logLine(`[cron] ${chariotSkus.size} SKUs exclus (chariot)`);

    // 3. Commandes Shopware préparées aujourd'hui
    logLine(`[cron] Récupération commandes Shopware du ${today}...`);
    const orders = await getShopwareOrdersForDay(today);
    logLine(`[cron] ${orders.length} commande(s) préparée(s) trouvée(s)`);

    if (!orders.length) {
      return NextResponse.json({ ok: true, date: today, orders: 0, message: "Aucune commande préparée aujourd'hui", log });
    }

    // 4. Consolider les quantités par SKU (en excluant le chariot)
    const qtyBySku: Record<string, number> = {};
    const orderNumbers: string[] = [];
    let skippedChariot = 0;
    let skippedZeroQty = 0;

    for (const order of orders) {
      logLine(`[cron] Traitement commande ${order.number} (id=${order.id})`);
      orderNumbers.push(order.number);

      let detail: any;
      try {
        detail = await getShopwareOrderDetail(order.id);
      } catch (e: any) {
        logLine(`[cron] ⚠️ Impossible de lire le détail de la commande ${order.id}: ${e.message}`);
        continue;
      }

      const lines: any[] = detail?.details || [];
      for (const line of lines) {
        const sku: string = (line.articleNumber || "").trim();
        const qty: number = Number(line.quantity) || 0;

        if (!sku || qty <= 0) { skippedZeroQty++; continue; }
        if (chariotSkus.has(sku.toLowerCase())) {
          logLine(`[cron] ⏭ Chariot exclu: ${sku}`);
          skippedChariot++;
          continue;
        }

        qtyBySku[sku] = (qtyBySku[sku] || 0) + qty;
      }
    }

    const skus = Object.keys(qtyBySku);
    logLine(`[cron] ${skus.length} SKU(s) distincts à déduire (${skippedChariot} exclus chariot)`);

    if (!skus.length) {
      return NextResponse.json({
        ok: true, date: today, orders: orders.length,
        message: "Tous les articles sont sur le chariot eshop — aucune déduction à faire",
        skippedChariot, log,
      });
    }

    // 5. Matching SKU → Odoo
    logLine(`[cron] Matching ${skus.length} SKUs vers Odoo...`);
    const matched = await matchSkusToOdoo(sess, skus);
    const unmatched = skus.filter((s) => !matched[s]);
    logLine(`[cron] ${Object.keys(matched).length} matchés, ${unmatched.length} non trouvés`);
    if (unmatched.length) logLine(`[cron] Non matchés: ${unmatched.join(", ")}`);

    // 6. Construire les lignes pour Odoo
    const pickingLines = Object.entries(matched)
      .filter(([sku]) => qtyBySku[sku] > 0)
      .map(([sku, prod]) => ({
        productId: prod.product_id,
        productName: prod.product_name,
        qty: qtyBySku[sku],
        uomId: prod.uom_id,
      }));

    if (!pickingLines.length) {
      return NextResponse.json({
        ok: false, date: today, orders: orders.length,
        message: "Aucun produit trouvé dans Odoo", unmatched, log,
      });
    }

    // 7. Créer + valider le picking Odoo
    const origin = `ESHOP-${today} (${orders.length} cmd: ${orderNumbers.slice(0, 5).join(", ")}${orderNumbers.length > 5 ? "…" : ""})`;
    logLine(`[cron] Création picking Odoo: ${pickingLines.length} lignes, origine="${origin}"`);
    const pickingId = await createAndValidateDelivery(sess, pickingLines, origin);
    logLine(`[cron] ✅ Picking validé: id=${pickingId}`);

    return NextResponse.json({
      ok: true,
      date: today,
      picking_id: pickingId,
      orders_count: orders.length,
      order_numbers: orderNumbers,
      lines_count: pickingLines.length,
      skipped_chariot: skippedChariot,
      unmatched_skus: unmatched,
      log,
    });

  } catch (e: any) {
    console.error("[cron] Erreur:", e);
    return NextResponse.json({ ok: false, error: e.message, log }, { status: 500 });
  }
}

// GET — appelé par Vercel Cron (avec Authorization) ou en ping simple (sans auth)
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization") || "";
  const cronSecret = process.env.CRON_SECRET || "";

  // Si appelé par Vercel Cron (bearer valide) → exécuter la logique
  if (cronSecret && authHeader === `Bearer ${cronSecret}`) {
    return POST(req);
  }

  // Sinon → ping informatif
  return NextResponse.json({
    route: "stock-exit-cron",
    schedule: "0 20 * * * (UTC) = 22h00 heure française (CEST)",
    description: "GET/POST avec Authorization: Bearer {CRON_SECRET} pour déclencher manuellement",
    env: {
      shopware_url: SW_URL ? "✓" : "⚠️ SHOPWARE_URL manquant",
      shopware_user: SW_USER ? "✓" : "⚠️ SHOPWARE_USER manquant",
      shopware_key: SW_KEY ? "✓" : "⚠️ SHOPWARE_API_KEY manquant",
      odoo_url: ODOO_URL ? "✓" : "⚠️ ODOO_URL manquant",
      odoo_db: ODOO_DB ? "✓" : "⚠️ ODOO_DB manquant",
      odoo_user: ODOO_USER ? "✓" : "⚠️ ODOO_LOGIN manquant",
      odoo_pass: ODOO_PASS ? "✓" : "⚠️ ODOO_PASSWORD manquant",
      cron_secret: cronSecret ? "✓" : "⚠️ CRON_SECRET manquant",
    },
  });
}
