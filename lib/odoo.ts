// lib/odoo.ts
import { F, M } from "@/lib/fieldMap";
import * as compat from "./odooCompat";

export interface OdooConfig { url: string; db: string; }
export interface OdooSession { uid: number; name: string; login: string; sessionId: string; config: OdooConfig; }

// Comptes avec accès aux fonctions admin du WMS
const ADMIN_LOGINS = ["j.fitoussi@drhauschka.fr"];
export function isAdmin(session: OdooSession): boolean {
  return ADMIN_LOGINS.includes(session.login?.toLowerCase());
}

// Suggestions clients (autocomplétion). Renvoie id + nom + réf.
export async function suggestPartners(session: OdooSession, q: string): Promise<{ id: number; name: string; ref: string }[]> {
  const t = q.trim();
  if (t.length < 2) return [];
  const rows = await searchRead(session, M("MODEL_PARTNER"),
    ["|", ["name", "ilike", t], ["ref", "ilike", t]],
    ["id", "name", "ref"], 12, "name");
  return rows.map((r: any) => ({ id: r.id, name: r.name || "", ref: r.ref || "" }));
}

// Suggestions produits (autocomplétion). Renvoie id + nom + réf.
export async function suggestProducts(session: OdooSession, q: string): Promise<{ id: number; name: string; ref: string }[]> {
  const t = q.trim();
  if (t.length < 2) return [];
  const rows = await searchRead(session, M("MODEL_PRODUCT"),
    ["|", "|", ["default_code", "ilike", t], ["barcode", "ilike", t], ["name", "ilike", t]],
    ["id", "name", "default_code"], 12, "default_code");
  return rows.map((r: any) => ({ id: r.id, name: r.name || "", ref: r.default_code || "" }));
}

/**
 * Lots d'un produit, avec quantité DISPO NETTE (qty physique - réservé) sur les
 * emplacements internes. Inclut aussi les lots totalement réservés (dispo nette 0 ou
 * négative) — on ne filtre plus sur "quantity > 0" (stock physique brut), sinon un lot
 * avec du stock mais 100% réservé n'apparaissait jamais. Complété par les 5 derniers
 * lots créés pour ce produit même s'ils n'ont plus aucune quant (épuisés).
 */
export async function getProductStockLots(session: OdooSession, productId: number): Promise<{ lotId: number; lotName: string; qty: number }[]> {
  if (!productId) return [];
  const quants = await searchRead(session, M("MODEL_QUANT"),
    [["product_id", "=", productId], ["lot_id", "!=", false], ["location_id.usage", "=", "internal"]],
    ["lot_id", "quantity", "reserved_quantity"], 200);
  // Agrège par lot (un lot peut être sur plusieurs emplacements). qty = dispo nette (brut - réservé).
  const byLot: Record<number, { lotName: string; qty: number }> = {};
  for (const q of quants) {
    const lid = Array.isArray(q.lot_id) ? q.lot_id[0] : null;
    if (!lid) continue;
    if (!byLot[lid]) byLot[lid] = { lotName: Array.isArray(q.lot_id) ? q.lot_id[1] : "", qty: 0 };
    byLot[lid].qty += ((q.quantity || 0) - (q.reserved_quantity || 0));
  }

  // Complète avec les 5 derniers lots créés pour ce produit (même à 0 stock), pour ne pas
  // se limiter aux seuls lots ayant encore du dispo. On essaie le nom de modèle configuré,
  // puis les deux noms possibles selon la version d'Odoo (stock.lot / stock.production.lot),
  // au cas où l'override configuré ne correspondrait pas à la réalité de cette instance.
  const lotModelCandidates = Array.from(new Set([M("MODEL_LOT"), "stock.lot", "stock.production.lot"]));
  for (const model of lotModelCandidates) {
    try {
      const recentLots = await searchRead(session, model,
        [["product_id", "=", productId]], ["id", "name"], 5, "id desc");
      if (recentLots.length) {
        for (const l of recentLots) {
          if (!byLot[l.id]) byLot[l.id] = { lotName: l.name || "", qty: 0 };
        }
        break; // le premier modèle qui répond avec des résultats est le bon — inutile d'essayer les autres
      }
    } catch { /* modèle invalide sur cette instance — on tente le suivant */ }
  }

  return Object.entries(byLot)
    .map(([lotId, v]) => ({ lotId: Number(lotId), lotName: v.lotName, qty: Math.round(v.qty) }))
    .sort((a, b) => b.qty - a.qty);
}

// ── Recherche des VENTES (livraisons OUT) d'un produit pour un client ──
// Renvoie une ligne par livraison validée (done) : date, n° OUT, commande, qté, lots.
export interface ClientProductSale {
  pickingId: number;
  pickingName: string;   // WH/OUT/...
  date: string;          // date_done
  orderName: string;     // S0xxxx (origin)
  orderId: number | null;// id sale.order (pour le lien)
  qty: number;           // qté livrée
  lots: string[];        // lots du produit livrés
}
export async function searchClientProductSales(
  session: OdooSession, clientQuery: string, productQuery: string,
  // ids précis si l'utilisateur a sélectionné dans l'autocomplétion (prioritaire sur le texte)
  partnerId?: number | null, productId?: number | null
): Promise<{ partner: string; product: string; sales: ClientProductSale[] }> {
  const cq = clientQuery.trim(), pq = productQuery.trim();
  if (!partnerId && !cq) return { partner: "", product: "", sales: [] };
  if (!productId && !pq) return { partner: "", product: "", sales: [] };

  // 1. Partenaire : id précis si fourni, sinon recherche par nom/réf.
  const partners = partnerId
    ? await searchRead(session, M("MODEL_PARTNER"), [["id", "=", partnerId]], ["id", "name"], 1)
    : await searchRead(session, M("MODEL_PARTNER"), ["|", ["name", "ilike", cq], ["ref", "=", cq]], ["id", "name"], 20);
  if (!partners.length) return { partner: "", product: "", sales: [] };
  const partnerIds = partners.map((p: any) => p.id);

  // 2. Produit : id précis si fourni, sinon recherche par réf/EAN/nom.
  const prods = productId
    ? await searchRead(session, M("MODEL_PRODUCT"), [["id", "=", productId]], ["id", "name", "default_code"], 1)
    : await searchRead(session, M("MODEL_PRODUCT"),
        ["|", "|", ["default_code", "=", pq], ["barcode", "=", pq], ["name", "ilike", pq]],
        ["id", "name", "default_code"], 10);
  if (!prods.length) return { partner: partners[0].name, product: "", sales: [] };
  const productIds = prods.map((p: any) => p.id);

  // 3. Livraisons sortantes VALIDÉES de ces clients (OUT done).
  const picks = await searchRead(session, M("MODEL_PICKING"),
    [["partner_id", "in", partnerIds], ["picking_type_code", "=", "outgoing"], ["state", "=", "done"]],
    ["id", "name", "date_done", "origin", "sale_id"], 1000, "date_done desc");
  if (!picks.length) return { partner: partners[0].name, product: prods[0].name, sales: [] };
  const pickById: Record<number, any> = {};
  for (const p of picks) pickById[p.id] = p;

  // 4. Lignes de mouvement de CE produit dans ces livraisons (qté faite > 0).
  const mls = await searchRead(session, M("MODEL_MOVE_LINE"),
    [["picking_id", "in", picks.map((p: any) => p.id)], ["product_id", "in", productIds], ["qty_done", ">", 0]],
    ["picking_id", "qty_done", "lot_id"], 5000);

  // 5. Agrégation par livraison : qté totale + lots.
  const byPick: Record<number, { qty: number; lots: Set<string> }> = {};
  for (const ml of mls) {
    const pid = Array.isArray(ml.picking_id) ? ml.picking_id[0] : ml.picking_id;
    if (!pid) continue;
    if (!byPick[pid]) byPick[pid] = { qty: 0, lots: new Set() };
    byPick[pid].qty += ml.qty_done || 0;
    if (ml.lot_id) byPick[pid].lots.add(Array.isArray(ml.lot_id) ? ml.lot_id[1] : String(ml.lot_id));
  }

  const sales: ClientProductSale[] = Object.entries(byPick).map(([pidStr, agg]) => {
    const pid = Number(pidStr);
    const p = pickById[pid];
    return {
      pickingId: pid,
      pickingName: p?.name || String(pid),
      date: p?.date_done || "",
      orderName: p?.origin || (Array.isArray(p?.sale_id) ? p.sale_id[1] : ""),
      orderId: Array.isArray(p?.sale_id) ? p.sale_id[0] : null,
      qty: Math.round(agg.qty * 100) / 100,
      lots: Array.from(agg.lots),
    };
  }).sort((a, b) => (a.date < b.date ? 1 : -1));

  return { partner: partners[0].name, product: prods[0].name, sales };
}

// Liste des utilisateurs actifs Odoo (pour le panneau Administration des droits).
export async function getActiveUsers(session: OdooSession): Promise<{ id: number; name: string; login: string }[]> {
  const users = await searchRead(session, M("MODEL_USERS"),
    [["active", "=", true], ["share", "=", false]],
    ["id", "name", "login"], 500, "name");
  return users
    .filter((u: any) => u.login && u.login.includes("@"))
    .map((u: any) => ({ id: u.id, name: u.name || u.login, login: String(u.login).toLowerCase() }));
}

