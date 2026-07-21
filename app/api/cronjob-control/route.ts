// app/api/cronjob-control/route.ts
// Pilote le job externe cron-job.org ("Sortie eshop") qui appelle /api/eshop-out-cron
// toutes les heures — permet d'activer/désactiver ce déclenchement depuis le WMS,
// sans jamais exposer la clé API cron-job.org côté client.
//
// GET  ?action=status  → { enabled: boolean, jobId, title }
// POST ?action=enable  → active le job
// POST ?action=disable → désactive le job
//
// Écritures protégées par x-wms-token (même mécanisme que les autres actions d'écriture du WMS).

import { NextRequest, NextResponse } from "next/server";
import { fetchT } from "@/lib/fetchTimeout";

const CRONJOB_API_KEY = process.env.CRONJOB_ORG_API_KEY || "";
// Titre du job à piloter — évite de coder l'ID en dur (peut changer si le job est recréé).
const JOB_TITLE = process.env.CRONJOB_ORG_JOB_TITLE || "Sortie eshop";

async function cronjobFetch(path: string, method = "GET", body?: any) {
  const res = await fetchT(`https://api.cron-job.org${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${CRONJOB_API_KEY}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`cron-job.org ${res.status}: ${text.slice(0, 300)}`);
  return json;
}

async function findJobByTitle(): Promise<{ jobId: number; enabled: boolean; title: string } | null> {
  const data = await cronjobFetch("/jobs");
  const jobs: any[] = data?.jobs || [];
  const job = jobs.find(j => (j.title || "") === JOB_TITLE);
  if (!job) return null;
  return { jobId: job.jobId, enabled: !!job.enabled, title: job.title };
}

function checkWriteAuth(req: NextRequest): boolean {
  const expected = process.env.WMS_WRITE_TOKEN || "";
  const received = req.headers.get("x-wms-token") || "";
  return !!expected && received === expected;
}

export async function GET(req: NextRequest) {
  if (!CRONJOB_API_KEY) return NextResponse.json({ error: "CRONJOB_ORG_API_KEY non configurée" }, { status: 500 });
  try {
    const job = await findJobByTitle();
    if (!job) return NextResponse.json({ error: `Job "${JOB_TITLE}" introuvable sur cron-job.org` }, { status: 404 });
    return NextResponse.json({ ok: true, ...job });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!checkWriteAuth(req)) return NextResponse.json({ error: "Non autorisé" }, { status: 401 });
  if (!CRONJOB_API_KEY) return NextResponse.json({ error: "CRONJOB_ORG_API_KEY non configurée" }, { status: 500 });

  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action");
  if (action !== "enable" && action !== "disable") {
    return NextResponse.json({ error: "action doit être 'enable' ou 'disable'" }, { status: 400 });
  }

  try {
    const job = await findJobByTitle();
    if (!job) return NextResponse.json({ error: `Job "${JOB_TITLE}" introuvable sur cron-job.org` }, { status: 404 });

    await cronjobFetch(`/jobs/${job.jobId}`, "PATCH", { job: { enabled: action === "enable" } });
    return NextResponse.json({ ok: true, jobId: job.jobId, enabled: action === "enable" });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
