// app/api/fix-shipping-date/route.ts
// ─────────────────────────────────────────────────────────────────────────────
// MAINTENANCE — À USAGE UNIQUE, SUPPRIMABLE UNE FOIS LA CORRECTION FAITE.
//
// Rattrapage des commandes e-shop sorties par le cron AVANT le correctif de la
// date d'expédition prévue : le cron ne posait que commitment_date, pas le champ
// custom Studio. Ces commandes se retrouvent donc sans date d'expédition prévue.
//
// Ce que fait la route : pour chaque commande (sale.order) donnée par son nom
// (S71566, S71559, …), écrit la date d'expédition prévue = SA date de création,
// convertie en heure de Paris. N'écrit QUE sur sale.order — les pickings, déjà
// validés, ne sont pas touchés.
//
// Sécurité :
//   - Authorization: Bearer {CRON_SECRET} obligatoire
//   - les commandes qui ont DÉJÀ une date sont ignorées (jamais écrasées),
//     sauf ?force=1
//   - ?dry=1 pour simuler sans rien écrire
//
// Appels :
//   POST /api/fix-shipping-date              → applique sur la liste par défaut
//   GET  /api/fix-shipping-date?dry=1        → simulation
//   POST /api/fix-shipping-date  body {"orders":["S71566","S71559"]}  → liste custom
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { fetchT } from "@/lib/fetchTimeout";
import { loadFieldOverrides, getFixShipDateStatus, saveFixShipDateStatus } from "@/lib/supabase";
import { F, setFieldOverrides } from "@/lib/fieldMap";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const ODOO_URL = process.env.ODOO_URL || "";
const ODOO_DB = process.env.ODOO_DB || "";
const ODOO_USER = process.env.ODOO_LOGIN || "";
const ODOO_PASS = process.env.ODOO_PASSWORD || "";

// Liste fournie par Jordan — commandes e-shop déjà sorties, sans date d'expédition.
const DEFAULT_ORDERS = [
  "S71566", "S71559", "S71554", "S71547", "S71546", "S71545", "S71544", "S71543",
  "S71542", "S71541", "S71540", "S71539", "S71538", "S71537", "S71536", "S71535",
  "S71534", "S71532", "S71531", "S71530", "S71527", "S71524", "S71522", "S71521",
  "S71520", "S71517", "S71516", "S71515", "S71514", "S71512", "S71510", "S71502",
  "S71489", "S71482", "S71477", "S71474", "S71473", "S71470", "S71467", "S71457",
  "S71449", "S71440", "S71432", "S71417", "S71411", "S71404", "S71403", "S71401",
  "S71400", "S71395", "S71391", "S71385", "S71376", "S71366", "S71363", "S71361",
  "S71347", "S71346", "S71345", "S71343", "S71341", "S71340", "S71338", "S71335",
  "S71329", "S71312", "S71297", "S71287", "S71279", "S71275", "S71271", "S71263",
];

function safeErrMsg(e: any): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try { return JSON.stringify(e); } catch { return String(e); }
}

// ─── Odoo JSON-RPC (sans contexte navigateur) ───────────────────────────────

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

