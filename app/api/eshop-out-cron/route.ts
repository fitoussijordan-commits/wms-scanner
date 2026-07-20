// app/api/eshop-out-cron/route.ts
// Cron quotidien — Automatise l'écran "E-shop → Sorties du jour" :
//   1) Charge les ventes Shopware des dernières 48h (marge de sécurité pour ne rater aucune commande)
//   2) Applique EXACTEMENT les mêmes règles que l'écran manuel (SortiesTab) :
//      - exclut les commandes déjà sorties (garde-fou wms_eshop_processed)
//      - exclut les commandes annulées (orderStatusId = -1)
//      - exclut les commandes non payées (paymentStatusId ≠ 12)
//      - exclut les réfs "chariot eshop" (gérées à part, stock décrémenté séparément)
//      - ignore les réfs non mappées vers un produit Odoo (elles resteront visibles
//        sur l'écran manuel pour correction humaine — le cron ne les invente pas)
//   3) Crée + confirme la commande Odoo (sale.order) → génère le bon de préparation (pick)
//   4) Valide automatiquement le pick puis le OUT dans Odoo (stock déduit)
//   5) Marque les commandes comme "sorties" (anti double-déduction) + décrémente le chariot
//
// Appel : GET ou POST /api/eshop-out-cron
//         Authorization: Bearer {CRON_SECRET}
//
// Sécurité : si une réf n'est pas mappée, ou si le client e-shop Odoo n'est pas configuré,
// ou si aucune ligne n'est éligible, le cron s'arrête proprement sans rien créer (log détaillé).

import { NextRequest, NextResponse } from "next/server";
import { fetchT } from "@/lib/fetchTimeout";
import {
  getEshopMappingOverrides, getEshopMappingCache, saveEshopMappingCache,
  getProcessedEshopOrders, markEshopOrdersProcessed, decrementChariotStock,
  saveCronRunStatus, getCronRunStatus,
} from "@/lib/supabase";

// ─── Config ─────────────────────────────────────────────────────────────────

const SW_URL = process.env.SHOPWARE_URL || "";
const SW_USER = process.env.SHOPWARE_USER || "";
const SW_KEY = process.env.SHOPWARE_API_KEY || "";

const ODOO_URL = process.env.ODOO_URL || "";
const ODOO_DB = process.env.ODOO_DB || "";
const ODOO_USER = process.env.ODOO_LOGIN || "";
const ODOO_PASS = process.env.ODOO_PASSWORD || "";

// Client e-shop Odoo (nom ou réf) — même mécanisme que l'écran manuel (localStorage
// remplacé ici par une variable d'env car le cron n'a pas de contexte navigateur).
const ESHOP_PARTNER = process.env.ESHOP_PARTNER_REF || "eSHOP";

// Combien d'heures en arrière on regarde (48h par défaut, demandé explicitement
// pour être sûr de ne rater aucune commande même en cas de run manqué/retard Shopware).
const LOOKBACK_HOURS = Number(process.env.ESHOP_CRON_LOOKBACK_HOURS || "48");

// ─── Helpers Shopware (API REST /api, Shopware 5) ──────────────────────────