async function rpc(config: OdooConfig, endpoint: string, params: any, sessionId?: string) {
  // Fetch relatif "/api/odoo/proxy" : fonctionne uniquement dans un navigateur (URL de base
  // implicite = origine de la page). Côté serveur (cron, route API appelée sans contexte
  // navigateur), il faut une URL absolue — sans quoi le fetch échoue silencieusement.
  // Le comportement client (navigateur) est inchangé : base reste "" dans ce cas.
  const isServer = typeof window === "undefined";
  const base = isServer
    ? (process.env.INTERNAL_BASE_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000"))
    : "";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  // Côté serveur, la "Protection de déploiement" de Vercel bloque même les appels internes
  // (401 "Protected deployment") sauf à fournir ce header de contournement automatisé.
  // VERCEL_AUTOMATION_BYPASS_SECRET est injectée automatiquement par Vercel si l'option
  // "Protection Bypass for Automation" est activée dans Settings → Deployment Protection.
  if (isServer && process.env.VERCEL_AUTOMATION_BYPASS_SECRET) {
    headers["x-vercel-protection-bypass"] = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  }
  const res = await fetch(`${base}/api/odoo/proxy`, {
    method: "POST",
    headers,
    body: JSON.stringify({ odooUrl: config.url, endpoint, params, sessionId }),
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    // data.error DOIT être une string pour que new Error(...) produise un message lisible —
    // sinon (objet) l'Error stringifie silencieusement en "[object Object]", rendant
    // le diagnostic impossible en prod. On coerce systématiquement en string.
    const raw = data?.error;
    const msg = typeof raw === "string" ? raw : (raw ? JSON.stringify(raw) : `Erreur ${res.status}`);
    throw new Error(msg);
  }
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

/** Le modèle visé est-il celui des lignes de mouvement ? */
function isMoveLineModel(model: string) {
  return model === "stock.move.line" || model === M("MODEL_MOVE_LINE");
}

function isPickingModel(model: string) {
  return model === "stock.picking" || model === M("MODEL_PICKING");
}

/**
 * NOM DU CHAMP « MOUVEMENTS DU TRANSFERT ».
 *
 * `move_ids_without_package` a été retiré de stock.picking en Odoo 19 ; il ne
 * reste que `move_ids`. Ce champ était jusqu'ici corrigé à la main dans l'écran
 * Champs — ce qui suppose de penser à le faire, et ne survit pas à un changement
 * de base. On le résout donc automatiquement, comme les autres renommages.
 */
let _pickingMoveField: string | null = null;

async function pickingMoveField(session: OdooSession): Promise<string> {
  if (_pickingMoveField) return _pickingMoveField;
  const declared = F("PICKING_MOVE_IDS");
  const known = await knownFields(session, M("MODEL_PICKING"));
  if (!known) return declared;                       // inconnu : comportement d'origine
  if (known.has(declared)) { _pickingMoveField = declared; return declared; }
  for (const alt of ["move_ids", "move_ids_without_package"]) {
    if (known.has(alt)) {
      console.warn(`[WMS] Champ ${declared} absent de stock.picking, utilisation de ${alt}`);
      _pickingMoveField = alt;
      return alt;
    }
  }
  return declared;
}

/** Réinitialise les résolutions mémorisées — indispensable au changement de base. */
export function resetSchemaCache() {
  _pickingMoveField = null;
  for (const k of Object.keys(_modelFieldsCache)) delete _modelFieldsCache[k];
  for (const k of Object.keys(_modelResolveCache)) delete _modelResolveCache[k];
  compat.setStockShape(null);
}

/**
 * TRADUCTION D'UNE LISTE DE CHAMPS DEMANDÉS.
 * qty_done / reserved_uom_qty n'existent plus sur le modèle fusionné. Les
 * demander fait échouer la requête ENTIÈRE, donc vide l'écran appelant. On les
 * remplace par les champs réels ; normalizeMoveLines rétablit ensuite les
 * anciens noms sur les objets renvoyés, si bien que le code appelant ne change
 * pas.
 */
function translateMlFields(fields: string[], shape: compat.StockShape): string[] {
  if (!shape.merged) return fields;
  const out = new Set<string>();
  let touched = false;
  for (const f of fields) {
    if (f === "qty_done" || f === "reserved_uom_qty") { touched = true; continue; }
    out.add(f);
  }
  // `state` est ajouté d'office : sur une ligne terminée, la quantité réalisée se
  // lit directement dans `quantity` (voir lineDone). Sans lui, tout l'historique
  // serait compté à zéro.
  if (touched) { out.add("quantity"); out.add("picked"); out.add("state"); }
  return Array.from(out);
}

/**
 * TRADUCTION D'UN DOMAINE DE RECHERCHE.
 *
 * Plus insidieux que les champs : un nom inconnu dans un domaine fait échouer la
 * requête sans que rien n'indique la cause côté écran (« 0 colis » alors que les
 * colis existent).
 *
 * Correspondances retenues :
 *   qty_done > 0  /  != 0   →  picked = true  OU  state = done
 *   qty_done = 0            →  picked = false
 *   qty_done <autre>        →  quantity <même comparaison>
 *   reserved_uom_qty ...    →  quantity <même comparaison>
 *
 * Le « OU state = done » n'est pas un détail : sur une ligne déjà terminée,
 * `picked` n'est pas nécessairement resté à vrai. Sans cette branche, toute
 * requête portant sur de l'historique reviendrait vide — un écran sans données
 * plutôt qu'une erreur. C'est la même raison que dans lineDone.
 *
 * Un domaine Odoo est en notation préfixée avec ET implicite entre les termes :
 * remplacer un terme par la séquence ["|", A, B] est donc correct, d'où le
 * flatMap plutôt qu'un map.
 *
 * Limite assumée : sur le modèle fusionné, « fait » est un booléen. Un test du
 * type « fait > 3 » n'a plus d'équivalent exact et devient un test sur la
 * quantité de la ligne. Aucun appel du WMS ne fait ça aujourd'hui.
 */
function translateMlDomain(domain: any[], shape: compat.StockShape): any[] {
  if (!shape.merged || !Array.isArray(domain)) return domain;
  return domain.flatMap((leaf: any) => {
    if (!Array.isArray(leaf) || leaf.length !== 3) return [leaf];   // "&", "|", "!"
    const [field, op, val] = leaf;
    if (field === "qty_done") {
      if (val === 0 && (op === ">" || op === "!=")) {
        return ["|", ["picked", "=", true], ["state", "=", "done"]];
      }
      if (val === 0 && op === "=") return [["picked", "=", false]];
      return [["quantity", op, val]];
    }
    if (field === "reserved_uom_qty") return [["quantity", op, val]];
    return [leaf];
  });
}

/**
 * Alias du champ « mouvements du transfert », commun à searchRead et
 * searchReadAll.
 *
 * Factorisé parce que la divergence entre les deux a coûté cher : l'alias
 * n'existait que dans searchRead, si bien que « Commandes en attente », qui
 * passe par searchReadAll, affichait 0 article partout. Deux chemins de lecture
 * doivent traduire à l'identique, sinon la correction n'en couvre qu'un.
 */
async function aliasChampMouvements(session: OdooSession, model: string, fields: string[]) {
  if (!isPickingModel(model)) return { fields, alias: null as null | { from: string; to: string } };
  const declared = F("PICKING_MOVE_IDS");
  const real = await pickingMoveField(session);
  if (real === declared || !(fields.includes(declared) || fields.includes(real))) {
    return { fields, alias: null };
  }
  return {
    fields: fields.map(x => (x === declared ? real : x)),
    alias: { from: real, to: declared },
  };
}

/** Réexpose le nom historique sur les enregistrements renvoyés. */
function appliquerAlias(rows: any[], alias: { from: string; to: string } | null) {
  if (!alias || !Array.isArray(rows)) return rows;
  for (const r of rows) {
    if (r && typeof r === "object" && alias.from in r) r[alias.to] = r[alias.from];
  }
  return rows;
}

export async function searchRead(session: OdooSession, model: string, domain: any[], fields: string[], limit = 0, order = "") {
  let d = domain, f = fields;
  if (isMoveLineModel(model)) {
    const shape = await stockShape(session);
    d = translateMlDomain(domain, shape);
    f = translateMlFields(fields, shape);
  }

  // Transferts : le champ « mouvements » a changé de nom. On demande celui qui
  // existe, et on réexpose ensuite le nom attendu par le reste du code — ainsi
  // aucun appelant ne change, et surtout aucun réglage manuel n'est nécessaire.
  //
  // L'alias est posé que l'appelant ait passé l'ancien nom OU le nouveau : selon
  // qu'il soit passé ou non par availableFields, ce n'est pas le même. Ne traiter
  // qu'un seul des deux cas laisserait l'autre silencieusement sans données.
  const aliasRes = await aliasChampMouvements(session, model, f);
  f = aliasRes.fields;
  const moveAlias = aliasRes.alias;

  const rows = await call(session, "/web/dataset/call_kw", { model, method: "search_read", args: [d], kwargs: { fields: f, limit, order } });
  // Lignes de mouvement : on rétablit les noms historiques (voir normalizeMoveLines).
  if (isMoveLineModel(model)) {
    return normalizeMoveLines(rows, await stockShape(session));
  }
  return appliquerAlias(rows, moveAlias);
}

// Récupère TOUS les enregistrements en paginant (par lots de `chunk`), sans plafond.
// Évite la troncature silencieuse d'Odoo sur les gros volumes.
export async function searchReadAll(
  session: OdooSession, model: string, domain: any[], fields: string[], order = "", chunk = 10000
): Promise<any[]> {
  const out: any[] = [];
  let offset = 0;
  // Même traduction que searchRead : cette fonction contourne searchRead, donc
  // sans cela elle resterait la seule porte ouverte aux noms de champs disparus.
  const mlShape = isMoveLineModel(model) ? await stockShape(session) : null;
  const d = mlShape ? translateMlDomain(domain, mlShape) : domain;
  const aliasRes = await aliasChampMouvements(session, model, mlShape ? translateMlFields(fields, mlShape) : fields);
  const f = aliasRes.fields;
  while (true) {
    const batch = await call(session, "/web/dataset/call_kw", {
      model, method: "search_read", args: [d], kwargs: { fields: f, limit: chunk, offset, order },
    });
    if (!batch || !batch.length) break;
    out.push(...batch);
    if (batch.length < chunk) break; // dernière page
    offset += chunk;
    if (offset > 1_000_000) break;   // garde-fou absolu
  }
  return mlShape ? normalizeMoveLines(out, mlShape) : appliquerAlias(out, aliasRes.alias);
}

export async function callMethod(session: OdooSession, model: string, method: string, args: any[] = [], kwargs: any = {}) {
  return call(session, "/web/dataset/call_kw", { model, method, args, kwargs });
}

export async function getInventoryFields(session: OdooSession): Promise<string[]> {
  const fields = await call(session, "/web/dataset/call_kw", {
    model: M("MODEL_QUANT"), method: "fields_get", args: [], kwargs: { attributes: ["string", "type"] }
  });
  return Object.keys(fields || {}).filter((k: string) => k.includes("inventor") || k.includes("reason") || k.includes("adjustment"));
}

/**
 * Récupère le numéro de suivi (carrier_tracking_ref) des commandes Imparfaite.
 * Entrée : liste des réfs de commande du fichier (ex ["289116777", ...]).
 * Chaîne : réf → sale.order (origin "Imparfaite <ref>") → picking OUT lié → carrier_tracking_ref.
 * Sortie : map { ref: tracking } (tracking = "" si pas encore expédié / pas trouvé).
 */
export async function getImparfaiteTrackings(
  session: OdooSession, refs: string[]
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const clean = Array.from(new Set(refs.map(r => String(r).replace(/^#/, "").trim()).filter(Boolean)));
  if (!clean.length) return out;

  // 1. Retrouver les commandes de vente par origine "Imparfaite <ref>".
  //    On fait un OR de "origin ilike %ref%" pour couvrir "Imparfaite #ref" / "Imparfaite ref".
  const domain: any[] = [];
  for (let i = 0; i < clean.length - 1; i++) domain.push("|");
  for (const r of clean) domain.push(["origin", "ilike", r]);

  const orders = await searchReadAll(
    session, M("MODEL_SALE_ORDER"), domain, ["id", "name", "origin"], ""
  );
  if (!orders.length) return out;

  // Map origin → ref fichier (pour rattacher chaque commande à sa réf)
  const orderIdToRef: Record<number, string> = {};
  for (const o of orders) {
    const org = String(o.origin || "");
    const hit = clean.find(r => org.includes(r));
    if (hit) orderIdToRef[o.id] = hit;
  }
  const orderIds = orders.map((o: any) => o.id);

  // 2. Pickings OUT liés à ces commandes (via sale_id), avec le tracking.
  const picks = await searchReadAll(
    session, M("MODEL_PICKING"),
    [["sale_id", "in", orderIds], ["picking_type_code", "=", "outgoing"]],
    ["id", "sale_id", "carrier_tracking_ref", "state", "date_done"], ""
  );

  // 3. Pour chaque réf, prendre le tracking du OUT le plus récent qui en a un.
  const byRef: Record<string, { tracking: string; date: string }[]> = {};
  for (const p of picks) {
    const soId = Array.isArray(p.sale_id) ? p.sale_id[0] : p.sale_id;
    const ref = orderIdToRef[soId];
    if (!ref) continue;
    (byRef[ref] ||= []).push({ tracking: String(p.carrier_tracking_ref || ""), date: String(p.date_done || "") });
  }
  for (const ref of clean) {
    const list = byRef[ref] || [];
    // priorité : un tracking non vide, le plus récent
    const withTrack = list.filter(x => x.tracking).sort((a, b) => (a.date < b.date ? 1 : -1));
    out[ref] = withTrack.length ? withTrack[0].tracking : "";
  }
  return out;
}

/**
 * TRADUCTION DES QUANTITÉS À L'ÉCRITURE.
 *
 * Le code écrit `qty_done` et `reserved_uom_qty` sur les lignes de mouvement à
 * une vingtaine d'endroits. Ces champs n'existent plus en Odoo 17+ : chaque
 * écriture y échouerait avec « Invalid field ». Plutôt que de modifier vingt
 * appels, on traduit ici, au seul point de passage.
 *
 * Règles :
 *   qty_done: q          → quantity: q, picked: q > 0
 *   reserved_uom_qty: r  → quantity: r si r > 0 ; ignoré si r vaut 0
 *
 * Le cas `reserved_uom_qty: 0` servait à empêcher Odoo 16 de re-réserver une
 * ligne pendant l'emballage. Cette mécanique n'existe plus en 17+ (c'est
 * `picked` qui tranche) et écrire quantity: 0 effacerait la quantité préparée.
 * On l'ignore donc volontairement.
 */
function translateMlVals(values: any, shape: compat.StockShape): any {
  if (!shape.merged || !values || typeof values !== "object") return values;
  const hasDone = "qty_done" in values;
  const hasResv = "reserved_uom_qty" in values;
  if (!hasDone && !hasResv) return values;

  const out: any = { ...values };
  delete out.qty_done;
  delete out.reserved_uom_qty;

  if (hasDone) {
    const q = Number(values.qty_done) || 0;
    out.quantity = q;
    out.picked = q > 0;
  } else {
    const r = Number(values.reserved_uom_qty) || 0;
    if (r > 0) out.quantity = r;
  }
  return out;
}

async function maybeTranslate(session: OdooSession, model: string, values: any) {
  if (model !== M("MODEL_MOVE_LINE") && model !== "stock.move.line") return values;
  return translateMlVals(values, await stockShape(session));
}

export async function create(session: OdooSession, model: string, values: any) {
  const vals = await maybeTranslate(session, model, values);
  return call(session, "/web/dataset/call_kw", { model, method: "create", args: [vals], kwargs: {} });
}

export async function write(session: OdooSession, model: string, ids: number[], values: any) {
  const vals = await maybeTranslate(session, model, values);
  return call(session, "/web/dataset/call_kw", { model, method: "write", args: [ids, vals], kwargs: {} });
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
  const locs = await searchRead(session, M("MODEL_LOCATION"), [["barcode", "=", trimmed]], ["id", "name", "complete_name", "barcode"], 1);
  if (locs.length) return { type: "location", data: locs[0] };
  if (upper !== trimmed) {
    const locsU = await searchRead(session, M("MODEL_LOCATION"), [["barcode", "=", upper]], ["id", "name", "complete_name", "barcode"], 1);
    if (locsU.length) return { type: "location", data: locsU[0] };
  }
  const locsI = await searchRead(session, M("MODEL_LOCATION"), [["barcode", "ilike", trimmed]], ["id", "name", "complete_name", "barcode"], 1);
  if (locsI.length) return { type: "location", data: locsI[0] };

  // 2. Product by barcode (exact — EAN codes are numeric, case doesn't matter)
  const byBC = await searchRead(session, M("MODEL_PRODUCT"), [["barcode", "=", trimmed]], PRODUCT_FIELDS, 1);
  if (byBC.length) return { type: "product", data: byBC[0] };

  // 3. Product by reference — exact, then uppercase, then ilike
  const byRef = await searchRead(session, M("MODEL_PRODUCT"), [["default_code", "=", trimmed]], PRODUCT_FIELDS, 1);
  if (byRef.length) return { type: "product", data: byRef[0] };
  if (upper !== trimmed) {
    const byRefU = await searchRead(session, M("MODEL_PRODUCT"), [["default_code", "=", upper]], PRODUCT_FIELDS, 1);
    if (byRefU.length) return { type: "product", data: byRefU[0] };
  }
  const byRefI = await searchRead(session, M("MODEL_PRODUCT"), [["default_code", "=ilike", trimmed]], PRODUCT_FIELDS, 1);
  if (byRefI.length) return { type: "product", data: byRefI[0] };

  // 4. Lot — exact, then uppercase, then ilike
  const LOT_FIELDS = ["id", "name", "product_id", "expiration_date", "use_date", "removal_date"];
  let lots = await searchRead(session, M("MODEL_LOT"), [["name", "=", trimmed]], LOT_FIELDS, 1);
  if (!lots.length && upper !== trimmed) lots = await searchRead(session, M("MODEL_LOT"), [["name", "=", upper]], LOT_FIELDS, 1);
  if (!lots.length) lots = await searchRead(session, M("MODEL_LOT"), [["name", "ilike", trimmed]], LOT_FIELDS, 1);
  if (lots.length) {
    let prod = await searchRead(session, M("MODEL_PRODUCT"), [["id", "=", lots[0].product_id[0]]], PRODUCT_FIELDS, 1);
    // Fallback: archived product
    if (!prod.length) prod = await searchRead(session, M("MODEL_PRODUCT"), [["id", "=", lots[0].product_id[0]], ["active", "=", false]], PRODUCT_FIELDS, 1);
    return { type: "lot", data: { lot: lots[0], product: prod[0] || null } };
  }

  // 5. Fallback: archived product by barcode
  const archivedBC = await searchRead(session, M("MODEL_PRODUCT"), [["barcode", "=", trimmed], ["active", "=", false]], PRODUCT_FIELDS, 1);
  if (archivedBC.length) return { type: "product", data: archivedBC[0] };

  // 6. Fallback: archived product by reference (case-insensitive)
  let archivedRef = await searchRead(session, M("MODEL_PRODUCT"), [["default_code", "=ilike", trimmed], ["active", "=", false]], PRODUCT_FIELDS, 1);
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

export async function globalSearch(
  session: OdooSession,
  query: string,
  opts?: {
    /** Inclut les produits ARCHIVÉS d'Odoo. Par défaut false : Odoo les masque,
     *  et on ne veut pas les voir remonter dans la recherche courante (scan,
     *  accueil…). Utile en revanche pour rattacher un SKU chariot à un ancien
     *  produit archivé. */
    includeArchived?: boolean;
  }
): Promise<GlobalSearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed || trimmed.length < 2) return [];

  // `active in [true,false]` = la façon Odoo de lever le masquage des archivés.
  const arch: any[] = opts?.includeArchived ? [["active", "in", [true, false]]] : [];

  // Fire all searches in parallel — limits kept small to reduce Odoo response time
  const [locs, productsByRefOrName, productsByBarcode, lots, supplierInfos] = await Promise.all([
    // Locations by complete_name (internal + transit)
    searchRead(session, M("MODEL_LOCATION"),
      [["complete_name", "ilike", trimmed], ["usage", "in", ["internal", "transit"]]],
      ["id", "name", "complete_name", "barcode", "usage"], 20),
    // Products by internal ref OR name
    searchRead(session, M("MODEL_PRODUCT"),
      [...arch, "|", ["default_code", "ilike", trimmed], ["name", "ilike", trimmed]],
      PRODUCT_FIELDS, 50),
    // Products by barcode (exact — only if query looks like a barcode)
    trimmed.length >= 6 ? searchRead(session, M("MODEL_PRODUCT"),
      [...arch, ["barcode", "=", trimmed]], PRODUCT_FIELDS, 5) : Promise.resolve([]),
    // Lots by name
    searchRead(session, M("MODEL_LOT"),
      [["name", "ilike", trimmed]],
      ["id", "name", "product_id", "expiration_date"], 20),
    // Supplier refs
    searchRead(session, M("MODEL_PRODUCT_SUPPLIER"),
      [["product_code", "ilike", trimmed]],
      ["id", "product_code", "product_id", "product_tmpl_id"], 30),
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
    tmplProducts = await searchRead(session, M("MODEL_PRODUCT"),
      [...arch, ["product_tmpl_id", "in", tmplIds]],
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
    const newProds = await searchRead(session, M("MODEL_PRODUCT"),
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
    session, M("MODEL_QUANT"),
    [["product_id", "=", productId], ["quantity", "!=", 0], ["location_id.usage", "=", "internal"]],
    ["location_id", "lot_id", "quantity", "reserved_quantity"],
    500, "location_id"
  );

  // Enrich with lot expiration dates
  const lotIds = Array.from(new Set(quants.filter((q: any) => q.lot_id).map((q: any) => q.lot_id[0])));
  if (lotIds.length > 0) {
    const lots = await searchRead(session, M("MODEL_LOT"), [["id", "in", lotIds]], ["id", "name", "expiration_date", "use_date", "removal_date"], lotIds.length);
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
    session, M("MODEL_QUANT"),
    [["lot_id", "=", lotId], ["product_id", "=", productId], ["quantity", "!=", 0], ["location_id.usage", "=", "internal"]],
    ["location_id", "lot_id", "quantity", "reserved_quantity"],
    200, "location_id"
  );
}

// Stock at a specific location (for transfer mode)
export async function getStockAtLocation(session: OdooSession, productId: number, locationId: number) {
  return searchRead(
    session, M("MODEL_QUANT"),
    [["product_id", "=", productId], ["location_id", "=", locationId]],
    ["quantity", "lot_id", "reserved_quantity"]
  );
}

// All products at a location
export async function getProductsAtLocation(session: OdooSession, locationId: number) {
  const quants = await searchRead(
    session, M("MODEL_QUANT"),
    [["location_id", "=", locationId], ["quantity", "!=", 0]],
    ["id", "product_id", "location_id", "lot_id", "quantity", "reserved_quantity", "inventory_quantity"],
    500, "product_id"
  );
  // Enrich with lot expiration dates
  const lotIds = Array.from(new Set(quants.filter((q: any) => q.lot_id).map((q: any) => q.lot_id[0])));
  if (lotIds.length > 0) {
    const lots = await searchRead(session, M("MODEL_LOT"), [["id", "in", lotIds]], ["id", "name", "expiration_date", "use_date", "removal_date"], lotIds.length);
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
    const products = await searchRead(session, M("MODEL_PRODUCT"), [["id", "in", productIds]], ["id", "barcode", "default_code"], productIds.length);
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
  return searchRead(session, M("MODEL_LOCATION"), [["usage", "in", ["internal", "transit"]]], ["id", "name", "complete_name", "barcode", "usage", "location_id"], 2000, "complete_name");
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
  const id = await create(session, M("MODEL_LOCATION"), vals);
  return id as number;
}

// Vérifie si un code-barres d'emplacement existe déjà (évite les doublons de scan).
export async function locationBarcodeExists(session: OdooSession, barcode: string): Promise<boolean> {
  const b = barcode.trim();
  if (!b) return false;
  const found = await searchRead(session, M("MODEL_LOCATION"), [["barcode", "=", b]], ["id"], 1);
  return found.length > 0;
}

// ============================================
// RENAME LOCATION
// ============================================
export async function renameLocation(session: OdooSession, locationId: number, newName: string) {
  return write(session, M("MODEL_LOCATION"), [locationId], { name: newName });
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
    searchRead(session, M("MODEL_PICKING_TYPE"), [["code", "=", "internal"], ["name", "ilike", "pick"]], ["id"], 10)
      .then(async (t: any[]) => {
        if (t.length) return t;
        const t2 = await searchRead(session, M("MODEL_PICKING_TYPE"), [["sequence_code", "=", "PICK"]], ["id"], 10);
        if (t2.length) return t2;
        return searchRead(session, M("MODEL_PICKING_TYPE"), [["code", "=", "outgoing"]], ["id"], 10);
      }),
    // Picking type OUT (pour l'enrichissement date)
    searchRead(session, M("MODEL_PICKING_TYPE"), [["code", "=", "outgoing"]], ["id"], 10),
    // Tag "Transmise"
    searchRead(session, M("MODEL_CRM_TAG"), [["name", "ilike", "transmise"]], ["id"], 10),
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
    domain.push([F("ORDER_TAGS"), "in", transmiseTagIds]);
  }

  // TOUTES les commandes en attente, sans plafond : la limite fixe de 200
  // coupait silencieusement les plus récentes dès que le volume dépassait 200
  // (elles n'entraient jamais dans la fenêtre triée par scheduled_date).
  const pickings = await searchReadAll(
    session, M("MODEL_PICKING"),
    domain,
    await availableFields(session, M("MODEL_PICKING"), PICKING_FIELDS()),
    "scheduled_date asc, date_deadline asc, id asc"
  );

  // Enrichissement date depuis OUT lié + sale.order.
  // ⚠ Le groupe de procurement n'existe plus sur stock.picking en Odoo 19. Cet
  // enrichissement est un CONFORT (date d'expédition plus précise) : s'il échoue,
  // on doit continuer avec les dates du picking, pas faire tomber tout l'écran.
  const _grp = F("PICKING_GROUP_ID");
  const groupIds = Array.from(new Set(pickings.map((p: any) => p[_grp]?.[0]).filter(Boolean)));
  if (groupIds.length > 0 && outTypeIds.length > 0) try {
    const outPickings = await searchReadAll(
      session, M("MODEL_PICKING"),
      [[_grp, "in", groupIds], ["picking_type_id", "in", outTypeIds]],
      ["id", _grp, "scheduled_date", "date_deadline", "origin"]
    );
    const outByGroup: Record<number, any> = {};
    for (const op of outPickings) { if (op[_grp]) outByGroup[op[_grp][0]] = op; }

    const soNames = Array.from(new Set(outPickings.map((op: any) => op.origin).filter(Boolean)));
    const salesMap: Record<string, any> = {};
    if (soNames.length > 0) {
      const sales = await searchRead(session, M("MODEL_SALE_ORDER"),
        [["name", "in", soNames]], ["id", "name", "commitment_date", "expected_date"], soNames.length);
      for (const s of sales) salesMap[s.name] = s;
    }
    for (const p of pickings) {
      const gid = p[_grp]?.[0];
      if (gid && outByGroup[gid]) {
        const outP = outByGroup[gid];
        const sale = outP.origin ? salesMap[outP.origin] : null;
        p.shipping_date = sale?.commitment_date || sale?.expected_date || outP.date_deadline || outP.scheduled_date || null;
        if (!p.origin && outP.origin) p.origin = outP.origin;
      }
    }
  } catch (e) {
    // Champ absent (Odoo 19) ou inaccessible : on garde les dates du picking.
    console.warn("[WMS] Enrichissement par groupe de procurement indisponible :", e);
  }

  for (const p of pickings) {
    const shipDate = (p as any)[F("SHIPPING_DATE")];
    if (!p.shipping_date) {
      p.shipping_date = shipDate || p.date_deadline || p.scheduled_date || null;
    } else if (shipDate) {
      p.shipping_date = shipDate;
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
export async function getWaitingPickingsLight(session: OdooSession): Promise<{ id: number; name: string; shipping_date: string | null; scheduled_date: string | null; date_deadline: string | null; [key: string]: any }[]> {
  const { pickTypeIds, transmiseTagIds } = await _resolveWaitingIds(session);
  if (!pickTypeIds.length) return [];

  const domain: any[] = [
    ["picking_type_id", "in", pickTypeIds],
    ["state", "in", ["confirmed", "waiting", "partially_available"]],
  ];
  if (transmiseTagIds.length > 0) {
    domain.push([F("ORDER_TAGS"), "in", transmiseTagIds]);
  }

  // Sans plafond : même raison que getWaitingPickings — au-delà de 200 commandes
  // en attente, la détection de nouvelles commandes ratait les plus récentes.
  const pickings = await searchReadAll(
    session, M("MODEL_PICKING"),
    domain,
    ["id", "name", "scheduled_date", "date_deadline", F("SHIPPING_DATE"), "origin"]
  );

  for (const p of pickings) {
    p.shipping_date = (p as any)[F("SHIPPING_DATE")] || p.date_deadline || p.scheduled_date || null;
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
  await callMethod(session, M("MODEL_PICKING"), "action_assign", [[pickingId]]);

  const [picking] = await searchRead(session, M("MODEL_PICKING"),
    [["id", "=", pickingId]], ["state"], 1);
  const state = picking?.state || "confirmed";

  // Toujours vérifier les manquants — même si Odoo retourne "assigned",
  // il peut y avoir des lignes avec stock insuffisant (stock négatif, erreur Odoo…).
  // On compare la demande (product_uom_qty) à ce qui est vraiment réservé (reserved_availability).
  const moves = await searchRead(session, M("MODEL_MOVE"),
    [["picking_id", "=", pickingId], ["state", "!=", "cancel"]],
    await availableFields(session, M("MODEL_MOVE"),
      ["product_id", "product_uom_qty", "reserved_availability", "quantity"]), 200);
  // Reserve cote mouvement : reserved_availability (<=v16) ou quantity (v17+)
  const _resv = (m: any) => Number(m.reserved_availability ?? m.quantity ?? 0) || 0;
  const missingLines = moves.filter((m: any) =>
    Math.round(((m.product_uom_qty || 0) - _resv(m)) * 1000) > 0
  ).map((m: any) => ({
    product: m.product_id[1],
    needed: m.product_uom_qty,
    available: _resv(m),
    missing: Math.round(((m.product_uom_qty || 0) - _resv(m)) * 100) / 100,
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
    model: M("MODEL_ACTIONS_REPORT"),
    method: "search_read",
    args: [[["model", "=", M("MODEL_PICKING")], ["report_type", "ilike", "qweb"]]],
    kwargs: { fields: ["id", "name", "report_name"], limit: 50, order: "name asc", context: { lang: "fr_FR" } },
  });
}

const PREP_REPORT_KEY = "wms_prep_report_name";

// Rapport imposé à tous les postes, chargé depuis Supabase au démarrage.
// Prioritaire sur le réglage local : c'est tout l'intérêt d'un réglage partagé.
// Tant qu'il n'est pas chargé (null), on garde le comportement d'avant, ce qui
// évite un écran bloqué si Supabase est injoignable.
let _sharedPrepReport: string | null = null;

export function setSharedPrepReportName(name: string | null) {
  _sharedPrepReport = name && name.trim() ? name.trim() : null;
}

export function getSavedPrepReportName(): string {
  if (_sharedPrepReport) return _sharedPrepReport;
  try { return localStorage.getItem(PREP_REPORT_KEY) || M("MODEL_REPORT_PICKING"); } catch { return M("MODEL_REPORT_PICKING"); }
}

/** Mémorise localement. Le partage vers les autres postes se fait à part. */
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
// TOLÉRANCE AUX CHAMPS ABSENTS
// ────────────────────────────────────────────
// Un champ disparu d'une version d'Odoo (ex. group_id sur stock.picking en v19)
// fait échouer TOUTE la requête, donc l'écran entier — même si le champ n'était
// qu'un confort. On filtre donc la liste demandée sur ce qui existe réellement.
// La liste des champs d'un modèle est lue une fois puis mémorisée.
// ============================================
const _modelFieldsCache: Record<string, Set<string> | null> = {};

async function knownFields(session: OdooSession, model: string): Promise<Set<string> | null> {
  if (model in _modelFieldsCache) return _modelFieldsCache[model];
  try {
    const f = await call(session, "/web/dataset/call_kw", {
      model, method: "fields_get", args: [], kwargs: { attributes: ["type"] },
    });
    _modelFieldsCache[model] = f && typeof f === "object" ? new Set(Object.keys(f)) : null;
  } catch {
    _modelFieldsCache[model] = null; // en cas d'échec : on ne filtre rien
  }
  return _modelFieldsCache[model];
}

/**
 * RÉSOLUTION DU NOM D'UN MODÈLE RENOMMÉ ENTRE VERSIONS.
 *
 * Odoo renomme parfois un modèle entier. Appeler l'ancien nom ne donne PAS une
 * erreur de champ mais un 404 werkzeug brut — un message qui ne dit rien et fait
 * perdre un temps considérable à diagnostiquer.
 *
 * On essaie donc les noms candidats dans l'ordre et on retient le premier qui
 * existe réellement dans la base connectée. Résultat mémorisé : un seul
 * fields_get par modèle et par session.
 */
const _modelResolveCache: Record<string, string> = {};

export async function resolveModel(
  session: OdooSession, primary: string, alternatives: string[],
): Promise<string> {
  if (_modelResolveCache[primary]) return _modelResolveCache[primary];
  for (const cand of [primary, ...alternatives]) {
    const f = await knownFields(session, cand);
    if (f && f.size > 0) {
      if (cand !== primary) console.warn(`[WMS] Modèle ${primary} introuvable, utilisation de ${cand}`);
      _modelResolveCache[primary] = cand;
      return cand;
    }
  }
  return primary; // aucun candidat trouvé : on laisse remonter l'erreur d'origine
}

/**
 * Valeurs d'un mouvement de stock à créer, adaptées à la version.
 *
 * Deux champs varient :
 *  - `name` (la description de la ligne) a disparu de stock.move en Odoo 19 ;
 *    l'écrire fait échouer la création de tout le transfert.
 *  - l'unité de mesure s'appelle `product_uom` ou `product_uom_id` selon la
 *    version.
 *
 * On construit donc les valeurs à partir de ce que le modèle expose réellement,
 * plutôt que de supposer des noms qui changent d'une version à l'autre.
 */
export async function moveVals(
  session: OdooSession,
  v: { description?: string; productId: number; qty: number; uomId?: number | null;
       locationId?: number; locationDestId?: number },
): Promise<Record<string, any>> {
  const f = await knownFields(session, M("MODEL_MOVE"));
  const has = (n: string) => !f || f.has(n);

  const out: Record<string, any> = {
    product_id: v.productId,
    product_uom_qty: v.qty,
  };
  if (v.description && has("name")) out.name = v.description;
  if (v.uomId) {
    if (has("product_uom")) out.product_uom = v.uomId;
    else if (has("product_uom_id")) out.product_uom_id = v.uomId;
  }
  if (v.locationId != null) out.location_id = v.locationId;
  if (v.locationDestId != null) out.location_dest_id = v.locationDestId;
  return out;
}

/**
 * Modèle des colis. Renommé en stock.package dans les versions récentes ;
 * c'est ce qui faisait échouer la validation d'emballage avec un 404.
 */
export async function packageModel(session: OdooSession): Promise<string> {
  return resolveModel(session, M("MODEL_QUANT_PACKAGE"), ["stock.package", "stock.quant.package"]);
}

/**
 * Clause de domaine « produit stockable », valable dans toutes les versions.
 * Jusqu'en Odoo 17 : type = "product". Depuis la v18 : is_storable = true, et
 * plus aucun produit n'a type = "product" — le filtre d'origine renverrait donc
 * zéro résultat sans erreur, ce qui viderait silencieusement les écrans.
 */
export async function storableClause(session: OdooSession, model: string): Promise<any[]> {
  const f = await knownFields(session, model);
  return f && f.has("is_storable") ? ["is_storable", "=", true] : ["type", "=", "product"];
}

/** Retire d'une liste de champs ceux qui n'existent pas sur le modèle. */
/**
 * Renommages connus : un champ absent qui a un SUCCESSEUR doit être remplacé,
 * pas supprimé.
 *
 * Sans cela, « Commandes en attente » affichait 0 article partout : le champ
 * move_ids_without_package était retiré parce qu'il n'existe plus en v19, donc
 * plus rien n'était demandé, donc rien à compter — et aucune erreur pour le
 * signaler. Supprimer un champ de confort est sans conséquence ; supprimer un
 * champ renommé fait disparaître la donnée en silence.
 */
const RENOMMAGES: Record<string, string[]> = {
  move_ids_without_package: ["move_ids"],
  move_line_ids_without_package: ["move_line_ids"],
};

export async function availableFields(session: OdooSession, model: string, wanted: string[]): Promise<string[]> {
  const known = await knownFields(session, model);
  if (!known) return wanted;               // inconnu → comportement d'origine

  const kept: string[] = [];
  const dropped: string[] = [];
  const remplaces: string[] = [];
  for (const f of wanted) {
    if (known.has(f)) { kept.push(f); continue; }
    const successeur = (RENOMMAGES[f] || []).find(alt => known.has(alt));
    if (successeur) {
      if (!kept.includes(successeur)) kept.push(successeur);
      remplaces.push(`${f} → ${successeur}`);
    } else {
      dropped.push(f);
    }
  }
  if (remplaces.length) console.warn(`[WMS] Champs renommés sur ${model} :`, remplaces.join(", "));
  if (dropped.length)   console.warn(`[WMS] Champs absents de ${model}, ignorés :`, dropped.join(", "));
  return kept.length ? kept : wanted;
}

/**
 * Structure des quantités de stock de la base connectée (Odoo 16 vs 17+).
 * Exportée pour que les écrans n'aient pas à réécrire l'appel fields_get.
 * Le résultat est mémorisé par odooCompat : appeler ceci est quasi gratuit.
 */
export async function stockShape(session: OdooSession) {
  return compat.detectStockShape(
    m => call(session, "/web/dataset/call_kw", {
      model: m, method: "fields_get", args: [], kwargs: { attributes: ["type"] },
    }),
    M("MODEL_MOVE_LINE"),
  );
}

// ============================================
// PREPARATION — Outgoing pickings
// ============================================

// ⚠️ Fonction (et non constante) : les champs custom sont résolus au runtime
// via F(...), après chargement du mapping Odoo. Une constante figée au chargement
// du module capturerait les valeurs par défaut avant l'application des overrides.
const PICKING_FIELDS = () => [
  "id", "name", "state", "scheduled_date", "date_deadline", F("PICKING_DATE"),
  "partner_id", "origin", "picking_type_id", F("PICKING_GROUP_ID"),
  F("PICKING_MOVE_IDS"), "location_id", "location_dest_id",
  F("SHIPPING_DATE"), F("ORDER_TAGS"), "carrier_id",
  "user_id",
];

// Cherche les AUTRES préparations (pick) du même client encore en cours,
// pour avertir au moment d'imprimer qu'il faut peut-être les coupler.
// On exclut le picking courant (et son groupage _groupIds).
export async function findSiblingPickingsForPartner(
  session: OdooSession,
  partnerId: number,
  excludeIds: number[] = []
): Promise<{ id: number; name: string; user: string | null; state: string; origin: string }[]> {
  if (!partnerId) return [];
  const { pickTypeIds } = await _resolveWaitingIds(session);
  if (!pickTypeIds.length) return [];
  const recs = await searchRead(
    session, M("MODEL_PICKING"),
    [
      ["partner_id", "=", partnerId],
      ["picking_type_id", "in", pickTypeIds],
      ["state", "in", ["confirmed", "waiting", "partially_available", "assigned"]],
    ],
    ["id", "name", "user_id", "state", "origin"],
    50
  );
  const excl = new Set(excludeIds);
  return recs
    .filter((p: any) => !excl.has(p.id))
    .map((p: any) => ({
      id: p.id,
      name: p.name,
      user: Array.isArray(p.user_id) ? p.user_id[1] : null,
      state: p.state,
      origin: p.origin || "",
    }));
}

// Get pick-type pickings in confirmed/assigned state (preparation)
export async function getOutgoingPickings(session: OdooSession) {
  // Find pick picking type(s) — preparation before delivery
  const types = await searchRead(session, M("MODEL_PICKING_TYPE"), [["code", "=", "internal"], ["name", "ilike", "pick"]], ["id", "name"], 10);
  let typeIds = types.map((t: any) => t.id);
  if (!typeIds.length) {
    const types2 = await searchRead(session, M("MODEL_PICKING_TYPE"), [["sequence_code", "=", "PICK"]], ["id"], 10);
    typeIds = types2.map((t: any) => t.id);
  }
  if (!typeIds.length) {
    const types3 = await searchRead(session, M("MODEL_PICKING_TYPE"), [["code", "=", "outgoing"]], ["id"], 10);
    typeIds = types3.map((t: any) => t.id);
  }
  if (!typeIds.length) return [];

  const pickings = await searchRead(
    session, M("MODEL_PICKING"),
    [
      ["picking_type_id", "in", typeIds],
      ["state", "=", "assigned"],
    ],
    await availableFields(session, M("MODEL_PICKING"), PICKING_FIELDS()),
    200,
    "date_deadline asc, scheduled_date asc, id asc"
  );

  // Enrich with shipping date from related OUT picking (via group_id) or sale order.
  // ⚠ Confort uniquement : le groupe de procurement n'existe plus sur
  // stock.picking en Odoo 19. En cas d'échec on garde les dates du picking
  // plutôt que de faire tomber tout l'écran Préparation.
  const _grp2 = F("PICKING_GROUP_ID");
  const groupIds = Array.from(new Set(pickings.map((p: any) => p[_grp2]?.[0]).filter(Boolean)));
  if (groupIds.length > 0) try {
    // Find outgoing pickings with same group_id
    const outTypes = await searchRead(session, M("MODEL_PICKING_TYPE"), [["code", "=", "outgoing"]], ["id"], 10);
    const outTypeIds = outTypes.map((t: any) => t.id);
    if (outTypeIds.length > 0) {
      const outPickings = await searchRead(
        session, M("MODEL_PICKING"),
        [[_grp2, "in", groupIds], ["picking_type_id", "in", outTypeIds]],
        ["id", _grp2, "scheduled_date", "date_deadline", "origin"],
        500
      );
      // Map group_id → OUT picking
      const outByGroup: Record<number, any> = {};
      for (const op of outPickings) {
        if (op[_grp2]) outByGroup[op[_grp2][0]] = op;
      }
      // Also try to get sale order dates from OUT picking origins
      const soNames = Array.from(new Set(outPickings.map((op: any) => op.origin).filter(Boolean)));
      const salesMap: Record<string, any> = {};
      if (soNames.length > 0) {
        const sales = await searchRead(
          session, M("MODEL_SALE_ORDER"),
          [["name", "in", soNames]],
          ["id", "name", "commitment_date", "expected_date"],
          soNames.length
        );
        for (const s of sales) salesMap[s.name] = s;
      }

      for (const p of pickings) {
        const gid = p[_grp2]?.[0];
        if (gid && outByGroup[gid]) {
          const outP = outByGroup[gid];
          const sale = outP.origin ? salesMap[outP.origin] : null;
          // Priority: sale.commitment_date > OUT.date_deadline > OUT.scheduled_date
          p.shipping_date = sale?.commitment_date || sale?.expected_date || outP.date_deadline || outP.scheduled_date || null;
          if (!p.origin && outP.origin) p.origin = outP.origin; // show SO ref
        }
      }
    }
  } catch (e) {
    // Champ absent (Odoo 19) ou inaccessible : on garde les dates du picking.
    console.warn("[WMS] Enrichissement par groupe de procurement indisponible :", e);
  }

  // Filter out pickings tagged "En attente" via le champ tags de commande
  const _tagField = F("ORDER_TAGS");
  const tagIds = Array.from(new Set(
    pickings.flatMap((p: any) => p[_tagField] || [])
  )) as number[];
  let excludeTagIds: number[] = [];
  if (tagIds.length > 0) {
    const tags = await searchRead(session, M("MODEL_CRM_TAG"), [["id", "in", tagIds]], ["id", "name"], tagIds.length);
    excludeTagIds = tags.filter((t: any) => t.name?.toLowerCase().includes("en attente")).map((t: any) => t.id);
  }
  const filteredPickings = excludeTagIds.length > 0
    ? pickings.filter((p: any) => {
        const pTags: number[] = p[_tagField] || [];
        return !pTags.some((tid: number) => excludeTagIds.includes(tid));
      })
    : pickings;

  // Utilise la date d'expédition prévue (champ custom) comme date primaire si présente
  const _shipField = F("SHIPPING_DATE");
  for (const p of filteredPickings) {
    if (p[_shipField]) p.shipping_date = p[_shipField];
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
  const rows = await searchRead(
    session, M("MODEL_MOVE_LINE"),
    [["picking_id", "=", pickingId]],
    // Champs de quantité filtrés sur ce qui existe : qty_done/reserved_uom_qty
    // n'existent plus en Odoo 17+. Le reste du code lit via compat.*
    await availableFields(session, M("MODEL_MOVE_LINE"), [
      "id", "product_id", "lot_id", "location_id", "location_dest_id",
      "qty_done", "reserved_uom_qty", "quantity", "picked",
      "picking_id", "move_id", "product_uom_id",
    ]),
    200,
    "product_id"
  );
  return normalizeMoveLines(rows, await stockShape(session));
}

/**
 * NORMALISATION DES LIGNES — pourquoi elle existe.
 *
 * L'écran de préparation lit `reserved_uom_qty` et `qty_done` à plus de
 * quatre-vingts endroits. En Odoo 17+ ces champs n'existent plus : les lignes
 * arrivent sans eux, toutes les comparaisons valent 0 < 0, et l'écran affiche
 * « 0 article à préparer » sans la moindre erreur — exactement le bug constaté.
 *
 * Réécrire ces quatre-vingts comparaisons serait long et risqué. On rétablit
 * donc les deux noms historiques sur les objets renvoyés, calculés depuis
 * `quantity` / `picked`. Le code d'affichage reste inchangé et garde un sens
 * correct ; seules les ÉCRITURES passent par compat.doneVals, qui elles
 * connaissent la vraie version.
 *
 * Limite assumée : en modèle fusionné une ligne est prélevée ou ne l'est pas.
 * Le « fait » relu depuis Odoo est donc 0 ou la quantité complète — la
 * progression à l'unité en cours de préparation reste locale au WMS.
 */
export function normalizeMoveLines<T = any>(rows: any[], shape: compat.StockShape): T[] {
  if (!shape.merged || !Array.isArray(rows)) return rows as T[];
  return rows.map((ml: any) => {
    // Si `quantity` n'a pas été demandé, on n'invente rien : ajouter des clés à 0
    // serait pire que leur absence pour le code qui teste leur présence.
    if (!ml || typeof ml !== "object" || !("quantity" in ml)) return ml;
    return {
      ...ml,
      reserved_uom_qty: compat.lineExpected(ml, shape),
      qty_done:         compat.lineDone(ml, shape),
    };
  }) as T[];
}

// Progression réelle (partagée, lue depuis Odoo) pour PLUSIEURS pickings d'un coup.
// Renvoie pour chaque id : unités faites/réservées + lignes faites/totales.
// Permet une barre de chargement dynamique reflétant le travail de TOUS les préparateurs.
export async function getPickingsProgress(
  session: OdooSession, pickingIds: number[]
): Promise<Record<number, { done: number; total: number; doneLines: number; totalLines: number }>> {
  const out: Record<number, { done: number; total: number; doneLines: number; totalLines: number }> = {};
  if (!pickingIds.length) return out;
  for (const id of pickingIds) out[id] = { done: 0, total: 0, doneLines: 0, totalLines: 0 };

  // Version-agnostique : en Odoo 17+ les champs reserved_uom_qty / qty_done
  // n'existent plus (fusionnes en quantity + picked).
  const shape = await compat.detectStockShape(m =>
    call(session, "/web/dataset/call_kw", { model: m, method: "fields_get", args: [], kwargs: { attributes: ["type"] } }),
    M("MODEL_MOVE_LINE"));
  const lines = await searchRead(
    session, M("MODEL_MOVE_LINE"),
    [["picking_id", "in", pickingIds], ...compat.pendingDomain(shape)],
    compat.moveLineFields(shape, ["picking_id"]),
    5000
  );
  for (const ml of lines) {
    const pid = Array.isArray(ml.picking_id) ? ml.picking_id[0] : ml.picking_id;
    if (!pid || !out[pid]) continue;
    const reserved = compat.lineExpected(ml, shape);
    const done = Math.min(compat.lineDone(ml, shape), reserved); // borne : pas plus que réservé
    out[pid].total += reserved;
    out[pid].done += done;
    out[pid].totalLines += 1;
    if (done >= reserved) out[pid].doneLines += 1;
  }
  return out;
}

// Crée une nouvelle ligne de mouvement pour un lot scanné différent du lot réservé.
// C'est l'approche correcte dans Odoo : ne pas changer le lot_id d'une ligne réservée,
// mais créer une nouvelle ligne pour le lot réellement prélevé.
export async function createDeviationMoveLine(session: OdooSession, params: {
  moveId: number; pickingId: number; productId: number; productUomId: number;
  lotId: number; locationId: number; locationDestId: number;
}): Promise<number> {
  return create(session, M("MODEL_MOVE_LINE"), {
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
    session, M("MODEL_MOVE"),
    [["picking_id", "=", pickingId]],
    // quantity_done n'existe plus sur stock.move en Odoo 17+ (remplace par
    // quantity + picked). On demande les deux jeux, filtres sur l'existant.
    await availableFields(session, M("MODEL_MOVE"), [
      "id", "product_id", "product_uom_qty", "quantity_done", "quantity", "picked",
      "product_uom", "state", "location_id", "location_dest_id", "move_line_ids",
    ]),
    200,
    "product_id"
  );
}

// Check availability (action_assign)
export async function checkAvailability(session: OdooSession, pickingId: number) {
  return callMethod(session, M("MODEL_PICKING"), "action_assign", [[pickingId]]);
}

// Set qty_done on a move line
export async function setMoveLineQtyDone(session: OdooSession, moveLineId: number, qtyDone: number, lotId?: number | null) {
  const vals: any = { qty_done: qtyDone };
  if (lotId) vals.lot_id = lotId;
  return write(session, M("MODEL_MOVE_LINE"), [moveLineId], vals);
}

// Auto-fill all move lines qty_done = reserved_uom_qty
export async function autoFillPicking(session: OdooSession, pickingId: number) {
  const moveLines = await getPickingMoveLines(session, pickingId);
  for (const ml of moveLines) {
    if ((!ml.qty_done || ml.qty_done === 0) && ml.reserved_uom_qty > 0) {
      await write(session, M("MODEL_MOVE_LINE"), [ml.id], { qty_done: ml.reserved_uom_qty });
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
  const pickingTypes = await searchRead(session, M("MODEL_PICKING_TYPE"), [["code", "=", "internal"]], ["id"], 1);
  if (!pickingTypes.length) throw new Error("Aucun type d'opération interne trouvé");

  // Create picking + moves
  const pickingId = await create(session, M("MODEL_PICKING"), {
    picking_type_id: pickingTypes[0].id,
    location_id: sourceLocationId,
    location_dest_id: destLocationId,
    // Nom résolu sur la base connectée : move_ids_without_package a été renommé
    // en move_ids. Contrairement aux lectures, une écriture ne pardonne pas —
    // Odoo refuse la clé inconnue et le transfert n'est pas créé.
    [await pickingMoveField(session)]: await Promise.all(lines.map(async (line) => [0, 0,
      await moveVals(session, {
        description: line.productName, productId: line.productId, qty: line.qty,
        uomId: line.uomId, locationId: sourceLocationId, locationDestId: destLocationId,
      }),
    ])),
  });

  // Confirm moves (state: draft → confirmed)
  await callMethod(session, M("MODEL_PICKING"), "action_confirm", [[pickingId]]);

  // Odoo auto-creates move lines after action_confirm (splits by lot/location from available stock).
  // Delete them all — we'll create the correct ones manually with explicit source + lot.
  const autoMoveLines = await searchRead(session, M("MODEL_MOVE_LINE"),
    [["picking_id", "=", pickingId]],
    ["id"], 500
  );
  if (autoMoveLines.length) {
    await callMethod(session, M("MODEL_MOVE_LINE"), "unlink", [autoMoveLines.map((ml: any) => ml.id)]);
  }

  // Get moves (one per product, or multiple if same product appears twice with different lots)
  const moves = await searchRead(session, M("MODEL_MOVE"),
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

    await create(session, M("MODEL_MOVE_LINE"), mlData);
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
  const pickingTypes = await searchRead(session, M("MODEL_PICKING_TYPE"), [["code", "=", "internal"]], ["id"], 1);
  if (!pickingTypes.length) throw new Error("Aucun type d'opération interne trouvé");

  // Un seul picking — location_dest_id = fallback (écrasé au niveau move/move_line)
  const pickingId = await create(session, M("MODEL_PICKING"), {
    picking_type_id: pickingTypes[0].id,
    location_id: sourceLocationId,
    location_dest_id: fallbackDestLocationId,
    // Nom résolu sur la base connectée : move_ids_without_package a été renommé
    // en move_ids. Contrairement aux lectures, une écriture ne pardonne pas —
    // Odoo refuse la clé inconnue et le transfert n'est pas créé.
    [await pickingMoveField(session)]: await Promise.all(lines.map(async (line) => [0, 0,
      await moveVals(session, {
        description: line.productName, productId: line.productId, qty: line.qty,
        uomId: line.uomId, locationId: sourceLocationId,
        locationDestId: line.destLocationId,  // destination spécifique par produit
      }),
    ])),
  });

  await callMethod(session, M("MODEL_PICKING"), "action_confirm", [[pickingId]]);

  // Supprimer les lignes auto-créées par Odoo (mauvaises sources/lots)
  const autoMoveLines = await searchRead(session, M("MODEL_MOVE_LINE"),
    [["picking_id", "=", pickingId]], ["id"], 500);
  if (autoMoveLines.length) {
    await callMethod(session, M("MODEL_MOVE_LINE"), "unlink", [autoMoveLines.map((ml: any) => ml.id)]);
  }

  // Récupérer les moves créés (un par ligne, dans l'ordre d'insertion)
  const moves = await searchRead(session, M("MODEL_MOVE"),
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
    await create(session, M("MODEL_MOVE_LINE"), mlData);
  }

  return pickingId;
}

// ============================================
// EMBALLAGE — Pack & Ship
// ============================================

/** OUT pickings en état "assigned" prêts à emballer (stock disponible en Sortie) */
export async function getPackablePickings(session: OdooSession): Promise<any[]> {
  return searchRead(session, M("MODEL_PICKING"),
    [["picking_type_code", "=", "outgoing"], ["state", "=", "assigned"]],
    ["id", "name", "state", "origin", F("CLIENT_ORDER"), "partner_id", "scheduled_date",
     "date_deadline", F("PICKING_MOVE_IDS"), "carrier_id"],
    200, "date_deadline asc, scheduled_date asc, id asc"
  );
}

/** Trouve le OUT picking lié à un PICK picking via le groupe de procurement.
 *  Renvoie null si le champ n'existe pas (Odoo 19) plutôt que de propager
 *  l'erreur : l'appelant sait déjà gérer l'absence de OUT lié. */
export async function findOutPickingFromPick(session: OdooSession, pickId: number): Promise<any | null> {
  const _grp = F("PICKING_GROUP_ID");
  let pick: any;
  try {
    [pick] = await searchRead(session, M("MODEL_PICKING"), [["id", "=", pickId]], [_grp], 1);
  } catch { return null; }
  if (!pick?.[_grp]) return null;
  const groupId = Array.isArray(pick[_grp]) ? pick[_grp][0] : pick[_grp];
  const outs = await searchRead(session, M("MODEL_PICKING"),
    [[_grp, "=", groupId], ["picking_type_code", "=", "outgoing"],
     ["state", "in", ["assigned", "confirmed", "waiting", "partially_available"]]],
    ["id", "name", "state", "origin", "partner_id", "scheduled_date", "date_deadline",
     "carrier_id", F("PICKING_MOVE_IDS")],
    1
  );
  return outs[0] || null;
}

/** Trouve le(s) PICK picking(s) (internal, déjà "done") liés à un OUT.
 *  Liste vide si le champ n'existe pas (Odoo 19), au lieu d'une erreur. */
export async function findPickPickingsFromOut(session: OdooSession, outPickingId: number): Promise<any[]> {
  const _grp = F("PICKING_GROUP_ID");
  let out: any;
  try {
    [out] = await searchRead(session, M("MODEL_PICKING"), [["id", "=", outPickingId]], [_grp], 1);
  } catch { return []; }
  if (!out?.[_grp]) return [];
  const groupId = Array.isArray(out[_grp]) ? out[_grp][0] : out[_grp];
  return searchRead(session, M("MODEL_PICKING"),
    [[_grp, "=", groupId], ["picking_type_code", "=", "internal"]],
    ["id", "name", "state"], 10
  );
}

/**
 * Force reserved_uom_qty=0 sur TOUTES les move lines "done" d'un picking qui ont encore
 * une réservation résiduelle (Odoo interdit qu'une ligne faite ait une quantité réservée :
 * "Une ligne de mouvement fait ne doit jamais comporter de quantité réservée."). Corrige
 * n'importe quel résidu, pas seulement celui du produit qu'on vient de synchroniser.
 */
export async function clearReservedOnDoneLines(session: OdooSession, pickingId: number): Promise<number> {
  const lines = await searchRead(session, M("MODEL_MOVE_LINE"),
    [["picking_id", "=", pickingId], ["state", "=", "done"], ["reserved_uom_qty", "!=", 0]],
    ["id"], 500);
  if (!lines.length) return 0;
  await write(session, M("MODEL_MOVE_LINE"), lines.map((l: any) => l.id), { reserved_uom_qty: 0 });
  return lines.length;
}

/**
 * Synchronise les colis (result_package_id) d'un OUT vers les move lines correspondantes
 * du PICK déjà validé, produit par produit + lot par lot. Nécessaire quand le pick a été
 * "défait" (colis retirés) après validation : le pick garde alors une seule ligne groupée
 * (ou des colis obsolètes/vides), ce qui empêche Odoo de réconcilier correctement la chaîne
 * pick→OUT à la validation du OUT (erreur "impossible de déréserver plus que la quantité
 * en stock"). Si le OUT a divisé un produit/lot en plusieurs colis (ex: 60/70/70) alors que
 * le pick n'a qu'UNE ligne groupée pour ce produit/lot, cette fonction DIVISE aussi la ligne
 * du pick dans les mêmes proportions, puis assigne chaque nouvelle ligne au bon colis —
 * pour que la structure du pick corresponde exactement à celle du OUT.
 */
export async function syncPickPackagesFromOut(
  session: OdooSession, outPickingId: number
): Promise<{ pickName: string; updated: number; split: number }[]> {
  const picks = await findPickPickingsFromOut(session, outPickingId);
  if (!picks.length) throw new Error("Aucun pick lié trouvé pour ce OUT");

  const outLines = await searchRead(session, M("MODEL_MOVE_LINE"),
    [["picking_id", "=", outPickingId], ["qty_done", ">", 0]],
    ["product_id", "lot_id", "qty_done", "result_package_id"], 500);

  const key = (pid: number, lid: number | null) => `${pid}_${lid ?? 0}`;
  // Groupe les lignes OUT par produit+lot → liste des {packageId, qty} à répartir.
  const outByKey: Record<string, { packageId: number; qty: number }[]> = {};
  for (const ol of outLines) {
    const pid = Array.isArray(ol.product_id) ? ol.product_id[0] : ol.product_id;
    const lid = ol.lot_id ? (Array.isArray(ol.lot_id) ? ol.lot_id[0] : ol.lot_id) : null;
    const pkgId = ol.result_package_id ? (Array.isArray(ol.result_package_id) ? ol.result_package_id[0] : ol.result_package_id) : null;
    if (!pkgId) continue;
    const k = key(pid, lid);
    (outByKey[k] ||= []).push({ packageId: pkgId, qty: ol.qty_done || 0 });
  }

  const results: { pickName: string; updated: number; split: number }[] = [];
  for (const pick of picks) {
    const pickLines = await searchRead(session, M("MODEL_MOVE_LINE"),
      [["picking_id", "=", pick.id]],
      ["id", "product_id", "lot_id", "qty_done", "result_package_id"], 500);

    let updated = 0, splitCount = 0;
    for (const pl of pickLines) {
      const pid = Array.isArray(pl.product_id) ? pl.product_id[0] : pl.product_id;
      const lid = pl.lot_id ? (Array.isArray(pl.lot_id) ? pl.lot_id[0] : pl.lot_id) : null;
      const k = key(pid, lid);
      const targets = outByKey[k];
      if (!targets || !targets.length) continue;

      if (targets.length === 1) {
        // Un seul colis pour ce produit/lot côté OUT → assignation directe, pas de split requis.
        // reserved_uom_qty forcé à 0 : une ligne "done" ne doit jamais avoir de réservation.
        const target = targets[0];
        if (!pl.result_package_id || pl.result_package_id[0] !== target.packageId) {
          await write(session, M("MODEL_MOVE_LINE"), [pl.id], { result_package_id: target.packageId, reserved_uom_qty: 0 });
          updated++;
        }
        continue;
      }

      // Plusieurs colis côté OUT pour ce produit/lot → diviser la ligne du pick dans les
      // mêmes proportions, puis assigner chaque nouvelle ligne au colis correspondant.
      const totalTarget = targets.reduce((s, t) => s + t.qty, 0);
      const totalPick = pl.qty_done || 0;
      if (totalTarget <= 0 || totalPick <= 0) continue;

      let remaining = totalPick;
      let currentLineId = pl.id;
      for (let i = 0; i < targets.length; i++) {
        const isLast = i === targets.length - 1;
        // Répartit au prorata (proportionnel au qty du OUT), le dernier colis récupère le reliquat
        // exact pour ne pas perdre d'unités par arrondi.
        const wantQty = isLast ? remaining : Math.round((targets[i].qty / totalTarget) * totalPick);
        if (wantQty <= 0) continue;

        if (isLast) {
          // Dernière part : assigne directement la ligne courante (pas besoin de re-diviser).
          // reserved_uom_qty forcé à 0 : une ligne "done" ne doit jamais avoir de réservation.
          await write(session, M("MODEL_MOVE_LINE"), [currentLineId], { result_package_id: targets[i].packageId, reserved_uom_qty: 0 });
          updated++;
        } else {
          // Divise : la ligne courante garde `wantQty`, le reliquat part dans une nouvelle ligne
          // qu'on traitera à l'itération suivante.
          const newLineId = await splitMoveLine(session, currentLineId, wantQty);
          // reserved_uom_qty forcé à 0 des deux côtés : une ligne "done" ne doit jamais avoir
          // de réservation (splitMoveLine proratise reserved_uom_qty, invalide ici).
          await write(session, M("MODEL_MOVE_LINE"), [currentLineId], { result_package_id: targets[i].packageId, reserved_uom_qty: 0 });
          await write(session, M("MODEL_MOVE_LINE"), [newLineId], { reserved_uom_qty: 0 });
          updated++; splitCount++;
          currentLineId = newLineId;
        }
        remaining -= wantQty;
      }
    }
    // Filet de sécurité : nettoie TOUT résidu de réservation sur ce pick, pas seulement
    // celui du produit traité ci-dessus (au cas où un autre écart traînerait ailleurs).
    await clearReservedOnDoneLines(session, pick.id);
    results.push({ pickName: pick.name, updated, split: splitCount });
  }
  return results;
}

/** Données du picking pré-chargées à l'OUVERTURE du détail Emballage.
 *  L'opérateur saisit ensuite le nombre de colis et les poids : pendant ces
 *  quelques secondes, ces allers-retours Odoo sont déjà faits. Au clic sur
 *  « Valider & Imprimer », packAndShipOut n'a donc plus rien à aller chercher.
 */
export interface PackPrefetch {
  pickingName:           string;
  hasCarrier:            boolean;
  state:                 string;
  existingAttachmentIds: number[];
  moveLines:             { id: number; reserved_uom_qty: number }[];
  fetchedAt:             number;
}

/** Pré-charge le contexte nécessaire à packAndShipOut (3 requêtes en parallèle). */
export async function prefetchPackData(session: OdooSession, outPickingId: number): Promise<PackPrefetch> {
  const [before, pickInfo, moveLines] = await Promise.all([
    searchRead(session, M("MODEL_ATTACHMENT"),
      [["res_model", "=", M("MODEL_PICKING")], ["res_id", "=", outPickingId], ["mimetype", "ilike", "pdf"]],
      ["id"], 100),
    searchRead(session, M("MODEL_PICKING"), [["id", "=", outPickingId]], ["name", "carrier_id", "state"], 1),
    searchRead(session, M("MODEL_MOVE_LINE"),
      [["picking_id", "=", outPickingId], ["state", "not in", ["done", "cancel"]]],
      await availableFields(session, M("MODEL_MOVE_LINE"), ["id", "reserved_uom_qty", "quantity", "picked"]), 500),
  ]);
  return {
    pickingName:           pickInfo[0]?.name || `OUT-${outPickingId}`,
    hasCarrier:            !!pickInfo[0]?.carrier_id,
    state:                 pickInfo[0]?.state || "",
    existingAttachmentIds: before.map((a: any) => a.id),
    moveLines,
    fetchedAt:             Date.now(),
  };
}

/** Au-delà de ce délai, les move lines pré-chargées sont considérées périmées
 *  (un autre poste a pu toucher au picking) et sont relues avant validation. */
const PACK_PREFETCH_TTL_MS = 120_000;

export interface PackShipResult {
  pickingName:      string;
  labelAttachments: { id: number; name: string; datas: string }[];
  labelsPending:    boolean;
  blPrinted:        boolean;
  blError?:         string;
  /** Impression du bon de livraison — à suivre en tâche de fond, ne bloque pas l'UI. */
  blPromise:        Promise<{ success: boolean; error?: string }>;
  /** Étiquettes transporteur dès qu'elles arrivent (liste vide si timeout). */
  labelsPromise:    Promise<{ id: number; name: string; datas: string }[]>;
  /**
   * Refus du transporteur, s'il y en a un. `null` sinon.
   *
   * Indispensable : le bon est validé AVANT l'appel au transporteur. Si celui-ci
   * refuse — nom ou adresse trop longs par exemple — le stock est sorti et aucune
   * étiquette n'arrive. Sans ce canal, l'erreur était avalée et l'opérateur
   * repartait avec un colis sans étiquette, sans savoir pourquoi.
   */
  shipErrorPromise: Promise<string | null>;
}

/** Workflow complet emballage + expédition pour un OUT picking.
 *
 *  Chemin critique volontairement réduit à la seule étape qui compte vraiment
 *  (button_validate). Tout le reste est soit pré-chargé, soit parallélisé, soit
 *  renvoyé sous forme de promesse que l'appelant suit en tâche de fond :
 *   - contexte du picking → pré-chargé à l'ouverture du détail (`prefetch`)
 *   - action_assign → seulement si le picking n'est pas déjà réservé
 *   - N colis → un seul multi-create, poids inclus
 *   - BL → lancé EN PARALLÈLE de button_validate (option `blParallel`)
 *   - étiquettes transporteur → polling en tâche de fond via `labelsPromise`
 */
export async function packAndShipOut(
  session: OdooSession,
  outPickingId: number,
  packageWeights: number[],
  printOptions?: {
    blPrinterId?: number; labelPrinterId?: number; blReportName?: string; overlayDate?: string;
    /** false → BL imprimé APRÈS la validation (comportement historique, plus lent
     *  mais garantit que le PDF reflète l'état `done` du picking). */
    blParallel?: boolean;
    prefetch?: PackPrefetch;
  }
): Promise<PackShipResult> {
  const nPackages = packageWeights.length;
  if (!nPackages) throw new Error("Au moins un colis requis");

  // ── 1. Contexte du picking : pré-chargé si dispo, sinon récupéré maintenant ──
  const ctx = printOptions?.prefetch ?? await prefetchPackData(session, outPickingId);
  const existingIds = new Set(ctx.existingAttachmentIds);
  const pickingName = ctx.pickingName;
  const hasCarrier  = ctx.hasCarrier;

  // ── 2. action_assign : inutile si le picking est déjà réservé ────────────────
  //     Les OUT de la liste Emballage sont en `assigned` par construction. Un OUT
  //     atteint par scan peut être `confirmed`/`waiting` → là seulement on réserve.
  //     (l'appel est lourd : le proxy lui accorde un timeout de 45 s)
  let moveLines = ctx.moveLines;
  const needsAssign = ctx.state !== "assigned";
  const isStale     = Date.now() - ctx.fetchedAt > PACK_PREFETCH_TTL_MS;
  if (needsAssign) {
    await callMethod(session, M("MODEL_PICKING"), "action_assign", [[outPickingId]]).catch(() => null);
  }
  if (needsAssign || isStale) {
    moveLines = await searchRead(session, M("MODEL_MOVE_LINE"),
      [["picking_id", "=", outPickingId], ["state", "not in", ["done", "cancel"]]],
      await availableFields(session, M("MODEL_MOVE_LINE"), ["id", "reserved_uom_qty", "quantity", "picked"]), 500);
  }

  // ── 3. Créer les N colis, poids inclus dès la création ──────────────────────
  //     Un create par colis, lancés EN PARALLÈLE : c'est déjà une seule vague
  //     d'allers-retours, exactement comme un multi-create, mais sans dépendre
  //     du comportement d'Odoo sur create([{...},{...}]) — un multi-create qui
  //     retourne autre chose qu'une liste d'ids donne 1 seul colis, donc 1 seule
  //     étiquette transporteur au lieu de N.
  const totalWeight = packageWeights.reduce((s, w) => s + w, 0);
  // Résolu une fois avant la vague parallèle : le nom du modèle colis change
  // selon la version d'Odoo (voir packageModel).
  const pkgModel = await packageModel(session);
  const packageIds: number[] = await Promise.all(
    packageWeights.map(w =>
      // shipping_weight au create ; si la version d'Odoo le refuse ici, la vague
      // 4a le réécrit juste après.
      (create(session, pkgModel, { shipping_weight: w }) as Promise<number>)
        .catch(() => create(session, pkgModel, {}) as Promise<number>)
    )
  );
  if (packageIds.length !== nPackages || packageIds.some(id => !id)) {
    throw new Error(`Création des colis incomplète (${packageIds.filter(Boolean).length}/${nPackages})`);
  }

  // ── 4. Une seule vague parallèle pour tout le reste ──────────────────────────
  const tasks: Promise<any>[] = [];

  // 4a. Filet de sécurité sur le poids : certaines versions Odoo ignorent
  //     shipping_weight au create. Groupé par valeur pour limiter les appels.
  const pkgsByWeight: Record<number, number[]> = {};
  packageIds.forEach((id, i) => { (pkgsByWeight[packageWeights[i]] ||= []).push(id); });
  for (const [w, ids] of Object.entries(pkgsByWeight)) {
    tasks.push(write(session, pkgModel, ids, { shipping_weight: parseFloat(w) }).catch(() => null));
  }

  // 4b. fait = attendu (groupé par quantité pour batcher les writes).
  //     Version-agnostique : en Odoo 17+ on écrit quantity + picked.
  const _shape = await compat.detectStockShape(m =>
    call(session, "/web/dataset/call_kw", { model: m, method: "fields_get", args: [], kwargs: { attributes: ["type"] } }),
    M("MODEL_MOVE_LINE"));
  const mlsToFill = moveLines.filter((ml: any) => compat.lineExpected(ml, _shape) > 0);
  if (mlsToFill.length) {
    const byQty: Record<number, number[]> = {};
    for (const ml of mlsToFill) {
      const q = compat.lineExpected(ml, _shape);
      if (!byQty[q]) byQty[q] = [];
      byQty[q].push(ml.id);
    }
    for (const [qtyStr, ids] of Object.entries(byQty)) {
      tasks.push(write(session, M("MODEL_MOVE_LINE"), ids, compat.doneVals(parseFloat(qtyStr), _shape)));
    }
  }

  // 4c. Distribuer les move lines en round-robin sur les N colis
  //     → chaque colis reçoit du contenu → TNT génère 1 étiquette par colis
  if (moveLines.length && packageIds.length) {
    const mlsByPkg: Record<number, number[]> = {};
    for (let i = 0; i < moveLines.length; i++) {
      const pkgId = packageIds[i % packageIds.length];
      if (!mlsByPkg[pkgId]) mlsByPkg[pkgId] = [];
      mlsByPkg[pkgId].push(moveLines[i].id);
    }
    for (const [pkgId, ids] of Object.entries(mlsByPkg)) {
      tasks.push(write(session, M("MODEL_MOVE_LINE"), ids, { result_package_id: Number(pkgId) }));
    }
  }

  // 4d. Si nPackages > moveLines.length, certains colis n'ont pas de lignes
  const assignedCount = Math.min(moveLines.length, packageIds.length);
  for (let i = assignedCount; i < packageIds.length; i++) {
    tasks.push(
      create(session, M("MODEL_PACKAGE_LEVEL"), {
        package_id: packageIds[i], picking_id: outPickingId, is_done: true,
      }).catch(() => null)
    );
  }

  // 4e. Nb colis + poids total sur le picking
  tasks.push(
    write(session, M("MODEL_PICKING"), [outPickingId], {
      number_of_packages: nPackages,
      shipping_weight: totalWeight,
    }).catch(() =>
      write(session, M("MODEL_PICKING"), [outPickingId], { shipping_weight: totalWeight }).catch(() => null)
    )
  );

  await Promise.all(tasks);

  // ── 4c. Date d'expédition : jamais dans le passé ────────────────────────────
  //
  // Le transporteur refuse une expédition datée d'hier — TNT répond
  // « The field 'shippingDate' is not valid. » et l'envoi échoue.
  //
  // Le cas est banal : une commande préparée physiquement un jour et expédiée le
  // lendemain garde la date prévue de sa préparation. Le champ Studio
  // « Date d'expédition prévue » ne corrige rien, ce n'est pas celui que le
  // module transporteur lit (vérifié sur S71761 : modifier la Date prévue du OUT
  // débloque l'envoi, le champ Studio non).
  //
  // On ne repousse QUE si la date est révolue, et jamais au-delà : une date
  // future volontaire (expédition programmée) est respectée telle quelle.
  try {
    const [cur] = await searchRead(session, M("MODEL_PICKING"), [["id", "=", outPickingId]], ["scheduled_date"], 1);
    const prevue = cur?.scheduled_date ? new Date(String(cur.scheduled_date).replace(" ", "T") + "Z") : null;
    const debutDuJour = new Date();
    debutDuJour.setUTCHours(0, 0, 0, 0);
    if (prevue && prevue < debutDuJour) {
      const maintenant = new Date().toISOString().replace("T", " ").slice(0, 19);
      await write(session, M("MODEL_PICKING"), [outPickingId], { scheduled_date: maintenant });
      console.warn(`[WMS] ${pickingName} : date prévue ${cur.scheduled_date} révolue, repoussée à ${maintenant} (refus transporteur sinon)`);
    }
  } catch (e: any) {
    // Confort : si la lecture échoue, on laisse l'expédition suivre son cours
    // plutôt que de bloquer un emballage pour une date.
    console.warn("[WMS] Date d'expédition non vérifiée :", e?.message || e);
  }

  // ── 5. BL lancé EN PARALLÈLE de la validation ───────────────────────────────
  //     La génération du PDF côté Odoo (wkhtmltopdf) coûte 1 à 3 s ; la faire
  //     pendant button_validate au lieu d'après supprime ce temps du ressenti.
  //     ⚠ Contrepartie : le PDF est rendu juste AVANT le passage en `done`.
  //     Si le BL imprimé affichait de mauvaises quantités, passer blParallel:false
  //     rétablit exactement le comportement précédent.
  const startBl = () => printOptions?.blPrinterId
    ? printPickingReportDirect(session, outPickingId, printOptions.blPrinterId, {
        reportName:  printOptions.blReportName || getSavedPrepReportName(),
        title:       `BL_${pickingName}.pdf`,
        overlayDate: printOptions.overlayDate,
      })
    : Promise.resolve({ success: false, error: undefined as string | undefined });

  const blParallel   = printOptions?.blParallel !== false;
  const earlyBl      = blParallel ? startBl() : null;

  // ── 6. Validation du picking : SEULE étape réellement bloquante ─────────────
  await validatePicking(session, outPickingId);

  const blPromise = earlyBl ?? startBl();

  // ── 7. Étiquettes transporteur : polling en tâche de fond ───────────────────
  //     Ne bloque plus le retour de la fonction : l'appelant affiche le succès
  //     immédiatement et suit `labelsPromise` pour lancer l'impression.
  //     ⚠ On attend N étiquettes, pas une seule. TNT/SendCloud écrit les pièces
  //     jointes une par une : s'arrêter à la première (ce que faisait la version
  //     précédente) ne fait imprimer qu'UNE étiquette pour un envoi en 3 colis.
  //     On continue donc jusqu'à en avoir `expected`, et une fois la première
  //     arrivée on laisse encore LABEL_SETTLE_MS aux suivantes avant d'abandonner.
  //     Une erreur réseau ponctuelle n'interrompt pas la boucle.
  const LABEL_SETTLE_MS = 6000;
  const pollLabels = async (maxMs: number, intervalMs: number, expected: number): Promise<any[]> => {
    const deadline = Date.now() + maxMs;
    let best: any[] = [];
    let firstSeenAt = 0;
    while (Date.now() < deadline) {
      try {
        const atts = await searchRead(session, M("MODEL_ATTACHMENT"),
          [["res_model", "=", M("MODEL_PICKING")], ["res_id", "=", outPickingId], ["mimetype", "ilike", "pdf"]],
          ["id", "name", "datas", "create_date"], 100);
        const fresh = atts.filter((a: any) => !existingIds.has(a.id));
        if (fresh.length > best.length) {
          best = fresh;
          if (!firstSeenAt) firstSeenAt = Date.now();
        }
        if (best.length >= expected) return best;                              // toutes reçues
        if (firstSeenAt && Date.now() - firstSeenAt > LABEL_SETTLE_MS) return best; // les retardataires ne viendront plus
      } catch { /* on retente au tour suivant */ }
      await new Promise(r => setTimeout(r, intervalMs));
    }
    return best;
  };

  // Canal séparé pour le refus transporteur : labelsPromise ne renvoie que des
  // pièces jointes, elle ne peut pas porter la raison d'une absence.
  let signalerErreurEnvoi: (e: string | null) => void = () => {};
  const shipErrorPromise = new Promise<string | null>(r => { signalerErreurEnvoi = r; });

  const labelsPromise: Promise<any[]> = !hasCarrier
    // Pas de transporteur → aucune étiquette à attendre, on ne poll même pas.
    ? (signalerErreurEnvoi(null), Promise.resolve([]))
    : (async () => {
        // Odoo appelle normalement send_to_shipper dans button_validate :
        // les étiquettes sont souvent déjà là. Polling serré d'abord.
        // On attend les nPackages étiquettes, pas seulement la première.
        const quick = await pollLabels(8000, 300, nPackages);
        if (quick.length >= nPackages) return quick;

        // ⚠⚠ NE JAMAIS relancer send_to_shipper si une étiquette existe déjà.
        // Un 2e appel recrée un envoi TNT COMPLET : sur 8 colis, ça génère 8
        // étiquettes supplémentaires (donc impression en double) ET un second
        // numéro de suivi facturé. On ne le déclenche que si RIEN n'est parti :
        // zéro pièce jointe ET aucun numéro de suivi sur le picking.
        if (quick.length === 0) {
          let alreadyShipped = false;
          try {
            const [p] = await searchRead(session, M("MODEL_PICKING"),
              [["id", "=", outPickingId]], ["carrier_tracking_ref"], 1);
            alreadyShipped = !!p?.carrier_tracking_ref;
          } catch {
            // Doute sur l'état → on s'abstient. Mieux vaut aucune étiquette
            // imprimée qu'un second envoi transporteur facturé.
            alreadyShipped = true;
          }
          if (!alreadyShipped) {
            try {
              await callMethod(session, M("MODEL_PICKING"), "send_to_shipper", [[outPickingId]]);
            } catch (e: any) {
              // On NE masque plus : le refus du transporteur est la seule
              // explication de l'absence d'étiquette, et l'opérateur doit la voir.
              signalerErreurEnvoi(safeErrMsg?.(e) || e?.message || String(e));
            }
          }
        }

        // Étiquettes partiellement arrivées (ou envoi relancé) : on attend
        // simplement les suivantes, sans jamais re-solliciter le transporteur.
        const late = await pollLabels(30_000, 1500, nPackages);
        const res = late.length >= quick.length ? late : quick;
        // Aucune étiquette et aucun refus explicite : on le dit quand même, sinon
        // l'écran affiche « expédié » pour une expédition qui n'a pas eu lieu.
        signalerErreurEnvoi(res.length === 0
          ? "Aucune étiquette reçue du transporteur — vérifie le bon dans Odoo (bouton « Envoyer à l\u2019expéditeur »)"
          : null);
        return res;
      })();

  return {
    pickingName,
    labelAttachments: [],
    labelsPending:    hasCarrier,
    blPrinted:        false,
    blPromise,
    labelsPromise,
    shipErrorPromise,
  };
}

/** Valide un picking satellite (commande groupée) SANS transporteur.
 *  Pas de colis créé, pas de send_to_shipper — juste qty_done + validate.
 *  Le BL part en parallèle de la validation et est renvoyé sous forme de
 *  promesse : l'appelant affiche le résultat sans attendre l'imprimante.
 */
export async function validateSatellitePicking(
  session: OdooSession,
  pickingId: number,
  printOptions?: { blPrinterId?: number; blReportName?: string; overlayDate?: string; blParallel?: boolean }
): Promise<{ name: string; blPrinted: boolean; blError?: string; blPromise: Promise<{ success: boolean; error?: string }> }> {
  // Nom + move lines en parallèle. action_assign est omis : les satellites sont
  // sélectionnés avec state="assigned", la réservation est donc déjà faite.
  const [infoList, moveLines] = await Promise.all([
    searchRead(session, M("MODEL_PICKING"), [["id", "=", pickingId]], ["name", "state"], 1),
    searchRead(session, M("MODEL_MOVE_LINE"),
      [["picking_id", "=", pickingId], ["state", "not in", ["done", "cancel"]]],
      await availableFields(session, M("MODEL_MOVE_LINE"), ["id", "reserved_uom_qty", "quantity", "picked"]), 500),
  ]);
  const info = infoList[0];
  const pickingName = info?.name || `OUT-${pickingId}`;

  let mls = moveLines;
  if (info?.state && info.state !== "assigned") {
    await callMethod(session, M("MODEL_PICKING"), "action_assign", [[pickingId]]).catch(() => null);
    mls = await searchRead(session, M("MODEL_MOVE_LINE"),
      [["picking_id", "=", pickingId], ["state", "not in", ["done", "cancel"]]],
      await availableFields(session, M("MODEL_MOVE_LINE"), ["id", "reserved_uom_qty", "quantity", "picked"]), 500);
  }

  const _shapeSat = await compat.detectStockShape(m =>
    call(session, "/web/dataset/call_kw", { model: m, method: "fields_get", args: [], kwargs: { attributes: ["type"] } }),
    M("MODEL_MOVE_LINE"));
  const mlsToFill = mls.filter((ml: any) => compat.lineExpected(ml, _shapeSat) > 0);
  if (mlsToFill.length) {
    const byQty: Record<number, number[]> = {};
    for (const ml of mlsToFill) {
      const q = compat.lineExpected(ml, _shapeSat);
      if (!byQty[q]) byQty[q] = [];
      byQty[q].push(ml.id);
    }
    await Promise.all(
      Object.entries(byQty).map(([qtyStr, ids]) =>
        write(session, M("MODEL_MOVE_LINE"), ids, compat.doneVals(parseFloat(qtyStr), _shapeSat))
      )
    );
  }

  const startBl = () => printOptions?.blPrinterId
    ? printPickingReportDirect(session, pickingId, printOptions.blPrinterId, {
        reportName:  printOptions.blReportName || getSavedPrepReportName(),
        title:       `BL_${pickingName}.pdf`,
        overlayDate: printOptions.overlayDate,
      })
    : Promise.resolve({ success: false, error: undefined as string | undefined });

  const earlyBl = printOptions?.blParallel !== false ? startBl() : null;

  await validatePicking(session, pickingId);

  const blPromise = earlyBl ?? startBl();
  blPromise.catch(() => ({ success: false }));

  return { name: pickingName, blPrinted: false, blPromise };
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
  return searchRead(session, M("MODEL_PICKING"),
    domain,
    ["id", "name", "origin", "partner_id", "carrier_id", "carrier_tracking_ref", "date_done", "state"],
    50, "date_done desc"
  );
}

// Recherche un OUT par numéro de commande (origin) ou numéro OUT — tous états
// Cherche UNIQUEMENT sur origin et name pour éviter les faux-positifs sur partenaire/tracking
/**
 * Coordonnées de livraison d'un transfert, prêtes pour un affranchissement.
 *
 * Le préparateur ne doit rien retaper : tout est déjà dans Odoo. On accepte
 * indifféremment le nom du OUT, celui du pick ou la référence de commande —
 * sur le terrain, c'est le papier sous la main qui décide de ce qu'on scanne.
 *
 * Le poids est repris du transfert quand Odoo le connaît. Sinon il est laissé
 * à zéro et devra être saisi : deviner un poids, c'est affranchir faux.
 */
export interface LivraisonColissimo {
  pickingId: number;
  pickingName: string;
  origin: string;
  state: string;
  transporteur: string;
  suiviExistant: string;
  nom: string;
  societe: string;
  adresse: string;
  adresse2: string;
  cp: string;
  ville: string;
  pays: string;
  email: string;
  telephone: string;
  poids: number;
  /** Ce qui manque pour affranchir — vide si tout est là. */
  manquants: string[];
}

export async function chargerLivraison(session: OdooSession, ref: string): Promise<LivraisonColissimo | null> {
  const pickings = await searchPickingByCommande(session, ref);
  if (!pickings.length) return null;
  // Le OUT le plus récent : c'est celui qu'on est en train d'expédier.
  const p = pickings[0];

  const partnerId = Array.isArray(p.partner_id) ? p.partner_id[0] : p.partner_id;
  let adr: any = {};
  if (partnerId) {
    const [c] = await searchRead(session, "res.partner", [["id", "=", partnerId]],
      ["id", "name", "street", "street2", "zip", "city", "country_id", "email", "phone", "mobile", "parent_id", "is_company"], 1);
    adr = c || {};
  }

  // Poids : Odoo le porte sur le transfert quand un transporteur est renseigné.
  let poids = 0;
  try {
    const champs = await knownFields(session, M("MODEL_PICKING"));
    const dispo = ["shipping_weight", "weight"].filter(f => !champs || champs.has(f));
    if (dispo.length) {
      const [w] = await searchRead(session, M("MODEL_PICKING"), [["id", "=", p.id]], ["id", ...dispo], 1);
      for (const f of dispo) { const v = Number(w?.[f]) || 0; if (v > 0) { poids = v; break; } }
    }
  } catch { /* poids inconnu : saisie manuelle */ }

  const pays = Array.isArray(adr.country_id) ? String(adr.country_id[1] || "") : "";
  // Odoo ne donne que le libellé du pays sur ce champ relationnel. On ne garde
  // le code que pour la France, seul cas courant ici ; le reste sera choisi à
  // l'écran plutôt que déduit d'une traduction.
  const codePays = /france/i.test(pays) ? "FR" : "";

  const nom = String(adr.name || "").trim();
  const societe = adr.is_company ? nom : (Array.isArray(adr.parent_id) ? String(adr.parent_id[1] || "") : "");

  const manquants: string[] = [];
  if (!nom) manquants.push("nom du destinataire");
  if (!adr.street) manquants.push("adresse");
  if (!adr.zip) manquants.push("code postal");
  if (!adr.city) manquants.push("ville");
  if (!(poids > 0)) manquants.push("poids");

  return {
    pickingId: p.id,
    pickingName: p.name || "",
    origin: p.origin || "",
    state: p.state || "",
    transporteur: Array.isArray(p.carrier_id) ? String(p.carrier_id[1] || "") : "",
    suiviExistant: String(p.carrier_tracking_ref || ""),
    nom,
    societe: societe === nom ? "" : societe,
    adresse: String(adr.street || ""),
    adresse2: String(adr.street2 || ""),
    cp: String(adr.zip || ""),
    ville: String(adr.city || ""),
    pays: codePays,
    email: String(adr.email || ""),
    telephone: String(adr.mobile || adr.phone || ""),
    poids,
    manquants,
  };
}

/** Inscrit le numéro de colis sur le transfert, pour le retrouver depuis Odoo. */
export async function ecrireSuiviColissimo(
  session: OdooSession, pickingId: number, numero: string,
): Promise<void> {
  if (!numero) return;
  await write(session, M("MODEL_PICKING"), [pickingId], { carrier_tracking_ref: numero });
}

export async function searchPickingByCommande(session: OdooSession, ref: string): Promise<any[]> {
  const trimmed = ref.trim();
  const domain: any[] = [
    ["picking_type_code", "=", "outgoing"],
    ["state", "in", ["done", "assigned", "waiting", "confirmed"]],
    "|",
      ["origin", "=", trimmed],      // correspondance exacte d'abord
      ["name", "=", trimmed],
  ];
  let results = await searchRead(session, M("MODEL_PICKING"),
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
    results = await searchRead(session, M("MODEL_PICKING"),
      domain2,
      ["id", "name", "origin", "partner_id", "carrier_id", "carrier_tracking_ref", "date_done", "state"],
      20, "date_done desc"
    );
  }
  return results;
}

// Récupère les pièces jointes PDF d'un picking (labels transporteur)
export async function getPickingAttachments(session: OdooSession, pickingId: number): Promise<any[]> {
  return searchRead(session, M("MODEL_ATTACHMENT"),
    [["res_model", "=", M("MODEL_PICKING")], ["res_id", "=", pickingId], ["mimetype", "ilike", "pdf"]],
    ["id", "name", "datas", "mimetype", "create_date"],
    20
  );
}

// Re-déclenche l'envoi au transporteur (peut fonctionner si le picking est toujours accessible)
export async function resendToShipper(session: OdooSession, pickingId: number): Promise<void> {
  await callMethod(session, M("MODEL_PICKING"), "send_to_shipper", [[pickingId]]);
}

export async function validatePicking(session: OdooSession, pickingId: number) {
  const result = await callMethod(session, M("MODEL_PICKING"), "button_validate", [[pickingId]]);

  // Handle Odoo wizards
  if (result && typeof result === "object" && result.res_model) {
    const wizardModel = result.res_model;
    const wizardId = result.res_id;
    const ctx = result.context || {};

    if (wizardModel === M("MODEL_IMMEDIATE_TRANSFER")) {
      await call(session, "/web/dataset/call_kw", {
        model: M("MODEL_IMMEDIATE_TRANSFER"), method: "process", args: [[wizardId]], kwargs: { context: ctx },
      });
    } else if (wizardModel === M("MODEL_BACKORDER_CONFIRM")) {
      await call(session, "/web/dataset/call_kw", {
        model: M("MODEL_BACKORDER_CONFIRM"), method: "process", args: [[wizardId]], kwargs: { context: ctx },
      });
    }
  }

  return result;
}

// Comme validatePicking mais REFUSE de créer un reliquat.
// Lève une erreur avec la liste des articles manquants si Odoo veut un backorder.
export async function validatePickingStrict(session: OdooSession, pickingId: number): Promise<void> {
  const result = await callMethod(session, M("MODEL_PICKING"), "button_validate", [[pickingId]]);

  if (result && typeof result === "object" && result.res_model) {
    const wizardModel = result.res_model;
    const wizardId = result.res_id;
    const ctx = result.context || {};

    if (wizardModel === M("MODEL_IMMEDIATE_TRANSFER")) {
      // Qtés non renseignées → OK, on force avec les qtés réservées
      await call(session, "/web/dataset/call_kw", {
        model: M("MODEL_IMMEDIATE_TRANSFER"), method: "process", args: [[wizardId]], kwargs: { context: ctx },
      });
    } else if (wizardModel === M("MODEL_BACKORDER_CONFIRM")) {
      // Récupérer les lignes incomplètes pour afficher un message utile
      const missing = await searchRead(session, M("MODEL_MOVE_LINE"),
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
    session, M("MODEL_PRODUCT_SUPPLIER"),
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
      session, M("MODEL_PRODUCT"),
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
      session, M("MODEL_PRODUCT"),
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

// Cache en mémoire des SKU déjà reconnus (vidé au rechargement de la page).
// Évite de relancer tout le matching Odoo à chaque poll (toutes les 90 s) et à
// chaque ouverture de la roue crantée / du chariot pour des SKU inchangés.
// On ne cache QUE les matchs positifs : un SKU non trouvé sera réessayé (il peut
// être corrigé côté Odoo entre-temps).
const _eshopMatchCache = new Map<string, EshopMatchResult>();
export function clearEshopMatchCache() { _eshopMatchCache.clear(); }

// Exécute des tâches asynchrones en parallèle avec une concurrence limitée.
// Remplace les boucles `for … await` séquentielles (1 requête à la fois) sans
// pour autant saturer le proxy Odoo (limite 300 req/60 s) : ~10 en vol max.
async function parallelLimit<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx]);
    }
  });
  await Promise.all(runners);
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

  // Cache mémoire : sert immédiatement les SKU déjà reconnus, sans requête Odoo.
  for (const sku of skus) {
    const hit = _eshopMatchCache.get(sku);
    if (hit) { result[sku] = hit; remaining.delete(sku); }
  }
  if (remaining.size === 0) return result; // tout servi depuis le cache

  // Helper — enrichit un product.product et le met dans result (+ cache)
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

  // Mémorise les matchs trouvés (positifs) avant de renvoyer, pour que les
  // prochains appels les servent depuis le cache mémoire sans requête Odoo.
  const finalize = (): Record<string, EshopMatchResult> => {
    for (const [sku, m] of Object.entries(result)) {
      if (m && m.product_id) _eshopMatchCache.set(sku, m);
    }
    return result;
  };

  // ── Stratégie 1 : référence fournisseur ──────────────────────────────────
  const skusToMatch = Array.from(remaining);
  const supplierInfos = await searchRead(
    session, M("MODEL_PRODUCT_SUPPLIER"),
    [["product_code", "in", skusToMatch]],
    ["id", "product_code", "product_id", "product_tmpl_id"],
    skusToMatch.length * 3
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
      session, M("MODEL_PRODUCT"),
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
    const products = await searchRead(session, M("MODEL_PRODUCT"), [["id", "in", ids]], ["id", "name", "default_code", "barcode"], ids.length);
    const pMap: Record<number, any> = {};
    for (const p of products) pMap[p.id] = p;
    for (const [sku, val] of needsEnrich) {
      const p = pMap[val.product_id];
      if (p) { result[sku].default_code = p.default_code || ""; result[sku].barcode = p.barcode || ""; result[sku].product_name = p.name; }
    }
  }

  if (remaining.size === 0) return finalize();

  // ── Stratégie 1bis : référence Odoo (default_code) ───────────────────────
  // Si la réf fournisseur n'a rien donné, on tente la réf interne Odoo.
  const remainingForRef = Array.from(remaining);
  const byDefaultCode = await searchRead(
    session, M("MODEL_PRODUCT"),
    [["default_code", "in", remainingForRef]],
    ["id", "name", "default_code", "barcode"],
    remainingForRef.length
  );
  for (const p of byDefaultCode) {
    const sku = remainingForRef.find(s => s === p.default_code);
    if (sku && remaining.has(sku)) addMatch(sku, p, "ref");
  }

  if (remaining.size === 0) return finalize();

  // ── Stratégie 2 : EAN / barcode ──────────────────────────────────────────
  const remainingArr = Array.from(remaining);
  const byBarcode = await searchRead(
    session, M("MODEL_PRODUCT"),
    [["barcode", "in", remainingArr]],
    ["id", "name", "default_code", "barcode"],
    remainingArr.length
  );
  for (const p of byBarcode) {
    const sku = remainingArr.find(s => s === p.barcode);
    if (sku) addMatch(sku, p, "barcode");
  }

  if (remaining.size === 0) return finalize();

  // ── Stratégie 2bis : réf fournisseur / réf Odoo insensible casse-format ───
  // Repli quand "=" exact a raté (casse, espaces parasites, zéro initial…).
  // Parallélisé (concurrence limitée) : avant, chaque SKU était traité en série.
  await parallelLimit(Array.from(remaining), 10, async (sku) => {
    const s = sku.trim();
    if (!s) return;
    // a) réf fournisseur (product.supplierinfo.product_code) en =ilike
    const si = await searchRead(
      session, M("MODEL_PRODUCT_SUPPLIER"),
      [["product_code", "=ilike", s]],
      ["product_id", "product_tmpl_id"], 1
    );
    let prod: any = null;
    if (si.length && si[0].product_id) {
      const pid = si[0].product_id[0];
      const ps = await searchRead(session, M("MODEL_PRODUCT"), [["id", "=", pid]], ["id", "name", "default_code", "barcode"], 1);
      if (ps.length) prod = ps[0];
    } else if (si.length && si[0].product_tmpl_id) {
      const ps = await searchRead(session, M("MODEL_PRODUCT"), [["product_tmpl_id", "=", si[0].product_tmpl_id[0]]], ["id", "name", "default_code", "barcode"], 1);
      if (ps.length) prod = ps[0];
    }
    // b) sinon réf Odoo (default_code) en =ilike, actifs ou archivés
    if (!prod) {
      const ps = await searchRead(session, M("MODEL_PRODUCT"), [["default_code", "=ilike", s], ["active", "in", [true, false]]], ["id", "name", "default_code", "barcode"], 1);
      if (ps.length) prod = ps[0];
    }
    if (prod) addMatch(sku, prod, "ref");
  });

  if (remaining.size === 0) return finalize();

  // ── Stratégie 3 : nom similaire (ilike) ──────────────────────────────────
  // On cherche chaque SKU restant comme fragment de nom — parallélisé aussi.
  await parallelLimit(Array.from(remaining), 10, async (sku) => {
    const fragment = sku.replace(/[-_]/g, " ").replace(/\s+/g, " ").trim();
    if (fragment.length < 3) return;
    const found = await searchRead(
      session, M("MODEL_PRODUCT"),
      [["name", "ilike", fragment], ["active", "in", [true, false]]],
      ["id", "name", "default_code", "barcode"],
      1
    );
    if (found.length > 0) addMatch(sku, found[0], "name");
  });

  if (remaining.size === 0) return finalize();

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
      session, M("MODEL_PRODUCT_SUPPLIER"),
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
        session, M("MODEL_PRODUCT"),
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
      const products = await searchRead(session, M("MODEL_PRODUCT"), [["id", "in", ids]], ["id", "name", "default_code", "barcode"], ids.length);
      const pMap: Record<number, any> = {};
      for (const p of products) pMap[p.id] = p;
      for (const s of lrNeedsEnrich) {
        const p = pMap[result[s].product_id];
        if (p) { result[s].default_code = p.default_code || ""; result[s].barcode = p.barcode || ""; result[s].product_name = p.name; }
      }
    }

    // b) secours : réf interne (default_code) puis barcode sur le code nettoyé
    const stillLr = lrSkus.filter(s => remaining.has(s));
    await parallelLimit(stillLr, 10, async (sku) => {
      const clean = sku.trim().replace(/^LR/i, "");
      if (!clean) return;
      let found = await searchRead(
        session, M("MODEL_PRODUCT"),
        [["default_code", "=ilike", clean], ["active", "in", [true, false]]],
        ["id", "name", "default_code", "barcode"], 1
      );
      if (!found.length) {
        found = await searchRead(
          session, M("MODEL_PRODUCT"),
          [["barcode", "=", clean]],
          ["id", "name", "default_code", "barcode"], 1
        );
      }
      if (found.length > 0) addMatch(sku, found[0], "supplier_ref");
    });

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

  return finalize();
}

// Get main stock location for product IDs (where most qty is stored)
// DIAGNOSTIC TNT : inspecte les enregistrements tnt.shipping.service liés à un OUT,
// pour comprendre comment cibler/appliquer un service (ex: "JE") via set_service.
// Diag : inspecte une commande (par n°, ex "S12345") et liste les champs liés à
// la facturation/force_invoiced, + la valeur actuelle sur cette commande.
export async function debugSaleOrderFields(session: OdooSession, orderName: string): Promise<any> {
  const out: any = { order: orderName };
  try {
    const fields = await callMethod(session, M("MODEL_SALE_ORDER"), "fields_get", [], { attributes: ["string", "type"] });
    const keys = Object.keys(fields || {});
    // champs dont le nom OU le libellé évoque "facture/invoice/force"
    out.matching = keys
      .filter(k => /force|invoic|factur/i.test(k) || /force|invoic|factur/i.test((fields[k]?.string || "")))
      .map(k => ({ field: k, string: fields[k]?.string, type: fields[k]?.type }));
    // valeur actuelle sur la commande si on la trouve
    try {
      const so = await searchRead(session, M("MODEL_SALE_ORDER"), [["name", "=", orderName.trim()]], ["id", "name", ...out.matching.map((m: any) => m.field)], 1);
      out.current = so[0] || null;
    } catch (e: any) { out.currentError = e.message; }
  } catch (e: any) { out.error = e.message; }
  return out;
}

export async function debugTntService(session: OdooSession, pickingName: string): Promise<any> {
  const out: any = { picking: pickingName };
  try {
    const picks = await searchRead(session, M("MODEL_PICKING"), [["name", "=", pickingName.trim().toUpperCase()]], ["id", "name", "carrier_id"], 1);
    if (!picks.length) return { error: "OUT introuvable" };
    const pick = picks[0];
    out.pickingId = pick.id;
    out.carrier = pick.carrier_id;
    // champs du modèle tnt.shipping.service
    try {
      const fields = await callMethod(session, M("MODEL_TNT_SHIPPING"), "fields_get", [], { attributes: ["string", "type", "relation"] });
      out.serviceFields = Object.keys(fields || {});
      out.serviceFieldsDetail = fields;
    } catch (e: any) { out.serviceFieldsError = e.message; }
    // enregistrements liés à ce picking (on tente plusieurs noms de champ de lien)
    for (const f of ["picking_id", "stock_picking_id", "delivery_id"]) {
      try {
        const recs = await searchRead(session, M("MODEL_TNT_SHIPPING"), [[f, "=", pick.id]], ["id", "display_name", "service_code", "service_label", "due_date"], 20);
        if (recs.length) { out.linkedVia = f; out.services = recs; break; }
      } catch {}
    }
    // si rien trouvé, on prend juste un échantillon du modèle
    if (!out.services) {
      try { out.sample = await searchRead(session, M("MODEL_TNT_SHIPPING"), [], ["id", "display_name", "service_code", "service_label"], 10); } catch (e: any) { out.sampleError = e.message; }
    }
  } catch (e: any) { out.error = e.message; }
  return out;
}

// Applique un service TNT (par défaut "JE" = 13:00 Express) sur le OUT d'un picking.
// Cible la ligne tnt.shipping.service liée au picking dont service_code == code,
// puis appelle la méthode set_service (= bouton "Use Service" d'Odoo).
export async function applyTntService(
  session: OdooSession, pickingId: number, code = "JE"
): Promise<{ ok: boolean; serviceId?: number; reason?: string }> {
  try {
    // 1) Récupérer les services TNT liés à ce picking.
    const recs = await searchRead(
      session, M("MODEL_TNT_SHIPPING"),
      [["picking_id", "=", pickingId]],
      ["id", "service_code", "service_label", "display_name"], 50
    );
    if (!recs.length) return { ok: false, reason: "no-services" };

    // 2) Trouver la ligne dont service_code == code (insensible casse/espaces).
    const want = code.trim().toUpperCase();
    let target = recs.find((r: any) => (r.service_code || "").trim().toUpperCase() === want);
    // Filet de secours : pour JE on vise "13:00 Express - Essentiel Flexibilité" (libellé exact).
    if (!target && want === "JE") target = recs.find((r: any) => /13[:h]?00/.test(String(r.service_label || r.display_name || "")) && /essentiel|flexib/i.test(String(r.service_label || r.display_name || "")));
    if (!target) return { ok: false, reason: "service-not-found" };

    // 3) Appeler set_service sur cet enregistrement.
    await callMethod(session, M("MODEL_TNT_SHIPPING"), "set_service", [[target.id]]);
    return { ok: true, serviceId: target.id };
  } catch (e: any) {
    return { ok: false, reason: e?.message || "error" };
  }
}

// Comme applyTntService, mais déclenche d'abord le calcul des services TNT côté
// picking s'ils n'existent pas encore (équivalent du bouton "GET SERVICE"),
// puis réessaie quelques fois (le calcul peut être asynchrone).
export async function applyTntServiceWithRetry(
  session: OdooSession, pickingId: number, code = "JE"
): Promise<{ ok: boolean; serviceId?: number; reason?: string }> {
  let last = await applyTntService(session, pickingId, code);
  if (last.ok || last.reason !== "no-services") return last;

  // Pas de services encore calculés → tenter de les générer via le picking.
  // On essaie plusieurs noms de méthode possibles selon le module TNT installé.
  const genMethods = ["get_service", "get_services", "action_get_service", "compute_tnt_services", "get_tnt_services"];
  for (const m of genMethods) {
    try { await callMethod(session, M("MODEL_PICKING"), m, [[pickingId]]); break; }
    catch {}
  }
  // Réessais (le calcul peut prendre un instant).
  for (let i = 0; i < 3; i++) {
    await new Promise(r => setTimeout(r, 800));
    last = await applyTntService(session, pickingId, code);
    if (last.ok || last.reason !== "no-services") return last;
  }
  return last;
}

// Prépa libre depuis des OUT Odoo : à partir de n° de bons (WH/OUT/…), renvoie
// les lignes (produit + qté DEMANDÉE) avec l'emplacement WMS (le plus rempli).
export interface OutPrepLine { ref: string; qty: number; name: string; productId: number; location: string; stock: number; found: boolean; }
export async function getOutPickingLines(
  session: OdooSession, pickingNames: string[]
): Promise<{ lines: OutPrepLine[]; foundPickings: string[]; missing: string[] }> {
  const names = Array.from(new Set(pickingNames.map(n => n.trim().toUpperCase()).filter(Boolean)));
  if (!names.length) return { lines: [], foundPickings: [], missing: [] };

  // 1) Trouver les pickings par nom.
  const picks = await searchRead(session, M("MODEL_PICKING"), [["name", "in", names]], ["id", "name"], names.length * 2);
  const foundPickings = picks.map((p: any) => p.name);
  const missing = names.filter(n => !foundPickings.includes(n));
  if (!picks.length) return { lines: [], foundPickings: [], missing: names };

  // 2) Mouvements de ces pickings → produit + qté demandée (product_uom_qty).
  const pickIds = picks.map((p: any) => p.id);
  const moves = await searchRead(session, M("MODEL_MOVE"),
    [["picking_id", "in", pickIds], ["product_uom_qty", ">", 0]],
    ["product_id", "product_uom_qty"], 5000);

  // Cumul par produit.
  const qtyByProd: Record<number, number> = {};
  for (const m of moves) {
    const pid = Array.isArray(m.product_id) ? m.product_id[0] : m.product_id;
    if (pid) qtyByProd[pid] = (qtyByProd[pid] || 0) + (m.product_uom_qty || 0);
  }
  const productIds = Object.keys(qtyByProd).map(Number);
  if (!productIds.length) return { lines: [], foundPickings, missing };

  // 3) Réf/nom + emplacement (le plus rempli).
  const prods = await searchRead(session, M("MODEL_PRODUCT"), [["id", "in", productIds]], ["id", "default_code", "name"], productIds.length);
  const prodMap: Record<number, { ref: string; name: string }> = {};
  for (const p of prods) prodMap[p.id] = { ref: p.default_code || "", name: p.name || "" };
  const locMap = await getProductLocations(session, productIds) as Record<number, any>;

  const lines: OutPrepLine[] = productIds.map(pid => {
    const p = prodMap[pid] || { ref: "", name: "" };
    const loc = locMap[pid];
    return {
      ref: p.ref || String(pid), qty: Math.round(qtyByProd[pid]), name: p.name, productId: pid,
      location: loc ? (loc.location_name || "").split("/").pop() || "—" : "—",
      stock: loc ? Math.round(loc.quantity) : 0, found: true,
    };
  });
  return { lines, foundPickings, missing };
}

export async function getProductLocations(session: OdooSession, productIds: number[]) {
  if (!productIds.length) return {};

  const quants = await searchRead(
    session, M("MODEL_QUANT"),
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
  const existing = await searchRead(session, M("MODEL_ATTACHMENT"), [["name", "=", fileName]], ["id"], 1);
  if (existing.length > 0) {
    await write(session, M("MODEL_ATTACHMENT"), [existing[0].id], { datas: b64 });
  } else {
    await create(session, M("MODEL_ATTACHMENT"), { name: fileName, type: "binary", datas: b64, mimetype: "application/json", public: true });
  }
}

export async function loadPreparedOrders(session: OdooSession): Promise<string[]> {
  const today = new Date().toISOString().split("T")[0];
  const attachments = await searchRead(session, M("MODEL_ATTACHMENT"), [["name", "=", "eshop_prepared_orders.json"]], ["datas"], 1);
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
  const existing = await searchRead(session, M("MODEL_ATTACHMENT"), [["name", "=", fileName]], ["id"], 1);
  if (existing.length > 0) {
    await write(session, M("MODEL_ATTACHMENT"), [existing[0].id], { datas: b64 });
  } else {
    await create(session, M("MODEL_ATTACHMENT"), { name: fileName, type: "binary", datas: b64, mimetype: "application/json", public: true });
  }
}

export async function loadRangedState(session: OdooSession, packingName: string): Promise<string[]> {
  const fileName = `arrivage_ranged_${packingName}.json`;
  const attachments = await searchRead(session, M("MODEL_ATTACHMENT"), [["name", "=", fileName]], ["datas"], 1);
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
  const existing = await searchRead(session, M("MODEL_ATTACHMENT"), [["name", "=", fileName]], ["id"], 1);
  if (existing.length) await callMethod(session, M("MODEL_ATTACHMENT"), "unlink", [[existing[0].id]]);
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
  const existing = await searchRead(session, M("MODEL_ATTACHMENT"), [["name", "=", fileName]], ["id"], 1);
  if (existing.length > 0) {
    await write(session, M("MODEL_ATTACHMENT"), [existing[0].id], { datas: b64 });
    return;
  }
  await create(session, M("MODEL_ATTACHMENT"), { name: fileName, type: "binary", datas: b64, mimetype: "application/json", public: true });
}

export async function loadChariotSkus(session: OdooSession): Promise<string[]> {
  const attachments = await searchRead(session, M("MODEL_ATTACHMENT"), [["name", "=", "eshop_chariot_skus.json"]], ["datas"], 1);
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
  const existing = await searchRead(session, M("MODEL_ATTACHMENT"), [["name", "=", fileName]], ["id"], 1);
  if (existing.length > 0) {
    await write(session, M("MODEL_ATTACHMENT"), [existing[0].id], { datas: b64 });
    return existing[0].id;
  }

  // Create new — no res_model/res_id to avoid permission issues
  return create(session, M("MODEL_ATTACHMENT"), {
    name: fileName,
    type: "binary",
    datas: b64,
    mimetype: "application/json",
    public: true,
  });
}

// ══════════════════════════════════════════
// IMPORT WALA PROGRAMMÉ
// ══════════════════════════════════════════
//
// L'import Wala se fait aujourd'hui à l'arrivée physique de la marchandise, par
// une personne qui sait analyser le fichier fournisseur. Pendant une absence,
// personne ne peut le faire — et la marchandise arrive quand même.
//
// On sépare donc les deux temps : l'analyse est PRÉPARÉE à l'avance, et le
// préparateur n'a qu'un bouton à presser le jour de la livraison.
//
// Stocké en pièce jointe Odoo, comme les listes de prélèvement : visible et
// récupérable depuis Odoo, et ça ne dépend pas d'un navigateur particulier.

const WALA_PENDING_FILE = "wala_import_programme.json";

export interface PendingWalaImport {
  /** Lignes déjà rapprochées des articles Odoo — l'analyse est faite. */
  lines: any[];
  fileName: string;
  invoiceNo: string;
  preparedBy: string;
  preparedAt: string;
  note?: string;
  /** Poste qui a lancé l'import, pour que les autres cessent de le proposer. */
  claimedBy?: string;
  claimedAt?: string;
  /**
   * Ce qui a déjà été fait, pour reprendre après un échec en cours de route.
   *
   * Une fois le bon de commande créé dans Odoo, tout recommencer de zéro n'est
   * plus possible : on note donc l'avancement pour continuer là où ça s'est
   * arrêté, au lieu de laisser une commande orpheline et un opérateur bloqué.
   */
  progress?: {
    poId: number;
    poName: string;
    pickingId: number;
    pickingName: string;
    /** Dernière étape achevée : commande | lots | validation. */
    etape: "commande" | "lots" | "validation";
    at: string;
  };
}

export async function savePendingWalaImport(session: OdooSession, data: PendingWalaImport): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  let bin = "";
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...Array.from(bytes.slice(i, i + chunk)));
  const b64 = btoa(bin);

  const existing = await searchRead(session, M("MODEL_ATTACHMENT"), [["name", "=", WALA_PENDING_FILE]], ["id"], 1);
  if (existing.length) {
    await write(session, M("MODEL_ATTACHMENT"), [existing[0].id], { datas: b64 });
    return;
  }
  await create(session, M("MODEL_ATTACHMENT"), {
    name: WALA_PENDING_FILE, type: "binary", datas: b64,
    mimetype: "application/json", public: true,
  });
}

export async function loadPendingWalaImport(session: OdooSession): Promise<PendingWalaImport | null> {
  const atts = await searchRead(session, M("MODEL_ATTACHMENT"),
    [["name", "=", WALA_PENDING_FILE]], ["id", "datas"], 1, "write_date desc");
  if (!atts.length || !atts[0].datas) return null;
  try {
    const bin = atob(atts[0].datas);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch { return null; }
}

/** Supprime l'import programmé — appelé une fois qu'il a été exécuté. */
export async function clearPendingWalaImport(session: OdooSession): Promise<void> {
  const atts = await searchRead(session, M("MODEL_ATTACHMENT"), [["name", "=", WALA_PENDING_FILE]], ["id"], 5);
  if (atts.length) await unlink(session, M("MODEL_ATTACHMENT"), atts.map((a: any) => a.id));
}

/** Au-delà de ce délai, une prise en main est considérée comme abandonnée. */
const WALA_CLAIM_MS = 15 * 60 * 1000;

/**
 * Réserve l'import avant de l'exécuter.
 *
 * Le bouton est visible sur tous les postes. Sans réservation, deux personnes
 * qui appuient à quelques secondes d'intervalle créeraient deux bons de
 * commande et doubleraient le stock — une erreur pénible à défaire.
 *
 * On relit donc l'état partagé au dernier moment : si quelqu'un d'autre est
 * déjà dessus, on refuse en le nommant. La réservation expire au bout de
 * quinze minutes, pour qu'un poste planté ne bloque pas l'arrivage.
 *
 * Ce n'est pas un verrou strict — deux appuis dans la même seconde peuvent
 * encore passer. Ça ferme la fenêtre réaliste, pas toutes les fenêtres.
 */
export async function claimPendingWalaImport(
  session: OdooSession, par: string,
): Promise<{ ok: true; data: PendingWalaImport } | { ok: false; raison: string }> {
  const data = await loadPendingWalaImport(session);
  if (!data) return { ok: false, raison: "L'import a déjà été effectué depuis un autre poste." };

  if (data.claimedBy && data.claimedAt) {
    const age = Date.now() - new Date(data.claimedAt).getTime();
    if (age >= 0 && age < WALA_CLAIM_MS && data.claimedBy !== par) {
      return { ok: false, raison: `Import déjà lancé par ${data.claimedBy}.` };
    }
  }

  const reserve = { ...data, claimedBy: par, claimedAt: new Date().toISOString() };
  await savePendingWalaImport(session, reserve);
  return { ok: true, data: reserve };
}

/** Lève la réservation après un échec, pour qu'un autre poste puisse réessayer. */
export async function releasePendingWalaImport(session: OdooSession): Promise<void> {
  const data = await loadPendingWalaImport(session);
  if (!data) return;
  const { claimedBy, claimedAt, ...reste } = data;
  await savePendingWalaImport(session, reste as PendingWalaImport);
}

// ============================================
// POIDS ARTICLE DÉDUIT DE LA PACKING LIST
// ============================================
//
// Les packing lists WALA donnent le poids net de chaque carton. Quand un carton
// ne contient qu'un seul article, diviser ce poids par la quantité donne le
// poids unitaire — une donnée que personne ne saisit à la main et qui manque
// donc sur beaucoup de fiches Odoo.
//
// Deux réserves assumées, dites à l'écran plutôt que cachées :
//   - le poids net inclut le conditionnement primaire (flacon, étui). C'est le
//     poids à l'expédition, pas le poids du produit seul. Pour du calcul de
//     frais de port, c'est justement celui qu'on veut.
//   - un carton contenant plusieurs articles ne permet aucune attribution : on
//     ne devine pas, on l'ignore.

/** Convertit « 1.234,56 », « 12,345 » ou « 12.345 » en nombre. */
function kgVersNombre(brut: string): number | null {
  if (!brut) return null;
  let s = String(brut).trim();
  const virgule = s.lastIndexOf(",");
  const point = s.lastIndexOf(".");
  // Le séparateur décimal est le dernier des deux ; l'autre sépare les milliers.
  if (virgule > point) s = s.replace(/\./g, "").replace(",", ".");
  else if (point > virgule) s = s.replace(/,/g, "");
  else s = s.replace(",", ".");
  const n = parseFloat(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export interface PoidsSuggere {
  supplierRef: string;
  designation: string;
  productId: number | null;
  defaultCode: string;
  productName: string;
  /** Poids unitaire retenu, en kg. */
  unitaire: number;
  /** Nombre de cartons exploitables ayant servi au calcul. */
  cartons: number;
  /** Écart relatif entre le carton le plus léger et le plus lourd (0 = parfait). */
  dispersion: number;
  /** Poids actuellement renseigné dans Odoo, null si l'article n'est pas rattaché. */
  actuel: number | null;
}

/** Au-delà, deux cartons du même article ne se ressemblent plus assez pour conclure. */
export const POIDS_DISPERSION_MAX = 0.1;

/**
 * Déduit un poids unitaire par article à partir des cartons mono-article.
 *
 * Quand plusieurs cartons portent le même article, on retient la MÉDIANE : une
 * pesée aberrante tirerait une moyenne, pas une médiane. La dispersion est
 * renvoyée pour que l'appelant puisse refuser les cas trop incertains au lieu
 * d'écrire un chiffre douteux dans Odoo.
 */
export async function suggererPoidsArticles(
  session: OdooSession, pallets: any[],
): Promise<{ suggestions: PoidsSuggere[]; ignores: { raison: string; cartons: number }[] }> {
  const parRef: Record<string, { designation: string; poids: number[] }> = {};
  let multiArticles = 0, sansPoids = 0, sansQte = 0, invraisemblables = 0;

  for (const p of pallets || []) {
    for (const c of p.cartons || []) {
      const arts = (c.articles && c.articles.length ? c.articles : [c]).filter((a: any) => a?.supplierRef);
      if (arts.length === 0) continue;
      if (arts.length > 1) { multiArticles++; continue; }

      let net = kgVersNombre(c.netKg);
      const brut = kgVersNombre(c.grossKg);
      if (net == null) { sansPoids++; continue; }

      // Le parseur prend les DEUX derniers nombres de la ligne carton et suppose
      // l'ordre net puis brut. Si la mise en page du PDF change, ils arrivent
      // inversés — et on calculerait avec le poids emballage compris sans que
      // rien ne le signale. Le net ne pouvant pas dépasser le brut, on remet
      // dans l'ordre plutôt que de faire confiance à la position.
      if (brut != null && net > brut) net = brut;

      const qte = Number(arts[0].qtyProduct) || 0;
      if (qte <= 0) { sansQte++; continue; }

      const unitaire = net / qte;
      // Garde-fou grossier : un cosmétique ne pèse ni 0 g ni 50 kg. Une valeur
      // hors de ces bornes vient d'une ligne mal découpée, pas d'une balance.
      if (unitaire <= 0.0005 || unitaire > 50) { invraisemblables++; continue; }

      const ref = String(arts[0].supplierRef);
      if (!parRef[ref]) parRef[ref] = { designation: arts[0].productDesc || "", poids: [] };
      parRef[ref].poids.push(unitaire);
    }
  }

  const refs = Object.keys(parRef);
  if (!refs.length) return { suggestions: [], ignores: ignoresListe(multiArticles, sansPoids, sansQte, invraisemblables) };

  // Rapprochement Odoo : sans article rattaché, un poids ne mène nulle part.
  const matches = await matchSupplierRefs(session, refs);
  const productIds = Array.from(new Set(
    Object.values(matches).map((m: any) => m?.product_id).filter(Boolean))) as number[];

  const actuels: Record<number, { weight: number; code: string; name: string }> = {};
  if (productIds.length) {
    const prods = await searchRead(session, M("MODEL_PRODUCT"),
      [["id", "in", productIds]], ["id", "weight", "default_code", "name"], productIds.length);
    for (const pr of prods) actuels[pr.id] = { weight: Number(pr.weight) || 0, code: pr.default_code || "", name: pr.name || "" };
  }

  const suggestions: PoidsSuggere[] = refs.map(ref => {
    const liste = parRef[ref].poids.slice().sort((a, b) => a - b);
    const milieu = Math.floor(liste.length / 2);
    const mediane = liste.length % 2 ? liste[milieu] : (liste[milieu - 1] + liste[milieu]) / 2;
    const dispersion = liste.length > 1 && liste[0] > 0
      ? (liste[liste.length - 1] - liste[0]) / liste[0] : 0;

    const m: any = matches[ref];
    const pid = m?.product_id || null;
    const info = pid ? actuels[pid] : null;

    return {
      supplierRef: ref,
      designation: parRef[ref].designation,
      productId: pid,
      defaultCode: info?.code || "",
      productName: info?.name || m?.product_name || "",
      // Trois décimales : au gramme près. Au-delà, on afficherait une précision
      // que la source n'a pas.
      unitaire: Math.round(mediane * 1000) / 1000,
      cartons: liste.length,
      dispersion: Math.round(dispersion * 1000) / 1000,
      actuel: info ? info.weight : null,
    };
  }).sort((a, b) => a.supplierRef.localeCompare(b.supplierRef));

  return { suggestions, ignores: ignoresListe(multiArticles, sansPoids, sansQte, invraisemblables) };
}

function ignoresListe(multi: number, sansPoids: number, sansQte: number, invraisemblables = 0) {
  const out: { raison: string; cartons: number }[] = [];
  if (multi) out.push({ raison: "carton contenant plusieurs articles — attribution impossible", cartons: multi });
  if (sansPoids) out.push({ raison: "poids net absent ou illisible sur la packing list", cartons: sansPoids });
  if (sansQte) out.push({ raison: "quantité absente", cartons: sansQte });
  if (invraisemblables) out.push({ raison: "poids unitaire hors bornes (moins d'1 g ou plus de 50 kg) — ligne mal lue", cartons: invraisemblables });
  return out;
}

/**
 * Écrit le poids sur la fiche article.
 *
 * Le champ vit sur product.template : passer par product.product emprunte un
 * champ relié, ce qui marche parfois et échoue silencieusement le reste du
 * temps selon la configuration. On vise donc le modèle porteur.
 */
export async function appliquerPoidsArticle(
  session: OdooSession, productId: number, poids: number,
): Promise<void> {
  if (!(poids > 0)) throw new Error("Poids invalide");
  const [prod] = await searchRead(session, M("MODEL_PRODUCT"),
    [["id", "=", productId]], ["id", "product_tmpl_id"], 1);
  if (!prod) throw new Error("Article introuvable");
  const tmplId = Array.isArray(prod.product_tmpl_id) ? prod.product_tmpl_id[0] : prod.product_tmpl_id;
  if (!tmplId) throw new Error("Modèle d'article introuvable");
  await write(session, "product.template", [tmplId], { weight: poids });
}

/**
 * Remplit automatiquement les poids MANQUANTS.
 *
 * Ne touche jamais à un poids déjà renseigné : une valeur saisie à la main a
 * demandé du travail et vaut mieux qu'une déduction. Les cas trop dispersés
 * sont laissés de côté aussi — ils sont renvoyés pour être arbitrés à l'écran.
 */
export async function remplirPoidsManquants(
  session: OdooSession, suggestions: PoidsSuggere[],
): Promise<{
  ecrits: { ref: string; nom: string; poids: number }[];
  echecs: { ref: string; erreur: string }[];
  ignores: { ref: string; raison: string }[];
}> {
  const ecrits: { ref: string; nom: string; poids: number }[] = [];
  const echecs: { ref: string; erreur: string }[] = [];
  const ignores: { ref: string; raison: string }[] = [];

  for (const s of suggestions) {
    const nom = s.defaultCode || s.supplierRef;
    if (!s.productId) { ignores.push({ ref: nom, raison: "aucun article Odoo rattaché" }); continue; }
    if ((s.actuel ?? 0) > 0) { ignores.push({ ref: nom, raison: `poids déjà renseigné (${s.actuel} kg)` }); continue; }
    if (s.dispersion > POIDS_DISPERSION_MAX) {
      ignores.push({ ref: nom, raison: `cartons incohérents (${Math.round(s.dispersion * 100)} % d'écart)` });
      continue;
    }
    try {
      await appliquerPoidsArticle(session, s.productId, s.unitaire);
      ecrits.push({ ref: nom, nom: s.productName || s.designation, poids: s.unitaire });
    } catch (e: any) {
      echecs.push({ ref: nom, erreur: safeErrMsg(e) });
    }
  }
  return { ecrits, echecs, ignores };
}

export interface WalaImportResult {
  poId: number;
  poName: string;
  pickingId: number;
  pickingName: string;
  lotsCreated: number;
  lotsDuplicate: string[];
  linesCount: number;
  /** Renseigné seulement si la validation a été demandée. */
  validated?: boolean;
  /** Transferts de rangement qu'il reste à traiter à la main dans Odoo. */
  chained?: { id: number; name: string; state: string }[];
  /** Transferts de rangement enchaînés automatiquement, et leur issue. */
  rangements?: { name: string; ok: boolean; erreur?: string }[];
}

/**
 * Import Wala : commande fournisseur, lots, quantités, et validation optionnelle.
 *
 * Extrait de l'écran d'import pour être appelé aussi par le bouton d'arrivage.
 * Deux implémentations de la même chose finissent toujours par diverger — on l'a
 * vérifié aujourd'hui avec searchRead et searchReadAll.
 *
 * REPRISE APRÈS ÉCHEC — une fois le bon de commande créé dans Odoo, il n'y a
 * plus de retour arrière propre. Plutôt que d'annuler et de tout recommencer,
 * l'avancement est remonté à l'appelant après chaque étape franchie ; un
 * nouvel appel avec `reprise` repart de là. Chaque étape est écrite pour
 * supporter d'être rejouée :
 *   - les lots sont récupérés s'ils existent déjà,
 *   - l'affectation des quantités réécrit les mêmes lignes,
 *   - une réception déjà validée n'est pas revalidée,
 *   - seuls les transferts de rangement encore ouverts sont traités.
 *
 * Tant que l'avancement n'est pas enregistré (échec avant toute création), le
 * bon de commande est annulé et supprimé : sans ce retour arrière, chaque
 * tentative ratée laisserait une commande fantôme dans Odoo.
 */
export async function runWalaImport(
  session: OdooSession,
  lines: { productId: number; qty: number; price: number; defaultCode: string; name: string; uomId: number; lotNo: string; expiryDate: string; invoiceNo: string }[],
  opts: {
    validate?: boolean;
    /** Enchaîne aussi les transferts de rangement (voir validateReception). */
    terminerRangement?: boolean;
    /** Avancement d'une tentative précédente : on repart de là au lieu de zéro. */
    reprise?: PendingWalaImport["progress"];
    /** Appelé après chaque étape franchie, pour persister l'avancement. */
    onProgress?: (p: NonNullable<PendingWalaImport["progress"]>) => void | Promise<void>;
    onLog?: (msg: string, state: "running" | "ok" | "warn" | "error") => void;
  } = {},
): Promise<WalaImportResult> {
  const log = opts.onLog || (() => {});
  const lotsDuplicate: string[] = [];
  let lotsCreated = 0;
  let createdPoId: number | null = null;
  const reprise = opts.reprise;

  // L'avancement n'est utile que s'il est connu de l'appelant AVANT l'échec
  // suivant. On le remonte donc au fil de l'eau, sans attendre la fin.
  const avancer = async (po: { poId: number; poName: string; pickingId: number; pickingName: string },
                         etape: "commande" | "lots" | "validation") => {
    createdPoId = null; // à partir d'ici, on reprend au lieu d'annuler
    try {
      await opts.onProgress?.({ ...po, etape, at: new Date().toISOString() });
    } catch { log("Avancement non enregistré — une reprise repartirait du début", "warn"); }
  };

  try {
    log("Recherche du fournisseur WALA Heilmittel GmbH…", "running");
    const partnerId = await getWalaPartnerId(session);
    log(`Fournisseur trouvé (ID ${partnerId})`, "ok");

    const invoiceNo = lines[0]?.invoiceNo || "";

    // GARDE-FOU : la même facture ne peut pas entrer deux fois.
    //
    // Les protections côté écran (rafraîchissement, réservation) ferment la
    // fenêtre courante mais reposent sur l'état d'un navigateur. Celle-ci
    // interroge Odoo, qui est la seule source de vérité : peu importe le poste,
    // le moment, ou le nombre de doigts sur le bouton.
    //
    // Le numéro de facture WALA est reporté dans partner_ref du bon de commande.
    // S'il en existe déjà un, la marchandise est déjà entrée en stock.
    //
    // En reprise, le bon existant est le nôtre : le contrôle se contente alors
    // de vérifier qu'aucun AUTRE bon n'a été créé entre-temps.
    if (invoiceNo) {
      log(`Vérification qu'aucune commande n'existe pour la facture ${invoiceNo}…`, "running");
      const deja = await searchRead(session, M("MODEL_PURCHASE_ORDER"),
        [["partner_ref", "=", invoiceNo], ["state", "!=", "cancel"]], ["id", "name", "state"], 3);
      const etrangers = deja.filter((p: any) => p.id !== reprise?.poId);
      if (etrangers.length) {
        const noms = etrangers.map((p: any) => p.name).join(", ");
        const err: any = new Error(
          `Facture ${invoiceNo} déjà importée — bon de commande ${noms}. ` +
          `Le stock a déjà été mis à jour. Pour réimporter, annulez d'abord ce bon dans Odoo.`);
        // Marqueur : l'écran doit retirer l'import programmé plutôt que de le
        // remettre à disposition. Rien ne sert de laisser un bouton qui échouera.
        err.walaDoublon = true;
        throw err;
      }
      log(`Aucune commande existante pour la facture ${invoiceNo}`, "ok");
    } else {
      // Sans numéro de facture, ce contrôle est aveugle. On le dit plutôt que
      // de laisser croire à une protection qui n'existe pas.
      log("Pas de numéro de facture — le contrôle anti-doublon ne peut pas s'appliquer", "warn");
    }

    let po: { poId: number; poName: string; pickingId: number; pickingName: string; locationId: number; locationDestId: number };
    if (reprise) {
      log(`Reprise de l'import — commande ${reprise.poName} déjà créée`, "warn");
      const loc = await receptionLocations(session, reprise.pickingId);
      po = { ...reprise, ...loc };
    } else {
      log("Création du bon de commande fournisseur…", "running");
      const poLines: WalaPOLine[] = lines.map(l => ({
        productId: l.productId, qty: l.qty, price: l.price,
        name: `[${l.defaultCode}] ${l.name}`, uomId: l.uomId,
      }));
      po = await createAndConfirmPO(session, partnerId, poLines, { partnerRef: invoiceNo });
      createdPoId = po.poId;
      log(`Bon de commande créé et confirmé : ${po.poName}`, "ok");
      log(`Réception générée : ${po.pickingName}`, "ok");
      await avancer(po, "commande");
    }

    // Les lots sont déjà posés sur la réception : les rejouer ne casserait rien
    // (getOrCreateLot les retrouve, setReceptionLots réécrit les mêmes lignes)
    // mais ferait perdre du temps sur une grosse packing list.
    const lotsDejaFaits = reprise?.etape === "lots" || reprise?.etape === "validation";

    if (lotsDejaFaits) {
      log("Lots et quantités déjà affectés lors de la tentative précédente", "ok");
    } else {
      log(`Création des lots (${lines.length} lignes)…`, "running");
      const receptionLines: ReceptionLotLine[] = [];
      const lotIdCache: Record<string, number> = {};
      for (const line of lines) {
        if (!line.lotNo) {
          receptionLines.push({ productId: line.productId, lotId: null, lotName: "", qty: line.qty, uomId: line.uomId });
          continue;
        }
        const key = `${line.productId}|${line.lotNo}`;
        let lotId = lotIdCache[key];
        if (!lotId) {
          const { id, existed } = await getOrCreateLot(session, line.productId, line.lotNo, line.expiryDate);
          lotId = id; lotIdCache[key] = id;
          if (existed) { if (!lotsDuplicate.includes(line.lotNo)) lotsDuplicate.push(line.lotNo); }
          else lotsCreated++;
        }
        receptionLines.push({ productId: line.productId, lotId, lotName: line.lotNo, qty: line.qty, uomId: line.uomId });
      }
      log(lotsDuplicate.length
        ? `Lots traités — ${lotsCreated} créés, ${lotsDuplicate.length} déjà existants (réutilisés)`
        : `${lotsCreated} lots créés`, lotsDuplicate.length ? "warn" : "ok");

      log("Affectation des lots et quantités à la réception…", "running");
      await setReceptionLots(session, po.pickingId, po.locationId, po.locationDestId, receptionLines);
      log("Lots et quantités affectés", "ok");
      await avancer(po, "lots");
    }

    const res: WalaImportResult = {
      poId: po.poId, poName: po.poName,
      pickingId: po.pickingId, pickingName: po.pickingName,
      lotsCreated, lotsDuplicate, linesCount: lines.length,
    };

    if (opts.validate) {
      log("Validation de la réception…", "running");
      const v = await validateReception(session, po.pickingId, {
        terminerRangement: opts.terminerRangement,
        onLog: (m, t) => log(m, (t as any) || "ok"),
      });
      res.validated = v.validated;
      res.chained = v.chained;
      res.rangements = v.rangements;
      // Le stock est entré. Si un rangement échoue, la reprise devra sauter la
      // validation — la rejouer sur une réception déjà « done » lèverait une
      // erreur Odoo et masquerait le vrai problème.
      await avancer(po, "validation");
      const ranges = (v.rangements || []).filter(r => r.ok).length;
      log(v.chained.length
        ? `Réception validée — ${v.chained.length} transfert(s) de rangement à traiter`
        : ranges
          ? `Réception validée et rangée — ${ranges} transfert(s) enchaîné(s), stock à jour`
          : "Réception validée, stock à jour", v.chained.length ? "warn" : "ok");
    } else {
      log("Réception prête à valider dans Odoo", "ok");
    }

    createdPoId = null; // succès : plus de retour arrière à faire
    return res;
  } catch (e: any) {
    if (createdPoId !== null) {
      log("Annulation du bon de commande créé…", "running");
      try { await cancelAndDeletePO(session, createdPoId); log("Bon de commande annulé", "ok"); }
      catch { log("Annulation impossible — à vérifier dans Odoo", "error"); }
    }
    throw e;
  }
}

/**
 * Transferts déclenchés par un bon validé.
 *
 * On suit la CHAÎNE DES MOUVEMENTS plutôt que le nom du bon : c'est la vraie
 * relation entre une réception et le transfert de rangement qu'elle déclenche.
 * Le rapprochement par nom d'origine échouerait dès qu'Odoo nomme le transfert
 * suivant autrement — ce qui dépend du paramétrage.
 */
async function transfertsEnchaines(
  session: OdooSession, pickingId: number,
): Promise<{ id: number; name: string; state: string }[]> {
  const moves = await searchRead(session, M("MODEL_MOVE"),
    [["picking_id", "=", pickingId]],
    await availableFields(session, M("MODEL_MOVE"), ["id", "move_dest_ids"]), 500);
  const destIds = Array.from(new Set(moves.flatMap((m: any) => m.move_dest_ids || [])));
  if (!destIds.length) return [];

  const destMoves = await searchRead(session, M("MODEL_MOVE"),
    [["id", "in", destIds]], ["id", "picking_id", "state"], destIds.length);
  const pickIds = Array.from(new Set(
    destMoves.map((m: any) => (Array.isArray(m.picking_id) ? m.picking_id[0] : m.picking_id)).filter(Boolean),
  ));
  if (!pickIds.length) return [];

  return searchRead(session, M("MODEL_PICKING"),
    [["id", "in", pickIds], ["state", "not in", ["done", "cancel"]]],
    ["id", "name", "state"], pickIds.length);
}

/**
 * Valide une réception fournisseur, et au besoin toute la chaîne qui en découle.
 *
 * En réception multi-étapes, valider le bon fournisseur déclenche un transfert
 * de rangement vers les emplacements de stockage. Tant qu'il n'est pas validé,
 * la marchandise reste en zone d'entrée dans Odoo.
 *
 * `terminerRangement` enchaîne ces transferts automatiquement. C'est un choix
 * lourd de conséquences : valider un rangement, c'est déclarer que la
 * marchandise EST dans les emplacements de destination. À n'activer que si le
 * rangement physique suit réellement ce qu'Odoo décide.
 *
 * Sans cette option, on se contente de signaler ce qui reste : mieux vaut une
 * étape visible en attente qu'un stock annoncé au mauvais endroit.
 */
export async function validateReception(
  session: OdooSession, pickingId: number,
  opts: { terminerRangement?: boolean; onLog?: (m: string, t?: string) => void } = {},
): Promise<{
  validated: boolean;
  chained: { id: number; name: string; state: string }[];
  rangements?: { name: string; ok: boolean; erreur?: string }[];
}> {
  const log = opts.onLog || (() => {});

  // Une réception déjà validée (reprise après échec du rangement) ne doit pas
  // l'être une seconde fois : Odoo lèverait une erreur qui masquerait le vrai
  // problème. On passe directement à la suite de la chaîne.
  const [etat] = await searchRead(session, M("MODEL_PICKING"),
    [["id", "=", pickingId]], ["id", "name", "state"], 1);
  if (etat?.state === "done") {
    log(`Réception ${etat.name} déjà validée — on passe au rangement`, "ok");
  } else {
    await validatePicking(session, pickingId);
  }

  let chained: { id: number; name: string; state: string }[] = [];
  try { chained = await transfertsEnchaines(session, pickingId); }
  catch { /* information de confort : ne doit pas faire échouer la réception */ }

  if (!opts.terminerRangement || !chained.length) return { validated: true, chained };

  // Une chaîne peut compter plus de deux maillons (entrée → contrôle → stock).
  // On déroule donc, avec une borne : une boucle infinie sur des validations
  // Odoo serait bien pire qu'un transfert oublié.
  const rangements: { name: string; ok: boolean; erreur?: string }[] = [];
  const traites = new Set<number>([pickingId]);
  let file = [...chained];

  for (let profondeur = 0; profondeur < 5 && file.length; profondeur++) {
    const suivants: { id: number; name: string; state: string }[] = [];
    for (const t of file) {
      if (traites.has(t.id)) continue;
      traites.add(t.id);
      try {
        // Réserver d'abord : sans réservation, Odoo valide un transfert vide.
        try { await callMethod(session, M("MODEL_PICKING"), "action_assign", [[t.id]]); } catch { /* déjà réservé */ }
        await validatePicking(session, t.id);
        rangements.push({ name: t.name, ok: true });
        log(`Rangement ${t.name} validé`, "ok");
        try { suivants.push(...await transfertsEnchaines(session, t.id)); } catch { /* fin de chaîne */ }
      } catch (e: any) {
        const erreur = safeErrMsg(e);
        rangements.push({ name: t.name, ok: false, erreur });
        log(`Rangement ${t.name} non validé : ${erreur}`, "error");
      }
    }
    file = suivants.filter(s => !traites.has(s.id));
  }

  // On ne renvoie comme « restant à traiter » que ce qui n'est pas passé :
  // annoncer un transfert en attente alors qu'il est fait serait un faux signal.
  const restants = chained.filter(c => !rangements.some(r => r.name === c.name && r.ok))
    .concat(file);

  return { validated: true, chained: restants, rangements };
}

export async function loadPackingList(session: OdooSession, name: string) {
  const fileName = `packing_${name}.json`;
  const attachments = await searchRead(
    session, M("MODEL_ATTACHMENT"),
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
    session, M("MODEL_ATTACHMENT"),
    [["name", "ilike", "packing_"], ["name", "ilike", ".json"]],
    ["id", "name", "write_date", "create_date"],
    50, "write_date desc"
  );
}

export async function deletePackingList(session: OdooSession, attachmentId: number) {
  return callMethod(session, M("MODEL_ATTACHMENT"), "unlink", [[attachmentId]]);
}

// ============================================
// INVENTORY ADJUSTMENTS
// ============================================

// Get all stock.quant ids for a product (with optional lot filter)
export async function getQuantsForProduct(session: OdooSession, productId: number): Promise<any[]> {
  const quants = await searchRead(
    session, M("MODEL_QUANT"),
    [["product_id", "=", productId], ["location_id.usage", "=", "internal"]],
    ["id", "location_id", "lot_id", "quantity", "reserved_quantity", "inventory_quantity"],
    500, "location_id"
  );

  // Enrich lot expiry
  const lotIds = Array.from(new Set(quants.filter((q: any) => q.lot_id).map((q: any) => q.lot_id[0]))) as number[];
  if (lotIds.length > 0) {
    const lots = await searchRead(session, M("MODEL_LOT"), [["id", "in", lotIds]], ["id", "name", "expiration_date", "use_date"], lotIds.length);
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
    session, M("MODEL_PRODUCT"),
    [["id", "in", ids]],
    ["id", "product_tmpl_id", "volume"], ids.length
  );
  const tmplIds = Array.from(new Set(prods.map((p: any) => p.product_tmpl_id?.[0]).filter(Boolean)));
  const _dimField = F("PRODUCT_DIMENSIONS");
  const tmpls = tmplIds.length
    ? await searchRead(session, M("MODEL_PRODUCT_TEMPLATE"), [["id", "in", tmplIds]], ["id", _dimField, "volume"], tmplIds.length)
    : [];
  const tmplMap: Record<number, any> = {};
  for (const t of tmpls) tmplMap[t.id] = t;
  const volByProduct: Record<number, number> = {};
  for (const p of prods) {
    const t = tmplMap[p.product_tmpl_id?.[0]];
    let cm3 = parseDimsToCm3(t?.[_dimField] || "");
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
  await write(session, M("MODEL_QUANT"), [quantId], { inventory_quantity: newQty });

  if (reason?.trim()) {
    // 2a. Avec raison : laisser le wizard appliquer ET nommer (ne pas appeler action_apply_inventory)
    // Le wizard stock.inventory.adjustment.name.action_apply() fait les deux en une fois
    try {
      const wizardId = await create(session, M("MODEL_INVENTORY_ADJ_NAME"), {
        inventory_adjustment_name: reason.trim(),
        quant_ids: [[6, 0, [quantId]]],
      }) as number;
      await callMethod(session, M("MODEL_INVENTORY_ADJ_NAME"), "action_apply", [[wizardId]]);
      return;
    } catch {
      // Si le wizard échoue → fallback sans raison
    }
  }

  // 2b. Sans raison (ou fallback) : appel direct
  await callMethod(session, M("MODEL_QUANT"), "action_apply_inventory", [[quantId]]);
}

// Applique PLUSIEURS ajustements de quant en UNE SEULE opération.
// Indispensable quand des quants se compensent (ex: WH/Sortie −9 et +9 sur le même
// produit/lot) : les appliquer un par un crée des mouvements séparés qui se
// régénèrent l'un l'autre. Ici on écrit tous les inventory_quantity puis on applique
// l'inventaire en un seul appel groupé → les écarts se neutralisent ensemble.
// Applique plusieurs ajustements de quant en respectant un ORDRE précis :
// d'abord les quants dont la qté actuelle est POSITIVE (on les solde), PUIS les
// négatifs. Sinon Odoo recrée la compensation entre un −X et un +X du même
// produit/lot en sortie et l'écart "revient". Chaque quant est appliqué
// individuellement (action_apply_inventory ligne par ligne) dans cet ordre.
export async function applyInventoryAdjustmentBatch(
  session: OdooSession,
  items: { quantId: number; newQty: number; currentQty?: number }[],
  reason?: string
): Promise<void> {
  if (!items.length) return;
  // Tri : positifs (currentQty >= 0) d'abord, négatifs ensuite.
  const ordered = [...items].sort((a, b) => {
    const ca = a.currentQty ?? 0, cb = b.currentQty ?? 0;
    const na = ca < 0 ? 1 : 0, nb = cb < 0 ? 1 : 0;
    if (na !== nb) return na - nb;       // négatifs après
    return cb - ca;                       // plus gros positif d'abord
  });
  for (const it of ordered) {
    await applyInventoryAdjustment(session, it.quantId, it.newQty, reason);
  }
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
  const quantId = await create(session, M("MODEL_QUANT"), vals) as number;
  await callMethod(session, M("MODEL_QUANT"), "action_apply_inventory", [[quantId]]);
  if (reason?.trim()) {
    try {
      const moves = await searchRead(
        session, M("MODEL_MOVE"),
        [["state", "=", "done"], ["product_id", "=", productId],
         ["|", ["location_id", "=", locationId], ["location_dest_id", "=", locationId]]],
        ["id"], 1, "date desc"
      );
      if (moves.length) await write(session, M("MODEL_MOVE"), [moves[0].id], { reference: reason.trim() });
    } catch {}
  }
}

// Tous les emplacements avec stock négatif (pour corrections)
// On inclut les emplacements internes ET de sortie (usage=output / nom "sortie"),
// car certains Odoo placent WH/Sortie en usage="output" → sinon ses négatifs
// n'apparaissent pas ici alors qu'ils existent (visibles dans Sorties orphelines).
// ══════════════════════════════════════════════════════════════════════════
// AGENT DE SURVEILLANCE — collecte des alertes WMS pour le tableau de bord.
// ══════════════════════════════════════════════════════════════════════════
export interface AlertItem { label: string; detail?: string; qty?: number; extra?: string }
export interface AlertGroup { key: string; title: string; icon: string; severity: "critical" | "warning" | "info"; count: number; items: AlertItem[]; error?: string; screen?: string }

// Erreur → message toujours lisible (jamais "[object Object]"), quel que soit ce qui est levé.
export function safeErrMsg(e: any): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try { return JSON.stringify(e); } catch { return String(e); }
}

// Les 6 sections sont indépendantes (lecture seule) → exécutées EN PARALLÈLE via Promise.all
// au lieu de séquentiellement, pour rester largement sous les limites de temps d'exécution
// serverless (chaque section peut prendre plusieurs secondes ; en série cela peut dépasser
// 30-40s, en parallèle le temps total ≈ celui de la section la plus longue).
export async function collectAlerts(session: OdooSession, opts?: { returnDays?: number; dlvMonths?: number }): Promise<AlertGroup[]> {
  const returnDays = opts?.returnDays ?? 10;

  const negativeP = (async (): Promise<AlertGroup> => {
    try {
      const negs = await getNegativeStockQuants(session);
      return {
        key: "negative", title: "Stock négatif", icon: "⚠️", severity: "critical", screen: "negativeStock",
        count: negs.length,
        items: negs.slice(0, 100).map((q: any) => ({
          label: Array.isArray(q.product_id) ? q.product_id[1] : String(q.product_id),
          detail: Array.isArray(q.location_id) ? q.location_id[1] : "",
          qty: q.quantity,
          extra: q.lot_id ? (Array.isArray(q.lot_id) ? q.lot_id[1] : "") : "",
        })),
      };
    } catch (e: any) { return { key: "negative", title: "Stock négatif", icon: "⚠️", severity: "critical", count: 0, items: [], error: safeErrMsg(e) }; }
  })();

  const returnsP = (async (): Promise<AlertGroup> => {
    try {
      let typeIds: number[] = [];
      const bySeq = await searchRead(session, M("MODEL_PICKING_TYPE"), [["sequence_code", "ilike", "RET"]], ["id", "sequence_code"], 20);
      typeIds = bySeq.filter((t: any) => t.sequence_code?.toUpperCase().includes("RET")).map((t: any) => t.id);
      if (!typeIds.length) {
        const byName = await searchRead(session, M("MODEL_PICKING_TYPE"), [["name", "ilike", "retour"]], ["id"], 10);
        typeIds = byName.map((t: any) => t.id);
      }
      const items: AlertItem[] = [];
      if (typeIds.length) {
        const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - returnDays);
        const cutoffStr = cutoff.toISOString().slice(0, 19).replace("T", " ");
        const picks = await searchRead(session, M("MODEL_PICKING"),
          [["picking_type_id", "in", typeIds], ["state", "in", ["confirmed", "assigned", "waiting", "partially_available"]], ["scheduled_date", "<=", cutoffStr]],
          ["id", "name", "scheduled_date", "partner_id", "origin"], 200);
        for (const p of picks) {
          const days = Math.floor((Date.now() - new Date(p.scheduled_date).getTime()) / 86400000);
          items.push({ label: p.name, detail: Array.isArray(p.partner_id) ? p.partner_id[1] : (p.origin || ""), extra: `${days} j` });
        }
      }
      return { key: "returns", title: `Retours en attente > ${returnDays} j`, icon: "↩️", severity: "warning", screen: "returns", count: items.length, items };
    } catch (e: any) { return { key: "returns", title: "Retours en attente", icon: "↩️", severity: "warning", count: 0, items: [], error: safeErrMsg(e) }; }
  })();

  const dlvP = (async (): Promise<AlertGroup> => {
    try {
      const lots = await getDlvStockLots(session);
      const soon = new Date(); soon.setMonth(soon.getMonth() + (opts?.dlvMonths ?? 6));
      const short = (lots as any[]).filter(l => l.dlvDate && new Date(l.dlvDate) <= soon && (l.qtyDispo ?? l.qty) > 0)
        .sort((a, b) => (a.dlvDate < b.dlvDate ? -1 : 1));
      return {
        key: "dlv", title: "DLV / DLC courtes", icon: "⏳", severity: "warning", screen: "fefo", count: short.length,
        items: short.slice(0, 100).map(l => ({ label: `${l.ref} — ${l.name}`, detail: `Lot ${l.lotName}`, qty: l.qtyDispo ?? l.qty, extra: String(l.dlvDate).slice(0, 10) })),
      };
    } catch (e: any) { return { key: "dlv", title: "DLV / DLC courtes", icon: "⏳", severity: "warning", count: 0, items: [], error: safeErrMsg(e) }; }
  })();

  const nonsellableP = (async (): Promise<AlertGroup> => {
    try {
      // Produits non vendables ayant du stock physique. On croise product.template(sale_ok=false)
      // avec les quants > 0.
      const tmpls = await searchRead(session, M("MODEL_PRODUCT_TEMPLATE"), [["sale_ok", "=", false], await storableClause(session, M("MODEL_PRODUCT_TEMPLATE"))], ["id", "name", "default_code", "qty_available"], 500);
      const withStock = (tmpls as any[]).filter(t => (t.qty_available ?? 0) > 0);
      return {
        key: "nonsellable", title: "Stock non vendable (Odoo)", icon: "🚫", severity: "info", screen: "productImport", count: withStock.length,
        items: withStock.slice(0, 100).map(t => ({ label: `${t.default_code || ""} ${t.name}`.trim(), qty: t.qty_available })),
      };
    } catch (e: any) { return { key: "nonsellable", title: "Stock non vendable", icon: "🚫", severity: "info", count: 0, items: [], error: safeErrMsg(e) }; }
  })();

  const orphansP = (async (): Promise<AlertGroup> => {
    try {
      const orphans = await getOrphanMoves(session);
      return {
        key: "orphans", title: "Sorties orphelines", icon: "📤", severity: "warning", screen: "inventory", count: orphans.length,
        items: orphans.slice(0, 100).map((o: any) => ({ label: `${o.ref} — ${o.name}`, detail: o.locationName, qty: o.uncoveredQty, extra: o.lotName })),
      };
    } catch (e: any) { return { key: "orphans", title: "Sorties orphelines", icon: "📤", severity: "warning", count: 0, items: [], error: safeErrMsg(e) }; }
  })();

  const putawayP = (async (): Promise<AlertGroup> => {
    try {
      const rules = await searchRead(session, "stock.putaway.rule", [], ["product_id"], 5000);
      const withRule = new Set<number>();
      for (const r of rules) { const pid = Array.isArray(r.product_id) ? r.product_id[0] : r.product_id; if (pid) withRule.add(pid); }
      // Produits stockables actifs et vendables → devraient avoir une règle.
      const prods = await searchRead(session, M("MODEL_PRODUCT"), [await storableClause(session, M("MODEL_PRODUCT")), ["active", "=", true], ["sale_ok", "=", true]], ["id", "default_code", "name"], 3000);
      const missing = (prods as any[]).filter(p => !withRule.has(p.id));
      return {
        key: "putaway", title: "Stratégie de rangement à régler", icon: "📦", severity: "info", screen: "locationManager", count: missing.length,
        items: missing.slice(0, 100).map(p => ({ label: `${p.default_code || ""} ${p.name}`.trim() })),
      };
    } catch (e: any) { return { key: "putaway", title: "Stratégie de rangement", icon: "📦", severity: "info", count: 0, items: [], error: safeErrMsg(e) }; }
  })();

  return Promise.all([negativeP, returnsP, dlvP, nonsellableP, orphansP, putawayP]);
}

export async function getNegativeStockQuants(session: OdooSession): Promise<any[]> {
  const quants = await searchRead(
    session, M("MODEL_QUANT"),
    ["&", ["quantity", "<", 0],
      "|", ["location_id.usage", "=", "internal"],
      "|", ["location_id.usage", "=", "output"], ["location_id.complete_name", "ilike", "sortie"]],
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
  const res = await searchRead(session, M("MODEL_CONFIG_PARAM"), [["key", "=", key]], ["value"], 1);
  return res.length ? res[0].value : null;
}

export async function setConfigParam(session: OdooSession, key: string, value: string): Promise<void> {
  const res = await searchRead(session, M("MODEL_CONFIG_PARAM"), [["key", "=", key]], ["id"], 1);
  if (res.length) {
    await write(session, M("MODEL_CONFIG_PARAM"), [res[0].id], { value });
  } else {
    await create(session, M("MODEL_CONFIG_PARAM"), { key, value });
  }
}


// ============================================
// COLIS / PUT IN PACK
// ============================================

export async function putInPack(session: OdooSession, pickingId: number, moveLineIds: number[]): Promise<any> {
  // Set result_package_id to create a new package for selected lines
  // First call action_put_in_pack on the picking with selected move line ids
  const result = await call(session, "/web/dataset/call_kw", {
    model: M("MODEL_PICKING"),
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
    model: await packageModel(session),
    method: "create",
    args: [{}],
    kwargs: {},
  });
  // Read back name (Odoo auto-generates it)
  const pkgs = await searchRead(session, await packageModel(session), [["id", "=", pkgId]], ["name"], 1);
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
    model: M("MODEL_MOVE_LINE"),
    method: "write",
    args: [moveLineIds, { result_package_id: packageId }],
    kwargs: {},
  });
}

export async function getPickingPackages(session: OdooSession, pickingId: number): Promise<any[]> {
  const lines = await searchRead(
    session,
    M("MODEL_MOVE_LINE"),
    [["picking_id", "=", pickingId], ["result_package_id", "!=", false]],
    // qty_done / reserved_uom_qty n'existent plus en Odoo 19 : les demander tels
    // quels faisait échouer TOUTE la requête, d'où « 0 colis » alors que les colis
    // existent bien dans Odoo. searchRead rétablit ensuite les deux noms.
    await availableFields(session, M("MODEL_MOVE_LINE"), [
      "result_package_id", "product_id", "lot_id",
      "qty_done", "reserved_uom_qty", "quantity", "picked",
    ]),
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

/**
 * Lignes "à problème" d'un picking : soit sans colis (result_package_id vide) avec
 * du stock fait, soit avec reserved_uom_qty désynchronisé de qty_done (ex: Fait=200
 * mais Réservé=0, cas typique après un mouvement de stock manuel qui corrige le
 * quant physique sans mettre à jour la réservation de la move line du transfert).
 * Sert à repérer et réparer ces lignes sans repasser par Odoo directement.
 */
export async function getOrphanMoveLines(session: OdooSession, pickingId: number): Promise<any[]> {
  // « Quelque chose a été fait sur la ligne » ne s'exprime pas pareil selon la
  // version : qty_done > 0 avant la v17, quantity > 0 ensuite. Le champ figure
  // ici dans le DOMAINE, donc un mauvais nom fait échouer la requête entière.
  //
  // On filtre sur la QUANTITÉ et non sur `picked`. Quand Odoo scinde une ligne
  // au scan — 1 unité prélevée et mise en colis, 24 laissées de côté — le
  // reliquat porte une quantité mais `picked = false`. Filtrer sur `picked`
  // cachait donc précisément les lignes qu'on vient réparer ici : l'écran
  // annonçait « aucune ligne sans colis » alors que 24 unités l'étaient.
  const shape = await stockShape(session);
  const doneClause = shape.merged ? ["quantity", ">", 0] : ["qty_done", ">", 0];
  const lines = await searchRead(
    session, M("MODEL_MOVE_LINE"),
    [["picking_id", "=", pickingId], doneClause],
    await availableFields(session, M("MODEL_MOVE_LINE"), [
      "id", "product_id", "lot_id",
      "qty_done", "reserved_uom_qty", "quantity", "picked",
      "location_id", "location_dest_id", "result_package_id",
    ]),
    200
  );
  return lines.filter((ml: any) => {
    // Sans colis : c'est le cas principal, quel que soit l'état de prélèvement.
    if (!ml.result_package_id) return true;
    // Avec colis : on ne signale qu'une vraie désynchronisation (fait ≠ réservé),
    // pas une ligne simplement pas encore prélevée — sinon tout un picking en
    // cours remonterait comme « à réparer », ce qui noierait les vrais cas.
    return (ml.qty_done || 0) > 0 && (ml.reserved_uom_qty || 0) !== (ml.qty_done || 0);
  });
}

/**
 * Cherche un colis (stock.quant.package) par son nom exact (ex: "PACK0041495").
 * Sert à retrouver un colis VIDÉ (aucune ligne dedans actuellement) qui n'apparaît
 * plus dans getPickingPackages, pour pouvoir le réutiliser au lieu d'en créer un nouveau.
 */
export async function findPackageByName(session: OdooSession, name: string): Promise<{ id: number; name: string } | null> {
  const res = await searchRead(session, await packageModel(session), [["name", "=", name.trim()]], ["id", "name"], 1);
  return res.length ? { id: res[0].id, name: res[0].name } : null;
}

/**
 * Réaligne reserved_uom_qty sur qty_done pour une ligne (cas où une manip a
 * laissé reserved_uom_qty désynchronisé, ex: 0 réservé alors que 200 sont faits) —
 * puis l'assigne au colis donné. Combine réparation + affectation en un seul appel.
 */
export async function repairAndAssignLine(
  session: OdooSession, moveLineId: number, packageId: number,
  opts: { marquerPreleve?: boolean } = {},
): Promise<void> {
  const [ml] = await searchRead(session, M("MODEL_MOVE_LINE"), [["id", "=", moveLineId]], ["qty_done", "reserved_uom_qty"], 1);
  if (!ml) throw new Error("Ligne introuvable");
  const vals: any = { result_package_id: packageId };

  // Une ligne réservée mais non prélevée compte pour 0 dans le colis : la mettre
  // dans le carton sans la marquer prélevée donnerait un colis qui paraît vide.
  // On reprend la quantité réservée comme quantité faite.
  if (opts.marquerPreleve && (ml.qty_done || 0) === 0 && (ml.reserved_uom_qty || 0) > 0) {
    vals.qty_done = ml.reserved_uom_qty;
  } else if ((ml.reserved_uom_qty || 0) !== (ml.qty_done || 0)) {
    vals.reserved_uom_qty = ml.qty_done || 0;
  }
  await write(session, M("MODEL_MOVE_LINE"), [moveLineId], vals);
}

/**
 * Met TOUTES les lignes sans colis d'un transfert dans le même colis.
 *
 * Cas réel : au scan, Odoo a mis 1 unité dans le colis et laissé 24 de côté.
 * Les reprendre une par une est fastidieux et se prête aux oublis — d'autant
 * que le reliquat peut être éclaté sur plusieurs lignes.
 *
 * Chaque ligne est traitée séparément et les échecs sont rapportés plutôt que
 * de faire échouer l'ensemble : mieux vaut 23 lignes rangées et 1 erreur
 * nommée qu'un abandon global sans savoir où ça a coincé.
 */
export async function assignAllOrphansToPackage(
  session: OdooSession, pickingId: number, packageId: number,
): Promise<{ traitees: number; echecs: { id: number; produit: string; erreur: string }[] }> {
  const orphans = (await getOrphanMoveLines(session, pickingId))
    .filter((ml: any) => !ml.result_package_id);

  let traitees = 0;
  const echecs: { id: number; produit: string; erreur: string }[] = [];
  for (const ml of orphans) {
    try {
      await repairAndAssignLine(session, ml.id, packageId, { marquerPreleve: true });
      traitees++;
    } catch (e: any) {
      echecs.push({ id: ml.id, produit: ml.product_id?.[1] || `ligne ${ml.id}`, erreur: safeErrMsg(e) });
    }
  }
  return { traitees, echecs };
}

/**
 * Réaligne reserved_uom_qty sur qty_done pour une ligne SANS toucher à son colis actuel
 * (utile quand le colis est déjà le bon, seul reserved_uom_qty est désynchronisé).
 */
export async function repairLineQty(session: OdooSession, moveLineId: number): Promise<void> {
  const [ml] = await searchRead(session, M("MODEL_MOVE_LINE"), [["id", "=", moveLineId]], ["qty_done"], 1);
  if (!ml) throw new Error("Ligne introuvable");
  await write(session, M("MODEL_MOVE_LINE"), [moveLineId], { reserved_uom_qty: ml.qty_done || 0 });
}

/**
 * Retire une move line d'un colis (remet result_package_id à vide) pour pouvoir
 * la réassigner à un autre colis ensuite. Utile pour corriger un colis mal rempli
 * sans devoir repasser par Odoo directement.
 */
export async function unassignLineFromPackage(session: OdooSession, moveLineId: number): Promise<void> {
  await write(session, M("MODEL_MOVE_LINE"), [moveLineId], { result_package_id: false });
}

/**
 * Divise une move line en deux : la ligne existante garde `keepQty`, une NOUVELLE
 * ligne est créée avec le reliquat (qty_done ET reserved_uom_qty totaux - keepQty).
 * Sert à répartir une quantité groupée (ex: 200 unités) sur plusieurs colis
 * distincts (ex: 3 cartons de 70/70/60) sans repasser par Odoo directement.
 * Retourne l'id de la nouvelle ligne créée (celle qui contient le reliquat).
 */
export async function splitMoveLine(session: OdooSession, moveLineId: number, keepQty: number): Promise<number> {
  const [ml] = await searchRead(session, M("MODEL_MOVE_LINE"),
    [["id", "=", moveLineId]],
    ["product_id", "lot_id", "location_id", "location_dest_id", "picking_id", "move_id", "product_uom_id",
     "qty_done", "reserved_uom_qty", "result_package_id", "package_id", "state"],
    1);
  if (!ml) throw new Error("Ligne introuvable");

  const totalQty = ml.qty_done || 0;
  const totalReserved = ml.reserved_uom_qty || 0;
  if (keepQty <= 0 || keepQty >= totalQty) {
    throw new Error(`Quantité à conserver invalide (doit être entre 0 et ${totalQty} exclus)`);
  }
  const restQty = totalQty - keepQty;
  // Répartit la réservation au prorata (évite de laisser une ligne avec reserved_uom_qty
  // incohérent, ce qui bloquerait la validation stricte du picking) — SAUF si la ligne
  // est déjà "done" : Odoo interdit alors toute quantité réservée non nulle
  // ("Une ligne de mouvement fait ne doit jamais comporter de quantité réservée").
  const isDone = ml.state === "done";
  const keepReserved = isDone ? 0 : (totalReserved > 0 ? Math.round((keepQty / totalQty) * totalReserved * 100) / 100 : keepQty);
  const restReserved = isDone ? 0 : (totalReserved > 0 ? Math.round((totalReserved - keepReserved) * 100) / 100 : restQty);

  // 1) Réduit la ligne existante à keepQty.
  await write(session, M("MODEL_MOVE_LINE"), [moveLineId], { qty_done: keepQty, reserved_uom_qty: keepReserved });

  // 2) Crée une nouvelle ligne avec le reliquat, SANS colis assigné (à répartir ensuite).
  const newId = await create(session, M("MODEL_MOVE_LINE"), {
    product_id: ml.product_id?.[0],
    lot_id: ml.lot_id?.[0] || false,
    location_id: ml.location_id?.[0],
    location_dest_id: ml.location_dest_id?.[0],
    picking_id: ml.picking_id?.[0],
    move_id: ml.move_id?.[0],
    product_uom_id: ml.product_uom_id?.[0],
    qty_done: restQty,
    reserved_uom_qty: restReserved,
    result_package_id: false,
  }) as number;

  return newId;
}

/** Une ligne de réappro chariot : produit Odoo + quantité à basculer sur le chariot. */
export interface ChariotReapproLine {
  productId:    number;
  defaultCode:  string;
  name:         string;
  qty:          number;
}

/** Commande e-shop trouvée pour un réappro chariot. */
export interface ChariotReappro {
  orderName:   string;   // S71596
  pickingId:   number;   // le OUT à valider
  pickingName: string;   // WH/OUT/…
  state:       string;
  lines:       ChariotReapproLine[];
}

/**
 * Réappro chariot : retrouve la commande e-shop (numéro S ou WH/OUT/…) et son
 * bon de sortie NON validé, avec les lignes à basculer sur le chariot.
 * Le service client crée la commande, les préparateurs la préparent : ici on ne
 * crée rien, on se contente de lire ce qui existe.
 */
export async function findChariotReappro(session: OdooSession, ref: string): Promise<ChariotReappro> {
  const q = ref.trim();
  if (!q) throw new Error("Référence vide");

  const picks = await searchPickingByCommande(session, q);
  if (!picks.length) throw new Error(`Aucune commande trouvée pour « ${q} »`);

  // On veut un OUT encore à valider. S'il n'y en a pas, on le dit clairement
  // (souvent : la commande a déjà été traitée).
  const open = picks.filter((p: any) => p.state !== "done" && p.state !== "cancel");
  if (!open.length) {
    const done = picks.find((p: any) => p.state === "done");
    throw new Error(done
      ? `La commande ${done.origin || q} est déjà validée (${done.name}) — réappro déjà fait ?`
      : `Aucun bon de sortie à valider pour « ${q} »`);
  }
  const pick = open[0];

  // Quantités : ce qui est réservé/fait sur les lignes de mouvement.
  const mls = await searchRead(session, M("MODEL_MOVE_LINE"),
    [["picking_id", "=", pick.id], ["state", "not in", ["cancel"]]],
    ["product_id", "reserved_uom_qty", "qty_done"], 500);

  const byProduct = new Map<number, ChariotReapproLine>();
  for (const ml of mls) {
    const pid = Array.isArray(ml.product_id) ? ml.product_id[0] : ml.product_id;
    if (!pid) continue;
    const qty = (ml.qty_done || 0) > 0 ? ml.qty_done : (ml.reserved_uom_qty || 0);
    if (!(qty > 0)) continue;
    const cur = byProduct.get(pid);
    if (cur) cur.qty += qty;
    else byProduct.set(pid, {
      productId: pid,
      defaultCode: "",
      name: Array.isArray(ml.product_id) ? ml.product_id[1] : String(pid),
      qty,
    });
  }
  if (!byProduct.size) throw new Error(`Aucun article à réapprovisionner sur ${pick.name}`);

  // Références internes (utiles pour le rapprochement avec les SKU du chariot)
  const ids = Array.from(byProduct.keys());
  try {
    const prods = await searchRead(session, M("MODEL_PRODUCT"), [["id", "in", ids]], ["id", "default_code"], ids.length);
    for (const p of prods) {
      const l = byProduct.get(p.id);
      if (l) l.defaultCode = p.default_code || "";
    }
  } catch { /* non bloquant */ }

  return {
    orderName:   pick.origin || q,
    pickingId:   pick.id,
    pickingName: pick.name,
    state:       pick.state,
    lines:       Array.from(byProduct.values()),
  };
}

export async function setPackageWeight(session: OdooSession, packageId: number, weight: number) {
  return write(session, await packageModel(session), [packageId], { shipping_weight: weight });
}

/**
 * Préparation multi-lots : l'opérateur a déjà préparé `doneOnOldLot` unités sur
 * la ligne (lot A) et scanne maintenant un AUTRE lot (B). Au lieu d'écraser le
 * lot de la ligne (ce qui réattribuait TOUTES les unités au dernier lot scanné),
 * on scinde : la ligne existante garde `doneOnOldLot` sur son lot, et une NOUVELLE
 * ligne porte le lot B avec le reliquat réservé.
 * Renvoie l'id de la nouvelle ligne (à incrémenter ensuite pour le lot B).
 */
export async function splitLineForNewLot(
  session: OdooSession,
  lineId: number,
  doneOnOldLot: number,
  newLotId: number
): Promise<{ newLineId: number; restReserved: number }> {
  const [ml] = await searchRead(session, M("MODEL_MOVE_LINE"),
    [["id", "=", lineId]],
    ["product_id", "lot_id", "location_id", "location_dest_id", "picking_id", "move_id", "product_uom_id", "reserved_uom_qty"],
    1);
  if (!ml) throw new Error("Ligne introuvable");

  const reserved = ml.reserved_uom_qty || 0;
  const rest = Math.max(0, reserved - doneOnOldLot);

  // 1) Verrouille la ligne d'origine : ses unités faites restent sur son lot,
  //    sa réservation tombe à ce qui est réellement pris dessus.
  await write(session, M("MODEL_MOVE_LINE"), [lineId], {
    qty_done: doneOnOldLot,
    reserved_uom_qty: doneOnOldLot,
  });

  // 2) Nouvelle ligne pour le lot scanné, avec le reliquat réservé (qty_done=0,
  //    l'appelant l'incrémente au fil des scans).
  const newLineId = await create(session, M("MODEL_MOVE_LINE"), {
    product_id: ml.product_id?.[0],
    lot_id: newLotId,
    location_id: ml.location_id?.[0],
    location_dest_id: ml.location_dest_id?.[0],
    picking_id: ml.picking_id?.[0],
    move_id: ml.move_id?.[0],
    product_uom_id: ml.product_uom_id?.[0],
    qty_done: 0,
    reserved_uom_qty: rest,
    result_package_id: false,
  }) as number;

  return { newLineId, restReserved: rest };
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
    session, M("MODEL_ATTACHMENT"),
    [["res_model", "=", M("MODEL_PICKING")], ["res_id", "=", pickingId], ["mimetype", "ilike", "pdf"]],
    ["id"], 100
  );
  const existingIds = new Set(attachmentsBefore.map((a: any) => a.id));

  // 2. Créer le package avec le poids
  const packageId = await create(session, await packageModel(session), {
    shipping_weight: weightKg,
  }) as number;

  // 3. Lier le package au picking :
  //    a) Écrire result_package_id sur les move lines done du picking
  //       → package_ids (computed) inclut ces packages → apparaît dans Odoo
  //    b) Créer aussi un stock.package.level pour les versions Odoo qui le lisent
  try {
    const doneLines = await searchRead(
      session, M("MODEL_MOVE_LINE"),
      [["picking_id", "=", pickingId]],
      ["id"],
      500
    );
    if (doneLines.length > 0) {
      const ids = doneLines.map((l: any) => l.id);
      await write(session, M("MODEL_MOVE_LINE"), ids, { result_package_id: packageId });
    }
  } catch { /* best-effort */ }

  try {
    await create(session, M("MODEL_PACKAGE_LEVEL"), {
      package_id: packageId,
      picking_id: pickingId,
      is_done: true,
    });
  } catch { /* stock.package.level peut ne pas exister dans toutes les versions */ }

  // 4. Incrémenter number_of_packages sur le picking pour TNT
  try {
    const picking = await searchRead(session, M("MODEL_PICKING"),
      [["id", "=", pickingId]],
      ["shipping_weight", "number_of_packages"],
      1
    );
    if (picking.length > 0) {
      const currentWeight = picking[0].shipping_weight || 0;
      const currentPkgs = picking[0].number_of_packages || 1;
      await write(session, M("MODEL_PICKING"), [pickingId], {
        shipping_weight: currentWeight + weightKg,
        number_of_packages: currentPkgs + 1,
      });
    }
  } catch {}

  // 5. Appeler send_to_shipper
  await callMethod(session, M("MODEL_PICKING"), "send_to_shipper", [[pickingId]]);

  // 6. Attendre puis récupérer les nouvelles pièces jointes
  await new Promise(resolve => setTimeout(resolve, 2000));
  const attachmentsAfter = await searchRead(
    session, M("MODEL_ATTACHMENT"),
    [["res_model", "=", M("MODEL_PICKING")], ["res_id", "=", pickingId], ["mimetype", "ilike", "pdf"]],
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
      session, M("MODEL_PRODUCT_SUPPLIER"),
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
        session, M("MODEL_PRODUCT_TEMPLATE"),
        [["id", "in", Array.from(tmplIds)]],
        ["id", "name", "default_code", "uom_id", "product_variant_ids"], 0
      );
      for (const t of tmpls) tmplById[t.id] = t;
    }
    // Pour les supplierinfo sans product_tmpl_id : on résout le template via le variant.
    const variantToTmpl: Record<number, any> = {};
    if (orphanVariantIds.size) {
      const prods = await searchRead(
        session, M("MODEL_PRODUCT"),
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
      const _supCodeField = F("SUPPLIER_PRODUCT_CODE");
      const templates = await searchRead(
        session, M("MODEL_PRODUCT_TEMPLATE"),
        [[_supCodeField, "in", remaining]],
        ["id", "name", "default_code", _supCodeField, "product_variant_ids", "uom_id"],
        0
      );
      for (const t of templates) {
        const code = String(t[_supCodeField] || "").trim();
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
    session, M("MODEL_PARTNER"),
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

/**
 * Emplacements source et destination d'une réception existante.
 *
 * En reprise, le bon de commande n'est pas recréé : ces deux valeurs, que
 * createAndConfirmPO renvoyait, doivent être relues sur la réception elle-même.
 */
export async function receptionLocations(
  session: OdooSession, pickingId: number,
): Promise<{ locationId: number; locationDestId: number }> {
  const [p] = await searchRead(session, M("MODEL_PICKING"),
    [["id", "=", pickingId]], ["id", "location_id", "location_dest_id"], 1);
  if (!p) throw new Error(`Réception ${pickingId} introuvable — reprise impossible`);
  const num = (v: any) => (Array.isArray(v) ? v[0] : v) || 0;
  return { locationId: num(p.location_id), locationDestId: num(p.location_dest_id) };
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

  // L'unité de mesure sur une ligne de commande fournisseur s'appelle
  // product_uom jusqu'à Odoo 16, product_uom_id à partir de la 17. On lit le
  // nom réellement présent : écrire le mauvais fait échouer tout l'import.
  const polFields = await knownFields(session, "purchase.order.line");
  const uomField = polFields && !polFields.has("product_uom") && polFields.has("product_uom_id")
    ? "product_uom_id" : "product_uom";

  const poValues: any = {
    partner_id: partnerId,
    order_line: groupedLines.map(l => [0, 0, {
      product_id: l.productId,
      product_qty: l.qty,
      price_unit: l.price || 0,
      name: l.name,
      date_planned: today,
      [uomField]: l.uomId,
    }]),
  };
  if (options.partnerRef) poValues.partner_ref = options.partnerRef;

  const poId = await create(session, M("MODEL_PURCHASE_ORDER"), poValues);

  const poRecords = await searchRead(session, M("MODEL_PURCHASE_ORDER"), [["id", "=", poId]], ["id", "name"], 1);
  const poName = poRecords[0]?.name || `PO-${poId}`;

  // Confirmer le bon de commande
  await callMethod(session, M("MODEL_PURCHASE_ORDER"), "button_confirm", [[poId]]);

  // Récupérer la réception générée
  const pickings = await searchRead(
    session, M("MODEL_PICKING"),
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
    await callMethod(session, M("MODEL_PURCHASE_ORDER"), "button_cancel", [[poId]]);
  } catch {} // ignore si déjà annulé
  try {
    await unlink(session, M("MODEL_PURCHASE_ORDER"), [poId]);
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
    session, M("MODEL_LOT"),
    [["name", "=", lotName], ["product_id", "=", productId]],
    ["id", "name"], 1
  );
  if (existing.length) return { id: existing[0].id, existed: true };

  const values: any = { name: lotName, product_id: productId, company_id: 1 };
  if (expiryDate) values.expiration_date = expiryDate + " 00:00:00";

  const id = await create(session, M("MODEL_LOT"), values);
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
    session, M("MODEL_MOVE"),
    [["picking_id", "=", pickingId]],
    ["id", "product_id", "product_qty", "product_uom"],
    0
  );
  const moveLines = await searchRead(
    session, M("MODEL_MOVE_LINE"),
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
      await write(session, M("MODEL_MOVE_LINE"), [ml.id], vals);
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
      await create(session, M("MODEL_MOVE_LINE"), vals);
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
    session, M("MODEL_QUANT"),
    [["location_id.usage", "=", "internal"], ["lot_id", "!=", false], ["quantity", ">", 0]],
    ["product_id", "lot_id", "quantity", "reserved_quantity"],
    5000
  );
  if (!quants?.length) return [];

  // 2. Lots → dates d'expiration
  const lotIds = Array.from(new Set(quants.map((q: any) => q.lot_id[0]))) as number[];
  const lots: any[] = await searchRead(
    session, M("MODEL_LOT"),
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
    session, M("MODEL_PRODUCT"),
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
  const outLines: any[] = await searchReadAll(
    session, M("MODEL_MOVE_LINE"), outDomain,
    ["product_id", "lot_id", "qty_done", "date", "reference", "origin"], "date asc"
  );
  if (!outLines.length) return { anomalies: [], nbSorties: 0, nbProduits: 0 };

  const productIds = Array.from(new Set(outLines.map((l: any) => l.product_id[0]))) as number[];

  // 2) Produits → ref/nom.
  const products = await searchRead(session, M("MODEL_PRODUCT"), [["id", "in", productIds]], ["id", "default_code", "name"], productIds.length);
  const prodMap: Record<number, { ref: string; name: string }> = {};
  for (const p of products) prodMap[p.id] = { ref: p.default_code || "", name: p.name || "" };

  // 3) Lots de ces produits → DLUO.
  const allLots = await searchReadAll(session, M("MODEL_LOT"), [["product_id", "in", productIds]], ["id", "name", "product_id", "expiration_date", "use_date", "removal_date"]);
  const lotMap: Record<number, { name: string; dluo: string; productId: number }> = {};
  for (const l of allLots) {
    const dluo = l.expiration_date || l.use_date || l.removal_date || "";
    lotMap[l.id] = { name: l.name, dluo: dluo ? String(dluo).slice(0, 10) : "", productId: Array.isArray(l.product_id) ? l.product_id[0] : l.product_id };
  }

  // 3bis) Stock ACTUEL par lot (emplacements internes) → pour ne signaler que les
  //       anomalies où il reste encore du stock du lot plus ancien AUJOURD'HUI.
  const curQuants = await searchReadAll(
    session, M("MODEL_QUANT"),
    [["product_id", "in", productIds], ["location_id.usage", "=", "internal"], ["lot_id", "!=", false], ["quantity", ">", 0]],
    ["lot_id", "quantity"]
  );
  const currentStockByLot: Record<number, number> = {};
  for (const q of curQuants) {
    const lid = Array.isArray(q.lot_id) ? q.lot_id[0] : q.lot_id;
    if (lid) currentStockByLot[lid] = (currentStockByLot[lid] || 0) + (q.quantity || 0);
  }

  // 4) TOUS les mouvements internes (done) de ces produits, par lot, pour reconstruire
  //    le stock par lot dans le temps. On regarde l'impact sur le stock INTERNE :
  //    +qty quand ça ENTRE en interne, -qty quand ça SORT de l'interne.
  const moveLines: any[] = await searchReadAll(
    session, M("MODEL_MOVE_LINE"),
    [["state", "=", "done"], ["product_id", "in", productIds], ["lot_id", "!=", false], ["date", "<=", endDT]],
    ["product_id", "lot_id", "qty_done", "date", "location_id", "location_usage", "location_dest_id", "location_dest_usage"],
    "date asc"
  );
  // location_usage / location_dest_usage ne sont pas toujours dispo → on récupère l'usage des emplacements.
  const locIds = new Set<number>();
  for (const m of moveLines) {
    if (Array.isArray(m.location_id)) locIds.add(m.location_id[0]);
    if (Array.isArray(m.location_dest_id)) locIds.add(m.location_dest_id[0]);
  }
  const locs = await searchRead(session, M("MODEL_LOCATION"), [["id", "in", Array.from(locIds)]], ["id", "usage"], locIds.size || 1);
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
    session, M("MODEL_MOVE"),
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
    session, M("MODEL_PRODUCT"),
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
    session, M("MODEL_QUANT"),
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
      session, M("MODEL_LOT"),
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
      session, M("MODEL_LOCATION"),
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
    session, M("MODEL_PRODUCT_TEMPLATE"),
    [["default_code", "=like", `${prefix}%`]],
    ["default_code"],
    200
  );
  return (products || []).map((p: any) => p.default_code as string).filter(Boolean);
}

/**
 * Récupère le prix d'achat (standard_price = coût) Odoo par code fournisseur Wala.
 * Chaîne : code Wala (product.supplierinfo.product_code) → product.template → standard_price.
 * Renvoie { [codeWala]: coût }.
 */
export async function getWalaPurchasePrices(session: OdooSession, articleCodes: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const codes = Array.from(new Set(articleCodes.map(c => String(c).trim()).filter(Boolean)));
  if (!codes.length) return out;
  // 1. supplierinfo : code Wala → template
  const sis = await searchRead(
    session, M("MODEL_PRODUCT_SUPPLIER"),
    [["product_code", "in", codes]],
    ["product_code", "product_tmpl_id", "product_id"], 0
  );
  const tmplByCode: Record<string, number> = {};
  const tmplIds = new Set<number>();
  for (const si of sis) {
    const code = String(si.product_code || "").trim();
    const tid = Array.isArray(si.product_tmpl_id) ? si.product_tmpl_id[0] : null;
    if (code && tid) { tmplByCode[code] = tid; tmplIds.add(tid); }
  }
  if (!tmplIds.size) return out;
  // 2. templates → standard_price
  const tmpls = await searchRead(
    session, M("MODEL_PRODUCT_TEMPLATE"),
    [["id", "in", Array.from(tmplIds)]],
    ["id", "standard_price"], 0
  );
  const priceByTmpl: Record<number, number> = {};
  for (const t of tmpls) priceByTmpl[t.id] = Number(t.standard_price) || 0;
  for (const [code, tid] of Object.entries(tmplByCode)) out[code] = priceByTmpl[tid] ?? 0;
  return out;
}

/**
 * Récupère la GAMME (catégorie produit = categ_id → product.category) par code fournisseur Wala.
 * Chaîne : code Wala (product.supplierinfo.product_code) → product.template → categ_id.
 * Renvoie { [codeWala]: "Nom de la gamme" }.
 */
export async function getWalaCategories(session: OdooSession, articleCodes: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const codes = Array.from(new Set(articleCodes.map(c => String(c).trim()).filter(Boolean)));
  if (!codes.length) return out;
  const sis = await searchRead(
    session, M("MODEL_PRODUCT_SUPPLIER"),
    [["product_code", "in", codes]],
    ["product_code", "product_tmpl_id"], 0
  );
  const tmplByCode: Record<string, number> = {};
  const tmplIds = new Set<number>();
  for (const si of sis) {
    const code = String(si.product_code || "").trim();
    const tid = Array.isArray(si.product_tmpl_id) ? si.product_tmpl_id[0] : null;
    if (code && tid) { tmplByCode[code] = tid; tmplIds.add(tid); }
  }
  if (!tmplIds.size) return out;
  const tmpls = await searchRead(
    session, M("MODEL_PRODUCT_TEMPLATE"),
    [["id", "in", Array.from(tmplIds)]],
    ["id", "categ_id"], 0
  );
  const catByTmpl: Record<number, string> = {};
  for (const t of tmpls) catByTmpl[t.id] = Array.isArray(t.categ_id) ? String(t.categ_id[1] || "") : "";
  for (const [code, tid] of Object.entries(tmplByCode)) { const c = catByTmpl[tid]; if (c) out[code] = c; }
  return out;
}

/** true si un default_code (référence interne) existe déjà sur un produit. */
export async function productCodeExists(session: OdooSession, code: string): Promise<boolean> {
  const c = code.trim();
  if (!c) return false;
  const found = await searchRead(session, M("MODEL_PRODUCT_TEMPLATE"), [["default_code", "=", c]], ["id"], 1);
  return (found || []).length > 0;
}

/** Unités de mesure disponibles dans Odoo */
export async function getUoMs(session: OdooSession): Promise<{ id: number; name: string }[]> {
  const uoms = await searchRead(session, M("MODEL_UOM"), [["active", "=", true]], ["id", "name"], 100);
  return (uoms || []).map((u: any) => ({ id: u.id, name: u.name }));
}

/** Catégories produit (Famille = categ_id → product.category). */
export async function getProductCategories(session: OdooSession): Promise<{ id: number; name: string }[]> {
  const cats = await searchRead(session, "product.category", [], ["id", "complete_name", "name"], 500);
  return (cats || []).map((c: any) => ({ id: c.id, name: c.complete_name || c.name })).sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name));
}

/** Types de produit custom (x_type_de_produit_id → modèle x_type_de_produit). */
export async function getProductTypes(session: OdooSession): Promise<{ id: number; name: string }[]> {
  try {
    const types = await searchRead(session, "x_type_de_produit", [], ["id", "display_name"], 500);
    return (types || []).map((t: any) => ({ id: t.id, name: t.display_name || String(t.id) })).sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name));
  } catch {
    return []; // modèle absent → on ignore ce champ
  }
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
  list_price?: number;      // prix de vente
  standard_price?: number;  // prix d'achat / coût
  supplierId?: number;      // fournisseur (res.partner)
  supplierRef?: string;     // référence produit chez le fournisseur
  categId?: number;         // Famille (categ_id → product.category)
  typeProduitId?: number;   // Type de produit (x_type_de_produit_id)
}): Promise<number> {
  // Deux champs ont changé côté produit selon la version d'Odoo :
  //
  // 1. uom_po_id (« unité d'achat ») a disparu en v19 — il n'y a plus qu'une
  //    seule unité de mesure. On ne l'envoie que s'il existe.
  // 2. Le type « stockable » : jusqu'en v17 c'était type = "product". Depuis la
  //    v18, type ne vaut plus que consu/service/combo et le caractère stockable
  //    est porté par le booléen is_storable. Envoyer "product" y serait refusé.
  const tmplFields = await knownFields(session, M("MODEL_PRODUCT_TEMPLATE"));
  const has = (f: string) => !tmplFields || tmplFields.has(f);

  const vals: any = {
    name: data.name,
    default_code: data.default_code,
    uom_id: data.uom_id,
    tracking: data.tracking,
    sale_ok: data.sale_ok ?? true,
    purchase_ok: data.purchase_ok ?? true,
  };
  if (has("is_storable")) {
    vals.type = "consu";
    vals.is_storable = true;
  } else {
    vals.type = "product";
  }
  if (has("uom_po_id")) vals.uom_po_id = data.uom_id;
  if (data.barcode) vals.barcode = data.barcode;
  if (data.weight) vals.weight = data.weight;
  if (data.list_price != null) vals.list_price = data.list_price;
  if (data.standard_price != null) vals.standard_price = data.standard_price;
  if (data.categId) vals.categ_id = data.categId;                       // Famille
  if (data.typeProduitId) vals.x_type_de_produit_id = data.typeProduitId; // Type de produit (custom)
  // Fournisseur → ligne product.supplierinfo créée en même temps (one2many seller_ids).
  if (data.supplierId) {
    const si: any = { partner_id: data.supplierId };
    if (data.supplierRef) si.product_code = data.supplierRef;   // Référence Fournisseur
    if (data.standard_price != null) si.price = data.standard_price; // Prix (achat) sur la ligne fournisseur
    vals.seller_ids = [[0, 0, si]];
  }
  return create(session, M("MODEL_PRODUCT_TEMPLATE"), vals);
}

// ══════════════════════════════════════════
// CRÉATION APPARIÉE MEA — code 7 + code AV + nomenclature kit
// ══════════════════════════════════════════

/**
 * Cherche des articles par référence exacte, actifs ET archivés.
 *
 * Inclure les archivés est indispensable avant une création : Odoo refuse deux
 * articles avec la même référence interne, y compris si l'existant est archivé.
 * Sans ce contrôle, l'écran annoncerait « à créer » puis échouerait à la
 * validation, après avoir déjà créé la moitié du lot.
 */
export async function findProductsByRefs(
  session: OdooSession, refs: string[],
): Promise<Record<string, { id: number; tmplId: number; name: string; active: boolean }>> {
  const out: Record<string, { id: number; tmplId: number; name: string; active: boolean }> = {};
  const clean = Array.from(new Set(refs.map(r => r.trim()).filter(Boolean)));
  if (!clean.length) return out;
  const rows = await searchRead(
    session, M("MODEL_PRODUCT"),
    [["default_code", "in", clean], ["active", "in", [true, false]]],
    ["id", "default_code", "name", "active", "product_tmpl_id"],
    clean.length * 2,
  );
  for (const p of rows) {
    if (!p.default_code) continue;
    out[String(p.default_code).trim()] = {
      id: p.id,
      tmplId: Array.isArray(p.product_tmpl_id) ? p.product_tmpl_id[0] : p.product_tmpl_id,
      name: p.name || "",
      active: p.active !== false,
    };
  }
  return out;
}

/** Réglages repris d'un article de référence, pour ne rien figer dans le code. */
export interface ProductDefaults { categId: number | null; uomId: number | null }

/**
 * Lit la catégorie et l'unité d'un article existant, qui sert de modèle.
 * Préféré à des valeurs écrites en dur : si la catégorie change dans Odoo, les
 * nouveaux articles suivent sans qu'on ait à retoucher le code.
 */
export async function getProductDefaults(session: OdooSession, ref: string): Promise<ProductDefaults> {
  const rows = await searchRead(
    session, M("MODEL_PRODUCT"),
    [["default_code", "=", ref.trim()], ["active", "in", [true, false]]],
    ["id", "categ_id", "uom_id"], 1,
  );
  const p = rows[0];
  if (!p) return { categId: null, uomId: null };
  return {
    categId: Array.isArray(p.categ_id) ? p.categ_id[0] : (p.categ_id || null),
    uomId: Array.isArray(p.uom_id) ? p.uom_id[0] : (p.uom_id || null),
  };
}

/**
 * Nomenclature de type KIT sur un article, avec un composant unique.
 *
 * En Odoo un kit se déclare par type = "phantom" : à la sortie, l'article se
 * décompose en ses composants au lieu de déclencher un ordre de fabrication.
 * C'est exactement le comportement décrit par l'écran Odoo : « Une nomenclature
 * de type kit est utilisée pour séparer l'article en ses composants ».
 */
export async function createKitBom(
  session: OdooSession,
  productTmplId: number,
  componentProductId: number,
  componentQty = 1,
): Promise<number> {
  return await create(session, M("MODEL_MRP_BOM"), {
    product_tmpl_id: productTmplId,
    product_qty: 1,
    type: "phantom",
    bom_line_ids: [[0, 0, { product_id: componentProductId, product_qty: componentQty }]],
  }) as number;
}

/** Nomenclature déjà présente sur cet article ? Évite d'en créer une seconde. */
export async function hasBom(session: OdooSession, productTmplId: number): Promise<boolean> {
  const rows = await searchRead(
    session, M("MODEL_MRP_BOM"),
    [["product_tmpl_id", "=", productTmplId]], ["id"], 1,
  );
  return rows.length > 0;
}

/**
 * NOM DE CLIENT LISIBLE.
 *
 * Odoo renvoie le nom d'AFFICHAGE d'un contact rattaché à une société sous la
 * forme « Société, Contact ». Quand les deux portent le même nom — ou que l'un
 * contient l'autre, ce qui est fréquent avec des libellés du type
 * « BIO VEYRE - LES COMPTOIRS ... , LES COMPTOIRS ... » — la même chose s'affiche
 * deux fois de suite et devient illisible sur un écran d'entrepôt.
 *
 * On ne retire que la redondance : deux segments réellement différents (une
 * société et le nom d'un magasin distinct) restent tous les deux affichés, car
 * l'information sert à identifier le destinataire.
 */
export function cleanPartnerLabel(display: string): string {
  const brut = (display || "").trim();
  if (!brut) return "";
  const segments = brut.split(",").map(s => s.trim()).filter(Boolean);
  const gardes: string[] = [];
  for (const seg of segments) {
    const redondant = gardes.some(g =>
      g.toUpperCase() === seg.toUpperCase() ||
      g.toUpperCase().includes(seg.toUpperCase()) ||
      seg.toUpperCase().includes(g.toUpperCase()));
    if (!redondant) gardes.push(seg);
  }
  return gardes.join(", ");
}

// ══════════════════════════════════════════
// AUDIT DES FACTURES CLIENT
// ══════════════════════════════════════════
//
// L'action automatisée de facturation compare le montant de la facture à celui
// de la COMMANDE ENTIÈRE. Dès qu'une commande est livrée en plusieurs fois, la
// facture ne couvre que le livré : l'écart est normal, mais l'action le traite
// comme une anomalie, envoie une alerte et — surtout — laisse la facture en
// brouillon sans la comptabiliser ni l'envoyer au client.
//
// Cet écran sert à retrouver ces factures et à distinguer les vrais écarts des
// faux positifs. LECTURE SEULE : rien n'est modifié dans Odoo.

export interface InvoiceAuditRow {
  id: number;
  name: string;
  partner: string;
  origin: string;
  amount: number;
  state: string;
  date: string;
  /** Montant de la commande d'origine, si on l'a retrouvée. */
  orderAmount: number | null;
  ecart: number | null;
  brouillon: boolean;
}

export async function auditInvoices(
  session: OdooSession, dateFrom: string, dateTo: string,
): Promise<InvoiceAuditRow[]> {
  // create_date et non invoice_date : on cherche ce que l'automatisation a
  // produit un jour donné, pas ce qui est daté de ce jour-là comptablement.
  const invs = await searchRead(
    session, M("MODEL_ACCOUNT_MOVE"),
    [["move_type", "=", "out_invoice"],
     ["create_date", ">=", `${dateFrom} 00:00:00`],
     ["create_date", "<=", `${dateTo} 23:59:59`]],
    ["id", "name", "partner_id", "invoice_origin", "amount_total", "state", "create_date"],
    2000, "create_date desc",
  );
  if (!invs.length) return [];

  // Les commandes d'origine, en une seule requête. invoice_origin peut en
  // contenir plusieurs, séparées par des virgules.
  const noms = Array.from(new Set(
    invs.flatMap((i: any) => String(i.invoice_origin || "").split(",").map((s: string) => s.trim()).filter(Boolean)),
  ));
  const montantParCommande: Record<string, number> = {};
  if (noms.length) {
    const sos = await searchRead(session, M("MODEL_SALE_ORDER"),
      [["name", "in", noms]], ["name", "amount_total"], noms.length);
    for (const so of sos) montantParCommande[so.name] = Number(so.amount_total) || 0;
  }

  return invs.map((i: any) => {
    const origines = String(i.invoice_origin || "").split(",").map((s: string) => s.trim()).filter(Boolean);
    const connues = origines.filter(o => o in montantParCommande);
    // Somme des commandes : une facture peut en regrouper plusieurs.
    const orderAmount = connues.length ? connues.reduce((s, o) => s + montantParCommande[o], 0) : null;
    const amount = Number(i.amount_total) || 0;
    return {
      id: i.id,
      name: i.name || `(brouillon ${i.id})`,
      partner: Array.isArray(i.partner_id) ? cleanPartnerLabel(i.partner_id[1]) : "",
      origin: origines.join(", "),
      amount,
      state: i.state || "",
      date: String(i.create_date || "").slice(0, 16).replace("T", " "),
      orderAmount,
      ecart: orderAmount === null ? null : Math.round((amount - orderAmount) * 100) / 100,
      brouillon: i.state === "draft",
    };
  });
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
    session, M("MODEL_PRODUCT_TEMPLATE"),
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
    byName = await searchRead(session, M("MODEL_PRODUCT_TEMPLATE"), domain, ["id", "default_code", "name", "temp_min_quantity"], 200);
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

// ============================================
// SAISIE LOGISTIQUE (PDA) — EAN, poids, dimensions
// ============================================

export interface ProductLogistics {
  id: number;            // id du product.template
  default_code: string;
  name: string;
  barcode: string;
  weight: number;
  volume: number;
  length: number;        // champs dimensions (product_length/width/height selon l'install Odoo)
  width: number;
  height: number;
}

// Champs "dimensions" — n'existent pas sur toutes les installations Odoo (module
// delivery / stock_packaging). On les lit en tolérant leur absence, plutôt que de
// faire échouer toute la lecture si le champ n'est pas installé.
const DIM_FIELDS = ["product_length", "product_width", "product_height"];

/** Cherche UN produit pour la saisie logistique : code-barres exact, puis référence
 *  exacte, puis recherche partielle (ref ou nom). Retourne null si rien trouvé. */
export async function findProductForLogistics(
  session: OdooSession,
  code: string
): Promise<ProductLogistics | null> {
  const q = (code || "").trim();
  if (!q) return null;

  const baseFields = ["id", "default_code", "name", "barcode", "weight", "volume"];
  // On tente d'abord AVEC les champs dimensions ; si l'install Odoo ne les a pas,
  // on retombe sur les champs de base uniquement.
  const tryRead = async (domain: any[], limit: number) => {
    try {
      return await searchRead(session, M("MODEL_PRODUCT_TEMPLATE"), domain, [...baseFields, ...DIM_FIELDS], limit);
    } catch {
      return await searchRead(session, M("MODEL_PRODUCT_TEMPLATE"), domain, baseFields, limit);
    }
  };

  let res = await tryRead([["barcode", "=", q]], 1);
  if (!res?.length) res = await tryRead([["default_code", "=", q]], 1);

  // Recherche par NUMÉRO DE LOT : indispensable pour les articles qui n'ont pas encore
  // d'EAN (on ne peut pas les scanner autrement) — le lot mène au produit, donc au template.
  if (!res?.length) {
    const lots = await searchRead(session, M("MODEL_LOT"), [["name", "=", q]], ["id", "product_id"], 1);
    const productId = lots?.[0]?.product_id?.[0];
    if (productId) {
      const variants = await searchRead(session, M("MODEL_PRODUCT"), [["id", "=", productId]], ["product_tmpl_id"], 1);
      const tmplId = variants?.[0]?.product_tmpl_id?.[0];
      if (tmplId) res = await tryRead([["id", "=", tmplId]], 1);
    }
  }

  if (!res?.length) res = await tryRead(["|", ["default_code", "ilike", q], ["name", "ilike", q]], 1);
  if (!res?.length) return null;

  const p = res[0];
  const num = (v: any) => (typeof v === "number" ? v : 0);
  return {
    id: p.id,
    default_code: p.default_code || "",
    name: p.name || "",
    barcode: p.barcode || "",
    weight: num(p.weight),
    volume: num(p.volume),
    length: num(p.product_length),
    width: num(p.product_width),
    height: num(p.product_height),
  };
}

/** Enregistre les données logistiques d'un product.template.
 *  Seuls les champs fournis (non undefined) sont écrits. Si l'écriture des champs
 *  dimensions échoue (module non installé), on réessaie sans eux pour ne pas perdre
 *  l'EAN et le poids — et on signale les champs ignorés. */
export async function saveProductLogistics(
  session: OdooSession,
  templateId: number,
  data: { barcode?: string; weight?: number; length?: number; width?: number; height?: number }
): Promise<{ skippedDimensions: boolean }> {
  const vals: any = {};
  if (data.barcode !== undefined) vals.barcode = data.barcode || false;
  if (data.weight !== undefined) vals.weight = data.weight;

  const dimVals: any = {};
  if (data.length !== undefined) dimVals.product_length = data.length;
  if (data.width !== undefined) dimVals.product_width = data.width;
  if (data.height !== undefined) dimVals.product_height = data.height;

  const hasDims = Object.keys(dimVals).length > 0;
  if (!hasDims) {
    if (Object.keys(vals).length) await write(session, M("MODEL_PRODUCT_TEMPLATE"), [templateId], vals);
    return { skippedDimensions: false };
  }

  try {
    await write(session, M("MODEL_PRODUCT_TEMPLATE"), [templateId], { ...vals, ...dimVals });
    return { skippedDimensions: false };
  } catch {
    // Champs dimensions absents de cette install Odoo → on sauve au moins le reste.
    if (Object.keys(vals).length) await write(session, M("MODEL_PRODUCT_TEMPLATE"), [templateId], vals);
    return { skippedDimensions: true };
  }
}

/** Recherche live par query partielle (nom ou ref) — pour autocomplete */
export async function searchProductsByQuery(
  session: OdooSession,
  query: string,
  limit = 20
): Promise<{ id: number; default_code: string; name: string; temp_min_quantity: number }[]> {
  if (!query.trim()) return [];
  const domain: any[] = ["|", ["default_code", "ilike", query], ["name", "ilike", query]];
  const res = await searchRead(session, M("MODEL_PRODUCT_TEMPLATE"), domain, ["id", "default_code", "name", "temp_min_quantity"], limit);
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
    session, M("MODEL_LOCATION"),
    ["|", ["usage", "=", "output"], ["complete_name", "ilike", "sortie"]],
    ["id", "complete_name", "usage"],
    100
  );
  if (!outputLocs.length) return [];
  const outputLocIds = outputLocs.map((l: any) => l.id as number);

  // 1. Quants dans ces emplacements avec qty > 0 ET sans réservation.
  //    Définition « sortie orpheline » = stock en Sortie SANS commande associée
  //    = quant dont reserved_quantity = 0 (rien n'est réservé dessus).
  //    On filtre directement côté Odoo pour ne remonter que les non-réservés.
  const quants: any[] = await searchRead(
    session, M("MODEL_QUANT"),
    [["location_id", "in", outputLocIds], ["quantity", ">", 0], ["reserved_quantity", "=", 0]],
    ["id", "product_id", "location_id", "lot_id", "quantity", "reserved_quantity"],
    2000
  );
  if (!quants.length) return [];

  // 4. Enrichir produits
  const productIds = Array.from(new Set(quants.map((q: any) => q.product_id[0]))) as number[];
  const products: any[] = await searchRead(
    session, M("MODEL_PRODUCT"),
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
    const lots: any[] = await searchRead(session, M("MODEL_LOT"), [["id", "in", lotIds]], ["id", "name"], lotIds.length);
    for (const l of lots) lotMap[l.id] = l.name;
  }

  // 6. Calculer qté non couverte par un picking actif
  const result: {
    id: number; productId: number; ref: string; name: string; lotName: string;
    qty: number; reservedQty: number; uncoveredQty: number; state: string; date: string;
    locationName: string; locationDestName: string; pickingState: string; reason: string; quantId: number;
  }[] = [];

  for (const q of quants) {
    // reserved_quantity = 0 garanti par le domaine → toute la quantité est orpheline.
    const uncovered = q.quantity;
    if (uncovered <= 0) continue;
    const prod = prodMap[q.product_id[0]];
    result.push({
      id: q.id,
      quantId: q.id,
      productId: q.product_id[0],
      ref: prod?.default_code || "",
      name: prod?.name || q.product_id[1] || "",
      lotName: q.lot_id ? (lotMap[q.lot_id[0]] || q.lot_id[1] || "") : "",
      qty: q.quantity,
      reservedQty: 0,
      uncoveredQty: uncovered,
      state: "stranded",
      date: "",
      locationName: Array.isArray(q.location_id) ? q.location_id[1] : "",
      locationDestName: "",
      pickingState: "",
      reason: "Aucune réservation (stock en sortie sans commande)",
    });
  }

  result.sort((a, b) => b.uncoveredQty - a.uncoveredQty);
  return result;
}

/** Annule une liste de stock.move orphelins (passe à state=cancel + libère réservation) */
export async function cancelOrphanMoves(session: OdooSession, moveIds: number[]): Promise<void> {
  if (!moveIds.length) return;
  await write(session, M("MODEL_MOVE"), moveIds, { state: "draft" });
  await write(session, M("MODEL_MOVE"), moveIds, { state: "cancel" });
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
    await write(session, M("MODEL_QUANT"), [c.quantId], { inventory_quantity: newQty });
    await callMethod(session, M("MODEL_QUANT"), "action_apply_inventory", [[c.quantId]]);
  }
}

export async function bulkUpdateMinQuantity(
  session: OdooSession,
  updates: { id: number; value: number }[]
): Promise<void> {
  await Promise.all(
    updates.map(u => write(session, M("MODEL_PRODUCT_TEMPLATE"), [u.id], { temp_min_quantity: u.value }))
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
    const fg = await callMethod(session, M("MODEL_SALE_ORDER"), "fields_get", [], { attributes: ["string", "type", "relation"] });
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
      const rows = await searchRead(session, M("MODEL_SALE_ORDER"), domain, fields, 0, "date_order desc");
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
        const rows = await searchRead(session, M("MODEL_SALE_ORDER"), domain, ["id", "name", "amount_untaxed", "amount_total"], 0, "");
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
        const rows = await searchRead(session, M("MODEL_PARTNER"), [["id", "in", shipIds.slice(i, i + 200)]], ["id", "zip", "city"], 0, "");
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
        const rows = await searchRead(session, M("MODEL_PARTNER"), [["id", "in", partnerIds.slice(i, i + 200)]], ["id", "ref"], 0, "");
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
  const rows = await searchRead(session, M("MODEL_SALE_ORDER"),
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
  const prods = await searchRead(session, M("MODEL_PRODUCT"),
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
    const fg = await callMethod(session, M("MODEL_PRODUCT_TEMPLATE"), "fields_get",
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
      const tmpls = await searchRead(session, M("MODEL_PRODUCT_TEMPLATE"), [["id", "=", tmplId]], toRead, 1);
      if (tmpls[0]) {
        if (dimTextField) dimText = tmpls[0][dimTextField] || "";
        for (const f of dimFields) dims[f] = tmpls[0][f] || 0;
      }
    }
  } catch { dimFields = []; dimTextField = null; }

  // Lignes fournisseur (variante OU template)
  const suppliers = await searchRead(session, M("MODEL_PRODUCT_SUPPLIER"),
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
    await write(session, M("MODEL_PRODUCT"), [productId], { barcode: barcode.trim() || false });
  }

  // Vendable / poids / volume / dimensions → product.template
  const tmplVals: any = {};
  if (saleOk !== undefined) tmplVals.sale_ok = saleOk;
  if (weight !== undefined && !isNaN(weight)) tmplVals.weight = weight;
  if (volume !== undefined && !isNaN(volume)) tmplVals.volume = volume;
  if (dimTextField && dimText !== undefined) tmplVals[dimTextField] = dimText.trim() || false;
  if (dims) for (const [k, v] of Object.entries(dims)) { if (!isNaN(v)) tmplVals[k] = v; }
  if (Object.keys(tmplVals).length) await write(session, M("MODEL_PRODUCT_TEMPLATE"), [tmplId], tmplVals);

  // Réf fournisseur → product.supplierinfo
  if (supplierCodes?.length) {
    await Promise.all(supplierCodes.map(s =>
      write(session, M("MODEL_PRODUCT_SUPPLIER"), [s.id], { product_code: s.product_code.trim() || false })
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
      session, M("MODEL_PRODUCT_PACKAGING"),
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
    session, M("MODEL_LOCATION"),
    [["barcode", "=", q], ["usage", "=", "internal"]],
    ["id", "name", "complete_name", "barcode"], 5
  );
  if (byBc.length) return byBc;
  // sinon recherche par nom complet (ilike) — utile pour "Allée A", "A-", etc.
  return searchRead(
    session, M("MODEL_LOCATION"),
    ["|", ["complete_name", "ilike", q], ["name", "ilike", q], ["usage", "=", "internal"]],
    ["id", "name", "complete_name", "barcode"], 50, "complete_name"
  );
}

// Théorique pour une liste de combinaisons (produit/lot/emplacement).
// Retourne pour chaque clé: { quantId, theoretical } d'après stock.quant temps réel.
export interface TheoreticalRow { productId: number; lotId: number | null; locationId: number | null; quantId: number | null; theoretical: number; quantQty?: number; }

export interface UnscannedLot {
  productId: number; productName: string; odooRef: string;
  lotId: number | null; lotName: string;
  locationId: number; locationName: string;
  quantId: number; qty: number;
}

/**
 * Lots en stock qu'AUCUN scan n'a couverts.
 *
 * Sans cela, l'inventaire ne compare que ce qui a été trouvé : un lot présent
 * en stock mais introuvable physiquement reste invisible, et son stock demeure
 * faux indéfiniment. C'est précisément l'écart qu'un inventaire doit révéler.
 *
 * Un scan sans emplacement vaut pour TOUS les emplacements de ce couple
 * produit/lot, et un scan sans lot ni emplacement couvre le produit entier —
 * dans ce dernier cas on ne peut rien conclure lot par lot, alors on s'abstient
 * plutôt que d'inventer des écarts.
 */
export async function findUnscannedLots(
  session: OdooSession,
  scanned: { productId: number; lotId: number | null; locationId: number | null }[],
): Promise<UnscannedLot[]> {
  const productIds = Array.from(new Set(scanned.map(s => s.productId)));
  if (!productIds.length) return [];

  // Produits comptés globalement (ni lot ni emplacement) : le total fait foi,
  // le détail par lot n'a pas de sens.
  const global = new Set(scanned.filter(s => !s.lotId && s.locationId == null).map(s => s.productId));

  const couvert = (pid: number, lot: number | null, loc: number) =>
    scanned.some(s =>
      s.productId === pid &&
      (s.lotId == null || s.lotId === lot) &&
      (s.locationId == null || s.locationId === loc));

  const quants = await searchRead(
    session, M("MODEL_QUANT"),
    [["product_id", "in", productIds], ["location_id.usage", "=", "internal"], ["quantity", ">", 0]],
    ["id", "product_id", "lot_id", "location_id", "quantity"], 5000,
  );

  return quants
    .filter((q: any) => {
      const pid = Array.isArray(q.product_id) ? q.product_id[0] : q.product_id;
      if (global.has(pid)) return false;
      const lot = q.lot_id ? (Array.isArray(q.lot_id) ? q.lot_id[0] : q.lot_id) : null;
      const loc = Array.isArray(q.location_id) ? q.location_id[0] : q.location_id;
      return !couvert(pid, lot, loc);
    })
    .map((q: any) => {
      const pid = Array.isArray(q.product_id) ? q.product_id[0] : q.product_id;
      const nomProduit = Array.isArray(q.product_id) ? q.product_id[1] : "";
      const ref = (nomProduit.match(/^\[([^\]]+)\]/) || [])[1] || "";
      return {
        productId: pid,
        productName: nomProduit.replace(/^\[[^\]]+\]\s*/, ""),
        odooRef: ref,
        lotId: q.lot_id ? (Array.isArray(q.lot_id) ? q.lot_id[0] : q.lot_id) : null,
        lotName: q.lot_id && Array.isArray(q.lot_id) ? q.lot_id[1] : "",
        locationId: Array.isArray(q.location_id) ? q.location_id[0] : q.location_id,
        locationName: Array.isArray(q.location_id) ? q.location_id[1] : "",
        quantId: q.id,
        qty: Number(q.quantity) || 0,
      };
    });
}

export async function getInventoryTheoretical(
  session: OdooSession,
  keys: { productId: number; lotId: number | null; locationId: number | null }[]
): Promise<TheoreticalRow[]> {
  if (!keys.length) return [];
  const productIds = Array.from(new Set(keys.map(k => k.productId)));
  // On récupère tous les quants internes des produits concernés en une requête
  const quants = await searchRead(
    session, M("MODEL_QUANT"),
    [["product_id", "in", productIds], ["location_id.usage", "=", "internal"]],
    ["id", "product_id", "lot_id", "location_id", "quantity"],
    2000
  );
  const qKey = (pid: number, lot: number | null, loc: number | null) => `${pid}|${lot ?? 0}|${loc ?? 0}`;
  // Map exacte produit+lot+emplacement
  const exact: Record<string, { quantId: number; qty: number }> = {};
  // Agrégat produit+lot (tous emplacements) — scan libre avec lot connu.
  const byProdLot: Record<string, { quantId: number; qty: number; bestQty: number }> = {};
  // Agrégat produit SEUL (tous lots, tous emplacements) — scan libre SANS lot
  // (corrige le faux écart sur les produits gérés par lot : le théorique doit
  //  sommer TOUT le stock du produit, pas exiger "lot = aucun").
  const byProd: Record<number, { quantId: number; qty: number; bestQty: number }> = {};
  for (const q of quants) {
    const pid = Array.isArray(q.product_id) ? q.product_id[0] : q.product_id;
    const lot = q.lot_id ? (Array.isArray(q.lot_id) ? q.lot_id[0] : q.lot_id) : null;
    const loc = q.location_id ? (Array.isArray(q.location_id) ? q.location_id[0] : q.location_id) : null;
    const qty = Number(q.quantity) || 0;
    exact[qKey(pid, lot, loc)] = { quantId: q.id, qty };
    const plKey = `${pid}|${lot ?? 0}`;
    if (!byProdLot[plKey]) byProdLot[plKey] = { quantId: q.id, qty: 0, bestQty: qty };
    byProdLot[plKey].qty += qty;
    if (qty >= byProdLot[plKey].bestQty) { byProdLot[plKey].quantId = q.id; byProdLot[plKey].bestQty = qty; }
    if (!byProd[pid]) byProd[pid] = { quantId: q.id, qty: 0, bestQty: qty };
    byProd[pid].qty += qty;
    if (qty >= byProd[pid].bestQty) { byProd[pid].quantId = q.id; byProd[pid].bestQty = qty; }
  }
  return keys.map(k => {
    if (k.locationId != null) {
      const hit = exact[qKey(k.productId, k.lotId, k.locationId)];
      return { ...k, quantId: hit?.quantId ?? null, theoretical: hit?.qty ?? 0, quantQty: hit?.qty ?? 0 };
    }
    // Scan libre AVEC lot → somme du produit+lot sur tous les emplacements.
    if (k.lotId != null) {
      const hit = byProdLot[`${k.productId}|${k.lotId}`];
      return { ...k, quantId: hit?.quantId ?? null, theoretical: hit?.qty ?? 0, quantQty: hit?.bestQty ?? 0 };
    }
    // Scan libre SANS lot → somme de TOUT le stock du produit (tous lots/emplacements).
    const hit = byProd[k.productId];
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
    vals[F("SHIPPING_DATE")] = today; // champ "date" → YYYY-MM-DD
    vals.commitment_date = `${today} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  } catch {}

  // Étiquettes (crm.tag) : "import eShop" + "Transmise" — trouvées ou créées
  try {
    const findOrCreateTag = async (name: string): Promise<number | null> => {
      const t = await searchRead(session, M("MODEL_CRM_TAG"), [["name", "=", name]], ["id"], 1);
      if (t.length) return t[0].id;
      return await create(session, M("MODEL_CRM_TAG"), { name }) as number;
    };
    const tagIds = (await Promise.all([findOrCreateTag("import eShop"), findOrCreateTag("Transmise")]))
      .filter((x): x is number => typeof x === "number");
    if (tagIds.length) vals.tag_ids = [[6, 0, tagIds]];
  } catch {}

  const id = await create(session, M("MODEL_SALE_ORDER"), vals) as number;

  // Confirme la commande → génère le bon de préparation (stock.picking)
  if (confirm) {
    try { await callMethod(session, M("MODEL_SALE_ORDER"), "action_confirm", [[id]]); }
    catch (e) { /* en cas d'échec, la commande reste en devis (non bloquant) */ }
  }

  const recs = await searchRead(session, M("MODEL_SALE_ORDER"), [["id", "=", id]], ["id", "name"], 1);
  return { id, name: recs[0]?.name || String(id) };
}

// Valide automatiquement TOUS les pickings d'une commande, dans l'ordre logique
// (pick/internal d'abord, puis out/delivery). Pour chaque picking : réserve (assign),
// remplit les qty_done = réservé, puis valide (gère wizards immediate/backorder).
// Renvoie le détail par picking pour affichage.
export async function validateOrderPickings(
  session: OdooSession, orderId: number
): Promise<{ validated: string[]; failed: { name: string; error: string }[] }> {
  const out: { validated: string[]; failed: { name: string; error: string }[] } = { validated: [], failed: [] };
  // Pickings non terminés de la commande.
  const picks = await searchRead(session, M("MODEL_PICKING"),
    [["sale_id", "=", orderId], ["state", "not in", ["done", "cancel"]]],
    ["id", "name", "picking_type_code", "state"], 20);
  if (!picks.length) return out;
  // Ordre : pick/internal avant out/outgoing (sinon le out n'a pas encore le stock).
  const rank = (c: string) => (c === "internal" ? 0 : c === "outgoing" ? 2 : 1);
  picks.sort((a: any, b: any) => rank(a.picking_type_code) - rank(b.picking_type_code));

  for (const p of picks) {
    try {
      // 1. Réserver le stock.
      try { await callMethod(session, M("MODEL_PICKING"), "action_assign", [[p.id]]); } catch {}
      // 2. Remplir qty_done = réservé sur chaque ligne (sinon validation = reliquat).
      const mls = await searchRead(session, M("MODEL_MOVE_LINE"),
        [["picking_id", "=", p.id], ["state", "not in", ["done", "cancel"]]],
        ["id", "reserved_uom_qty", "qty_done"], 500);
      for (const ml of mls) {
        const want = ml.reserved_uom_qty || 0;
        if (want > 0 && (ml.qty_done || 0) < want) {
          try { await write(session, M("MODEL_MOVE_LINE"), [ml.id], { qty_done: want }); } catch {}
        }
      }
      // 3. Valider en mode STRICT : si Odoo veut un reliquat (stock insuffisant),
      //    on REFUSE et on lève une erreur → l'utilisateur traitera le reliquat à la main.
      await validatePickingStrict(session, p.id);
      out.validated.push(p.name);
    } catch (e: any) {
      out.failed.push({ name: p.name, error: e?.message || "erreur" });
      // On ARRÊTE la chaîne : si le pick échoue, on ne valide pas le OUT derrière.
      break;
    }
  }
  return out;
}

// Statut Odoo (pick / out / facture) d'une commande e-shop déjà sortie (devis créé).
// Utilisé pour le petit récap des dernières commandes validées côté e-shop.
export interface EshopOrderStatus {
  devis: string;             // nom sale.order, ex "S00234"
  orderNumbers: string[];    // n° commandes Shopware regroupées
  found: boolean;            // false si le devis n'existe plus / introuvable dans Odoo
  saleState?: string;        // état sale.order : draft/sent/sale/done/cancel
  pick?: { id: number; name: string; state: string } | null;   // transfert interne (préparation)
  out?: { id: number; name: string; state: string } | null;    // livraison sortante
  saleOrderId?: number;      // id sale.order Odoo (pour lien direct)
  invoiceStatus?: string;    // invoice_status du sale.order : upselling/invoiced/to invoice/no
  invoiced: boolean;         // facture(s) posée(s) (account.move state = posted) liée(s) à la commande
  anomaly: string | null;    // message si un souci est détecté, sinon null
  source: "manual" | "cron"; // créée à la main sur l'écran Sorties, ou automatiquement par le cron 22h
}

export async function getRecentEshopOrdersStatus(
  session: OdooSession,
  recents: { devis: string; orderNumbers: string[]; processedAt: string; source?: "manual" | "cron" }[]
): Promise<EshopOrderStatus[]> {
  const devisNames = Array.from(new Set(recents.map(r => r.devis).filter(n => n && n !== "chariot")));
  const out: EshopOrderStatus[] = [];
  if (!devisNames.length) return recents.map(r => ({
    devis: r.devis, orderNumbers: r.orderNumbers, found: false, invoiced: false,
    anomaly: r.devis === "chariot" ? null : "Commande introuvable dans Odoo",
    source: r.source || "manual",
  }));

  const orders = await searchRead(
    session, M("MODEL_SALE_ORDER"),
    [["name", "in", devisNames]],
    ["id", "name", "state", "invoice_status"],
    devisNames.length
  );
  const orderByName: Record<string, any> = {};
  for (const o of orders) orderByName[o.name] = o;
  const orderIds = orders.map((o: any) => o.id);

  // Pickings (pick interne + out) liés aux commandes.
  const picksByOrder: Record<number, any[]> = {};
  if (orderIds.length) {
    const picks = await searchRead(
      session, M("MODEL_PICKING"),
      [["sale_id", "in", orderIds]],
      ["id", "name", "state", "sale_id", "picking_type_code"],
      500
    );
    for (const p of picks) {
      const sid = p.sale_id?.[0];
      if (!sid) continue;
      (picksByOrder[sid] ||= []).push(p);
    }
  }

  // Factures (account.move) liées via invoice_ids sur sale.order.
  const invoicedByOrder: Record<number, boolean> = {};
  if (orderIds.length) {
    try {
      const invoiceLines = await searchRead(
        session, "account.move",
        [["invoice_origin", "in", orders.map((o: any) => o.name)], ["move_type", "=", "out_invoice"]],
        ["id", "invoice_origin", "state"],
        500
      );
      const originToOrderId: Record<string, number> = {};
      for (const o of orders) originToOrderId[o.name] = o.id;
      for (const inv of invoiceLines) {
        const oid = originToOrderId[inv.invoice_origin];
        if (oid && inv.state === "posted") invoicedByOrder[oid] = true;
      }
    } catch { /* non bloquant si le champ invoice_origin diffère */ }
  }

  for (const r of recents) {
    const source = r.source || "manual";
    if (r.devis === "chariot") {
      // Vente 100% chariot, sans devis Odoo : rien à valider côté pick/out/facture.
      out.push({ devis: r.devis, orderNumbers: r.orderNumbers, found: true, invoiced: true, anomaly: null, source });
      continue;
    }
    const o = orderByName[r.devis];
    if (!o) {
      out.push({ devis: r.devis, orderNumbers: r.orderNumbers, found: false, invoiced: false, anomaly: "Commande introuvable dans Odoo", source });
      continue;
    }
    const picks = picksByOrder[o.id] || [];
    const pick = picks.find((p: any) => p.picking_type_code === "internal") || null;
    const outP = picks.find((p: any) => p.picking_type_code === "outgoing") || null;
    const invoiced = !!invoicedByOrder[o.id] || o.invoice_status === "invoiced";

    let anomaly: string | null = null;
    if (o.state === "cancel") anomaly = "Commande annulée dans Odoo";
    else if (pick && pick.state !== "done") anomaly = `Pick non validé (${pick.state})`;
    else if (outP && outP.state !== "done") anomaly = `Sortie (OUT) non validée (${outP.state})`;
    else if (!outP && picks.length) anomaly = "Pas de transfert de sortie (OUT) trouvé";
    else if (!invoiced) anomaly = "Facture non faite";

    out.push({
      devis: r.devis, orderNumbers: r.orderNumbers, found: true, saleState: o.state,
      pick: pick ? { id: pick.id, name: pick.name, state: pick.state } : null,
      out: outP ? { id: outP.id, name: outP.name, state: outP.state } : null,
      invoiceStatus: o.invoice_status, invoiced, anomaly, source, saleOrderId: o.id,
    });
  }
  return out;
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
  isCompany?: boolean;     // true → company_type "company" (Société), sinon "person"
  tag?: string;            // étiquette client (res.partner.category_id), ex: "Imparfaite"
  pricelistName?: string;  // liste de prix client (property_product_pricelist), ex: "WALAOFFERT_2023"
}
export interface MarketplaceLine { productId: number; qty: number; name?: string; price?: number; }

// Crée un nouveau client (res.partner). Toujours nouveau (1 commande = 1 client).
export async function createMarketplaceClient(session: OdooSession, c: MarketplaceClient): Promise<number> {
  const vals: any = {
    name: c.name || "Client marketplace",
    company_type: c.isCompany ? "company" : "person", // Société si demandé
    customer_rank: 1,
  };
  if (c.ref) vals.ref = c.ref;                       // numéro client = réf commande (ex: Imparfaite289...)
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
  // Étiquette client (res.partner.category_id, many2many) — trouve ou crée le tag.
  if (c.tag) {
    try {
      let t = await searchRead(session, M("MODEL_PARTNER_CATEGORY"), [["name", "=", c.tag]], ["id"], 1);
      const tagId = t.length ? t[0].id : await create(session, M("MODEL_PARTNER_CATEGORY"), { name: c.tag }) as number;
      if (tagId) vals.category_id = [[6, 0, [tagId]]];
    } catch {}
  }
  // Liste de prix client (property_product_pricelist) — par nom (EN/US), tolérant.
  if (c.pricelistName) {
    try {
      let pl = await searchRead(session, M("MODEL_PRODUCT_PRICELIST"), [["name", "=", c.pricelistName]], ["id"], 1);
      if (!pl.length) pl = await searchRead(session, M("MODEL_PRODUCT_PRICELIST"), [["name", "ilike", c.pricelistName]], ["id"], 1);
      if (pl.length) vals.property_product_pricelist = pl[0].id;
    } catch {}
  }
  // Pays via code ISO2
  if (c.countryCode) {
    try {
      const co = await searchRead(session, M("MODEL_COUNTRY"), [["code", "=", c.countryCode.toUpperCase()]], ["id"], 1);
      if (co.length) vals.country_id = co[0].id;
    } catch {}
  }
  return await create(session, M("MODEL_PARTNER"), vals) as number;
}

// Crée une commande de vente marketplace pour un client donné.
// confirm → confirme (génère le BL) ; assign → réserve le stock sur le BL.
// Lignes à 0 € si price non fourni (mode "suivi/destockage").
export async function createMarketplaceOrder(
  session: OdooSession,
  partnerId: number,
  lines: MarketplaceLine[],
  opts: { origin?: string; confirm?: boolean; assign?: boolean; tag?: string; tags?: string[]; price0?: boolean; pricelistName?: string; tntService?: string; forceInvoiced?: boolean } = {}
): Promise<{ id: number; name: string; tnt?: { ok: boolean; reason?: string; serviceId?: number } }> {
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
      let pl = await searchRead(session, M("MODEL_PRODUCT_PRICELIST"), [["name", "=", opts.pricelistName]], ["id"], 1);
      if (!pl.length) pl = await searchRead(session, M("MODEL_PRODUCT_PRICELIST"), [["name", "ilike", opts.pricelistName]], ["id"], 1);
      if (pl.length) { pricelistId = pl[0].id; vals.pricelist_id = pricelistId; }
    } catch {}
  }
  // Date d'expédition prévue = aujourd'hui (champ custom date x_studio_date_dexpdition_prvue)
  try {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    vals[F("SHIPPING_DATE")] = today; // champ "date" → YYYY-MM-DD
    vals.commitment_date = `${today} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  } catch {}
  // Étiquettes (crm.tag) : accepte un tag unique (opts.tag) OU plusieurs (opts.tags).
  const wantedTags = Array.from(new Set([...(opts.tags || []), ...(opts.tag ? [opts.tag] : [])].filter(Boolean)));
  if (wantedTags.length) {
    try {
      const findOrCreateTag = async (name: string): Promise<number | null> => {
        const t = await searchRead(session, M("MODEL_CRM_TAG"), [["name", "=", name]], ["id"], 1);
        if (t.length) return t[0].id;
        return await create(session, M("MODEL_CRM_TAG"), { name }) as number;
      };
      const tagIds = (await Promise.all(wantedTags.map(findOrCreateTag))).filter((x): x is number => typeof x === "number");
      if (tagIds.length) vals.tag_ids = [[6, 0, tagIds]];
    } catch {}
  }

  const id = await create(session, M("MODEL_SALE_ORDER"), vals) as number;

  // "Forcer le statut à 'Entièrement facturé'" (champ custom force_invoiced d'un module
  // externe) → empêche la génération de facture à la validation du OUT. Write protégé :
  // si le champ n'existe pas (module absent), on n'interrompt pas l'import.
  if (opts.forceInvoiced) {
    try { await write(session, M("MODEL_SALE_ORDER"), [id], { force_invoiced: true }); } catch {}
  }

  // La pricelist est READONLY une fois la commande confirmée (state=sale).
  // On la (ré)impose donc TANT QU'ON EST EN BROUILLON, puis on recalcule les prix.
  if (pricelistId) {
    try {
      await write(session, M("MODEL_SALE_ORDER"), [id], { pricelist_id: pricelistId });
      try { await callMethod(session, M("MODEL_SALE_ORDER"), "action_update_prices", [[id]]); }
      catch { try { await callMethod(session, M("MODEL_SALE_ORDER"), "update_prices", [[id]]); } catch {} }
    } catch {}
  }

  let tntResult: { ok: boolean; reason?: string; serviceId?: number } | undefined;
  if (opts.confirm) {
    try {
      await callMethod(session, M("MODEL_SALE_ORDER"), "action_confirm", [[id]]);
      // pickings générés par la confirmation (sortie TNT)
      let outPickIds: number[] = [];
      try {
        const picks = await searchRead(session, M("MODEL_PICKING"),
          [["sale_id", "=", id], ["picking_type_code", "=", "outgoing"], ["state", "not in", ["done", "cancel"]]],
          ["id"], 10);
        outPickIds = picks.map((p: any) => p.id);
      } catch {}
      // réservation du stock
      if (opts.assign) {
        for (const pid of outPickIds) { try { await callMethod(session, M("MODEL_PICKING"), "action_assign", [[pid]]); } catch {} }
      }
      // service TNT par défaut (ex: "JE") sur le OUT
      if (opts.tntService && outPickIds.length) {
        try { tntResult = await applyTntServiceWithRetry(session, outPickIds[0], opts.tntService); }
        catch (e: any) { tntResult = { ok: false, reason: e?.message || "tnt-error" }; }
      }
    } catch {}
  }

  const recs = await searchRead(session, M("MODEL_SALE_ORDER"), [["id", "=", id]], ["id", "name"], 1);
  return { id, name: recs[0]?.name || String(id), tnt: tntResult };
}

// Stock disponible (quantity - reserved) par référence interne Odoo. Pour la synchro Shopware.
export async function getStockByRef(session: OdooSession, ref: string): Promise<{ productId: number; name: string; available: number } | null> {
  const prods = await searchRead(session, M("MODEL_PRODUCT"),
    ["|", ["default_code", "=", ref], ["barcode", "=", ref]],
    ["id", "name", "default_code", "qty_available"], 1);
  if (!prods.length) return null;
  const p = prods[0];
  // qty_available = stock physique ; on retire le réservé via les quants internes
  const quants = await searchRead(session, M("MODEL_QUANT"),
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
  const quants = await searchRead(session, M("MODEL_QUANT"),
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
  let r = await searchRead(session, M("MODEL_PARTNER"), [["name", "=", q], ["is_company", "=", true]], fields, 1);
  if (r.length) return { id: r[0].id, name: r[0].name };
  // 2) Réf exacte ET société
  r = await searchRead(session, M("MODEL_PARTNER"), [["ref", "=", q], ["is_company", "=", true]], fields, 1);
  if (r.length) return { id: r[0].id, name: r[0].name };
  // 3) Nom exact (toute fiche)
  r = await searchRead(session, M("MODEL_PARTNER"), [["name", "=", q]], fields, 1);
  if (r.length) return { id: r[0].id, name: r[0].name };
  // 4) Id interne si purement numérique
  if (/^\d+$/.test(q)) {
    r = await searchRead(session, M("MODEL_PARTNER"), [["id", "=", Number(q)]], fields, 1);
    if (r.length) return { id: r[0].id, name: r[0].name };
  }
  // 5) Réf exacte (dernier recours — peut être ambigu)
  r = await searchRead(session, M("MODEL_PARTNER"), [["ref", "=", q]], fields, 1);
  if (r.length) return { id: r[0].id, name: r[0].name };
  return null;
}

// ============================================
// PICK — Recoliser une ligne "en vrac" en plusieurs colis (ex: 200 -> 70/70/60)
// ============================================

export interface PickSplitPlanLine {
  moveLineId: number;
  product: string;
  lot: string;
  currentQty: number;
  currentPackage: string | null;
}

export interface PickSplitResult {
  ok: boolean;
  message: string;
  sourceLine?: PickSplitPlanLine;
  createdPackages?: { id: number; name: string; qty: number }[];
}

/**
 * Recolise une move line "en vrac" (result_package_id vide) d'un picking en
 * plusieurs colis selon une répartition de quantités (ex: [70, 70, 60]).
 *
 * Fonctionne même sur un picking VALIDÉ (done) : on ne touche pas au total
 * qty_done (la somme des parts doit être égale au qty_done de la ligne source),
 * on découpe la ligne en N sous-lignes et on crée/affecte un colis à chacune.
 *
 * IMPORTANT : la somme de `quantities` DOIT être égale à la quantité de la
 * ligne source, sinon on refuse (pour ne jamais modifier le stock total).
 *
 * @param dryRun  si true, ne fait AUCUNE écriture — renvoie seulement le plan.
 */
export async function splitPickLineIntoPackages(
  session: OdooSession,
  params: {
    pickingId: number;
    productId: number;   // ex: 1061021 -> passer l'id interne product.product
    lotId?: number;      // optionnel, pour cibler un lot précis (A436928)
    quantities: number[]; // ex: [70, 70, 60]
  },
  dryRun = true
): Promise<PickSplitResult> {
  const { pickingId, productId, lotId, quantities } = params;

  if (!quantities.length || quantities.some(q => q <= 0)) {
    return { ok: false, message: "Quantités invalides (toutes > 0 requises)." };
  }
  const target = quantities.reduce((a, b) => a + b, 0);

  // 1) Trouver la move line "en vrac" (sans colis) du produit/lot dans ce picking
  const domain: any[] = [
    ["picking_id", "=", pickingId],
    ["product_id", "=", productId],
    ["result_package_id", "=", false],
    ["qty_done", ">", 0],
  ];
  if (lotId) domain.push(["lot_id", "=", lotId]);

  const lines = await searchRead(
    session, M("MODEL_MOVE_LINE"), domain,
    ["id", "product_id", "lot_id", "qty_done", "reserved_uom_qty",
     "location_id", "location_dest_id", "move_id", "product_uom_id", "result_package_id"],
    50
  );

  if (!lines.length) {
    return { ok: false, message: "Aucune ligne 'en vrac' (sans colis) trouvée pour ce produit/lot dans ce picking." };
  }

  // On prend la ligne dont qty_done == target si possible, sinon la plus grosse.
  let src = lines.find((l: any) => (l.qty_done || 0) === target) || lines.sort((a: any, b: any) => (b.qty_done || 0) - (a.qty_done || 0))[0];

  const srcQty = src.qty_done || 0;
  const sourceLine: PickSplitPlanLine = {
    moveLineId: src.id,
    product: src.product_id?.[1] || String(productId),
    lot: src.lot_id?.[1] || "-",
    currentQty: srcQty,
    currentPackage: src.result_package_id ? src.result_package_id[1] : null,
  };

  if (srcQty !== target) {
    return {
      ok: false,
      message: `La ligne en vrac contient ${srcQty} unités mais la répartition demandée totalise ${target}. Ajuste les quantités pour qu'elles fassent exactement ${srcQty}, ou cible une autre ligne.`,
      sourceLine,
    };
  }

  if (dryRun) {
    return {
      ok: true,
      message: `PLAN (dry-run) : la ligne ${src.id} (${srcQty} u.) sera découpée en ${quantities.length} colis : ${quantities.join(" / ")}. Aucune écriture effectuée.`,
      sourceLine,
      createdPackages: quantities.map((q, i) => ({ id: -1, name: `NOUVEAU_COLIS_${i + 1}`, qty: q })),
    };
  }

  // 2) EXÉCUTION
  const created: { id: number; name: string; qty: number }[] = [];

  // 2a) La 1re part reste sur la ligne source : on réduit qty_done + reserved à quantities[0]
  //     et on lui crée un colis.
  const firstQty = quantities[0];
  await write(session, M("MODEL_MOVE_LINE"), [src.id], {
    qty_done: firstQty,
    reserved_uom_qty: Math.min(src.reserved_uom_qty || 0, firstQty),
  });
  const pkg0 = await createPackage(session);
  await write(session, M("MODEL_MOVE_LINE"), [src.id], { result_package_id: pkg0.id });
  created.push({ id: pkg0.id, name: pkg0.name, qty: firstQty });

  // 2b) Les parts suivantes : nouvelle move line + nouveau colis chacune.
  for (let i = 1; i < quantities.length; i++) {
    const q = quantities[i];
    const newLineId = await create(session, M("MODEL_MOVE_LINE"), {
      product_id: src.product_id?.[0],
      lot_id: src.lot_id?.[0] || false,
      location_id: src.location_id?.[0],
      location_dest_id: src.location_dest_id?.[0],
      picking_id: pickingId,
      move_id: src.move_id?.[0],
      product_uom_id: src.product_uom_id?.[0],
      qty_done: q,
      reserved_uom_qty: 0,
      result_package_id: false,
    }) as number;
    const pkg = await createPackage(session);
    await write(session, M("MODEL_MOVE_LINE"), [newLineId], { result_package_id: pkg.id });
    created.push({ id: pkg.id, name: pkg.name, qty: q });
  }

  return {
    ok: true,
    message: `OK : ${srcQty} u. réparties en ${created.length} colis (${created.map(c => `${c.name}:${c.qty}`).join(", ")}).`,
    sourceLine,
    createdPackages: created,
  };
}

// ============================================
// FABRICATION SIMPLIFIÉE (mrp.production)
// Crée un ordre de fabrication avec ses composants saisis à la main, puis le
// confirme (état "confirmed") sans le terminer : rien n'est consommé ni produit,
// on réserve juste les composants. La finalisation se fait dans Odoo.
// ============================================

export interface ManufactureComponent {
  productId: number;    // product.product
  qtyPerUnit: number;   // quantité consommée pour UN pack
  // Lot imposé. Appliqué après la confirmation de l'ordre (voir
  // createManufacturingOrder) : le poser à la création ferait échouer tout
  // l'ordre si le composant n'est pas encore disponible.
  lotId?: number | null;
}

export interface ManufactureResult {
  id: number;
  name: string;
  state: string;
  warning?: string;
}

/** Type d'opération "Fabrication" (mrp_operation) du premier entrepôt trouvé. */
async function findManufacturePickingType(session: OdooSession): Promise<number | null> {
  const types = await searchRead(
    session, M("MODEL_PICKING_TYPE"),
    [["code", "=", "mrp_operation"], ["active", "=", true]],
    ["id"], 1
  );
  return types?.[0]?.id ?? null;
}

/**
 * Crée un ordre de fabrication et le passe en "Confirmé".
 *
 * @param productId  produit fini (product.product)
 * @param qty        nombre de packs à fabriquer
 * @param components composants + quantité PAR PACK (multipliée par qty ici)
 * @param sourceLocationId emplacement de prélèvement des composants (optionnel)
 *
 * Les quantités sont multipliées côté WMS : l'utilisateur saisit "par pack", ce qui
 * est plus naturel, mais Odoo attend des quantités totales sur les move_raw_ids.
 */
export async function createManufacturingOrder(
  session: OdooSession,
  productId: number,
  qty: number,
  components: ManufactureComponent[],
  sourceLocationId?: number | null
): Promise<ManufactureResult> {
  if (!productId) throw new Error("Produit à fabriquer manquant");
  if (!(qty > 0)) throw new Error("Quantité à fabriquer invalide");
  const lines = components.filter(c => c.productId && c.qtyPerUnit > 0);
  if (!lines.length) throw new Error("Aucun composant à consommer");

  // UoM du produit fini — obligatoire à la création de l'OF.
  const [prod] = await searchRead(session, M("MODEL_PRODUCT"), [["id", "=", productId]], ["id", "name", "uom_id"], 1);
  if (!prod) throw new Error("Produit à fabriquer introuvable dans Odoo");
  const uomId = Array.isArray(prod.uom_id) ? prod.uom_id[0] : prod.uom_id;

  // UoM de chaque composant (Odoo exige product_uom_id sur les lignes).
  const compIds = lines.map(l => l.productId);
  const compRows = await searchRead(session, M("MODEL_PRODUCT"), [["id", "in", compIds]], ["id", "uom_id"], compIds.length);
  const uomByProduct: Record<number, number> = {};
  for (const r of compRows) uomByProduct[r.id] = Array.isArray(r.uom_id) ? r.uom_id[0] : r.uom_id;

  const vals: any = {
    product_id: productId,
    product_qty: qty,
    product_uom_id: uomId,
    // Pas de bom_id : la composition est saisie librement dans le WMS.
    // Format x2many Odoo : chaque ligne est la commande [0, 0, {valeurs}].
    // Sans ce triplet, Odoo reçoit un dict nu et lève "unhashable type: 'dict'".
    move_raw_ids: lines.map(l => {
      const move: any = {
        product_id: l.productId,
        product_uom_qty: l.qtyPerUnit * qty,
        product_uom: uomByProduct[l.productId],
      };
      // Emplacement de prélèvement imposé (l'emplacement scanné).
      if (sourceLocationId) move.location_id = sourceLocationId;
      // Le lot n'est pas posé ici mais après la confirmation (voir plus bas) :
      // le forcer dès la création fait échouer tout l'ordre quand le composant
      // n'est pas encore disponible.
      return [0, 0, move];
    }),
  };

  if (sourceLocationId) vals.location_src_id = sourceLocationId;

  const pickingTypeId = await findManufacturePickingType(session);
  if (pickingTypeId) vals.picking_type_id = pickingTypeId;

  const id = await create(session, M("MODEL_MRP_PRODUCTION"), vals) as number;

  // L'ordre est laissé en BROUILLON (draft) : on ne le confirme pas. Rien n'est
  // réservé ni consommé ; c'est toi qui confirmes/termines dans Odoo quand tu veux.
  let warning: string | undefined;

  // ── Lots choisis dans le WMS ────────────────────────────────────────────
  // Les mouvements composants (move_raw_ids) existent dès la création, même en
  // brouillon. On y attache le lot voulu via une ligne de détail à quantité 0 :
  // le lot est ainsi déjà inscrit et visible dans l'ordre, sans rien réserver.
  // Traitement tolérant : un échec ici n'annule pas l'ordre déjà créé.
  const withLots = lines.filter(l => l.lotId);
  if (withLots.length) {
    try {
      const moves = await searchRead(
        session, M("MODEL_MOVE"),
        [["raw_material_production_id", "=", id]],
        ["id", "product_id", "product_uom_qty", "product_uom", "location_id"],
        withLots.length * 4
      );
      const failures: string[] = [];

      for (const l of withLots) {
        const move = moves.find((m: any) => m.product_id?.[0] === l.productId);
        if (!move) continue;
        const totalQty = l.qtyPerUnit * qty;

        // Lignes de détail déjà créées par la réservation pour ce mouvement.
        const existing = await searchRead(
          session, M("MODEL_MOVE_LINE"), [["move_id", "=", move.id]], ["id", "lot_id"], 10
        );

        try {
          if (existing.length === 1) {
            // Cas courant : une seule ligne réservée → on lui impose notre lot.
            await write(session, M("MODEL_MOVE_LINE"), [existing[0].id], { lot_id: l.lotId });
          } else if (existing.length === 0) {
            // Rien de réservé (composant indisponible) → on crée la ligne avec le
            // lot voulu, en quantité 0 : Odoo la complètera à la réservation, mais
            // le lot choisi est déjà inscrit et visible dans l'ordre.
            const detail: any = {
              move_id: move.id,
              product_id: l.productId,
              product_uom_id: uomByProduct[l.productId] ?? move.product_uom?.[0],
              lot_id: l.lotId,
              quantity: 0,
            };
            const locId = sourceLocationId || move.location_id?.[0];
            if (locId) detail.location_id = locId;
            try {
              await create(session, M("MODEL_MOVE_LINE"), detail);
            } catch (e1: any) {
              // Selon la version d'Odoo le champ quantité s'appelle "quantity"
              // (v17+) ou "qty_done" (avant). On retente avec l'autre nom plutôt
              // que d'abandonner le lot.
              delete detail.quantity;
              detail.qty_done = 0;
              try {
                await create(session, M("MODEL_MOVE_LINE"), detail);
              } catch {
                throw e1; // on remonte la première erreur, plus parlante
              }
            }
          } else {
            // Plusieurs lignes (lots panachés par Odoo) : on ne touche à rien
            // pour ne pas casser une réservation déjà cohérente.
            failures.push(`${l.productId} (déjà réparti sur ${existing.length} lots)`);
          }
        } catch (e: any) {
          failures.push(`${l.productId} : ${safeErrMsg(e)}`);
        }
        void totalQty;
      }

      if (failures.length) {
        // On remonte la cause Odoo telle quelle : sans elle, impossible de savoir
        // pourquoi le lot n'apparaît pas (champ absent, ligne refusée, etc.).
        const msg = `Lot non appliqué — ${failures.join(" ; ")}`;
        warning = warning ? `${warning} ${msg}` : msg;
      }
    } catch (e: any) {
      const msg = `Lots non appliqués : ${safeErrMsg(e)}`;
      warning = warning ? `${warning} ${msg}` : msg;
    }
  }

  const [saved] = await searchRead(session, M("MODEL_MRP_PRODUCTION"), [["id", "=", id]], ["id", "name", "state"], 1);
  return {
    id,
    name: saved?.name || `OF#${id}`,
    state: saved?.state || "draft",
    warning,
  };
}

/** Derniers ordres de fabrication, pour le récap dans le WMS. */
export async function getRecentManufacturingOrders(
  session: OdooSession,
  limit = 15
): Promise<{ id: number; name: string; product: string; qty: number; state: string; date: string }[]> {
  const rows = await searchRead(
    session, M("MODEL_MRP_PRODUCTION"), [],
    ["id", "name", "product_id", "product_qty", "state", "create_date"],
    limit, "id desc"
  );
  return (rows || []).map((r: any) => ({
    id: r.id,
    name: r.name || "",
    product: Array.isArray(r.product_id) ? r.product_id[1] : "",
    qty: r.product_qty || 0,
    state: r.state || "",
    date: r.create_date || "",
  }));
}

export interface LocationStockItem {
  productId: number;
  productName: string;
  productRef: string;
  lotId: number | null;
  lotName: string;
  qty: number;          // disponible net (physique - réservé) — peut être 0
  onHand: number;       // stock physique à l'emplacement (réservations comprises)
  reserved: number;     // quantité déjà réservée par d'autres opérations
  expirationDate: string;
}

/**
 * Résout un emplacement scanné (code-barres ou nom) et retourne son contenu,
 * une ligne par couple produit/lot. Utilisé par la fabrication : les composants
 * à picker sont tous dans un emplacement dédié, on scanne l'emplacement une fois
 * puis on choisit dedans plutôt que de chercher chaque produit à la main.
 *
 * Tri FEFO (péremption la plus courte d'abord) pour que le lot à écouler soit en tête.
 */
export async function getLocationStockForPicking(
  session: OdooSession,
  code: string
): Promise<{ location: { id: number; name: string } | null; items: LocationStockItem[] }> {
  const trimmed = (code || "").trim();
  if (!trimmed) return { location: null, items: [] };
  const upper = trimmed.toUpperCase();
  const fields = ["id", "name", "complete_name", "barcode"];

  let locs = await searchRead(session, M("MODEL_LOCATION"), [["barcode", "=", trimmed]], fields, 1);
  if (!locs.length && upper !== trimmed) {
    locs = await searchRead(session, M("MODEL_LOCATION"), [["barcode", "=", upper]], fields, 1);
  }
  if (!locs.length) locs = await searchRead(session, M("MODEL_LOCATION"), [["barcode", "ilike", trimmed]], fields, 1);
  if (!locs.length) locs = await searchRead(session, M("MODEL_LOCATION"), [["complete_name", "ilike", trimmed]], fields, 1);
  if (!locs.length) return { location: null, items: [] };

  const loc = locs[0];
  const quants = await getProductsAtLocation(session, loc.id);

  const items: LocationStockItem[] = (quants || []).map((q: any) => ({
    productId: q.product_id?.[0],
    productName: q.product_id?.[1] || "",
    productRef: q.product_ref || "",
    lotId: q.lot_id ? q.lot_id[0] : null,
    lotName: q.lot_name || (q.lot_id ? q.lot_id[1] : "") || "",
    // Disponible net : ce qui n'est pas déjà réservé par une autre opération.
    // Peut être 0 alors qu'il y a du stock physique (tout est réservé ailleurs).
    qty: (q.quantity || 0) - (q.reserved_quantity || 0),
    // Stock physique présent à l'emplacement, réservations comprises.
    onHand: q.quantity || 0,
    reserved: q.reserved_quantity || 0,
    expirationDate: q.expiration_date || "",
    // On filtre sur le PHYSIQUE, pas sur le disponible : un composant entièrement
    // réservé ailleurs doit rester sélectionnable (l'ordre attendra la dispo).
  })).filter((it: LocationStockItem) => it.productId && it.onHand > 0);

  // FEFO : les lots qui périment le plus tôt en premier, sans date à la fin.
  items.sort((a, b) => {
    if (a.productName !== b.productName) return a.productName.localeCompare(b.productName);
    if (!a.expirationDate) return 1;
    if (!b.expirationDate) return -1;
    return a.expirationDate < b.expirationDate ? -1 : 1;
  });

  return { location: { id: loc.id, name: loc.complete_name || loc.name }, items };
}

/**
 * Stock d'un produit sur TOUS les emplacements internes, une ligne par lot
 * et emplacement. Complète getLocationStockForPicking pour le cas où les
 * composants ne sont pas regroupés dans un emplacement dédié : on cherche le
 * produit, et on choisit le lot/emplacement dans la liste.
 *
 * Trié FEFO (péremption la plus courte d'abord), comme la vue par emplacement.
 */
export async function getProductStockByLocation(
  session: OdooSession,
  productId: number
): Promise<(LocationStockItem & { locationId: number; locationName: string })[]> {
  if (!productId) return [];

  const quants = await searchRead(
    session, M("MODEL_QUANT"),
    [["product_id", "=", productId], ["location_id.usage", "=", "internal"], ["quantity", ">", 0]],
    ["id", "product_id", "location_id", "lot_id", "quantity", "reserved_quantity"],
    300
  );
  if (!quants.length) return [];

  // Péremption des lots concernés (pour le tri FEFO et l'affichage).
  const lotIds = Array.from(new Set(quants.filter((q: any) => q.lot_id).map((q: any) => q.lot_id[0])));
  const lotMap: Record<number, any> = {};
  if (lotIds.length) {
    const lots = await searchRead(
      session, M("MODEL_LOT"), [["id", "in", lotIds]],
      ["id", "name", "expiration_date", "use_date", "removal_date"], lotIds.length
    );
    for (const l of lots) lotMap[l.id] = l;
  }

  // Référence produit (une seule lecture, même produit pour toutes les lignes).
  const [prod] = await searchRead(session, M("MODEL_PRODUCT"), [["id", "=", productId]], ["id", "name", "default_code"], 1);

  type Row = LocationStockItem & { locationId: number; locationName: string };
  const items: Row[] = quants.map((q: any) => {
    const lot = q.lot_id ? lotMap[q.lot_id[0]] : null;
    return {
      productId,
      productName: prod?.name || q.product_id?.[1] || "",
      productRef: prod?.default_code || "",
      lotId: q.lot_id ? q.lot_id[0] : null,
      lotName: lot?.name || (q.lot_id ? q.lot_id[1] : "") || "",
      qty: (q.quantity || 0) - (q.reserved_quantity || 0),
      onHand: q.quantity || 0,
      reserved: q.reserved_quantity || 0,
      expirationDate: lot?.expiration_date || lot?.use_date || lot?.removal_date || "",
      locationId: q.location_id?.[0],
      locationName: q.location_id?.[1] || "",
    };
  });

  items.sort((a, b) => {
    if (!a.expirationDate) return 1;
    if (!b.expirationDate) return -1;
    return a.expirationDate < b.expirationDate ? -1 : 1;
  });

  return items;
}

export interface ManufactureLine {
  moveLineId: number | null; // stock.move.line (null si aucune ligne de détail encore)
  moveId: number;            // stock.move (raw material)
  productId: number;
  productName: string;
  lotName: string;
  reserved: number;          // quantité réservée
  done: number;              // quantité "Fait" (consommée à la validation)
}

export interface ManufactureDetail {
  id: number;
  name: string;
  state: string;
  product: string;
  qty: number;
  lines: ManufactureLine[];
  qtyDoneField: "quantity" | "qty_done"; // nom du champ selon la version d'Odoo
}

/** Détail d'un ordre de fabrication : ses composants et l'état réservé/fait. */
export async function getManufacturingOrderDetail(
  session: OdooSession,
  orderId: number
): Promise<ManufactureDetail> {
  const [order] = await searchRead(
    session, M("MODEL_MRP_PRODUCTION"), [["id", "=", orderId]],
    ["id", "name", "state", "product_id", "product_qty"], 1
  );
  if (!order) throw new Error("Ordre de fabrication introuvable");

  const moves = await searchRead(
    session, M("MODEL_MOVE"),
    [["raw_material_production_id", "=", orderId]],
    ["id", "product_id", "product_uom_qty"], 200
  );

  // Détecte le nom du champ "quantité faite" sur stock.move.line (varie selon version).
  let qtyDoneField: "quantity" | "qty_done" = "quantity";
  try {
    const fields = await callMethod(session, M("MODEL_MOVE_LINE"), "fields_get", [[], ["name"]]);
    if (fields && !("quantity" in fields) && ("qty_done" in fields)) qtyDoneField = "qty_done";
  } catch { /* défaut "quantity" (Odoo 17+) */ }

  const moveIds = moves.map((m: any) => m.id);
  const mlines = moveIds.length
    ? await searchRead(
        session, M("MODEL_MOVE_LINE"),
        [["move_id", "in", moveIds]],
        ["id", "move_id", "product_id", "lot_id", "reserved_uom_qty", qtyDoneField], 500
      )
    : [];

  const lines: ManufactureLine[] = [];
  for (const m of moves) {
    const forMove = mlines.filter((ml: any) => ml.move_id?.[0] === m.id);
    if (forMove.length) {
      for (const ml of forMove) {
        lines.push({
          moveLineId: ml.id, moveId: m.id,
          productId: m.product_id?.[0],
          productName: m.product_id?.[1] || "",
          lotName: ml.lot_id ? ml.lot_id[1] : "",
          reserved: ml.reserved_uom_qty || 0,
          done: ml[qtyDoneField] || 0,
        });
      }
    } else {
      // Mouvement sans ligne de détail (rien de réservé) → ligne "vide".
      lines.push({
        moveLineId: null, moveId: m.id,
        productId: m.product_id?.[0],
        productName: m.product_id?.[1] || "",
        lotName: "",
        reserved: 0,
        done: 0,
      });
    }
  }

  return {
    id: order.id,
    name: order.name || "",
    state: order.state || "",
    product: Array.isArray(order.product_id) ? order.product_id[1] : "",
    qty: order.product_qty || 0,
    lines,
    qtyDoneField,
  };
}

/**
 * Pré-remplit la colonne "Fait" = quantité réservée sur toutes les lignes d'un
 * ordre, SANS valider. L'ordre reste ouvert : tu contrôles puis tu cliques
 * "Marquer comme fait" dans Odoo. Rien n'est consommé ici.
 *
 * Ne touche qu'aux lignes réservées (reserved > 0) : une ligne à 0 réservé n'a
 * rien à "faire". Retourne le nombre de lignes mises à jour.
 */
/**
 * Termine un ordre de fabrication : consomme les composants et produit le fini.
 *
 * Validation STRICTE, comme pour l'emballage. Si Odoo propose un reliquat —
 * c'est-à-dire qu'on produit moins que prévu — on refuse et on renvoie la main :
 * créer un reliquat en silence laisserait un ordre fantôme que personne ne
 * cherchera, et fausserait le suivi de production.
 */
export async function markManufacturingDone(
  session: OdooSession, orderId: number,
): Promise<{ done: boolean; name: string; state: string }> {
  const res = await callMethod(session, M("MODEL_MRP_PRODUCTION"), "button_mark_done", [[orderId]]);

  if (res && typeof res === "object" && (res as any).res_model) {
    const model = (res as any).res_model;
    const wid = (res as any).res_id;
    const ctx = (res as any).context || {};
    if (model === "mrp.immediate.production") {
      // « Quantités non renseignées » : Odoo propose de produire le prévu.
      await callMethod(session, model, "process", [[wid]], { context: ctx });
    } else if (model === "mrp.production.backorder") {
      throw new Error(
        "Odoo demande un reliquat : la quantité produite est inférieure au prévu. "
        + "À traiter dans Odoo pour choisir ce qu'il advient du reste.");
    } else {
      throw new Error(`Fenêtre Odoo inattendue (${model}) — fabrication non validée automatiquement`);
    }
  }

  // Relecture : seule preuve que l'ordre est réellement terminé. Une méthode
  // peut répondre sans erreur sans que l'état ait changé.
  const [o] = await searchRead(session, M("MODEL_MRP_PRODUCTION"),
    [["id", "=", orderId]], ["id", "name", "state"], 1);
  return { done: o?.state === "done", name: o?.name || "", state: o?.state || "" };
}

export async function fillManufacturingDone(
  session: OdooSession,
  orderId: number
): Promise<{ updated: number; skipped: number; confirmed?: boolean; reserved?: boolean }> {
  let detail = await getManufacturingOrderDetail(session, orderId);
  let confirmed = false, reserved = false;

  // Un ordre en BROUILLON n'a aucune réservation : Odoo n'affecte le stock qu'à
  // la confirmation. Le remplissage trouvait donc « réservé = 0 » partout et
  // annonçait des composants indisponibles, alors que le stock est là.
  if (detail.state === "draft") {
    await callMethod(session, M("MODEL_MRP_PRODUCTION"), "action_confirm", [[orderId]]);
    confirmed = true;
  }

  // Puis on demande la réservation. Sans elle, un ordre confirmé mais jamais
  // assigné présente les mêmes symptômes.
  if (detail.lines.every(l => (l.reserved || 0) <= 0)) {
    try {
      await callMethod(session, M("MODEL_MRP_PRODUCTION"), "action_assign", [[orderId]]);
      reserved = true;
    } catch { /* stock réellement insuffisant : on le verra à la relecture */ }
  }

  if (confirmed || reserved) detail = await getManufacturingOrderDetail(session, orderId);

  let updated = 0, skipped = 0;
  for (const l of detail.lines) {
    if (!l.moveLineId || l.reserved <= 0) { skipped++; continue; }
    if (l.done === l.reserved) { updated++; continue; } // déjà rempli
    await write(session, M("MODEL_MOVE_LINE"), [l.moveLineId], { [detail.qtyDoneField]: l.reserved });
    updated++;
  }
  return { updated, skipped, confirmed, reserved };
}
