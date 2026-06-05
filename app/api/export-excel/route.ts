// app/api/export-excel/route.ts
// Proxy server-side vers la fonction Python analyse_export.py
// Ajoute le WMS_INTERNAL_TOKEN sans l'exposer au client

import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit, getClientIp } from "@/lib/rateLimiter";

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  // ── Rate limiting : 10 exports / 60s par IP ──────────────────────────────
  const ip = getClientIp(req);
  const rl = checkRateLimit(`excel:${ip}`, 10, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Trop de requêtes" },
      { status: 429, headers: { "Retry-After": String(Math.ceil(rl.resetIn / 1000)) } }
    );
  }

  const token = process.env.WMS_INTERNAL_TOKEN;
  if (!token) {
    console.error("[export-excel] WMS_INTERNAL_TOKEN non défini");
    return NextResponse.json({ error: "Configuration serveur manquante" }, { status: 500 });
  }

  try {
    const body = await req.json();

    // Appel vers la fonction Python avec le token serveur
    const baseUrl = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : "http://localhost:3000";

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    let res: Response;
    try {
      res = await fetch(`${baseUrl}/api/analyse_export`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-WMS-Token": token,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error("[export-excel] Erreur Python:", res.status, text);
      return NextResponse.json({ error: "Erreur génération Excel" }, { status: 500 });
    }

    const blob = await res.arrayBuffer();
    return new NextResponse(blob, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename=analyse_offres_${new Date().toISOString().slice(0, 10)}.xlsx`,
      },
    });
  } catch (e: any) {
    if (e.name === "AbortError") {
      return NextResponse.json({ error: "Timeout génération Excel" }, { status: 504 });
    }
    console.error("[export-excel] Erreur:", e);
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 });
  }
}