// ─── Conversion create_date (UTC) → date du jour en heure de Paris ──────────
// Odoo stocke create_date en UTC ("YYYY-MM-DD HH:MM:SS"). Une commande créée à
// 23h30 heure de Paris est stockée au 21h30 UTC du même jour en hiver, mais une
// commande créée à 00h30 heure de Paris est stockée à 22h30 UTC LA VEILLE :
// sans conversion, on daterait la sortie du mauvais jour.
function utcSqlToParisDate(sqlUtc: string): string | null {
  if (!sqlUtc || typeof sqlUtc !== "string") return null;
  const m = sqlUtc.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  if (isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find(p => p.type === t)?.value;
  const y = get("year"), mo = get("month"), da = get("day");
  return y && mo && da ? `${y}-${mo}-${da}` : null;
}

// ─── Traitement ─────────────────────────────────────────────────────────────

interface RowReport {
  name: string;
  id?: number;
  createDate?: string;
  newShippingDate?: string;
  previous?: string | null;
  action: "écrit" | "simulé" | "déjà renseigné" | "introuvable" | "date illisible" | "erreur";
  error?: string;
}

async function run(orders: string[], dry: boolean, force: boolean): Promise<any> {
  const log: string[] = [];
  const L = (s: string) => { console.log(s); log.push(s); };

  if (!ODOO_URL || !ODOO_DB || !ODOO_USER || !ODOO_PASS) {
    throw new Error("Odoo non configuré (ODOO_URL / ODOO_DB / ODOO_LOGIN / ODOO_PASSWORD)");
  }

  // Même mapping de champs que l'app (roue crantée) — sinon on écrirait sur un
  // nom de champ obsolète si le champ Studio a été renommé.
  let shipField: string;
  try {
    setFieldOverrides(await loadFieldOverrides());
  } catch (e: any) {
    L(`⚠ Mapping champs non chargé, valeurs par défaut : ${safeErrMsg(e)}`);
  }
  shipField = F("SHIPPING_DATE");
  L(`Champ cible : sale.order.${shipField}`);
  L(`${orders.length} commande(s) demandée(s)${dry ? " — SIMULATION, aucune écriture" : ""}${force ? " — FORCE : les dates existantes seront écrasées" : ""}`);

  const s = await odooAuth();
  L(`Odoo OK (uid=${s.uid})`);

  // Lecture des commandes ciblées
  const recs: any[] = await odooCall(s, "sale.order", "search_read", [[["name", "in", orders]]], {
    fields: ["id", "name", "create_date", shipField],
    limit: orders.length * 2,
  });
  const byName: Record<string, any> = {};
  for (const r of recs) byName[r.name] = r;
  L(`${recs.length} commande(s) trouvée(s) dans Odoo`);

  const report: RowReport[] = [];
  // Regroupement par date cible : un seul write par date au lieu d'un par commande.
  const idsByDate: Record<string, number[]> = {};

  for (const name of orders) {
    const r = byName[name];
    if (!r) { report.push({ name, action: "introuvable" }); continue; }

    const previous = r[shipField] || null;
    if (previous && !force) {
      report.push({ name, id: r.id, previous, action: "déjà renseigné" });
      continue;
    }

    const newDate = utcSqlToParisDate(r.create_date);
    if (!newDate) {
      report.push({ name, id: r.id, createDate: r.create_date, action: "date illisible" });
      continue;
    }

    report.push({
      name, id: r.id, createDate: r.create_date, newShippingDate: newDate, previous,
      action: dry ? "simulé" : "écrit",
    });
    if (!dry) (idsByDate[newDate] ||= []).push(r.id);
  }

  // Écriture groupée
  const writeErrors: { date: string; error: string }[] = [];
  if (!dry) {
    for (const [date, ids] of Object.entries(idsByDate)) {
      try {
        await odooCall(s, "sale.order", "write", [ids, { [shipField]: date }]);
        L(`✅ ${ids.length} commande(s) → ${date}`);
      } catch (e: any) {
        const msg = safeErrMsg(e);
        writeErrors.push({ date, error: msg });
        L(`⚠ Échec écriture pour ${date} (${ids.length} commande(s)) : ${msg}`);
        for (const row of report) {
          if (row.newShippingDate === date && row.action === "écrit") { row.action = "erreur"; row.error = msg; }
        }
      }
    }
  }

  const count = (a: RowReport["action"]) => report.filter(r => r.action === a).length;
  const summary = {
    demandées:        orders.length,
    écrites:          count("écrit"),
    simulées:         count("simulé"),
    déjàRenseignées:  count("déjà renseigné"),
    introuvables:     count("introuvable"),
    dateIllisible:    count("date illisible"),
    erreurs:          count("erreur"),
  };
  L(`Résumé : ${JSON.stringify(summary)}`);

  // Mémorise l'exécution → le bouton disparaît de l'écran E-shop, sur tous les postes.
  // Uniquement si ce n'était pas une simulation et qu'aucune écriture n'a échoué :
  // en cas d'échec partiel, le bouton reste pour pouvoir relancer.
  if (!dry && writeErrors.length === 0) {
    try {
      await saveFixShipDateStatus({
        doneAt:  new Date().toISOString(),
        updated: summary.écrites,
        skipped: summary.déjàRenseignées,
      });
      L("Correction marquée comme faite — le bouton disparaît de l'écran E-shop.");
    } catch (e: any) { L(`⚠ Statut non enregistré (le bouton restera visible) : ${safeErrMsg(e)}`); }
  }

  return {
    ok: writeErrors.length === 0,
    dryRun: dry,
    force,
    champ: `sale.order.${shipField}`,
    summary,
    introuvables: report.filter(r => r.action === "introuvable").map(r => r.name),
    detail: report,
    writeErrors,
    log,
  };
}

// Deux façons de s'authentifier :
//  - Bearer {CRON_SECRET} → appel depuis un terminal / un job externe
//  - x-wms-token          → appel depuis l'app (bouton de l'écran E-shop)
//
// ⚠ Le token d'écriture de l'app est WMS_WRITE_TOKEN côté serveur (= la valeur de
// NEXT_PUBLIC_WMS_TOKEN côté client), comme dans cronjob-control et shopware-explore.
// WMS_INTERNAL_TOKEN (lib/apiAuth) est une AUTRE variable, non configurée sur ce
// projet : s'en servir ici renvoyait systématiquement « Non autorisé ».
// On accepte les deux, celle qui est renseignée gagne.
function checkAuth(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET || "";
  if (cronSecret && (req.headers.get("authorization") || "") === `Bearer ${cronSecret}`) return true;

  const received = req.headers.get("x-wms-token") || "";
  if (!received) return false;
  const accepted = [process.env.WMS_WRITE_TOKEN || "", process.env.WMS_INTERNAL_TOKEN || ""].filter(Boolean);
  return accepted.some(expected => expected === received);
}

function parseOpts(req: NextRequest, body?: any) {
  const { searchParams } = new URL(req.url);
  const dry = searchParams.get("dry") === "1" || body?.dry === true;
  const force = searchParams.get("force") === "1" || body?.force === true;
  let orders: string[] = DEFAULT_ORDERS;
  if (Array.isArray(body?.orders) && body.orders.length) {
    orders = body.orders.map((x: any) => String(x).trim()).filter(Boolean);
  } else {
    const q = searchParams.get("orders");
    if (q) orders = q.split(",").map(x => x.trim()).filter(Boolean);
  }
  return { orders: Array.from(new Set(orders)), dry, force };
}

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: "Non autorisé" }, { status: 401 });
  let body: any = null;
  try { body = await req.json(); } catch { /* corps vide accepté */ }
  const { orders, dry, force } = parseOpts(req, body);
  try {
    return NextResponse.json(await run(orders, dry, force));
  } catch (e: any) {
    console.error("[fix-shipping-date]", e);
    return NextResponse.json({ ok: false, error: safeErrMsg(e) }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);

  // Statut sans authentification : l'écran E-shop s'en sert pour savoir s'il doit
  // encore afficher le bouton. Ne divulgue rien de sensible.
  if (searchParams.get("status") === "1") {
    const done = await getFixShipDateStatus().catch(() => null);
    return NextResponse.json({
      route: "fix-shipping-date",
      done: !!done,
      status: done,
      pending: DEFAULT_ORDERS.length,
      // Diagnostic non sensible : dit SI un token est configuré, jamais sa valeur.
      // Permet de comprendre un « Non autorisé » sans fouiller les variables Vercel.
      auth: {
        serverWriteToken: !!process.env.WMS_WRITE_TOKEN,
        serverInternalToken: !!process.env.WMS_INTERNAL_TOKEN,
        cronSecret: !!process.env.CRON_SECRET,
      },
    });
  }

  if (!checkAuth(req)) {
    return NextResponse.json({
      route: "fix-shipping-date",
      description: "Maintenance à usage unique. Écrit la date d'expédition prévue = date de création sur les sale.order listées. Auth : Bearer {CRON_SECRET} ou entête x-wms-token. ?status=1 pour l'état, ?dry=1 simule, ?force=1 écrase les dates existantes, ?orders=S1,S2 pour une liste custom.",
      commandesParDéfaut: DEFAULT_ORDERS.length,
    });
  }
  const { orders, dry, force } = parseOpts(req);
  try {
    return NextResponse.json(await run(orders, dry, force));
  } catch (e: any) {
    console.error("[fix-shipping-date]", e);
    return NextResponse.json({ ok: false, error: safeErrMsg(e) }, { status: 500 });
  }
}