async function swFetch(path: string): Promise<any> {
  const auth = Buffer.from(`${SW_USER}:${SW_KEY}`).toString("base64");
  const baseUrl = SW_URL.replace(/\/+$/, "").replace(/\/backend$/i, "");
  const res = await fetchT(`${baseUrl}/api${path}`, {
    headers: { Accept: "application/json", Authorization: `Basic ${auth}` },
    cache: "no-store",
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* réponse non-JSON */ }
  if (!res.ok) throw new Error(`Shopware ${res.status}: ${text.slice(0, 300)}`);
  return json;
}

interface SwLine { articleNumber: string | null; name: string; quantity: number; mode: number; }
interface SwOrder { id: number; number: string; orderStatusId: number; paymentStatusId: number; orderTime: string; lines: SwLine[]; }

async function getOrdersSince(startIso: string, endIso: string): Promise<SwOrder[]> {
  const q = `/orders?limit=200`
    + `&filter[0][property]=orderTime&filter[0][expression]=>=&filter[0][value]=${encodeURIComponent(startIso)}`
    + `&filter[1][property]=orderTime&filter[1][expression]=<=&filter[1][value]=${encodeURIComponent(endIso)}`
    + `&sort[0][property]=orderTime&sort[0][direction]=ASC`;
  const data = await swFetch(q);
  const list: any[] = data?.data || [];
  const orders: SwOrder[] = [];
  for (const o of list) {
    let details = o.details;
    if (!details) {
      const d = await swFetch(`/orders/${o.id}`);
      details = d?.data?.details || [];
    }
    orders.push({
      id: o.id, number: o.number, orderStatusId: o.orderStatusId, paymentStatusId: o.paymentStatusId,
      orderTime: o.orderTime,
      lines: (details || []).map((d: any) => ({
        articleNumber: d.articleNumber, name: d.articleName, quantity: d.quantity, mode: d.mode,
      })),
    });
  }
  return orders;
}

// ─── Helpers Odoo (JSON-RPC direct, sans contexte navigateur) ──────────────

interface OSess { uid: number; sessionId: string; }

async function odooRpc(endpoint: string, params: any, sessionId?: string): Promise<any> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (sessionId) headers["Cookie"] = `session_id=${sessionId}`;
  const res = await fetchT(`${ODOO_URL.replace(/\/$/, "")}${endpoint}`, {
    method: "POST", headers,
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", id: Date.now(), params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.data?.message || json.error.message || JSON.stringify(json.error));
  return json.result;
}

async function odooAuth(): Promise<OSess> {
  const res = await fetchT(`${ODOO_URL.replace(/\/$/, "")}/web/session/authenticate`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", id: 1, params: { db: ODOO_DB, login: ODOO_USER, password: ODOO_PASS } }),
  });
  const json = await res.json();
  if (!json.result?.uid) throw new Error("Authentification Odoo échouée");
  const setCookie = res.headers.get("set-cookie") || "";
  const sid = setCookie.match(/session_id=([^;]+)/)?.[1] || json.result.session_id || "";
  return { uid: json.result.uid, sessionId: sid };
}

async function odooCall(s: OSess, model: string, method: string, args: any[], kwargs: any = {}): Promise<any> {
  return odooRpc("/web/dataset/call_kw", { model, method, args, kwargs: { context: {}, ...kwargs } }, s.sessionId);
}
async function odooSearch(s: OSess, model: string, domain: any[], fields: string[], limit = 0, order = ""): Promise<any[]> {
  return odooCall(s, model, "search_read", [domain], { fields, limit: limit || 0, order });
}
async function odooCreate(s: OSess, model: string, vals: any): Promise<number> {
  return odooCall(s, model, "create", [vals]);
}
async function odooWrite(s: OSess, model: string, ids: number[], vals: any): Promise<void> {
  return odooCall(s, model, "write", [ids, vals]);
}

// ─── Chariot SKUs (exceptions — mêmes que l'écran manuel) ──────────────────

async function loadChariotSkus(s: OSess): Promise<Set<string>> {
  const atts = await odooSearch(s, "ir.attachment", [["name", "=", "eshop_chariot_skus.json"]], ["datas"], 1);
  if (!atts.length || !atts[0].datas) return new Set();
  const binary = Buffer.from(atts[0].datas, "base64").toString("utf-8");
  const skus: string[] = JSON.parse(binary);
  return new Set(skus.map((x: string) => x.toLowerCase()));
}

// ─── Client e-shop Odoo ─────────────────────────────────────────────────────

// Identique à findEshopPartner (lib/odoo.ts) : priorité nom exact+société > réf exacte+société
// > nom exact > id numérique > réf exacte (dernier recours, peut être ambigu).
async function findEshopPartner(s: OSess, idOrRef: string): Promise<{ id: number; name: string } | null> {
  const q = idOrRef.trim();
  const fields = ["id", "name"];
  let r = await odooSearch(s, "res.partner", [["name", "=", q], ["is_company", "=", true]], fields, 1);
  if (r.length) return { id: r[0].id, name: r[0].name };
  r = await odooSearch(s, "res.partner", [["ref", "=", q], ["is_company", "=", true]], fields, 1);
  if (r.length) return { id: r[0].id, name: r[0].name };
  r = await odooSearch(s, "res.partner", [["name", "=", q]], fields, 1);
  if (r.length) return { id: r[0].id, name: r[0].name };
  if (/^\d+$/.test(q)) {
    r = await odooSearch(s, "res.partner", [["id", "=", Number(q)]], fields, 1);
    if (r.length) return { id: r[0].id, name: r[0].name };
  }
  r = await odooSearch(s, "res.partner", [["ref", "=", q]], fields, 1);
  return r.length ? { id: r[0].id, name: r[0].name } : null;
}

// ─── Matching SKU → produit Odoo (réf fournisseur → réf interne → EAN), avec cache ──

interface Match { product_id: number; default_code: string; product_name: string; }

async function matchSkus(s: OSess, skus: string[]): Promise<Record<string, Match>> {
  const result: Record<string, Match> = {};
  if (!skus.length) return result;
  const remaining = new Set(skus);

  // 1) réf fournisseur
  const supplierInfos = await odooSearch(s, "product.supplierinfo", [["product_code", "in", skus]],
    ["product_code", "product_id", "product_tmpl_id"], skus.length * 3);
  const tmplIds: number[] = []; const tmplToSku: Record<number, string> = {};
  for (const si of supplierInfos) {
    const sku = si.product_code;
    if (!remaining.has(sku)) continue;
    if (si.product_id) {
      result[sku] = { product_id: si.product_id[0], product_name: si.product_id[1], default_code: "" };
      remaining.delete(sku);
    } else if (si.product_tmpl_id) {
      tmplIds.push(si.product_tmpl_id[0]); tmplToSku[si.product_tmpl_id[0]] = sku;
    }
  }
  if (tmplIds.length) {
    const variants = await odooSearch(s, "product.product", [["product_tmpl_id", "in", tmplIds]],
      ["id", "name", "product_tmpl_id", "default_code"], tmplIds.length * 3);
    for (const v of variants) {
      const tmplId = Array.isArray(v.product_tmpl_id) ? v.product_tmpl_id[0] : v.product_tmpl_id;
      const sku = tmplToSku[tmplId];
      if (sku && remaining.has(sku)) { result[sku] = { product_id: v.id, product_name: v.name, default_code: v.default_code || "" }; remaining.delete(sku); }
    }
  }
  // Enrichir default_code manquant
  const needsEnrich = Object.entries(result).filter(([, v]) => !v.default_code);
  if (needsEnrich.length) {
    const ids = needsEnrich.map(([, v]) => v.product_id);
    const prods = await odooSearch(s, "product.product", [["id", "in", ids]], ["id", "default_code", "name"], ids.length);
    const pMap: Record<number, any> = {}; for (const p of prods) pMap[p.id] = p;
    for (const [sku, v] of needsEnrich) { const p = pMap[v.product_id]; if (p) { result[sku].default_code = p.default_code || ""; result[sku].product_name = p.name; } }
  }
  if (!remaining.size) return result;

  // 2) réf interne Odoo (default_code)
  const remArr = Array.from(remaining);
  const byCode = await odooSearch(s, "product.product", [["default_code", "in", remArr]], ["id", "name", "default_code"], remArr.length);
  for (const p of byCode) { const sku = remArr.find(x => x === p.default_code); if (sku) { result[sku] = { product_id: p.id, product_name: p.name, default_code: p.default_code || "" }; remaining.delete(sku); } }
  if (!remaining.size) return result;

  // 3) EAN / barcode
  const remArr2 = Array.from(remaining);
  const byBarcode = await odooSearch(s, "product.product", [["barcode", "in", remArr2]], ["id", "name", "default_code", "barcode"], remArr2.length);
  for (const p of byBarcode) { const sku = remArr2.find(x => x === p.barcode); if (sku) { result[sku] = { product_id: p.id, product_name: p.name, default_code: p.default_code || "" }; remaining.delete(sku); } }

  return result;
}

// ─── Création + confirmation commande Odoo (identique à createEshopQuotation) ──

async function createQuotation(
  s: OSess, partnerId: number,
  lines: { productId: number; qty: number; name: string; orders: string }[],
  origin: string
): Promise<{ id: number; name: string }> {
  const grouped: Record<number, { productId: number; qty: number; name: string; orders: string }> = {};
  for (const l of lines) {
    if (grouped[l.productId]) { grouped[l.productId].qty += l.qty; grouped[l.productId].orders += ", " + l.orders; }
    else grouped[l.productId] = { ...l };
  }
  const vals: any = {
    partner_id: partnerId,
    origin,
    order_line: Object.values(grouped).map(l => [0, 0, {
      product_id: l.productId, product_uom_qty: l.qty,
      name: `${l.name}\nCommandes : ${l.orders}`.trim(),
    }]),
  };
  try {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    vals.commitment_date = `${today} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  } catch {}
  // Étiquettes de traçabilité (mêmes que l'écran manuel)
  try {
    const findOrCreateTag = async (name: string): Promise<number | null> => {
      const t = await odooSearch(s, "crm.tag", [["name", "=", name]], ["id"], 1);
      if (t.length) return t[0].id;
      return await odooCreate(s, "crm.tag", { name });
    };
    const tagIds = (await Promise.all([findOrCreateTag("import eShop"), findOrCreateTag("Transmise"), findOrCreateTag("Auto (cron)")]))
      .filter((x): x is number => typeof x === "number");
    if (tagIds.length) vals.tag_ids = [[6, 0, tagIds]];
  } catch {}

  const id = await odooCreate(s, "sale.order", vals);
  try { await odooCall(s, "sale.order", "action_confirm", [[id]]); } catch { /* reste en devis si échec — non bloquant */ }
  const rec = await odooSearch(s, "sale.order", [["id", "=", id]], ["id", "name"], 1);
  return { id, name: rec[0]?.name || String(id) };
}

// ─── Validation strict pick + out (identique à validateOrderPickings) ─────

async function validateOrderPickings(s: OSess, orderId: number): Promise<{ validated: string[]; failed: { name: string; error: string }[] }> {
  const out: { validated: string[]; failed: { name: string; error: string }[] } = { validated: [], failed: [] };
  const picks = await odooSearch(s, "stock.picking", [["sale_id", "=", orderId], ["state", "not in", ["done", "cancel"]]],
    ["id", "name", "picking_type_code", "state"], 20);
  if (!picks.length) return out;
  const rank = (c: string) => (c === "internal" ? 0 : c === "outgoing" ? 2 : 1);
  picks.sort((a: any, b: any) => rank(a.picking_type_code) - rank(b.picking_type_code));

  for (const p of picks) {
    try {
      try { await odooCall(s, "stock.picking", "action_assign", [[p.id]]); } catch {}
      const mls = await odooSearch(s, "stock.move.line", [["picking_id", "=", p.id], ["state", "not in", ["done", "cancel"]]],
        ["id", "reserved_uom_qty", "qty_done"], 500);
      for (const ml of mls) {
        const want = ml.reserved_uom_qty || 0;
        if (want > 0 && (ml.qty_done || 0) < want) {
          try { await odooWrite(s, "stock.move.line", [ml.id], { qty_done: want }); } catch {}
        }
      }
      // Validation stricte : si Odoo réclame un reliquat (stock insuffisant), on lève une erreur.
      const res = await odooCall(s, "stock.picking", "button_validate", [[p.id]]);
      if (res && typeof res === "object" && res.res_model) {
        const wModel = res.res_model, wId = res.res_id, ctx = res.context || {};
        if (wModel === "stock.backorder.confirmation") {
          throw new Error("Stock insuffisant (reliquat demandé) — non validé automatiquement");
        } else if (wModel === "stock.immediate.transfer") {
          await odooCall(s, "stock.immediate.transfer", "process", [[wId]], { context: ctx });
        } else {
          throw new Error(`Wizard inattendu (${wModel}) — non validé automatiquement`);
        }
      }
      out.validated.push(p.name);
    } catch (e: any) {
      out.failed.push({ name: p.name, error: e?.message || "erreur" });
      break; // on n'enchaîne pas le OUT si le pick a échoué
    }
  }
  return out;
}

// ─── Route principale ────────────────────────────────────────────────────

async function runCron(): Promise<any> {
  const log: string[] = [];
  const L = (s: string) => { console.log(s); log.push(s); };

  if (!SW_URL || !SW_KEY) throw new Error("Shopware non configuré (SHOPWARE_URL / SHOPWARE_API_KEY)");
  if (!ODOO_URL || !ODOO_DB || !ODOO_USER || !ODOO_PASS) throw new Error("Odoo non configuré (ODOO_URL / ODOO_DB / ODOO_LOGIN / ODOO_PASSWORD)");

  const end = new Date();
  const start = new Date(end.getTime() - LOOKBACK_HOURS * 3600 * 1000);
  // Shopware stocke/compare orderTime en heure LOCALE (Europe/Paris), pas en UTC.
  // Le serveur (Vercel) tourne en UTC → il faut convertir les bornes en heure Paris
  // avant de les envoyer, sinon le filtre coupe 1-2h trop tôt (été/hiver) et rate
  // les commandes les plus récentes.
  const fmt = (d: Date) => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Paris",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    }).formatToParts(d);
    const get = (t: string) => parts.find(p => p.type === t)?.value || "00";
    return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
  };
  L(`[cron] Fenêtre (heure Paris) : ${fmt(start)} → ${fmt(end)} (lookback ${LOOKBACK_HOURS}h)`);

  L(`[cron] Auth Odoo…`);
  const s = await odooAuth();
  L(`[cron] Odoo OK (uid=${s.uid})`);

  L(`[cron] Récupération ventes Shopware…`);
  const orders = await getOrdersSince(fmt(start), fmt(end));
  L(`[cron] ${orders.length} commande(s) trouvée(s) sur la fenêtre`);
  if (!orders.length) return { ok: true, message: "Aucune commande sur la fenêtre", log };

  const orderNumbers = orders.map(o => o.number).filter(Boolean);
  const processed = await getProcessedEshopOrders(orderNumbers);
  const chariot = await loadChariotSkus(s);
  const overrides = await getEshopMappingOverrides();
  const cache = await getEshopMappingCache();

  // Diagnostic détaillé par commande : pourquoi une commande précise est exclue.
  const diag = orders.map(o => ({
    number: o.number, orderStatusId: o.orderStatusId, paymentStatusId: o.paymentStatusId, orderTime: o.orderTime,
    alreadyProcessed: processed.has(o.number),
    excludedReason: processed.has(o.number) ? "déjà sortie"
      : String(o.orderStatusId) === "-1" ? "annulée"
      : String(o.paymentStatusId) !== "12" ? `paiement ≠12 (${o.paymentStatusId})`
      : null,
  }));

  // Mêmes règles EXACTES que SortiesTab.deductAgg :
  // exclut déjà-sorties, annulées, non-payées(≠12), chariot, non-mappées.
  const eligible = orders.filter(o => !processed.has(o.number) && String(o.orderStatusId) !== "-1" && String(o.paymentStatusId) === "12");
  L(`[cron] ${eligible.length} commande(s) éligible(s) (payées, non annulées, non déjà sorties)`);
  if (!eligible.length) return { ok: true, message: "Aucune commande éligible", log, scanned: orders.length, diag };

  // Collecte des refs à matcher (hors chariot, hors mode≠0)
  const refsNeeded = new Set<string>();
  for (const o of eligible) for (const l of o.lines) {
    if (l.mode !== 0 || !l.articleNumber) continue;
    if (chariot.has(l.articleNumber.trim().toLowerCase())) continue;
    if (overrides[l.articleNumber] || cache[l.articleNumber]) continue;
    refsNeeded.add(l.articleNumber);
  }
  let fresh: Record<string, Match> = {};
  if (refsNeeded.size) {
    fresh = await matchSkus(s, Array.from(refsNeeded));
    const newCache = { ...cache };
    for (const [ref, m] of Object.entries(fresh)) newCache[ref] = { product_id: m.product_id, default_code: m.default_code, product_name: m.product_name };
    try { await saveEshopMappingCache(newCache); } catch {}
  }
  const effMatch = (ref: string): Match | null => {
    if (overrides[ref]) return { product_id: overrides[ref].productId, default_code: overrides[ref].odooRef, product_name: overrides[ref].productName };
    if (cache[ref]) return cache[ref] as any;
    if (fresh[ref]) return fresh[ref];
    return null;
  };

  // Agrégation des lignes à déduire + chariot (identique à SortiesTab)
  const deductAgg: Record<string, { productId: number; qty: number; name: string; cmds: string[] }> = {};
  const chariotAgg: Record<string, number> = {};
  const unmapped = new Set<string>();
  const includedOrderNumbers: string[] = [];

  for (const o of eligible) {
    includedOrderNumbers.push(o.number);
    for (const l of o.lines) {
      if (l.mode !== 0 || !l.articleNumber) continue;
      const ref = l.articleNumber;
      if (chariot.has(ref.trim().toLowerCase())) {
        chariotAgg[ref] = (chariotAgg[ref] || 0) + l.quantity;
        continue;
      }
      const m = effMatch(ref);
      if (!m || !m.product_id) { unmapped.add(ref); continue; }
      if (!deductAgg[ref]) deductAgg[ref] = { productId: m.product_id, qty: 0, name: l.name, cmds: [] };
      deductAgg[ref].qty += l.quantity;
      deductAgg[ref].cmds.push(`${o.number}${l.quantity > 1 ? ` ×${l.quantity}` : ""}`);
    }
  }

  if (unmapped.size) L(`[cron] ⚠ ${unmapped.size} réf(s) non mappée(s), ignorée(s) : ${Array.from(unmapped).join(", ")}`);

  const toDeduct = Object.entries(deductAgg).map(([ref, v]) => ({ ref, ...v }));
  const chariotDeductions = Object.entries(chariotAgg).map(([sku, qty]) => ({ sku, qty }));

  if (!toDeduct.length && !chariotDeductions.length) {
    return { ok: true, message: "Aucune ligne mappée à déduire", log, scanned: orders.length, eligible: eligible.length, unmapped: Array.from(unmapped) };
  }

  let quotation: { id: number; name: string } | null = null;
  if (toDeduct.length) {
    L(`[cron] Résolution client e-shop (${ESHOP_PARTNER})…`);
    const partner = await findEshopPartner(s, ESHOP_PARTNER);
    if (!partner) throw new Error(`Client e-shop Odoo introuvable (ESHOP_PARTNER_REF="${ESHOP_PARTNER}")`);

    const origin = `E-shop AUTO ${fmt(start).slice(0, 10)}→${fmt(end).slice(0, 10)}`;
    L(`[cron] Création commande Odoo : ${toDeduct.length} ligne(s), client=${partner.name}…`);
    quotation = await createQuotation(s, partner.id,
      toDeduct.map(a => ({ productId: a.productId, qty: a.qty, name: a.name, orders: a.cmds.join(", ") })),
      origin);
    L(`[cron] ✅ Commande créée : ${quotation.name}`);
  }

  // Garde-fou : marque les commandes réellement incluses comme sorties (source = cron)
  try {
    await markEshopOrdersProcessed(includedOrderNumbers, quotation ? quotation.name : "chariot", "cron");
    L(`[cron] ${includedOrderNumbers.length} commande(s) marquée(s) comme sortie(s)`);
  } catch (e: any) { L(`[cron] ⚠ Erreur marquage garde-fou : ${e.message}`); }

  let validation: { validated: string[]; failed: { name: string; error: string }[] } | null = null;
  if (quotation) {
    L(`[cron] Validation automatique pick + OUT…`);
    try {
      validation = await validateOrderPickings(s, quotation.id);
      if (validation.validated.length) L(`[cron] ✅ Validé : ${validation.validated.join(", ")}`);
      if (validation.failed.length) L(`[cron] ⚠ Échec validation : ${validation.failed.map(f => `${f.name} (${f.error})`).join(" · ")}`);
    } catch (e: any) { L(`[cron] ⚠ Erreur validation : ${e.message}`); }
  }

  if (chariotDeductions.length) {
    try {
      const { shortages } = await decrementChariotStock(chariotDeductions);
      if (shortages.length) L(`[cron] ⚠ Chariot insuffisant : ${shortages.map(sh => `${sh.sku} (demandé ${sh.demande}, dispo ${sh.dispo})`).join(" · ")}`);
      else L(`[cron] ✅ Chariot mis à jour (${chariotDeductions.length} réf)`);
    } catch (e: any) { L(`[cron] ⚠ Erreur MAJ chariot : ${e.message}`); }
  }

  return {
    ok: true,
    scanned: orders.length,
    eligible: eligible.length,
    quotation: quotation ? quotation.name : null,
    lines: toDeduct.length,
    unmapped: Array.from(unmapped),
    validation,
    chariot: chariotDeductions,
    orderNumbers: includedOrderNumbers,
    log,
  };
}

function checkAuth(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET || "";
  if (!cronSecret) return false;
  const authHeader = req.headers.get("authorization") || "";
  return authHeader === `Bearer ${cronSecret}`;
}

// Résumé humain court pour le statut de run (affiché dans l'app sans avoir à lire les logs).
function summarize(result: any): string {
  if (result.message) return result.message;
  const parts: string[] = [];
  if (result.quotation) parts.push(`commande ${result.quotation}`);
  if (result.lines) parts.push(`${result.lines} réf déduite(s)`);
  if (result.chariot?.length) parts.push(`${result.chariot.length} réf chariot`);
  if (result.validation?.failed?.length) parts.push(`⚠ validation échouée : ${result.validation.failed.map((f: any) => f.name).join(", ")}`);
  if (result.unmapped?.length) parts.push(`⚠ ${result.unmapped.length} non mappée(s)`);
  return parts.length ? parts.join(" · ") : `${result.scanned ?? 0} commande(s) scannée(s), rien à faire`;
}

async function runCronAndTrack(): Promise<any> {
  try {
    const result = await runCron();
    try { await saveCronRunStatus({ ranAt: new Date().toISOString(), ok: true, summary: summarize(result) }); } catch {}
    return result;
  } catch (e: any) {
    try { await saveCronRunStatus({ ranAt: new Date().toISOString(), ok: false, summary: "Échec du run", error: e.message }); } catch {}
    throw e;
  }
}

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: "Non autorisé" }, { status: 401 });
  try {
    const result = await runCronAndTrack();
    return NextResponse.json(result);
  } catch (e: any) {
    console.error("[eshop-out-cron] Erreur:", e);
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}

// GET — appelé par Vercel Cron (Authorization géré par Vercel), ou ?status=1 pour
// consulter le dernier run sans en déclencher un nouveau, ou ping informatif sans auth.
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);

  if (searchParams.get("status") === "1") {
    const last = await getCronRunStatus();
    return NextResponse.json({ route: "eshop-out-cron", lastRun: last });
  }

  if (checkAuth(req)) {
    try {
      const result = await runCronAndTrack();
      return NextResponse.json(result);
    } catch (e: any) {
      console.error("[eshop-out-cron] Erreur:", e);
      return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
    }
  }
  const cronSecret = process.env.CRON_SECRET || "";
  const last = await getCronRunStatus().catch(() => null);
  return NextResponse.json({
    route: "eshop-out-cron",
    description: "GET/POST avec Authorization: Bearer {CRON_SECRET} pour déclencher. GET ?status=1 pour voir le dernier run. Reproduit l'écran E-shop → Sorties (mapping, garde-fou anti-doublon, création + validation commande Odoo).",
    lookbackHours: LOOKBACK_HOURS,
    partnerRef: ESHOP_PARTNER,
    lastRun: last,
    env: {
      shopware_url: SW_URL ? "✓" : "⚠️ SHOPWARE_URL manquant",
      shopware_key: SW_KEY ? "✓" : "⚠️ SHOPWARE_API_KEY manquant",
      odoo_url: ODOO_URL ? "✓" : "⚠️ ODOO_URL manquant",
      odoo_db: ODOO_DB ? "✓" : "⚠️ ODOO_DB manquant",
      odoo_user: ODOO_USER ? "✓" : "⚠️ ODOO_LOGIN manquant",
      odoo_pass: ODOO_PASS ? "✓" : "⚠️ ODOO_PASSWORD manquant",
      cron_secret: cronSecret ? "✓" : "⚠️ CRON_SECRET manquant",
      eshop_partner_ref: ESHOP_PARTNER,
    },
  });
}
