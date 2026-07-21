// app/api/alerts-cron/route.ts
// Cron quotidien — Fait tourner l'agent de surveillance WMS (odoo.collectAlerts) et
// sauvegarde le résultat dans un historique consultable depuis l'app (AlertsDashboard),
// sans avoir à ouvrir l'écran soi-même pour déclencher l'analyse.
//
// Détecte : stock négatif, retours en attente, DLV/DLC courtes, stock non vendable
// avec stock, sorties orphelines, produits sans règle de rangement.
//
// Appel : GET ou POST /api/alerts-cron
//         Authorization: Bearer {CRON_SECRET}

import { NextRequest, NextResponse } from "next/server";
import * as odoo from "@/lib/odoo";
import { saveAlertsCronStatus, getAlertsCronHistory } from "@/lib/supabase";

// collectAlerts fait plusieurs requêtes Odoo lourdes (parallélisées, mais l'ensemble peut
// tout de même dépasser la limite par défaut de 10s des fonctions serverless) → on étend
// explicitement la durée max autorisée (60s = max du plan Hobby Vercel).
export const maxDuration = 60;

const ODOO_URL = process.env.ODOO_URL || "";
const ODOO_DB = process.env.ODOO_DB || "";
const ODOO_USER = process.env.ODOO_LOGIN || "";
const ODOO_PASS = process.env.ODOO_PASSWORD || "";

function checkAuth(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET || "";
  if (!cronSecret) return false;
  const authHeader = req.headers.get("authorization") || "";
  return authHeader === `Bearer ${cronSecret}`;
}

async function runAlertsCron(): Promise<any> {
  if (!ODOO_URL || !ODOO_DB || !ODOO_USER || !ODOO_PASS) {
    throw new Error("Odoo non configuré (ODOO_URL / ODOO_DB / ODOO_LOGIN / ODOO_PASSWORD)");
  }
  const session = await odoo.authenticate({ url: ODOO_URL, db: ODOO_DB }, ODOO_USER, ODOO_PASS);
  const groups = await odoo.collectAlerts(session);

  const totalCritical = groups.filter(g => g.severity === "critical").reduce((s, g) => s + g.count, 0);
  const totalWarning = groups.filter(g => g.severity === "warning").reduce((s, g) => s + g.count, 0);

  const summary = groups.filter(g => g.count > 0)
    .sort((a, b) => (a.severity === b.severity ? b.count - a.count : a.severity === "critical" ? -1 : b.severity === "critical" ? 1 : a.severity === "warning" ? -1 : 1))
    .map(g => `${g.icon} ${g.count} ${g.title.toLowerCase()}`)
    .join(" · ") || "Aucune alerte";

  return { groups, totalCritical, totalWarning, summary };
}

async function runAndTrack(): Promise<any> {
  try {
    const result = await runAlertsCron();
    try {
      await saveAlertsCronStatus({
        ranAt: new Date().toISOString(), ok: true, summary: result.summary,
        totalCritical: result.totalCritical, totalWarning: result.totalWarning,
      });
    } catch {}
    return { ok: true, ...result };
  } catch (e: any) {
    try {
      await saveAlertsCronStatus({ ranAt: new Date().toISOString(), ok: false, summary: "Échec du run", totalCritical: 0, totalWarning: 0, error: odoo.safeErrMsg(e) });
    } catch {}
    throw e;
  }
}

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: "Non autorisé" }, { status: 401 });
  try {
    const result = await runAndTrack();
    return NextResponse.json(result);
  } catch (e: any) {
    console.error("[alerts-cron] Erreur:", e);
    return NextResponse.json({ ok: false, error: odoo.safeErrMsg(e) }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);

  if (searchParams.get("status") === "1") {
    const history = await getAlertsCronHistory();
    return NextResponse.json({ route: "alerts-cron", history });
  }

  if (checkAuth(req)) {
    try {
      const result = await runAndTrack();
      return NextResponse.json(result);
    } catch (e: any) {
      console.error("[alerts-cron] Erreur:", e);
      return NextResponse.json({ ok: false, error: odoo.safeErrMsg(e) }, { status: 500 });
    }
  }

  const cronSecret = process.env.CRON_SECRET || "";
  const history = await getAlertsCronHistory().catch(() => []);
  return NextResponse.json({
    route: "alerts-cron",
    description: "GET/POST avec Authorization: Bearer {CRON_SECRET} pour déclencher. GET ?status=1 pour voir l'historique. Fait tourner odoo.collectAlerts (stock négatif, DLV, retours, etc.).",
    lastRun: history[0] || null,
    env: {
      odoo_url: ODOO_URL ? "✓" : "⚠️ ODOO_URL manquant",
      odoo_db: ODOO_DB ? "✓" : "⚠️ ODOO_DB manquant",
      odoo_user: ODOO_USER ? "✓" : "⚠️ ODOO_LOGIN manquant",
      odoo_pass: ODOO_PASS ? "✓" : "⚠️ ODOO_PASSWORD manquant",
      cron_secret: cronSecret ? "✓" : "⚠️ CRON_SECRET manquant",
    },
  });
}
