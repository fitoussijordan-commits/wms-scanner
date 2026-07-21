// app/api/cronjob-control/route.ts
// Pilote le job externe cron-job.org ("Sortie eshop") qui appelle /api/eshop-out-cron
// à intervalle régulier — permet d'activer/désactiver ce déclenchement ET de régler sa
// fréquence depuis le WMS, sans jamais exposer la clé API cron-job.org côté client.
//
// GET  ?action=status   → { enabled, jobId, title, intervalMinutes }
// POST ?action=enable   → active le job
// POST ?action=disable  → désactive le job
// POST ?action=setFreq&minutes=180 → change la fréquence (voir FREQ_PRESETS)
//
// Écritures protégées par x-wms-token (même mécanisme que les autres actions d'écriture du WMS).

import { NextRequest, NextResponse } from "next/server";
import { fetchT } from "@/lib/fetchTimeout";

const CRONJOB_API_KEY = process.env.CRONJOB_ORG_API_KEY || "";
// Titre du job à piloter — évite de coder l'ID en dur (peut changer si le job est recréé).
const JOB_TITLE = process.env.CRONJOB_ORG_JOB_TITLE || "Sortie eshop";

// Préréglages de fréquence autorisés (en minutes) → format schedule cron-job.org.
// - "toutes les N minutes" (N < 60) : minutes=[0,N,2N,...], hours=[-1] (toutes les heures)
// - "toutes les N heures" (N >= 60, multiple de 60) : hours=[0,N/60,2N/60,...] (dans la limite de 24), minutes=[0]
const FREQ_PRESETS = [15, 30, 60, 120, 180, 360, 720, 1440] as const;

function buildSchedule(intervalMinutes: number, timezone: string) {
  if (intervalMinutes < 60) {
    const minutes: number[] = [];
    for (let m = 0; m < 60; m += intervalMinutes) minutes.push(m);
    return { timezone, expiresAt: 0, hours: [-1], mdays: [-1], minutes, months: [-1], wdays: [-1] };
  }
  const stepHours = Math.round(intervalMinutes / 60);
  if (stepHours >= 24) {
    return { timezone, expiresAt: 0, hours: [0], mdays: [-1], minutes: [0], months: [-1], wdays: [-1] };
  }
  const hours: number[] = [];
  for (let h = 0; h < 24; h += stepHours) hours.push(h);
  return { timezone, expiresAt: 0, hours, mdays: [-1], minutes: [0], months: [-1], wdays: [-1] };
}

// Déduit l'intervalle (en minutes) à partir d'un schedule existant, pour affichage.
function inferIntervalMinutes(schedule: any): number | null {
  if (!schedule) return null;
  const minutes: number[] = schedule.minutes || [];
  const hours: number[] = schedule.hours || [];
  const isEveryHour = hours.length === 1 && hours[0] === -1;
  const isEveryMinute = minutes.length === 1 && minutes[0] === -1;
  if (isEveryMinute) return 1;
  if (isEveryHour && minutes.length >= 1 && minutes[0] !== -1) {
    if (minutes.length === 1) return 60;
    const step = minutes[1] - minutes[0];
    return step > 0 ? step : null;
  }
  if (!isEveryHour && hours.length >= 1) {
    if (hours.length === 1) return 1440;
    const step = hours[1] - hours[0];
    return step > 0 ? step * 60 : null;
  }
  return null;
}

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

async function findJobDetails(): Promise<{ jobId: number; enabled: boolean; title: string; schedule: any } | null> {
  const data = await cronjobFetch("/jobs");
  const jobs: any[] = data?.jobs || [];
  const job = jobs.find(j => (j.title || "") === JOB_TITLE);
  if (!job) return null;
  return { jobId: job.jobId, enabled: !!job.enabled, title: job.title, schedule: job.schedule };
}

function checkWriteAuth(req: NextRequest): boolean {
  const expected = process.env.WMS_WRITE_TOKEN || "";
  const received = req.headers.get("x-wms-token") || "";
  return !!expected && received === expected;
}

export async function GET(req: NextRequest) {
  if (!CRONJOB_API_KEY) return NextResponse.json({ error: "CRONJOB_ORG_API_KEY non configurée" }, { status: 500 });
  try {
    const job = await findJobDetails();
    if (!job) return NextResponse.json({ error: `Job "${JOB_TITLE}" introuvable sur cron-job.org` }, { status: 404 });
    return NextResponse.json({
      ok: true, jobId: job.jobId, enabled: job.enabled, title: job.title,
      intervalMinutes: inferIntervalMinutes(job.schedule),
      presets: FREQ_PRESETS,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!checkWriteAuth(req)) return NextResponse.json({ error: "Non autorisé" }, { status: 401 });
  if (!CRONJOB_API_KEY) return NextResponse.json({ error: "CRONJOB_ORG_API_KEY non configurée" }, { status: 500 });

  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action");

  try {
    const job = await findJobDetails();
    if (!job) return NextResponse.json({ error: `Job "${JOB_TITLE}" introuvable sur cron-job.org` }, { status: 404 });

    if (action === "enable" || action === "disable") {
      await cronjobFetch(`/jobs/${job.jobId}`, "PATCH", { job: { enabled: action === "enable" } });
      return NextResponse.json({ ok: true, jobId: job.jobId, enabled: action === "enable" });
    }

    if (action === "setFreq") {
      const minutes = Number(searchParams.get("minutes"));
      if (!FREQ_PRESETS.includes(minutes as any)) {
        return NextResponse.json({ error: `minutes doit être l'un de : ${FREQ_PRESETS.join(", ")}` }, { status: 400 });
      }
      const timezone = job.schedule?.timezone || "Europe/Paris";
      const schedule = buildSchedule(minutes, timezone);
      await cronjobFetch(`/jobs/${job.jobId}`, "PATCH", { job: { schedule } });
      return NextResponse.json({ ok: true, jobId: job.jobId, intervalMinutes: minutes });
    }

    return NextResponse.json({ error: "action doit être 'enable', 'disable' ou 'setFreq'" }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
