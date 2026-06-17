// app/api/bmv-extract/route.ts
// Proxy server-side vers api/extract-bmv.py — ajoute le WMS_INTERNAL_TOKEN

import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const token = process.env.WMS_INTERNAL_TOKEN;
  if (!token) {
    console.error("[bmv-extract] WMS_INTERNAL_TOKEN non défini");
    return NextResponse.json({ error: "Configuration serveur manquante" }, { status: 500 });
  }

  try {
    const body = await req.arrayBuffer();

    const baseUrl = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : "http://localhost:3000";

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 55000);

    let res: Response;
    try {
      const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
      res = await fetch(`${baseUrl}/api/extract-bmv`, {
        method: "POST",
        headers: {
          "Content-Type": req.headers.get("content-type") || "application/pdf",
          "X-WMS-Token": token,
          ...(bypassSecret ? { "x-vercel-protection-bypass": bypassSecret } : {}),
        },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    const rawText = await res.text();
    if (!res.ok || !rawText.trimStart().startsWith("{")) {
      console.error(`[bmv-extract] Réponse non-JSON (status=${res.status}):`, rawText.slice(0, 500));
      return NextResponse.json({ error: `Erreur Python (${res.status}): ${rawText.slice(0, 200)}` }, { status: 502 });
    }
    const data = JSON.parse(rawText);
    return NextResponse.json(data, { status: res.status });
  } catch (e: any) {
    if (e.name === "AbortError") {
      return NextResponse.json({ error: "Timeout extraction PDF" }, { status: 504 });
    }
    console.error("[bmv-extract] Erreur:", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  }
}
