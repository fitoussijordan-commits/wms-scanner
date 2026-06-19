// app/api/cron/dlv-sale-ok/route.ts
//
// Cron Vercel — 1x/jour à 2h
// Pour les catégories 1 (Vente), 4 (Miniature), 6 (PLV), L (Lot échantillons) :
//   - stock dispo (qty - reserved) = 0  → sale_ok = false
//   - stock dispo >= 1 et sale_ok = false → sale_ok = true
// Les articles exclus via l'interface (table Supabase wms_cron_exclusions) sont ignorés.
//
// Env vars requises :
//   ODOO_URL, ODOO_DB, ODOO_LOGIN, ODOO_PASSWORD
//   NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY (déjà dans Vercel)

import { NextRequest, NextResponse } from "next/server";

const CRON_SECRET  = process.env.CRON_SECRET;
const ODOO_URL     = (process.env.ODOO_URL || "").replace(/\/$/, "");
const ODOO_DB      = process.env.ODOO_DB     || "";
const ODOO_LOGIN   = process.env.ODOO_LOGIN  || "";
const ODOO_PASS    = process.env.ODOO_PASSWORD || "";
const SB_URL       = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
const SB_ANON      = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

// Préfixes de référence ciblés : 1=Vente, 4=Miniature, 6=PLV, L=Lot échantillons
const TARGET_PREFIXES = ["1", "4", "6", "L"];

// ── Supabase : lecture des exclusions ────────────────────────────────────────

async function fetchCronExclusions(): Promise<Set<string>> {
  if (!SB_URL || !SB_ANON) return new Set();
  try {
    const res = await fetch(`${SB_URL}/rest/v1/wms_cron_exclusions?select=odoo_ref`, {
      headers: { apikey: SB_ANON, Authorization: `Bearer ${SB_ANON}` },
    });
    if (!res.ok) return new Set();
    const data: { odoo_ref: string }[] = await res.json();
    return new Set(data.map(d => d.odoo_ref));
  } catch {
    return new Set();
  }
}

// ── Helpers RPC Odoo (appel direct serveur → pas de proxy browser) ────────────

async function odooRpc(endpoint: string, params: any, sessionId?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (sessionId) headers["Cookie"] = `session_id=${sessionId}`;

  const res = await fetch(`${ODOO_URL}${endpoint}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", id: Date.now(), params }),
  });

  const data = await res.json();
  if (data.error) throw new Error(data.error.data?.message || data.error.message || JSON.stringify(data.error));

  // Récupère le session_id rafraîchi
  let newSid: string | undefined;
  const setCookie = res.headers.get("set-cookie") || "";
  const m = setCookie.match(/session_id=([^;]+)/);
  if (m) newSid = m[1];

  return { result: data.result, sessionId: newSid };
}

async function authenticate(): Promise<string> {
  const { result } = await odooRpc("/web/session/authenticate", {
    db: ODOO_DB, login: ODOO_LOGIN, password: ODOO_PASS,
  });
  if (!result?.uid) throw new Error("Authentification Odoo échouée");
  return result.session_id || "";
}

async function searchRead(sid: string, model: string, domain: any[], fields: string[], limit = 0): Promise<any[]> {
  const { result } = await odooRpc("/web/dataset/call_kw", {
    model, method: "search_read",
    args: [domain],
    kwargs: { fields, limit, context: { lang: "fr_FR" } },
  }, sid);
  return result || [];
}

async function writeRecords(sid: string, model: string, ids: number[], values: any): Promise<void> {
  await odooRpc("/web/dataset/call_kw", {
    model, method: "write",
    args: [ids, values],
    kwargs: { context: { lang: "fr_FR" } },
  }, sid);
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  // Vérification CRON_SECRET si défini
  if (CRON_SECRET) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${CRON_SECRET}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  if (!ODOO_URL || !ODOO_DB || !ODOO_LOGIN || !ODOO_PASS) {
    return NextResponse.json({ error: "Variables d'environnement Odoo manquantes" }, { status: 500 });
  }

  const log: string[] = [];
  const ts = new Date().toISOString();

  try {
    const [sid, exclusions] = await Promise.all([authenticate(), fetchCronExclusions()]);
    log.push(`[${ts}] Auth OK`);
    log.push(`Exclusions : ${exclusions.size} article(s) ignoré(s)`);

    // 1. Récupère tous les produits actifs des catégories cibles (filtre sur default_code)
    const allProducts: any[] = await searchRead(
      sid, "product.product",
      [
        ["active", "=", true],
        ["default_code", "!=", false],
      ],
      ["id", "default_code", "sale_ok", "qty_available", "virtual_available", "product_tmpl_id"],
      0
    );

    // Filtre côté JS sur le préfixe + exclusions Supabase
    const targeted = allProducts.filter(p => {
      const ref = (p.default_code || "").trim().toUpperCase();
      return TARGET_PREFIXES.some(pfx => ref.startsWith(pfx)) && !exclusions.has(ref);
    });

    log.push(`Produits ciblés : ${targeted.length} (catégories ${TARGET_PREFIXES.join("/")})`);

    // 2. Récupère le stock réservé par produit via stock.quant
    const productIds = targeted.map(p => p.id);
    const quants: any[] = productIds.length
      ? await searchRead(
          sid, "stock.quant",
          [["product_id", "in", productIds], ["location_id.usage", "=", "internal"]],
          ["product_id", "quantity", "reserved_quantity"],
          0
        )
      : [];

    // Agrège par product_id
    const reservedByProduct: Record<number, number> = {};
    const onHandByProduct: Record<number, number> = {};
    for (const q of quants) {
      const pid = q.product_id[0];
      onHandByProduct[pid]  = (onHandByProduct[pid]  || 0) + (q.quantity          || 0);
      reservedByProduct[pid] = (reservedByProduct[pid] || 0) + (q.reserved_quantity || 0);
    }

    // 3. Calcule les changements nécessaires
    const toDisable: number[] = []; // tmpl_id à passer sale_ok = false
    const toEnable:  number[] = []; // tmpl_id à passer sale_ok = true

    for (const p of targeted) {
      const onHand  = onHandByProduct[p.id]   || 0;
      const reserved = reservedByProduct[p.id] || 0;
      const dispo   = Math.max(0, onHand - reserved);

      if (dispo <= 0 && p.sale_ok === true) {
        toDisable.push(p.product_tmpl_id[0] ?? p.product_tmpl_id);
      } else if (dispo >= 1 && p.sale_ok === false) {
        toEnable.push(p.product_tmpl_id[0] ?? p.product_tmpl_id);
      }
    }

    log.push(`À désactiver (dispo=0) : ${toDisable.length} | À réactiver (dispo≥1) : ${toEnable.length}`);

    // 4. Applique les writes par batch de 50
    const BATCH = 50;
    for (let i = 0; i < toDisable.length; i += BATCH) {
      await writeRecords(sid, "product.template", toDisable.slice(i, i + BATCH), { sale_ok: false });
    }
    for (let i = 0; i < toEnable.length; i += BATCH) {
      await writeRecords(sid, "product.template", toEnable.slice(i, i + BATCH), { sale_ok: true });
    }

    log.push(`Done ✓`);
    console.log(log.join("\n"));

    return NextResponse.json({
      ok: true,
      ts,
      targeted: targeted.length,
      disabled: toDisable.length,
      enabled: toEnable.length,
      log,
    });

  } catch (e: any) {
    console.error(`[dlv-sale-ok cron] Erreur :`, e.message);
    return NextResponse.json({ ok: false, error: e.message, ts }, { status: 500 });
  }
}
